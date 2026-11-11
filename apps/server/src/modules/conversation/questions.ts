import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "@bakery/persistence";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import type { CoordinatorEffect } from "./coordinator.ts";
import {
  hasQueuedTurnCapacity,
  lockConversationScope,
  resolveCoordinatorAgentVersion,
} from "./postgres.ts";

/** Seven days: a question nobody answers must not block a conversation forever. */
export const DEFAULT_QUESTION_TTL_SECONDS = 7 * 24 * 60 * 60;

type QuestionEffect = Extract<CoordinatorEffect, { type: "question" }>;

type QuestionOption = { id: string; label: string };
type Audience =
  | { type: "task_participants" }
  | { type: "principals"; principalIds: string[] };

type QuestionRow = {
  id: string;
  kind: string;
  conversation_id: string;
  task_id: string;
  run_id: string | null;
  turn_id: string | null;
  generation: number;
  prompt: string;
  options: QuestionOption[] | null;
  allow_free_text: boolean;
  audience: Audience;
  expires_at: Date | string | null;
  status: string;
  answer: unknown | null;
  answered_by: string | null;
  answered_at: Date | string | null;
  answer_digest: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

/** Open questions past their deadline read as expired before the sweep runs. */
const EFFECTIVE_STATUS = `case when q.status = 'open'
    and q.expires_at is not null and q.expires_at <= now()
  then 'expired' else q.status end`;

const COLUMNS = `q.id, q.kind, q.conversation_id, q.task_id, q.run_id,
  q.turn_id, q.generation, q.prompt, q.options, q.allow_free_text, q.audience,
  q.expires_at, ${EFFECTIVE_STATUS} as status, q.answer, q.answered_by,
  q.answered_at, q.answer_digest, q.created_at, q.updated_at, q.version`;

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

export function toQuestion(row: QuestionRow) {
  return contractSchemas.Question.parse({
    id: row.id,
    kind: row.kind,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    runId: row.run_id,
    turnId: row.turn_id,
    generation: row.generation,
    prompt: row.prompt,
    responseSchema: null,
    options: row.options,
    allowFreeText: row.allow_free_text,
    audience: row.audience,
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    status: row.status,
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at === null ? null : iso(row.answered_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  });
}

export type ScopeFacts = {
  application_id: string | null;
  repository_id: string | null;
  task_id: string | null;
};

export async function scopeOf(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
): Promise<ScopeFacts> {
  const result = await transaction.query<ScopeFacts>(
    `select conversation.application_id, conversation.repository_id,
            (select task.id from bakery.tasks task
              where task.organization_id = conversation.organization_id
                and task.conversation_id = conversation.id
              order by task.created_at asc, task.id asc limit 1) as task_id
       from bakery.conversations conversation
      where conversation.organization_id = $1 and conversation.id = $2`,
    [organizationId, conversationId],
  );
  return result.rows[0] ??
    { application_id: null, repository_id: null, task_id: null };
}

/** Task the conversation belongs to; questions are task-scoped. */
export async function taskIdForConversation(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
): Promise<string | null> {
  return (await scopeOf(transaction, organizationId, conversationId)).task_id;
}

/**
 * Generation of a turn: the number of turns admitted up to and including it.
 * A question or approval is bound to the generation of its asking turn.
 */
export async function turnGeneration(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
  turnId: string,
): Promise<number> {
  const generation = await transaction.query<{ generation: number }>(
    `select count(*)::int as generation
       from bakery.conversation_turns turn
       join bakery.messages message
         on message.organization_id = turn.organization_id
        and message.conversation_id = turn.conversation_id
        and message.id = turn.trigger_message_id
      where turn.organization_id = $1 and turn.conversation_id = $2
        and message.sequence <= (
          select asking.sequence
            from bakery.conversation_turns asked
            join bakery.messages asking
              on asking.organization_id = asked.organization_id
             and asking.conversation_id = asked.conversation_id
             and asking.id = asked.trigger_message_id
           where asked.organization_id = $1 and asked.id = $3)`,
    [organizationId, conversationId, turnId],
  );
  return generation.rows[0]?.generation ?? 1;
}

/**
 * Creates the questions a completed turn asked, inside the turn's
 * transaction. Each is bound to the asking turn and its generation: the
 * number of turns admitted up to and including the asking turn.
 */
export async function createQuestionsForTurn(
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    conversationId: string;
    turnId: string;
    effects: readonly CoordinatorEffect[];
  },
): Promise<void> {
  const questions = facts.effects.filter((effect): effect is QuestionEffect =>
    effect.type === "question"
  );
  if (questions.length === 0) return;
  const scope = await scopeOf(
    transaction,
    facts.organizationId,
    facts.conversationId,
  );
  if (scope.task_id === null) throw new Error("QUESTION_TASK_REQUIRED");
  const asked = await turnGeneration(
    transaction,
    facts.organizationId,
    facts.conversationId,
    facts.turnId,
  );
  for (const question of questions) {
    const options = question.options ?? null;
    const inserted = await transaction.query<{ id: string }>(
      `insert into bakery.questions (
         organization_id, kind, conversation_id, task_id, turn_id, generation,
         prompt, options, allow_free_text, audience, expires_at
       ) values ($1, 'question', $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb,
         now() + ($10 || ' seconds')::interval)
       returning id`,
      [
        facts.organizationId,
        facts.conversationId,
        scope.task_id,
        facts.turnId,
        asked,
        question.prompt,
        options === null ? null : JSON.stringify(options),
        question.allowFreeText ?? options === null,
        JSON.stringify(question.audience ?? { type: "task_participants" }),
        String(question.expiresInSeconds ?? DEFAULT_QUESTION_TTL_SECONDS),
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("QUESTION_INSERT_FAILED");
    await appendDomainEvent(transaction, {
      organizationId: facts.organizationId,
      applicationId: scope.application_id,
      repositoryId: scope.repository_id,
      taskId: scope.task_id,
      conversationId: facts.conversationId,
      eventType: "question.opened",
      aggregateId: id,
      aggregateVersion: 1,
      payload: { questionId: id, conversationId: facts.conversationId },
      traceId: crypto.randomUUID(),
    });
    await appendAudit(transaction, {
      organizationId: facts.organizationId,
      principalId: null,
      operation: "questions.create",
      resourceType: "question",
      resourceId: id,
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      details: { conversationId: facts.conversationId, turnId: facts.turnId },
    });
  }
}

/** Open questions still awaiting an answer, for the coordinator's context. */
export async function readOpenQuestions(
  database: PgDatabase,
  organizationId: string,
  conversationId: string,
): Promise<readonly unknown[]> {
  const result = await database.query<QuestionRow>(
    `select ${COLUMNS} from bakery.questions q
      where q.organization_id = $1 and q.conversation_id = $2
        and q.kind = 'question' and q.status = 'open'
        and (q.expires_at is null or q.expires_at > now())
      order by q.created_at asc, q.id asc limit 20`,
    [organizationId, conversationId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    options: row.options,
    allowFreeText: row.allow_free_text,
  }));
}

export function createQuestionsListHandler(secret: string) {
  return async (context: ActionContext, rawInput: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const input = rawInput as {
      cursor?: string;
      limit?: number;
      taskId?: string;
      conversationId?: string;
      status?: string;
    };
    const binding: CursorBinding = {
      action: "questions.list",
      principalId,
      organizationId,
      ordering: "createdAt:desc,id:desc",
      filters: canonicalJson({
        taskId: input.taskId ?? null,
        conversationId: input.conversationId ?? null,
        status: input.status ?? null,
      }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<
      QuestionRow & { cursor_created_at: string }
    >(
      `select ${COLUMNS},
              to_char(q.created_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from bakery.questions q
        where q.organization_id = $1 and q.kind = 'question'
          and ($2::uuid is null or q.task_id = $2)
          and ($3::uuid is null or q.conversation_id = $3)
          and ($4::text is null or (${EFFECTIVE_STATUS}) = $4)
          and ($5::timestamptz is null or (q.created_at, q.id) < ($5, $6::uuid))
          and (q.audience ->> 'type' <> 'principals'
               or q.audience -> 'principalIds' @> to_jsonb($8::text))
        order by q.created_at desc, q.id desc
        limit $7`,
      [
        organizationId,
        input.taskId ?? null,
        input.conversationId ?? null,
        input.status ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
        principalId,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toQuestion),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

async function loadQuestion(
  transaction: PgTransactionClient,
  organizationId: string,
  id: string,
  lock = false,
): Promise<QuestionRow> {
  const result = await transaction.query<QuestionRow>(
    `select ${COLUMNS} from bakery.questions q
      where q.organization_id = $1 and q.id = $2${
      lock ? " for update of q" : ""
    }`,
    [organizationId, id],
  );
  const row = result.rows[0];
  if (!row) notFound();
  return row;
}

export async function getQuestion(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = context.params.id;
  if (!id) notFound();
  const row = await loadQuestion(transaction, organizationId, id);
  // Approvals are read through approvals.get; they are not plain questions.
  if (row.kind !== "question") notFound();
  // A question private to named principals is invisible to everyone else.
  if (
    row.audience.type === "principals" &&
    !row.audience.principalIds.includes(principalId)
  ) notFound();
  return toQuestion(row);
}

type AnswerBody = { optionId?: string; text?: string };

function normalizeAnswer(row: QuestionRow, raw: unknown): AnswerBody {
  const invalid = (): never => {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "answer" },
    });
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "optionId" && key !== "text")
  ) invalid();
  const answer: AnswerBody = {};
  if (record.optionId !== undefined) {
    const options = row.options ?? [];
    if (
      typeof record.optionId !== "string" ||
      !options.some((option) => option.id === record.optionId)
    ) invalid();
    answer.optionId = record.optionId as string;
  }
  if (record.text !== undefined) {
    if (
      typeof record.text !== "string" || record.text.trim().length === 0 ||
      record.text.length > 4000 ||
      (row.options !== null && !row.allow_free_text)
    ) invalid();
    answer.text = (record.text as string).trim();
  }
  if (row.options === null && answer.text === undefined) invalid();
  return answer;
}

function describeAnswer(row: QuestionRow, answer: AnswerBody): string {
  const label = answer.optionId === undefined
    ? undefined
    : row.options?.find((option) => option.id === answer.optionId)?.label;
  return [label, answer.text].filter((part) => part !== undefined).join(": ");
}

/**
 * First-answer compare-and-swap. The first valid answer from an eligible
 * principal wins; an identical replay returns the stored answer; a different
 * later answer, or any answer once the question expired, fails without effect.
 */
export async function answerQuestion(
  context: ActionContext,
  rawInput: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = context.params.id;
  if (!id) notFound();
  const input = rawInput as z.output<typeof contractSchemas.QuestionAnswer>;
  const peek = await loadQuestion(transaction, organizationId, id);
  // Same refusal as questions.get, ahead of the kind check and the archived
  // refusal below: a non-audience caller cannot confirm the item exists,
  // whatever its kind or conversation state.
  if (
    peek.audience.type === "principals" &&
    !peek.audience.principalIds.includes(principalId)
  ) notFound();
  // Archived conversation, application or repository refuse answers like
  // messages.create; this also takes the conversation lock first, then the
  // question row, the order turn admission uses.
  await lockConversationScope(
    transaction,
    organizationId,
    peek.conversation_id,
    "update",
  );
  const row = await loadQuestion(transaction, organizationId, id, true);
  // Approvals are decided through approvals.decide, never answered as questions.
  if (row.kind !== "question") conflict("question_kind_unsupported");
  const answer = normalizeAnswer(row, input.answer);
  const digest = await sha256Hex(canonicalJson(answer));
  if (row.status === "answered") {
    if (row.answer_digest === digest) return toQuestion(row);
    conflict("question_answered");
  }
  if (row.status !== "open") conflict(`question_${row.status}`);

  const updated = await transaction.query<QuestionRow>(
    `update bakery.questions q
        set status = 'answered', answer = $3::jsonb, answered_by = $4,
            answered_at = now(), answer_digest = $5, updated_at = now(),
            version = version + 1
      where q.organization_id = $1 and q.id = $2 and q.status = 'open'
        and (q.expires_at is null or q.expires_at > now())
      returning ${COLUMNS}`,
    [organizationId, id, JSON.stringify(answer), principalId, digest],
  );
  const answered = updated.rows[0];
  if (!answered) conflict("question_unavailable");

  const scope = await scopeOf(
    transaction,
    organizationId,
    answered.conversation_id,
  );
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.application_id,
    repositoryId: scope.repository_id,
    taskId: scope.task_id,
    conversationId: answered.conversation_id,
    eventType: "question.answered",
    aggregateId: answered.id,
    aggregateVersion: answered.version,
    payload: { questionId: answered.id, runId: answered.run_id },
    traceId: context.traceId,
  });
  const resumed = await resumeCurrentGeneration(transaction, {
    organizationId,
    principalId,
    question: answered,
    answerText: describeAnswer(answered, answer),
    scope,
    traceId: context.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "questions.answer",
    resourceType: "question",
    resourceId: answered.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { conversationId: answered.conversation_id, resumed },
  });
  return toQuestion(answered);
}

/**
 * Answer path: queues the single follow-up for the asking turn once every
 * sibling question is settled (see {@link resumeAskingTurn}).
 */
async function resumeCurrentGeneration(
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    principalId: string;
    question: QuestionRow;
    answerText: string;
    scope: ScopeFacts;
    traceId: string;
  },
): Promise<boolean> {
  const { question } = facts;
  if (question.turn_id === null) return false;
  return await resumeAskingTurn(transaction, {
    organizationId: facts.organizationId,
    conversationId: question.conversation_id,
    turnId: question.turn_id,
    generation: question.generation,
    authorId: facts.principalId,
    scope: facts.scope,
    traceId: facts.traceId,
  });
}

