import { createHash } from "node:crypto";
import type {
  FilesApi,
  SearchFilter,
  StorageItem,
  StorageVersion,
} from "./api.ts";
import { UsageError } from "./config.ts";
import {
  type FileRef,
  normalizePath,
  parseRef,
  resolveEntry,
} from "./paths.ts";

/** Where a command writes: text for people, bytes for `cat`, files for `get`. */
export type Output = Readonly<{
  text: (line: string) => void;
  bytes: (content: Uint8Array) => void;
  /** Writes a file; `overwrite: false` refuses to replace one that exists. */
  file: (
    path: string,
    content: Uint8Array,
    overwrite: boolean,
  ) => Promise<void>;
}>;

/** A command's failure with a message to print, as opposed to a bug. */
export class CommandError extends Error {
  override readonly name = "CommandError";
}

export type FileOptions = Readonly<{
  json: boolean;
  long: boolean;
  range?: string;
  output?: string;
  force: boolean;
  search: SearchFilter;
}>;

const KIB = 1024;

/** A size the way `ls -h` prints it. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < KIB) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / KIB;
  let unit = 0;
  while (value >= KIB && unit < units.length - 1) {
    value /= KIB;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function printJson(out: Output, value: unknown): void {
  out.text(JSON.stringify(value, null, 2));
}

function row(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((cell, at) => cell.padEnd(widths[at] ?? 0)).join("  ")
    .trimEnd();
}

function table(out: Output, rows: readonly (readonly string[])[]): void {
  const widths =
    rows[0]?.map((_, at) => Math.max(...rows.map((r) => r[at].length))) ?? [];
  for (const cells of rows) out.text(row(cells, widths));
}

/** The name `ls` prints: the path below the folder listed, so a top-level folder of two segments reads whole. */
function itemLabel(item: StorageItem, parent: string): string {
  const own = normalizePath(item.path);
  const below = parent === "/"
    ? own.slice(1)
    : own.toLowerCase().startsWith(`${parent.toLowerCase()}/`)
    ? own.slice(parent.length + 1)
    : (own.split("/").pop() ?? item.name);
  return item.kind === "folder" ? `${below}/` : below;
}

function describeItem(item: StorageItem, parent: string): string[] {
  return [
    item.kind === "folder" ? "folder" : "file",
    formatSize(item.sizeBytes),
    item.updatedAt.slice(0, 19).replace("T", " "),
    itemLabel(item, parent),
  ];
}

/** `ls [path]`: the entries of a folder, the top-level folders at `/`, or one file. */
export async function ls(
  api: FilesApi,
  argument: string | undefined,
  options: FileOptions,
  out: Output,
): Promise<void> {
  const path = normalizePath(argument ?? "/");
  let items: StorageItem[];
  if (path === "/") {
    items = await api.roots();
  } else {
    const entry = await resolveEntry(api, path);
    if (entry === null) {
      throw new CommandError(`No such file or folder: ${path}`);
    }
    items = entry.kind === "folder" ? await api.entries(entry.id) : [entry];
  }
  if (options.json) return printJson(out, items);
  if (options.long) {
    return table(out, items.map((item) => describeItem(item, path)));
  }
  for (const item of items) out.text(itemLabel(item, path));
}

async function entryFor(api: FilesApi, ref: FileRef): Promise<{
  item: StorageItem;
  revision: number | null;
  versionId: string | null;
  isCurrent: boolean | null;
}> {
  if (ref.kind === "version") {
    const found = await api.byVersion(ref.versionId);
    return {
      item: found.file,
      revision: found.revision,
      versionId: found.versionId,
      isCurrent: found.isCurrent,
    };
  }
  const item = await resolveEntry(api, ref.path);
  if (item === null) {
    throw new CommandError(`No such file or folder: ${ref.path}`);
  }
  return { item, revision: ref.revision, versionId: null, isCurrent: null };
}

function fileFor(found: Awaited<ReturnType<typeof entryFor>>): StorageItem {
  if (found.item.kind !== "file") {
    throw new CommandError(`${found.item.path} is a folder, not a file.`);
  }
  return found.item;
}

/** `stat <path|path@n|@version-id>`: what an entry is. */
export async function stat(
  api: FilesApi,
  argument: string,
  options: FileOptions,
  out: Output,
): Promise<void> {
  const found = await entryFor(api, parseRef(argument));
  const { item } = found;
  if (options.json) {
    return printJson(out, {
      ...item,
      ...(found.versionId === null ? {} : {
        versionId: found.versionId,
        revision: found.revision,
        isCurrent: found.isCurrent,
      }),
    });
  }
  const lines: [string, string][] = [
    ["Path", item.path],
    ["Kind", item.kind],
    ["Id", item.id],
    ["Folder rule", item.policy],
  ];
  if (item.kind === "file") {
    lines.push(
      ["Type", item.mediaType ?? "-"],
      ["Size", formatSize(item.sizeBytes)],
    );
    lines.push(["Pinned", item.pinned ? "yes" : "no"]);
    if (item.contentRemoved) {
      lines.push(["Contents", "removed (the history still lists)"]);
    }
  }
  lines.push(["Changed", item.updatedAt]);
  if (found.versionId !== null) {
    lines.push(
      ["Version", found.versionId],
      [
        "Revision",
        `${found.revision} (${found.isCurrent ? "current" : "older"})`,
      ],
    );
  }
  const width = Math.max(...lines.map(([label]) => label.length));
  for (const [label, value] of lines) {
    out.text(`${label.padEnd(width)}  ${value}`);
  }
}

