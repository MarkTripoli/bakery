import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Cutoff,
  parseCutoff,
} from "../../../apps/server/src/modules/backups/cutoff-rules.ts";

/**
 * What a complete Bakery backup contains, and the check that says whether one
 * does (issue #64, slice A).
 *
 * A backup directory carries a `manifest.json` listing every state store the
 * product has, with a status for each: `captured` (its file is in the set,
 * with its size and SHA-256), `excluded` (deliberately not in the set, with
 * the reason) or `failed`. A set whose required store is not `captured`, or
 * whose files do not match the manifest, is incomplete and must never be
 * reported as a recoverable backup.
 *
 * The plaintext manifest carries no secret and no object key: object keys live
 * in the age-encrypted references file, and the secrets key itself is never
 * copied (only its id is recorded; the operator holds the key).
 */

export const MANIFEST_FILE = "manifest.json";
export const CHECKSUMS_FILE = "SHA256SUMS";
/**
 * Written by backup.sh, in shell, when it cannot build the manifest (Deno or the
 * release checkout is missing). The set keeps its dumps so the bytes exist, but
 * it declares itself incomplete: it is never `latest`, never counts as the
 * newest good set, and no restore may use it.
 */
export const INCOMPLETE_FILE = "INCOMPLETE.json";
export const MANIFEST_FORMAT = 2;
/** The first format: no cutoff record. Still readable, and reported as such. */
export const LEGACY_MANIFEST_FORMAT = 1;

export type StoreStatus = "captured" | "excluded" | "failed";

export type StoreDefinition = {
  readonly id: string;
  readonly title: string;
  /** Where the data lives and how backup.sh captures it. */
  readonly source: string;
  /** A required store that is not captured makes the whole set incomplete. */
  readonly required: boolean;
  /** The file in the set that holds it; null for an inline or excluded store. */
  readonly file: string | null;
  /** Why it is not in the set; set only for a store that is always excluded. */
  readonly excludedReason?: string;
};

/**
 * The declared stores. Adding a place where Bakery keeps state means adding it
 * here, and `backup.sh` must capture it or the set stays incomplete.
 */
export const STORES: readonly StoreDefinition[] = Object.freeze([
  {
    id: "postgres-bakery",
    title: "Bakery database",
    source: "pg_dump --format=custom of the `bakery` database",
    required: true,
    file: "bakery.dump.age",
  },
  {
    id: "postgres-inngest",
    title: "Workflow engine database",
    source: "pg_dump --format=custom of the `inngest` database",
    required: true,
    file: "inngest.dump.age",
  },
  {
    id: "redis",
    title: "Workflow engine queue state",
    source: "a Redis SAVE, then the RDB snapshot (/var/lib/bakery/redis)",
    required: true,
    file: "redis.rdb.age",
  },
  {
    id: "files",
    title: "Skill and worker files",
    source: "/var/lib/bakery/skills and /var/lib/bakery/worker, tarred",
    required: true,
    file: "files.tar.gz.age",
  },
  {
    id: "release-journal",
    title: "Release journal",
    source: "/var/lib/bakery/deploy/state.json",
    required: true,
    file: "release.json",
  },
  {
    id: "object-references",
    title: "Object references",
    source:
      "every skill file and blob the database refers to, by object key and SHA-256, so a restore can read each object back; the bytes are not copied",
    required: true,
    file: "references.json.age",
  },
  {
    id: "secrets-key-identity",
    title: "Secrets key identity",
    source:
      "the id of the key that protects saved secrets (BAKERY_SECRETS_KEY_ID) and a fingerprint of the key file, so a restore can check it has the right key; the key itself is operator-held and never copied, and the file is read once, only to compute the fingerprint",
    required: true,
    file: null,
  },
  {
    id: "incoming",
    title: "Upload staging",
    source: "/var/lib/bakery/incoming",
    required: false,
    file: null,
    excludedReason:
      "transient staging for uploads in flight; nothing in it is state a restore needs",
  },
  {
    id: "host-configuration",
    title: "Host configuration and keys",
    source: "/etc/bakery (env files, the secrets key, the age identity)",
    required: false,
    file: null,
    excludedReason:
      "operator-managed and secret: the operator keeps these separately, never in a backup set",
  },
  {
    id: "postgres-roles",
    title: "Database roles",
    source: "cluster-wide roles of the Postgres instance",
    required: false,
    file: null,
    excludedReason:
      "recreated from the role bootstrap script when a restore starts a database",
  },
]);

