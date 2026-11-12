/**
 * What a test process prints when a spawn fails with
 * `NotCapable: Requires run access to "git"` (#229).
 *
 * Seen twice on the rig host with no cause found, and every rerun passed. The
 * mechanism, reproduced with a throwaway script on Deno 2.9.1: the lane's
 * `--allow-run=git,/usr/bin/git` is resolved against the PATH the process
 * started with, and a bare `git` is resolved against the PATH of the moment it
 * is spawned. If the two give different paths the spawn is refused, although
 * the grant names git. A PATH that merely lists `/bin` before `/usr/bin` is
 * fine; a PATH that CHANGES after the process started is not. What has not been
 * found is what changes it on the rig host, so a failed spawn now says what it
 * saw: the PATH the lane started with, the PATH now, where the program
 * resolves in each, the lane's grant, and what the runtime says it may run.
 * Nothing here changes what a test can observe except that stderr gains this
 * text, on a failure that was going to throw anyway.
 */

export type SpawnCandidate = {
  /** Where the program was found: a directory of the PATH joined to its name. */
  readonly path: string;
  /** Where that path really points, when it can be resolved. */
  readonly realPath: string | undefined;
};

/** Plain data, so the report is a pure function of it. */
export type SpawnFacts = {
  readonly message: string;
  /** From `Requires run access to "<program>"`; undefined when the message has no such name. */
  readonly program: string | undefined;
  readonly startupPath: string | undefined;
  readonly currentPath: string | undefined;
  readonly allowRun: string | undefined;
  readonly gitExecutable: string | undefined;
  readonly candidatesAtStart: readonly SpawnCandidate[];
  readonly candidatesNow: readonly SpawnCandidate[];
  readonly permissions: readonly { command: string; state: string }[];
  readonly processInfo: { pid: number; cwd: string; deno: string };
};

const MAX_VALUE = 400;
const MAX_CANDIDATES = 8;
const MAX_PERMISSIONS = 12;

/** One bounded line of text: no line breaks, no control characters, cut at MAX_VALUE. */
function line(value: string | undefined): string {
  if (value === undefined) return "(not set)";
  const flat = Array.from(
    value,
    (character) => {
      const code = character.codePointAt(0) ?? 0;
      // C0 and C1 controls, DEL, and the two Unicode line separators.
      return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 ||
          code === 0x2029
        ? "?"
        : character;
    },
  ).join("");
  return flat.length > MAX_VALUE
    ? `${flat.slice(0, MAX_VALUE)}... (${flat.length - MAX_VALUE} more)`
    : flat;
}

function describeCandidates(candidates: readonly SpawnCandidate[]): string {
  if (candidates.length === 0) return "(none on that PATH)";
  const shown = candidates.slice(0, MAX_CANDIDATES).map((candidate, index) =>
    `[${index + 1}] ${line(candidate.path)}${
      candidate.realPath !== undefined && candidate.realPath !== candidate.path
        ? ` -> ${line(candidate.realPath)}`
        : ""
    }`
  );
  const more = candidates.length - shown.length;
  return shown.join("  ") + (more > 0 ? `  (+${more} more)` : "");
}

/** The first place the program resolves, which is the one a spawn uses. */
const first = (candidates: readonly SpawnCandidate[]) =>
  candidates[0]?.path ?? "(not found)";

/** Whether the PATH changed since the lane started, said without guessing. */
function changed(facts: SpawnFacts): string {
  if (facts.startupPath === undefined) {
    return "unknown (BAKERY_TEST_STARTUP_PATH is not set: this process was not started by scripts/run-tests.ts)";
  }
  if (facts.startupPath === facts.currentPath) return "no";
  return "YES: the grant was resolved against the startup PATH, so a program that now resolves elsewhere is refused";
}

/** The report for one failed spawn. Bounded: a handful of lines, each cut. */
export function describeSpawnCapability(facts: SpawnFacts): string {
  const program = facts.program ?? "(not named in the message)";
  const lines = [
    `[bakery-test] spawn refused (#229): ${line(facts.message)}`,
    `  program:                 ${line(program)}`,
    `  lane --allow-run:        ${
      line(
        facts.allowRun ??
          "unknown (BAKERY_TEST_ALLOW_RUN is not set: not started by scripts/run-tests.ts)",
      )
    }`,
    `  PATH at lane start:      ${line(facts.startupPath)}`,
    `  PATH now:                ${line(facts.currentPath)}`,
    `  PATH changed since start: ${changed(facts)}`,
    `  "${line(program)}" at start:  ${
      describeCandidates(facts.candidatesAtStart)
    }`,
    `  "${line(program)}" now:       ${
      describeCandidates(facts.candidatesNow)
    }`,
    `  resolves to the same path: ${
      first(facts.candidatesAtStart) === first(facts.candidatesNow)
        ? "yes"
        : `NO (start ${line(first(facts.candidatesAtStart))}, now ${
          line(first(facts.candidatesNow))
        })`
    }`,
    `  runtime permission(run): ${
      facts.permissions.slice(0, MAX_PERMISSIONS).map((permission) =>
        `${line(permission.command)}=${line(permission.state)}`
      ).join("  ") || "(none queried)"
    }`,
    `  GIT_EXECUTABLE:          ${line(facts.gitExecutable)}`,
    `  process:                 pid ${facts.processInfo.pid}, deno ${
      line(facts.processInfo.deno)
    }, cwd ${line(facts.processInfo.cwd)}`,
  ];
  return lines.join("\n");
}

