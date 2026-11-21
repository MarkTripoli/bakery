import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { z } from "zod";
import { sha256Hex } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  drainDecision,
  type DrainObservation,
  effectiveMaintenanceState,
  maintenanceIsActive,
  MaintenanceState,
} from "../../platform/maintenance.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { BackupRunStatus } from "./state.ts";

/**
 * The host runner's side of the installation maintenance switch (issue #64
 * slice B). The runner holds the switch for the one backup run it has claimed,
 * waits for the installation to go quiet, takes the snapshot, and a terminal
 * report of that run lets go. Only the runner credential reaches these
 * functions (the route authenticates first), and only for the run whose lease
 * token it presents.
 *
 * The switch is lease-bound (see platform/maintenance.ts): its lease follows
 * the run's, every running report extends it, and a lapse returns the
 * installation to normal with no action from anyone.
 */

type View = z.output<typeof contractSchemas.BackupMaintenance>;

/** The audit rows' reason and operation words. */
export const MAINTENANCE_REASON_BACKUP = "backup";
export const MAINTENANCE_ENTER_OPERATION = "backupRunner.maintenance.enter";
export const MAINTENANCE_EXIT_OPERATION = "backupRunner.maintenance.exit";
/** The runner has no principal: its audit identity is its credential. */
const RUNNER_RESOURCE_TYPE = "backup_runner_credential";
const RUNNER_RESOURCE_ID = "backup-runner";

/** Who is acting, for the audit rows: the runner credential and the request. */
export type MaintenanceActor = {
  readonly generation: number;
  readonly requestId: string;
  readonly traceId: string;
};

type SwitchRow = {
  state: string;
  reason: string;
  ownerRunId: string | null;
  enteredAt: Date;
  leaseExpiresAt: Date;
};

const SWITCH_COLUMNS = `state, reason, owner_run_id as "ownerRunId",
  entered_at as "enteredAt", lease_expires_at as "leaseExpiresAt"`;

