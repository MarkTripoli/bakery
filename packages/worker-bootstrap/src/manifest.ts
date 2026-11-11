import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { BootstrapError } from "./errors.ts";

/** Targets a release manifest may list. */
export const KNOWN_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
] as const;
export type ReleaseTarget = (typeof KNOWN_TARGETS)[number];

/**
 * Targets this bootstrap installs. A target joins this list only when its
 * acceptance lane has run on a real runner of that OS and architecture
 * (B15.06); cross-compiled builds are not evidence for another host.
 */
export const SUPPORTED_TARGETS: readonly ReleaseTarget[] = ["linux-x64"];

export function detectTarget(
  platform: string,
  arch: string,
): ReleaseTarget | null {
  const name = `${platform}-${arch}`;
  return (SUPPORTED_TARGETS as readonly string[]).includes(name)
    ? name as ReleaseTarget
    : null;
}

/** A public key the bootstrap trusts: raw 32-byte Ed25519, base64. */
export type TrustedKey = Readonly<{ keyId: string; publicKey: string }>;

/** What a verified manifest says about the one target being installed. */
export type VerifiedManifest = Readonly<{
  release: string;
  target: ReleaseTarget;
  file: string;
  size: number;
  sha256: string;
  stateFormat: number;
  protocol: Readonly<{ min: number; max: number }>;
  expiresAt: string;
  keyId: string;
}>;

export type VerifyOptions = Readonly<{
  trustRoot: readonly TrustedKey[];
  /** The exact release the setup command names. */
  release: string;
  /** The target this machine reports. */
  target: string;
  now: Date;
  /** The worker protocol version the server speaks. */
  protocol: number;
  /** The state format already on this machine, or the one this release writes. */
  stateFormat: number;
}>;

const MAX_ENVELOPE_CHARS = 128 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const EXACT_RELEASE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const malformed = () => new BootstrapError("MANIFEST_MALFORMED");

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when `value` has exactly the listed own keys, no more and no fewer. */
function hasExactly(value: Json, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function decodeBase64(value: unknown, maxBytes: number): Buffer {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length % 4 !== 0 || !BASE64.test(value)
  ) throw malformed();
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw malformed();
  if (bytes.toString("base64") !== value) throw malformed();
  return bytes;
}

function parseInstant(value: unknown): number {
  if (typeof value !== "string" || !ISO_UTC.test(value)) throw malformed();
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw malformed();
  return time;
}

function parseInteger(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < min ||
    value > max
  ) throw malformed();
  return value;
}

type Parsed = Readonly<{
  release: string;
  issuedAt: number;
  expiresAt: string;
  expiresAtMs: number;
  protocol: { min: number; max: number };
  stateFormat: number;
  targets: ReadonlyMap<ReleaseTarget, {
    file: string;
    size: number;
    sha256: string;
  }>;
}>;

function parsePayload(bytes: Buffer): Parsed {
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw malformed();
  }
  if (
    !isRecord(document) ||
    !hasExactly(document, [
      "schema",
      "release",
      "issuedAt",
      "expiresAt",
      "protocol",
      "stateFormat",
      "targets",
    ])
  ) throw malformed();
  if (document.schema !== 1) throw malformed();
  const release = document.release;
  if (typeof release !== "string" || !EXACT_RELEASE.test(release)) {
    throw malformed();
  }
  const issuedAt = parseInstant(document.issuedAt);
  const expiresAtMs = parseInstant(document.expiresAt);
  if (expiresAtMs <= issuedAt) throw malformed();
  const protocol = document.protocol;
  if (!isRecord(protocol) || !hasExactly(protocol, ["min", "max"])) {
    throw malformed();
  }
  const min = parseInteger(protocol.min, 0, 1_000_000);
  const max = parseInteger(protocol.max, 0, 1_000_000);
  if (min > max) throw malformed();
  const stateFormat = parseInteger(document.stateFormat, 0, 1_000_000);
  const targets = document.targets;
  if (!isRecord(targets)) throw malformed();
  const parsedTargets = new Map<
    ReleaseTarget,
    { file: string; size: number; sha256: string }
  >();
  for (const [name, entry] of Object.entries(targets)) {
    if (!(KNOWN_TARGETS as readonly string[]).includes(name)) throw malformed();
    if (!isRecord(entry) || !hasExactly(entry, ["file", "size", "sha256"])) {
      throw malformed();
    }
    const { file, sha256 } = entry;
    if (
      typeof file !== "string" || !FILE_NAME.test(file) || file.includes("..")
    ) throw malformed();
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw malformed();
    parsedTargets.set(name as ReleaseTarget, {
      file,
      size: parseInteger(entry.size, 1, MAX_ARTIFACT_BYTES),
      sha256,
    });
  }
  return {
    release,
    issuedAt,
    expiresAt: document.expiresAt as string,
    expiresAtMs,
    protocol: { min, max },
    stateFormat,
    targets: parsedTargets,
  };
}

