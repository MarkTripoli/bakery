import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  type DriverContext,
  isStoragePath,
  MAX_STORAGE_READ_BYTES,
  type StorageChangeEvent,
  type StorageListPage,
  type StorageObject,
  storageParentPath,
  type StoragePort,
  type StorageReadInput,
  type StorageReadResult,
  type StorageWriteResult,
} from "@bakery/integration-sdk/provider";
import type { StorageProviderEntry } from "./storage-connections.ts";

export const LOCAL_DISK_PROVIDER = "local-disk";
export const LOCAL_DISK_ADAPTER_VERSION = "local-disk@1";
export const MAX_LOCAL_DISK_WALK = 10_000;
export const LOCAL_DISK_CHUNK_BYTES = 64 * 1024;
const MAX_NAME_BYTES = 255;
const CTIME_RESOLUTION_NS = 1_000_000_000n;
const STAGING_PREFIX = ".bakery-write-";
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW |
  constants.O_NONBLOCK;
const STAGING_FLAGS = constants.O_WRONLY | constants.O_CREAT |
  constants.O_EXCL | constants.O_NOFOLLOW;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  html: "text/html",
};

export type LocalDiskFile = { handle: FileHandle; stats: BigIntStats };

export type LocalDiskStaging = LocalDiskFile & { path: string };

export type ChunkReader = {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
};

type FolderScan = {
  visited: number;
  folders: string[];
  files: Array<{ path: string; stats: BigIntStats }>;
};

function mediaTypeOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown })?.code;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ||
    code === "ENAMETOOLONG";
}

async function unlessMissing<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function fitsDisk(path: string): boolean {
  return isStoragePath(path) &&
    path.split("/").every((segment) =>
      Buffer.byteLength(segment, "utf8") <= MAX_NAME_BYTES
    );
}

function reportableName(name: string): boolean {
  return name.length <= MAX_NAME_BYTES && !name.startsWith(STAGING_PREFIX) &&
    isStoragePath("/" + name);
}

function listable(entry: Dirent): boolean {
  return (entry.isFile() || entry.isDirectory()) && reportableName(entry.name);
}

function nameOf(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}

function childPath(folder: string, name: string): string {
  return folder === "/" ? "/" + name : folder + "/" + name;
}

