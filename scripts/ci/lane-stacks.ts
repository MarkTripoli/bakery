/**
 * The compose stacks one lane run brought up (#246). The fixtures that start a
 * compose stack write its project name to the file named by
 * `BAKERY_LANE_STACK_REGISTRY` before they start it; when the lane ends, the
 * runner removes by name whatever of those projects is still there. A test
 * process that was killed (a timeout, an out-of-memory kill) cannot run its own
 * teardown, and a bring-up that stopped half way leaves `Created` containers
 * and networks behind; the runner outlives both.
 *
 * Only names a fixture of this run wrote are touched, and only resources that
 * carry exactly that compose project label: never a stack found by its shape
 * or by being new.
 */

/** A compose project name a fixture may register: the repository's own prefix and nothing that could be an option. */
const STACK_NAME = /^bakery-[a-z0-9][a-z0-9_-]{0,127}$/;

/** The registered names in the file's text: one per line, valid ones only, once each. */
export function parseLaneStacks(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const name = line.trim();
    if (STACK_NAME.test(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Runs `docker` with these arguments: its exit code (127 when it cannot run) and standard output. */
export type DockerRun = (
  args: readonly string[],
) => Promise<{ code: number; text: string }>;

export type StackSweep = {
  /** Projects that had something left and now have nothing. */
  removed: string[];
  /** Projects that still have something after the attempt, or could not be asked about. */
  failed: string[];
};

type Resources = {
  containers: string[];
  networks: string[];
  volumes: string[];
};

async function resourcesOf(
  docker: DockerRun,
  project: string,
): Promise<Resources | null> {
  const label = `label=com.docker.compose.project=${project}`;
  const ask = async (args: string[]): Promise<string[] | null> => {
    const result = await docker(args);
    return result.code === 0
      ? result.text.split("\n").map((id) => id.trim()).filter(Boolean)
      : null;
  };
  const containers = await ask(["ps", "-a", "-q", "--filter", label]);
  const networks = await ask(["network", "ls", "-q", "--filter", label]);
  const volumes = await ask(["volume", "ls", "-q", "--filter", label]);
  return containers === null || networks === null || volumes === null
    ? null
    : { containers, networks, volumes };
}

const none = (resources: Resources) =>
  resources.containers.length + resources.networks.length +
      resources.volumes.length === 0;

/** Removes what is left of each named compose project; a project with nothing left is not reported. */
export async function sweepLaneStacks(
  names: readonly string[],
  docker: DockerRun,
): Promise<StackSweep> {
  const sweep: StackSweep = { removed: [], failed: [] };
  for (const project of names) {
    const found = await resourcesOf(docker, project);
    if (found === null) {
      sweep.failed.push(project);
      continue;
    }
    if (none(found)) continue;
    await docker([
      "compose",
      "--project-name",
      project,
      "down",
      "-v",
      "--remove-orphans",
    ]);
    // What compose could not remove (a half-created project, a network made by
    // hand with the project's label) goes by id, from the same label.
    const left = await resourcesOf(docker, project);
    if (left !== null && !none(left)) {
      if (left.containers.length > 0) {
        await docker(["rm", "-f", "-v", ...left.containers]);
      }
      if (left.networks.length > 0) {
        await docker(["network", "rm", ...left.networks]);
      }
      if (left.volumes.length > 0) {
        await docker(["volume", "rm", "-f", ...left.volumes]);
      }
    }
    const after = await resourcesOf(docker, project);
    (after !== null && none(after) ? sweep.removed : sweep.failed).push(
      project,
    );
  }
  return sweep;
}