/** The program a `Requires run access to "<program>"` message names. */
export function programOf(message: string): string | undefined {
  return /Requires run access to "([^"\n]{1,200})"/.exec(message)?.[1];
}

/** Where `program` is found along a PATH string, in order. */
export function candidatesAlong(
  path: string | undefined,
  program: string | undefined,
): SpawnCandidate[] {
  if (path === undefined || program === undefined || program.includes("/")) {
    return [];
  }
  const found: SpawnCandidate[] = [];
  for (const directory of path.split(":")) {
    if (directory === "" || found.length >= MAX_CANDIDATES + 1) continue;
    const candidate = `${directory.replace(/\/+$/, "")}/${program}`;
    try {
      const info = Deno.statSync(candidate);
      if (!info.isFile) continue;
    } catch {
      continue;
    }
    let realPath: string | undefined;
    try {
      realPath = Deno.realPathSync(candidate);
    } catch {
      realPath = undefined;
    }
    found.push({ path: candidate, realPath });
  }
  return found;
}

export type SpawnEnvironment = {
  readonly startupPath: string | undefined;
  readonly currentPath: string | undefined;
  readonly allowRun: string | undefined;
  readonly gitExecutable: string | undefined;
};

/** Reads the environment this diagnostic is about; every read is allowed to fail. */
export function readSpawnEnvironment(): SpawnEnvironment {
  const read = (name: string) => {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  };
  return {
    startupPath: read("BAKERY_TEST_STARTUP_PATH"),
    currentPath: read("PATH"),
    allowRun: read("BAKERY_TEST_ALLOW_RUN"),
    gitExecutable: read("GIT_EXECUTABLE"),
  };
}

/** What the runtime says about running these commands, never prompting. */
function queryPermissions(
  commands: readonly string[],
): { command: string; state: string }[] {
  return commands.map((command) => {
    try {
      return {
        command,
        state: Deno.permissions.querySync({ name: "run", command }).state,
      };
    } catch (error) {
      return {
        command,
        state: `unreadable (${(error as Error).name})`,
      };
    }
  });
}

/** The facts for one failed spawn, from the real process. */
export function gatherSpawnFacts(
  error: Error,
  environment: SpawnEnvironment = readSpawnEnvironment(),
): SpawnFacts {
  const program = programOf(error.message);
  const candidatesNow = candidatesAlong(environment.currentPath, program);
  const candidatesAtStart = candidatesAlong(environment.startupPath, program);
  const commands = new Set<string>();
  if (program !== undefined) commands.add(program);
  commands.add("/usr/bin/git");
  commands.add("/bin/git");
  for (const candidate of [...candidatesAtStart, ...candidatesNow]) {
    commands.add(candidate.path);
  }
  let cwd = "(unreadable)";
  try {
    cwd = Deno.cwd();
  } catch {
    // Left as unreadable.
  }
  return {
    message: error.message.split("\n")[0] ?? error.message,
    program,
    ...environment,
    candidatesAtStart,
    candidatesNow,
    permissions: queryPermissions([...commands].slice(0, MAX_PERMISSIONS)),
    processInfo: { pid: Deno.pid, cwd, deno: Deno.version.deno },
  };
}

/** How many full reports one process prints before it only counts. */
export const FULL_REPORTS_PER_PROCESS = 2;

export type SpawnFailureReporter = (error: unknown) => void;

/**
 * Whether a path is on disk, a symlink (even a dangling one) included. When it
 * cannot be told, say a permission refusal, it counts as on disk: a report that
 * should not have been printed costs a line, one that was hidden could cost the
 * incident.
 */
function pathOnDisk(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (error) {
    return !(error instanceof Deno.errors.NotFound);
  }
}

/**
 * Reports a run-access refusal, once per error and in full for the first few:
 * a failing file can refuse dozens of spawns and the first reports say it all.
 * Anything else, including a refused env or read permission, is ignored. It
 * never throws into the spawn it describes.
 */
export function createSpawnFailureReporter(
  write: (text: string) => void,
  gather: (error: Error) => SpawnFacts = gatherSpawnFacts,
  exists: (path: string) => boolean = pathOnDisk,
): SpawnFailureReporter {
  const seen = new WeakSet<object>();
  let full = 0;
  let suppressed = 0;
  return (error: unknown) => {
    try {
      if (!(error instanceof Deno.errors.NotCapable)) return;
      if (!/Requires run access/.test(error.message)) return;
      // An absolute path never depends on the PATH, and one that is not on disk
      // cannot be a path-resolution problem. Tests refuse such paths on purpose
      // (`/nonexistent/kill`), and a healthy run must not print what an
      // incident prints.
      const program = programOf(error.message);
      if (program !== undefined && program.includes("/") && !exists(program)) {
        return;
      }
      if (seen.has(error)) return;
      seen.add(error);
      if (full < FULL_REPORTS_PER_PROCESS) {
        full += 1;
        write(describeSpawnCapability(gather(error)));
        return;
      }
      suppressed += 1;
      write(
        `[bakery-test] spawn refused again (#229): ${
          line(error.message.split("\n")[0])
        } (${suppressed} not reported in full; see the first report above)`,
      );
    } catch {
      // A diagnostic never replaces the error it is about.
    }
  };
}
