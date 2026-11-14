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
  type PgTransactionClient,
  withPgTransaction,
} from "../../../platform/database.ts";
import { nextOccurrence, parseCron } from "./schedule.ts";
import { dueOccurrences, type MisfirePolicy, planFiring } from "./tick-plan.ts";
import { parseTrigger } from "./trigger.ts";
import { insertFiring } from "./firing.ts";

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
  /**
   * Automations that could not be admitted this tick, each rolled back whole
   * (its firing and its cursor), with a short reason. They are left out of the
   * rest of the tick, so they hold nobody else back, and tried again at the
   * next one.
   */
  failed: readonly Readonly<{ automationId: string; error: string }>[];
}>;

/** An automation whose admission failed, carrying which one. */
class AutomationAdmissionError extends Error {
  readonly automationId: string;
  constructor(automationId: string, cause: unknown) {
    super("AUTOMATION_ADMISSION_FAILED", { cause });
    this.automationId = automationId;
  }
}

const reasonOf = (error: unknown): string => {
  const text = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
};

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
  excluded: readonly string[],
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
          and d.id <> all($2::uuid[])
        order by d.next_fire_at, d.id
        limit 1
        for update of d skip locked`,
      [now.toISOString(), excluded],
    );
    const row = claimed.rows[0];
    if (!row) return null;
    try {
      return await admitClaimed(transaction, row, now);
    } catch (cause) {
      // The transaction rolls back whole; say which automation it was.
      throw new AutomationAdmissionError(row.id, cause);
    }
  });
}

async function admitClaimed(
  transaction: PgTransactionClient,
  row: DueRow,
  now: Date,
): Promise<{ admitted: boolean; coalesced: boolean; cleared: boolean }> {
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
    admitted = await insertFiring(transaction, {
      organizationId: row.organization_id,
      automationVersionId: row.active_version_id,
      scheduledAt: plan.scheduledAt,
      status: plan.status,
      pending: plan.pending,
      skippedCount: plan.skippedCount,
    }) === "inserted";
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
}

/**
 * Admits the firings of every due automation, up to `batch` of them, one
 * transaction each. An automation that fails is rolled back whole, set aside
 * for the rest of this tick and reported in `failed`: the ones behind it are
 * still admitted, so one broken automation (of any organization) cannot keep
 * every other automation from firing, and it is tried again at the next tick.
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
  const failed: { automationId: string; error: string }[] = [];
  const setAside: string[] = [];
  for (let index = 0; index < batch; index += 1) {
    let outcome;
    try {
      outcome = await admitOne(options.database, now, setAside);
    } catch (error) {
      if (!(error instanceof AutomationAdmissionError)) throw error;
      setAside.push(error.automationId);
      failed.push({
        automationId: error.automationId,
        error: reasonOf(error.cause),
      });
      continue;
    }
    if (outcome === null) break;
    if (outcome.admitted) admitted += 1;
    if (outcome.coalesced) coalesced += 1;
    if (outcome.cleared) cleared += 1;
  }
  return { admitted, coalesced, cleared, failed };
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
      await step.run("admit-due-automations", async () => {
        const result = await admitDueAutomations({
          database: options.database,
        });
        // Everything that could be admitted has been, and is committed. An
        // automation that could not be is reported as a failed step so that
        // Inngest retries it and the failure is visible, not swallowed.
        if (result.failed.length > 0) {
          throw new Error(
            `AUTOMATION_TICK_FAILURES:${result.failed.length}:` +
              result.failed.map((failure) =>
                `${failure.automationId} ${failure.error}`
              ).join("; "),
          );
        }
        return result;
      }),
  );
}
