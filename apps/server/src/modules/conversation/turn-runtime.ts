import type { Inngest } from "inngest";
import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgDatabase,
  type PgTransactionClient,
  sweepCoordinatorTurnJobs,
  withPgTransaction,
} from "@bakery/persistence";
import { organizationId as toOrganizationId } from "@bakery/contracts/contracts";
import { principalId as toPrincipalId } from "@bakery/contracts/contracts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import { authorize } from "../auth/application/authorize.ts";
import { lockConversationScope } from "./postgres.ts";
import { pushCoordinatorCancelToWorker } from "./coordinator-worker.ts";
import {
  proposePlanRevisions,
  readCurrentPlanContext,
} from "./plan-revisions.ts";
import {
  createQuestionsForTurn,
  expireDueQuestions,
  readOpenQuestions,
  taskIdForConversation,
} from "./questions.ts";
import type {
  CoordinatorEffect,
  CoordinatorTurnExecutor,
  CoordinatorTurnInput,
} from "./coordinator.ts";

export const TURN_EVENT = "bakery/conversation.turn_changed.v1";
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const MAX_CONTEXT_MESSAGES = 1_000;

type TurnStatus =
  | "queued"
  | "active"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "canceled";

export type TurnRuntimeOptions = Readonly<{
  database: PgDatabase;
  executor: CoordinatorTurnExecutor;
  leaseMs?: number;
  heartbeatMs?: number;
}>;

export type ClaimResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<
    { kind: "terminal"; turnId: string; status: TurnStatus; code: string }
  >
  | Readonly<{
    kind: "claimed";
    turnId: string;
    claimVersion: number;
  }>;

export type ProcessResult =
  | Readonly<{ kind: "none" | "busy" | "lost" }>
  | Readonly<{ kind: "processed"; turnId: string; status: TurnStatus }>;

type TurnRow = {
  id: string;
  trigger_message_id: string;
  status: TurnStatus;
  version: number;
  context_through_sequence: string | null;
  agent_version_id: string | null;
  lease_expired: boolean;
  author_id: string | null;
};

function problem(code: string, detail: string, status = 409) {
  return {
    type: "about:blank",
    title: "Conversation turn did not complete",
    status,
    detail,
    code,
    requestId: crypto.randomUUID(),
    retryable: false,
  };
}

async function remainingQueued(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
): Promise<boolean> {
  const result = await transaction.query(
    `select 1 from bakery.conversation_turns
      where organization_id = $1 and conversation_id = $2 and status = 'queued'
      limit 1`,
    [organizationId, conversationId],
  );
  return result.rows.length > 0;
}

type ScopeFacts = { applicationId: string | null; repositoryId: string | null };

async function emitTurnChanged(
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    conversationId: string;
    turnId: string;
    triggerMessageId: string;
    status: TurnStatus;
    version: number;
    scope: ScopeFacts;
    wake: boolean;
  },
): Promise<void> {
  await appendDomainEvent(transaction, {
    organizationId: facts.organizationId,
    applicationId: facts.scope.applicationId,
    repositoryId: facts.scope.repositoryId,
    conversationId: facts.conversationId,
    eventType: "conversation.turn_changed",
    aggregateId: facts.turnId,
    aggregateVersion: facts.version,
    payload: {
      resourceId: facts.turnId,
      resourceVersion: facts.version,
      conversationId: facts.conversationId,
      triggerMessageId: facts.triggerMessageId,
      status: facts.status,
    },
    traceId: crypto.randomUUID(),
    ...(facts.wake
      ? {
        outboxDeliveryKey:
          `conversation:${facts.conversationId}:turn:${facts.turnId}:version:${facts.version}`,
      }
      : {}),
  });
}

async function scopeFacts(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
): Promise<ScopeFacts> {
  const row = await transaction.query<
    { application_id: string | null; repository_id: string | null }
  >(
    `select application_id, repository_id from bakery.conversations
      where organization_id = $1 and id = $2`,
    [organizationId, conversationId],
  );
  return {
    applicationId: row.rows[0]?.application_id ?? null,
    repositoryId: row.rows[0]?.repository_id ?? null,
  };
}

