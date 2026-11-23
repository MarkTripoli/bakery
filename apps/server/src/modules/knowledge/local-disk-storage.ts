import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import {
  type DriverContext,
  isStoragePath,
  MAX_STORAGE_READ_BYTES,
  type StorageChangeEvent,
  type StorageObject,
  storageParentPath,
  type StoragePort,
  type StorageWriteResult,
} from "@bakery/integration-sdk/provider";
import type { StorageProviderEntry } from "./storage-connections.ts";

export const LOCAL_DISK_PROVIDER = "local-disk";
export const LOCAL_DISK_ADAPTER_VERSION = "local-disk@1";
export const MAX_LOCAL_DISK_WALK = 10_000;
const STAGING_PREFIX = ".bakery-write-";
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

function mediaTypeOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function reportableName(name: string): boolean {
  return name.length <= 255 && !name.startsWith(STAGING_PREFIX) &&
    isStoragePath("/" + name);
}

function nameOf(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}

function childPath(folder: string, name: string): string {
  return folder === "/" ? "/" + name : folder + "/" + name;
}

function revisionOf(stats: BigIntStats): string {
  return `${stats.size}-${stats.mtimeNs}-${stats.ino}`;
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
  return stats.mtimeNs.toString().padStart(24, "0") + ":" +
    createHash("sha256").update(path).digest("hex");
}

function encodeCursor(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
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

  function inside(base: string, real: string): boolean {
    return real === base || real.startsWith(base + "/");
  }

  async function resolve(path: string): Promise<string | null> {
    if (!isStoragePath(path)) return null;
    const base = await realBase();
    if (base === null) return null;
    try {
      const real = await realpath(path === "/" ? base : base + path);
      return inside(base, real) ? real : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function statObject(path: string): Promise<StorageObject | null> {
    const real = await resolve(path);
    if (real === null) return null;
    const stats = await stat(real, { bigint: true });
    if (!stats.isFile() && !stats.isDirectory()) return null;
    return objectOf(path, stats);
  }

  async function children(real: string): Promise<Dirent[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(real, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) =>
        (entry.isFile() || entry.isDirectory()) && reportableName(entry.name)
      )
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  async function readBytes(
    real: string,
    expected: BigIntStats,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> {
    let handle;
    try {
      handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (opened.ino !== expected.ino || opened.dev !== expected.dev) {
        return null;
      }
      const size = Number(opened.size);
      const count = Math.max(0, Math.min(length, size - offset));
      const bytes = new Uint8Array(count);
      let done = 0;
      while (done < count) {
        const { bytesRead } = await handle.read(
          bytes,
          done,
          count - done,
          offset + done,
        );
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return bytes.subarray(0, done);
    } finally {
      await handle.close();
    }
  }

  async function writableParent(path: string): Promise<string | null> {
    const base = await realBase();
    if (base === null) return null;
    let current = base;
    const parent = storageParentPath(path);
    if (parent === "/") return current;
    for (const segment of parent.slice(1).split("/")) {
      const next = current + "/" + segment;
      try {
        await mkdir(next);
      } catch (error) {
        if ((error as { code?: unknown })?.code !== "EEXIST") throw error;
      }
      const real = await realpath(next);
      if (!inside(base, real)) return null;
      const stats = await lstat(real);
      if (!stats.isDirectory()) return null;
      current = real;
    }
    return current;
  }

  async function sameBytes(real: string, bytes: Uint8Array): Promise<boolean> {
    const current = await readFile(real);
    return Buffer.compare(current, Buffer.from(bytes)) === 0;
  }

  return {
    async list(input) {
      const real = await resolve(input.path);
      if (real === null) return { items: [], nextCursor: null };
      const after = input.cursor === null ? null : decodeCursor(input.cursor);
      const all = (await children(real)).filter((entry) =>
        after === null || entry.name > after
      );
      const items: StorageObject[] = [];
      for (const entry of all) {
        if (items.length === input.limit) break;
        const stats = await lstat(real + "/" + entry.name, { bigint: true });
        if (!stats.isFile() && !stats.isDirectory()) continue;
        items.push(objectOf(childPath(input.path, entry.name), stats));
      }
      const more = all.length > items.length;
      return {
        items,
        nextCursor: more && items.length > 0
          ? encodeCursor(items[items.length - 1].name)
          : null,
      };
    },

    stat(input) {
      return statObject(input.path);
    },

    async read(input) {
      if (input.path === "/") return { kind: "missing" };
      const real = await resolve(input.path);
      if (real === null) return { kind: "missing" };
      const stats = await stat(real, { bigint: true });
      if (!stats.isFile()) return { kind: "missing" };
      const object = objectOf(input.path, stats);
      if (input.revision !== null && input.revision !== object.revision) {
        return { kind: "stale", current: object };
      }
      const bytes = await readBytes(
        real,
        stats,
        input.range?.offset ?? 0,
        input.range?.length ?? MAX_STORAGE_READ_BYTES,
      );
      if (bytes === null) return { kind: "missing" };
      return { kind: "bytes", object, bytes };
    },

    async write(input): Promise<StorageWriteResult> {
      if (!isStoragePath(input.path) || input.path === "/") {
        return { kind: "conflict", current: null };
      }
      const parent = await writableParent(input.path);
      if (parent === null) return { kind: "conflict", current: null };
      const target = parent + "/" + nameOf(input.path);
      const current = await statObject(input.path);
      if (current?.kind === "folder") return { kind: "conflict", current };
      const matches = input.ifMatch === null
        ? current === null
        : current?.revision === input.ifMatch;
      if (!matches) {
        if (current !== null && await sameBytes(target, input.bytes)) {
          return { kind: "written", object: current };
        }
        return { kind: "conflict", current };
      }
      const staging = parent + "/" + STAGING_PREFIX + randomUUID();
      const handle = await open(
        staging,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o640,
      );
      try {
        await handle.writeFile(input.bytes);
      } finally {
        await handle.close();
      }
      try {
        if (input.ifMatch === null) {
          try {
            await link(staging, target);
          } catch (error) {
            if ((error as { code?: unknown })?.code !== "EEXIST") throw error;
            return { kind: "conflict", current: await statObject(input.path) };
          }
        } else {
          await rename(staging, target);
        }
      } finally {
        await unlink(staging).catch((error) => {
          if (!isMissing(error)) throw error;
        });
      }
      const written = await statObject(input.path);
      if (written === null) return { kind: "conflict", current: null };
      return { kind: "written", object: written };
    },

    async changes(input) {
      const base = await realBase();
      if (base === null) return { events: [], position: input.since };
      const found: StorageChangeEvent[] = [];
      let highest: string | null = null;
      const folders: Array<{ real: string; path: string }> = [
        { real: base, path: "/" },
      ];
      let visited = 0;
      while (folders.length > 0 && visited < MAX_LOCAL_DISK_WALK) {
        const next = folders.shift()!;
        for (const entry of await children(next.real)) {
          if (visited >= MAX_LOCAL_DISK_WALK) break;
          visited++;
          const real = next.real + "/" + entry.name;
          const path = childPath(next.path, entry.name);
          if (entry.isDirectory()) {
            folders.push({ real, path });
            continue;
          }
          const stats = await lstat(real, { bigint: true });
          if (!stats.isFile()) continue;
          const position = positionOf(path, stats);
          if (highest === null || position > highest) highest = position;
          if (input.since !== null && position <= input.since) continue;
          found.push({
            kind: input.since === null ? "created" : "updated",
            path,
            revision: revisionOf(stats),
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
