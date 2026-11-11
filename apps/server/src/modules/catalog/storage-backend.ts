import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { SecretsKeyConfig } from "@bakery/config";
import type { PgTransactionClient } from "../../platform/database.ts";
import { SkillFileStore } from "./storage.ts";
import { SkillFileStoreError, type SkillObjectStore } from "./storage-port.ts";
import { S3SkillObjectStore } from "./s3-store.ts";
import {
  type R2Connection,
  type R2Credentials,
  resolveR2Connection,
  SKILL_STORAGE_CONFIG_INVALID,
  SkillStorageBackend,
} from "./skill-storage-config.ts";
import {
  openSkillStorageCredentials,
  readSkillStorageSettings,
  type SettingsQueryable,
  type StoredSkillStorageSettings,
} from "./skill-storage-settings.ts";

/** A resolved, ready-to-use storage target; credentials live only in memory. */
export type ResolvedSkillStorage =
  | { readonly backend: "filesystem"; readonly root: string }
  | {
    readonly backend: "r2";
    readonly connection: R2Connection;
    readonly credentials: R2Credentials;
  };

/** Facts the resolver needs from the process, never from the environment. */
export type SkillStorageResolverOptions = {
  /** Private filesystem root (`BAKERY_SKILL_FILE_ROOT`); also the import scratch root. */
  readonly filesystemRoot?: string;
  readonly secretsKey?: SecretsKeyConfig;
  /** True only when BAKERY_ENV is test: a stored loopback endpoint is honoured. */
  readonly allowLoopbackEndpoint: boolean;
};

export function createSkillS3Client(
  connection: Pick<R2Connection, "endpoint">,
  credentials: R2Credentials,
  timeouts: { readonly attempts: number; readonly requestMs: number } = {
    attempts: 3,
    requestMs: 30000,
  },
): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: connection.endpoint,
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

type LiveStore = {
  readonly store: SkillObjectStore;
  /** Releases the connection pool of an S3 client; a no-op for the filesystem. */
  readonly close: () => void;
};

/** Builds the adapter for one resolved target. */
export function openResolvedSkillStore(
  resolved: ResolvedSkillStorage,
): LiveStore {
  if (resolved.backend === SkillStorageBackend.Filesystem) {
    return { store: new SkillFileStore(resolved.root), close: () => {} };
  }
  const client = createSkillS3Client(
    resolved.connection,
    resolved.credentials,
  );
  return {
    store: new S3SkillObjectStore(client, resolved.connection.bucket),
    close: () => client.destroy(),
  };
}

/**
 * Resolves the settings row to a usable target. Filesystem needs the process
 * root; r2 validates and pins the endpoint, then decrypts the credentials.
 */
export async function resolveSkillStorage(
  query: SettingsQueryable,
  settings: StoredSkillStorageSettings | null,
  options: SkillStorageResolverOptions,
  backend: SkillStorageBackend = settings?.backend ??
    SkillStorageBackend.Filesystem,
): Promise<ResolvedSkillStorage> {
  if (backend === SkillStorageBackend.Filesystem) {
    if (options.filesystemRoot === undefined) {
      throw new SkillFileStoreError("SKILL_FILE_STORE_UNSUPPORTED");
    }
    return { backend, root: options.filesystemRoot };
  }
  if (
    settings === null || settings.accountId === null ||
    settings.bucket === null || settings.secretId === null
  ) throw new SkillFileStoreError(SKILL_STORAGE_CONFIG_INVALID);
  const connection = resolveR2Connection(
    {
      accountId: settings.accountId,
      bucket: settings.bucket,
      endpointOverride: settings.endpointOverride,
    },
    { allowLoopbackEndpoint: options.allowLoopbackEndpoint },
  );
  const credentials = await openSkillStorageCredentials(
    query,
    options.secretsKey,
    settings,
  );
  return { backend, connection, credentials };
}

/**
 * The store every caller holds. It resolves the active backend per operation
 * from the installation settings row and rebuilds its adapter only when the
 * row's version changes, so a rotation, bucket change or backend switch takes
 * effect on the next operation without a restart and without startup order.
 */
export class DatabaseSkillObjectStore implements SkillObjectStore {
  #current: { version: number; live: LiveStore } | undefined;
  #retired: LiveStore[] = [];
  #rebuilding: Promise<LiveStore> | undefined;

  constructor(
    private readonly database: SettingsQueryable,
    private readonly options: SkillStorageResolverOptions,
  ) {}

