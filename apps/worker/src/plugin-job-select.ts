import { BWRAP_FLAG, createBwrapRuntime } from "./plugin-job-bwrap.ts";
import { createDockerRuntime, DOCKER_FLAG } from "./plugin-job-docker.ts";
import {
  type ContainmentRuntime,
  DEFAULT_CODE_MOUNT,
} from "./plugin-job-runtime.ts";

/**
 * Chooses the containment runtime a worker will run plugin jobs in (#29).
 *
 * Both runtimes are off unless an operator sets their flag. Each enabled one
 * is probed, in the order docker then bubblewrap, and the first that proves
 * its boundary on this host is used. When none does the worker runs no plugin
 * jobs and does not advertise the capability, and the reasons are returned so
 * the operator can read them in the log.
 */

export const PLUGIN_JOB_CAPABILITY = "plugin.job.contained";

export type PluginRuntimeChoice =
  | Readonly<{ kind: "selected"; runtime: ContainmentRuntime }>
  | Readonly<{ kind: "none"; reasons: readonly string[] }>;

export async function selectPluginRuntime(
  env: Readonly<Record<string, string | undefined>>,
  factories: Readonly<{
    docker?: () => ContainmentRuntime;
    bwrap?: () => ContainmentRuntime;
  }> = {},
  options: Readonly<{
    /** Host directories a contained job must not see, such as the worker's state directory. */
    hide?: readonly string[];
  }> = {},
): Promise<PluginRuntimeChoice> {
  const candidates: ContainmentRuntime[] = [];
  if (env[DOCKER_FLAG] === "1") {
    candidates.push(
      (factories.docker ?? (() => createDockerRuntime({ env })))(),
    );
  }
  if (env[BWRAP_FLAG] === "1") {
    candidates.push((factories.bwrap ??
      (() => createBwrapRuntime({ env, hide: options.hide })))());
  }
  if (candidates.length === 0) {
    return {
      kind: "none",
      reasons: ["plugin jobs are not enabled on this worker"],
    };
  }
  const reasons: string[] = [];
  for (const runtime of candidates) {
    const probe = await runtime.probe();
    if (probe.supported) return { kind: "selected", runtime };
    reasons.push(`${probe.runtime}: ${probe.reason}`);
  }
  return { kind: "none", reasons };
}

/**
 * The command that runs a job's entry inside the boundary; the entry sits under
 * the directory the runtime mounts the code at.
 */
export function jobCommand(
  env: Readonly<Record<string, string | undefined>>,
  entry: string,
  mount: string = DEFAULT_CODE_MOUNT,
): readonly string[] {
  const configured = (env.BAKERY_PLUGIN_JOB_COMMAND ?? "").trim();
  const base = configured.length > 0
    ? configured.split(/\s+/)
    : ["deno", "run", "--no-prompt", "--no-remote"];
  return [...base, `${mount}/${entry}`];
}

/**
 * Everything the worker keeps that a contained job must never read: its state
 * directory, the registration, spool and enrollment-token files, and the
 * directories holding harness logins. The job runs as the worker's own user
 * and sees the host read-only, so each of these is hidden by name.
 */
export function workerOwnedPaths(
  config: Readonly<{
    stateDir: string;
    registrationPath: string;
    spoolPath: string;
    enrollmentTokenPath?: string | undefined;
    claudeAuthSourceDir?: string | undefined;
    codexAuthSourceDir?: string | undefined;
  }>,
): string[] {
  return [
    ...new Set(
      [
        config.stateDir,
        config.registrationPath,
        config.spoolPath,
        config.enrollmentTokenPath,
        config.claudeAuthSourceDir,
        config.codexAuthSourceDir,
      ].filter((path): path is string =>
        typeof path === "string" && path !== ""
      ),
    ),
  ];
}
