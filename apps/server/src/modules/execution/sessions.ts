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
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  DECISION_NOTE_MAX_LENGTH,
  isStorableDecisionText,
} from "@bakery/contracts/human-approval";
import { appendDecision } from "../work/human-approval-store.ts";
import { DEFAULT_AGENT_SPAWN } from "@bakery/config";
import type { AgentSpawnConfig } from "@bakery/config";
import {
  admitAgentSteer,
  steerRecordDetail,
  stepIsReviewer,
} from "../work/agent-steer.ts";
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

type SessionListInput = {
  runStepId: string;
  cursor?: string;
  limit?: number;
};

/**
 * The agent sessions that belong to one run step.
 *
 * A client that has a run step cannot otherwise reach a session: the by-id read
 * needs an id it already knows. This lists them in the same stable order the
 * cursor is bound to, so a caller walking a long step never sees a gap or a
 * repeat. A step in another organization answers 404 rather than an empty page,
 * so the route cannot be used to learn that a step exists.
 */
export function createSessionListHandler(secret: string) {
  return async function listAgentSessions(
    context: ActionContext,
    rawInput: unknown,
  ) {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const input = rawInput as SessionListInput;
    const runStepId = input.runStepId;

    const step = await transaction.query<{ id: string }>(
      `select id from bakery.run_steps
      where organization_id = $1 and id = $2`,
      [organizationId, runStepId],
    );
    if (step.rows.length === 0) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }

    const cursorBinding: CursorBinding = {
      action: "sessions.list",
      organizationId,
      principalId,
      ordering: "createdAt:asc,id:asc",
      filters: `runStep:${runStepId}`,
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, cursorBinding);
    const limit = input.limit ?? 25;

    const result = await transaction.query<SessionRow>(
      `select ${SESSION_COLUMNS}
       from bakery.agent_sessions session
      where session.organization_id = $1
        and session.run_step_id = $2
        and (
          $3::timestamptz is null or
          (session.created_at, session.id) > ($3::timestamptz, $4::uuid)
        )
      order by session.created_at asc, session.id asc
      limit $5`,
      [
        organizationId,
        runStepId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );

    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return contractSchemas.AgentSessionPage.parse({
      items: await Promise.all(visible.map(async (row) => {
        const attempt = row.run_step_id === null
          ? undefined
          : await liveAttempt(transaction, organizationId, row.run_step_id);
        return {
          id: row.id,
          runStepId: row.run_step_id,
          conversationId: row.conversation_id,
          agentVersionId: row.agent_version_id,
          harness: row.harness,
          status: row.status,
          resumeRef: row.resume_ref ?? null,
          parentSessionId: row.parent_session_id,
          adapterCapabilities: readAdapterCapabilities(
            attempt?.adapterCapabilities,
          ),
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
          version: row.version,
        };
      })),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, cursorBinding, {
          createdAt: iso(last.created_at),
          id: last.id,
        })
        : null,
    });
  };
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
 * The first DECISION_NOTE_MAX_LENGTH code units of a steer, never ending on a
 * high surrogate: slicing through an emoji would leave a lone surrogate, which
 * PostgreSQL jsonb rejects.
 */
function excerptForLedger(body: string): string {
  if (body.length <= DECISION_NOTE_MAX_LENGTH) return body;
  const last = body.charCodeAt(DECISION_NOTE_MAX_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff
    ? DECISION_NOTE_MAX_LENGTH - 1
    : DECISION_NOTE_MAX_LENGTH;
  return body.slice(0, end);
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
  limits: AgentSpawnConfig = DEFAULT_AGENT_SPAWN,
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
  // PostgreSQL jsonb rejects NUL and lone surrogates; refuse them at the door
  // as a 400 instead of failing the insert as a 500.
  if (!isStorableDecisionText(input.body)) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const clientMessageId = input.clientMessageId ??
    requireCommandMetadata(context).idempotencyKey;
  const session = await loadSession(
    transaction,
    organizationId,
    sessionId(context),
  );

  // An agent steers only a session of a run it spawned, only with the steer
  // grant, never a reviewer's, and within a bound; a person passes untouched.
  // Before the first write, so a refusal leaves no trace.
  const target = await transaction.query<{ run_id: string; step_key: string }>(
    `select step.run_id, step.step_key
       from bakery.run_steps as step
      where step.organization_id = $1 and step.id = $2`,
    [organizationId, session.run_step_id],
  );
  // The target step must resolve for everyone. A session with no step has no
  // run tree an agent could be admitted to, and a person's steer is just as
  // meaningless without the step it is recorded against. Admission then runs
  // for every caller (it is a no-op for a person), so there is no branch on which
  // an agent's steer reaches the ledger under a person's label.
  const targetRow = target.rows[0];
  if (!targetRow) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const admission = await admitAgentSteer(transaction, context, {
    organizationId,
    principalId,
    targetRunId: targetRow.run_id,
    targetStepKey: targetRow.step_key,
    limits,
  });
  const steersReviewer = await stepIsReviewer(
    transaction,
    organizationId,
    targetRow.run_id,
    targetRow.step_key,
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

  // Chapter 25 section 9: a steer is recorded in the work item's decisions
  // ledger before it is delivered, in the same transaction as the worker
  // command, so a delivered steer always has a ledger entry and a refused one
  // leaves none.
  const owner = await transaction.query<{ task_id: string; run_id: string }>(
    `select run.task_id, run.id as run_id
       from bakery.run_steps step
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id and run.id = step.run_id
      where step.organization_id = $1 and step.id = $2`,
    [organizationId, session.run_step_id],
  );
  const ownerRow = owner.rows[0];
  if (!ownerRow) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  await appendDecision(transaction, {
    organizationId,
    taskId: ownerRow.task_id,
    runId: ownerRow.run_id,
    kind: "steer",
    subjectKind: "session",
    subjectId: session.id,
    decidedBy: principalId,
    // The full text lives on the message; the ledger keeps a bounded excerpt
    // (its note limit) and the id to find the rest.
    text: excerptForLedger(input.body),
    detail: {
      mode,
      messageId: message.id,
      truncated: input.body.length > DECISION_NOTE_MAX_LENGTH,
      ...steerRecordDetail(principalId, admission, steersReviewer),
    },
  });

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
