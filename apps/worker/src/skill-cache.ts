import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { contractSchemas } from "../../../packages/contracts/src/contracts.ts";
import type {
  PreparedSkillRoot,
  SkillCacheIdentity,
  SkillFileManifestEntry,
  SkillMaterializationOwner,
  WorkerSkillVersionResponse,
} from "./types.ts";

const {
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_NOFOLLOW,
  O_RDONLY,
  O_WRONLY,
} = constants;
const CACHE_DIRECTORY = "skill-materialization-v1";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[0-9a-f-]{36}$/i;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/;
const LOCK_POLL_MS = 10;

const cacheUuid = z.string().uuid().describe(
  "Canonical UUID in an immutable worker skill-cache owner record.",
);
const cacheDigest = z.string().regex(SHA256).describe(
  "Lowercase SHA-256 identity in an immutable worker skill-cache record.",
);
const cacheDecimal = z.string().regex(POSITIVE_DECIMAL).describe(
  "Positive decimal session generation or fence in a cache owner record.",
);
const cacheRelativePath = z.string().min(1).max(500).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  !value.includes("\0") && !value.endsWith("/") &&
  !value.includes("//") && value.split("/").every((part) =>
    part !== "" && part !== "." && part !== ".."
  )
).describe("Validated relative entry path in a committed skill-cache record.");
const DurableOwnerSchema = z.object({
  dev: z.string().min(1).describe(
    "Pinned device identity of the private skill-cache root.",
  ),
  ino: z.string().min(1).describe(
    "Pinned inode identity of the private skill-cache root.",
  ),
  uid: z.number().int().nonnegative().describe(
    "Trusted same-UID owner of the private skill-cache root.",
  ),
  organizationId: cacheUuid.describe(
    "Authorized organization namespace of the exact cache key.",
  ),
  versionId: cacheUuid.describe(
    "Exact immutable skill-version UUID in the cache key.",
  ),
  digest: cacheDigest.describe(
    "Exact immutable manifest digest in the cache key.",
  ),
  workerHostId: cacheUuid.describe(
    "Exact worker host owning the durable cache lifecycle record.",
  ),
  workerSessionId: cacheUuid.describe(
    "Exact worker process session owning the lifecycle record.",
  ),
  workerSessionGeneration: cacheDecimal.describe(
    "Exact worker process-session generation owning the record.",
  ),
  jobId: cacheUuid.describe("Exact job owning the durable lifecycle record."),
  attemptId: cacheUuid.describe(
    "Exact execution attempt owning the durable lifecycle record.",
  ),
  fence: cacheDecimal.describe(
    "Exact job and attempt fence owning the lifecycle record.",
  ),
  stageId: cacheUuid.optional().describe(
    "Random private cache stage UUID when the record owns a cold stage.",
  ),
  copyId: cacheUuid.optional().describe(
    "Random private-copy UUID when the record owns an attempt tree.",
  ),
}).strict().describe(
  "Root-pinned exact owner record for a cache stage, durable pin, or private attempt tree.",
);
const CommitRecordSchema = z.object({
  schemaVersion: z.literal(1).describe(
    "Schema version for an immutable skill-cache commit marker.",
  ),
  keyHash: cacheDigest.describe(
    "SHA-256 pathname key derived from organization, version, and digest.",
  ),
  stageId: cacheUuid.describe(
    "Private cold stage UUID selected by the exclusive commit marker.",
  ),
  owner: DurableOwnerSchema.describe(
    "Exact root, cache, worker, session, job, attempt, and fence owner.",
  ),
  entryPath: cacheRelativePath.describe(
    "Manifest entry path in the committed immutable tree.",
  ),
  files: z.array(contractSchemas.SkillFileManifestEntry).max(256).describe(
    "Complete immutable file inventory verified for the committed tree.",
  ),
}).strict().describe(
  "Exclusive hard-linked publication record for one complete immutable cache tree.",
);

type FsIdentity = Readonly<{ dev: string; ino: string; uid: number }>;
type DurableOwner = Readonly<z.output<typeof DurableOwnerSchema>>;
type CommitRecord = Readonly<z.output<typeof CommitRecordSchema>>;
type VerifiedCacheEntry = Readonly<{
  identity: SkillCacheIdentity;
  keyHash: string;
  treePath: string;
  entryPath: string;
  files: readonly SkillFileManifestEntry[];
  cold: boolean;
}>;
type FileIdentity = Readonly<{ dev: string; ino: string }>;

export type SkillCacheReconciliation = "active" | "stale" | "unknown";
export type SkillCacheReconciler = (
  owner: SkillMaterializationOwner,
) => Promise<SkillCacheReconciliation>;

export type SkillCacheHooks = Readonly<{
  afterLock?: (identity: SkillCacheIdentity) => void | Promise<void>;
  afterStageCreated?: (
    identity: SkillCacheIdentity,
    stagePath: string,
  ) => void | Promise<void>;
  afterCommitLink?: (
    identity: SkillCacheIdentity,
  ) => void | Promise<void>;
  beforeCopyFile?: (
    file: SkillFileManifestEntry,
  ) => void | Promise<void>;
}>;