async function finishTurn(
  transaction: PgTransactionClient,
  turn: TurnRow,
  organizationId: string,
  conversationId: string,
  status: "failed" | "canceled" | "completed",
  extra: { failure?: unknown; outputMessageId?: string; sessionId?: string },
): Promise<number> {
  const updated = await transaction.query<{ version: number }>(
    `update bakery.conversation_turns
        set status = $3, finished_at = now(), updated_at = now(),
            lease_expires_at = null, failure = $4::jsonb,
            output_message_id = $5, agent_session_id = $6,
            version = version + 1
      where organization_id = $1 and id = $2
      returning version`,
    [
      organizationId,
      turn.id,
      status,
      extra.failure === undefined ? null : JSON.stringify(extra.failure),
      extra.outputMessageId ?? null,
      extra.sessionId ?? null,
    ],
  );
  const version = updated.rows[0]?.version;
  if (!version) throw new Error("CONVERSATION_TURN_UPDATE_FAILED");
  const queued = await remainingQueued(
    transaction,
    organizationId,
    conversationId,
  );
  await emitTurnChanged(transaction, {
    organizationId,
    conversationId,
    turnId: turn.id,
    triggerMessageId: turn.trigger_message_id,
    status,
    version,
    scope: await scopeFacts(transaction, organizationId, conversationId),
    wake: queued,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId: null,
    operation: "conversationTurns.run",
    resourceType: "conversation_turn",
    resourceId: turn.id,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    details: {
      conversationId,
      status,
      ...(extra.failure === undefined
        ? {}
        : { code: (extra.failure as { code: string }).code }),
    },
  });
  return version;
}

/** Current authority and scope of the requester; any denial revokes the turn. */
async function authorityHolds(
  transaction: PgTransactionClient,
  organizationId: string,
  conversationId: string,
  authorId: string | null,
): Promise<boolean> {
  try {
    await lockConversationScope(
      transaction,
      organizationId,
      conversationId,
      "update",
    );
    if (authorId === null) return false;
    const actor = await resolveOrganizationActor(
      transaction,
      toPrincipalId(authorId),
      toOrganizationId(organizationId),
    );
    authorize(actor, "message:write");
    return true;
  } catch (error) {
    if (error instanceof StandardError) return false;
    throw error;
  }
}

/**
 * Database-authoritative claim. Takes the oldest queued turn (or a stale
 * active one) to `active`, after re-checking the requester's current authority
 * and conversation scope. Revoked authority fails the turn without executing.
 */