/**
 * Queues exactly one follow-up turn for an asking turn, only while it is still
 * the conversation's latest generation, once every sibling question is settled
 * and at least one was answered. Lists answered siblings and notes expired
 * ones. Idempotent: the turn row is locked to serialize a racing last answer
 * and expiry sweep, and the message id is stable per asking turn.
 */
async function resumeAskingTurn(
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    conversationId: string;
    turnId: string;
    generation: number;
    authorId: string | null;
    scope: ScopeFacts;
    traceId: string;
  },
): Promise<boolean> {
  const { organizationId, conversationId, turnId } = facts;
  await transaction.query(
    `select 1 from bakery.conversation_turns
      where organization_id = $1 and id = $2 for update`,
    [organizationId, turnId],
  );
  // Never queue work in an archived conversation, application or repository.
  const archived = await transaction.query(
    `select 1 from bakery.conversations c
       left join bakery.applications a
         on a.organization_id = c.organization_id and a.id = c.application_id
       left join bakery.repositories r
         on r.organization_id = c.organization_id and r.id = c.repository_id
      where c.organization_id = $1 and c.id = $2
        and (c.archived_at is not null or a.archived_at is not null
             or r.archived_at is not null)`,
    [organizationId, conversationId],
  );
  if (archived.rows.length > 0) return false;
  const turns = await transaction.query<{ count: number }>(
    `select count(*)::int as count from bakery.conversation_turns
      where organization_id = $1 and conversation_id = $2`,
    [organizationId, conversationId],
  );
  if ((turns.rows[0]?.count ?? 0) !== facts.generation) return false;
  const stillOpen = await transaction.query(
    `select 1 from bakery.questions
      where organization_id = $1 and conversation_id = $2 and turn_id = $3
        and kind = 'question'
        and status = 'open' and (expires_at is null or expires_at > now())
      limit 1`,
    [organizationId, conversationId, turnId],
  );
  if (stillOpen.rows.length > 0) return false;
  const siblings = await transaction.query<QuestionRow>(
    `select ${COLUMNS} from bakery.questions q
      where q.organization_id = $1 and q.conversation_id = $2
        and q.turn_id = $3 and q.kind = 'question'
      order by q.created_at asc, q.id asc`,
    [organizationId, conversationId, turnId],
  );
  const answered = siblings.rows.filter((row) => row.status === "answered");
  if (answered.length === 0) return false;
  const clientMessageId = `question-turn:${turnId}:answers`;
  const existing = await transaction.query(
    `select 1 from bakery.messages
      where organization_id = $1 and conversation_id = $2
        and client_message_id = $3 limit 1`,
    [organizationId, conversationId, clientMessageId],
  );
  if (existing.rows.length > 0) return false;
  const lines = answered.map((row) =>
    `Answer to question "${row.prompt}": ${
      describeAnswer(row, row.answer as AnswerBody)
    }`
  );
  for (const row of siblings.rows) {
    if (row.status === "expired") {
      lines.push(`Question "${row.prompt}" expired without an answer.`);
    }
  }
  const authorId = facts.authorId ??
    answered.find((row) => row.answered_by !== null)?.answered_by ?? null;
  if (authorId === null) return false;
  await queueAgentRequest(transaction, {
    organizationId,
    conversationId,
    authorId,
    body: lines.join("\n"),
    clientMessageId,
    scope: facts.scope,
    traceId: facts.traceId,
  });
  return true;
}

