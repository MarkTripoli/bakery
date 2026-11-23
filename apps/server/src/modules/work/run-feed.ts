import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type CursorBinding,
  decodeSequenceIdCursor,
  encodeSequenceIdCursor,
} from "../../platform/cursor.ts";

/**
 * The tool feed of a run (#435): one item for each time a `tool.call` step
 * started a call and each time it settled, read forward from a cursor.
 *
 * A `tool.call` step has no agent session, so its calls cannot appear in a
 * session feed; the engine records them against the run instead. The reader
 * builds each item from named columns, so no column that is later added to the
 * table reaches the wire by accident. A recorded call carries no arguments and
 * no result, so there is nothing to redact and `redacted` is always false.
 */

type RunToolCallRow = {
  id: string;
  run_id: string;
  run_step_id: string;
  sequence: string;
  call_id: string;
  connection_id: string;
  tool_name: string;
  phase: "started" | "completed" | "failed";
  ok: boolean | null;
  failure_code: string | null;
  occurred_at: Date | string;
};

export type RunFeedPage = {
  items: {
    id: string;
    runId: string;
    runStepId: string;
    sequence: string;
    kind: "tool";
    occurredAt: string;
    redacted: boolean;
    tool: {
      callId: string;
      connectionId: string;
      name: string;
      phase: "started" | "completed" | "failed";
      ok: boolean | null;
      code: string | null;
    };
  }[];
  nextCursor: string | null;
};

function runFeedBinding(
  organizationId: string,
  principalId: string,
  runId: string,
): CursorBinding {
  return {
    action: "runs.feed",
    principalId,
    organizationId,
    ordering: "sequence:asc,id:asc",
    filters: `run:${runId}`,
    schemaVersion: 1,
  };
}

/** One page of a run's tool feed, oldest first, resumed by an opaque cursor. */
export async function readRunFeed(
  transaction: PgTransactionClient,
  input: Readonly<{
    secret: string;
    organizationId: string;
    principalId: string;
    runId: string;
    cursor: string | undefined;
    limit: number | undefined;
  }>,
): Promise<RunFeedPage> {
  const binding = runFeedBinding(
    input.organizationId,
    input.principalId,
    input.runId,
  );
  const position = await decodeSequenceIdCursor(
    input.secret,
    input.cursor,
    binding,
  );
  const limit = input.limit ?? 25;
  const result = await transaction.query<RunToolCallRow>(
    `select id, run_id, run_step_id, sequence::text, call_id, connection_id,
            tool_name, phase, ok, failure_code, occurred_at
       from bakery.run_tool_calls
      where organization_id = $1
        and run_id = $2
        and (
          $3::bigint is null or
          (sequence, id) > ($3::bigint, $4::uuid)
        )
      order by sequence asc, id asc
      limit $5`,
    [
      input.organizationId,
      input.runId,
      position?.sequence ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const visible = result.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => ({
      id: row.id,
      runId: row.run_id,
      runStepId: row.run_step_id,
      sequence: row.sequence,
      kind: "tool" as const,
      occurredAt:
        (row.occurred_at instanceof Date
          ? row.occurred_at
          : new Date(row.occurred_at)).toISOString(),
      redacted: false,
      tool: {
        callId: row.call_id,
        connectionId: row.connection_id,
        name: row.tool_name,
        phase: row.phase,
        ok: row.ok,
        code: row.failure_code,
      },
    })),
    nextCursor: result.rows.length > limit && last
      ? await encodeSequenceIdCursor(input.secret, binding, {
        sequence: last.sequence,
        id: last.id,
      })
      : null,
  };
}
