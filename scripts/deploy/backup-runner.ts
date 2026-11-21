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
import { connect } from "./backup-runner/offsite.ts";
import {
  earliestBaseBackup,
  listSpool,
  shipWal,
  WAL_SPOOL,
  walUnbrokenSince,
} from "./backup-runner/wal.ts";

/** The operator's public age recipient, from the file backup.sh reads. */
const BACKUP_ENV = "/etc/bakery/backup.env";

async function backupRecipient(path: string): Promise<string> {
  const text = await Deno.readTextFile(path);
  const match = /^BAKERY_BACKUP_RECIPIENT=["']?([^"'\n]+)["']?\s*$/m.exec(text);
  if (!match) throw new Error("BAKERY_BACKUP_RECIPIENT is not set");
  return match[1];
}

/** age-encrypts one file to the recipient; the bytes never touch the disk. */
async function ageEncrypt(
  path: string,
  recipient: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const output = await new Deno.Command("age", {
    args: ["--encrypt", "--recipient", recipient, path],
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  if (!output.success) throw new Error("age could not encrypt a WAL file");
  return output.stdout;
}

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
  readonly walSpool?: string;
  readonly encryptWal?: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly backupEnv?: string;
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
    backup: (signal, cutoff, pointInTime) =>
      options.backup
        ? options.backup(signal, secrets, cutoff)
        : runBackupScript({
          script: BACKUP_SCRIPT,
          root,
          secrets,
          signal,
          cutoff,
          pointInTime,
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
  /**
   * Restore to any minute: one pass over the WAL spool, after the backup step.
   * The settings (an audited read) are asked for only when the spool holds
   * something. Returns true when the pass failed; the backup's own outcome is
   * already reported and stands.
   */
  const walPass = async (): Promise<boolean> => {
    const spool = options.walSpool ?? WAL_SPOOL;
    try {
      if ((await listSpool(spool)).length === 0) return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
    try {
      const settings = await api.settings();
      const enabled = settings.pointInTimeEnabled === true;
      const offsite = enabled
        ? offsiteFromSettings(settings, { allowLoopbackEndpoint: test })
        : null;
      const connection = offsite === null
        ? null
        : await connect(offsite, { resolve: options.resolve });
      const encrypt = options.encryptWal ?? (async (path, signal) =>
        ageEncrypt(
          path,
          await backupRecipient(options.backupEnv ?? BACKUP_ENV),
          signal,
        ));
      const shipped = await shipWal({
        spool,
        enabled,
        connection,
        encrypt,
        report: (window) => api.reportWal(window),
        earliestBaseBackupAt: await earliestBaseBackup(
          root,
          await walUnbrokenSince(spool),
        ),
      });
      if (shipped.shipped > 0) {
        log(`restore to any minute: shipped ${shipped.shipped} WAL file(s)`);
      }
      return false;
    } catch (error) {
      log(
        `restore to any minute: WAL shipping failed (${
          (error as Error)?.message ?? error
        }); the spool is kept for the next pass`,
      );
      return true;
    }
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
    const walFailed = await walPass();
    const code = exitCodeOf(outcome);
    return code === EXIT.ok && walFailed ? EXIT.failed : code;
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
