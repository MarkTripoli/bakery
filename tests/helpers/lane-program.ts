/**
 * Which `git` a lane should spawn, decided once from the PATH the lane started
 * with (#229).
 *
 * A lane grants `--allow-run=git,/usr/bin/git`, and the bare name in that grant
 * is resolved against the PATH the process started with. A bare `git` spawn is
 * resolved again, against the PATH of the moment it spawns, so a PATH that
 * changes during the run refuses a spawn the grant names: `NotCapable: Requires
 * run access to "git"`. Resolving the program once, at the start, and spawning
 * that absolute path removes the second resolution and with it the failure.
 *
 * When the process was not started by `scripts/run-tests.ts` there is no
 * recorded startup PATH; the current one is the honest stand-in, and if the
 * program cannot be found at all the bare name is returned so the spawn fails
 * the way it always did.
 */
import { basename, isAbsolute } from "node:path";

/** Where a program is found along a PATH string, in order, as absolute paths. */
export function candidatePaths(
  path: string | undefined,
  program: string,
): string[] {
  if (path === undefined || program.includes("/")) return [];
  const found: string[] = [];
  for (const directory of path.split(":")) {
    // An empty segment means the current directory, which is never a stable
    // place for a program a lane is about to run.
    if (directory === "") continue;
    found.push(`${directory.replace(/\/+$/, "")}/${basename(program)}`);
  }
  return found;
}

/**
 * The first candidate on `path` that `exists` accepts, or undefined: the one a
 * spawn with that PATH would have used.
 */
export function resolveProgram(
  path: string | undefined,
  program: string,
  exists: (candidate: string) => boolean,
): string | undefined {
  if (program.includes("/")) return isAbsolute(program) ? program : undefined;
  return candidatePaths(path, program).find(exists);
}

function onDisk(candidate: string): boolean {
  try {
    return Deno.statSync(candidate).isFile;
  } catch {
    return false;
  }
}

/**
 * The absolute path a lane should spawn for `program`.
 *
 * `read` is the environment read, injected so the decision is testable without
 * touching the process's own PATH.
 */
export function startupProgram(
  program: string,
  read: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string {
  const path = read("BAKERY_TEST_STARTUP_PATH") ?? read("PATH");
  return resolveProgram(path, program, onDisk) ?? program;
}
