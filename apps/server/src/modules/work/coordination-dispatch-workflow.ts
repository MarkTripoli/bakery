import type { Inngest } from "inngest";
import { INNGEST_EVENT_DEFINITIONS } from "@bakery/contracts/events";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import { dispatchReadyLanes } from "./coordination-dispatch.ts";

export const LANE_DISPATCH_FUNCTION_ID = "bakery-coordination-lane-dispatch";
const LANE_DISPATCH_EVENT =
  INNGEST_EVENT_DEFINITIONS["coordination.lanes_dispatch_requested"].name;

type DispatchRequest = {
  organizationId: string;
  planId: string;
  traceId: string;
};

function dispatchRequest(data: unknown): DispatchRequest | null {
  if (!data || typeof data !== "object") return null;
  const record = data as {
    organizationId?: unknown;
    traceId?: unknown;
    payload?: { planId?: unknown };
  };
  const planId = record.payload?.planId;
  if (
    typeof record.organizationId !== "string" || typeof planId !== "string"
  ) return null;
  return {
    organizationId: record.organizationId,
    planId,
    traceId: typeof record.traceId === "string"
      ? record.traceId
      : crypto.randomUUID(),
  };
}

/**
 * Starts the ready lanes of a plan in a transaction of its own (see
 * `dispatchReadyLanes`). Idempotent: a lane already started is not a ready lane,
 * so a redelivered or repeated request starts nothing twice.
 */
export async function runLaneDispatch(
  database: PgDatabase,
  request: DispatchRequest,
) {
  return await withPgTransaction(
    database,
    (transaction) => dispatchReadyLanes(transaction, request),
  );
}

/**
 * Consumer of `coordination.lanes_dispatch_requested`, which materializing a
 * plan and every lane's end write through the outbox. Retries a transient
 * failure (a serialization or deadlock abort) from scratch.
 */
export function createLaneDispatchWorkflow(
  options: Readonly<{ client: Inngest; database: PgDatabase }>,
) {
  return options.client.createFunction(
    {
      id: LANE_DISPATCH_FUNCTION_ID,
      retries: 5,
      triggers: [{ event: LANE_DISPATCH_EVENT }],
    },
    async ({ event, step }) => {
      const request = dispatchRequest(event.data);
      if (!request) return { kind: "ignored" as const };
      const result = await step.run(
        `dispatch-lanes-${request.planId}`,
        () => runLaneDispatch(options.database, request),
      );
      return { kind: "dispatched" as const, planId: request.planId, ...result };
    },
  );
}
