import { z } from "zod";
import type { DriverContext } from "./ports.ts";

export const MAX_STORAGE_PATH_LENGTH = 1024;
export const MAX_STORAGE_PAGE_SIZE = 100;
export const MAX_STORAGE_READ_BYTES = 8 * 1024 * 1024;
export const MAX_STORAGE_CHANGES_PAGE = 200;

export function isStoragePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_STORAGE_PATH_LENGTH) return false;
  if (!path.startsWith("/")) return false;
  if (path === "/") return true;
  if (path.endsWith("/")) return false;
  for (const segment of path.slice(1).split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
    for (const character of segment) {
      const code = character.codePointAt(0)!;
      if (code <= 0x1f || code === 0x7f) return false;
    }
  }
  return true;
}

export const StoragePathSchema = z.string().max(MAX_STORAGE_PATH_LENGTH)
  .refine(isStoragePath, "not an absolute storage path").describe(
    "Absolute remote path inside the connection, such as /reports/q3.pdf; / is the root, and empty, . and .. segments are refused.",
  );

export const StorageObjectSchema = z.strictObject({
  path: StoragePathSchema,
  name: z.string().min(1).max(255).describe(
    "Last segment of the path, as the provider names it.",
  ),
  kind: z.enum(["file", "folder"]).describe(
    "Whether the path is a file with bytes or a folder that lists children.",
  ),
  sizeBytes: z.number().int().min(0).describe(
    "Size of the file's current bytes; null for a folder.",
  ).nullable().describe("Size of the file's current bytes; null for a folder."),
  mediaType: z.string().min(1).max(200).describe(
    "Media type the provider reports for a file; null for a folder or when unknown.",
  ).nullable().describe(
    "Media type the provider reports for a file; null for a folder or when unknown.",
  ),
  revision: z.string().min(1).max(400).describe(
    "Provider revision or entity tag of the current bytes; changes whenever the bytes change, and keys an ingest. Null for a folder.",
  ).nullable().describe(
    "Provider revision or entity tag of the current bytes; changes whenever the bytes change, and keys an ingest. Null for a folder.",
  ),
  modifiedAt: z.iso.datetime().describe(
    "Moment the provider last changed the entry, when it reports one.",
  ).nullable().describe(
    "Moment the provider last changed the entry, when it reports one.",
  ),
}).describe("One file or folder in outside storage, as the port reports it.");

export const StorageListInputSchema = z.strictObject({
  path: StoragePathSchema,
  cursor: z.string().min(1).max(1000).describe(
    "Opaque cursor from the previous page; null for the first page.",
  ).nullable().describe(
    "Opaque cursor from the previous page; null for the first page.",
  ),
  limit: z.number().int().min(1).max(MAX_STORAGE_PAGE_SIZE).describe(
    "Most entries the page may carry.",
  ),
}).describe("A request for one page of a remote folder's children.");

export const StorageListPageSchema = z.strictObject({
  items: z.array(StorageObjectSchema).max(MAX_STORAGE_PAGE_SIZE).describe(
    "Children of the folder in the provider's stable order.",
  ),
  nextCursor: z.string().min(1).max(1000).describe(
    "Cursor for the next page, or null when the folder is exhausted.",
  ).nullable().describe(
    "Cursor for the next page, or null when the folder is exhausted.",
  ),
}).describe("One page of a remote folder's children, keyset paged by cursor.");

export const StorageReadRangeSchema = z.strictObject({
  offset: z.number().int().min(0).describe(
    "First byte to return, counted from zero.",
  ),
  length: z.number().int().min(1).max(MAX_STORAGE_READ_BYTES).describe(
    "Most bytes to return; fewer come back at the end of the file.",
  ),
}).describe("A byte range of one file to read.");

export const StorageReadInputSchema = z.strictObject({
  path: StoragePathSchema,
  range: StorageReadRangeSchema.describe(
    "Byte range to read, or null for the whole file up to the read limit.",
  ).nullable().describe(
    "Byte range to read, or null for the whole file up to the read limit.",
  ),
  revision: z.string().min(1).max(400).describe(
    "Revision the caller expects; a read of a file that has moved on answers stale rather than other bytes.",
  ).nullable().describe(
    "Revision the caller expects; a read of a file that has moved on answers stale rather than other bytes.",
  ),
}).describe("A request to read a file's bytes through the port.");

