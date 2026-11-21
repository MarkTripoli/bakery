import { appendAudit } from "@bakery/persistence/event-audit";
import { observeDrain } from "../modules/backups/maintenance.ts";
import {
  readUncertainActions,
  type UncertainActionKind,
} from "../modules/backups/uncertain-actions.ts";
import type { PgTransactionClient } from "./database.ts";
import {
  drainDecision,
  maintenanceIsActive,
  MaintenanceState,
} from "./maintenance.ts";

/**
 * Pausing work around an update (issue #59, server asks 1, 4 and 10).
 *
 * The launcher (scripts/deploy/release.mjs) has to stop Bakery taking new work
 * while it switches versions, and it must do that without calling Bakery's API
 * or UI, which may be the very thing that is broken. So the pause is the
 * installation's existing maintenance switch (platform/maintenance.ts), set from
 * a host task as the database owner, the way the restore fence is.
 *
 * It is the same switch a backup holds, with reason `update`: every guarded
 * entry point already answers a retryable 503 INSTALLATION_QUIESCED while it is
 * on, and a webhook delivery is stored and waits. The lease is long enough for
 * one launcher run and short enough that a launcher that dies leaves nothing
 * stuck: when it lapses the installation is back to normal on its own.
 *
 * Nothing is moved, rewritten or sent. Tasks, approvals and questions stay
 * exactly where they are; "carried over" is a count taken after the pause, so
 * the launcher can say what waited.
 */

export const MAINTENANCE_REASON_UPDATE = "update";
export const UPDATE_PAUSE_OPERATION = "installation.update.pause";
export const UPDATE_RESUME_OPERATION = "installation.update.resume";

/** Longer than the launcher's own 30 minute run limit, so a live run never loses it. */
export const UPDATE_PAUSE_LEASE_SECONDS = 35 * 60;
/** How long the pause waits for running work to finish before it gives up. */
export const UPDATE_DRAIN_TIMEOUT_SECONDS = 180;

/** Why a pause was refused. Each is a different next step for the person. */
export type UpdatePauseRefusalCode =
  | "INSTALLATION_RESTORING"
  | "MAINTENANCE_HELD"
  | "DRAIN_TIMEOUT";

export class UpdatePauseRefusal extends Error {
  readonly code: UpdatePauseRefusalCode;
  constructor(code: UpdatePauseRefusalCode) {
    super(code);
    this.name = "UpdatePauseRefusal";
    this.code = code;
  }
}

/** What waited through the update: counts only, never a title, target or argument. */
export type CarriedOver = {
  /** Tasks still in flight: queued, active, waiting for input or blocked. */
  readonly tasks: number;
  readonly approvals: number;
  /** Open questions that are not approvals. */
  readonly questions: number;
  /** Outside actions whose outcome Bakery cannot tell. They are only ever checked, never sent again. */
  readonly outsideActionsUnsure: number;
};

export type UpdatePauseResult = {
  readonly state: "quiesced";
  readonly carriedOver: CarriedOver;
};

export type UpdateResumeResult = {
  /** False when nothing of ours was held (already resumed, or the lease lapsed). */
  readonly released: boolean;
  readonly carriedOver: CarriedOver;
};

type Query = Pick<PgTransactionClient, "query">;

export async function readCarriedOver(
  transaction: Query,
): Promise<CarriedOver> {
  const result = await transaction.query<CarriedOver>(
    `select
       (select count(*)::integer from bakery.tasks
         where status in ('queued', 'active', 'waiting_input', 'blocked'))
         as "tasks",
       (select count(*)::integer from bakery.questions
         where status = 'open' and kind = 'approval') as "approvals",
       (select count(*)::integer from bakery.questions
         where status = 'open' and kind <> 'approval') as "questions",
       (select count(*)::integer from bakery.external_effects
         where status = 'uncertain') as "outsideActionsUnsure"`,
  );
  return result.rows[0];
}

type SwitchRow = {
  state: string;
  reason: string;
  enteredAt: Date;
  leaseExpiresAt: Date;
  now: Date;
};

const SWITCH = `select state, reason, entered_at as "enteredAt",
  lease_expires_at as "leaseExpiresAt", clock_timestamp() as "now"
  from bakery.installation_maintenance where id = true for update`;

/**
 * Takes the switch for the update, or refuses. A restore hold refuses first: an
 * update must not open what a restore closed (ask 10). A backup holding the
 * switch refuses too, because two holders cannot share it. Calling again while
 * our own hold is live only extends its lease.
 */
export async function enterUpdatePause(
  transaction: PgTransactionClient,
): Promise<void> {
  const restoring = await transaction.query<{ held: boolean }>(
    `select exists (
       select 1 from bakery.installation_restores where released_at is null
     ) as "held"`,
  );
  if (restoring.rows[0]?.held === true) {
    throw new UpdatePauseRefusal("INSTALLATION_RESTORING");
  }
  const found = await transaction.query<SwitchRow>(SWITCH);
  const row = found.rows[0];
  const active = row !== undefined && maintenanceIsActive(row, row.now);
  if (active && row.reason !== MAINTENANCE_REASON_UPDATE) {
    throw new UpdatePauseRefusal("MAINTENANCE_HELD");
  }
  if (active) {
    await transaction.query(
      `update bakery.installation_maintenance
          set lease_expires_at = clock_timestamp() + make_interval(secs => $1),
              version = version + 1
        where id = true`,
      [UPDATE_PAUSE_LEASE_SECONDS],
    );
    return;
  }
  await transaction.query(
    `insert into bakery.installation_maintenance
       (id, state, reason, owner_run_id, entered_at, lease_expires_at)
     values (true, 'draining', $1, null, clock_timestamp(),
             clock_timestamp() + make_interval(secs => $2))
     on conflict (id) do update
       set state = 'draining', reason = excluded.reason,
           owner_run_id = null, entered_at = excluded.entered_at,
           lease_expires_at = excluded.lease_expires_at,
           version = bakery.installation_maintenance.version + 1`,
    [MAINTENANCE_REASON_UPDATE, UPDATE_PAUSE_LEASE_SECONDS],
  );
}

