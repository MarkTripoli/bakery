import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  checkDestinationHost,
  createPinnedAgents,
  type HostResolver,
  resolveHostAddresses,
} from "../../../apps/server/src/modules/backups/dns.ts";
import {
  type BackupDestination,
  BackupDestinationInvalid,
  BackupProbeOutcome,
  createBackupS3Client,
  mapProbeError,
  resolveBackupDestination,
} from "../../../apps/server/src/modules/backups/s3.ts";
import type { FailureCode, RunnerSettings } from "./api.ts";
import type { Artifact } from "./backup-step.ts";
import { redact, type Secrets } from "./redact.ts";
import { isDeclaredIncomplete } from "./manifest.ts";
import { backupTimestamp, selectExpired } from "./retention.ts";

/** A part is this big; a file no bigger than one part goes up in one request. */
export const PART_BYTES = 64 * 1024 * 1024;

/** The off-site step failed; the code is one the server accepts. */
export class OffsiteError extends Error {
  constructor(readonly code: FailureCode, readonly detail: string) {
    super(`BACKUP_RUNNER_OFFSITE ${code}`);
  }
}

export type Credentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

export type Offsite = {
  readonly destination: BackupDestination;
  readonly credentials: Credentials;
};

/**
 * What the settings ask for, or null when there is no off-site copy to make.
 * Configured but withheld by the server (a refused address, an unresolvable
 * name, an invalid destination) is a failure here, never a silent skip: the
 * administrator asked for an off-site copy and has to learn why there is none.
 */
export function offsiteFromSettings(
  settings: RunnerSettings,
  options: { readonly allowLoopbackEndpoint: boolean },
): Offsite | null {
  if (!settings.offsiteConfigured) return null;
  if (settings.offsiteRefusal !== null) {
    throw refusalFor(settings.offsiteRefusal);
  }
  const { offsiteEndpoint, offsiteRegion, offsiteBucket, offsitePrefix } =
    settings;
  const { offsiteAccessKeyId, offsiteSecretAccessKey } = settings;
  if (
    offsiteEndpoint === null || offsiteRegion === null ||
    offsiteBucket === null ||
    offsiteAccessKeyId === null || offsiteSecretAccessKey === null
  ) {
    throw new OffsiteError(
      "runner_error",
      "The off-site destination is configured but the server released no credentials.",
    );
  }
  try {
    return {
      destination: resolveBackupDestination({
        endpoint: offsiteEndpoint,
        region: offsiteRegion,
        bucket: offsiteBucket,
        prefix: offsitePrefix ?? "",
      }, options),
      credentials: {
        accessKeyId: offsiteAccessKeyId,
        secretAccessKey: offsiteSecretAccessKey,
      },
    };
  } catch (error) {
    if (error instanceof BackupDestinationInvalid) {
      throw new OffsiteError("destination_refused", "destination_invalid");
    }
    throw error;
  }
}

function refusalFor(word: string): OffsiteError {
  return word === "destination_unresolvable"
    ? new OffsiteError("destination_unreachable", "destination_unresolvable")
    : new OffsiteError("destination_refused", word);
}

export type Connection = {
  readonly client: S3Client;
  readonly destination: BackupDestination;
};

/**
 * Re-resolves the destination's host NOW and holds it to the address policy,
 * then builds a client whose sockets can only reach validated addresses. The
 * runner repeats this itself, whatever the server decided: a name re-pointed
 * after the server's check must not be dialled.
 */
export async function connect(
  offsite: Offsite,
  options: {
    readonly resolve?: HostResolver;
    readonly signal?: AbortSignal;
    readonly requestMs?: number;
  } = {},
): Promise<Connection> {
  const resolve = options.resolve ?? resolveHostAddresses;
  const check = await checkDestinationHost(
    offsite.destination,
    resolve,
    options.signal,
  );
  if (!check.ok) throw refusalFor(check.refusal);
  const agents = createPinnedAgents(offsite.destination, resolve);
  const client = createBackupS3Client(
    offsite.destination,
    offsite.credentials,
    { attempts: 3, requestMs: options.requestMs ?? 10 * 60 * 1000 },
    agents,
  );
  return { client, destination: offsite.destination };
}

/** Maps an SDK error to the failure the server has a word for. */
export function offsiteErrorOf(
  error: unknown,
  credentials: Credentials,
  secrets: Secrets,
): OffsiteError {
  if (error instanceof OffsiteError) return error;
  const mapped = mapProbeError(error, credentials);
  const detail = redact(mapped.detail ?? "", secrets);
  switch (mapped.outcome) {
    case BackupProbeOutcome.DestinationRefused:
    case BackupProbeOutcome.DestinationPrivateAddress:
      return new OffsiteError(
        "destination_refused",
        mapped.outcome === BackupProbeOutcome.DestinationPrivateAddress
          ? "destination_private_address"
          : detail,
      );
    case BackupProbeOutcome.DestinationUnreachable:
      return new OffsiteError("destination_unreachable", detail);
    default:
      return new OffsiteError("runner_error", detail);
  }
}

