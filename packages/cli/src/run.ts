import { createFilesApi, describeFailure, type FilesApi } from "./api.ts";
import { SessionFileMismatch } from "./session-files.ts";
import { SessionRefusal } from "./session-call.ts";
import { type CliConfig, readConfig, UsageError } from "./config.ts";
import {
  cat,
  CommandError,
  type FileOptions,
  get,
  history,
  ls,
  open,
  type Output,
  search,
  setPin,
  stat,
  uses,
} from "./files.ts";

export const HELP = `bakery: read Bakery's file tree from the command line.

Usage:
  bakery files ls [path]                 list a folder (the top-level folders at /)
  bakery files stat <ref>                what a file or folder is
  bakery files history <ref>             every saved version of a file
  bakery files uses <ref>                the runs that used the file
  bakery files cat <ref>                 write a file's bytes to standard output
  bakery files get <ref> [-o path]       save a file (checks its digest)
  bakery files open <version-id>         the path and revision a saved version belongs to
  bakery files pin <path>                keep a record file's versions (administrators; needs artifact:manage)
  bakery files unpin <path>              let retention apply to it again
  bakery files search [text] [--in path] [--kind kind] [--type media-type]
  bakery tools                           what this session may call (sessions only)

A <ref> is a path (/projects/web/plan.md), a path at one revision
(/projects/web/plan.md@3), or one saved version (@<version id>).

Options:
  --json             print JSON instead of text
  -l, --long         ls: kind, size, changed
  --range bytes=a-b  cat, get: one byte range
  -o, --output path  get: where to save (default: the file's name here)
  --force            get: replace a file that exists
  --url, --organization   take the place of BAKERY_URL and BAKERY_ORGANIZATION

Settings (environment): BAKERY_URL, BAKERY_ORGANIZATION, and BAKERY_TOKEN
or BAKERY_TOKEN_FILE (an access token from Settings). There is no --token
flag, so a token never lands in shell history.

Inside a session there is no access token: the worker writes this attempt's
session operation credential to BAKERY_SESSION_CREDENTIAL_FILE, and the same
commands go through the tool gateway as the person the run is for. The tools
command lists what that credential may call. Nothing here can exceed it.
`;

type Parsed = Readonly<{
  command: string | null;
  positionals: readonly string[];
  options: FileOptions;
  flags: Readonly<{ url?: string; organization?: string }>;
  help: boolean;
}>;

const VALUE_FLAGS = new Set([
  "--range",
  "-o",
  "--output",
  "--url",
  "--organization",
  "--in",
  "--kind",
  "--type",
]);

/** Reads the arguments after `files`, or refuses with the flag it did not understand. */
export function parseArguments(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  let long = false;
  let force = false;
  let help = false;
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at];
    if (argument === "--json") json = true;
    else if (argument === "-l" || argument === "--long") long = true;
    else if (argument === "--force") force = true;
    else if (argument === "-h" || argument === "--help") help = true;
    else if (VALUE_FLAGS.has(argument)) {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`${argument} needs a value.`);
      }
      values.set(argument === "--output" ? "-o" : argument, value);
      at += 1;
    } else if (argument.startsWith("--token")) {
      throw new UsageError(
        "There is no --token flag: set BAKERY_TOKEN or BAKERY_TOKEN_FILE, so the token stays out of shell history.",
      );
    } else if (argument.startsWith("-") && argument !== "-") {
      throw new UsageError(`Unknown option ${argument}. Try --help.`);
    } else positionals.push(argument);
  }
  const [group, command, ...rest] = positionals;
  if (group !== undefined && group !== "files" && group !== "tools") {
    throw new UsageError(`Unknown command "${group}". Try --help.`);
  }
  return {
    // `tools` is its own one-word command: it takes no sub-command and no
    // positionals, so its group name is carried as the command.
    command: group === "tools" ? "tools" : command ?? null,
    positionals: group === "tools"
      ? [command, ...rest].filter(
        (item) => item !== undefined,
      ) as string[]
      : rest,
    help: help || group === undefined,
    flags: {
      url: values.get("--url"),
      organization: values.get("--organization"),
    },
    options: {
      json,
      long,
      force,
      range: values.get("--range"),
      output: values.get("-o"),
      search: {
        ...(values.has("--in") ? { path: values.get("--in") } : {}),
        ...(values.has("--kind") ? { kind: values.get("--kind") } : {}),
        ...(values.has("--type") ? { mediaType: values.get("--type") } : {}),
      },
    },
  };
}

