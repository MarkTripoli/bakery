/**
 * The one git the worker may run, by absolute path.
 *
 * The run grants name this path and Deno matches the path a command resolves
 * to. A bare `git` resolves through PATH, so on a host whose PATH lists `/bin`
 * before `/usr/bin` it becomes `/bin/git`, misses the grant and fails with
 * NotCapable. Granting the bare name instead would let whichever git comes
 * first on PATH run, which is the wider grant the narrow list avoids. So every
 * grant and every spawn of git in the worker uses this constant.
 */
export const GIT_EXECUTABLE = "/usr/bin/git" as const;
