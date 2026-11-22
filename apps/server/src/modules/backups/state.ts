import { StandardError, unprocessable } from "@bakery/contracts/http";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";

/**
 * Backup run state, kept in TypeScript on purpose: the PostgreSQL boundary
 * allows no CHECK constraint, trigger or routine, so every rule about which
 * report is allowed when lives in these small pure functions.
 */

export const BackupRunStatus = Object.freeze(
  {
    Requested: "requested",
    Claimed: "claimed",
    Running: "running",
    Completed: "completed",
    Failed: "failed",
  } as const,
);
export type BackupRunStatus =
  (typeof BackupRunStatus)[keyof typeof BackupRunStatus];

export const BackupTrigger = Object.freeze(
  { Manual: "manual", Scheduled: "scheduled" } as const,
);
export type BackupTrigger = (typeof BackupTrigger)[keyof typeof BackupTrigger];

export const BackupLocation = Object.freeze(
  { ServerHost: "server-host", OffSite: "off-site" } as const,
);
const LOCATIONS: ReadonlySet<string> = new Set(Object.values(BackupLocation));

/** Stable failure causes a runner may report. */
export const BackupFailureCode = Object.freeze(
  {
    DiskFull: "disk_full",
    DestinationRefused: "destination_refused",
    DestinationUnreachable: "destination_unreachable",
    KeyMissing: "key_missing",
    IncompleteSet: "incomplete_set",
    DrainTimeout: "drain_timeout",
    RunnerError: "runner_error",
  } as const,
);

/**
 * The only causes a COMPLETED report may carry: the backup was taken on the host
 * and its off-site copy failed. Every other failure ends the run as `failed`.
 */
export const NOT_COPIED_CODES: ReadonlySet<string> = new Set([
  BackupFailureCode.DestinationRefused,
  BackupFailureCode.DestinationUnreachable,
]);

/**
 * How long a claim lasts; every running report extends it by this much.
 *
 * A claim is not idempotent: if the runner's claim answer is lost, the runner
 * asks again and is told there is nothing to claim until this lease lapses,
 * then the lapsed claim is taken over (its report sequence restarts). A runner
 * therefore polls rather than assuming one failed claim means no work, and an
 * operator should expect up to this long between a lost answer and the retry
 * being served.
 */
export const BACKUP_LEASE_SECONDS = 300;
/** Without a schedule, a backup older than this is "stale". */
export const BACKUP_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type ReportStatus = "running" | "completed" | "failed";
export type ReportBody = {
  readonly sequence: number;
  readonly status: ReportStatus;
  readonly progressPercent?: number;
  readonly sizeBytes?: string;
  readonly locations?: readonly string[];
  readonly failureCode?: string;
  readonly failureDetail?: string;
};

const BIGINT_MAX = 9223372036854775807n;

/**
 * Shape rules the wire schema cannot express: which figures each status needs
 * and refuses. Anything outside them is 422, so a report can never smuggle an
 * unrelated field in through the one status that allows it.
 */
export function assertReportShape(report: ReportBody): void {
  const has = {
    progress: report.progressPercent !== undefined,
    size: report.sizeBytes !== undefined,
    locations: report.locations !== undefined,
    code: report.failureCode !== undefined,
    detail: report.failureDetail !== undefined,
  };
  if (report.status === "running") {
    for (const [field, present] of Object.entries(has)) {
      if (field !== "progress" && present) {
        throw unprocessable([fieldName(field)], "not_allowed_while_running");
      }
    }
    return;
  }
  if (report.status === "completed") {
    if (!has.size) throw unprocessable(["sizeBytes"], "required");
    if (!has.locations || report.locations!.length === 0) {
      throw unprocessable(["locations"], "required");
    }
    if (
      !/^[0-9]+$/.test(report.sizeBytes!) ||
      BigInt(report.sizeBytes!) > BIGINT_MAX
    ) {
      throw unprocessable(["sizeBytes"], "invalid_size");
    }
    const seen = new Set<string>();
    for (const [index, location] of report.locations!.entries()) {
      if (!LOCATIONS.has(location) || seen.has(location)) {
        throw unprocessable(["locations", index], "invalid_location");
      }
      seen.add(location);
    }
    if (has.detail && !has.code) {
      throw unprocessable(["failureDetail"], "needs_failure_code");
    }
    if (has.code) {
      // "Taken, not copied off-site": the backup exists on the host and only the
      // off-site copy failed. It names that and nothing else.
      if (!NOT_COPIED_CODES.has(report.failureCode!)) {
        throw unprocessable(["failureCode"], "not_allowed_when_completed");
      }
      if (seen.has(BackupLocation.OffSite)) {
        throw unprocessable(
          ["failureCode"],
          "not_allowed_when_copied_off_site",
        );
      }
      if (
        report.locations!.length !== 1 || !seen.has(BackupLocation.ServerHost)
      ) {
        throw unprocessable(["locations"], "must_be_server_host_only");
      }
    }
    return;
  }
  if (!has.code) throw unprocessable(["failureCode"], "required");
  if (has.size) throw unprocessable(["sizeBytes"], "not_allowed");
  if (has.locations) throw unprocessable(["locations"], "not_allowed");
  if (has.progress) throw unprocessable(["progressPercent"], "not_allowed");
}

