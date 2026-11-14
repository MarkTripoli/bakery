/**
 * `automation.tick`: the one clock that admits automation firings (issue #36).
 *
 * It runs every minute, claims the automations whose cursor is due one at a
 * time with a row lock that other ticks skip, works out the due occurrences of
 * the active version's schedule, admits at most one deduplicated firing for
 * them under the version's misfire policy, and moves the cursor to the next
 * occurrence after now. A duplicate wake, two ticks at once or a restart in the
 * middle can change nothing: the firing is keyed by its scheduled UTC instant
 * and the cursor moves in the same transaction as the firing is written. The
 * cursor is the scheduler's own state: moving it does not change the record's
 * `version`, so a person's `If-Match` is not made stale by every firing.
 *
 * It admits; it does not start runs. A queued firing waits, `pending`, for the
 * run starter, which rechecks cancellation, grants and budgets.
 */
import type { Inngest } from "inngest";
import {
  type PgDatabase,
  withPgTransaction,
} from "../../../platform/database.ts";
import { nextOccurrence, parseCron } from "./schedule.ts";
import { dueOccurrences, type MisfirePolicy, planFiring } from "./tick-plan.ts";
import { parseTrigger } from "./trigger.ts";

export const AUTOMATION_TICK_FUNCTION_ID = "bakery-automation-tick";

/** Automations one tick admits at most; the next minute takes the rest. */
export const AUTOMATION_TICK_BATCH = 200;
/** The most a caller may ask one tick to admit. */
export const AUTOMATION_TICK_BATCH_CEILING = 5_000;

export type TickResult = Readonly<{
  /** Firings written (queued or skipped). */
  admitted: number;
  /** Of those, how many were catch-ups that stood in for more than one occurrence. */
  coalesced: number;
  /** Cursors cleared because the active version has no schedule to follow. */
  cleared: number;
}>;

type DueRow = {
  id: string;
  organization_id: string;
  active_version_id: string;
  next_fire_at: Date | string;
  trigger: unknown;
  misfire_policy: string;
};

/** One due automation, claimed and admitted in its own transaction; null when nothing is due. */
async function admitOne(
  database: PgDatabase,
  now: Date,
): Promise<
  { admitted: boolean; coalesced: boolean; cleared: boolean } | null
> {
  return await withPgTransaction(database, async (transaction) => {
    const claimed = await transaction.query<DueRow>(
      `select d.id, d.organization_id, d.active_version_id, d.next_fire_at,
              v.trigger, v.misfire_policy
         from bakery.automation_definitions d
         join bakery.automation_versions v
           on v.organization_id = d.organization_id
          and v.id = d.active_version_id
        where d.enabled
          and d.next_fire_at is not null
          and d.next_fire_at <= $1
        order by d.next_fire_at, d.id
        limit 1
        for update of d skip locked`,
      [now.toISOString()],
    );
    const row = claimed.rows[0];
    if (!row) return null;

    let schedule: ReturnType<typeof parseCron>;
    let zone: string;
    try {
      const trigger = parseTrigger(row.trigger);
      if (trigger.type !== "schedule") throw new Error("not a schedule");
      schedule = parseCron(trigger.cron);
      zone = trigger.timezone;
    } catch {
      // A version without a schedule has nothing to fire: clear the cursor so it is not claimed again.
      await transaction.query(
        `update bakery.automation_definitions
            set next_fire_at = null, updated_at = now()
          where id = $1`,
        [row.id],
      );
      return { admitted: false, coalesced: false, cleared: true };
    }

    const cursor = new Date(row.next_fire_at);
    const due = dueOccurrences(schedule, zone, cursor, now);
    let admitted = false;
    let coalesced = false;
    if (due !== null) {
      const plan = planFiring(row.misfire_policy as MisfirePolicy, due);
      const inserted = await transaction.query(
        `insert into bakery.automation_firings (
           organization_id, automation_version_id, scheduled_at, status,
           pending, skipped_count
         ) values ($1, $2, $3, $4, $5, $6)
         on conflict (automation_version_id, scheduled_at) do nothing`,
        [
          row.organization_id,
          row.active_version_id,
          plan.scheduledAt.toISOString(),
          plan.status,
          plan.pending,
          plan.skippedCount,
        ],
      );
      admitted = (inserted.rowCount ?? 0) > 0;
      coalesced = admitted && due.count > 1;
    }
    // The next occurrence after now: whatever was due is accounted for.
    const next = nextOccurrence(schedule, zone, now);
    await transaction.query(
      `update bakery.automation_definitions
          set next_fire_at = $2, updated_at = now()
        where id = $1`,
      [row.id, next?.toISOString() ?? null],
    );
    return { admitted, coalesced, cleared: false };
  });
}

/**
 * Admits the firings of every due automation, up to `batch` of them, one
 * transaction each, so one failing automation holds back none of the others'
 * work already committed.
 */
export async function admitDueAutomations(options: {
  database: PgDatabase;
  now?: Date;
  batch?: number;
}): Promise<TickResult> {
  const batch = options.batch ?? AUTOMATION_TICK_BATCH;
  if (
    !Number.isInteger(batch) || batch < 1 ||
    batch > AUTOMATION_TICK_BATCH_CEILING
  ) {
    throw new RangeError(
      `batch must be a whole number from 1 to ${AUTOMATION_TICK_BATCH_CEILING}`,
    );
  }
  const now = options.now ?? new Date();
  let admitted = 0;
  let coalesced = 0;
  let cleared = 0;
  for (let index = 0; index < batch; index += 1) {
    const outcome = await admitOne(options.database, now);
    if (outcome === null) break;
    if (outcome.admitted) admitted += 1;
    if (outcome.coalesced) coalesced += 1;
    if (outcome.cleared) cleared += 1;
  }
  return { admitted, coalesced, cleared };
}

/** The one Inngest clock for every automation: a cron every minute that admits what is due. */
export function createAutomationTickFunction(
  options: { database: PgDatabase; client: Inngest },
) {
  return options.client.createFunction(
    {
      id: AUTOMATION_TICK_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) =>
      await step.run(
        "admit-due-automations",
        () => admitDueAutomations({ database: options.database }),
      ),
  );
}
