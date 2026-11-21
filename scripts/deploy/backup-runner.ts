import { readRunnerConfig } from "./backup-runner/config.ts";
import type { Cutoff } from "../../apps/server/src/modules/backups/cutoff-rules.ts";
import {
  ApiFatal,
  ApiUnavailable,
  createRunnerApi,
  defaultSleep,
  type RunnerApi,
} from "./backup-runner/api.ts";
import {
  type Artifact,
  BACKUP_SCRIPT,
  BACKUPS_ROOT,
  runBackupScript,
} from "./backup-runner/backup-step.ts";
import {
  type Offsite,
  offsiteFromSettings,
  pruneLocal,
  pruneOffsite,
  uploadSet,
} from "./backup-runner/offsite.ts";
import {
  addSecret,
  createSecrets,
  redact,
  type Secrets,
} from "./backup-runner/redact.ts";
import {
  type RunnerDeps,
  runOnce,
  type RunOutcome,
} from "./backup-runner/run.ts";
import type { HostResolver } from "../../apps/server/src/modules/backups/dns.ts";

/**
 * The host backup runner (issue #80, slice S1c): one pass per invocation, run
 * every minute by bakery-backup-runner.timer. It claims a backup run from the
 * Bakery API with its own credential, takes the backup with the existing
 * backup.sh, optionally copies it off-site, and reports. The server never sees
 * backup bytes or an age key: only the PUBLIC recipient in /etc/bakery/backup.env
 * is used, by backup.sh.
 *
 * Exit codes: 0 nothing to do or backed up; 1 the backup failed, or it was taken
 * but NOT copied off-site (reported either way, so the unit shows in
 * `systemctl --failed`); 2 the lease was lost; 3 the server could not be reached
 * or refused the runner.
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  notCopied: 1,
  leaseLost: 2,
  unreachable: 3,
  usage: 64,
} as const;

export type RunnerOptions = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  /** Test seams. Production passes none of them. */
  readonly backup?: (
    signal: AbortSignal,
    secrets: Secrets,
    cutoff: Cutoff,
  ) => Promise<Artifact>;
  readonly resolve?: HostResolver;
  readonly sleep?: RunnerDeps["sleep"];
  readonly fetch?: typeof fetch;
  readonly backupsRoot?: string;
  readonly now?: () => Date;
  readonly partBytes?: number;
  readonly heartbeatMs?: number;
};

export function exitCodeOf(outcome: RunOutcome): number {
  switch (outcome.kind) {
    case "idle":
    case "completed":
      return EXIT.ok;
    case "failed":
      return EXIT.failed;
    case "not-copied":
      return EXIT.notCopied;
    case "lease-lost":
      return EXIT.leaseLost;
    case "undelivered":
      return EXIT.unreachable;
  }
}

/** Runs one pass with real collaborators (or the test seams) and returns the exit code. */
export async function runRunner(options: RunnerOptions): Promise<number> {
  const secrets = createSecrets();
  const log = (line: string) =>
    (options.log ?? ((l) => console.error(l)))(redact(line, secrets, 2000));
  const config = readRunnerConfig(options.env);
  if (typeof config === "string") {
    log(`backup runner: ${config}`);
    return EXIT.usage;
  }
  addSecret(secrets, config.token);
  const test = options.env.BAKERY_ENV === "test";
  const root = options.backupsRoot ?? BACKUPS_ROOT;
  const now = options.now ?? (() => new Date());
  const api: RunnerApi = createRunnerApi({
    baseUrl: config.baseUrl,
    token: config.token,
    secrets,
    fetch: options.fetch,
    sleep: options.sleep,
  });
  const deps: RunnerDeps = {
    api,
    secrets,
    backup: (signal, cutoff) =>
      options.backup
        ? options.backup(signal, secrets, cutoff)
        : runBackupScript({
          script: BACKUP_SCRIPT,
          root,
          secrets,
          signal,
          cutoff,
        }),
    offsite: (settings) =>
      offsiteFromSettings(settings, { allowLoopbackEndpoint: test }),
    upload: (offsite: Offsite, artifact, signal, onFile) =>
      uploadSet({
        offsite,
        artifact,
        secrets,
        signal,
        resolve: options.resolve,
        partBytes: options.partBytes,
        onFile,
      }),
    prune: async (settings, offsite, artifact) => {
      const keep = {
        artifactName: artifact.name,
        daysToKeep: settings.daysToKeep,
        now: now(),
      };
      const local = await pruneLocal({ root, ...keep });
      if (local.length > 0) {
        log(`retention removed ${local.length} local backup(s)`);
      }
      if (offsite !== null) {
        const remote = await pruneOffsite({
          offsite,
          resolve: options.resolve,
          ...keep,
        });
        if (remote.length > 0) {
          log(`retention removed ${remote.length} off-site backup(s)`);
        }
      }
    },
    sleep: options.sleep ?? defaultSleep,
    log,
    heartbeatMs: options.heartbeatMs,
  };
  try {
    const outcome = await runOnce(deps);
    if (outcome.kind === "lease-lost") {
      log(
        `backup run ${outcome.runId}: the server no longer accepts its reports (${outcome.reason})`,
      );
    } else if (outcome.kind === "undelivered") {
      log(
        `backup run ${outcome.runId}: the runner could not report to the server`,
      );
    }
    return exitCodeOf(outcome);
  } catch (error) {
    if (error instanceof ApiFatal) {
      log(
        `backup runner: the server refused the runner (${error.status} ${error.code})`,
      );
    } else if (error instanceof ApiUnavailable) {
      log("backup runner: the server could not be reached");
    } else {
      log(
        `backup runner: unexpected error ${(error as Error)?.message ?? error}`,
      );
    }
    return EXIT.unreachable;
  }
}

if (import.meta.main) {
  Deno.exit(await runRunner({ env: Deno.env.toObject() }));
}
