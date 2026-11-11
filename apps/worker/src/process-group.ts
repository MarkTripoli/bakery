/**
 * Starting a child in its own process group and signalling that group.
 *
 * Moved unchanged out of harness-common.ts so that the git runner can use it
 * without importing the harness module (which would be a cycle). harness-common
 * re-exports everything here, so no importer changes.
 */

/** Absolute helper used to signal a process group under restricted run grants. */
export const HARNESS_GROUP_KILL_EXECUTABLE = "/usr/bin/kill";

export type HarnessGroupTeardown = {
  readonly status: "confirmed" | "unconfirmed";
  readonly via: "deno-kill" | "kill-helper" | "none";
  readonly reason?: string;
};

/**
 * SIGKILL the child process group and await the result. Deno.kill needs a
 * broad run grant; under restricted grants the awaited kill helper signals the
 * group. Failure to signal the group is reported, never silently downgraded.
 */
export async function killHarnessProcessGroup(
  child: Deno.ChildProcess,
  killExecutable: string = HARNESS_GROUP_KILL_EXECUTABLE,
): Promise<HarnessGroupTeardown> {
  let teardown: HarnessGroupTeardown;
  try {
    Deno.kill(-child.pid, "SIGKILL");
    teardown = { status: "confirmed", via: "deno-kill" };
  } catch (error) {
    // An empty group (ESRCH) means every member already exited: confirmed.
    teardown = error instanceof Deno.errors.NotFound
      ? { status: "confirmed", via: "deno-kill" }
      : await killGroupWithHelper(child.pid, killExecutable);
  }
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
): Promise<HarnessGroupTeardown> {
  try {
    const result = await new Deno.Command(killExecutable, {
      args: ["-s", "KILL", "--", `-${pid}`],
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

export async function spawnInOwnProcessGroup(
  executable: string,
  args: readonly string[],
): Promise<{ command: string; args: string[] }> {
  try {
    await Deno.stat("/usr/bin/setsid");
    return {
      command: "/usr/bin/setsid",
      args: [executable, ...args],
    };
  } catch {
    return { command: executable, args: [...args] };
  }
}
