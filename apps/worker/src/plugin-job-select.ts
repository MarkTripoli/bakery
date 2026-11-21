import { BWRAP_FLAG, createBwrapRuntime } from "./plugin-job-bwrap.ts";
import { createDockerRuntime, DOCKER_FLAG } from "./plugin-job-docker.ts";
import type { ContainmentRuntime } from "./plugin-job-runtime.ts";

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
): Promise<PluginRuntimeChoice> {
  const candidates: ContainmentRuntime[] = [];
  if (env[DOCKER_FLAG] === "1") {
    candidates.push(
      (factories.docker ?? (() => createDockerRuntime({ env })))(),
    );
  }
  if (env[BWRAP_FLAG] === "1") {
    candidates.push((factories.bwrap ?? (() => createBwrapRuntime({ env })))());
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

/** The command that runs a job's entry inside the boundary; the entry sits under /code. */
export function jobCommand(
  env: Readonly<Record<string, string | undefined>>,
  entry: string,
): readonly string[] {
  const configured = (env.BAKERY_PLUGIN_JOB_COMMAND ?? "").trim();
  const base = configured.length > 0
    ? configured.split(/\s+/)
    : ["deno", "run", "--no-prompt", "--no-remote"];
  return [...base, `/code/${entry}`];
}