/** `history <path>`: every saved version of a file, newest first. */
export async function history(
  api: FilesApi,
  argument: string,
  options: FileOptions,
  out: Output,
): Promise<void> {
  const file = fileFor(await entryFor(api, parseRef(argument)));
  const versions = [...await api.versions(file.id)].sort((a, b) =>
    b.revision - a.revision
  );
  if (options.json) return printJson(out, versions);
  if (versions.length === 0) return out.text("No versions.");
  table(out, [
    ["REV", "SAVED", "SIZE", "BY", "SHA-256", ""],
    ...versions.map((version: StorageVersion) => [
      String(version.revision),
      version.createdAt.slice(0, 19).replace("T", " "),
      formatSize(version.sizeBytes),
      madeBy(version),
      version.sha256 === null ? "-" : version.sha256.slice(0, 12),
      [
        version.isCurrent ? "current" : "",
        version.contentRemoved ? "removed" : "",
      ]
        .filter((word) => word !== "").join(" "),
    ]),
  ]);
}

/** Who a version is by: an agent's version names the agent and the person. */
export function madeBy(version: StorageVersion): string {
  if (version.makerKind !== "agent") {
    return version.makerName ?? version.makerKind;
  }
  const agent = version.agentName ? `agent ${version.agentName}` : "an agent";
  return `${agent} for ${version.makerName ?? "unknown"}`;
}

/** `uses <path>`: the runs that pinned a version of this file as an input. */
export async function uses(
  api: FilesApi,
  argument: string,
  options: FileOptions,
  out: Output,
): Promise<void> {
  const file = fileFor(await entryFor(api, parseRef(argument)));
  const used = await api.uses(file.id);
  if (options.json) return printJson(out, used);
  if (used.length === 0) return out.text("Nothing has used this file yet.");
  table(out, [
    ["REV", "USED", "WORK ITEM", "INPUT"],
    ...used.map((use) => [
      String(use.revision),
      use.usedAt.slice(0, 19).replace("T", " "),
      use.workItemTitle,
      use.inputName ?? "-",
    ]),
  ]);
}

/** `open <version-id>`: the path and revision a saved version belongs to. */
export async function open(
  api: FilesApi,
  argument: string,
  options: FileOptions,
  out: Output,
): Promise<void> {
  const ref = parseRef(argument.startsWith("@") ? argument : `@${argument}`);
  if (ref.kind !== "version") throw new UsageError("open takes a version id.");
  const found = await api.byVersion(ref.versionId);
  if (options.json) return printJson(out, found);
  out.text(
    `${found.file.path}@${found.revision}${
      found.isCurrent ? " (current)" : ""
    }`,
  );
}

/** `search <text>`: files whose name contains the text. */
export async function search(
  api: FilesApi,
  options: FileOptions,
  out: Output,
): Promise<void> {
  const hits = await api.search(options.search);
  if (options.json) return printJson(out, hits);
  if (hits.length === 0) return out.text("No matches.");
  table(
    out,
    hits.map((hit) => [
      hit.path,
      hit.kind,
      hit.sizeBytes === null ? "-" : formatSize(hit.sizeBytes),
    ]),
  );
}

async function read(
  api: FilesApi,
  argument: string,
  options: FileOptions,
) {
  const ref = parseRef(argument);
  const found = await entryFor(api, ref);
  const file = fileFor(found);
  const response = await api.content(file.id, {
    revision: found.revision ?? undefined,
    range: options.range,
  });
  if (response.status === 416) {
    throw new CommandError(
      `That byte range is outside the file (it has ${
        response.contentRange.split("/")[1]
      } bytes).`,
    );
  }
  return { file, response };
}

/** `cat <path|path@n|@version-id>`: the bytes of a file on standard output. */
export async function cat(
  api: FilesApi,
  argument: string,
  options: FileOptions,
  out: Output,
): Promise<void> {
  const { response } = await read(api, argument, options);
  out.bytes(response.content);
}

/** `get <ref> [-o path]`: saves a file, after checking its bytes against the server's digest. */
export async function get(
  api: FilesApi,
  argument: string,
  options: FileOptions,
  out: Output,
): Promise<void> {
  const { file, response } = await read(api, argument, options);
  if (response.status === 200) {
    const digest = createHash("sha256").update(response.content).digest("hex");
    if (digest !== response.contentDigest) {
      throw new CommandError(
        "The downloaded bytes do not match the server's digest; nothing was saved.",
      );
    }
  }
  const target = options.output ?? file.name;
  await out.file(target, response.content, options.force).catch(
    (error: unknown) => {
      if (
        error instanceof Error && "code" in error && error.code === "EEXIST"
      ) {
        throw new CommandError(
          `${target} already exists; use --force to replace it.`,
        );
      }
      throw error;
    },
  );
  out.text(`Saved ${target} (${formatSize(response.content.byteLength)})`);
}

/**
 * `pin <path>` and `unpin <path>`: set or clear an administrator pin, which
 * stops retention from collecting the file's versions. Needs a token with the
 * artifact:manage permission; a working-area file has no pin and is refused
 * here before the server is asked.
 */
export async function setPin(
  api: FilesApi,
  argument: string,
  pinned: boolean,
  options: FileOptions,
  out: Output,
): Promise<void> {
  const ref = parseRef(argument);
  if (ref.kind === "version" || ref.revision !== null) {
    throw new CommandError(
      "A pin is on the file, not on one revision: give a path without @.",
    );
  }
  const file = fileFor(await entryFor(api, ref));
  if (file.artifactId === null) {
    throw new CommandError(
      `${file.path} is a working-area file; only a file kept as a record can be pinned.`,
    );
  }
  const result = await api.pin(file.id, pinned);
  if (options.json) return printJson(out, { path: file.path, ...result });
  out.text(
    `${result.pinned ? "Pinned" : "Unpinned"} ${file.path}${
      !result.pinned && result.unpinEligible
        ? " (an expired version may now be collected)"
        : ""
    }`,
  );
}
