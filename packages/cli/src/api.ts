import {
  ApiProblemError,
  ApiTransportError,
  type BinaryArtifactClientResponse,
  type ClientOutputMap,
  createBakeryClient,
} from "@bakery/contracts/client";
import type { CliConfig } from "./config.ts";

export type StorageItem =
  ClientOutputMap["Page<StorageFolderItem>"]["items"][number];
export type StorageVersion =
  ClientOutputMap["Page<StorageFileVersion>"]["items"][number];
export type StorageUse =
  ClientOutputMap["Page<StorageFileUse>"]["items"][number];
export type StorageFileAtVersion = ClientOutputMap["StorageFileAtVersion"];
export type PinResult = ClientOutputMap["ArtifactPinResult"];
export type SearchHit = ClientOutputMap["Page<FileSearchHit>"]["items"][number];

export type SearchFilter = Readonly<{
  query?: string;
  path?: string;
  kind?: string;
  mediaType?: string;
}>;

/** The reads the files commands need; every list is read to its last page. */
export type FilesApi = Readonly<{
  roots: () => Promise<StorageItem[]>;
  entries: (folderId: string) => Promise<StorageItem[]>;
  versions: (fileId: string) => Promise<StorageVersion[]>;
  uses: (fileId: string) => Promise<StorageUse[]>;
  byVersion: (versionId: string) => Promise<StorageFileAtVersion>;
  content: (
    fileId: string,
    options: Readonly<{ revision?: number; range?: string }>,
  ) => Promise<BinaryArtifactClientResponse>;
  search: (filter: SearchFilter) => Promise<SearchHit[]>;
  /** Sets or clears a record file's administrator pin. */
  pin: (fileId: string, pinned: boolean) => Promise<PinResult>;
}>;

/** A guard against a cursor that never ends, not a limit anyone reaches. */
const PAGE_GUARD = 1_000;
const PAGE_SIZE = 100;

async function allPages<T>(
  read: (
    cursor: string | undefined,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PAGE_GUARD; page += 1) {
    const result = await read(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    cursor = result.nextCursor;
  }
  return items;
}

/** The files API over the generated client, signed in with the access token. */
export function createFilesApi(
  config: CliConfig,
  fetchImplementation: typeof fetch = globalThis.fetch,
): FilesApi {
  const client = createBakeryClient({
    baseUrl: config.baseUrl,
    getContext: () => ({ organizationId: config.organizationId }),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${config.token}`);
      // A token is a bearer value: no cookies, so the request never depends on a browser session.
      return fetchImplementation(input, {
        ...init,
        headers,
        credentials: "omit",
      });
    },
  });
  const actions = client.actions;
  return {
    roots: () => allPages(async () => await actions["storageRoots.list"]({})),
    entries: (folderId) =>
      allPages((cursor) =>
        actions["storageFolderEntries.list"]({
          id: folderId,
          cursor,
          limit: PAGE_SIZE,
        })
      ),
    versions: (fileId) =>
      allPages((cursor) =>
        actions["storageFileVersions.list"]({
          id: fileId,
          cursor,
          limit: PAGE_SIZE,
        })
      ),
    uses: (fileId) =>
      allPages((cursor) =>
        actions["storageFileUses.list"]({
          id: fileId,
          cursor,
          limit: PAGE_SIZE,
        })
      ),
    byVersion: (versionId) =>
      actions["storageFiles.byVersion"]({ id: versionId }),
    content: (fileId, options) =>
      actions["storageFiles.content"]({
        id: fileId,
        ...(options.revision === undefined
          ? {}
          : { revision: options.revision }),
        ...(options.range === undefined ? {} : { range: options.range }),
      }),
    search: (filter) =>
      allPages((cursor) =>
        actions["files.search"]({ ...filter, cursor, limit: PAGE_SIZE })
      ),
    pin: (fileId, pinned) =>
      actions["storageFiles.pin"]({ id: fileId, pinned }),
  };
}

/** What went wrong, in words a person can act on; never includes the token. */
export function describeFailure(error: unknown): string | null {
  if (error instanceof ApiProblemError) {
    const { status, code } = error.problem;
    switch (status) {
      case 401:
        return "Not signed in: the access token is missing, expired or revoked. Make a new one in Settings.";
      case 403:
        return "You do not have access to that.";
      case 404:
        return "Not found. It may have been removed, or you may not have access to it.";
      case 410:
        return "That file's contents were removed by retention or an administrator; its history still lists.";
      case 416:
        return "That byte range is outside the file.";
      case 422:
        return "That file cannot be pinned: only a file kept as a record has a pin, not a working-area file.";
      case 429:
        return "Too many requests; wait a moment and try again.";
      default:
        return `The server refused the request (${status} ${code}).`;
    }
  }
  if (error instanceof ApiTransportError) {
    return error.kind === "network"
      ? "Cannot reach the server. Check BAKERY_URL and your connection."
      : `The server's answer could not be read (${error.kind}).`;
  }
  return null;
}
