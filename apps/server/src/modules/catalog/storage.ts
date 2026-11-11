import {
  assertSkillObjectKey,
  SkillFileStoreError,
  type SkillObject,
  type SkillObjectStore,
} from "./storage-port.ts";
export { SkillFileStoreError } from "./storage-port.ts";
import { constants, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import {
  link,
  lstat as nodeLstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const {
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_NOFOLLOW,
  O_RDONLY,
  O_WRONLY,
} = constants;
const TEMP_NAME = /^\.bakery-tmp-[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Identity = { dev: number; ino: number };
type StoreStat = Identity & {
  mode: number;
  uid: number;
  nlink: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
};

export type SkillFileStoreOperations = Pick<
  SkillObjectStore,
  "recover" | "putIfAbsent" | "read"
>;

type SkillFileStorePaths = Readonly<{
  parent: string;
  temporary: string;
  destination: string;
}>;

export type SkillFileStoreHooks = Readonly<{
  beforeLink?: (paths: SkillFileStorePaths) => void | Promise<void>;
  /** Returning `simulate-crash` leaves the linked temporary name for recovery. */
  afterLink?: (
    paths: SkillFileStorePaths,
  ) => void | "simulate-crash" | Promise<void | "simulate-crash">;
  beforeRecoverUnlink?: (
    paths: SkillFileStorePaths,
  ) => void | Promise<void>;
}>;

function unsupported(): never {
  throw new SkillFileStoreError("SKILL_FILE_STORE_UNSUPPORTED");
}
function fail(code: string): never {
  throw new SkillFileStoreError(code);
}
function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
function mode(stat: { mode: number }): number {
  return stat.mode & 0o777;
}
function identity(stat: { dev: number; ino: number }): Identity {
  return { dev: stat.dev, ino: stat.ino };
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function fileNameFromKey(root: string, key: string): string {
  if (
    key.includes("\\") || key.includes("\0") || key.startsWith("/") ||
    key.split("/").some((part) => part === "" || part === "." || part === "..")
  ) fail("SKILL_FILE_KEY_INVALID");
  const resolved = join(root, key);
  const rel = relative(root, resolved);
  if (rel.startsWith(".." + sep) || rel === ".." || rel.includes("\0")) {
    fail("SKILL_FILE_KEY_INVALID");
  }
  return resolved;
}

async function lstat(path: string): Promise<StoreStat> {
  let handle;
  try {
    const pathStat = await nodeLstat(path);
    if (pathStat.isSymbolicLink()) fail("SKILL_FILE_SYMLINK");
    handle = await open(path, O_RDONLY | O_NOFOLLOW);
    const stat = await handle.stat();
    if (!sameIdentity(identity(pathStat), identity(stat))) {
      fail("SKILL_FILE_PATH_CHANGED");
    }
    return {
      ...identity(stat),
      mode: mode(stat),
      uid: stat.uid,
      nlink: stat.nlink,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
  } catch (error) {
    if (error instanceof SkillFileStoreError) throw error;
    if (isNotFound(error)) fail("SKILL_FILE_NOT_FOUND");
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      fail("SKILL_FILE_SYMLINK");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertPrivateDirectory(
  path: string,
  expectedUid: number,
): Promise<Identity> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink || !stat.isDirectory || stat.uid !== expectedUid ||
    stat.mode !== 0o700
  ) fail("SKILL_FILE_DIRECTORY_UNSAFE");
  return identity(stat);
}

async function openPrivateDirectory(
  path: string,
  expectedUid: number,
): Promise<{ handle: Awaited<ReturnType<typeof open>>; identity: Identity }> {
  try {
    const handle = await open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isDirectory() || stat.uid !== expectedUid || mode(stat) !== 0o700
    ) {
      await handle.close();
      fail("SKILL_FILE_DIRECTORY_UNSAFE");
    }
    return { handle, identity: identity(stat) };
  } catch (error) {
    if (error instanceof SkillFileStoreError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      fail("SKILL_FILE_SYMLINK");
    }
    throw error;
  }
}

async function ensurePrivateDirectory(
  path: string,
  uid: number,
): Promise<void> {
  if (Deno.build.os !== "linux") unsupported();
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  await assertPrivateDirectory(path, uid);
}

async function ensureFanout(
  root: string,
  key: string,
  uid: number,
): Promise<string> {
  const parts = key.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    await assertPrivateDirectory(current, uid);
  }
  return join(current, parts.at(-1)!);
}

async function sha256File(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<string> {
  const hash = createHash("sha256");
  let size = 0;
  const bytes = new Uint8Array(await handle.readFile());
  hash.update(bytes);
  size = bytes.byteLength;
  return `${hash.digest("hex")}\0${size}`;
}

async function verifyFile(
  path: string,
  uid: number,
  expectedSha256: string,
  expectedSize: number,
): Promise<StoreStat> {
  if (!SHA256.test(expectedSha256)) fail("SKILL_FILE_DIGEST_INVALID");
  let handle;
  try {
    const pathStat = await nodeLstat(path);
    if (pathStat.isSymbolicLink()) fail("SKILL_FILE_SYMLINK");
    handle = await open(path, O_RDONLY | O_NOFOLLOW);
    const stat = await handle.stat();
    if (stat.isSymbolicLink()) fail("SKILL_FILE_SYMLINK");
    if (
      !stat.isFile() || stat.uid !== uid || (mode(stat) & 0o077) !== 0 ||
      stat.size !== expectedSize
    ) fail("SKILL_FILE_OBJECT_UNSAFE");
    const digestAndSize = await sha256File(handle);
    const [digest, sizeText] = digestAndSize.split("\0");
    if (digest !== expectedSha256 || Number(sizeText) !== expectedSize) {
      fail("SKILL_CONTENT_INTEGRITY_FAILED");
    }
    return {
      ...identity(stat),
      mode: mode(stat),
      uid: stat.uid,
      nlink: stat.nlink,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
  } catch (error) {
    if (error instanceof SkillFileStoreError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      fail("SKILL_FILE_NOT_FOUND");
    }
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      fail("SKILL_FILE_SYMLINK");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Linux/Deno private no-follow store for generated immutable object keys. */
export class SkillFileStore implements SkillObjectStore {
  readonly #root: string;
  readonly #uid: number;
  readonly #hooks?: SkillFileStoreHooks;

  constructor(
    root: string,
    uid = Deno.uid() ?? -1,
    options: Readonly<{
      platform?: typeof Deno.build.os;
      hooks?: SkillFileStoreHooks;
    }> = {},
  ) {
    if ((options.platform ?? Deno.build.os) !== "linux") unsupported();
    if (uid < 0) fail("SKILL_FILE_UID_UNAVAILABLE");
    if (!root.startsWith("/") || root.includes("\0")) {
      fail("SKILL_FILE_ROOT_INVALID");
    }
    this.#root = root;
    this.#uid = uid;
    this.#hooks = options.hooks;
  }

  async *list(): AsyncIterable<SkillObject> {
    await this.initialize();
    const pending = [this.#root];
    while (pending.length) {
      const directory = pending.pop();
      if (!directory) break;
      await assertPrivateDirectory(directory, this.#uid);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (
            directory === this.#root && entry.name === ".bakery-source-scratch"
          ) continue;
          pending.push(path);
        } else if (TEMP_NAME.test(entry.name)) {
          continue;
        } else {
          const key = relative(this.#root, path);
          assertSkillObjectKey(key);
          const stat = await nodeLstat(path);
          const sha256 = key.slice(-64);
          await this.read(key, sha256, stat.size);
          yield { objectKey: key, sha256, sizeBytes: stat.size };
        }
      }
    }
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#root, this.#uid);
  }

  async putIfAbsent(
    objectKey: string,
    content: Uint8Array,
    expectedSha256: string,
  ): Promise<void> {
    if (createHash("sha256").update(content).digest("hex") !== expectedSha256) {
      fail("SKILL_CONTENT_INTEGRITY_FAILED");
    }
    await this.initialize();
    fileNameFromKey(this.#root, objectKey);
    const destination = await ensureFanout(this.#root, objectKey, this.#uid);
    const parent = dirname(destination);
    const parentIdentity = await assertPrivateDirectory(parent, this.#uid);
    const temp = join(parent, `.bakery-tmp-${crypto.randomUUID()}`);
    let temporary;
    let preserveTemporary = false;
    try {
      temporary = await open(
        temp,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
        0o600,
      );
      let written = 0;
      while (written < content.byteLength) {
        const result = await temporary.write(content.subarray(written));
        written += result.bytesWritten;
      }
      await temporary.sync();
      const temporaryStat = await temporary.stat();
      if (
        !temporaryStat.isFile() || temporaryStat.uid !== this.#uid ||
        mode(temporaryStat) !== 0o600
      ) {
        fail("SKILL_FILE_TEMP_UNSAFE");
      }
      await temporary.close();
      temporary = undefined;
      const paths = Object.freeze({
        parent,
        temporary: temp,
        destination,
      });
      await this.#hooks?.beforeLink?.(paths);
      const beforeLink = await assertPrivateDirectory(parent, this.#uid);
      if (!sameIdentity(parentIdentity, beforeLink)) {
        fail("SKILL_FILE_PARENT_CHANGED");
      }
      try {
        await link(temp, destination);
      } catch (error) {
        if (!isExists(error)) throw error;
        await verifyFile(
          destination,
          this.#uid,
          expectedSha256,
          content.byteLength,
        );
        return;
      }
      const afterLinkHook = await this.#hooks?.afterLink?.(paths);
      if (afterLinkHook === "simulate-crash") {
        preserveTemporary = true;
        throw new Error("SKILL_FILE_STORE_SIMULATED_CRASH");
      }
      const afterLink = await assertPrivateDirectory(parent, this.#uid);
      if (!sameIdentity(beforeLink, afterLink)) {
        fail("SKILL_FILE_PARENT_CHANGED");
      }
      const destinationStat = await verifyFile(
        destination,
        this.#uid,
        expectedSha256,
        content.byteLength,
      );
      const tempStat = await lstat(temp);
      if (!sameIdentity(tempStat, destinationStat)) {
        fail("SKILL_FILE_LINK_CHANGED");
      }
      await unlink(temp);
      const directory = await openPrivateDirectory(parent, this.#uid);
      try {
        await directory.handle.sync();
      } finally {
        await directory.handle.close();
      }
    } catch (error) {
      if (error instanceof SkillFileStoreError) throw error;
      throw error;
    } finally {
      await temporary?.close().catch(() => undefined);
      if (!preserveTemporary) await unlink(temp).catch(() => undefined);
    }
  }

  async read(
    objectKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<Uint8Array> {
    await this.initialize();
    const path = fileNameFromKey(this.#root, objectKey);
    await verifyFile(path, this.#uid, expectedSha256, expectedSize);
    try {
      const handle = await open(path, O_RDONLY | O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== expectedSize) {
          fail("SKILL_CONTENT_INTEGRITY_FAILED");
        }
        const bytes = new Uint8Array(await handle.readFile());
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== expectedSha256) fail("SKILL_CONTENT_INTEGRITY_FAILED");
        return bytes;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof SkillFileStoreError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ELOOP") {
        fail("SKILL_FILE_SYMLINK");
      }
      throw error;
    }
  }

  async recover(
    objectKey: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<void> {
    await this.initialize();
    const destination = fileNameFromKey(this.#root, objectKey);
    const parent = dirname(destination);
    const parentIdentity = await assertPrivateDirectory(parent, this.#uid);
    const destinationStat = await verifyFile(
      destination,
      this.#uid,
      expectedSha256,
      expectedSize,
    );
    const entries = await readdir(parent, { withFileTypes: true }) as Dirent[];
    const candidates = entries.filter((entry) =>
      entry.isFile() && TEMP_NAME.test(entry.name)
    );
    if (destinationStat.nlink !== 2 || candidates.length !== 1) {
      if (destinationStat.nlink > 1) fail("SKILL_FILE_ORPHAN_UNSAFE");
      return;
    }
    const temp = join(parent, candidates[0].name);
    const paths = Object.freeze({ parent, temporary: temp, destination });
    await this.#hooks?.beforeRecoverUnlink?.(paths);
    const beforeUnlink = await assertPrivateDirectory(parent, this.#uid);
    if (!sameIdentity(parentIdentity, beforeUnlink)) {
      fail("SKILL_FILE_PARENT_CHANGED");
    }
    const tempStat = await lstat(temp);
    if (
      !sameIdentity(destinationStat, tempStat) || tempStat.uid !== this.#uid ||
      !tempStat.isFile || tempStat.mode !== 0o600
    ) {
      fail("SKILL_FILE_ORPHAN_UNSAFE");
    }
    await unlink(temp);
    const directory = await openPrivateDirectory(parent, this.#uid);
    try {
      if (!sameIdentity(parentIdentity, directory.identity)) {
        fail("SKILL_FILE_PARENT_CHANGED");
      }
      await directory.handle.sync();
    } finally {
      await directory.handle.close();
    }
    const after = await verifyFile(
      destination,
      this.#uid,
      expectedSha256,
      expectedSize,
    );
    if (after.nlink !== 1) fail("SKILL_FILE_ORPHAN_UNSAFE");
  }
}