  async #active(): Promise<LiveStore> {
    // A settings read that fails is a dependency outage, not a storage error.
    const settings = await readSkillStorageSettings(this.database).catch(
      (error) => {
        throw error instanceof SkillFileStoreError
          ? error
          : new SkillFileStoreError("SKILL_FILE_DEPENDENCY_UNAVAILABLE");
      },
    );
    const version = settings?.version ?? 0;
    const cached = this.#current;
    if (cached?.version === version) return cached.live;
    // A slower concurrent read of an older row must not roll the adapter back.
    if (cached && version < cached.version) return cached.live;
    // One rebuild at a time; concurrent operations on a new version wait for it.
    if (this.#rebuilding === undefined) {
      this.#rebuilding = (async () => {
        const resolved = await resolveSkillStorage(
          this.database,
          settings,
          this.options,
        );
        const live = openResolvedSkillStore(resolved);
        // A client replaced just now may still serve an in-flight operation;
        // only the one before it is closed.
        if (cached) this.#retired.push(cached.live);
        while (this.#retired.length > 1) this.#retired.shift()?.close();
        this.#current = { version, live };
        return live;
      })().finally(() => {
        this.#rebuilding = undefined;
      });
    }
    const live = await this.#rebuilding;
    return this.#current?.version === version ? live : await this.#active();
  }

  async putIfAbsent(
    objectKey: string,
    content: Uint8Array,
    expectedSha256: string,
  ): Promise<void> {
    await (await this.#active()).store.putIfAbsent(
      objectKey,
      content,
      expectedSha256,
    );
  }

  async read(
    objectKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<Uint8Array> {
    return await (await this.#active()).store.read(
      objectKey,
      expectedSha256,
      expectedSize,
    );
  }

  async recover(
    objectKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<void> {
    await (await this.#active()).store.recover(
      objectKey,
      expectedSha256,
      expectedSize,
    );
  }

  async *list() {
    yield* (await this.#active()).store.list();
  }

  /** Releases every S3 client this store opened. */
  close(): void {
    this.#current?.live.close();
    this.#current = undefined;
    for (const live of this.#retired.splice(0)) live.close();
  }
}

/**
 * The server's skill object store. Defined whenever the process has a private
 * root: that root also hosts Git import scratch, so r2 mode keeps it too.
 */
export function createSkillObjectStore(
  database: Pick<PgTransactionClient, "query">,
  options: SkillStorageResolverOptions,
): DatabaseSkillObjectStore | undefined {
  return options.filesystemRoot === undefined
    ? undefined
    : new DatabaseSkillObjectStore(database, options);
}

/** Fixed result codes of the verification probe; no provider text escapes. */
export const SkillStorageVerificationOutcome = Object.freeze(
  {
    Verified: "verified",
    NotConfigured: "not_configured",
    CredentialsRejected: "credentials_rejected",
    AccessDenied: "access_denied",
    BucketNotFound: "bucket_not_found",
    EndpointUnreachable: "endpoint_unreachable",
    IntegrityFailed: "integrity_failed",
    ProviderError: "provider_error",
  } as const,
);
export type SkillStorageVerificationOutcome =
  (typeof SkillStorageVerificationOutcome)[
    keyof typeof SkillStorageVerificationOutcome
  ];

const CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "InvalidToken",
  "ExpiredToken",
  "Unauthorized",
]);

class ProbeIntegrityError extends Error {}

/** Maps any probe failure to one fixed outcome; provider text is dropped. */
export function mapProbeError(error: unknown): SkillStorageVerificationOutcome {
  if (error instanceof ProbeIntegrityError) {
    return SkillStorageVerificationOutcome.IntegrityFailed;
  }
  if (error instanceof S3ServiceException) {
    const status = error.$metadata.httpStatusCode;
    if (error.name === "NoSuchBucket") {
      return SkillStorageVerificationOutcome.BucketNotFound;
    }
    if (CREDENTIAL_ERRORS.has(error.name) || status === 401) {
      return SkillStorageVerificationOutcome.CredentialsRejected;
    }
    if (status === 403) return SkillStorageVerificationOutcome.AccessDenied;
    return SkillStorageVerificationOutcome.ProviderError;
  }
  // No HTTP response at all: DNS, connect, TLS, timeout or abort.
  return SkillStorageVerificationOutcome.EndpointUnreachable;
}

/**
 * Bounded probe: puts a random sentinel under `bakery-probe/`, reads it back,
 * compares its digest and deletes it. The prefix is outside the inventory
 * prefix, so a left-over sentinel never reaches a skill inventory. One attempt
 * per call and a hard deadline keep a stuck provider from holding a request.
 */
export async function probeSkillStorage(
  connection: R2Connection,
  credentials: R2Credentials,
  signal?: AbortSignal,
): Promise<SkillStorageVerificationOutcome> {
  const client = createSkillS3Client(connection, credentials, {
    attempts: 1,
    requestMs: 10000,
  });
  const abortSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  try {
    const key = `bakery-probe/${crypto.randomUUID()}`;
    const body = crypto.getRandomValues(new Uint8Array(32));
    const digest = createHash("sha256").update(body).digest("base64");
    await client.send(
      new PutObjectCommand({
        Bucket: connection.bucket,
        Key: key,
        Body: body,
        IfNoneMatch: "*",
        ChecksumSHA256: digest,
      }),
      { abortSignal },
    );
    const read = await client.send(
      new GetObjectCommand({ Bucket: connection.bucket, Key: key }),
      { abortSignal },
    );
    const bytes = await read.Body?.transformToByteArray();
    if (
      !bytes ||
      createHash("sha256").update(bytes).digest("base64") !== digest
    ) throw new ProbeIntegrityError();
    await client.send(
      new DeleteObjectCommand({ Bucket: connection.bucket, Key: key }),
      { abortSignal },
    );
    return SkillStorageVerificationOutcome.Verified;
  } catch (error) {
    return mapProbeError(error);
  } finally {
    client.destroy();
  }
}
