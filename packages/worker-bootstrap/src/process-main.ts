import process from "node:process";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { lstat } from "node:fs/promises";
import { hostname } from "node:os";
import { LinkStepFailed } from "./link.ts";
import type { ReleaseConfig } from "./bootstrap.ts";
import { runBootstrap } from "./main.ts";
import { systemProbes } from "./probes.ts";

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
      // Adding the service needs the administrator steps `bakery-worker plan`
      // lists; this build prints them rather than running them.
      startService: () => {
        throw new LinkStepFailed(
          "The service was not added: this build cannot add it yet. Run bakery-worker plan to see the steps.",
          join(home, ".local", "share", "bakery-worker", "service.log"),
        );
      },
    },
  });
}
