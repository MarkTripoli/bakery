import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";

/**
 * What the tool.call runner writes to a run's tool feed (#435). Each call is
 * recorded once when it first sends and once when it settles; a step looked at
 * again while its write is unproven records nothing more. The record names the
 * tool and the connection and how the call ended, never its arguments or its
 * result.
 */
export type ToolCallRecord = Readonly<{
  organizationId: string;
  runId: string;
  stepKey: string;
  iteration: number;
  /** The step's one effect key; the started and the settling record share it. */
  callId: string;
  connectionId: string;
  toolName: string;
  phase: "started" | "completed" | "failed";
  /** A fixed failure code, only for a failed call. */
  failureCode?: string;
}>;

export type ToolCallRecorder = (record: ToolCallRecord) => Promise<void>;

/**
 * Records into `bakery.run_tool_calls`. The row of one (run, call, phase) is
 * written once, so a replayed step is a no-op. A run with no row for the step
 * (the step was never admitted) records nothing: the feed describes steps that
 * exist.
 */
export function createPostgresToolCallRecorder(
  database: PgDatabase,
): ToolCallRecorder {
  return (record) =>
    withPgTransaction(database, async (transaction) => {
      await transaction.query(
        `insert into bakery.run_tool_calls (
           organization_id, run_id, run_step_id, call_id, connection_id,
           tool_name, phase, ok, failure_code
         )
         select step.organization_id, step.run_id, step.id, $5, $6,
                $7, $8, $9, $10
           from bakery.run_steps step
          where step.organization_id = $1 and step.run_id = $2
            and step.step_key = $3 and step.iteration = $4
         on conflict (run_id, call_id, phase) do nothing`,
        [
          record.organizationId,
          record.runId,
          record.stepKey,
          record.iteration,
          record.callId,
          record.connectionId,
          record.toolName,
          record.phase,
          record.phase === "started" ? null : record.phase === "completed",
          record.failureCode ?? null,
        ],
      );
    });
}