/**
 * Appends a system message with the `agent_request` intent and queues exactly
 * one coordinator turn for it, inside the caller's transaction. Used for
 * question answers, the expiry sweep and approval change requests; every
 * caller holds the conversation row lock (message sequence and queue cap).
 * A full queue refuses like `messages.create` does.
 */
export async function queueAgentRequest(
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    conversationId: string;
    authorId: string;
    body: string;
    clientMessageId: string;
    scope: ScopeFacts;
    traceId: string;
  },
): Promise<void> {
  const { organizationId } = facts;
  if (
    !await hasQueuedTurnCapacity(
      transaction,
      organizationId,
      facts.conversationId,
    )
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "conversation_queue_full" },
    });
  }
  const agentVersionId = await resolveCoordinatorAgentVersion(
    transaction,
    organizationId,
  );
  const next = await transaction.query<{ sequence: string }>(
    `select (coalesce(max(sequence), 0) + 1)::text as sequence
       from bakery.messages
      where organization_id = $1 and conversation_id = $2`,
    [organizationId, facts.conversationId],
  );
  const sequence = next.rows[0]?.sequence;
  if (!sequence) throw new Error("MESSAGE_SEQUENCE_UNAVAILABLE");
  const message = await transaction.query<{ id: string }>(
    `insert into bakery.messages (
       organization_id, conversation_id, author_id, message_type, body,
       client_message_id, sequence, intent
     ) values ($1, $2, $3, 'system', $4, $5, $6, 'agent_request')
     returning id`,
    [
      organizationId,
      facts.conversationId,
      facts.authorId,
      facts.body,
      facts.clientMessageId,
      sequence,
    ],
  );
  const messageId = message.rows[0]?.id;
  if (!messageId) throw new Error("MESSAGE_INSERT_FAILED");
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: facts.scope.application_id,
    repositoryId: facts.scope.repository_id,
    conversationId: facts.conversationId,
    eventType: "conversation.message_created",
    aggregateId: messageId,
    aggregateVersion: 1,
    payload: {
      resourceId: messageId,
      resourceVersion: 1,
      conversationId: facts.conversationId,
      messageSequence: sequence,
      intent: "agent_request",
    },
    traceId: facts.traceId,
  });
  const turn = await transaction.query<{ id: string }>(
    `insert into bakery.conversation_turns (
       organization_id, conversation_id, trigger_message_id, status,
       context_through_sequence, agent_version_id
     ) values ($1, $2, $3, 'queued', $4, $5)
     returning id`,
    [
      organizationId,
      facts.conversationId,
      messageId,
      sequence,
      agentVersionId,
    ],
  );
  const turnId = turn.rows[0]?.id;
  if (!turnId) throw new Error("CONVERSATION_TURN_INSERT_FAILED");
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: facts.scope.application_id,
    repositoryId: facts.scope.repository_id,
    conversationId: facts.conversationId,
    eventType: "conversation.turn_changed",
    aggregateId: turnId,
    aggregateVersion: 1,
    payload: {
      resourceId: turnId,
      resourceVersion: 1,
      conversationId: facts.conversationId,
      triggerMessageId: messageId,
      status: "queued",
    },
    traceId: facts.traceId,
    outboxDeliveryKey:
      `conversation:${facts.conversationId}:turn:${turnId}:version:1`,
  });
}