/** Data files first; the checksum list last, so its presence marks a complete set. */
export function uploadOrder(artifact: Artifact) {
  const rank = (name: string) =>
    name === "SHA256SUMS" ? 2 : name === "release.json" ? 1 : 0;
  return [...artifact.files].sort((a, b) =>
    rank(a.name) - rank(b.name) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

async function putFile(
  client: S3Client,
  bucket: string,
  key: string,
  path: string,
  size: number,
  partBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const abortSignal = signal;
  if (size <= partBytes) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: await Deno.readFile(path),
        ContentLength: size,
      }),
      { abortSignal },
    );
    return;
  }
  const started = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    { abortSignal },
  );
  const uploadId = started.UploadId;
  if (!uploadId) {
    throw new Error("The destination started no multipart upload.");
  }
  try {
    const parts: { ETag: string; PartNumber: number }[] = [];
    using file = await Deno.open(path, { read: true });
    for (
      let number = 1, offset = 0;
      offset < size;
      number++, offset += partBytes
    ) {
      const length = Math.min(partBytes, size - offset);
      const chunk = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const n = await file.read(chunk.subarray(read));
        if (n === null) throw new Error("The backup file ended early.");
        read += n;
      }
      const sent = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: number,
          Body: chunk,
          ContentLength: length,
        }),
        { abortSignal },
      );
      if (!sent.ETag) throw new Error("The destination returned no part tag.");
      parts.push({ ETag: sent.ETag, PartNumber: number });
    }
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
      { abortSignal },
    );
  } catch (error) {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    ).catch(() => {});
    throw error;
  }
}

export type UploadOptions = {
  readonly offsite: Offsite;
  readonly artifact: Artifact;
  readonly secrets: Secrets;
  readonly signal?: AbortSignal;
  readonly resolve?: HostResolver;
  readonly partBytes?: number;
  readonly onFile?: (done: number, total: number) => void;
};

/**
 * Uploads every file of the set under `<prefix><name>/`, then verifies each
 * object by asking the destination for its size. Resolves only when every
 * object is present at its local size, which is what "off-site" means.
 */
export async function uploadSet(options: UploadOptions): Promise<void> {
  const { offsite, artifact } = options;
  const { client, destination } = await connect(offsite, {
    resolve: options.resolve,
    signal: options.signal,
  });
  try {
    const files = uploadOrder(artifact);
    let done = 0;
    for (const file of files) {
      const key = `${destination.prefix}${artifact.name}/${file.name}`;
      await putFile(
        client,
        destination.bucket,
        key,
        file.path,
        file.size,
        options.partBytes ?? PART_BYTES,
        options.signal,
      );
      const head = await client.send(
        new HeadObjectCommand({ Bucket: destination.bucket, Key: key }),
        { abortSignal: options.signal },
      );
      if (head.ContentLength !== file.size) {
        throw new OffsiteError(
          "runner_error",
          `The destination holds ${
            head.ContentLength ?? "no"
          } bytes of ${file.name}, expected ${file.size}.`,
        );
      }
      options.onFile?.(++done, files.length);
    }
  } catch (error) {
    throw offsiteErrorOf(error, offsite.credentials, options.secrets);
  } finally {
    client.destroy();
  }
}

/** The set names under the folder (its immediate sub-prefixes). */
async function listSetNames(
  client: S3Client,
  destination: BackupDestination,
): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: destination.bucket,
        Prefix: destination.prefix,
        Delimiter: "/",
        ContinuationToken: token,
      }),
    );
    for (const entry of page.CommonPrefixes ?? []) {
      const prefix = entry.Prefix ?? "";
      const name = prefix.slice(destination.prefix.length).replace(/\/$/, "");
      if (backupTimestamp(name) !== null) names.push(name);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  return names;
}

/**
 * Deletes the off-site sets older than `daysToKeep`, never the newest and never
 * the one just taken. Returns the names it removed.
 */
export async function pruneOffsite(options: {
  readonly offsite: Offsite;
  readonly artifactName: string;
  readonly daysToKeep: number;
  readonly now: Date;
  readonly resolve?: HostResolver;
  readonly signal?: AbortSignal;
}): Promise<string[]> {
  const { client, destination } = await connect(options.offsite, {
    resolve: options.resolve,
    signal: options.signal,
  });
  try {
    const names = await listSetNames(client, destination);
    const expired = selectExpired({
      names,
      now: options.now,
      daysToKeep: options.daysToKeep,
      protect: new Set([options.artifactName]),
    });
    for (const name of expired) {
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: destination.bucket,
            Prefix: `${destination.prefix}${name}/`,
            ContinuationToken: token,
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key) {
            await client.send(
              new DeleteObjectCommand({
                Bucket: destination.bucket,
                Key: object.Key,
              }),
            );
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
    }
    return expired;
  } finally {
    client.destroy();
  }
}

/** Deletes the local sets older than `daysToKeep` under `root`, with the same protections. */
export async function pruneLocal(options: {
  readonly root: string;
  readonly artifactName: string;
  readonly daysToKeep: number;
  readonly now: Date;
}): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(options.root)) {
    // Only real directories named like a set: a symlink or a file that happens
    // to carry such a name is not ours to remove.
    if (
      entry.isDirectory && !entry.isSymlink &&
      backupTimestamp(entry.name) !== null
    ) {
      names.push(entry.name);
    }
  }
  // A set that declared itself incomplete is prunable by age and never counts
  // as the newest good set.
  const incomplete = new Set<string>();
  for (const name of names) {
    if (await isDeclaredIncomplete(`${options.root}/${name}`)) {
      incomplete.add(name);
    }
  }
  const expired = selectExpired({
    names,
    now: options.now,
    daysToKeep: options.daysToKeep,
    protect: new Set([options.artifactName]),
    incomplete,
  });
  for (const name of expired) {
    await Deno.remove(`${options.root}/${name}`, { recursive: true });
  }
  return expired;
}
