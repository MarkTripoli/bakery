import { LANE_STACK_REGISTRY_VARIABLE } from "../../scripts/ci/lane-environment.ts";

/**
 * Records the compose project name of a stack a fixture is about to bring up
 * (#246), so the test runner can remove it by name if the test process does not
 * survive to tear it down. Call it before the first docker command of the
 * project. Outside a lane run (no registry named) it does nothing.
 */
export function registerLaneStack(project: string): void {
  const registry = Deno.env.get(LANE_STACK_REGISTRY_VARIABLE);
  if (registry === undefined || registry.length === 0) return;
  Deno.writeTextFileSync(registry, `${project}\n`, { append: true });
}
