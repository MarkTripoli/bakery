import process from "node:process";
import {
  ApiFatal,
  ApiUnavailable,
  createRunnerApi,
  type DrillReport,
  type DrillReporter,
  type DrillView,
} from "./backup-runner/api.ts";
import { readRunnerConfig } from "./backup-runner/config.ts";
import {
  type DrillOptions,
  type DrillOutcome,
  runDrill,
} from "./backup-runner/drill.ts";
import { addSecret, createSecrets, redact } from "./backup-runner/redact.ts";

/**
 * Command line for the restore drill (issue #64 slice D), called by
 * restore-drill.sh.
 *
 *   restore-drill.ts <backup set directory> --identity <age identity file>
 *       --key-file <secrets key file> [--release-root <dir>]
 *       [--scratch-root <dir>] [--no-report]
 *
 * It restores the set into isolated, throwaway stores, checks it there, prints
 * one result line, and reports the result to the server with the backup
 * runner's credential (BAKERY_API_URL and BAKERY_BACKUP_RUNNER_TOKEN) unless
 * --no-report is given.
 *
 * Exit 0: the drill passed and was reported. Exit 1: the drill failed (and was
 * reported). Exit 3: the drill ran, but its result could not be reported.
 * Exit 64: bad arguments.
 */

export const EXIT = Object.freeze(
  { passed: 0, failed: 1, notReported: 3, usage: 64 } as const,
);

const DEFAULT_RELEASE_ROOT = "/opt/bakery/background";
const REPORT_ATTEMPTS = 3;
const REPORT_WAIT_MS = 2000;

export type CliOptions = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  readonly out?: (line: string) => void;
  /** Test seams. */
  readonly drill?: (options: DrillOptions) => Promise<DrillOutcome>;
  readonly api?: DrillReporter;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly fetch?: typeof fetch;
};

type Parsed = {
  directory: string;
  identityFile: string;
  keyFile?: string;
  releaseRoot: string;
  scratchRoot?: string;
  report: boolean;
};

function parse(args: readonly string[]): Parsed | string {
  let directory: string | undefined;
  let identityFile: string | undefined;
  let keyFile: string | undefined;
  let releaseRoot = DEFAULT_RELEASE_ROOT;
  let scratchRoot: string | undefined;
  let report = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      index += 1;
      return next;
    };
    if (arg === "--identity") identityFile = value();
    else if (arg === "--key-file") keyFile = value();
    else if (arg === "--release-root") releaseRoot = value() ?? "";
    else if (arg === "--scratch-root") scratchRoot = value() ?? "";
    else if (arg === "--no-report") report = false;
    else if (arg.startsWith("--")) return `unknown option ${arg}`;
    else if (directory === undefined) directory = arg;
    else return "only one backup set directory may be given";
  }
  if (directory === undefined) return "the backup set directory is required";
  if (!identityFile) return "--identity <age identity file> is required";
  if (releaseRoot === "") return "--release-root needs a directory";
  if (scratchRoot === "") return "--scratch-root needs a directory";
  return {
    directory,
    identityFile,
    releaseRoot,
    report,
    ...(keyFile === undefined ? {} : { keyFile }),
    ...(scratchRoot === undefined ? {} : { scratchRoot }),
  };
}

function summary(outcome: DrillOutcome): string {
  const age = outcome.rpoSeconds === null
    ? "unknown"
    : `${outcome.rpoSeconds}s`;
  const times = `rpo=${age} rto=${outcome.rtoSeconds}s`;
  if (outcome.outcome === "passed") {
    return `RESTORE_DRILL_PASSED backup=${outcome.backupName} ${times}`;
  }
  return `RESTORE_DRILL_FAILED backup=${outcome.backupName} code=${outcome.failureCode} check=${
    outcome.checksFailed[0]
  } ${times}: ${outcome.detail}`;
}

export async function main(
  args: readonly string[],
  options: CliOptions,
): Promise<number> {
  const secrets = createSecrets();
  const log = (line: string) =>
    (options.log ?? ((l) => console.error(l)))(redact(line, secrets, 2000));
  const out = options.out ?? ((line) => console.log(line));
  const parsed = parse(args);
  if (typeof parsed === "string") {
    log(`restore drill: ${parsed}`);
    return EXIT.usage;
  }
  // The credential is checked before the drill starts, so a drill is not run
  // for nothing when its result could not be sent.
  let api: DrillReporter | undefined = options.api;
  if (parsed.report && api === undefined) {
    const config = readRunnerConfig(options.env);
    if (typeof config === "string") {
      log(`restore drill: ${config} (or pass --no-report)`);
      return EXIT.usage;
    }
    addSecret(secrets, config.token);
    api = createRunnerApi({
      baseUrl: config.baseUrl,
      token: config.token,
      secrets,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  const outcome = await (options.drill ?? runDrill)({
    directory: parsed.directory,
    identityFile: parsed.identityFile,
    releaseRoot: parsed.releaseRoot,
    ...(parsed.keyFile === undefined ? {} : { keyFile: parsed.keyFile }),
    ...(parsed.scratchRoot === undefined
      ? {}
      : { scratchRoot: parsed.scratchRoot }),
  });
  out(summary(outcome));
  const code = outcome.outcome === "passed" ? EXIT.passed : EXIT.failed;
  if (!parsed.report || api === undefined) return code;

  const report: DrillReport = { drillId: crypto.randomUUID(), ...outcome };
  const sleep = options.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let kept: DrillView | null = null;
  for (let attempt = 1; kept === null; attempt += 1) {
    try {
      kept = await api.drill(report);
    } catch (error) {
      if (error instanceof ApiUnavailable && attempt < REPORT_ATTEMPTS) {
        // The id is ours, so sending the same report again cannot duplicate it.
        await sleep(REPORT_WAIT_MS);
        continue;
      }
      log(
        `restore drill: the result could not be reported (${
          error instanceof ApiFatal
            ? `the server refused it: ${error.message}`
            : "the server could not be reached"
        }); the drill itself ${outcome.outcome}`,
      );
      return EXIT.notReported;
    }
  }
  log(`restore drill: reported as ${kept.id}`);
  return code;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), { env: process.env }));
}
