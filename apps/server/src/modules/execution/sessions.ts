import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgTransactionClient,
} from "@bakery/persistence";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  adapterSupportsSteering,
  readAdapterCapabilities,
  type SteeringMode,
} from "./adapter-capabilities.ts";
import { enqueueWorkerControlCommand } from "./coordination.ts";

type SessionRow = {
  id: string;
  run_step_id: string | null;
  conversation_id: string;
  agent_version_id: string;
  harness: string;
  status: string;
  resume_ref: unknown;
  parent_session_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type LiveAttempt = { attemptId: string; adapterCapabilities: unknown };

const SESSION_COLUMNS =
  `session.id, session.run_step_id, session.conversation_id,
   session.agent_version_id, session.harness, session.status,
   session.resume_ref, session.parent_session_id, session.created_at,
   session.updated_at, session.version`;

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function sessionId(context: ActionContext): string {
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return id;
}

/** Worker harness sessions only: coordinator sessions have no run step. */
async function loadSession(
  transaction: PgTransactionClient,
  organizationId: string,
  id: string,
): Promise<SessionRow> {
  const result = await transaction.query<SessionRow>(
    `select ${SESSION_COLUMNS}
       from bakery.agent_sessions session
      where session.organization_id = $1 and session.id = $2
        and session.run_step_id is not null`,
    [organizationId, id],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

async function liveAttempt(
  transaction: PgTransactionClient,
  organizationId: string,
  runStepId: string,
): Promise<LiveAttempt | undefined> {
  const result = await transaction.query<LiveAttempt>(
    `select attempt.id as "attemptId",
            host.adapter_capabilities as "adapterCapabilities"
       from bakery.jobs job
       join bakery.job_attempts attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id
       join bakery.worker_hosts host
         on host.organization_id = attempt.organization_id
        and host.id = attempt.worker_host_id
      where job.organization_id = $1 and job.run_step_id = $2
        and attempt.status in ('leased', 'running')
        and job.current_fence = attempt.fence
      order by attempt.attempt_no desc, attempt.id desc
      limit 1`,
    [organizationId, runStepId],
  );
  return result.rows[0];
}

export async function getAgentSession(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const row = await loadSession(
    transaction,
    organizationId,
    sessionId(context),
  );
  const attempt = await liveAttempt(
    transaction,
    organizationId,
    row.run_step_id!,
  );
  return contractSchemas.AgentSession.parse({
    id: row.id,
    runStepId: row.run_step_id,
    conversationId: row.conversation_id,
    agentVersionId: row.agent_version_id,
    harness: row.harness,
    status: row.status,
    resumeRef: row.resume_ref ?? null,
    parentSessionId: row.parent_session_id,
    adapterCapabilities: readAdapterCapabilities(attempt?.adapterCapabilities),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  });
}

type MessageRow = {
  id: string;
  conversation_id: string;
  author_id: string | null;
  agent_session_id: string | null;
  message_type: string;
  body: string;
  client_message_id: string;
  reply_to_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  sequence: string;
  intent: string;
  comment_context: unknown | null;
};

const MESSAGE_COLUMNS = `id, conversation_id, author_id, agent_session_id,
  message_type, body, client_message_id, reply_to_id, created_at, updated_at,
  version, sequence::text, intent, comment_context`;

function toMessage(row: MessageRow) {
  return contractSchemas.Message.parse({
    id: row.id,
    conversationId: row.conversation_id,
    authorId: row.author_id,
    agentSessionId: row.agent_session_id,
    messageType: row.message_type,
    body: row.body,
    clientMessageId: row.client_message_id,
    replyToId: row.reply_to_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
    sequence: row.sequence,
    intent: row.intent,
    commentContext: row.comment_context,
  });
}

/**
 * Steers or follows up a worker session. The message is recorded once per
 * `clientMessageId` and bound to one worker command, so a duplicate request
 * never produces a second prompt. A mode the worker session did not advertise
 * returns an explicit `unsupported` conflict and writes nothing.
 */
export async function steerAgentSession(
  context: ActionContext,
  rawInput: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as z.output<typeof contractSchemas.SteeringMessage>;
  // Legacy aliases: "interrupt" steers, "append" queues a follow-up.
  const mode: SteeringMode =
    input.mode === "follow_up" || input.mode === "append"
      ? "follow_up"
      : "steer";
  const clientMessageId = input.clientMessageId ??
    requireCommandMetadata(context).idempotencyKey;
  const session = await loadSession(
    transaction,
    organizationId,
    sessionId(context),
  );

  // Conversation first, then command locks: the same order message admission uses.
  await transaction.query(
    `select 1 from bakery.conversations
      where organization_id = $1 and id = $2 for update`,
    [organizationId, session.conversation_id],
  );
  const replay = await transaction.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from bakery.messages
      where organization_id = $1 and conversation_id = $2
        and author_id = $3 and client_message_id = $4`,
    [
      organizationId,
      session.conversation_id,
      principalId,
      clientMessageId,
    ],
  );
  const existing = replay.rows[0];
  if (existing) {
    if (existing.body !== input.body || existing.message_type !== "user") {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    return toMessage(existing);
  }

  const attempt = await liveAttempt(
    transaction,
    organizationId,
    session.run_step_id!,
  );
  if (!attempt) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "no_active_attempt" },
    });
  }
  if (
    !adapterSupportsSteering(
      mode,
      readAdapterCapabilities(attempt.adapterCapabilities),
    )
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "unsupported", mode },
    });
  }

  const next = await transaction.query<{ sequence: string }>(
    `select (coalesce(max(sequence), 0) + 1)::text as sequence
       from bakery.messages
      where organization_id = $1 and conversation_id = $2`,
    [organizationId, session.conversation_id],
  );
  const sequence = next.rows[0]?.sequence;
  if (!sequence) throw new Error("MESSAGE_SEQUENCE_UNAVAILABLE");
  const inserted = await transaction.query<MessageRow>(
    `insert into bakery.messages (
       organization_id, conversation_id, author_id, message_type, body,
       client_message_id, sequence, intent
     ) values ($1, $2, $3, 'user', $4, $5, $6, 'discussion')
     returning ${MESSAGE_COLUMNS}`,
    [
      organizationId,
      session.conversation_id,
      principalId,
      input.body,
      clientMessageId,
      sequence,
    ],
  );
  const message = inserted.rows[0];
  if (!message) throw new Error("MESSAGE_INSERT_FAILED");

  const metadata = requireCommandMetadata(context);
  await enqueueWorkerControlCommand(transaction, {
    organizationId,
    attemptId: attempt.attemptId,
    action: mode === "steer" ? "steer_message" : "follow_up_message",
    messageId: message.id,
    body: input.body,
    idempotencyKey: metadata.idempotencyKey,
    requestDigest: await sha256Hex(canonicalJson({
      sessionId: session.id,
      mode,
      clientMessageId: clientMessageId,
      body: input.body,
    })),
    traceId: context.traceId,
  });

  const scope = await transaction.query<
    { application_id: string | null; repository_id: string | null }
  >(
    `select application_id, repository_id from bakery.conversations
      where organization_id = $1 and id = $2`,
    [organizationId, session.conversation_id],
  );
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.rows[0]?.application_id ?? null,
    repositoryId: scope.rows[0]?.repository_id ?? null,
    conversationId: session.conversation_id,
    eventType: "session.steering_requested",
    aggregateId: message.id,
    aggregateVersion: 1,
    payload: { sessionId: session.id, messageId: message.id },
    traceId: context.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "sessions.steer",
    resourceType: "agent_session",
    resourceId: session.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { messageId: message.id, mode },
  });
  return toMessage(message);
}
