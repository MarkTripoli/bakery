import process from "node:process";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  appendFile,
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { LinkStepFailed } from "./link.ts";
import type { ReleaseConfig } from "./bootstrap.ts";
import { runBootstrap } from "./main.ts";
import { systemProbes } from "./probes.ts";
import { readRecord } from "./bounded-read.ts";
import { LINUX_UNIT_PATH } from "./service.ts";
import { REGISTRATION_SET_ASIDE } from "./service-link.ts";
import { type ServiceRunner, startLinkedService } from "./service-start.ts";

async function hostIdIn(path: string): Promise<string | null> {
  try {
    const registered = JSON.parse(await readRecord(path)) as {
      workerHostId?: unknown;
    };
    return typeof registered.workerHostId === "string"
      ? registered.workerHostId
      : null;
  } catch {
    return null;
  }
}

async function registeredHostId(root: string): Promise<string | null> {
  return await hostIdIn(join(root, "state", "registration.json")) ??
    await hostIdIn(join(root, "state", REGISTRATION_SET_ASIDE));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

const systemServiceRunner: ServiceRunner = {
  run: (argv, log) =>
    new Promise((resolve) => {
      const [program, ...args] = argv;
      if (program === undefined) return resolve(127);
      const child = spawn(program, args, {
        stdio: ["inherit", "pipe", "pipe"],
      });
      const record = (chunk: Uint8Array) =>
        void appendFile(log, chunk, { mode: 0o600 }).catch(() => undefined);
      child.stdout.on("data", record);
      child.stderr.on("data", record);
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    }),
  writeFile: (path, text, mode) => writeFile(path, text, { mode }),
  remove: (path) => rm(path, { force: true }),
  move: (from, to) => rename(from, to),
  exists,
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
};

/**
 * The command line around `runBootstrap`: the real terminal, the real clock and
 * network, and the real read-only probes. This and `bin.ts` are the only files
 * that touch the process or the environment (the environment is read here only
 * to refuse a setup code in it), so everything else is tested with fakes. The
 * release origin and trust root come in as `config`: the build's constant in
 * `bin.ts`, and a test's own (loopback, local test keys) in a test entry.
 */
export async function main(
  argv: readonly string[],
  config: ReleaseConfig | undefined,
): Promise<number> {
  const target = process.platform === "linux"
    ? "linux"
    : process.platform === "darwin"
    ? "macos"
    : null;
  const home = process.env.HOME;
  if (target === null || home === undefined || !isAbsolute(home)) {
    process.stderr.write(
      "This system is not supported, or its home directory is not set.\n",
    );
    return 2;
  }
  const write = (text: string) => void process.stdout.write(text);
  const ask = async (question: string) => {
    const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await lines.question(question);
    } finally {
      lines.close();
    }
  };
  return await runBootstrap(argv, {
    defaultRoot: join(home, ".local", "share", "bakery-worker"),
    environment: process.env,
    command: {
      stdin: process.stdin,
      write,
      ask,
      fetch,
      now: () => new Date(),
      release: config === undefined ? undefined : {
        config,
        platform: process.platform,
        arch: process.arch,
      },
    },
    operation: { write, probes: systemProbes(target), target, home },
    link: {
      isTerminal: process.stdin.isTTY === true,
      registeredHost: async (root) => {
        const known = await registeredHostId(root);
        if (known !== null) return { kind: "known", workerHostId: known };
        return target === "linux" && await exists(LINUX_UNIT_PATH)
          ? { kind: "in-service" }
          : { kind: "none" };
      },
      ask,
      waitForEnter: async () => {
        await ask("");
      },
      write,
      fetch,
      now: () => new Date(),
      sleep: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
      machine: {
        platform: process.platform,
        arch: process.arch,
        hostname: hostname(),
      },
      // Installing from the release origin needs the build's release origin
      // and an exact release, which are owner work behind the B00.04
      // allowlist (see release-config.ts). Until then `link` uses a worker
      // already installed in the root and says so when there is none.
      install: async (root) => {
        let installed = false;
        try {
          installed = (await lstat(join(root, "current"))).isSymbolicLink();
        } catch {
          installed = false;
        }
        if (!installed) {
          throw new LinkStepFailed(
            "The worker is not installed: this build has no release to install from.",
            join(root, "install.log"),
          );
        }
      },
      startService: (binding, root, repairOf) =>
        startLinkedService(
          binding,
          {
            target,
            root,
            home,
            uid: typeof process.getuid === "function" ? process.getuid() : null,
            username: userInfo().username,
          },
          systemServiceRunner,
          repairOf,
        ),
    },
  });
}
