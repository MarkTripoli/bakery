import { createFilesApi, describeFailure, type FilesApi } from "./api.ts";
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
  if (group !== undefined && group !== "files") {
    throw new UsageError(`Unknown command "${group}". Try --help.`);
  }
  return {
    command: command ?? null,
    positionals: rest,
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
    const config = await readConfig({
      environment: runtime.environment,
      flags: parsed.flags,
      readFileText: runtime.readFileText,
    });
    const api = (runtime.createApi ?? ((c: CliConfig) => createFilesApi(c)))(
      config,
    );
    const { options, command } = parsed;
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
    const described = describeFailure(error);
    if (described !== null) {
      runtime.error(described);
      return 1;
    }
    throw error;
  }
}