export class SkillCacheError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SkillCacheError";
  }
}

function fail(code: string): never {
  throw new SkillCacheError(code);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function mode(info: { mode: number }): number {
  return info.mode & 0o777;
}

function sameFsIdentity(
  left: { dev: string | number | bigint; ino: string | number | bigint },
  right: { dev: string | number | bigint; ino: string | number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino);
}

function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(canonical);
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  };
  return JSON.stringify(canonical(value));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hashValue(value: unknown): Promise<string> {
  return await sha256(new TextEncoder().encode(canonicalJson(value)));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
}

async function abortableDelay(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, LOCK_POLL_MS);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function validateRelativePath(path: string): void {
  if (
    path.length === 0 || path.startsWith("/") || path.includes("\\") ||
    path.includes("\0") || path.endsWith("/") || path.includes("//") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) fail("SKILL_CACHE_PATH_INVALID");
}

function assertIdentity(identity: SkillCacheIdentity): void {
  if (
    !SAFE_ID.test(identity.organizationId) ||
    !SAFE_ID.test(identity.versionId) || !SHA256.test(identity.digest)
  ) fail("SKILL_CACHE_IDENTITY_INVALID");
}

function assertOwner(owner: SkillMaterializationOwner): void {
  if (
    !SAFE_ID.test(owner.workerHostId) || !SAFE_ID.test(owner.workerSessionId) ||
    !SAFE_ID.test(owner.jobId) || !SAFE_ID.test(owner.attemptId) ||
    !POSITIVE_DECIMAL.test(owner.workerSessionGeneration) ||
    !POSITIVE_DECIMAL.test(owner.fence)
  ) fail("SKILL_CACHE_OWNER_INVALID");
}

function identityFromVersion(
  authorized: WorkerSkillVersionResponse,
): SkillCacheIdentity {
  return Object.freeze({
    organizationId: authorized.organizationId,
    versionId: authorized.version.id,
    digest: authorized.version.digest,
  });
}

function sameIdentity(
  left: SkillCacheIdentity,
  right: SkillCacheIdentity,
): boolean {
  return left.organizationId === right.organizationId &&
    left.versionId === right.versionId && left.digest === right.digest;
}

function sameManifest(
  left: WorkerSkillVersionResponse,
  right: WorkerSkillVersionResponse,
): boolean {
  return left.organizationId === right.organizationId &&
    left.version.id === right.version.id &&
    left.version.digest === right.version.digest &&
    left.version.entryPath === right.version.entryPath &&
    canonicalJson(left.version.manifest) ===
      canonicalJson(right.version.manifest) &&
    canonicalJson(left.files) === canonicalJson(right.files);
}

async function assertAuthorizedIdentity(
  identity: SkillCacheIdentity,
  authorized: WorkerSkillVersionResponse,
): Promise<void> {
  if (!sameIdentity(identity, identityFromVersion(authorized))) {
    fail("SKILL_CACHE_AUTHORITY_MISMATCH");
  }
  if (
    await hashValue(authorized.version.manifest) !== identity.digest ||
    authorized.version.status !== "published"
  ) fail("SKILL_CACHE_AUTHORITY_MISMATCH");
  validateRelativePath(authorized.version.entryPath);
  const paths = new Set<string>();
  for (const file of authorized.files) {
    validateRelativePath(file.path);
    if (paths.has(file.path)) fail("SKILL_CACHE_INVENTORY_INVALID");
    paths.add(file.path);
  }
  if (!paths.has(authorized.version.entryPath)) {
    fail("SKILL_CACHE_INVENTORY_INVALID");
  }
}

async function close(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) fail("SKILL_CACHE_WRITE_INCOMPLETE");
    offset += result.bytesWritten;
  }
}

async function writeExclusive(
  path: string,
  bytes: Uint8Array,
  expectedMode: number,
  uid: number,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      expectedMode,
    );
    await writeAll(handle, bytes);
    await handle.chmod(expectedMode);
    await handle.sync();
    const info = await handle.stat();
    if (
      !info.isFile() || info.isSymbolicLink() || info.uid !== uid ||
      mode(info) !== expectedMode || info.nlink !== 1
    ) fail("SKILL_CACHE_FILE_UNSAFE");
  } catch (error) {
    if (isNodeError(error, "ELOOP")) fail("SKILL_CACHE_SYMLINK");
    throw error;
  } finally {
    await close(handle);
  }
}