function joined(base: string, path: string): string {
  return path === "/" ? base : base + path;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameVersion(a: BigIntStats, b: BigIntStats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs;
}

function latest(...times: bigint[]): bigint {
  return times.reduce((a, b) => a > b ? a : b);
}

function changedNs(stats: BigIntStats): bigint {
  const ctimeCeiling = stats.ctimeNs + CTIME_RESOLUTION_NS - 1n;
  const written = stats.mtimeNs < ctimeCeiling ? stats.mtimeNs : ctimeCeiling;
  return latest(stats.ctimeNs, stats.birthtimeNs, written);
}

function revisionOf(stats: BigIntStats): string {
  return `${stats.size}-${changedNs(stats)}-${stats.mtimeNs}-${stats.ino}`;
}

function objectOf(path: string, stats: BigIntStats): StorageObject {
  if (stats.isDirectory()) {
    return {
      path,
      name: nameOf(path),
      kind: "folder",
      sizeBytes: null,
      mediaType: null,
      revision: null,
      modifiedAt: null,
    };
  }
  return {
    path,
    name: nameOf(path),
    kind: "file",
    sizeBytes: Number(stats.size),
    mediaType: mediaTypeOf(nameOf(path)),
    revision: revisionOf(stats),
    modifiedAt: new Date(Number(stats.mtimeNs / 1_000_000n)).toISOString(),
  };
}

function positionOf(path: string, stats: BigIntStats): string {
  return changedNs(stats).toString().padStart(24, "0") + ":" +
    createHash("sha256").update(path).digest("hex");
}

function encodeCursor(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

function emptyPage(): StorageListPage {
  return { items: [], nextCursor: null };
}

export async function lstatInside(
  base: string,
  path: string,
): Promise<BigIntStats | null> {
  if (!fitsDisk(path)) return null;
  let real = base;
  let stats = await unlessMissing(lstat(real, { bigint: true }));
  for (const segment of path === "/" ? [] : path.slice(1).split("/")) {
    if (stats === null || !stats.isDirectory()) return null;
    real += "/" + segment;
    stats = await unlessMissing(lstat(real, { bigint: true }));
  }
  return stats !== null && (stats.isFile() || stats.isDirectory())
    ? stats
    : null;
}

async function stillAt(
  base: string,
  path: string,
  expected: BigIntStats,
): Promise<boolean> {
  const now = await lstatInside(base, path);
  return now !== null && sameFile(now, expected);
}

export async function openInside(
  base: string,
  path: string,
  walked: BigIntStats,
): Promise<LocalDiskFile | null> {
  if (!walked.isFile()) return null;
  const handle = await unlessMissing(open(joined(base, path), READ_FLAGS));
  if (handle === null) return null;
  let file: LocalDiskFile | null = null;
  try {
    const stats = await handle.stat({ bigint: true });
    if (
      stats.isFile() && sameFile(stats, walked) &&
      await stillAt(base, path, stats)
    ) {
      file = { handle, stats };
    }
    return file;
  } finally {
    if (file === null) await handle.close();
  }
}

async function openAt(
  base: string,
  path: string,
): Promise<LocalDiskFile | null> {
  const walked = await lstatInside(base, path);
  return walked === null ? null : await openInside(base, path, walked);
}

async function readInto(
  reader: ChunkReader,
  bytes: Uint8Array,
  position: number,
): Promise<number> {
  let done = 0;
  while (done < bytes.length) {
    const { bytesRead } = await reader.read(
      bytes,
      done,
      bytes.length - done,
      position + done,
    );
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done;
}

export async function readOpened(
  path: string,
  file: LocalDiskFile,
  input: Pick<StorageReadInput, "range" | "revision">,
): Promise<StorageReadResult> {
  const object = objectOf(path, file.stats);
  if (input.revision !== null && input.revision !== object.revision) {
    return { kind: "stale", current: object };
  }
  const offset = input.range?.offset ?? 0;
  const length = input.range?.length ?? MAX_STORAGE_READ_BYTES;
  const bytes = new Uint8Array(
    Math.max(0, Math.min(length, Number(file.stats.size) - offset)),
  );
  const done = await readInto(file.handle, bytes, offset);
  const after = await file.handle.stat({ bigint: true });
  if (!sameVersion(after, file.stats)) {
    return { kind: "stale", current: objectOf(path, after) };
  }
  return { kind: "bytes", object, bytes: bytes.subarray(0, done) };
}

export async function holdsBytes(
  reader: ChunkReader,
  size: bigint,
  bytes: Uint8Array,
): Promise<boolean> {
  if (size !== BigInt(bytes.byteLength)) return false;
  const chunk = new Uint8Array(
    Math.min(LOCAL_DISK_CHUNK_BYTES, bytes.byteLength),
  );
  for (let offset = 0; offset < bytes.byteLength; offset += chunk.length) {
    const wanted = chunk.subarray(
      0,
      Math.min(chunk.length, bytes.byteLength - offset),
    );
    const done = await readInto(reader, wanted, offset);
    if (
      done !== wanted.length ||
      Buffer.compare(wanted, bytes.subarray(offset, offset + done)) !== 0
    ) {
      return false;
    }
  }
  return true;
}

async function alreadyHolds(
  base: string,
  path: string,
  bytes: Uint8Array,
): Promise<StorageObject | null> {
  const file = await openAt(base, path);
  if (file === null) return null;
  try {
    const same = await holdsBytes(file.handle, file.stats.size, bytes);
    const after = await file.handle.stat({ bigint: true });
    return same && sameVersion(after, file.stats)
      ? objectOf(path, file.stats)
      : null;
  } finally {
    await file.handle.close();
  }
}

function keepSmallest(names: string[], name: string, count: number): void {
  if (names.length === count && name >= names[count - 1]) return;
  let low = 0;
  let high = names.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (names[middle] < name) low = middle + 1;
    else high = middle;
  }
  names.splice(low, 0, name);
  if (names.length > count) names.pop();
}

export async function namesAfter(
  real: string,
  after: string | null,
  count: number,
): Promise<string[]> {
  const names: string[] = [];
  const folder = await unlessMissing(opendir(real));
  if (folder === null) return names;
  for await (const entry of folder) {
    if (listable(entry) && (after === null || entry.name > after)) {
      keepSmallest(names, entry.name, count);
    }
  }
  return names;
}

async function scanFolder(
  base: string,
  path: string,
  budget: number,
): Promise<FolderScan | null> {
  const folder = await lstatInside(base, path);
  if (folder === null || !folder.isDirectory()) return null;
  const real = joined(base, path);
  const entries = await unlessMissing(opendir(real));
  if (entries === null) return null;
  const scan: FolderScan = { visited: 0, folders: [], files: [] };
  for await (const entry of entries) {
    if (scan.visited >= budget) break;
    if (!listable(entry)) continue;
    scan.visited++;
    const child = childPath(path, entry.name);
    if (entry.isDirectory()) {
      scan.folders.push(child);
      continue;
    }
    const stats = await unlessMissing(
      lstat(real + "/" + entry.name, { bigint: true }),
    );
    if (stats !== null && stats.isFile()) {
      scan.files.push({ path: child, stats });
    }
  }
  return await stillAt(base, path, folder) ? scan : null;
}

async function statAt(
  base: string,
  path: string,
): Promise<StorageObject | null> {
  const walked = await lstatInside(base, path);
  if (walked === null || !(await stillAt(base, path, walked))) return null;
  return objectOf(path, walked);
}

async function ensureFolder(real: string): Promise<boolean> {
  try {
    await mkdir(real);
  } catch (error) {
    if (errorCode(error) !== "EEXIST" && !isMissing(error)) throw error;
  }
  const stats = await unlessMissing(lstat(real));
  return stats !== null && stats.isDirectory();
}

async function makeParents(base: string, path: string): Promise<boolean> {
  const parent = storageParentPath(path);
  if (parent === "/") return true;
  let real = base;
  for (const segment of parent.slice(1).split("/")) {
    real += "/" + segment;
    if (!(await ensureFolder(real))) return false;
  }
  return true;
}

export async function openStaging(
  base: string,
  path: string,
): Promise<LocalDiskStaging | null> {
  const staging = childPath(
    storageParentPath(path),
    STAGING_PREFIX + randomUUID(),
  );
  const real = joined(base, staging);
  const handle = await unlessMissing(open(real, STAGING_FLAGS, 0o640));
  if (handle === null) return null;
  let opened: LocalDiskStaging | null = null;
  try {
    const stats = await handle.stat({ bigint: true });
    if (await stillAt(base, staging, stats)) {
      opened = { handle, stats, path: staging };
    }
    return opened;
  } finally {
    if (opened === null) {
      await handle.close();
      await unlessMissing(unlink(real));
    }
  }
}

async function place(
  base: string,
  from: string,
  to: string,
  create: boolean,
): Promise<boolean> {
  try {
    if (create) await link(joined(base, from), joined(base, to));
    else await rename(joined(base, from), joined(base, to));
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST" || code === "EISDIR" || isMissing(error)) {
      return false;
    }
    throw error;
  }
}

export function createLocalDiskStoragePort(
  root: string,
  segments: readonly string[] = [],
): StoragePort {
  async function realBase(): Promise<string | null> {
    try {
      let base = await realpath(root);
      for (const segment of segments) {
        const next = base + "/" + segment;
        if (!(await lstat(next)).isDirectory()) return null;
        base = next;
      }
      return base;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  return {
    async list(input) {
      const base = await realBase();
      if (base === null) return emptyPage();
      const folder = await lstatInside(base, input.path);
      if (folder === null || !folder.isDirectory()) return emptyPage();
      const real = joined(base, input.path);
      const names = await namesAfter(
        real,
        input.cursor === null ? null : decodeCursor(input.cursor),
        input.limit + 1,
      );
      const items: StorageObject[] = [];
      let used = 0;
      for (; used < names.length && items.length < input.limit; used++) {
        const stats = await unlessMissing(
          lstat(real + "/" + names[used], { bigint: true }),
        );
        if (stats !== null && (stats.isFile() || stats.isDirectory())) {
          items.push(objectOf(childPath(input.path, names[used]), stats));
        }
      }
      if (!(await stillAt(base, input.path, folder))) return emptyPage();
      return {
        items,
        nextCursor: names.length > input.limit
          ? encodeCursor(names[used - 1])
          : null,
      };
    },

    async stat(input) {
      const base = await realBase();
      return base === null ? null : await statAt(base, input.path);
    },

    async read(input) {
      const base = await realBase();
      const file = base === null ? null : await openAt(base, input.path);
      if (file === null) return { kind: "missing" };
      try {
        return await readOpened(input.path, file, input);
      } finally {
        await file.handle.close();
      }
    },

    async write(input): Promise<StorageWriteResult> {
      const refused: StorageWriteResult = { kind: "conflict", current: null };
      if (input.path === "/" || !fitsDisk(input.path)) return refused;
      const base = await realBase();
      if (base === null || !(await makeParents(base, input.path))) {
        return refused;
      }
      const current = await statAt(base, input.path);
      if (current?.kind === "folder") return { kind: "conflict", current };
      const matches = input.ifMatch === null
        ? current === null
        : current?.revision === input.ifMatch;
      if (!matches) {
        const held = current === null
          ? null
          : await alreadyHolds(base, input.path, input.bytes);
        return held === null
          ? { kind: "conflict", current }
          : { kind: "written", object: held };
      }
      const staging = await openStaging(base, input.path);
      if (staging === null) return refused;
      try {
        await staging.handle.writeFile(input.bytes);
      } finally {
        await staging.handle.close();
      }
      try {
        const placed = await place(
          base,
          staging.path,
          input.path,
          input.ifMatch === null,
        );
        if (!placed) {
          return { kind: "conflict", current: await statAt(base, input.path) };
        }
      } finally {
        await unlessMissing(unlink(joined(base, staging.path)));
      }
      const landed = await lstatInside(base, input.path);
      if (landed === null || !sameFile(landed, staging.stats)) {
        return {
          kind: "conflict",
          current: landed === null ? null : objectOf(input.path, landed),
        };
      }
      return { kind: "written", object: objectOf(input.path, landed) };
    },

    async changes(input) {
      const base = await realBase();
      if (base === null) return { events: [], position: input.since };
      const found: StorageChangeEvent[] = [];
      let highest: string | null = null;
      const folders = ["/"];
      let visited = 0;
      while (folders.length > 0 && visited < MAX_LOCAL_DISK_WALK) {
        const scan = await scanFolder(
          base,
          folders.shift()!,
          MAX_LOCAL_DISK_WALK - visited,
        );
        if (scan === null) continue;
        visited += scan.visited;
        folders.push(...scan.folders);
        for (const file of scan.files) {
          const position = positionOf(file.path, file.stats);
          if (highest === null || position > highest) highest = position;
          if (input.since !== null && position <= input.since) continue;
          found.push({
            kind: input.since === null ? "created" : "updated",
            path: file.path,
            revision: revisionOf(file.stats),
            position,
          });
        }
      }
      found.sort((a, b) => a.position < b.position ? -1 : 1);
      const events = found.slice(0, input.limit);
      const position = events.length > 0
        ? events[events.length - 1].position
        : input.since ?? highest;
      return { events, position };
    },
  };
}

function localDriverContext(): DriverContext {
  const origin = new URL("file:///");
  return {
    provider: {
      send() {
        return Promise.reject(new Error("LOCAL_DISK_HAS_NO_NETWORK"));
      },
    },
    origin: { apiBaseUrl: origin, webBaseUrl: origin },
    signal: new AbortController().signal,
    now: () => new Date(),
  };
}

export function createLocalDiskStorageProvider(
  root: string,
): StorageProviderEntry {
  if (!root.startsWith("/")) throw new Error("STORAGE_LOCAL_ROOT_INVALID");
  return {
    provider: LOCAL_DISK_PROVIDER,
    bind(connection) {
      if (!UUID.test(connection.organizationId) || !UUID.test(connection.id)) {
        return undefined;
      }
      return {
        port: createLocalDiskStoragePort(root, [
          connection.organizationId.toLowerCase(),
          connection.id.toLowerCase(),
        ]),
        ctx: localDriverContext(),
        adapterVersion: LOCAL_DISK_ADAPTER_VERSION,
      };
    },
  };
}