export async function claimNextTurn(
  database: PgDatabase,
  identity: Readonly<{
    organizationId: string;
    conversationId: string;
    leaseMs?: number;
  }>,
): Promise<ClaimResult> {
  const { organizationId, conversationId } = identity;
  const leaseMs = identity.leaseMs ?? DEFAULT_LEASE_MS;
  return await withPgTransaction(database, async (transaction) => {
    const locked = await transaction.query(
      `select 1 from bakery.conversations
        where organization_id = $1 and id = $2 for update`,
      [organizationId, conversationId],
    );
    if (locked.rows.length !== 1) return { kind: "none" } as const;
    const turns = await transaction.query<TurnRow>(
      `select turn.id, turn.trigger_message_id, turn.status, turn.version,
              turn.context_through_sequence::text, turn.agent_version_id,
              coalesce(turn.lease_expires_at < now(), true) as lease_expired,
              message.author_id
         from bakery.conversation_turns turn
         join bakery.messages message
           on message.organization_id = turn.organization_id
          and message.conversation_id = turn.conversation_id
          and message.id = turn.trigger_message_id
        where turn.organization_id = $1 and turn.conversation_id = $2
          and turn.status in ('queued', 'active', 'cancel_requested')
        order by (turn.status = 'queued'), message.sequence asc
        limit 1
        for update of turn`,
      [organizationId, conversationId],
    );
    const turn = turns.rows[0];
    if (!turn) return { kind: "none" } as const;
    if (turn.status !== "queued" && !turn.lease_expired) {
      return { kind: "busy" } as const;
    }
    if (turn.status === "cancel_requested") {
      await finishTurn(
        transaction,
        turn,
        organizationId,
        conversationId,
        "canceled",
        {},
      );
      return {
        kind: "terminal",
        turnId: turn.id,
        status: "canceled",
        code: "canceled",
      } as const;
    }
    const allowed = await authorityHolds(
      transaction,
      organizationId,
      conversationId,
      turn.author_id,
    );
    const refusal = !allowed
      ? problem(
        "authority_revoked",
        "Requester authority or conversation scope was revoked before execution",
        403,
      )
      : turn.agent_version_id === null
      ? problem(
        "coordinator_unconfigured",
        "No coordinator agent is configured",
      )
      : null;
    if (refusal) {
      await finishTurn(
        transaction,
        turn,
        organizationId,
        conversationId,
        "failed",
        {
          failure: refusal,
        },
      );
      return {
        kind: "terminal",
        turnId: turn.id,
        status: "failed",
        code: refusal.code,
      } as const;
    }
    const claimed = await transaction.query<{ version: number }>(
      `update bakery.conversation_turns
          set status = 'active', started_at = coalesce(started_at, now()),
              lease_expires_at = now() + ($3 || ' milliseconds')::interval,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2
        returning version`,
      [organizationId, turn.id, String(leaseMs)],
    );
    const version = claimed.rows[0]?.version;
    if (!version) throw new Error("CONVERSATION_TURN_CLAIM_FAILED");
    await emitTurnChanged(transaction, {
      organizationId,
      conversationId,
      turnId: turn.id,
      triggerMessageId: turn.trigger_message_id,
      status: "active",
      version,
      scope: await scopeFacts(transaction, organizationId, conversationId),
      wake: false,
    });
    return { kind: "claimed", turnId: turn.id, claimVersion: version } as const;
  });
}

async function loadInput(
  database: PgDatabase,
  organizationId: string,
  conversationId: string,
  turnId: string,
): Promise<CoordinatorTurnInput> {
  const turn = await database.query<{
    trigger_message_id: string;
    context_through_sequence: string;
    agent_version_id: string;
    agent_id: string;
    revision: number;
    config: unknown;
    application_id: string | null;
    repository_id: string | null;
  }>(
    `select turn.trigger_message_id, turn.context_through_sequence::text,
            turn.agent_version_id, version.agent_id, version.revision,
            version.config, conversation.application_id,
            conversation.repository_id
       from bakery.conversation_turns turn
       join bakery.agent_versions version
         on version.organization_id = turn.organization_id
        and version.id = turn.agent_version_id
       join bakery.conversations conversation
         on conversation.organization_id = turn.organization_id
        and conversation.id = turn.conversation_id
      where turn.organization_id = $1 and turn.id = $2`,
    [organizationId, turnId],
  );
  const row = turn.rows[0];
  if (!row?.context_through_sequence) {
    throw new Error("CONVERSATION_TURN_PIN_MISSING");
  }
  const messages = await database.query<{
    id: string;
    sequence: string;
    author_id: string | null;
    message_type: string;
    intent: string;
    body: string;
  }>(
    `select * from (
       select id, sequence::text, author_id, message_type, intent, body
         from bakery.messages
        where organization_id = $1 and conversation_id = $2
          and sequence <= $3::bigint
        order by sequence desc limit $4
     ) recent order by sequence::bigint asc`,
    [
      organizationId,
      conversationId,
      row.context_through_sequence,
      MAX_CONTEXT_MESSAGES,
    ],
  );
  const task = await database.query<{ id: string }>(
    `select id from bakery.tasks
      where organization_id = $1 and conversation_id = $2
      order by created_at asc, id asc limit 1`,
    [organizationId, conversationId],
  );
  return {
    turnId,
    organizationId,
    conversationId,
    triggerMessageId: row.trigger_message_id,
    contextThroughSequence: row.context_through_sequence,
    messages: messages.rows.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      authorId: message.author_id,
      messageType: message.message_type,
      intent: message.intent,
      body: message.body,
    })),
    scope: {
      applicationId: row.application_id,
      repositoryId: row.repository_id,
      taskId: task.rows[0]?.id ?? null,
    },
    agentVersion: {
      id: row.agent_version_id,
      agentId: row.agent_id,
      revision: row.revision,
      config: row.config,
    },
    openQuestions: await readOpenQuestions(
      database,
      organizationId,
      conversationId,
    ),
    currentPlanRevision: await readCurrentPlanContext(
      database,
      organizationId,
      task.rows[0]?.id ?? null,
    ),
  };
}