/**
 * The key fingerprint: the first 16 hex characters of
 * SHA-256("bakery-backup-key-fingerprint-v1\n" || key file bytes). It is
 * domain-separated, so it is not the hash of the key as any other system would
 * take it, and 64 bits is enough to tell one key from another (a restore drill
 * compares it) while giving nothing toward recovering the key.
 */
export const KEY_FINGERPRINT_DOMAIN = "bakery-backup-key-fingerprint-v1\n";
export const KEY_FINGERPRINT_FORMAT = "sha256-16hex-v1";
const FINGERPRINT = /^[0-9a-f]{16}$/;

export function keyFingerprint(key: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(KEY_FINGERPRINT_DOMAIN);
  hash.update(key);
  return hash.digest("hex").slice(0, 16);
}

/**
 * Reads the key file once, only to fingerprint it. The bytes are not copied,
 * logged or kept: the buffer is zeroed as soon as the digest is taken.
 */
export async function readKeyFingerprint(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return keyFingerprint(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** What the secrets key looked like on the host when the backup ran. */
export type KeyIdentity =
  | {
    readonly state: "configured";
    readonly id: string;
    /** From `keyFingerprint`; the key itself is never recorded. */
    readonly fingerprint: string;
  }
  | { readonly state: "unconfigured" }
  | { readonly state: "failed"; readonly reason: string };

export type StoreEntry = {
  readonly id: string;
  readonly status: StoreStatus;
  readonly required: boolean;
  readonly file?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly reason?: string;
  readonly keyId?: string;
  readonly keyFingerprint?: string;
  readonly keyFingerprintFormat?: typeof KEY_FINGERPRINT_FORMAT;
};

export type Manifest = {
  readonly format: typeof MANIFEST_FORMAT | typeof LEGACY_MANIFEST_FORMAT;
  readonly startedAt: string;
  readonly finishedAt: string;
  /**
   * Format 2: when the snapshot began and where that time came from. A database
   * cutoff (taken by the runner while the installation was quiet) carries a
   * census of the unsettled effects; a host-clock cutoff (a backup no runner
   * took) is weaker and carries none. Everything after it is not in the set.
   */
  readonly cutoff?: Cutoff;
  /** Format 1 only: the host clock when the capture began. */
  readonly cutoffAt?: string;
  readonly release: { readonly sha: string | null };
  readonly stores: readonly StoreEntry[];
  readonly references: {
    readonly skillFiles: number;
    readonly blobs: number;
  };
  readonly note: string;
};

export type Problem = {
  readonly kind:
    | "no_manifest"
    | "declared_incomplete"
    | "key_mismatch"
    | "manifest_invalid"
    | "cutoff_not_database"
    | "store_not_captured"
    | "missing_file"
    | "size_mismatch"
    | "hash_mismatch"
    | "unlisted_file"
    | "checksums_mismatch";
  readonly store?: string;
  readonly file?: string;
  readonly detail: string;
};

export type Verification = {
  /** The cutoff the manifest recorded, when it could be read (format 2). */
  readonly cutoff?: Cutoff | null;
  readonly complete: boolean;
  /** No manifest: a set from before manifests existed. */
  readonly legacy: boolean;
  readonly problems: readonly Problem[];
};

/** Thrown when a manifest cannot be written because the set is incomplete. */
export class IncompleteBackup extends Error {
  constructor(readonly problems: readonly Problem[]) {
    super(`BACKUP_INCOMPLETE ${describeProblems(problems)}`);
  }
}

export function describeProblems(problems: readonly Problem[]): string {
  return problems
    .map((problem) =>
      `${problem.store ?? problem.file ?? problem.kind}: ${problem.kind}${
        problem.detail ? ` (${problem.detail})` : ""
      }`
    )
    .join("; ");
}

const KEY_ID = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{64}$/;
const SET_FILE = /^[A-Za-z0-9._-]+$/;

export function isKeyId(value: string): boolean {
  return KEY_ID.test(value);
}

/** SHA-256 and size of a file, read as a stream. */
export async function hashFile(
  path: string,
): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export type BuildInput = {
  readonly directory: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly key: KeyIdentity;
  readonly references: { readonly skillFiles: number; readonly blobs: number };
  /**
   * The database cutoff the runner took while the installation was quiet. Left
   * out for a backup no runner took: the cutoff is then the host clock when the
   * capture began, marked as weaker.
   */
  readonly cutoff?: Cutoff;
  /** Stores the capture itself reported as failed, with the reason. */
  readonly failed?: Readonly<Record<string, string>>;
};

/**
 * Reads the finished set, builds its manifest and writes `manifest.json` and
 * `SHA256SUMS` (which covers every file but itself, the manifest included).
 * Throws IncompleteBackup, writing nothing, when a required store is not
 * captured.
 */
export async function writeBackupManifest(
  input: BuildInput,
): Promise<Manifest> {
  const problems: Problem[] = [];
  const stores: StoreEntry[] = [];
  let releaseSha: string | null = null;
  for (const store of STORES) {
    const failure = input.failed?.[store.id];
    if (store.id === "secrets-key-identity") {
      const entry = keyEntry(store, input.key, failure);
      stores.push(entry);
      if (entry.status === "failed") {
        problems.push({
          kind: "store_not_captured",
          store: store.id,
          detail: entry.reason ?? "",
        });
      }
      continue;
    }
    if (store.file === null) {
      stores.push({
        id: store.id,
        status: "excluded",
        required: false,
        reason: store.excludedReason,
      });
      continue;
    }
    if (failure !== undefined) {
      stores.push({
        id: store.id,
        status: "failed",
        required: store.required,
        file: store.file,
        reason: failure,
      });
      problems.push({
        kind: "store_not_captured",
        store: store.id,
        file: store.file,
        detail: failure,
      });
      continue;
    }
    const path = join(input.directory, store.file);
    let measured;
    try {
      measured = await hashFile(path);
    } catch {
      stores.push({
        id: store.id,
        status: "failed",
        required: store.required,
        file: store.file,
        reason: "the file is not in the set",
      });
      problems.push({
        kind: "missing_file",
        store: store.id,
        file: store.file,
        detail: "the file is not in the set",
      });
      continue;
    }
    if (measured.bytes === 0) {
      stores.push({
        id: store.id,
        status: "failed",
        required: store.required,
        file: store.file,
        reason: "the file is empty",
      });
      problems.push({
        kind: "store_not_captured",
        store: store.id,
        file: store.file,
        detail: "the file is empty",
      });
      continue;
    }
    if (store.id === "release-journal") {
      releaseSha = await readReleaseSha(path);
    }
    stores.push({
      id: store.id,
      status: "captured",
      required: store.required,
      file: store.file,
      bytes: measured.bytes,
      sha256: measured.sha256,
    });
  }
  if (problems.length > 0) throw new IncompleteBackup(problems);

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    cutoff: input.cutoff ??
      {
        at: input.startedAt.toISOString(),
        source: "host-clock",
        effects: null,
      },
    release: { sha: releaseSha },
    stores,
    references: input.references,
    note:
      "The secrets key is not in this set. The operator holds it and must save it separately; without it saved secrets cannot be read after a restore. Only its id and a fingerprint are recorded: the key file was read once, to compute the fingerprint, and never copied or logged.",
  };
  await writeFile(
    join(input.directory, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeChecksums(input.directory);
  return manifest;
}

function keyEntry(
  store: StoreDefinition,
  key: KeyIdentity,
  failure: string | undefined,
): StoreEntry {
  if (failure !== undefined) {
    return {
      id: store.id,
      status: "failed",
      required: true,
      reason: failure,
    };
  }
  if (key.state === "configured") {
    if (!isKeyId(key.id)) {
      return {
        id: store.id,
        status: "failed",
        required: true,
        reason: "the secrets key id is not a valid id",
      };
    }
    if (!FINGERPRINT.test(key.fingerprint)) {
      return {
        id: store.id,
        status: "failed",
        required: true,
        reason: "the secrets key fingerprint is not valid",
      };
    }
    return {
      id: store.id,
      status: "captured",
      required: true,
      keyId: key.id,
      keyFingerprint: key.fingerprint,
      keyFingerprintFormat: KEY_FINGERPRINT_FORMAT,
    };
  }
  if (key.state === "unconfigured") {
    return {
      id: store.id,
      status: "excluded",
      required: true,
      reason: "no secrets key is configured on this host",
    };
  }
  return { id: store.id, status: "failed", required: true, reason: key.reason };
}

async function readReleaseSha(path: string): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as {
      active?: { sha?: unknown };
    };
    const sha = state.active?.sha;
    return typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Writes SHA256SUMS over every file in the set except itself. */
export async function writeChecksums(directory: string): Promise<void> {
  const names: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name !== CHECKSUMS_FILE) names.push(entry.name);
  }
  names.sort();
  const lines: string[] = [];
  for (const name of names) {
    const { sha256 } = await hashFile(join(directory, name));
    lines.push(`${sha256}  ./${name}`);
  }
  await writeFile(
    join(directory, CHECKSUMS_FILE),
    `${lines.join("\n")}\n`,
    { mode: 0o600 },
  );
}

function parseChecksums(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) [ *]\.\/([A-Za-z0-9._-]+)$/.exec(line);
    if (!match) return null;
    out.set(match[2], match[1]);
  }
  return out;
}

