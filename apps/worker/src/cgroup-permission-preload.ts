/**
 * Deno 2.9 requires --allow-all for direct /proc and /sys access. Keep the
 * worker's sandbox narrow by routing only the configured cgroup subtree through
 * a fixed, root-confined broker process.
 */
const CGROUP_PREFIX = "/sys/fs/cgroup/";
const BROKER_RUN_EXECUTABLES = [
  "/usr/bin/cat",
  "/usr/bin/find",
  "/usr/bin/mkdir",
  "/usr/bin/readlink",
  "/usr/bin/rmdir",
  "/usr/bin/stat",
  "/usr/bin/tee",
  "/usr/bin/test",
] as const;

type BrokerRequest = {
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

type BrokerEntry = {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
};

type DenoFileInfo = Awaited<ReturnType<typeof Deno.lstat>>;
type DenoApi = typeof Deno & {
  lstat: typeof Deno.lstat;
  stat: typeof Deno.stat;
  readDir: typeof Deno.readDir;
  readTextFile: typeof Deno.readTextFile;
  writeTextFile: typeof Deno.writeTextFile;
  mkdir: typeof Deno.mkdir;
  remove: typeof Deno.remove;
};

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

function configuredCgroupRoot(): string | null {
  const value = Deno.env.get("BAKERY_WORKER_CGROUP_ROOT")?.trim();
  if (!value) return null;
  const root = value.replace(/\/+$/, "");
  const relative = root.startsWith(CGROUP_PREFIX)
    ? root.slice(CGROUP_PREFIX.length)
    : "";
  if (
    !relative ||
    root.includes("\0") ||
    /[\r\n,]/.test(root) ||
    relative.split("/").some((segment: string) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) throw new Error("BAKERY_WORKER_CGROUP_ROOT_INVALID");
  return root;
}

function brokerPath(): string {
  return decodeURIComponent(
    new URL("./cgroup-broker.ts", import.meta.url).pathname,
  );
}

class CgroupBroker {
  readonly #process: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #encoder = new TextEncoder();
  #buffer = "";
  #nextId = 1;
  #closed = false;

  private constructor(
    process: Deno.ChildProcess,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    this.#process = process;
    this.#writer = writer;
    void this.readResponses();
  }
  get closed(): boolean {
    return this.#closed;
  }

  static async start(root: string): Promise<CgroupBroker> {
    const process = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        `--allow-run=${BROKER_RUN_EXECUTABLES.join(",")}`,
        brokerPath(),
        root,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const broker = new CgroupBroker(process, process.stdin.getWriter());
    await broker.request({ op: "ready" });
    return broker;
  }

  async request(request: BrokerRequest): Promise<unknown> {
    if (this.#closed) throw new Error("CGROUP_BROKER_EXITED");
    const id = this.#nextId++;
    const {
      promise: response,
      resolve,
      reject,
    } = Promise.withResolvers<unknown>();
    this.#pending.set(id, { resolve, reject });
    try {
      await this.#writer.write(
        this.#encoder.encode(`${JSON.stringify({ id, ...request })}\n`),
      );
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return await response;
  }

  private async readResponses(): Promise<void> {
    try {
      for await (const chunk of this.#process.stdout) {
        this.#buffer += new TextDecoder().decode(chunk);
        while (true) {
          const newline = this.#buffer.indexOf("\n");
          if (newline < 0) break;
          const line = this.#buffer.slice(0, newline);
          this.#buffer = this.#buffer.slice(newline + 1);
          if (!line) continue;
          this.resolveResponse(JSON.parse(line) as BrokerResponse);
        }
      }
      throw new Error("CGROUP_BROKER_EXITED");
    } catch (error) {
      this.#closed = true;
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    }
  }

  private resolveResponse(response: BrokerResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.value);
    } else {
      pending.reject(new Error(response.error || "CGROUP_BROKER_FAILED"));
    }
  }
}

const root = configuredCgroupRoot();
let brokerPromise: Promise<CgroupBroker> | null = null;

async function broker(): Promise<CgroupBroker> {
  if (!root) throw new Error("BAKERY_WORKER_CGROUP_ROOT_INVALID");
  if (!brokerPromise) brokerPromise = CgroupBroker.start(root);
  try {
    const client = await brokerPromise;
    if (client.closed) {
      brokerPromise = null;
      return await broker();
    }
    return client;
  } catch (error) {
    brokerPromise = null;
    throw error;
  }
}

async function requestCgroup(request: BrokerRequest): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await broker();
    try {
      return await client.request(request);
    } catch (error) {
      if (client.closed && attempt === 0) {
        brokerPromise = null;
        continue;
      }
      throw error;
    }
  }
  throw new Error("CGROUP_BROKER_EXITED");
}

function isCgroupPath(path: string | URL): path is string {
  if (typeof path !== "string" || !root) return false;
  if (path === root) return true;
  if (!path.startsWith(`${root}/`)) return false;
  const relative = path.slice(root.length + 1);
  return !relative.split("/").some((segment) =>
    segment === "" || segment === "." || segment === ".." ||
    segment.includes("\0")
  );
}

async function cgroupStat(path: string): Promise<DenoFileInfo> {
  try {
    return await requestCgroup({ op: "stat", path }) as DenoFileInfo;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "CGROUP_BROKER_NOT_FOUND"
    ) {
      throw new Deno.errors.NotFound(path);
    }
    throw error;
  }
}

async function cgroupRead(path: string): Promise<string> {
  return await requestCgroup({ op: "read", path }) as string;
}

async function cgroupWrite(path: string, data: string): Promise<void> {
  await requestCgroup({ op: "write", path, data });
}

async function cgroupMkdir(path: string): Promise<void> {
  await requestCgroup({ op: "mkdir", path });
}

async function cgroupRemove(path: string): Promise<void> {
  await requestCgroup({ op: "remove", path });
}

async function* cgroupReadDir(
  path: string,
): AsyncIterableIterator<Deno.DirEntry> {
  const entries = await requestCgroup({ op: "readDir", path }) as BrokerEntry[];
  for (const entry of entries) yield entry as Deno.DirEntry;
}

const runtime = Deno as DenoApi;
const originalLstat = runtime.lstat;
const originalStat = runtime.stat;
const originalReadDir = runtime.readDir;
const originalReadTextFile = runtime.readTextFile;
const originalWriteTextFile = runtime.writeTextFile;
const originalMkdir = runtime.mkdir;
const originalRemove = runtime.remove;

runtime.lstat = (path: string | URL) =>
  isCgroupPath(path) ? cgroupStat(path) : originalLstat(path);
runtime.stat = (path: string | URL) =>
  isCgroupPath(path) ? cgroupStat(path) : originalStat(path);
runtime.readDir = (path: string | URL) =>
  isCgroupPath(path) && typeof path === "string"
    ? cgroupReadDir(path)
    : originalReadDir(path);
runtime.readTextFile = (path, options) =>
  isCgroupPath(path) ? cgroupRead(path) : originalReadTextFile(path, options);
runtime.writeTextFile = (path, data, options) =>
  isCgroupPath(path) && typeof data === "string" && !options
    ? cgroupWrite(path, data)
    : originalWriteTextFile(path, data, options);
runtime.mkdir = (path, options) =>
  isCgroupPath(path) && typeof path === "string" && !options
    ? cgroupMkdir(path)
    : originalMkdir(path, options);
runtime.remove = (path, options) =>
  isCgroupPath(path) && typeof path === "string" && !options
    ? cgroupRemove(path)
    : originalRemove(path, options);
