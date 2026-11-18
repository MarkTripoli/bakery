import { join } from "node:path";

/**
 * What `path` is, without following a link: a real directory, a symlink (even
 * to a directory), anything else, or nothing at all.
 */
export function kindOf(
  path: string,
): "directory" | "symlink" | "other" | "missing" {
  try {
    const info = Deno.lstatSync(path);
    if (info.isSymlink) return "symlink";
    return info.isDirectory ? "directory" : "other";
  } catch {
    return "missing";
  }
}

/**
 * Whether `path` is a real directory. A symlink is not one, even to a
 * directory: `chmod` and a listing follow a link, so acting on the path would
 * reach whatever it points at, outside the tree being cleaned.
 */
function isRealDirectory(path: string): boolean {
  try {
    const info = Deno.lstatSync(path);
    return info.isDirectory && !info.isSymlink;
  } catch {
    return false;
  }
}

/**
 * Removes a temp tree even when a test left a directory it made unreadable or
 * unwritable (the readiness tests lock one on purpose, and `rm -rf` and a plain
 * recursive `Deno.remove` both stop at it). Every directory below `path` is made
 * accessible before it is listed, then the tree is removed. A path that is
 * already gone is not an error. A symlink, at the top or below, is removed as
 * the link it is and never followed: nothing it points at is changed or
 * listed. Synchronous, so it can run in an `unload` handler.
 *
 * Accepted, not closed (#268): between the `lstat` that proves a directory real
 * and the `chmod` that opens it, something running as the same user could
 * swap it for a link (a deliberate flipper hit it in 0.016% of calls). Closing
 * it takes an opened handle (`fchmod` on a directory opened with
 * `O_NOFOLLOW`) and then listing through that handle, which Deno does not
 * offer; a half-closed window would read as safe and not be. The process that
 * can swap a path under a lane root already holds the write access this
 * function uses, so no privilege boundary rests on it.
 */
export function removeTreeSync(path: string): void {
  const open = (directory: string) => {
    if (!isRealDirectory(directory)) return;
    try {
      Deno.chmodSync(directory, 0o700);
    } catch {
      // Gone, or not ours: the removal below reports what matters.
    }
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(directory)];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory && !entry.isSymlink) {
        open(join(directory, entry.name));
      }
    }
  };
  open(path);
  try {
    Deno.removeSync(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * The names directly inside `path`, or none when it does not exist or is not a
 * real directory: nothing is inside a symlink, only inside what it points at.
 */
export function entriesOf(path: string): string[] {
  if (!isRealDirectory(path)) return [];
  try {
    return [...Deno.readDirSync(path)].map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