export function conflict(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

export async function audit(
  transaction: PgTransactionClient,
  actor: MaintenanceActor,
  operation: string,
  runId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await recordAuthAudit(
    transaction,
    { requestId: actor.requestId, traceId: actor.traceId },
    {
      organizationId: null,
      principalId: null,
      operation,
      resourceType: RUNNER_RESOURCE_TYPE,
      resourceId: RUNNER_RESOURCE_ID,
      // Identifiers, words and counts only: never a token, a key or a secret.
      details: {
        runId,
        reason: MAINTENANCE_REASON_BACKUP,
        generation: actor.generation,
        ...details,
      },
    },
  );
}

/** What the drain check can see: live attempts and open transactions. */
export async function observeDrain(
  transaction: PgTransactionClient,
  enteredAt: Date,
): Promise<DrainObservation> {
  const attempts = await transaction.query<{ live: number }>(
    `select count(*)::integer as live from bakery.job_attempts
      where status in ('leased', 'running', 'canceling')
        and lease_expires_at > clock_timestamp()`,
  );
  // Open transactions of the server's own role that began before the switch was
  // set: a write the guard may have let through just before. The caller's own
  // session is left out. Other roles' sessions cannot be seen from here.
  const open = await transaction.query<{ open: number }>(
    `select count(*)::integer as open from pg_stat_activity
      where datname = current_database() and usename = current_user
        and pid <> pg_backend_pid() and xact_start is not null
        and xact_start < $1`,
    [enteredAt],
  );
  return {
    liveAttempts: attempts.rows[0]?.live ?? 0,
    openTransactions: open.rows[0]?.open ?? 0,
  };
}

type RunLease = {
  status: string;
  leaseTokenHash: string | null;
  leaseExpiresAt: Date | null;
  dbNow: Date;
};

export async function lockClaimedRun(
  transaction: PgTransactionClient,
  runId: string,
  leaseToken: string,
): Promise<{ leaseExpiresAt: Date; dbNow: Date }> {
  const found = await transaction.query<RunLease>(
    `select status, lease_token_hash as "leaseTokenHash",
            lease_expires_at as "leaseExpiresAt",
            clock_timestamp() as "dbNow"
       from bakery.backup_runs where id = $1 for update`,
    [runId],
  );
  const row = found.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (
    row.leaseTokenHash === null ||
    row.leaseTokenHash !== await sha256Hex(leaseToken)
  ) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  if (
    row.status !== BackupRunStatus.Claimed &&
    row.status !== BackupRunStatus.Running
  ) throw conflict("run_not_claimed");
  if (row.leaseExpiresAt === null || row.leaseExpiresAt <= row.dbNow) {
    throw conflict("lease_expired");
  }
  return { leaseExpiresAt: row.leaseExpiresAt, dbNow: row.dbNow };
}

/**
 * backupRunner.maintain: holds the installation for the claimed run and says
 * whether it is quiet yet. The first call enters maintenance (state `draining`:
 * new work is refused from this moment); each later call re-checks the drain
 * and, once nothing the check can see is left and the settle window has passed,
 * moves it to `quiesced`. Calling again while held is safe and changes nothing
 * but the answer. A different run cannot take it while another holds it.
 */
export async function maintainRun(
  transaction: PgTransactionClient,
  runId: string,
  leaseToken: string,
  actor: MaintenanceActor,
): Promise<View> {
  const run = await lockClaimedRun(transaction, runId, leaseToken);
  const found = await transaction.query<SwitchRow>(
    `select ${SWITCH_COLUMNS} from bakery.installation_maintenance
      where id = true for update`,
  );
  let row: SwitchRow | undefined = found.rows[0];
  const active = row !== undefined && maintenanceIsActive(row, run.dbNow);
  if (active && row!.ownerRunId !== runId) throw conflict("maintenance_held");

  if (!active) {
    // A hold whose lease lapsed is already off; say so once, here, the next
    // time anyone enters, because nothing else runs when a lease lapses.
    if (row !== undefined && row.state !== MaintenanceState.Off) {
      await audit(
        transaction,
        actor,
        MAINTENANCE_EXIT_OPERATION,
        row.ownerRunId,
        {
          outcome: "lease_expired",
          state: row.state,
        },
      );
    }
    const entered = await transaction.query<SwitchRow>(
      `insert into bakery.installation_maintenance
         (id, state, reason, owner_run_id, entered_at, lease_expires_at)
       values (true, 'draining', $1, $2, clock_timestamp(),
               (select lease_expires_at from bakery.backup_runs where id = $2))
       on conflict (id) do update
         set state = 'draining', reason = excluded.reason,
             owner_run_id = excluded.owner_run_id,
             entered_at = excluded.entered_at,
             lease_expires_at = excluded.lease_expires_at,
             version = bakery.installation_maintenance.version + 1
       returning ${SWITCH_COLUMNS}`,
      [MAINTENANCE_REASON_BACKUP, runId],
    );
    row = entered.rows[0];
    await audit(transaction, actor, MAINTENANCE_ENTER_OPERATION, runId, {
      state: MaintenanceState.Draining,
    });
  } else if (row!.leaseExpiresAt < run.leaseExpiresAt) {
    // The hold's lease follows the run's.
    const extended = await transaction.query<SwitchRow>(
      `update bakery.installation_maintenance
          set lease_expires_at = (select lease_expires_at
                                    from bakery.backup_runs where id = $1),
              version = version + 1
        where id = true returning ${SWITCH_COLUMNS}`,
      [runId],
    );
    row = extended.rows[0];
  }
  const held = row!;

  let observation: DrainObservation = { liveAttempts: 0, openTransactions: 0 };
  let state: string = held.state;
  let retryAfterSeconds = 0;
  if (held.state === MaintenanceState.Draining) {
    observation = await observeDrain(transaction, held.enteredAt);
    const decision = drainDecision({
      enteredAt: held.enteredAt,
      now: run.dbNow,
      observation,
    });
    if (decision.drained) {
      await transaction.query(
        `update bakery.installation_maintenance
            set state = 'quiesced', version = version + 1 where id = true`,
      );
      state = MaintenanceState.Quiesced;
    } else {
      retryAfterSeconds = decision.waitSeconds;
    }
  }
  return contractSchemas.BackupMaintenance.parse({
    state,
    runId,
    leaseExpiresAt: held.leaseExpiresAt.toISOString(),
    liveAttempts: observation.liveAttempts,
    openTransactions: observation.openTransactions,
    retryAfterSeconds,
  });
}

/**
 * Every running report of the owning run extends the hold with the claim, so
 * the two lapse together. A hold whose lease has already lapsed is NOT revived:
 * a late report must not put an installation that went back to normal under
 * maintenance again.
 */
export async function extendMaintenance(
  transaction: PgTransactionClient,
  runId: string,
): Promise<void> {
  await transaction.query(
    `update bakery.installation_maintenance
        set lease_expires_at = (select lease_expires_at
                                  from bakery.backup_runs where id = $1),
            version = version + 1
      where id = true and owner_run_id = $1 and state <> 'off'
        and lease_expires_at > clock_timestamp()`,
    [runId],
  );
}

/**
 * A terminal report of the owning run lets go, whether the backup completed or
 * failed (a drain timeout included). Does nothing when this run does not hold
 * it, so a run that never entered maintenance, or whose hold already lapsed and
 * was audited, writes no second exit row.
 */
export async function releaseMaintenance(
  transaction: PgTransactionClient,
  runId: string,
  outcome: "completed" | "failed",
  actor: MaintenanceActor,
  failureCode: string | null,
): Promise<void> {
  const released = await transaction.query(
    `update bakery.installation_maintenance
        set state = 'off', version = version + 1
      where id = true and owner_run_id = $1 and state <> 'off'`,
    [runId],
  );
  if (released.rowCount === 0) return;
  await audit(transaction, actor, MAINTENANCE_EXIT_OPERATION, runId, {
    outcome,
    ...(failureCode === null ? {} : { failureCode }),
  });
}

/** The maintenance state administrators see on the status read. */
export async function readMaintenanceState(
  transaction: PgTransactionClient,
): Promise<{ state: string; since: Date | null }> {
  const result = await transaction.query<
    { state: string; enteredAt: Date; leaseExpiresAt: Date; now: Date }
  >(
    `select state, entered_at as "enteredAt",
            lease_expires_at as "leaseExpiresAt",
            clock_timestamp() as "now"
       from bakery.installation_maintenance where id = true`,
  );
  const row = result.rows[0];
  if (!row) return { state: MaintenanceState.Off, since: null };
  const state = effectiveMaintenanceState(row, row.now);
  return {
    state,
    since: state === MaintenanceState.Off ? null : row.enteredAt,
  };
}
