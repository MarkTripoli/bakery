/**
 * Starting a child in its own process group and signalling that group.
 *
 * Lives apart from harness-common.ts so that the git runner can use it without
 * importing the harness module (a cycle). harness-common re-exports the harness
 * names, so no importer changes.
 */

/** Absolute helper used to signal a process group under restricted run grants. */
export const HARNESS_GROUP_KILL_EXECUTABLE = "/usr/bin/kill";

export type HarnessGroupTeardown = {
  readonly status: "confirmed" | "unconfirmed";
  readonly via: "deno-kill" | "kill-helper" | "none";
  readonly reason?: string;
};

/** Signals a child sends to its group; the two a stop needs. */
export type GroupSignal = "SIGTERM" | "SIGKILL";

/**
 * Sends `signal` to the process group `pid` leads and awaits the result.
 * Deno.kill needs a broad run grant; under restricted grants the awaited kill
 * helper signals the group. Failure to signal the group is reported, never
 * silently downgraded. An empty group (ESRCH) means every member already
 * exited, which is confirmed.
 */
export async function signalProcessGroup(
  pid: number,
  signal: GroupSignal,
  killExecutable: string = HARNESS_GROUP_KILL_EXECUTABLE,
  // Test seam: the unit lane's grants never allow Deno.kill, so the branch that
  // uses it is only reachable by injecting it.
  kill: (pid: number, signal: GroupSignal) => void = Deno.kill,
): Promise<HarnessGroupTeardown> {
  try {
    kill(-pid, signal);
    return { status: "confirmed", via: "deno-kill" };
  } catch (error) {
    return error instanceof Deno.errors.NotFound
      ? { status: "confirmed", via: "deno-kill" }
      : await killGroupWithHelper(pid, killExecutable, signal);
  }
}

/**
 * SIGKILL the child process group and await the result. See
 * {@link signalProcessGroup} for the grants and the failure reporting.
 */
export async function killHarnessProcessGroup(
  child: Deno.ChildProcess,
  killExecutable: string = HARNESS_GROUP_KILL_EXECUTABLE,
): Promise<HarnessGroupTeardown> {
  const teardown = await signalProcessGroup(
    child.pid,
    "SIGKILL",
    killExecutable,
  );
  try {
    child.kill("SIGKILL");
  } catch {
    // The child already exited.
  }
  return teardown;
}

async function killGroupWithHelper(
  pid: number,
  killExecutable: string,
  signal: GroupSignal = "SIGKILL",
): Promise<HarnessGroupTeardown> {
  try {
    const result = await new Deno.Command(killExecutable, {
      args: ["-s", signal === "SIGTERM" ? "TERM" : "KILL", "--", `-${pid}`],
      clearEnv: true,
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    if (result.success) return { status: "confirmed", via: "kill-helper" };
    // kill(1) exits 1 for both ESRCH and EPERM; only the former proves the
    // group is already empty.
    if (
      new TextDecoder().decode(result.stderr).includes("No such process")
    ) return { status: "confirmed", via: "kill-helper" };
    return {
      status: "unconfirmed",
      via: "none",
      reason: `group-kill-helper-exit-${result.code}`,
    };
  } catch {
    return {
      status: "unconfirmed",
      via: "none",
      reason: "group-kill-helper-unavailable",
    };
  }
}

/**
 * The command that starts `executable` as the leader of its own process group,
 * through `/usr/bin/setsid` (which execs it, so the pid is unchanged). Without
 * setsid the child is started directly and `grouped` is false: signalling its
 * group would then reach the worker's own.
 */
export async function spawnInOwnProcessGroup(
  executable: string,
  args: readonly string[],
): Promise<{ command: string; args: string[]; grouped: boolean }> {
  try {
    await Deno.stat("/usr/bin/setsid");
    return {
      command: "/usr/bin/setsid",
      args: [executable, ...args],
      grouped: true,
    };
  } catch {
    return { command: executable, args: [...args], grouped: false };
  }
}