/** Narrows an unknown JSON value to a manifest, or says why it is not one. */
export function parseManifest(value: unknown): Manifest | string {
  if (value === null || typeof value !== "object") {
    return "the manifest is not an object";
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.format !== MANIFEST_FORMAT &&
    manifest.format !== LEGACY_MANIFEST_FORMAT
  ) {
    return `the manifest format is ${
      String(manifest.format)
    }, not ${MANIFEST_FORMAT}`;
  }
  // Format 2 requires a cutoff, and a malformed one makes the manifest invalid.
  if (manifest.format === MANIFEST_FORMAT) {
    const cutoff = parseCutoff(manifest.cutoff);
    if (typeof cutoff === "string") return `the cutoff is invalid: ${cutoff}`;
  }
  if (!Array.isArray(manifest.stores)) return "the manifest has no stores";
  for (const raw of manifest.stores) {
    const store = raw as Record<string, unknown>;
    if (
      typeof store?.id !== "string" ||
      !["captured", "excluded", "failed"].includes(String(store.status)) ||
      typeof store.required !== "boolean"
    ) return "a store entry is malformed";
    if (store.status === "captured" && store.keyFingerprint !== undefined) {
      if (
        typeof store.keyFingerprint !== "string" ||
        !FINGERPRINT.test(store.keyFingerprint)
      ) return "the key fingerprint is malformed";
    }
    if (store.status === "captured" && store.file !== undefined) {
      if (
        typeof store.file !== "string" || !SET_FILE.test(store.file) ||
        typeof store.bytes !== "number" ||
        typeof store.sha256 !== "string" || !SHA.test(store.sha256)
      ) return `the entry for ${store.id} is malformed`;
    }
  }
  return value as Manifest;
}

