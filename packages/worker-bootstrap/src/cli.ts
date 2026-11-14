import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { BootstrapError } from "./errors.ts";
import { installFromOrigin, type ReleaseConfig } from "./bootstrap.ts";
import { isExactRelease } from "./manifest.ts";
import {
  type EnrollmentPreview,
  type HiddenInputStream,
  pairInstallation,
  type PairResult,
  readHiddenToken,
  readProtectedToken,
} from "./pairing.ts";

/**
 * The `setup` and `pair` commands (#18, slice 2). The setup code is only ever
 * typed at a hidden prompt or read from a protected file; there is no `--token`
 * flag and no environment variable that carries it, and both are refused by
 * name so a habit from another tool cannot leak one into a shell history.
 */

export type Command = Readonly<{
  name: "setup" | "pair";
  server: string;
  root: string;
  /** A protected file that holds the code; absent means the hidden prompt. */
  tokenFile: string | null;
  /** `setup` only: the exact release to install from the release origin, if it is not installed yet. */
  release?: string | null;
  /** `setup` only: consent to replace a different installed release. */
  upgrade?: boolean;
}>;

const TOKEN_ENVIRONMENT = [
  "BAKERY_WORKER_ENROLLMENT_TOKEN",
  "BAKERY_ENROLLMENT_TOKEN",
];

function option(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new BootstrapError("COMMAND_UNKNOWN");
  }
  return value;
}

/** Reads the command line and the environment, or refuses. Pure. */
export function parseCommand(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  defaults: Readonly<{ root: string }>,
): Command {
  const [name, ...rest] = argv;
  if (name !== "setup" && name !== "pair") {
    throw new BootstrapError("COMMAND_UNKNOWN");
  }
  const known = new Set([
    "--server",
    "--root",
    "--token-file",
    "--token-fd",
    ...(name === "setup" ? ["--release"] : []),
  ]);
  let upgrade = false;
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at]!;
    if (word === "--token" || word.startsWith("--token=")) {
      throw new BootstrapError("COMMAND_TOKEN_SHORTCUT");
    }
    if (word === "--upgrade") {
      upgrade = true;
      continue;
    }
    if (word.startsWith("--")) {
      if (!known.has(word)) throw new BootstrapError("COMMAND_UNKNOWN");
      at += 1;
    } else throw new BootstrapError("COMMAND_UNKNOWN");
  }
  for (const key of TOKEN_ENVIRONMENT) {
    if ((environment[key] ?? "") !== "") {
      throw new BootstrapError("COMMAND_TOKEN_SHORTCUT");
    }
  }
  const server = option(rest, "--server");
  if (server === null) throw new BootstrapError("COMMAND_UNKNOWN");
  const fd = option(rest, "--token-fd");
  const file = option(rest, "--token-file");
  if (fd !== null && file !== null) throw new BootstrapError("COMMAND_UNKNOWN");
  let tokenFile = file;
  if (fd !== null) {
    // A descriptor is read through the process's own table, where only this
    // process's owner can reach it: /proc/self/fd on Linux.
    if (!/^[0-9]{1,4}$/.test(fd) || Number(fd) < 3) {
      throw new BootstrapError("COMMAND_UNKNOWN");
    }
    tokenFile = `/proc/self/fd/${fd}`;
  }
  const release = name === "setup" ? option(rest, "--release") : null;
  if (release !== null && !isExactRelease(release)) {
    throw new BootstrapError("RELEASE_NOT_EXACT");
  }
  if (upgrade && release === null) throw new BootstrapError("COMMAND_UNKNOWN");
  return {
    name,
    server,
    root: option(rest, "--root") ?? defaults.root,
    tokenFile,
    ...(name === "setup" ? { release, upgrade } : {}),
  };
}

export type CommandIo = Readonly<{
  stdin: HiddenInputStream;
  /** One line a person answers locally, such as the confirmation. */
  ask: (question: string) => Promise<string>;
  write: (text: string) => void;
  fetch: typeof fetch;
  now: () => Date;
  /**
   * What `setup --release` installs from: the origin and trust root this build
   * was made with, and the machine's own platform. A build without a release
   * origin leaves it out, and `setup --release` then says so.
   */
  release?: Readonly<{ config: ReleaseConfig; platform: string; arch: string }>;
}>;

function describe(preview: EnrollmentPreview): string {
  return [
    `Organization: ${preview.organizationName}`,
    `Machine: ${preview.name} (${preview.os} ${preview.architecture}, ${preview.slots} at once)`,
    `May run: ${preview.capabilities.join(", ")}`,
    `Setup code expires: ${preview.expiresAt}`,
  ].join("\n");
}

/**
 * Runs a command. `setup --release V` installs that exact signed release from
 * the fixed release origin if it is not installed, then pairs; `setup` without
 * a release needs the worker installed already; `pair` pairs an installation
 * that exists. Returns a process exit code. It prints fixed
 * messages, and at the confirmation the server's preview of the organization,
 * the machine and what it may run: that text is shown only after the pairing
 * module has refused any control, line-break or direction-changing character in
 * it, so it cannot forge or erase a line. It never prints the setup code.
 */
export async function runCommand(
  command: Command,
  io: CommandIo,
): Promise<number> {
  try {
    if (command.name === "setup" && (command.release ?? null) !== null) {
      if (io.release === undefined) {
        throw new BootstrapError("SETUP_RELEASE_NOT_CONFIGURED");
      }
      const installedRelease = await installFromOrigin({
        root: command.root,
        release: command.release!,
        config: io.release.config,
        fetch: io.fetch,
        now: io.now(),
        platform: io.release.platform,
        arch: io.release.arch,
        upgrade: command.upgrade === true,
      });
      // Both come from the verified manifest: an exact version and a known target.
      io.write(
        installedRelease.status === "installed"
          ? `Installed release ${installedRelease.release} for ${installedRelease.target}.\n`
          : `Release ${installedRelease.release} for ${installedRelease.target} is already installed.\n`,
      );
    } else if (command.name === "setup") {
      let installed = false;
      try {
        installed = (await lstat(join(command.root, "current")))
          .isSymbolicLink();
      } catch {
        installed = false;
      }
      if (!installed) throw new BootstrapError("SETUP_NOT_INSTALLED");
    }
    const result: PairResult = await pairInstallation({
      root: command.root,
      serverUrl: command.server,
      readToken: () =>
        command.tokenFile !== null
          ? readProtectedToken(command.tokenFile)
          : readHiddenToken(io.stdin, io.write),
      confirm: async (preview) => {
        io.write(`${describe(preview)}\n`);
        const answer = await io.ask(
          "Pair this machine with this organization? [y/N] ",
        );
        return /^y(es)?$/i.test(answer.trim());
      },
      fetch: io.fetch,
      now: io.now(),
    });
    io.write(
      result.status === "paired"
        ? "Paired. Start the worker service, then return to Bakery.\n"
        : "This installation is already paired with this setup. Nothing was changed.\n",
    );
    return 0;
  } catch (error) {
    io.write(
      `${
        error instanceof BootstrapError
          ? error.message
          : "Setup could not complete. Nothing was changed."
      }\n`,
    );
    return error instanceof BootstrapError && error.code === "PAIRING_DECLINED"
      ? 1
      : 2;
  }
}
