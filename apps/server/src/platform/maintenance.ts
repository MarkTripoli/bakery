import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "./database.ts";

/**
 * The installation maintenance switch (issue #64 slice B).
 *
 * While a backup takes its snapshot the host runner holds the switch, and every
 * entry point that would start or change work calls `assertNotQuiesced` first.
 * The switch is lease-bound: it is active only while its state is not `off`
 * AND its lease is in the future, and that is decided here, on read, from the
 * database clock. Nothing sweeps the row, so a runner that dies cannot leave
 * the installation stuck: when its lease lapses the answer is `off` with no
 * action from anyone.
 */

export const MaintenanceState = Object.freeze(
  { Off: "off", Draining: "draining", Quiesced: "quiesced" } as const,
);
export type MaintenanceStateWord =
  (typeof MaintenanceState)[keyof typeof MaintenanceState];

/** The longest a refused caller is told to wait before asking again. */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 30;

/**
 * How long the switch must have been on before it may be called quiesced. A
 * transaction that passed the guard just before the switch was set finishes
 * well inside this window; it is the only thing that covers a write the guard
 * could not see. It is NOT a guarantee for a transaction that runs longer.
 */
export const DRAIN_SETTLE_SECONDS = 5;

/** What the switch row holds that the rules need. */
export type MaintenanceLease = {
  readonly state: string;
  readonly leaseExpiresAt: Date;
};

/**
 * True while the switch holds the installation: a state other than `off` whose
 * lease is strictly in the future. A lease that ends exactly now has lapsed.
 */
export function maintenanceIsActive(
  row: MaintenanceLease | null,
  now: Date,
): boolean {
  if (row === null) return false;
  if (
    row.state !== MaintenanceState.Draining &&
    row.state !== MaintenanceState.Quiesced
  ) return false;
  return row.leaseExpiresAt.getTime() > now.getTime();
}

/** The state callers should believe: `off` whenever the switch is not active. */
export function effectiveMaintenanceState(
  row: MaintenanceLease | null,
  now: Date,
): MaintenanceStateWord {
  if (!maintenanceIsActive(row, now)) return MaintenanceState.Off;
  return row!.state as MaintenanceStateWord;
}

/**
 * How long a refused caller should wait: the usual interval, or less when the
 * lease ends sooner, and never under one second.
 */
export function maintenanceRetryAfter(
  row: MaintenanceLease,
  now: Date,
): number {
  const remaining = Math.ceil(
    (row.leaseExpiresAt.getTime() - now.getTime()) / 1000,
  );
  return Math.max(1, Math.min(MAINTENANCE_RETRY_AFTER_SECONDS, remaining));
}

/**
 * Everything the drain check can see, and nothing else. It cannot see Inngest
 * or Redis engine steps, work a worker is doing without a lease, or a
 * transaction that began before the switch and is still open past the settle
 * window; the runbook says so.
 */
export type DrainObservation = {
  /** Worker job attempts that are leased, running or canceling with an unexpired lease. */
  readonly liveAttempts: number;
  /** Other open transactions of this role that began before the switch was set. */
  readonly openTransactions: number;
};

export type DrainDecision = {
  readonly drained: boolean;
  /** Whole seconds to wait before asking again; 0 when drained. */
  readonly waitSeconds: number;
};

/**
 * Whether the installation is quiet enough to be called quiesced: nothing live
 * to wait for, and the switch has been on for the settle window.
 */
export function drainDecision(input: {
  readonly enteredAt: Date;
  readonly now: Date;
  readonly observation: DrainObservation;
  readonly settleSeconds?: number;
}): DrainDecision {
  const settle = input.settleSeconds ?? DRAIN_SETTLE_SECONDS;
  const settledAt = input.enteredAt.getTime() + settle * 1000;
  const settleLeft = Math.max(
    0,
    Math.ceil((settledAt - input.now.getTime()) / 1000),
  );
  const busy = input.observation.liveAttempts > 0 ||
    input.observation.openTransactions > 0;
  if (!busy && settleLeft === 0) return { drained: true, waitSeconds: 0 };
  return { drained: false, waitSeconds: busy ? 2 : Math.max(1, settleLeft) };
}

/**
 * The doors a restore hold closes, in the order an administrator opens them
 * (#64 slice E3). `intake` is new work coming in (run creation, webhooks,
 * imports, catalog changes), `dispatch` is the background consumers that settle
 * and collect, `workers` is workers claiming work. A door is closed while the
 * restore record is unreleased and its own step has not been taken.
 */
