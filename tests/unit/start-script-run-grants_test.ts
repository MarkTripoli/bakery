// Rail: no server start path may grant `--allow-run` to something that can
// execute an arbitrary command. Deno's run grant is checked against the
// spawned path only, so granting a general exec wrapper (prlimit, systemd-run,
// git with `-c alias.x=!sh`, `deno eval`, a shell) is the same as granting
// every executable on the host. Each such need goes through a fixed-argv
// launcher instead (infra/draft-worker/launch.sh, infra/server-exec/*.sh).
import { assert, assertEquals } from "@std/assert";

const root = new URL("../../", import.meta.url);

/**
 * The start paths of server-side processes (API server, dispatcher, the
 * deploy-time isolation probes). The worker app is out of scope: it runs
 * harness processes by design under its own cgroup broker, and its grants are
 * computed by apps/worker/scripts/worker-permissions.ts.
 */
export const SERVER_START_SCRIPTS = [
  "apps/server/scripts/run-main.sh",
  "infra/compose.yaml",
  "infra/railway/server-entrypoint.sh",
  "infra/railway/local-proof/prove.sh",
  "scripts/deploy/runtime.sh",
] as const;

/** Basenames that can run an arbitrary command when spawned with chosen args. */
export const GENERAL_EXEC_WRAPPERS = [
  "prlimit",
  "systemd-run",
  "systemctl",
  "journalctl",
  "env",
  "sh",
  "bash",
  "dash",
  "zsh",
  "deno",
  "node",
  "git",
  "python",
  "python3",
  "perl",
  "runuser",
  "sudo",
  "nice",
  "timeout",
  "xargs",
  "flock",
  "setsid",
  "tini",
] as const;

/** Grants whose value is computed at run time, each owned by the worker app. */
const DYNAMIC_WORKER_GRANTS = ["${grants[3]}"];

export function runGrants(
  text: string,
): { scoped: string[]; unscoped: number } {
  const scoped: string[] = [];
  let unscoped = 0;
  for (const match of text.matchAll(/--allow-run(=([^\s"'\\]+))?/g)) {
    if (match[2] === undefined) {
      unscoped += 1;
      continue;
    }
    if (DYNAMIC_WORKER_GRANTS.includes(match[2])) continue;
    // A grant held in a shell variable is checked through its assignment:
    // `run_grant="a,b"` then `"--allow-run=$run_grant"`.
    const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(match[2]);
    if (variable) {
      const assigned = new RegExp(`^\\s*${variable[1]}="([^"]*)"`, "m")
        .exec(text)?.[1];
      if (assigned === undefined) {
        scoped.push(`unresolved:${match[2]}`);
        continue;
      }
      scoped.push(...assigned.split(",").filter(Boolean));
      continue;
    }
    scoped.push(...match[2].split(",").filter(Boolean));
  }
  return { scoped, unscoped };
}

export function forbiddenGrant(target: string): boolean {
  // A grant the rail cannot resolve is not trusted.
  if (target.startsWith("unresolved:")) return true;
  const base = target.split("/").at(-1) ?? target;
  return (GENERAL_EXEC_WRAPPERS as readonly string[]).includes(base);
}

Deno.test("no server start path grants --allow-run to a general exec wrapper", async () => {
  const offenders: string[] = [];
  for (const path of SERVER_START_SCRIPTS) {
    const { scoped, unscoped } = runGrants(
      await Deno.readTextFile(new URL(path, root)),
    );
    if (unscoped > 0) offenders.push(`${path}: unscoped --allow-run`);
    for (const target of scoped) {
      if (forbiddenGrant(target)) offenders.push(`${path}: ${target}`);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("the rail recognises exec wrappers however the grant is spelled", () => {
  // The rail itself must not be blind: each of these would let the server
  // run anything.
  for (
    const line of [
      "deno run --allow-run=/usr/bin/prlimit main.ts",
      "deno run --allow-run=prlimit main.ts",
      "deno run --allow-run=/usr/bin/stat,/usr/bin/git main.ts",
      "exec deno run --allow-run=deno x.ts",
      'deno run "--allow-run=/bin/sh" x.ts',
    ]
  ) {
    const { scoped } = runGrants(line);
    assert(scoped.some(forbiddenGrant), line);
  }
  assertEquals(runGrants("deno run --allow-run main.ts").unscoped, 1);
  // Through a variable, resolved or not.
  assert(
    runGrants('g="/usr/bin/stat,/usr/bin/prlimit"\ndeno run "--allow-run=$g" x')
      .scoped.some(forbiddenGrant),
  );
  assert(
    runGrants('deno run "--allow-run=$unknown" x').scoped.some(forbiddenGrant),
  );
  // A fixed launcher and stat are fine.
  assertEquals(
    runGrants(
      "deno run --allow-run=/srv/app/infra/server-exec/git.sh,/usr/bin/stat x",
    ).scoped.filter(forbiddenGrant),
    [],
  );
});