/**
 * One look at whether the held installation is quiet yet. Moves it to
 * `quiesced` once nothing the drain check can see is left and the settle window
 * has passed. Returns how long to wait before asking again (0 when quiet).
 *
 * The check runs as the database owner, so the open-transaction half of it only
 * sees the owner role's own sessions; the settle window is what covers a write
 * the server's guard let through just before the switch.
 */
export async function advanceUpdatePause(
  transaction: PgTransactionClient,
): Promise<{ quiesced: boolean; waitSeconds: number }> {
  const found = await transaction.query<SwitchRow>(SWITCH);
  const row = found.rows[0];
  if (
    row === undefined || !maintenanceIsActive(row, row.now) ||
    row.reason !== MAINTENANCE_REASON_UPDATE
  ) {
    // Our hold lapsed or was taken over while we waited: do not carry on.
    throw new UpdatePauseRefusal("MAINTENANCE_HELD");
  }
  if (row.state === MaintenanceState.Quiesced) {
    return { quiesced: true, waitSeconds: 0 };
  }
  const decision = drainDecision({
    enteredAt: row.enteredAt,
    now: row.now,
    observation: await observeDrain(transaction, row.enteredAt),
  });
  if (!decision.drained) {
    return { quiesced: false, waitSeconds: decision.waitSeconds };
  }
  await transaction.query(
    `update bakery.installation_maintenance
        set state = 'quiesced', version = version + 1 where id = true`,
  );
  return { quiesced: true, waitSeconds: 0 };
}

/**
 * Lets go of the switch, only if the update holds it. A backup's hold, or one
 * that already lapsed, is left alone.
 */
export async function releaseUpdatePause(
  transaction: PgTransactionClient,
): Promise<boolean> {
  const released = await transaction.query(
    `update bakery.installation_maintenance
        set state = 'off', version = version + 1
      where id = true and reason = $1 and state <> 'off'`,
    [MAINTENANCE_REASON_UPDATE],
  );
  return (released.rowCount ?? 0) > 0;
}

async function audit(
  transaction: PgTransactionClient,
  operation: string,
  details: Record<string, unknown>,
): Promise<void> {
  const requestId = `update:${crypto.randomUUID()}`;
  await appendAudit(transaction, {
    organizationId: null,
    principalId: null,
    operation,
    resourceType: "installation_maintenance",
    resourceId: "installation",
    requestId,
    traceId: requestId,
    // Counts and words only: never a task title, an effect target or an argument.
    details: { reason: MAINTENANCE_REASON_UPDATE, ...details },
  });
}

export type Transact = <T>(
  work: (transaction: PgTransactionClient) => Promise<T>,
) => Promise<T>;

/**
 * Pauses work and waits for it to go quiet, then reports what waited. If the
 * installation does not go quiet in time it lets go again, so a refused update
 * leaves Bakery taking work as before.
 */
export async function pauseForUpdate(
  transact: Transact,
  options: {
    readonly timeoutSeconds?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly now?: () => number;
  } = {},
): Promise<UpdatePauseResult> {
  const sleep = options.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() +
    (options.timeoutSeconds ?? UPDATE_DRAIN_TIMEOUT_SECONDS) * 1000;
  await transact(enterUpdatePause);
  for (;;) {
    const look = await transact(advanceUpdatePause);
    if (look.quiesced) break;
    if (now() >= deadline) {
      await transact(releaseUpdatePause);
      throw new UpdatePauseRefusal("DRAIN_TIMEOUT");
    }
    await sleep(look.waitSeconds * 1000);
  }
  return await transact(async (transaction) => {
    const carriedOver = await readCarriedOver(transaction);
    await audit(transaction, UPDATE_PAUSE_OPERATION, { ...carriedOver });
    return { state: MaintenanceState.Quiesced, carriedOver };
  });
}

/** Resumes work after the update and reports what was carried over. */
export async function resumeAfterUpdate(
  transact: Transact,
): Promise<UpdateResumeResult> {
  return await transact(async (transaction) => {
    const released = await releaseUpdatePause(transaction);
    const carriedOver = await readCarriedOver(transaction);
    if (released) {
      await audit(transaction, UPDATE_RESUME_OPERATION, { ...carriedOver });
    }
    return { released, carriedOver };
  });
}

/**
 * The outside actions whose outcome is unknown, grouped by kind, oldest first
 * (design ask 4). The same list the HTTP read serves; words and counts only.
 */
export async function readUnsureActions(
  transact: Transact,
): Promise<readonly UncertainActionKind[]> {
  return (await transact(readUncertainActions)).kinds;
}

/** The same counts with no change, for `status`. */
export async function readUpdateCounts(
  transact: Transact,
): Promise<CarriedOver> {
  return await transact(readCarriedOver);
}
