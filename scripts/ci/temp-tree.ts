import { join } from "node:path";

/**
 * Removes a temp tree even when a test left a directory it made unreadable or
 * unwritable (the readiness tests lock one on purpose, and `rm -rf` and a plain
 * recursive `Deno.remove` both stop at it). Every directory below `path` is made
 * accessible before it is listed, then the tree is removed. A path that is
 * already gone is not an error. Synchronous, so it can run in an `unload`
 * handler.
 */
export function removeTreeSync(path: string): void {
  const open = (directory: string) => {
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

/** The names directly inside `path`, or none when it does not exist. */
export function entriesOf(path: string): string[] {
  try {
    return [...Deno.readDirSync(path)].map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