async function applyOutcome(
  database: PgDatabase,
  identity: Readonly<{
    organizationId: string;
    conversationId: string;
    turnId: string;
    claimVersion: number;
  }>,
  outcome:
    | { status: "completed"; effects: readonly CoordinatorEffect[] }
    | { status: "failed"; code: string; detail: string },
): Promise<ProcessResult> {
  const { organizationId, conversationId, turnId } = identity;
  return await withPgTransaction(database, async (transaction) => {
    await transaction.query(
      `select 1 from bakery.conversations
        where organization_id = $1 and id = $2 for update`,
      [organizationId, conversationId],
    );
    const found = await transaction.query<TurnRow>(
      `select turn.id, turn.trigger_message_id, turn.status, turn.version,
              turn.context_through_sequence::text, turn.agent_version_id,
              false as lease_expired, null::uuid as author_id
         from bakery.conversation_turns turn
        where turn.organization_id = $1 and turn.id = $2 for update`,
      [organizationId, turnId],
    );
    const turn = found.rows[0];
    if (!turn) return { kind: "lost" } as const;
    if (turn.status === "cancel_requested") {
      await finishTurn(
        transaction,
        turn,
        organizationId,
        conversationId,
        "canceled",
        {},
      );
      return { kind: "processed", turnId, status: "canceled" } as const;
    }
    if (turn.status !== "active" || turn.version !== identity.claimVersion) {
      return { kind: "lost" } as const;
    }
    if (outcome.status === "failed") {
      await finishTurn(
        transaction,
        turn,
        organizationId,
        conversationId,
        "failed",
        {
          failure: problem(outcome.code, outcome.detail, 502),
        },
      );
      return { kind: "processed", turnId, status: "failed" } as const;
    }
    if (
      outcome.effects.some((effect) =>
        effect.type === "question" || effect.type === "planRevision"
      ) &&
      await taskIdForConversation(
          transaction,
          organizationId,
          conversationId,
        ) ===
        null
    ) {
      await finishTurn(
        transaction,
        turn,
        organizationId,
        conversationId,
        "failed",
        {
          failure: problem(
            "question_requires_task",
            "Questions and plan revisions are task-scoped; this conversation has no task",
            422,
          ),
        },
      );
      return { kind: "processed", turnId, status: "failed" } as const;
    }
    const replies = outcome.effects.filter((effect) => effect.type === "reply");
    let outputMessageId: string | undefined;
    let sessionId: string | undefined;
    if (replies.length > 0) {
      const scope = await scopeFacts(
        transaction,
        organizationId,
        conversationId,
      );
      const session = await transaction.query<{ id: string }>(
        `insert into bakery.agent_sessions (
           organization_id, conversation_id, agent_version_id, harness, status
         ) select $1, $2, agent_version_id, 'coordinator', 'completed'
             from bakery.conversation_turns where organization_id = $1 and id = $3
         returning id`,
        [organizationId, conversationId, turnId],
      );
      sessionId = session.rows[0]?.id;
      if (!sessionId) throw new Error("COORDINATOR_SESSION_INSERT_FAILED");
      let index = 0;
      for (const reply of replies) {
        index++;
        const next = await transaction.query<{ sequence: string }>(
          `select (coalesce(max(sequence), 0) + 1)::text as sequence
             from bakery.messages
            where organization_id = $1 and conversation_id = $2`,
          [organizationId, conversationId],
        );
        const sequence = next.rows[0]?.sequence;
        if (!sequence) throw new Error("MESSAGE_SEQUENCE_UNAVAILABLE");
        const inserted = await transaction.query<{ id: string }>(
          `insert into bakery.messages (
             organization_id, conversation_id, agent_session_id, message_type,
             body, client_message_id, reply_to_id, sequence, intent
           ) values ($1, $2, $3, 'assistant', $4, $5, $6, $7, 'agent_output')
           returning id`,
          [
            organizationId,
            conversationId,
            sessionId,
            reply.body,
            `turn:${turnId}:reply:${index}`,
            turn.trigger_message_id,
            sequence,
          ],
        );
        const messageId = inserted.rows[0]?.id;
        if (!messageId) throw new Error("MESSAGE_INSERT_FAILED");
        outputMessageId ??= messageId;
        await appendDomainEvent(transaction, {
          organizationId,
          applicationId: scope.applicationId,
          repositoryId: scope.repositoryId,
          conversationId,
          eventType: "conversation.message_created",
          aggregateId: messageId,
          aggregateVersion: 1,
          payload: {
            resourceId: messageId,
            resourceVersion: 1,
            conversationId,
            messageSequence: sequence,
            intent: "agent_output",
          },
          traceId: crypto.randomUUID(),
        });
      }
    }
    await createQuestionsForTurn(transaction, {
      organizationId,
      conversationId,
      turnId,
      effects: outcome.effects,
    });
    await proposePlanRevisions(transaction, {
      organizationId,
      conversationId,
      turnId,
      effects: outcome.effects,
    });
    await finishTurn(
      transaction,
      turn,
      organizationId,
      conversationId,
      "completed",
      {
        outputMessageId,
        sessionId,
      },
    );
    return { kind: "processed", turnId, status: "completed" } as const;
  });
}