export type RestoreDoor = "intake" | "dispatch" | "workers";

const DOOR_COLUMN: Readonly<Record<RestoreDoor, string>> = Object.freeze({
  intake: "intake_enabled_at",
  dispatch: "dispatch_enabled_at",
  workers: "workers_enabled_at",
});

type SwitchRow = { state: string; leaseExpiresAt: Date; now: Date };

type HoldRow = {
  state: string | null;
  leaseExpiresAt: Date | null;
  now: Date;
  restoreHeld?: boolean;
};

/**
 * What holds the installation right now, in one read on the database clock: a
 * restore (#64 slice E), whose record has no lease because nothing renews it
 * and nothing may let it lapse (it ends only when an administrator completes
 * the ordered re-enable steps and the record is released), and the backup
 * switch, which is active only while its state is not `off` and its lease is
 * in the future. One query, because this runs in front of every run creation
 * and worker claim.
 */
async function readHold(
  transaction: Pick<PgTransactionClient, "query">,
  door: RestoreDoor,
): Promise<{ restoring: boolean; backup: SwitchRow | null }> {
  // The column comes from the fixed map above, never from a caller's text.
  const column = DOOR_COLUMN[door];
  const result = await transaction.query<HoldRow>(
    `select switch.state, switch.lease_expires_at as "leaseExpiresAt",
            clock_timestamp() as "now",
            exists (
              select 1 from bakery.installation_restores
               where released_at is null and ${column} is null
            ) as "restoreHeld"
       from (select 1) as one
       left join bakery.installation_maintenance as switch on switch.id = true`,
  );
  const row = result.rows[0];
  if (row === undefined) return { restoring: false, backup: null };
  const backup = row.state !== null && row.leaseExpiresAt !== null &&
      maintenanceIsActive(
        { state: row.state, leaseExpiresAt: row.leaseExpiresAt },
        row.now,
      )
    ? { state: row.state, leaseExpiresAt: row.leaseExpiresAt, now: row.now }
    : null;
  return { restoring: row.restoreHeld === true, backup };
}

/**
 * Whether the launcher has paused work for an update right now (#59 ask 9):
 * the switch is held, its lease is in the future, and its reason is `update`.
 * A backup's hold is not an update, so it reads false here. Read on the
 * database clock, so a pause whose lease lapsed reads false with nothing
 * sweeping it.
 */
export async function updatePaused(
  query: Pick<PgTransactionClient, "query">,
): Promise<boolean> {
  const result = await query.query<
    { state: string; reason: string; leaseExpiresAt: Date; now: Date }
  >(
    `select state, reason, lease_expires_at as "leaseExpiresAt",
            clock_timestamp() as "now"
       from bakery.installation_maintenance where id = true`,
  );
  const row = result.rows[0];
  return row !== undefined && row.reason === "update" &&
    maintenanceIsActive(row, row.now);
}

/**
 * The shared guard. Call it first in the transaction of every entry point that
 * starts or changes work. A restore hold refuses with a 503
 * INSTALLATION_RESTORING that is not retryable (asking again does not help). A
 * backup hold refuses with a retryable 503 INSTALLATION_QUIESCED and a
 * Retry-After hint. Either way it happens before anything is written; the guard
 * reads with the database clock and writes nothing, so a refused call commits
 * nothing.
 */
export async function assertNotQuiesced(
  transaction: Pick<PgTransactionClient, "query">,
  door: RestoreDoor,
): Promise<void> {
  const hold = await readHold(transaction, door);
  if (hold.restoring) {
    throw new StandardError({ code: "INSTALLATION_RESTORING" });
  }
  if (hold.backup === null) return;
  throw new StandardError({
    code: "INSTALLATION_QUIESCED",
    params: {
      retryAfterSeconds: maintenanceRetryAfter(hold.backup, hold.backup.now),
    },
  });
}

/**
 * Whether the installation is held right now, by a backup or by a restore. For
 * a background consumer that must not count a refusal as an attempt: it leaves
 * the work exactly as it is and lets a later pass pick it up, instead of
 * throwing. Reads only.
 */
export async function isQuiesced(
  transaction: Pick<PgTransactionClient, "query">,
  door: RestoreDoor,
): Promise<boolean> {
  const hold = await readHold(transaction, door);
  return hold.restoring || hold.backup !== null;
}