export type IncompleteMarker = {
  readonly cause: string;
  readonly detail: string;
};

/**
 * The marker a set carries when backup.sh declared it incomplete, or null when
 * there is none. A marker that cannot be read still marks the set: the file's
 * presence is what counts.
 */
export async function readIncompleteMarker(
  directory: string,
): Promise<IncompleteMarker | null> {
  let text: string;
  try {
    text = await readFile(join(directory, INCOMPLETE_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const marker = JSON.parse(text) as Record<string, unknown>;
    return {
      cause: typeof marker.cause === "string" ? marker.cause : "unknown",
      detail: typeof marker.detail === "string" ? marker.detail : "",
    };
  } catch {
    return { cause: "unknown", detail: "the marker could not be read" };
  }
}

export async function isDeclaredIncomplete(
  directory: string,
): Promise<boolean> {
  return (await readIncompleteMarker(directory)) !== null;
}

export type VerifyOptions = {
  /**
   * Treat a set with no manifest as a legacy set instead of incomplete. It never
   * excuses a set that declares itself incomplete or has a manifest that does
   * not match.
   */
  readonly allowLegacy?: boolean;
  /**
   * A secrets key file to check against the fingerprint the manifest recorded
   * (for a restore drill). The file is read once, only to fingerprint it.
   */
  readonly keyFile?: string;
  /**
   * Refuse a set whose cutoff is not a database cutoff: a restore that must not
   * replay unknown effects needs the quiet moment and the census, which only a
   * runner-taken backup records.
   */
  readonly requireDatabaseCutoff?: boolean;
};

/**
 * Re-reads a backup directory and says whether it is a complete set: the
 * manifest parses, every declared required store is captured, every captured
 * file is present with the recorded size and hash, nothing unlisted is in the
 * directory and SHA256SUMS agrees. Every problem is listed, not just the first.
 */
export async function verifyBackupDirectory(
  directory: string,
  options: VerifyOptions = {},
): Promise<Verification> {
  // A set that declared itself incomplete is refused first, whatever else it
  // holds: it is not legacy, and no flag excuses it.
  const marker = await readIncompleteMarker(directory);
  if (marker !== null) {
    return {
      complete: false,
      legacy: false,
      problems: [{
        kind: "declared_incomplete",
        detail: `${marker.cause}${marker.detail ? `: ${marker.detail}` : ""}`,
      }],
    };
  }
  let text: string;
  try {
    text = await readFile(join(directory, MANIFEST_FILE), "utf8");
  } catch {
    return {
      complete: false,
      legacy: true,
      problems: [{
        kind: "no_manifest",
        detail: options.allowLegacy
          ? "a legacy set with no manifest, accepted because legacy sets are allowed"
          : "this set has no manifest, so what it holds cannot be checked",
      }],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      complete: false,
      legacy: false,
      problems: [{
        kind: "manifest_invalid",
        detail: "the manifest is not valid JSON",
      }],
    };
  }
  const manifest = parseManifest(parsed);
  if (typeof manifest === "string") {
    return {
      complete: false,
      legacy: false,
      problems: [{ kind: "manifest_invalid", detail: manifest }],
    };
  }

  const problems: Problem[] = [];
  if (
    options.requireDatabaseCutoff === true &&
    manifest.cutoff?.source !== "database"
  ) {
    problems.push({
      kind: "cutoff_not_database",
      detail: manifest.cutoff === undefined
        ? "this set predates cutoff records, so what may have happened after it cannot be known"
        : "the cutoff is the host clock, not a quiet moment taken from the database",
    });
  }
  const byId = new Map(manifest.stores.map((store) => [store.id, store]));
  const listed = new Set<string>([MANIFEST_FILE, CHECKSUMS_FILE]);
  for (const store of STORES) {
    const entry = byId.get(store.id);
    if (!entry) {
      if (store.required) {
        problems.push({
          kind: "store_not_captured",
          store: store.id,
          detail: "the manifest does not list this store",
        });
      }
      continue;
    }
    if (entry.status === "failed") {
      problems.push({
        kind: "store_not_captured",
        store: store.id,
        detail: entry.reason ?? "the capture failed",
      });
      continue;
    }
    if (entry.status === "excluded") {
      // Only the key identity may be excluded while required (no key is
      // configured); any other required store left out makes the set incomplete.
      if (store.required && store.id !== "secrets-key-identity") {
        problems.push({
          kind: "store_not_captured",
          store: store.id,
          detail: entry.reason ?? "the store was left out",
        });
      }
      continue;
    }
    if (store.file === null) continue;
    if (entry.file !== store.file) {
      problems.push({
        kind: "manifest_invalid",
        store: store.id,
        detail: `the manifest names ${String(entry.file)}, not ${store.file}`,
      });
      continue;
    }
    listed.add(store.file);
    try {
      const measured = await hashFile(join(directory, store.file));
      if (measured.bytes !== entry.bytes) {
        problems.push({
          kind: "size_mismatch",
          store: store.id,
          file: store.file,
          detail: `${measured.bytes} bytes, the manifest says ${entry.bytes}`,
        });
      } else if (measured.sha256 !== entry.sha256) {
        problems.push({
          kind: "hash_mismatch",
          store: store.id,
          file: store.file,
          detail: "the file does not match its recorded SHA-256",
        });
      }
    } catch {
      problems.push({
        kind: "missing_file",
        store: store.id,
        file: store.file,
        detail: "the file is not in the set",
      });
    }
  }

  const present: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) present.push(entry.name);
  }
  for (const name of present) {
    if (!listed.has(name)) {
      problems.push({
        kind: "unlisted_file",
        file: name,
        detail: "the file is in the set but not in the manifest",
      });
    }
  }

  try {
    const sums = parseChecksums(
      await readFile(join(directory, CHECKSUMS_FILE), "utf8"),
    );
    if (sums === null) {
      problems.push({
        kind: "checksums_mismatch",
        file: CHECKSUMS_FILE,
        detail: "SHA256SUMS is not readable",
      });
    } else {
      for (const name of present) {
        if (name === CHECKSUMS_FILE) continue;
        const expected = sums.get(name);
        if (expected === undefined) {
          problems.push({
            kind: "checksums_mismatch",
            file: name,
            detail: "SHA256SUMS does not list this file",
          });
          continue;
        }
        const { sha256 } = await hashFile(join(directory, name));
        if (sha256 !== expected) {
          problems.push({
            kind: "checksums_mismatch",
            file: name,
            detail: "the file does not match SHA256SUMS",
          });
        }
      }
      for (const name of sums.keys()) {
        if (!present.includes(name)) {
          problems.push({
            kind: "checksums_mismatch",
            file: name,
            detail: "SHA256SUMS lists a file that is not in the set",
          });
        }
      }
    }
  } catch {
    problems.push({
      kind: "checksums_mismatch",
      file: CHECKSUMS_FILE,
      detail: "SHA256SUMS is missing",
    });
  }
  if (options.keyFile !== undefined) {
    const entry = byId.get("secrets-key-identity");
    if (entry?.status !== "captured" || entry.keyFingerprint === undefined) {
      problems.push({
        kind: "key_mismatch",
        store: "secrets-key-identity",
        detail: "this backup recorded no secrets key to check against",
      });
    } else {
      let actual: string | null = null;
      try {
        actual = await readKeyFingerprint(options.keyFile);
      } catch {
        problems.push({
          kind: "key_mismatch",
          store: "secrets-key-identity",
          detail: "the key file could not be read",
        });
      }
      if (actual !== null && actual !== entry.keyFingerprint) {
        problems.push({
          kind: "key_mismatch",
          store: "secrets-key-identity",
          detail:
            "the key file is not the key this backup was taken with (its fingerprint differs)",
        });
      }
    }
  }
  return {
    complete: problems.length === 0,
    legacy: false,
    cutoff: manifest.cutoff ?? null,
    problems,
  };
}
