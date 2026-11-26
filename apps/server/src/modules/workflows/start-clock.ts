import type { Inngest } from "inngest";
import {
  type WorkflowStart,
  WorkflowStartsSchema,
} from "@bakery/contracts/workflow-starts";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import {
  MAX_OCCURRENCES,
  occurrencesBetween,
  parseCron,
} from "./automations/schedule.ts";
import { fireStart, type StartFiringOutcome } from "./start-firing.ts";
import { namesRepository } from "./start-read.ts";

export const START_CLOCK_FUNCTION_ID = "bakery-workflow-start-clock";

export const START_CLOCK_WINDOW_MS = 5 * 60_000;

type ScheduleStart = Extract<WorkflowStart["on"], { kind: "schedule" }>;

export function latestDueTick(on: ScheduleStart, now: Date): Date | null {
  const { occurrences } = occurrencesBetween(
    parseCron(on.cron),
    on.timezone,
    new Date(now.getTime() - START_CLOCK_WINDOW_MS - 1),
    now,
    MAX_OCCURRENCES,
  );
  return occurrences.at(-1) ?? null;
}

type ScheduledRow = {
  organization_id: string;
  workflow_id: string;
  version_id: string;
  starts: unknown;
};

export class StartClockFailures extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(
      `WORKFLOW_START_CLOCK_FAILURES:${failures.length}:${failures.join("; ")}`,
    );
    this.failures = failures;
  }
}

export async function fireDueScheduleStarts(options: {
  database: PgDatabase;
  now?: Date;
}): Promise<StartFiringOutcome[]> {
  const now = options.now ?? new Date();
  const scheduled = await options.database.query<ScheduledRow>(
    `select definition.organization_id, definition.id as workflow_id,
            version.id as version_id, version.starts
       from bakery.workflow_definitions definition
       join bakery.workflow_versions version
         on version.organization_id = definition.organization_id
        and version.id = definition.active_version_id
      where definition.enabled
        and version.starts @> $1::jsonb
      order by definition.organization_id, definition.id`,
    [JSON.stringify([{ on: { kind: "schedule" } }])],
  );
  const outcomes: StartFiringOutcome[] = [];
  const failures: string[] = [];
  for (const row of scheduled.rows) {
    for (const start of WorkflowStartsSchema.parse(row.starts)) {
      if (start.on.kind !== "schedule") continue;
      const live = {
        workflowId: row.workflow_id,
        versionId: row.version_id,
        startId: start.id,
      };
      let scheduledAt: Date | null;
      try {
        scheduledAt = latestDueTick(start.on, now);
      } catch {
        outcomes.push({
          ...live,
          result: "failed",
          code: "start_schedule_invalid",
        });
        continue;
      }
      if (scheduledAt === null) continue;
      const repositoryId = start.inputs?.repositoryId;
      if (!namesRepository(start.inputs) || typeof repositoryId !== "string") {
        outcomes.push({
          ...live,
          result: "failed",
          code: "start_repository_missing",
        });
        continue;
      }
      try {
        outcomes.push(
          await withPgTransaction(
            options.database,
            (transaction) =>
              fireStart(
                transaction,
                row.organization_id,
                { scheduledAt },
                { id: repositoryId },
                live,
              ),
          ),
        );
      } catch (error) {
        failures.push(
          `${row.workflow_id}/${start.id} ${
            error instanceof Error ? error.message : String(error)
          }`
            .slice(0, 200),
        );
      }
    }
  }
  if (failures.length > 0) throw new StartClockFailures(failures);
  return outcomes;
}

export function createStartClockFunction(
  options: { database: PgDatabase; client: Inngest },
) {
  return options.client.createFunction(
    {
      id: START_CLOCK_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) =>
      await step.run(
        "fire-due-schedule-starts",
        async () => await fireDueScheduleStarts({ database: options.database }),
      ),
  );
}