function fieldName(key: string): string {
  return ({
    progress: "progressPercent",
    size: "sizeBytes",
    locations: "locations",
    code: "failureCode",
    detail: "failureDetail",
  } as Record<string, string>)[key] ?? key;
}

/** Digest of the report body without the lease token: replay vs. a changed body. */
export function reportDigest(report: ReportBody): Promise<string> {
  return sha256Hex(canonicalJson({
    sequence: report.sequence,
    status: report.status,
    progressPercent: report.progressPercent ?? null,
    sizeBytes: report.sizeBytes ?? null,
    locations: report.locations ?? null,
    failureCode: report.failureCode ?? null,
    failureDetail: report.failureDetail ?? null,
  }));
}

export type RunSnapshot = {
  readonly status: BackupRunStatus;
  readonly reportSequence: number;
  readonly lastReportDigest: string | null;
  readonly progressPercent: number | null;
  readonly leaseExpiresAt: Date | null;
};

export type ReportDecision =
  | { readonly kind: "replay" }
  | { readonly kind: "apply" };

const TERMINAL: ReadonlySet<string> = new Set([
  BackupRunStatus.Completed,
  BackupRunStatus.Failed,
]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

function conflict(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

/**
 * Decides what a report does to a run whose lease token already matched.
 * - the stored sequence again with the identical body replays the stored row
 *   (also after the run has finished, so a lost final answer can be asked for
 *   again);
 * - the stored sequence with another body is IDEMPOTENCY_PAYLOAD_MISMATCH;
 * - only the next sequence applies; a gap or an older number is a conflict;
 * - a finished run takes no new report, and a lapsed lease takes none either.
 */
export function decideReport(
  run: RunSnapshot,
  report: ReportBody,
  digest: string,
  now: Date,
): ReportDecision {
  if (report.sequence === run.reportSequence) {
    if (run.lastReportDigest === digest) return { kind: "replay" };
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  if (report.sequence < run.reportSequence) {
    throw conflict("sequence_regression");
  }
  if (report.sequence !== run.reportSequence + 1) {
    throw conflict("sequence_gap");
  }
  if (isTerminal(run.status)) throw conflict("run_finished");
  if (
    run.status !== BackupRunStatus.Claimed &&
    run.status !== BackupRunStatus.Running
  ) {
    throw conflict("run_not_claimed");
  }
  if (run.leaseExpiresAt === null || run.leaseExpiresAt <= now) {
    throw conflict("lease_expired");
  }
  if (
    report.progressPercent !== undefined && run.progressPercent !== null &&
    report.progressPercent < run.progressPercent
  ) {
    throw unprocessable(["progressPercent"], "progress_went_back");
  }
  return { kind: "apply" };
}

export type BackupStateWord =
  | "protected"
  | "running"
  | "not_copied"
  | "stale"
  | "failed";

/**
 * The one answer to "am I protected". A held run with a live lease is
 * `running`; a held run whose lease lapsed means the runner stopped reporting,
 * which is `failed`; otherwise the newest finished attempt decides: `failed`,
 * or `not_copied` when it was taken on the host but its off-site copy failed (a
 * later good full backup is the newest and so replaces it), then age. Age wins
 * over `not_copied`: past the stale threshold the word is `stale`.
 */
export function backupStateWord(input: {
  readonly now: Date;
  readonly held: { readonly leaseExpiresAt: Date | null } | null;
  readonly newestFinishedStatus: BackupRunStatus | null;
  /** The newest finished attempt completed on the host but its off-site copy failed. */
  readonly newestFinishedNotCopied?: boolean;
  readonly lastGoodAt: Date | null;
  /**
   * How old the newest good backup may be: twice the schedule interval when a
   * schedule is on (`staleAfterMs` in schedule.ts), else the seven-day default.
   */
  readonly staleAfterMs?: number;
}): BackupStateWord {
  if (input.held) {
    return input.held.leaseExpiresAt !== null &&
        input.held.leaseExpiresAt > input.now
      ? "running"
      : "failed";
  }
  if (input.newestFinishedStatus === BackupRunStatus.Failed) return "failed";
  const fresh = input.lastGoodAt !== null &&
    input.now.getTime() - input.lastGoodAt.getTime() <=
      (input.staleAfterMs ?? BACKUP_STALE_AFTER_MS);
  // `stale` beats `not_copied`: a backup that old and kept only on the host is
  // the bigger risk, so once the last good one passes the threshold the answer
  // is "stale", not the milder "not copied".
  if (
    input.newestFinishedStatus === BackupRunStatus.Completed &&
    input.newestFinishedNotCopied === true &&
    fresh
  ) return "not_copied";
  return fresh ? "protected" : "stale";
}