export const StorageWriteInputSchema = z.strictObject({
  path: StoragePathSchema,
  mediaType: z.string().min(1).max(200).describe(
    "Media type to store the bytes under.",
  ),
  ifMatch: z.string().min(1).max(400).describe(
    "Revision the write replaces; null creates the file only when it is absent.",
  ).nullable().describe(
    "Revision the write replaces; null creates the file only when it is absent.",
  ),
  idempotencyKey: z.string().min(1).max(200).describe(
    "Key a provider uses to make a repeated write land once; the effect's own key.",
  ),
}).describe(
  "Metadata of one write to outside storage; the bytes travel beside it.",
);

export const StorageWriteResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("written").describe("The bytes are stored."),
    object: StorageObjectSchema,
  }).describe("A write that landed."),
  z.strictObject({
    kind: z.literal("conflict").describe(
      "The file's current revision is not the one the write named.",
    ),
    current: StorageObjectSchema.describe(
      "The entry as it is now, or null when it does not exist.",
    ).nullable().describe(
      "The entry as it is now, or null when it does not exist.",
    ),
  }).describe("A write refused because the file moved on."),
]).describe("How one write to outside storage ended.");

export const StorageChangeEventSchema = z.strictObject({
  kind: z.enum(["created", "updated", "deleted"]).describe(
    "What happened to the path.",
  ),
  path: StoragePathSchema,
  revision: z.string().min(1).max(400).describe(
    "Revision after the change; null for a deletion.",
  ).nullable().describe("Revision after the change; null for a deletion."),
  position: z.string().min(1).max(400).describe(
    "Opaque, increasing position of this event in the connection's change feed.",
  ),
}).describe("One change in outside storage, from the provider's change feed.");

export const StorageChangesInputSchema = z.strictObject({
  since: z.string().min(1).max(400).describe(
    "Position of the last event already seen, or null from the start of the feed.",
  ).nullable().describe(
    "Position of the last event already seen, or null from the start of the feed.",
  ),
  limit: z.number().int().min(1).max(MAX_STORAGE_CHANGES_PAGE).describe(
    "Most events the page may carry.",
  ),
}).describe("A request for the next page of change events.");

export const StorageChangesPageSchema = z.strictObject({
  events: z.array(StorageChangeEventSchema).max(MAX_STORAGE_CHANGES_PAGE)
    .describe("Changes after the given position, oldest first."),
  position: z.string().min(1).max(400).describe(
    "Position to continue from; null when the feed holds no events yet.",
  ).nullable().describe(
    "Position to continue from; null when the feed holds no events yet.",
  ),
}).describe("One page of a connection's change feed.");

export type StorageObject = z.infer<typeof StorageObjectSchema>;
export type StorageListInput = z.infer<typeof StorageListInputSchema>;
export type StorageListPage = z.infer<typeof StorageListPageSchema>;
export type StorageReadRange = z.infer<typeof StorageReadRangeSchema>;
export type StorageReadInput = z.infer<typeof StorageReadInputSchema>;
export type StorageWriteInput = z.infer<typeof StorageWriteInputSchema>;
export type StorageWriteResult = z.infer<typeof StorageWriteResultSchema>;
export type StorageChangeEvent = z.infer<typeof StorageChangeEventSchema>;
export type StorageChangesInput = z.infer<typeof StorageChangesInputSchema>;
export type StorageChangesPage = z.infer<typeof StorageChangesPageSchema>;

export type StorageReadResult =
  | { kind: "bytes"; object: StorageObject; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "stale"; current: StorageObject };

export type StoragePort = {
  list(input: StorageListInput & { ctx: DriverContext }): Promise<
    StorageListPage
  >;
  stat(input: { path: string; ctx: DriverContext }): Promise<
    StorageObject | null
  >;
  read(input: StorageReadInput & { ctx: DriverContext }): Promise<
    StorageReadResult
  >;
  write(
    input: StorageWriteInput & { bytes: Uint8Array; ctx: DriverContext },
  ): Promise<StorageWriteResult>;
  changes(input: StorageChangesInput & { ctx: DriverContext }): Promise<
    StorageChangesPage
  >;
};

export function storageParentPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}
