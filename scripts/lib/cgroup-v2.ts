export type CgroupLease = {
  readonly root: string;
  readonly release: () => Promise<void>;
};

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_PREFIX = "bakery-worker-";
const CAT = "/usr/bin/cat";
const MKDIR = "/usr/bin/mkdir";
const RMDIR = "/usr/bin/rmdir";
const TEE = "/usr/bin/tee";
const TEST = "/usr/bin/test";

function failure(): Error {
  return new Error("WORKER_CGROUP_DELEGATION_REQUIRED");
}

async function run(
  command: string,
  args: readonly string[],
): Promise<Deno.CommandOutput | null> {
  return await new Deno.Command(command, {
    args: [...args],
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => null);
}

async function readFile(path: string): Promise<string> {
  const result = await run(CAT, [path]);
  if (!result?.success) throw failure();
  return new TextDecoder().decode(result.stdout);
}

async function writeFile(path: string, content: string): Promise<void> {
  const process = new Deno.Command(TEE, {
    args: [path],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(content));
  await writer.close();
  if (!(await process.status).success) throw failure();
}

function cgroupPathFromMembership(membership: string): string {
  const line = membership.split("\n").find((entry) => entry.startsWith("0::"));
  const relative = line?.slice(3).trim();
  if (
    !relative || !relative.startsWith("/") ||
    relative.split("/").includes("..")
  ) {
    throw failure();
  }
  return `${CGROUP_ROOT}${relative}`;
}
async function findDelegatedParent(current: string): Promise<string> {
  let candidate = current;
  while (
    candidate === CGROUP_ROOT ||
    candidate.startsWith(`${CGROUP_ROOT}/`)
  ) {
    await requireDirectory(candidate);
    const controllers = (await readFile(`${candidate}/cgroup.controllers`))
      .split(/\s+/);
    if (controllers.includes("memory") && controllers.includes("pids")) {
      const processes = (await readFile(`${candidate}/cgroup.procs`)).trim();
      if (!processes) {
        const subtreePath = `${candidate}/cgroup.subtree_control`;
        let subtree = (await readFile(subtreePath)).split(/\s+/);
        const missing = ["memory", "pids"].filter((controller) =>
          !subtree.includes(controller)
        );
        if (missing.length > 0) {
          await writeFile(
            subtreePath,
            `${missing.map((controller) => `+${controller}`).join(" ")}\n`,
          );
          subtree = (await readFile(subtreePath)).split(/\s+/);
        }
        if (
          subtree.includes("memory") && subtree.includes("pids")
        ) return candidate;
      }
    }
    if (candidate === CGROUP_ROOT) break;
    const parent = candidate.slice(0, candidate.lastIndexOf("/"));
    if (!parent || parent === candidate) break;
    candidate = parent;
  }
  throw failure();
}

async function requireReadable(path: string): Promise<void> {
  await readFile(path);
}

async function requirePresent(path: string): Promise<void> {
  const regular = await run(TEST, ["-f", path]);
  const symlink = await run(TEST, ["-L", path]);
  if (!regular?.success || symlink?.success) throw failure();
}
async function requireDirectory(path: string): Promise<void> {
  const directory = await run(TEST, ["-d", path]);
  const symlink = await run(TEST, ["-L", path]);
  if (!directory?.success || symlink?.success) throw failure();
}

async function createDirectory(path: string): Promise<void> {
  const result = await run(MKDIR, [path]);
  if (!result?.success) throw failure();
}

async function removeEmpty(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await run(RMDIR, [path]);
    if (result?.success) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw failure();
}

export async function provisionDelegatedCgroupV2(
  prefix = CGROUP_PREFIX,
): Promise<CgroupLease> {
  if (Deno.build.os !== "linux") throw failure();
  const membership = await readFile("/proc/self/cgroup");
  const parent = await findDelegatedParent(
    cgroupPathFromMembership(membership),
  );
  await requireReadable(`${parent}/cgroup.events`);
  await requireReadable(`${parent}/cgroup.procs`);
  await requirePresent(`${parent}/cgroup.kill`);

  const root = `${parent}/${prefix}${crypto.randomUUID()}`;
  try {
    await createDirectory(root);
    await requireDirectory(root);
    await requireReadable(`${root}/cgroup.events`);
    await requireReadable(`${root}/cgroup.procs`);
    await requirePresent(`${root}/cgroup.kill`);
    const childControllers = await readFile(`${root}/cgroup.controllers`);
    const delegated = childControllers.split(/\s+/);
    if (!delegated.includes("memory") || !delegated.includes("pids")) {
      throw failure();
    }
    await writeFile(`${root}/cgroup.subtree_control`, "+memory +pids\n");
    const subtree = (await readFile(`${root}/cgroup.subtree_control`)).split(
      /\s+/,
    );
    if (!subtree.includes("memory") || !subtree.includes("pids")) {
      throw failure();
    }
  } catch {
    await removeEmpty(root).catch(() => undefined);
    throw failure();
  }

  let released = false;
  return {
    root,
    release: async () => {
      if (released) return;
      released = true;
      await writeFile(`${root}/cgroup.kill`, "1\n");
      await removeEmpty(root);
    },
  };
}
