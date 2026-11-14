/**
 * Promotion (issue #36): a queued firing that waits for its run is started
 * once the automation is free. The clock admits a firing as `queued` and
 * `pending` when an occurrence comes due while an earlier run is still active
 * (`queue_one`) and when nothing holds the automation (it then starts at the
 * next promotion); nothing tells the clock a run has ended, so this pass looks
 * for waiting firings every minute, oldest first, and starts each one in its
 * own transaction through `startFiring`, which leaves it waiting while a run of
 * the automation is active and starts at most one run however many promoters
 * run at once.
 */
import type { Inngest } from "inngest";
import type { PgDatabase } from "../../../platform/database.ts";
import { startFiring } from "./start.ts";

/** Waiting firings one pass looks at; the next minute takes the rest. */
export const AUTOMATION_PROMOTE_BATCH = 200;
/** The most a caller may ask one pass to look at. */
export const AUTOMATION_PROMOTE_BATCH_CEILING = 5_000;
export const AUTOMATION_PROMOTE_FUNCTION_ID = "bakery-automation-promote";

export type PromoteResult = Readonly<{
  /** Firings that became a task and a run. */
  started: number;
  /** Firings left waiting because a run of the automation is active. */
  held: number;
  /** Firings that could not start for a reason waiting will not change (now `failed`). */
  refused: number;
  /** Firings that hit a database or dependency fault, tried again next pass. */
  errors: readonly Readonly<{ firingId: string; error: string }>[];
}>;

export async function promoteWaitingFirings(options: {
  database: PgDatabase;
  batch?: number;
}): Promise<PromoteResult> {
  const batch = options.batch ?? AUTOMATION_PROMOTE_BATCH;
  if (
    !Number.isInteger(batch) || batch < 1 ||
    batch > AUTOMATION_PROMOTE_BATCH_CEILING
  ) {
    throw new RangeError(
      `batch must be a whole number from 1 to ${AUTOMATION_PROMOTE_BATCH_CEILING}`,
    );
  }
  const waiting = await options.database.query<{ id: string }>(
    `select id
       from bakery.automation_firings
      where status = 'queued' and pending and run_id is null
      order by created_at, id
      limit $1`,
    [batch],
  );
  let started = 0;
  let held = 0;
  let refused = 0;
  const errors: { firingId: string; error: string }[] = [];
  for (const { id: firingId } of waiting.rows) {
    try {
      const outcome = await startFiring({
        database: options.database,
        firingId,
        holdWhileActive: true,
      });
      if (outcome.kind === "started") started += 1;
      else if (outcome.kind === "held") held += 1;
      else if (outcome.kind === "failed") refused += 1;
    } catch (error) {
      const text = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
      errors.push({
        firingId,
        error: text.length > 200 ? `${text.slice(0, 197)}...` : text,
      });
    }
  }
  return { started, held, refused, errors };
}

/** The one Inngest function that starts waiting firings: a cron every minute. */
export function createAutomationPromoteFunction(
  options: { database: PgDatabase; client: Inngest },
) {
  return options.client.createFunction(
    {
      id: AUTOMATION_PROMOTE_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) =>
      await step.run("promote-waiting-firings", async () => {
        const result = await promoteWaitingFirings({
          database: options.database,
        });
        // Everything that could start has, and is committed. A firing that hit
        // a fault is reported as a failed step so Inngest retries it.
        if (result.errors.length > 0) {
          throw new Error(
            `AUTOMATION_PROMOTE_FAILURES:${result.errors.length}:` +
              result.errors.map((failure) =>
                `${failure.firingId} ${failure.error}`
              ).join("; "),
          );
        }
        return result;
      }),
  );
}
