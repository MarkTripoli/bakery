import type { FilesApi, StorageItem } from "./api.ts";
import { UsageError } from "./config.ts";

/** What a command names: a path (optionally at one revision), or one saved version by its id. */
export type FileRef =
  | Readonly<{ kind: "path"; path: string; revision: number | null }>
  | Readonly<{ kind: "version"; versionId: string }>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `/a/b` is the top path; empty and `/` are the top of the tree. */
export function normalizePath(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/**
 * `@<version id>` names one saved version; `/path@3` names revision 3 of a
 * file; anything else is a path now. (`@` inside a file name is not
 * supported in a path: the last `@` followed by digits is the revision.)
 */
export function parseRef(argument: string): FileRef {
  if (argument.startsWith("@")) {
    const id = argument.slice(1);
    if (!UUID.test(id)) {
      throw new UsageError(
        `"${argument}" is not a version id (an id looks like @<uuid>).`,
      );
    }
    return { kind: "version", versionId: id.toLowerCase() };
  }
  const match = /^(.*)@([1-9][0-9]{0,8})$/.exec(argument);
  if (match !== null) {
    return {
      kind: "path",
      path: normalizePath(match[1]),
      revision: Number(match[2]),
    };
  }
  return { kind: "path", path: normalizePath(argument), revision: null };
}

/**
 * The entry at a path, found by walking down from the top-level folders. The
 * API reads folders by id, so each level is matched against the entries' own
 * paths: an entry is the target when its path equals it, and a place to go on
 * from when its path is the target's parent (a top-level folder can be more
 * than one segment, such as `/users/<id>`). The top of the tree has no entry:
 * callers handle `/` themselves.
 */
export async function resolveEntry(
  api: FilesApi,
  path: string,
): Promise<StorageItem | null> {
  const target = normalizePath(path).toLowerCase();
  if (target === "/") return null;
  let level = await api.roots();
  for (let depth = 0; depth < 256; depth += 1) {
    // Names are unique in a folder when compared case-insensitively.
    const hit = level.find((item) => {
      const itemPath = normalizePath(item.path).toLowerCase();
      return itemPath === target || target.startsWith(`${itemPath}/`);
    });
    if (hit === undefined) return null;
    if (normalizePath(hit.path).toLowerCase() === target) return hit;
    if (hit.kind !== "folder") return null;
    level = await api.entries(hit.id);
  }
  return null;
}