/** Execute one claimed turn: heartbeat the lease, honor cancel, apply atomically. */
export async function executeClaimedTurn(
  options: TurnRuntimeOptions,
  identity: Readonly<{
    organizationId: string;
    conversationId: string;
    turnId: string;
    claimVersion: number;
  }>,
): Promise<ProcessResult> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const controller = new AbortController();
  const heartbeat = setInterval(async () => {
    try {
      // Conditional on the claim: a takeover or cancel bumps the version.
      const beat = await options.database.query<{ status: string }>(
        `update bakery.conversation_turns
            set lease_expires_at = now() + ($3 || ' milliseconds')::interval
          where organization_id = $1 and id = $2
            and status = 'active' and version = $4
          returning status`,
        [
          identity.organizationId,
          identity.turnId,
          String(leaseMs),
          identity.claimVersion,
        ],
      );
      if (beat.rows.length === 0) controller.abort();
    } catch {
      // The next beat or lease recovery decides; a failed beat never aborts.
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  try {
    let outcome;
    try {
      const input = await loadInput(
        options.database,
        identity.organizationId,
        identity.conversationId,
        identity.turnId,
      );
      outcome = await options.executor.execute(input, controller.signal);
    } catch {
      outcome = {
        status: "failed",
        code: "coordinator_error",
        detail: "Coordinator executor raised an error",
      } as const;
    }
    return await applyOutcome(options.database, identity, outcome);
  } finally {
    clearInterval(heartbeat);
  }
}

export async function processNextConversationTurn(
  options: TurnRuntimeOptions,
  identity: Readonly<{ organizationId: string; conversationId: string }>,
): Promise<ProcessResult> {
  const claim = await claimNextTurn(options.database, {
    ...identity,
    leaseMs: options.leaseMs,
  });
  if (claim.kind === "none" || claim.kind === "busy") return claim;
  if (claim.kind === "terminal") {
    return { kind: "processed", turnId: claim.turnId, status: claim.status };
  }
  return await executeClaimedTurn(options, {
    ...identity,
    turnId: claim.turnId,
    claimVersion: claim.claimVersion,
  });
}

function eventIdentity(data: unknown):
  | { organizationId: string; conversationId: string }
  | undefined {
  const record = data as {
    organizationId?: unknown;
    conversationId?: unknown;
    payload?: { conversationId?: unknown };
  };
  const conversationId = record?.payload?.conversationId ??
    record?.conversationId;
  return typeof record?.organizationId === "string" &&
      typeof conversationId === "string"
    ? { organizationId: record.organizationId, conversationId }
    : undefined;
}

export function createConversationTurnWorkflow(
  options: TurnRuntimeOptions & { client: Inngest },
) {
  return options.client.createFunction(
    {
      id: "bakery-conversation-turn",
      retries: 3,
      concurrency: [{ key: "event.data.conversationId", limit: 1 }],
      triggers: [{ event: TURN_EVENT }],
    },
    async ({ event, step }) => {
      const identity = eventIdentity(event.data);
      if (!identity) return { kind: "ignored" };
      const claim = await step.run(
        "claim-turn",
        () =>
          claimNextTurn(options.database, {
            ...identity,
            leaseMs: options.leaseMs,
          }),
      );
      if (claim.kind !== "claimed") return claim;
      return await step.run(
        "execute-turn",
        () =>
          executeClaimedTurn(options, {
            ...identity,
            turnId: claim.turnId,
            claimVersion: claim.claimVersion,
          }),
      );
    },
  );
}

export function createConversationTurnRecovery(
  options: Readonly<{ client: Inngest; database: PgDatabase; limit?: number }>,
) {
  return options.client.createFunction(
    {
      id: "bakery-conversation-turn-recovery",
      retries: 3,
      triggers: [{ cron: "* * * * *" }],
    },
    async ({ step }) => {
      const stale = await step.run(
        "find-stale-turns",
        async () =>
          (await options.database.query<
            { organizationId: string; conversationId: string; turnId: string }
          >(
            `select distinct on (turn.conversation_id)
                    turn.organization_id as "organizationId",
                    turn.conversation_id as "conversationId",
                    turn.id as "turnId"
               from bakery.conversation_turns turn
              where (
                    turn.status in ('active', 'cancel_requested')
                    and coalesce(turn.lease_expires_at < now(), true)
                  ) or (
                    turn.status = 'queued'
                    and turn.updated_at < now() - interval '30 seconds'
                    and not exists (
                      select 1 from bakery.conversation_turns running
                       where running.conversation_id = turn.conversation_id
                         and running.status in ('active', 'cancel_requested')
                         and running.lease_expires_at >= now()
                    )
                  )
              order by turn.conversation_id, turn.created_at
              limit $1`,
            [options.limit ?? 50],
          )).rows,
      );
      for (const turn of stale) {
        await step.sendEvent(`rearm-turn-${turn.turnId}`, {
          name: TURN_EVENT,
          data: {
            organizationId: turn.organizationId,
            conversationId: turn.conversationId,
            payload: { conversationId: turn.conversationId },
          },
        });
      }
      const expired = await step.run(
        "expire-questions",
        () => expireDueQuestions(options.database),
      );
      const jobs = await step.run(
        "sweep-coordinator-jobs",
        () =>
          sweepCoordinatorTurnJobs(options.database, options.limit ?? 50, {
            onCancelRequested: async (job) => {
              await pushCoordinatorCancelToWorker(options.database, job);
            },
          }),
      );
      return {
        rearmed: stale.length,
        expiredQuestions: expired,
        coordinatorJobs: jobs,
      };
    },
  );
}