export type Runtime = Readonly<{
  environment: (name: string) => string | undefined;
  output: Output;
  error: (line: string) => void;
  createApi?: (config: CliConfig) => FilesApi;
  readFileText?: (path: string) => Promise<string>;
  /**
   * True when the command runs inside a session (#404).
   *
   * Decided by the caller from what the environment holds, not by a flag: a
   * session has no access token, so `readConfig` would refuse it before any
   * command could explain why. The transport is chosen once, here.
   */
  inSession?: true;
  /** The session transport; required exactly when `inSession` is set. */
  createSessionApi?: (
    flags: Readonly<{
      url?: string;
      organization?: string;
    }>,
  ) => Promise<FilesApi>;
  /** What this session may call, for `bakery tools`. */
  listSessionTools?: () => Promise<
    readonly { name: string; method: string; path: string; scope: string }[]
  >;
}>;

function single(parsed: Parsed, what: string): string {
  const [first, ...extra] = parsed.positionals;
  if (first === undefined) {
    throw new UsageError(`${parsed.command} needs ${what}.`);
  }
  if (extra.length > 0) {
    throw new UsageError(`${parsed.command} takes one ${what}.`);
  }
  return first;
}

/** Runs one command line; returns the exit code (0 done, 1 failed, 2 not understood). */
export async function run(
  argv: readonly string[],
  runtime: Runtime,
): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help || parsed.command === null) {
      runtime.output.text(HELP.trimEnd());
      return parsed.help ? 0 : 2;
    }
    const { options, command } = parsed;
    // `tools` answers before any transport is built: it is a question about the
    // credential, not a call made with it.
    if (command === "tools") {
      if (parsed.positionals.length > 0) {
        throw new UsageError("tools takes no arguments.");
      }
      if (
        runtime.inSession !== true || runtime.listSessionTools === undefined
      ) {
        throw new UsageError(
          "tools lists what a session may call; run it inside one.",
        );
      }
      const tools = await runtime.listSessionTools();
      if (options.json) {
        runtime.output.text(JSON.stringify(tools, null, 2));
        return 0;
      }
      if (tools.length === 0) {
        runtime.output.text("This session may call nothing yet.");
        return 0;
      }
      for (const tool of tools) {
        runtime.output.text(
          `${tool.name}  ${tool.method} ${tool.path}  (${tool.scope})`,
        );
      }
      return 0;
    }
    let api: FilesApi;
    if (runtime.inSession === true) {
      if (runtime.createSessionApi === undefined) {
        throw new UsageError(
          "This session has no tool gateway configured, so no command can run.",
        );
      }
      api = await runtime.createSessionApi(parsed.flags);
    } else {
      const config = await readConfig({
        environment: runtime.environment,
        flags: parsed.flags,
        readFileText: runtime.readFileText,
      });
      api = (runtime.createApi ?? ((c: CliConfig) => createFilesApi(c)))(
        config,
      );
    }
    switch (command) {
      case "ls": {
        if (parsed.positionals.length > 1) {
          throw new UsageError("ls takes one path.");
        }
        await ls(api, parsed.positionals[0], options, runtime.output);
        break;
      }
      case "stat":
        await stat(
          api,
          single(parsed, "path or version"),
          options,
          runtime.output,
        );
        break;
      case "history":
        await history(api, single(parsed, "file"), options, runtime.output);
        break;
      case "uses":
        await uses(api, single(parsed, "file"), options, runtime.output);
        break;
      case "cat":
        await cat(api, single(parsed, "file"), options, runtime.output);
        break;
      case "get":
        await get(api, single(parsed, "file"), options, runtime.output);
        break;
      case "open":
        await open(api, single(parsed, "version id"), options, runtime.output);
        break;
      case "pin":
      case "unpin":
        await setPin(
          api,
          single(parsed, "file"),
          command === "pin",
          options,
          runtime.output,
        );
        break;
      case "search": {
        if (parsed.positionals.length > 1) {
          throw new UsageError("search takes one piece of text.");
        }
        const text = parsed.positionals[0];
        const filter = {
          ...options.search,
          ...(text === undefined ? {} : { query: text }),
        };
        if (Object.keys(filter).length === 0) {
          throw new UsageError(
            "search needs some text, or --in, --kind or --type.",
          );
        }
        await search(api, { ...options, search: filter }, runtime.output);
        break;
      }
      default:
        throw new UsageError(`Unknown files command "${command}". Try --help.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      runtime.error(error.message);
      return 2;
    }
    if (error instanceof CommandError) {
      runtime.error(error.message);
      return 1;
    }
    if (error instanceof SessionRefusal) {
      // Two lines, because a refusal has two halves: what the server decided
      // and what the person or agent can do about it.
      runtime.error(error.message);
      runtime.error(error.advice);
      return 1;
    }
    if (error instanceof SessionFileMismatch) {
      runtime.error(error.message);
      return 1;
    }
    const described = describeFailure(error);
    if (described !== null) {
      runtime.error(described);
      return 1;
    }
    throw error;
  }
}
