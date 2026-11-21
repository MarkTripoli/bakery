import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { BackupImplementedAction } from "@bakery/contracts/implemented-actions";
import type { z } from "zod";
import { sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { isPostgresUniqueViolation } from "../../platform/postgres-errors.ts";
import {
  assertReportShape,
  BACKUP_LEASE_SECONDS,
  BackupRunStatus,
  backupStateWord,
  BackupTrigger,
  decideReport,
  type ReportBody,
  reportDigest,
} from "./state.ts";
import { isBackupDue, staleAfterMs } from "./schedule.ts";
import {
  extendMaintenance,
  type MaintenanceActor,
  readMaintenanceState,
  releaseMaintenance,
} from "./maintenance.ts";
import { readBackupSchedule } from "./settings.ts";

type Run = z.output<typeof contractSchemas.BackupRun>;
type Status = z.output<typeof contractSchemas.BackupStatus>;
type Claim = z.output<typeof contractSchemas.BackupRunClaim>;

type RunRow = {
  id: string;
  triggerKind: string;
  status: string;
  requestedByPrincipalId: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  leaseExpiresAt: Date | null;
  progressPercent: number | null;
  sizeBytes: string | null;
  locations: string[];
  failureCode: string | null;
  failureDetail: string | null;
  cursorRequestedAt: string;
};

/** The lease token hash, the sequence and the digest never leave this module. */
const RUN_COLUMNS = `id, trigger_kind as "triggerKind", status,
  requested_by_principal_id as "requestedByPrincipalId",
  requested_at as "requestedAt", claimed_at as "claimedAt",
  started_at as "startedAt", finished_at as "finishedAt",
  lease_expires_at as "leaseExpiresAt",
  progress_percent as "progressPercent", size_bytes::text as "sizeBytes",
  locations, failure_code as "failureCode",
  failure_detail as "failureDetail",
  to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorRequestedAt"`;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toBackupRun(row: RunRow): Run {
  return contractSchemas.BackupRun.parse({
    id: row.id,
    triggerKind: row.triggerKind,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    requestedByPrincipalId: row.requestedByPrincipalId,
    claimedAt: iso(row.claimedAt),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    leaseExpiresAt: iso(row.leaseExpiresAt),
    progressPercent: row.progressPercent,
    sizeBytes: row.sizeBytes,
    locations: row.locations ?? [],
    failureCode: row.failureCode,
    failureDetail: row.failureDetail,
  });
}

function conflict(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

/** backups.list: newest request first, keyset on (requested_at, id). */
export async function listBackupRuns(
  transaction: PgTransactionClient,
  principalId: string,
  input: { cursor?: string; limit?: number },
  secret: string,
) {
  const binding: CursorBinding = {
    action: BackupImplementedAction.BackupsList,
    principalId,
    ordering: "requestedAt:desc,id:desc",
    filters: "all",
    schemaVersion: 1,
  };
  const cursor = await decodeCursor(secret, input.cursor, binding);
  const limit = input.limit ?? 25;
  const result = await transaction.query<RunRow>(
    `select ${RUN_COLUMNS} from bakery.backup_runs
      where $1::timestamptz is null
         or (requested_at, id) < ($1::timestamptz, $2::uuid)
      order by requested_at desc, id desc limit $3`,
    [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return contractSchemas["Page<BackupRun>"].parse({
    items: page.map(toBackupRun),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursorRequestedAt,
        id: last.id,
      })
      : null,
  });
}

/** backups.status: one answer to "am I protected". */
export async function readBackupStatus(
  transaction: PgTransactionClient,
): Promise<Status> {
  const clock = await transaction.query<{ now: Date }>(
    `select clock_timestamp() as now`,
  );
  const now = clock.rows[0].now;
  const held = await transaction.query<{
    id: string;
    progressPercent: number | null;
    leaseExpiresAt: Date | null;
  }>(
    `select id, progress_percent as "progressPercent",
            lease_expires_at as "leaseExpiresAt"
       from bakery.backup_runs where status in ('claimed', 'running')`,
  );
  const waiting = await transaction.query<{ id: string }>(
    `select id from bakery.backup_runs where status = 'requested'`,
  );
  const newest = await transaction.query<
    { status: string; finishedAt: Date | null; failureCode: string | null }
  >(
    `select status, finished_at as "finishedAt", failure_code as "failureCode"
       from bakery.backup_runs
      where status in ('completed', 'failed')
      order by finished_at desc, id desc limit 1`,
  );
  const good = await transaction.query<{ finishedAt: Date | null }>(
    `select max(finished_at) as "finishedAt" from bakery.backup_runs
      where status = 'completed'`,
  );
  // The cutoff of the newest completed backup that recorded one.
  const cutoff = await transaction.query<{ cutoffAt: Date }>(
    `select c.cutoff_at as "cutoffAt"
       from bakery.backup_cutoffs c
       join bakery.backup_runs r on r.id = c.run_id
      where r.status = 'completed'
      order by r.finished_at desc, r.id desc limit 1`,
  );
  const credential = await transaction.query<{ lastUsedAt: Date | null }>(
    `select last_used_at as "lastUsedAt"
       from bakery.backup_runner_credentials where id = true`,
  );
  const maintenance = await readMaintenanceState(transaction);
  const heldRow = held.rows[0] ?? null;
  const lastGoodAt = good.rows[0]?.finishedAt ?? null;
  const state = backupStateWord({
    now,
    held: heldRow,
    newestFinishedStatus: (newest.rows[0]?.status as BackupRunStatus) ?? null,
    // Completed with a failure code is "taken, not copied off-site".
    newestFinishedNotCopied: newest.rows[0]?.status === "completed" &&
      newest.rows[0]?.failureCode != null,
    lastGoodAt,
    staleAfterMs: staleAfterMs(await readBackupSchedule(transaction)),
  });
  const live = heldRow !== null && heldRow.leaseExpiresAt !== null &&
    heldRow.leaseExpiresAt > now;
  return contractSchemas.BackupStatus.parse({
    state,
    lastGoodBackupAt: iso(lastGoodAt),
    lastBackupCutoffAt: iso(cutoff.rows[0]?.cutoffAt ?? null),
    lastAttemptAt: iso(newest.rows[0]?.finishedAt ?? null),
    runningRunId: live ? heldRow.id : null,
    runningProgressPercent: live ? heldRow.progressPercent : null,
    waitingRunId: waiting.rows[0]?.id ?? null,
    runnerConfigured: credential.rows.length === 1,
    runnerLastUsedAt: iso(credential.rows[0]?.lastUsedAt ?? null),
    maintenanceState: maintenance.state,
    maintenanceSince: iso(maintenance.since),
  });
}

/**
 * backups.start: records one waiting manual request. A second ask while one
 * waits returns that request (the unique index allows only one); asking while
 * another run is held queues exactly one more.
 */
export async function requestBackup(
  transaction: PgTransactionClient,
  principalId: string,
): Promise<{ run: Run; created: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await transaction.query<RunRow>(
      `insert into bakery.backup_runs
         (trigger_kind, status, requested_by_principal_id)
       values ($1, $2, $3)
       on conflict ((true)) where status = 'requested' do nothing
       returning ${RUN_COLUMNS}`,
      [BackupTrigger.Manual, BackupRunStatus.Requested, principalId],
    );
    if (inserted.rows[0]) {
      return { run: toBackupRun(inserted.rows[0]), created: true };
    }
    const waiting = await transaction.query<RunRow>(
      `select ${RUN_COLUMNS} from bakery.backup_runs
        where status = 'requested'`,
    );
    // The waiting request can be claimed between the insert and this read;
    // then the next insert queues a new one.
    if (waiting.rows[0]) {
      return { run: toBackupRun(waiting.rows[0]), created: false };
    }
  }
  throw conflict("backup_request_contended");
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/**
 * backupRunnerCredential.issue: issues or rotates the one runner credential.
 * Only its SHA-256 hash is stored; the old credential stops working at once.
 */
export async function issueRunnerCredential(
  transaction: PgTransactionClient,
  principalId: string,
): Promise<{ credential: string; generation: number; issuedAt: Date }> {
  const credential = randomSecret();
  const tokenHash = await sha256Hex(credential);
  const result = await transaction.query<
    { generation: number; issuedAt: Date }
  >(
    `insert into bakery.backup_runner_credentials
       (id, token_hash, generation, issued_by_principal_id, issued_at)
     values (true, $1, 1, $2, now())
     on conflict (id) do update
        set token_hash = excluded.token_hash,
            generation = bakery.backup_runner_credentials.generation + 1,
            issued_by_principal_id = excluded.issued_by_principal_id,
            issued_at = excluded.issued_at,
            last_used_at = null
     returning generation, issued_at as "issuedAt"`,
    [tokenHash, principalId],
  );
  return { credential, ...result.rows[0] };
}

function readBearer(headers: Headers): string {
  const value = headers.get("authorization");
  if (!value) throw new StandardError({ code: "AUTH_REQUIRED" });
  const match = /^Bearer ([^\s]+)$/.exec(value);
  if (!match) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  return match[1];
}

/** Proves the caller holds the runner credential and records its last use. */
export async function authenticateRunner(
  transaction: PgTransactionClient,
  headers: Headers,
): Promise<{ readonly generation: number }> {
  const tokenHash = await sha256Hex(readBearer(headers));
  const result = await transaction.query<{ generation: number }>(
    `update bakery.backup_runner_credentials
        set last_used_at = now()
      where id = true and token_hash = $1
      returning generation`,
    [tokenHash],
  );
  if (result.rowCount !== 1) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return { generation: result.rows[0].generation };
}

/**
 * With no server-side scheduler, the runner's own poll is the clock: a claim
 * that finds nothing waiting asks `isBackupDue` and, when a scheduled backup is
 * due, records it as a waiting request in the same transaction. The one-waiting
 * unique index keeps it single when two claims race; the loser's insert does
 * nothing. Returns whether a due schedule was acted on.
 */
async function materializeScheduledRun(
  transaction: PgTransactionClient,
): Promise<boolean> {
  const schedule = await readBackupSchedule(transaction);
  if (schedule === null || !schedule.enabled) return false;
  const clock = await transaction.query<{ now: Date; newest: Date | null }>(
    `select clock_timestamp() as now,
            (select max(requested_at) from bakery.backup_runs) as newest`,
  );
  const { now, newest } = clock.rows[0];
  if (!isBackupDue(schedule, now, newest)) return false;
  await transaction.query(
    `insert into bakery.backup_runs
       (trigger_kind, status, requested_by_principal_id, requested_at)
     values ('scheduled', 'requested', null, clock_timestamp())
     on conflict ((true)) where status = 'requested' do nothing`,
  );
  return true;
}

/**
 * backupRunner.claim: hands the runner the one run it may work on, with a new
 * lease. A live claim elsewhere means nothing to do; a lapsed claim is taken
 * over, which resets its report sequence so the old holder's late reports are
 * refused (its lease token no longer matches). One backup at a time is held by
 * the unique indexes in 0277, not by a trigger.
 */
export async function claimRun(
  transaction: PgTransactionClient,
): Promise<Claim> {
  const leaseToken = randomSecret();
  const leaseHash = await sha256Hex(leaseToken);
  const held = await transaction.query<{ id: string; live: boolean }>(
    `select id, (lease_expires_at > clock_timestamp()) as live
       from bakery.backup_runs
      where status in ('claimed', 'running') for update`,
  );
  let target: string | undefined;
  let reclaim = false;
  if (held.rows[0]) {
    if (held.rows[0].live) return nothingToClaim();
    target = held.rows[0].id;
    reclaim = true;
  } else {
    const selectWaiting = () =>
      transaction.query<{ id: string }>(
        `select id from bakery.backup_runs
          where status = 'requested'
          order by requested_at, id limit 1 for update`,
      );
    let waiting = await selectWaiting();
    if (
      waiting.rows[0] === undefined &&
      await materializeScheduledRun(transaction)
    ) {
      // Nothing was waiting and a scheduled backup is due: it is the run to
      // take. (A concurrent claim that inserted it first is found the same way.)
      waiting = await selectWaiting();
    }
    target = waiting.rows[0]?.id;
  }
  if (target === undefined) return nothingToClaim();
  let updated;
  try {
    updated = await transaction.query<
      { id: string; triggerKind: string; leaseExpiresAt: Date }
    >(
      `update bakery.backup_runs
          set status = 'claimed', claimed_at = clock_timestamp(),
              lease_token_hash = $2,
              lease_expires_at = clock_timestamp() + make_interval(secs => $3),
              ${
        reclaim
          ? `started_at = null, progress_percent = null, report_sequence = 0,
              last_report_digest = null,`
          : ""
      }
              version = version + 1
        where id = $1
        returning id, trigger_kind as "triggerKind",
                  lease_expires_at as "leaseExpiresAt"`,
      [target, leaseHash, BACKUP_LEASE_SECONDS],
    );
  } catch (error) {
    // Another claim took the one active slot first.
    if (isPostgresUniqueViolation(error)) throw conflict("backup_in_progress");
    throw error;
  }
  const row = updated.rows[0];
  return contractSchemas.BackupRunClaim.parse({
    claimed: true,
    runId: row.id,
    leaseToken,
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    triggerKind: row.triggerKind,
  });
}

function nothingToClaim(): Claim {
  return contractSchemas.BackupRunClaim.parse({
    claimed: false,
    runId: null,
    leaseToken: null,
    leaseExpiresAt: null,
    triggerKind: null,
  });
}

type ReportRow = {
  id: string;
  status: string;
  reportSequence: number;
  lastReportDigest: string | null;
  progressPercent: number | null;
  leaseExpiresAt: Date | null;
  leaseTokenHash: string | null;
  dbNow: Date;
};

/**
 * backupRunner.report: applies one report under the run's row lock. The lease
 * token is checked first (a wrong one is forbidden), then the sequence and
 * lease rules in `decideReport`. A replay answers from the stored row.
 */
export async function reportRun(
  transaction: PgTransactionClient,
  runId: string,
  report: ReportBody & { readonly leaseToken: string },
  actor: MaintenanceActor,
): Promise<Run> {
  const found = await transaction.query<ReportRow>(
    `select id, status, report_sequence as "reportSequence",
            last_report_digest as "lastReportDigest",
            progress_percent as "progressPercent",
            lease_expires_at as "leaseExpiresAt",
            lease_token_hash as "leaseTokenHash",
            clock_timestamp() as "dbNow"
       from bakery.backup_runs where id = $1 for update`,
    [runId],
  );
  const row = found.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (
    row.leaseTokenHash === null ||
    row.leaseTokenHash !== await sha256Hex(report.leaseToken)
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  assertReportShape(report);
  const digest = await reportDigest(report);
  const decision = decideReport(
    {
      status: row.status as BackupRunStatus,
      reportSequence: row.reportSequence,
      lastReportDigest: row.lastReportDigest,
      progressPercent: row.progressPercent,
      leaseExpiresAt: row.leaseExpiresAt,
    },
    report,
    digest,
    row.dbNow,
  );
  if (decision.kind === "apply") {
    await applyReport(transaction, runId, report, digest);
    // The installation hold follows the run: a running report extends it with
    // the claim, a terminal report (completed, failed, a drain timeout) lets go.
    if (report.status === "running") {
      await extendMaintenance(transaction, runId);
    } else {
      await releaseMaintenance(
        transaction,
        runId,
        report.status,
        actor,
        report.failureCode ?? null,
      );
    }
  }
  const current = await transaction.query<RunRow>(
    `select ${RUN_COLUMNS} from bakery.backup_runs where id = $1`,
    [runId],
  );
  return toBackupRun(current.rows[0]);
}

async function applyReport(
  transaction: PgTransactionClient,
  runId: string,
  report: ReportBody,
  digest: string,
): Promise<void> {
  if (report.status === "running") {
    await transaction.query(
      `update bakery.backup_runs
          set status = 'running', started_at = coalesce(started_at, clock_timestamp()),
              progress_percent = coalesce($2::integer, progress_percent),
              lease_expires_at = clock_timestamp() + make_interval(secs => $3),
              report_sequence = $4, last_report_digest = $5, version = version + 1
        where id = $1`,
      [
        runId,
        report.progressPercent ?? null,
        BACKUP_LEASE_SECONDS,
        report.sequence,
        digest,
      ],
    );
    return;
  }
  if (report.status === "completed") {
    await transaction.query(
      `update bakery.backup_runs
          set status = 'completed', started_at = coalesce(started_at, clock_timestamp()),
              finished_at = clock_timestamp(), progress_percent = 100,
              size_bytes = $2::bigint, locations = $3::text[],
              lease_expires_at = null,
              failure_code = $6, failure_detail = $7,
              report_sequence = $4, last_report_digest = $5, version = version + 1
        where id = $1`,
      [
        runId,
        report.sizeBytes,
        report.locations,
        report.sequence,
        digest,
        // Only a backup taken but not copied off-site carries a cause.
        report.failureCode ?? null,
        report.failureCode === undefined ? null : report.failureDetail ?? null,
      ],
    );
    return;
  }
  await transaction.query(
    `update bakery.backup_runs
        set status = 'failed', finished_at = clock_timestamp(),
            failure_code = $2, failure_detail = $3, lease_expires_at = null,
            report_sequence = $4, last_report_digest = $5, version = version + 1
      where id = $1`,
    [
      runId,
      report.failureCode,
      report.failureDetail ?? null,
      report.sequence,
      digest,
    ],
  );
}
