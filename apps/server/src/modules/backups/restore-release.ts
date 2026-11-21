import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { BackupImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import type { z } from "zod";
import type { PgTransactionClient } from "../../platform/database.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";

/**
 * installationRestore.get and installationRestore.step (issue #64 slice E3).
 *
 * After a restore the fence (slice E1) leaves one unreleased record and every
 * door closed. An installation administrator opens the doors in a fixed order:
 * intake, then dispatch, then workers. The workers step is the last and also
 * releases the record, which ends the hold. Each step names the restored
 * backup as its typed confirmation, because it is the administrator saying
 * "yes, this installation is the one I mean". Every refusal has its own code
 * and changes nothing.
 */

type View = z.output<typeof contractSchemas.InstallationRestore>;

export const RESTORE_STEPS = ["intake", "dispatch", "workers"] as const;
export type RestoreStep = (typeof RESTORE_STEPS)[number];

export type RestoreProgress = {
  readonly backupName: string;
  readonly taken: Readonly<Record<RestoreStep, boolean>>;
};

/** The step to take next, or null when all are taken. */
export function nextRestoreStep(
  taken: Readonly<Record<RestoreStep, boolean>>,
): RestoreStep | null {
  return RESTORE_STEPS.find((step) => !taken[step]) ?? null;
}

/**
 * Whether `step` may be taken now with this confirmation. Throws the named
 * refusal otherwise. The confirmation is checked first, so a mistyped name is
 * the answer however the steps stand; then a step already taken; then order.
 */
export function assertStepAllowed(
  progress: RestoreProgress,
  step: RestoreStep,
  confirmation: string,
): void {
  if (confirmation !== progress.backupName) {
    throw new StandardError({ code: "RESTORE_CONFIRMATION_MISMATCH" });
  }
  if (progress.taken[step]) {
    throw new StandardError({ code: "RESTORE_STEP_ALREADY_TAKEN" });
  }
  const expected = nextRestoreStep(progress.taken);
  if (expected !== step) {
    throw new StandardError({
      code: "RESTORE_STEP_OUT_OF_ORDER",
      params: { expected },
    });
  }
}

type StoredRow = {
  id: string;
  backupName: string;
  cutoffAt: Date | null;
  restoredAt: Date;
  effectsHeld: number;
  attemptsQuarantined: number;
  jobsAwaitingReconciliation: number;
  workersRevoked: number;
  intakeEnabledAt: Date | null;
  dispatchEnabledAt: Date | null;
  workersEnabledAt: Date | null;
  releasedAt: Date | null;
};

const COLUMNS = `id, backup_name as "backupName", cutoff_at as "cutoffAt",
  restored_at as "restoredAt", effects_held as "effectsHeld",
  attempts_quarantined as "attemptsQuarantined",
  jobs_awaiting_reconciliation as "jobsAwaitingReconciliation",
  workers_revoked as "workersRevoked",
  intake_enabled_at as "intakeEnabledAt",
  dispatch_enabled_at as "dispatchEnabledAt",
  workers_enabled_at as "workersEnabledAt", released_at as "releasedAt"`;

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

function takenOf(row: StoredRow): Record<RestoreStep, boolean> {
  return {
    intake: row.intakeEnabledAt !== null,
    dispatch: row.dispatchEnabledAt !== null,
    workers: row.workersEnabledAt !== null,
  };
}

function view(row: StoredRow): View {
  return {
    id: row.id,
    backupName: row.backupName,
    cutoffAt: iso(row.cutoffAt),
    restoredAt: row.restoredAt.toISOString(),
    effectsHeld: row.effectsHeld,
    attemptsQuarantined: row.attemptsQuarantined,
    jobsAwaitingReconciliation: row.jobsAwaitingReconciliation,
    workersRevoked: row.workersRevoked,
    intakeEnabledAt: iso(row.intakeEnabledAt),
    dispatchEnabledAt: iso(row.dispatchEnabledAt),
    workersEnabledAt: iso(row.workersEnabledAt),
    releasedAt: iso(row.releasedAt),
    nextStep: row.releasedAt === null ? nextRestoreStep(takenOf(row)) : null,
  };
}

/** The restore that holds the installation, or the named refusal. */
export async function readHeldRestore(
  transaction: PgTransactionClient,
  options: { readonly lock: boolean } = { lock: false },
): Promise<StoredRow> {
  const result = await transaction.query<StoredRow>(
    `select ${COLUMNS} from bakery.installation_restores
      where released_at is null order by restored_at desc, id limit 1${
      options.lock ? " for update" : ""
    }`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new StandardError({ code: "RESTORE_NOT_HELD" });
  return row;
}

/** installationRestore.get */
export async function getRestore(
  transaction: PgTransactionClient,
): Promise<View> {
  return view(await readHeldRestore(transaction));
}

/** installationRestore.step */
export async function takeRestoreStep(
  transaction: PgTransactionClient,
  context: Parameters<typeof recordAuthAudit>[1],
  principalId: string,
  input: { readonly step: RestoreStep; readonly confirmation: string },
): Promise<View> {
  // Locked, so two administrators taking the same step see one winner.
  const row = await readHeldRestore(transaction, { lock: true });
  assertStepAllowed(
    { backupName: row.backupName, taken: takenOf(row) },
    input.step,
    input.confirmation,
  );
  // The column comes from the fixed list of steps, never from the caller's text.
  const column = {
    intake: "intake_enabled_at",
    dispatch: "dispatch_enabled_at",
    workers: "workers_enabled_at",
  }[input.step];
  const releasing = input.step === "workers";
  const updated = await transaction.query<StoredRow>(
    `update bakery.installation_restores
        set ${column} = clock_timestamp()${
      releasing ? ", released_at = clock_timestamp()" : ""
    }
      where id = $1 and released_at is null
      returning ${COLUMNS}`,
    [row.id],
  );
  const result = updated.rows[0];
  if (result === undefined) {
    throw new StandardError({ code: "RESTORE_NOT_HELD" });
  }
  // Names and the step only: nothing the restore touched.
  await recordAuthAudit(transaction, context, {
    organizationId: null,
    principalId,
    operation: Action.InstallationRestoreStep,
    resourceType: "installation_restore",
    resourceId: result.id,
    details: {
      step: input.step,
      backupName: result.backupName,
      released: releasing,
    },
  });
  return view(result);
}
