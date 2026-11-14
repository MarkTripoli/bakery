import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { BootstrapError } from "./errors.ts";
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
  const known = new Set(["--server", "--root", "--token-file", "--token-fd"]);
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at]!;
    if (word === "--token" || word.startsWith("--token=")) {
      throw new BootstrapError("COMMAND_TOKEN_SHORTCUT");
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
  return {
    name,
    server,
    root: option(rest, "--root") ?? defaults.root,
    tokenFile,
  };
}

export type CommandIo = Readonly<{
  stdin: HiddenInputStream;
  /** One line a person answers locally, such as the confirmation. */
  ask: (question: string) => Promise<string>;
  write: (text: string) => void;
  fetch: typeof fetch;
  now: () => Date;
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
 * Runs a command. `setup` needs the worker installed first (installing from the
 * fixed release origin is a later step) and then pairs; `pair` pairs an
 * installation that exists. Returns a process exit code and prints only fixed
 * messages: never the setup code, never text the server supplied.
 */
export async function runCommand(
  command: Command,
  io: CommandIo,
): Promise<number> {
  try {
    if (command.name === "setup") {
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