/**
 * Marks open questions past their deadline expired. Lock order matches the
 * answer and message paths: the conversation row first, then its questions
 * and asking turns, so a follow-up turn gets a unique message sequence.
 * Conversations are taken in id order, so concurrent sweeps serialize; a
 * sweep that finds the questions already expired changes nothing. While a
 * conversation's turn queue is full its due questions stay for a later sweep
 * (reads and answers already treat them as expired) rather than queue past
 * the cap.
 */
export async function expireDueQuestions(
  database: PgDatabase,
  limit = 100,
): Promise<number> {
  return await withPgTransaction(database, async (transaction) => {
    const due = await transaction.query<
      { id: string; organization_id: string; conversation_id: string }
    >(
      `select id, organization_id, conversation_id from bakery.questions
        where status = 'open' and expires_at <= now()
        order by expires_at asc, id asc
        limit $1`,
      [limit],
    );
    const byConversation = new Map<
      string,
      { organizationId: string; conversationId: string; ids: string[] }
    >();
    for (const row of due.rows) {
      const key = `${row.organization_id}:${row.conversation_id}`;
      const entry = byConversation.get(key) ??
        {
          organizationId: row.organization_id,
          conversationId: row.conversation_id,
          ids: [],
        };
      entry.ids.push(row.id);
      byConversation.set(key, entry);
    }
    let count = 0;
    const conversations = [...byConversation.values()].sort((left, right) =>
      left.conversationId < right.conversationId
        ? -1
        : left.conversationId > right.conversationId
        ? 1
        : 0
    );
    for (const conversation of conversations) {
      count += await expireConversationQuestions(transaction, conversation);
    }
    return count;
  });
}

