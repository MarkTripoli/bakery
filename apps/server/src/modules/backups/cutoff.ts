import { contractSchemas } from "@bakery/contracts/contracts";
import type { z } from "zod";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  effectiveMaintenanceState,
  MaintenanceState,
} from "../../platform/maintenance.ts";
import {
  audit,
  conflict,
  lockClaimedRun,
  type MaintenanceActor,
} from "./maintenance.ts";
import {
  type Census,
  censusOf,
  type EffectRow,
  LIVE_EFFECT_STATUSES,
  type OperationCount,
} from "./cutoff-rules.ts";

/**
 * backupRunner.cutoff (issue #64 slice C, also #49): the moment the snapshot
 * begins, from the DATABASE clock, with a census of the external effects that
 * could still reach a provider at that moment.
 *
 * It is only valid while the run holds the installation quiesced (slice B):
 * nothing new is admitted and nothing is in flight, so what is counted here is
 * what the dumps that follow will hold. The row is written before the dumps, so
 * it is inside the dump it describes. Asking again for the same run returns the
 * stored row: the cutoff of a run never moves.
 */

type View = z.output<typeof contractSchemas.BackupCutoff>;

export const CUTOFF_OPERATION = "backupRunner.cutoff";

type StoredRow = {
  cutoffAt: Date;
  effectsTotal: number;
  effectsPrepared: number;
  effectsSubmitted: number;
  effectsUncertain: number;
  effectsByOperation: OperationCount[];
  effectsDigest: string;
};

const STORED_COLUMNS = `cutoff_at as "cutoffAt",
  effects_total as "effectsTotal", effects_prepared as "effectsPrepared",
  effects_submitted as "effectsSubmitted",
  effects_uncertain as "effectsUncertain",
  effects_by_operation as "effectsByOperation",
  effects_digest as "effectsDigest"`;

function view(runId: string, row: StoredRow): View {
  return contractSchemas.BackupCutoff.parse({
    runId,
    cutoffAt: row.cutoffAt.toISOString(),
    effectsTotal: row.effectsTotal,
    effectsPrepared: row.effectsPrepared,
    effectsSubmitted: row.effectsSubmitted,
    effectsUncertain: row.effectsUncertain,
    effectsByOperation: row.effectsByOperation,
    effectsDigest: row.effectsDigest,
  });
}

/**
 * The live effects and the database clock, in ONE statement so both come from
 * the same snapshot. The left join keeps the clock when there are no effects.
 */
async function readLiveEffects(
  transaction: PgTransactionClient,
): Promise<{ at: Date; rows: EffectRow[] }> {
  const result = await transaction.query<
    {
      at: Date;
      id: string | null;
      status: string | null;
      operation: string | null;
    }
  >(
    `select c.at as "at", e.id as "id", e.status as "status",
            e.operation as "operation"
       from (select clock_timestamp() as at) c
       left join bakery.external_effects e
         on e.status in (${
      LIVE_EFFECT_STATUSES.map((s) => `'${s}'`).join(", ")
    })`,
  );
  const at = result.rows[0].at;
  const rows: EffectRow[] = [];
  for (const row of result.rows) {
    if (row.id === null || row.status === null || row.operation === null) {
      continue;
    }
    rows.push({ id: row.id, status: row.status, operation: row.operation });
  }
  return { at, rows };
}

/** The stored census as the rules' `Census` type (for the manifest and tests). */
export function censusOfRow(row: View): Census {
  return {
    total: row.effectsTotal,
    prepared: row.effectsPrepared,
    submitted: row.effectsSubmitted,
    uncertain: row.effectsUncertain,
    byOperation: row.effectsByOperation,
    digest: row.effectsDigest,
  };
}

export async function takeCutoff(
  transaction: PgTransactionClient,
  runId: string,
  leaseToken: string,
  actor: MaintenanceActor,
): Promise<View> {
  // The run must be the claimed one, its lease unexpired, the token its own.
  const run = await lockClaimedRun(transaction, runId, leaseToken);
  const held = await transaction.query<
    {
      state: string;
      ownerRunId: string | null;
      leaseExpiresAt: Date;
    }
  >(
    `select state, owner_run_id as "ownerRunId",
            lease_expires_at as "leaseExpiresAt"
       from bakery.installation_maintenance where id = true for share`,
  );
  const row = held.rows[0] ?? null;
  const state = effectiveMaintenanceState(row, run.dbNow);
  if (
    state !== MaintenanceState.Quiesced || row === null ||
    row.ownerRunId !== runId
  ) {
    // Not held, still draining, held by another run, or lapsed: no cutoff.
    throw conflict("not_quiesced");
  }
  const existing = await transaction.query<StoredRow>(
    `select ${STORED_COLUMNS} from bakery.backup_cutoffs where run_id = $1`,
    [runId],
  );
  if (existing.rows[0]) return view(runId, existing.rows[0]);

  const { at, rows } = await readLiveEffects(transaction);
  const census = await censusOf(rows);
  const inserted = await transaction.query<StoredRow>(
    `insert into bakery.backup_cutoffs
       (run_id, cutoff_at, effects_total, effects_prepared, effects_submitted,
        effects_uncertain, effects_by_operation, effects_digest)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     on conflict (run_id) do nothing
     returning ${STORED_COLUMNS}`,
    [
      runId,
      at,
      census.total,
      census.prepared,
      census.submitted,
      census.uncertain,
      JSON.stringify(census.byOperation),
      census.digest,
    ],
  );
  // The run row is locked, so a concurrent ask waited for this one; if the
  // insert still found a row (it cannot), read it back rather than invent.
  const stored = inserted.rows[0] ??
    (await transaction.query<StoredRow>(
      `select ${STORED_COLUMNS} from bakery.backup_cutoffs where run_id = $1`,
      [runId],
    )).rows[0];
  // Counts, words and the digest only: never an effect's id, target or arguments.
  await audit(transaction, actor, CUTOFF_OPERATION, runId, {
    cutoffAt: stored.cutoffAt.toISOString(),
    effectsTotal: stored.effectsTotal,
    effectsPrepared: stored.effectsPrepared,
    effectsSubmitted: stored.effectsSubmitted,
    effectsUncertain: stored.effectsUncertain,
    effectsDigest: stored.effectsDigest,
  });
  return view(runId, stored);
}
