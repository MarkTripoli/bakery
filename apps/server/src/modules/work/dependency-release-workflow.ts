import type { Inngest } from "inngest";
import { INNGEST_EVENT_DEFINITIONS } from "@bakery/contracts/events";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import { releaseDependantsOfEndedTask } from "./coordination-projection.ts";

export const DEPENDENCY_RELEASE_FUNCTION_ID = "bakery-dependency-release";
const DEPENDENCY_RELEASE_EVENT =
  INNGEST_EVENT_DEFINITIONS["task.dependency_release_requested"].name;

type ReleaseRequest = {
  organizationId: string;
  taskId: string;
  traceId: string;
};

function releaseRequest(data: unknown): ReleaseRequest | null {
  if (!data || typeof data !== "object") return null;
  const record = data as {
    organizationId?: unknown;
    traceId?: unknown;
    payload?: { taskId?: unknown };
  };
  const taskId = record.payload?.taskId;
  if (
    typeof record.organizationId !== "string" || typeof taskId !== "string"
  ) return null;
  return {
    organizationId: record.organizationId,
    taskId,
    traceId: typeof record.traceId === "string"
      ? record.traceId
      : crypto.randomUUID(),
  };
}

/**
 * Releases the runs blocked on a task that ended, in a transaction of its
 * own (see `releaseDependantsOfEndedTask`). Idempotent, so a redelivered or
 * repeated request changes nothing.
 */
export async function runDependencyRelease(
  database: PgDatabase,
  request: ReleaseRequest,
): Promise<void> {
  await withPgTransaction(
    database,
    (transaction) => releaseDependantsOfEndedTask(transaction, request),
  );
}

/**
 * Consumer of `task.dependency_release_requested`, which every task-end path
 * writes through the outbox in the transaction that ended the task. Retries a
 * transient failure (a serialization or deadlock abort) from scratch.
 */
export function createDependencyReleaseWorkflow(
  options: Readonly<{ client: Inngest; database: PgDatabase }>,
) {
  return options.client.createFunction(
    {
      id: DEPENDENCY_RELEASE_FUNCTION_ID,
      retries: 5,
      triggers: [{ event: DEPENDENCY_RELEASE_EVENT }],
    },
    async ({ event, step }) => {
      const request = releaseRequest(event.data);
      if (!request) return { kind: "ignored" as const };
      await step.run(
        `release-dependants-${request.taskId}`,
        () => runDependencyRelease(options.database, request),
      );
      return { kind: "released" as const, taskId: request.taskId };
    },
  );
}