async function readSafeFile(
  path: string,
  uid: number,
  expectedMode: number,
  allowCommitLink = false,
): Promise<{ bytes: Uint8Array; identity: FileIdentity }> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink()) fail("SKILL_CACHE_SYMLINK");
    handle = await open(path, O_RDONLY | O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !before.isFile() || !info.isFile() || info.isSymbolicLink() ||
      !sameFsIdentity(before, info) || info.uid !== uid ||
      mode(info) !== expectedMode ||
      (allowCommitLink ? info.nlink < 1 || info.nlink > 2 : info.nlink !== 1)
    ) fail("SKILL_CACHE_FILE_UNSAFE");
    return {
      bytes: new Uint8Array(await handle.readFile()),
      identity: { dev: String(info.dev), ino: String(info.ino) },
    };
  } catch (error) {
    if (isNodeError(error, "ELOOP")) fail("SKILL_CACHE_SYMLINK");
    throw error;
  } finally {
    await close(handle);
  }
}

async function assertDirectory(
  path: string,
  uid: number,
  expectedMode = 0o700,
): Promise<FsIdentity> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink()) fail("SKILL_CACHE_SYMLINK");
    handle = await open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !before.isDirectory() || !info.isDirectory() ||
      !sameFsIdentity(before, info) || info.uid !== uid ||
      mode(info) !== expectedMode
    ) fail("SKILL_CACHE_DIRECTORY_UNSAFE");
    return { dev: String(info.dev), ino: String(info.ino), uid: info.uid };
  } catch (error) {
    if (isNodeError(error, "ELOOP")) fail("SKILL_CACHE_SYMLINK");
    throw error;
  } finally {
    await close(handle);
  }
}

async function createPrivateDirectory(
  path: string,
  uid: number,
): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await assertDirectory(path, uid);
}

function expectedDirectories(
  files: readonly SkillFileManifestEntry[],
): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return directories;
}

async function listTree(
  root: string,
  uid: number,
): Promise<{ files: Set<string>; directories: Set<string> }> {
  const files = new Set<string>();
  const directories = new Set<string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    await assertDirectory(directory, uid);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("SKILL_CACHE_SYMLINK");
      if (entry.isDirectory()) {
        directories.add(rel);
        await visit(path, rel);
      } else if (entry.isFile()) files.add(rel);
      else fail("SKILL_CACHE_INVENTORY_INVALID");
    }
  };
  await visit(root, "");
  return { files, directories };
}

async function verifyTree(
  root: string,
  files: readonly SkillFileManifestEntry[],
  uid: number,
  projection: "cache" | "attempt",
  sourceIdentities?: ReadonlyMap<string, FileIdentity>,
): Promise<Map<string, FileIdentity>> {
  const actual = await listTree(root, uid);
  const expectedFiles = new Set(files.map((file) => file.path));
  const expectedDirs = expectedDirectories(files);
  if (
    canonicalJson([...actual.files].sort()) !==
      canonicalJson([...expectedFiles].sort()) ||
    canonicalJson([...actual.directories].sort()) !==
      canonicalJson([...expectedDirs].sort())
  ) fail("SKILL_CACHE_INVENTORY_INVALID");

  const identities = new Map<string, FileIdentity>();
  for (const file of files) {
    const expectedMode = projection === "cache"
      ? file.isExecutable ? 0o500 : 0o400
      : file.isExecutable
      ? 0o700
      : 0o600;
    const verified = await readSafeFile(
      join(root, ...file.path.split("/")),
      uid,
      expectedMode,
    );
    if (
      verified.bytes.byteLength !== file.sizeBytes ||
      await sha256(verified.bytes) !== file.sha256
    ) fail("SKILL_CACHE_CONTENT_INVALID");
    const source = sourceIdentities?.get(file.path);
    if (source && sameFsIdentity(source, verified.identity)) {
      fail("SKILL_CACHE_ATTEMPT_NOT_INDEPENDENT");
    }
    identities.set(file.path, verified.identity);
  }
  return identities;
}

async function parseJsonFile(
  path: string,
  uid: number,
  allowCommitLink = false,
): Promise<unknown> {
  const { bytes } = await readSafeFile(path, uid, 0o600, allowCommitLink);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail("SKILL_CACHE_RECORD_INVALID");
  }
}

function durableOwner(
  root: FsIdentity,
  identity: SkillCacheIdentity,
  owner: SkillMaterializationOwner,
  extra: { stageId?: string; copyId?: string } = {},
): DurableOwner {
  return Object.freeze({ ...root, ...identity, ...owner, ...extra });
}

function isDurableOwner(
  value: unknown,
  root: FsIdentity,
): value is DurableOwner {
  const parsed = DurableOwnerSchema.safeParse(value);
  return parsed.success && parsed.data.dev === root.dev &&
    parsed.data.ino === root.ino && parsed.data.uid === root.uid;
}

function isCommitRecord(
  value: unknown,
  keyHash: string,
  root: FsIdentity,
): value is CommitRecord {
  const parsed = CommitRecordSchema.safeParse(value);
  return parsed.success && parsed.data.keyHash === keyHash &&
    isDurableOwner(parsed.data.owner, root);
}

function below(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) &&
    !rel.includes("\0");
}

