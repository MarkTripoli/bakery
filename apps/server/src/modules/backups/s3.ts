import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { BackupS3Credentials } from "./settings.ts";

/**
 * The off-site destination: any S3-compatible bucket the installation
 * administrator names. Unlike skill storage this is not pinned to one provider,
 * so the endpoint is validated here instead.
 */

export type BackupDestination = {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** Folder inside the bucket: no leading slash, a trailing one when set. */
  readonly prefix: string;
};

export const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
export const REGION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
const PREFIX_PATTERN = /^[A-Za-z0-9!_.*'()\-/ ]{0,256}$/;

/** Hosts a loopback fixture may use, and only when BAKERY_ENV is test. */
const TEST_ENDPOINT_HOSTS: readonly string[] = [
  "127.0.0.1",
  "localhost",
  "[::1]",
  "s3-fixture",
];

export class BackupDestinationInvalid extends Error {
  constructor(readonly field: "endpoint" | "bucket" | "region" | "prefix") {
    super("BACKUP_DESTINATION_INVALID");
  }
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  // Any IPv6 literal: loopback, link-local and unique-local ranges included.
  if (hostname.startsWith("[")) return true;
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (quad === null) return false;
  const [a, b] = [Number(quad[1]), Number(quad[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Normalises a folder to `a/b/` (or empty); refuses dot segments. */
export function normalizePrefix(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new BackupDestinationInvalid("prefix");
  }
  const segments = prefix.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new BackupDestinationInvalid("prefix");
  }
  return segments.length === 0 ? "" : `${segments.join("/")}/`;
}

/**
 * Validates an administrator-supplied destination. The endpoint must be an
 * https origin (no credentials, path, query or fragment) that is not a
 * private, loopback or link-local address; only a test environment may name a
 * loopback http fixture. A DNS name that resolves to a private address is not
 * checked here: the destination is an administrator's choice, and the runner
 * is the one that dials it from the host.
 */
export function resolveBackupDestination(
  source: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly prefix: string;
  },
  options: { readonly allowLoopbackEndpoint: boolean },
): BackupDestination {
  let url: URL;
  try {
    url = new URL(source.endpoint);
  } catch {
    throw new BackupDestinationInvalid("endpoint");
  }
  const testEndpoint = options.allowLoopbackEndpoint &&
    url.protocol === "http:" && TEST_ENDPOINT_HOSTS.includes(url.hostname);
  const publicHttps = url.protocol === "https:" && !isPrivateHost(url.hostname);
  if (
    !(testEndpoint || publicHttps) || url.username || url.password ||
    url.search || url.hash || url.pathname !== "/"
  ) throw new BackupDestinationInvalid("endpoint");
  if (!BUCKET_NAME_PATTERN.test(source.bucket)) {
    throw new BackupDestinationInvalid("bucket");
  }
  if (!REGION_PATTERN.test(source.region)) {
    throw new BackupDestinationInvalid("region");
  }
  return {
    endpoint: url.origin,
    region: source.region,
    bucket: source.bucket,
    prefix: normalizePrefix(source.prefix),
  };
}

/** True when a credential has no whitespace or control characters. */
export function isCredentialText(value: string): boolean {
  return value.length > 0 && !Array.from(value).some((c) => {
    const code = c.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}

export function createBackupS3Client(
  destination: Pick<BackupDestination, "endpoint" | "region">,
  credentials: BackupS3Credentials,
  timeouts: { readonly attempts: number; readonly requestMs: number } = {
    attempts: 1,
    requestMs: 10000,
  },
): S3Client {
  return new S3Client({
    region: destination.region,
    endpoint: destination.endpoint,
    forcePathStyle: true,
    maxAttempts: timeouts.attempts,
    requestHandler: {
      connectionTimeout: 5000,
      requestTimeout: timeouts.requestMs,
    },
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
}

/** Stable words the page and the runner share. */
export const BackupProbeOutcome = Object.freeze(
  {
    Verified: "verified",
    NotConfigured: "not_configured",
    DestinationRefused: "destination_refused",
    DestinationUnreachable: "destination_unreachable",
    IntegrityFailed: "integrity_failed",
  } as const,
);
export type BackupProbeOutcome =
  (typeof BackupProbeOutcome)[keyof typeof BackupProbeOutcome];

export type BackupProbeResult = {
  readonly outcome: BackupProbeOutcome;
  /** The destination's own answer, bounded and with the credentials removed. */
  readonly detail: string | null;
};

const DETAIL_MAX = 500;

/** Bounded detail text with both halves of the credential pair removed. */
export function safeDetail(
  text: string,
  credentials: BackupS3Credentials,
): string | null {
  let value = text;
  for (const secret of [credentials.secretAccessKey, credentials.accessKeyId]) {
    if (secret.length > 0) value = value.split(secret).join("[redacted]");
  }
  value = Array.from(value).filter((c) => {
    const code = c.charCodeAt(0);
    return code >= 32 && code !== 127;
  }).join("").trim();
  return value === "" ? null : value.slice(0, DETAIL_MAX);
}

class ProbeIntegrityError extends Error {}

function mapProbeError(
  error: unknown,
  credentials: BackupS3Credentials,
): BackupProbeResult {
  if (error instanceof ProbeIntegrityError) {
    return {
      outcome: BackupProbeOutcome.IntegrityFailed,
      detail: "The bytes read back differ from the bytes written.",
    };
  }
  const e = error as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const text = `${e?.name ?? "Error"}: ${e?.message ?? ""}`;
  // Any HTTP answer means the destination was reached and said no.
  if (typeof e?.$metadata?.httpStatusCode === "number") {
    return {
      outcome: BackupProbeOutcome.DestinationRefused,
      detail: safeDetail(text, credentials),
    };
  }
  // No HTTP response at all: DNS, connect, TLS, timeout or abort.
  return {
    outcome: BackupProbeOutcome.DestinationUnreachable,
    detail: safeDetail(text, credentials),
  };
}

/**
 * Bounded probe, the "Send a test": puts a random sentinel under
 * `<prefix>bakery-probe/`, reads it back, compares its digest and deletes it.
 * One attempt per call and a hard deadline keep a stuck destination from
 * holding a request.
 */
export async function probeBackupDestination(
  destination: BackupDestination,
  credentials: BackupS3Credentials,
  signal?: AbortSignal,
): Promise<BackupProbeResult> {
  const client = createBackupS3Client(destination, credentials);
  const abortSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  try {
    const key = `${destination.prefix}bakery-probe/${crypto.randomUUID()}`;
    const body = crypto.getRandomValues(new Uint8Array(32));
    const digest = createHash("sha256").update(body).digest("base64");
    await client.send(
      new PutObjectCommand({
        Bucket: destination.bucket,
        Key: key,
        Body: body,
        ChecksumSHA256: digest,
      }),
      { abortSignal },
    );
    const read = await client.send(
      new GetObjectCommand({ Bucket: destination.bucket, Key: key }),
      { abortSignal },
    );
    const bytes = await read.Body?.transformToByteArray();
    if (
      !bytes ||
      createHash("sha256").update(bytes).digest("base64") !== digest
    ) throw new ProbeIntegrityError();
    await client.send(
      new DeleteObjectCommand({ Bucket: destination.bucket, Key: key }),
      { abortSignal },
    );
    return { outcome: BackupProbeOutcome.Verified, detail: null };
  } catch (error) {
    return mapProbeError(error, credentials);
  } finally {
    client.destroy();
  }
}
