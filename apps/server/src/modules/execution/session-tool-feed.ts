import type { PgTransactionClient } from "@bakery/persistence";
import { assignedAgentSessionSql } from "@bakery/persistence/claims";
import { allocateConversationFeedSequence } from "../conversation/feed-sequence.ts";

export type SessionToolFeedPhase = "started" | "completed" | "failed";

type ToolFeedEvent = Readonly<{
  organizationId: string;
  callId: string;
  phase: SessionToolFeedPhase;
  ok: boolean | null;
}>;

type ToolFeedScope = {
  conversation_id: string;
  agent_session_id: string;
};

export async function appendSessionToolFeedEvent(
  transaction: PgTransactionClient,
  event: ToolFeedEvent,
): Promise<void> {
  const scope = (await transaction.query<ToolFeedScope>(
    `select task.conversation_id,
            ${assignedAgentSessionSql("job")} as agent_session_id
       from bakery.tool_gateway_calls call
       join bakery.job_attempts attempt
         on attempt.organization_id = call.organization_id
        and attempt.id = call.attempt_id
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
       join bakery.tasks task
         on task.organization_id = run.organization_id
        and task.id = run.task_id
      where call.organization_id = $1 and call.id = $2`,
    [event.organizationId, event.callId],
  )).rows[0];
  if (scope === undefined || scope.agent_session_id === null) {
    throw new Error("TOOL_FEED_SCOPE_UNAVAILABLE");
  }
  const sequence = await allocateConversationFeedSequence(
    transaction,
    event.organizationId,
    scope.conversation_id,
  );
  await transaction.query(
    `insert into bakery.session_tool_feed_events (
       organization_id, conversation_id, agent_session_id,
       tool_gateway_call_id, sequence, phase, ok
     ) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id, tool_gateway_call_id, phase) do nothing`,
    [
      event.organizationId,
      scope.conversation_id,
      scope.agent_session_id,
      event.callId,
      sequence,
      event.phase,
      event.ok,
    ],
  );
}