export class SkillCache {
  readonly #configuredRoot: string;
  readonly #uid: number;
  readonly #hooks?: SkillCacheHooks;
  #rootPath: string | null = null;
  #rootIdentity: FsIdentity | null = null;
  #initializing: Promise<void> | null = null;

  constructor(
    stateDir: string,
    options: { uid?: number; hooks?: SkillCacheHooks } = {},
  ) {
    const uid = options.uid ?? Deno.uid();
    if (uid === null) fail("SKILL_CACHE_OS_UNSUPPORTED");
    this.#uid = uid;
    this.#configuredRoot = join(stateDir, CACHE_DIRECTORY);
    this.#hooks = options.hooks;
  }

  get rootPath(): string {
    if (!this.#rootPath) fail("SKILL_CACHE_NOT_INITIALIZED");
    return this.#rootPath;
  }

  async initialize(): Promise<void> {
    if (this.#rootPath) {
      await this.#assertRoot();
      return;
    }
    if (this.#initializing) return await this.#initializing;
    this.#initializing = this.#initialize();
    try {
      await this.#initializing;
    } finally {
      this.#initializing = null;
    }
  }

  async #initialize(): Promise<void> {
    await Deno.mkdir(dirname(this.#configuredRoot), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await mkdir(this.#configuredRoot, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const configured = await lstat(this.#configuredRoot);
    if (configured.isSymbolicLink()) fail("SKILL_CACHE_SYMLINK");
    const rootPath = await realpath(this.#configuredRoot);
    const rootIdentity = await assertDirectory(rootPath, this.#uid);
    this.#rootPath = rootPath;
    this.#rootIdentity = rootIdentity;
    for (const name of ["locks", "objects", "commits", "pins", "attempts"]) {
      await createPrivateDirectory(join(rootPath, name), this.#uid);
    }
    await syncDirectory(rootPath);
  }

  async #assertRoot(): Promise<FsIdentity> {
    if (!this.#rootPath || !this.#rootIdentity) {
      fail("SKILL_CACHE_NOT_INITIALIZED");
    }
    if (await realpath(this.#rootPath) !== this.#rootPath) {
      fail("SKILL_CACHE_ROOT_CHANGED");
    }
    const current = await assertDirectory(this.#rootPath, this.#uid);
    if (!sameFsIdentity(current, this.#rootIdentity)) {
      fail("SKILL_CACHE_ROOT_CHANGED");
    }
    return current;
  }

  async #keyHash(identity: SkillCacheIdentity): Promise<string> {
    assertIdentity(identity);
    return await hashValue([
      identity.organizationId,
      identity.versionId,
      identity.digest,
    ]);
  }

  async withKeyLockForTest<T>(
    identity: SkillCacheIdentity,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    await this.initialize();
    const keyHash = await this.#keyHash(identity);
    return await this.#withKeyLock(identity, keyHash, signal, work);
  }

  async #withKeyLock<T>(
    identity: SkillCacheIdentity,
    keyHash: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const root = await this.#assertRoot();
    const lockPath = join(this.rootPath, "locks", `${keyHash}.lock`);
    let file: Deno.FsFile | undefined;
    let locked = false;
    try {
      try {
        const existing = await Deno.lstat(lockPath);
        if (existing.isSymlink || !existing.isFile) {
          fail("SKILL_CACHE_LOCK_UNSAFE");
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        try {
          await writeExclusive(lockPath, new Uint8Array(), 0o600, this.#uid);
        } catch (createError) {
          if (!isNodeError(createError, "EEXIST")) throw createError;
        }
      }
      try {
        file = await Deno.open(lockPath, { read: true, write: true });
      } catch (error) {
        if (error instanceof Deno.errors.NotSupported) {
          fail("SKILL_CACHE_OS_LOCK_UNSUPPORTED");
        }
        throw error;
      }
      const before = await Deno.lstat(lockPath);
      const current = await file.stat();
      if (
        before.isSymlink || !before.isFile || before.dev === null ||
        before.ino === null || !current.isFile || current.dev === null ||
        current.ino === null || current.uid === null || current.mode === null ||
        current.nlink === null
      ) fail("SKILL_CACHE_LOCK_UNSAFE");
      if (
        !sameFsIdentity(
          { dev: before.dev, ino: before.ino },
          { dev: current.dev, ino: current.ino },
        ) ||
        current.uid !== root.uid || (current.mode & 0o777) !== 0o600 ||
        current.nlink !== 1
      ) fail("SKILL_CACHE_LOCK_UNSAFE");
      while (!(locked = await file.tryLock(true))) {
        await abortableDelay(signal);
      }
      throwIfAborted(signal);
      await this.#assertRoot();
      await this.#hooks?.afterLock?.(identity);
      throwIfAborted(signal);
      return await work();
    } catch (error) {
      if (error instanceof Deno.errors.NotSupported) {
        fail("SKILL_CACHE_OS_LOCK_UNSUPPORTED");
      }
      throw error;
    } finally {
      if (file) {
        try {
          if (locked) await file.unlock();
        } finally {
          file.close();
        }
      }
    }
  }

  async acquire(
    identity: SkillCacheIdentity,
    owner: SkillMaterializationOwner,
    authorized: WorkerSkillVersionResponse,
    signal: AbortSignal,
    fetchFile: (file: SkillFileManifestEntry) => Promise<Uint8Array>,
    reauthorizeCold: () => Promise<WorkerSkillVersionResponse>,
  ): Promise<VerifiedCacheEntry> {
    await this.initialize();
    assertIdentity(identity);
    assertOwner(owner);
    await assertAuthorizedIdentity(identity, authorized);
    const keyHash = await this.#keyHash(identity);
    return await this.#withKeyLock(identity, keyHash, signal, async () => {
      const warm = await this.#verifyCommitted(keyHash, identity, authorized);
      if (warm) return { ...warm, cold: false };

      const root = await this.#assertRoot();
      const stageId = crypto.randomUUID();
      const keyObjectRoot = join(this.rootPath, "objects", keyHash);
      await createPrivateDirectory(keyObjectRoot, this.#uid);
      const stagePath = join(keyObjectRoot, stageId);
      await createPrivateDirectory(stagePath, this.#uid);
      const treePath = join(stagePath, "tree");
      await createPrivateDirectory(treePath, this.#uid);
      const durable = durableOwner(root, identity, owner, { stageId });
      await writeExclusive(
        join(stagePath, "owner.json"),
        new TextEncoder().encode(`${canonicalJson(durable)}\n`),
        0o600,
        this.#uid,
      );
      let published = false;
      try {
        await this.#hooks?.afterStageCreated?.(identity, stagePath);
        for (const file of authorized.files) {
          throwIfAborted(signal);
          const parts = file.path.split("/");
          let parent = treePath;
          for (const part of parts.slice(0, -1)) {
            parent = join(parent, part);
            await createPrivateDirectory(parent, this.#uid);
          }
          const bytes = await fetchFile(file);
          throwIfAborted(signal);
          if (
            bytes.byteLength !== file.sizeBytes ||
            await sha256(bytes) !== file.sha256
          ) fail("SKILL_CACHE_CONTENT_INVALID");
          await writeExclusive(
            join(treePath, ...parts),
            bytes,
            file.isExecutable ? 0o500 : 0o400,
            this.#uid,
          );
          await syncDirectory(parent);
        }
        await verifyTree(treePath, authorized.files, this.#uid, "cache");
        const current = await reauthorizeCold();
        if (!sameManifest(authorized, current)) {
          fail("SKILL_CACHE_AUTHORITY_MISMATCH");
        }
        throwIfAborted(signal);
        const entry = await this.#publish(
          keyHash,
          identity,
          durable,
          authorized,
          stagePath,
          signal,
        );
        published = entry.treePath === treePath;
        return { ...entry, cold: true };
      } finally {
        if (!published) {
          const winner = await this.#commitStageId(keyHash).catch(() => null);
          if (winner !== stageId) {
            await rm(stagePath, { recursive: true, force: true }).catch(
              () => undefined,
            );
          }
        }
      }
    });
  }

  async #publish(
    keyHash: string,
    identity: SkillCacheIdentity,
    owner: DurableOwner,
    authorized: WorkerSkillVersionResponse,
    stagePath: string,
    signal: AbortSignal,
  ): Promise<VerifiedCacheEntry> {
    const commit: CommitRecord = Object.freeze({
      schemaVersion: 1,
      keyHash,
      stageId: owner.stageId!,
      owner,
      entryPath: authorized.version.entryPath,
      files: authorized.files,
    });
    const source = join(stagePath, "commit.json");
    await writeExclusive(
      source,
      new TextEncoder().encode(`${canonicalJson(commit)}\n`),
      0o600,
      this.#uid,
    );
    await syncDirectory(stagePath);
    throwIfAborted(signal);
    const destination = join(this.rootPath, "commits", keyHash);
    try {
      await link(source, destination);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const winner = await this.#verifyCommitted(keyHash, identity, authorized);
      if (!winner) fail("SKILL_CACHE_COMMIT_INVALID");
      await unlink(source).catch(() => undefined);
      return winner;
    }
    await this.#hooks?.afterCommitLink?.(identity);
    const sourceInfo = await lstat(source);
    const destinationInfo = await lstat(destination);
    if (!sameFsIdentity(sourceInfo, destinationInfo)) {
      fail("SKILL_CACHE_COMMIT_CHANGED");
    }
    await unlink(source);
    await syncDirectory(join(this.rootPath, "commits"));
    const winner = await this.#verifyCommitted(keyHash, identity, authorized);
    if (!winner) fail("SKILL_CACHE_COMMIT_INVALID");
    return winner;
  }

  async #commitStageId(keyHash: string): Promise<string | null> {
    try {
      const root = await this.#assertRoot();
      const value = await parseJsonFile(
        join(this.rootPath, "commits", keyHash),
        this.#uid,
        true,
      );
      return isCommitRecord(value, keyHash, root) ? value.stageId : null;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async #verifyCommitted(
    keyHash: string,
    identity: SkillCacheIdentity,
    authorized: WorkerSkillVersionResponse,
  ): Promise<VerifiedCacheEntry | null> {
    const root = await this.#assertRoot();
    let value: unknown;
    try {
      value = await parseJsonFile(
        join(this.rootPath, "commits", keyHash),
        this.#uid,
        true,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    if (!isCommitRecord(value, keyHash, root)) {
      fail("SKILL_CACHE_COMMIT_INVALID");
    }
    if (
      !sameIdentity(value.owner, identity) ||
      value.owner.stageId !== value.stageId ||
      value.entryPath !== authorized.version.entryPath ||
      canonicalJson(value.files) !== canonicalJson(authorized.files)
    ) fail("SKILL_CACHE_COMMIT_INVALID");
    const stagePath = join(this.rootPath, "objects", keyHash, value.stageId);
    const stageOwner = await parseJsonFile(
      join(stagePath, "owner.json"),
      this.#uid,
    );
    if (
      !isDurableOwner(stageOwner, root) ||
      canonicalJson(stageOwner) !== canonicalJson(value.owner)
    ) fail("SKILL_CACHE_OWNER_INVALID");
    const treePath = join(stagePath, "tree");
    await verifyTree(treePath, authorized.files, this.#uid, "cache");
    return Object.freeze({
      identity,
      keyHash,
      treePath,
      entryPath: value.entryPath,
      files: value.files,
      cold: false,
    });
  }

  async prepareAttempt(
    entry: VerifiedCacheEntry,
    owner: SkillMaterializationOwner,
    authorized: WorkerSkillVersionResponse,
    signal: AbortSignal,
  ): Promise<PreparedSkillRoot> {
    await this.initialize();
    assertOwner(owner);
    await assertAuthorizedIdentity(entry.identity, authorized);
    return await this.#withKeyLock(
      entry.identity,
      entry.keyHash,
      signal,
      async () => {
        const current = await this.#verifyCommitted(
          entry.keyHash,
          entry.identity,
          authorized,
        );
        if (!current) fail("SKILL_CACHE_COMMIT_MISSING");
        throwIfAborted(signal);
        const root = await this.#assertRoot();
        const ownerRecord = durableOwner(root, entry.identity, owner);
        const ownerHash = await hashValue(ownerRecord);
        const pinDirectory = join(this.rootPath, "pins", entry.keyHash);
        await createPrivateDirectory(pinDirectory, this.#uid);
        const pinPath = join(pinDirectory, `${ownerHash}.json`);
        await writeExclusive(
          pinPath,
          new TextEncoder().encode(`${canonicalJson(ownerRecord)}\n`),
          0o600,
          this.#uid,
        );
        await syncDirectory(pinDirectory);

        const attemptParent = join(
          this.rootPath,
          "attempts",
          owner.workerHostId,
          owner.workerSessionId,
          owner.workerSessionGeneration,
          owner.attemptId,
          owner.fence,
        );
        await this.#createAttemptParents(attemptParent);
        const copyId = crypto.randomUUID();
        const stagePath = join(attemptParent, `${copyId}.stage`);
        const finalPath = join(attemptParent, copyId);
        await createPrivateDirectory(stagePath, this.#uid);
        const attemptOwner = durableOwner(root, entry.identity, owner, {
          copyId,
        });
        await writeExclusive(
          join(stagePath, "owner.json"),
          new TextEncoder().encode(`${canonicalJson(attemptOwner)}\n`),
          0o600,
          this.#uid,
        );
        const attemptTree = join(stagePath, "tree");
        await createPrivateDirectory(attemptTree, this.#uid);
        try {
          const cacheIdentities = await verifyTree(
            current.treePath,
            current.files,
            this.#uid,
            "cache",
          );
          for (const file of current.files) {
            throwIfAborted(signal);
            await this.#hooks?.beforeCopyFile?.(file);
            throwIfAborted(signal);
            const source = await readSafeFile(
              join(current.treePath, ...file.path.split("/")),
              this.#uid,
              file.isExecutable ? 0o500 : 0o400,
            );
            let parent = attemptTree;
            const parts = file.path.split("/");
            for (const part of parts.slice(0, -1)) {
              parent = join(parent, part);
              await createPrivateDirectory(parent, this.#uid);
            }
            await writeExclusive(
              join(attemptTree, ...parts),
              source.bytes,
              file.isExecutable ? 0o700 : 0o600,
              this.#uid,
            );
            await syncDirectory(parent);
          }
          await verifyTree(
            attemptTree,
            current.files,
            this.#uid,
            "attempt",
            cacheIdentities,
          );
          throwIfAborted(signal);
          try {
            await lstat(finalPath);
            fail("SKILL_CACHE_ATTEMPT_PATH_EXISTS");
          } catch (error) {
            if (!isNodeError(error, "ENOENT")) throw error;
          }
          await rename(stagePath, finalPath);
          await syncDirectory(attemptParent);
          return Object.freeze({
            ...entry.identity,
            ...owner,
            rootPath: join(finalPath, "tree"),
            entryPath: current.entryPath,
          });
        } catch (error) {
          await rm(stagePath, { recursive: true, force: true }).catch(
            () => undefined,
          );
          await rm(finalPath, { recursive: true, force: true }).catch(
            () => undefined,
          );
          await unlink(pinPath).catch(() => undefined);
          throw error;
        }
      },
    );
  }

  async #createAttemptParents(path: string): Promise<void> {
    const root = join(this.rootPath, "attempts");
    if (!below(root, path)) fail("SKILL_CACHE_ATTEMPT_PATH_INVALID");
    let current = root;
    const rel = relative(root, path);
    for (const part of rel.split(sep)) {
      if (!part || !/^[A-Za-z0-9-]+$/.test(part)) {
        fail("SKILL_CACHE_ATTEMPT_PATH_INVALID");
      }
      current = join(current, part);
      await createPrivateDirectory(current, this.#uid);
    }
  }

  async releasePrepared(prepared: PreparedSkillRoot): Promise<void> {
    await this.initialize();
    const identity: SkillCacheIdentity = Object.freeze({
      organizationId: prepared.organizationId,
      versionId: prepared.versionId,
      digest: prepared.digest,
    });
    const owner: SkillMaterializationOwner = Object.freeze({
      workerHostId: prepared.workerHostId,
      workerSessionId: prepared.workerSessionId,
      workerSessionGeneration: prepared.workerSessionGeneration,
      jobId: prepared.jobId,
      attemptId: prepared.attemptId,
      fence: prepared.fence,
    });
    assertIdentity(identity);
    assertOwner(owner);
    const keyHash = await this.#keyHash(identity);
    const neverAbort = new AbortController().signal;
    await this.#withKeyLock(identity, keyHash, neverAbort, async () => {
      const root = await this.#assertRoot();
      const expectedOwner = durableOwner(root, identity, owner);
      const ownerHash = await hashValue(expectedOwner);
      const finalPath = dirname(prepared.rootPath);
      const expectedBase = join(
        this.rootPath,
        "attempts",
        owner.workerHostId,
        owner.workerSessionId,
        owner.workerSessionGeneration,
        owner.attemptId,
        owner.fence,
      );
      if (
        dirname(finalPath) !== expectedBase ||
        basename(prepared.rootPath) !== "tree"
      ) {
        fail("SKILL_CACHE_RELEASE_OWNER_MISMATCH");
      }
      const copyId = basename(finalPath);
      if (!SAFE_ID.test(copyId)) fail("SKILL_CACHE_RELEASE_OWNER_MISMATCH");
      const record = await parseJsonFile(
        join(finalPath, "owner.json"),
        this.#uid,
      );
      const expectedAttemptOwner = durableOwner(root, identity, owner, {
        copyId,
      });
      if (
        !isDurableOwner(record, root) ||
        canonicalJson(record) !== canonicalJson(expectedAttemptOwner)
      ) fail("SKILL_CACHE_RELEASE_OWNER_MISMATCH");
      const pinPath = join(
        this.rootPath,
        "pins",
        keyHash,
        `${ownerHash}.json`,
      );
      const pin = await parseJsonFile(pinPath, this.#uid);
      if (
        !isDurableOwner(pin, root) ||
        canonicalJson(pin) !== canonicalJson(expectedOwner)
      ) fail("SKILL_CACHE_RELEASE_OWNER_MISMATCH");
      await rm(finalPath, { recursive: true });
      await unlink(pinPath);
      await syncDirectory(dirname(pinPath));
    });
  }

  async recover(
    reconcile: SkillCacheReconciler,
    signal: AbortSignal,
  ): Promise<void> {
    await this.initialize();
    const root = await this.#assertRoot();
    const committed = new Set<string>();
    for (const entry of await readdir(join(this.rootPath, "commits"))) {
      throwIfAborted(signal);
      if (!SHA256.test(entry)) continue;
      try {
        const value = await parseJsonFile(
          join(this.rootPath, "commits", entry),
          this.#uid,
          true,
        );
        if (isCommitRecord(value, entry, root)) {
          committed.add(`${entry}/${value.stageId}`);
        }
      } catch {
        // Unknown or corrupt owner state is preserved for operator inspection.
      }
    }

    const candidates: Array<{
      path: string;
      owner: DurableOwner;
      kind: "stage" | "attempt" | "pin";
    }> = [];
    const objectRoot = join(this.rootPath, "objects");
    for (const key of await readdir(objectRoot, { withFileTypes: true })) {
      if (!key.isDirectory() || !SHA256.test(key.name)) continue;
      for (
        const stage of await readdir(join(objectRoot, key.name), {
          withFileTypes: true,
        })
      ) {
        if (
          !stage.isDirectory() || !SAFE_ID.test(stage.name) ||
          committed.has(`${key.name}/${stage.name}`)
        ) continue;
        const path = join(objectRoot, key.name, stage.name);
        const owner = await this.#readRecoverableOwner(
          join(path, "owner.json"),
          root,
        );
        if (owner?.stageId === stage.name) {
          candidates.push({ path, owner, kind: "stage" });
        }
      }
    }
    await this.#collectOwnerRecords(
      join(this.rootPath, "attempts"),
      "owner.json",
      "attempt",
      root,
      candidates,
    );
    await this.#collectOwnerRecords(
      join(this.rootPath, "pins"),
      undefined,
      "pin",
      root,
      candidates,
    );

    const reconciliations = new Map<string, SkillCacheReconciliation>();
    for (const candidate of candidates) {
      throwIfAborted(signal);
      if (!(await this.#recoverCandidateMatches(candidate))) continue;
      const reconciliationKey = canonicalJson({
        workerHostId: candidate.owner.workerHostId,
        workerSessionId: candidate.owner.workerSessionId,
        workerSessionGeneration: candidate.owner.workerSessionGeneration,
        jobId: candidate.owner.jobId,
        attemptId: candidate.owner.attemptId,
        fence: candidate.owner.fence,
      });
      let decision = reconciliations.get(reconciliationKey);
      if (!decision) {
        try {
          decision = await reconcile(candidate.owner);
        } catch {
          decision = "unknown";
        }
        reconciliations.set(reconciliationKey, decision);
      }
      if (decision !== "stale") continue;
      throwIfAborted(signal);
      const identity: SkillCacheIdentity = candidate.owner;
      const keyHash = await this.#keyHash(identity);
      await this.#withKeyLock(identity, keyHash, signal, async () => {
        const current = candidate.kind === "pin"
          ? await this.#readRecoverableOwner(candidate.path, root)
          : await this.#readRecoverableOwner(
            join(candidate.path, "owner.json"),
            root,
          );
        if (
          !current || canonicalJson(current) !== canonicalJson(candidate.owner)
        ) {
          return;
        }
        if (candidate.kind === "stage") {
          const winner = await this.#commitStageId(keyHash);
          if (winner === candidate.owner.stageId) return;
        }
        await rm(candidate.path, {
          recursive: candidate.kind !== "pin",
          force: false,
        });
      });
    }
  }

  async #recoverCandidateMatches(
    candidate: {
      path: string;
      owner: DurableOwner;
      kind: "stage" | "attempt" | "pin";
    },
  ): Promise<boolean> {
    const keyHash = await this.#keyHash(candidate.owner);
    if (candidate.kind === "stage") {
      return candidate.owner.stageId !== undefined && candidate.path === join(
            this.rootPath,
            "objects",
            keyHash,
            candidate.owner.stageId,
          );
    }
    if (candidate.kind === "pin") {
      const ownerHash = await hashValue(candidate.owner);
      return candidate.owner.stageId === undefined &&
        candidate.owner.copyId === undefined && candidate.path === join(
            this.rootPath,
            "pins",
            keyHash,
            `${ownerHash}.json`,
          );
    }
    if (!candidate.owner.copyId) return false;
    const parent = join(
      this.rootPath,
      "attempts",
      candidate.owner.workerHostId,
      candidate.owner.workerSessionId,
      candidate.owner.workerSessionGeneration,
      candidate.owner.attemptId,
      candidate.owner.fence,
    );
    return candidate.owner.stageId === undefined &&
      (candidate.path === join(parent, candidate.owner.copyId) ||
        candidate.path === join(parent, `${candidate.owner.copyId}.stage`));
  }

  async #readRecoverableOwner(
    path: string,
    root: FsIdentity,
  ): Promise<DurableOwner | null> {
    try {
      const value = await parseJsonFile(path, this.#uid);
      return isDurableOwner(value, root) ? value : null;
    } catch {
      return null;
    }
  }

  async #collectOwnerRecords(
    rootPath: string,
    ownerName: string | undefined,
    kind: "attempt" | "pin",
    root: FsIdentity,
    candidates: Array<{
      path: string;
      owner: DurableOwner;
      kind: "stage" | "attempt" | "pin";
    }>,
  ): Promise<void> {
    const visit = async (path: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const child = join(path, entry.name);
        if (ownerName && entry.isDirectory()) {
          const owner = await this.#readRecoverableOwner(
            join(child, ownerName),
            root,
          );
          if (
            owner &&
            (owner.copyId === entry.name ||
              `${owner.copyId}.stage` === entry.name)
          ) {
            candidates.push({ path: child, owner, kind });
            continue;
          }
          await visit(child);
        } else if (
          !ownerName && entry.isFile() && entry.name.endsWith(".json")
        ) {
          const owner = await this.#readRecoverableOwner(child, root);
          if (owner) candidates.push({ path: child, owner, kind });
        } else if (entry.isDirectory()) await visit(child);
      }
    };
    await visit(rootPath);
  }
}