async function expireConversationQuestions(
  transaction: PgTransactionClient,
  conversation: {
    organizationId: string;
    conversationId: string;
    ids: readonly string[];
  },
): Promise<number> {
  const { organizationId, conversationId } = conversation;
  const locked = await transaction.query(
    `select id from bakery.conversations
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, conversationId],
  );
  if (locked.rows.length !== 1) return 0;
  if (
    !await hasQueuedTurnCapacity(transaction, organizationId, conversationId)
  ) return 0;
  const expired = await transaction.query<
    {
      id: string;
      version: number;
      turn_id: string | null;
      generation: number;
      kind: string;
    }
  >(
    `update bakery.questions q
        set status = 'expired', updated_at = now(), version = version + 1
      where q.organization_id = $1 and q.conversation_id = $2
        and q.id = any($3::uuid[])
        and q.status = 'open' and q.expires_at <= now()
      returning q.id, q.version, q.turn_id, q.generation, q.kind`,
    [organizationId, conversationId, conversation.ids],
  );
  if (expired.rows.length === 0) return 0;
  const scope = await scopeOf(transaction, organizationId, conversationId);
  for (const row of expired.rows) {
    const isApproval = row.kind === "approval";
    await appendDomainEvent(transaction, {
      organizationId,
      applicationId: scope.application_id,
      repositoryId: scope.repository_id,
      taskId: scope.task_id,
      conversationId,
      eventType: isApproval ? "approval.expired" : "question.expired",
      aggregateId: row.id,
      aggregateVersion: row.version,
      payload: isApproval
        ? { resourceId: row.id, resourceVersion: row.version }
        : { questionId: row.id },
      traceId: crypto.randomUUID(),
    });
    await appendAudit(transaction, {
      organizationId,
      principalId: null,
      operation: isApproval ? "approvals.expire" : "questions.expire",
      resourceType: isApproval ? "approval" : "question",
      resourceId: row.id,
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      details: { conversationId },
    });
  }
  const settled = new Set<string>();
  for (const row of expired.rows) {
    if (
      row.kind !== "question" || row.turn_id === null ||
      settled.has(row.turn_id)
    ) continue;
    settled.add(row.turn_id);
    await resumeAskingTurn(transaction, {
      organizationId,
      conversationId,
      turnId: row.turn_id,
      generation: row.generation,
      authorId: null,
      scope,
      traceId: crypto.randomUUID(),
    });
  }
  return expired.rows.length;
}