function trustedPublicKey(key: TrustedKey) {
  const raw = Buffer.from(key.publicKey, "base64");
  if (raw.byteLength !== 32) throw new BootstrapError("MANIFEST_KEY_UNKNOWN");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/**
 * Verifies a signed release manifest and returns what it says about this
 * machine's target. The signature covers the exact payload bytes, so no
 * canonicalization is involved; the payload is parsed only after the
 * signature verifies against a key in the pinned trust root. Throws a
 * `BootstrapError` and never partially succeeds.
 */
export function verifySignedManifest(
  signed: string,
  options: VerifyOptions,
): VerifiedManifest {
  if (!EXACT_RELEASE.test(options.release)) {
    throw new BootstrapError("RELEASE_NOT_EXACT");
  }
  if (typeof signed !== "string" || signed.length > MAX_ENVELOPE_CHARS) {
    throw malformed();
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(signed);
  } catch {
    throw malformed();
  }
  if (
    !isRecord(envelope) ||
    !hasExactly(envelope, ["keyId", "payload", "signature"])
  ) throw malformed();
  const keyId = envelope.keyId;
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) throw malformed();
  const payload = decodeBase64(envelope.payload, MAX_PAYLOAD_BYTES);
  const signature = decodeBase64(envelope.signature, 64);
  if (signature.byteLength !== 64) throw malformed();

  const trusted = options.trustRoot.find((key) => key.keyId === keyId);
  if (!trusted) throw new BootstrapError("MANIFEST_KEY_UNKNOWN");
  let valid = false;
  try {
    valid = verify(null, payload, trustedPublicKey(trusted), signature);
  } catch (cause) {
    if (cause instanceof BootstrapError) throw cause;
    throw new BootstrapError("MANIFEST_SIGNATURE_INVALID", { cause });
  }
  if (!valid) throw new BootstrapError("MANIFEST_SIGNATURE_INVALID");

  const manifest = parsePayload(payload);
  const now = options.now.getTime();
  if (manifest.expiresAtMs <= now) throw new BootstrapError("MANIFEST_EXPIRED");
  if (manifest.issuedAt > now + CLOCK_SKEW_MS) {
    throw new BootstrapError("MANIFEST_NOT_YET_VALID");
  }
  if (manifest.release !== options.release) {
    throw new BootstrapError("MANIFEST_RELEASE_MISMATCH");
  }
  const target = (KNOWN_TARGETS as readonly string[]).includes(options.target)
    ? options.target as ReleaseTarget
    : undefined;
  const entry = target === undefined ? undefined : manifest.targets.get(target);
  if (target === undefined || entry === undefined) {
    throw new BootstrapError("MANIFEST_TARGET_UNSUPPORTED");
  }
  if (
    options.protocol < manifest.protocol.min ||
    options.protocol > manifest.protocol.max
  ) throw new BootstrapError("MANIFEST_PROTOCOL_INCOMPATIBLE");
  if (options.stateFormat !== manifest.stateFormat) {
    throw new BootstrapError("MANIFEST_STATE_FORMAT_INCOMPATIBLE");
  }
  return Object.freeze({
    release: manifest.release,
    target,
    file: entry.file,
    size: entry.size,
    sha256: entry.sha256,
    stateFormat: manifest.stateFormat,
    protocol: Object.freeze({ ...manifest.protocol }),
    expiresAt: manifest.expiresAt,
    keyId,
  });
}
