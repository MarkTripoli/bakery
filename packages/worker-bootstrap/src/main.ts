import { BootstrapError } from "./errors.ts";
import { type CommandIo, parseCommand, runCommand } from "./cli.ts";
import {
  type OperationIo,
  parseOperation,
  runOperation,
} from "./operations.ts";

/**
 * The one entry point for every command (#18, last slice): `setup`, `pair`,
 * `status`, `doctor`, `drain` and `plan`. It reads the command line, hands it to
 * the parser of its kind and runs it; anything that cannot be parsed prints one
 * fixed sentence and exits 2. Both kinds of command talk to the world only
 * through the io they are given, so a test runs the whole thing against a temp
 * root and loopback servers.
 */
export type BootstrapIo = Readonly<{
  command: CommandIo;
  operation: OperationIo;
  /** Where the installation lives unless `--root` says otherwise. */
  defaultRoot: string;
  environment: Readonly<Record<string, string | undefined>>;
}>;

export async function runBootstrap(
  argv: readonly string[],
  io: BootstrapIo,
): Promise<number> {
  try {
    if (argv[0] === "setup" || argv[0] === "pair") {
      return await runCommand(
        parseCommand(argv, io.environment, { root: io.defaultRoot }),
        io.command,
      );
    }
    return await runOperation(
      parseOperation(argv, { root: io.defaultRoot }),
      io.operation,
    );
  } catch (error) {
    io.command.write(
      `${
        error instanceof BootstrapError
          ? error.message
          : "The command could not complete. Nothing was changed."
      }\n`,
    );
    return 2;
  }
}
