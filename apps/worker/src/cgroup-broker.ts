import { REPOSITORY_INSPECTION_LIMITS } from "../../../packages/config/src/env.ts";

const CAT = "/usr/bin/cat";
const FIND = "/usr/bin/find";
const MKDIR = "/usr/bin/mkdir";
const READLINK = "/usr/bin/readlink";
const RMDIR = "/usr/bin/rmdir";
const STAT = "/usr/bin/stat";
const TEE = "/usr/bin/tee";
const TEST = "/usr/bin/test";

const CGROUP_PREFIX = "/sys/fs/cgroup/";
const BOUNDARY_NAME =
  /^bakery-native-(?:probe-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILES: Record<string, true> = {
  "cgroup.controllers": true,
  "cgroup.events": true,
  "cgroup.kill": true,
  "cgroup.procs": true,
  "memory.max": true,
  "memory.swap.max": true,
  "pids.max": true,
};

type BrokerRequest = {
  readonly id: number;
  readonly op:
    | "ready"
    | "stat"
    | "read"
    | "write"
    | "mkdir"
    | "remove"
    | "readDir";
  readonly path?: string;
  readonly data?: string;
};

type BrokerResponse = {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
};

type FileInfo = {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  readonly dev: string;
  readonly ino: string;
};

type DirectoryEntry = {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
};

function fail(code: string): never {
  throw new Error(code);
}

function parseRoot(value: string | undefined): string {
  const root = value?.trim().replace(/\/+$/, "") || "";
  const relative = root.startsWith(CGROUP_PREFIX)
    ? root.slice(CGROUP_PREFIX.length)
    : "";
  if (
    !relative ||
    root.includes("\0") ||
    /[\r\n,]/.test(root) ||
    relative.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) fail("CGROUP_BROKER_ROOT_INVALID");
  return root;
}

async function run(
  command: string,
  args: readonly string[],
): Promise<Deno.CommandOutput> {
  const output = await new Deno.Command(command, {
    args: [...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) fail(`CGROUP_BROKER_OPERATION_FAILED:${command}`);
  return output;
}

function decode(output: Deno.CommandOutput): string {
  return new TextDecoder().decode(output.stdout);
}

async function verifyRoot(root: string): Promise<void> {
  const canonical = decode(await run(READLINK, ["-f", "--", root])).trim();
  if (canonical !== root) fail("CGROUP_BROKER_ROOT_NOT_CANONICAL");
  const type = decode(await run(STAT, ["-c", "%F", "--", root])).trim();
  if (type !== "directory") fail("CGROUP_BROKER_ROOT_NOT_DIRECTORY");
}

function confinedPath(root: string, path: string): string[] {
  if (path !== root && !path.startsWith(`${root}/`)) {
    fail("CGROUP_BROKER_PATH_OUTSIDE_ROOT");
  }
  const relative = path === root ? "" : path.slice(root.length + 1);
  const segments = relative ? relative.split("/") : [];
  if (
    segments.some((segment) =>
      !segment || segment === "." || segment === ".." || segment.includes("\0")
    )
  ) fail("CGROUP_BROKER_PATH_INVALID");
  if (
    segments.length === 1 && !Object.hasOwn(FILES, segments[0]) &&
    !BOUNDARY_NAME.test(segments[0])
  ) fail("CGROUP_BROKER_PATH_INVALID");
  if (
    segments.length === 2 &&
    (!BOUNDARY_NAME.test(segments[0]) ||
      !Object.hasOwn(FILES, segments[1]))
  ) fail("CGROUP_BROKER_PATH_INVALID");
  if (segments.length > 2) fail("CGROUP_BROKER_PATH_INVALID");
  return segments;
}

function boundaryPath(root: string, path: string): boolean {
  const segments = confinedPath(root, path);
  return segments.length === 1 && BOUNDARY_NAME.test(segments[0]);
}
async function statPath(root: string, path: string): Promise<FileInfo> {
  confinedPath(root, path);
  const output = await new Deno.Command(STAT, {
    args: ["-c", "%F %d %i", "--", path],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const exists = await new Deno.Command(TEST, {
      args: ["-e", path],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    if (!exists.success) fail("CGROUP_BROKER_NOT_FOUND");
    fail(`CGROUP_BROKER_OPERATION_FAILED:${STAT}`);
  }
  const fields = decode(output).trim().match(/^(.*) (\d+) (\d+)$/s);
  if (!fields) fail("CGROUP_BROKER_STAT_INVALID");
  const kind = fields[1];
  return {
    isFile: kind.startsWith("regular") && kind.endsWith("file"),
    isDirectory: kind === "directory",
    isSymlink: kind.includes("symbolic link"),
    dev: fields[2],
    ino: fields[3],
  };
}

async function readPath(root: string, path: string): Promise<string> {
  const segments = confinedPath(root, path);
  if (
    !segments.length ||
    (segments.length === 1 && BOUNDARY_NAME.test(segments[0]))
  ) {
    fail("CGROUP_BROKER_PATH_INVALID");
  }
  return decode(await run(CAT, ["--", path]));
}

async function writePath(
  root: string,
  path: string,
  data: string,
): Promise<void> {
  const segments = confinedPath(root, path);
  if (segments.length !== 2 || !BOUNDARY_NAME.test(segments[0])) {
    fail("CGROUP_BROKER_WRITE_INVALID");
  }
  if (segments[1] === "cgroup.kill" && data !== "1\n") {
    fail("CGROUP_BROKER_WRITE_INVALID");
  }
  if (segments[1] === "cgroup.procs" && !/^\d+\n?$/.test(data)) {
    fail("CGROUP_BROKER_WRITE_INVALID");
  }
  const inspectionControls: Record<string, string> = {
    "memory.max": `${REPOSITORY_INSPECTION_LIMITS.memoryBytes}\n`,
    "memory.swap.max": "0\n",
    "pids.max": `${REPOSITORY_INSPECTION_LIMITS.processes}\n`,
  };
  if (
    segments[1] !== "cgroup.kill" && segments[1] !== "cgroup.procs" &&
    inspectionControls[segments[1]] !== data
  ) {
    fail("CGROUP_BROKER_WRITE_INVALID");
  }
  const process = new Deno.Command(TEE, {
    args: ["--", path],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(data));
  await writer.close();
  if (!(await process.status).success) {
    fail(`CGROUP_BROKER_OPERATION_FAILED:${TEE}`);
  }
}

async function createPath(root: string, path: string): Promise<void> {
  if (!boundaryPath(root, path)) fail("CGROUP_BROKER_PATH_INVALID");
  await run(MKDIR, ["--", path]);
}

async function removePath(root: string, path: string): Promise<void> {
  if (!boundaryPath(root, path)) fail("CGROUP_BROKER_PATH_INVALID");
  await run(RMDIR, ["--", path]);
}

async function readDirectory(
  root: string,
  path: string,
): Promise<DirectoryEntry[]> {
  const segments = confinedPath(root, path);
  if (segments.length > 0 && !BOUNDARY_NAME.test(segments[0])) {
    fail("CGROUP_BROKER_PATH_INVALID");
  }
  const records = decode(
    await run(FIND, [
      "--",
      path,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-printf",
      "%f\\0%y\\0",
    ]),
  ).split("\0");
  const entries: DirectoryEntry[] = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    const name = records[index];
    const type = records[index + 1];
    if (!name) continue;
    entries.push({
      name,
      isFile: type === "f",
      isDirectory: type === "d",
      isSymlink: type === "l",
    });
  }
  return entries;
}

async function handle(root: string, request: BrokerRequest): Promise<unknown> {
  switch (request.op) {
    case "ready":
      return true;
    case "stat":
      return await statPath(root, request.path ?? "");
    case "read":
      return await readPath(root, request.path ?? "");
    case "write":
      await writePath(root, request.path ?? "", request.data ?? "");
      return null;
    case "mkdir":
      await createPath(root, request.path ?? "");
      return null;
    case "remove":
      await removePath(root, request.path ?? "");
      return null;
    case "readDir":
      return await readDirectory(root, request.path ?? "");
  }
}

async function send(response: BrokerResponse): Promise<void> {
  await Deno.stdout.write(
    new TextEncoder().encode(`${JSON.stringify(response)}\n`),
  );
}
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function resetIdleTimer(): void {
  idleTimer = setTimeout(() => Deno.exit(0), 1_000);
}

async function main(): Promise<void> {
  const root = parseRoot(Deno.args[0]);
  await verifyRoot(root);
  resetIdleTimer();
  let buffer = "";
  for await (const chunk of Deno.stdin.readable) {
    clearTimeout(idleTimer);
    buffer += new TextDecoder().decode(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as BrokerRequest;
      try {
        await send({
          id: request.id,
          ok: true,
          value: await handle(root, request),
        });
      } catch (error) {
        await send({
          id: request.id,
          ok: false,
          error: error instanceof Error
            ? error.message
            : "CGROUP_BROKER_OPERATION_FAILED",
        });
      }
    }
    resetIdleTimer();
  }
}

if (import.meta.main) await main();
