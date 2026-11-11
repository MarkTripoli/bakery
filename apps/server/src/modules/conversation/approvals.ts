import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas, PrincipalType } from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
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
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import type { ApprovedPlanForInstructions } from "@bakery/contracts/workflow-presets";
import type { PlanRevisionBody } from "./plan-revisions.ts";
import { lockConversationScope } from "./postgres.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  DEFAULT_QUESTION_TTL_SECONDS,
  queueAgentRequest,
  type ScopeFacts,
  scopeOf,
  turnGeneration,
} from "./questions.ts";

export type ApprovalSubjectType =
  | "plan_revision"
  | "run_stage"
  | "merge"
  | "deploy";

type ApprovalRow = {
  id: string;
  kind: string;
  conversation_id: string;
  task_id: string;
  turn_id: string | null;
  prompt: string;
  status: string;
  subject_type: string | null;
  subject_id: string | null;
  subject_digest: string | null;
  scope: { stage?: string } | null;
  policy_digest: string | null;
  decision: string | null;
  decision_comment: string | null;
  decided_by: string | null;
  decided_at: Date | string | null;
  consumed_at: Date | string | null;
  consumed_by_run_id: string | null;
  revoked_at: Date | string | null;
  revoked_by: string | null;
  expires_at: Date | string | null;
  answer_digest: string | null;
  audience: { type: string; principalIds?: string[] };
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

/**
 * Approved but unconsumed approvals past their deadline read as expired, so a
 * stale approval keeps the stage paused before any sweep runs.
 */
const EFFECTIVE_STATUS = `case
  when q.status = 'open' and q.expires_at is not null and q.expires_at <= now()
    then 'expired'
  when q.status = 'answered' and q.decision = 'approve'
    and q.consumed_at is null and q.revoked_at is null
    and q.expires_at is not null and q.expires_at <= now()
    then 'expired'
  else q.status end`;

const COLUMNS = `q.id, q.kind, q.conversation_id, q.task_id, q.turn_id,
  q.prompt, ${EFFECTIVE_STATUS} as status, q.subject_type, q.subject_id,
  q.subject_digest, q.scope, q.policy_digest, q.decision, q.decision_comment,
  q.decided_by, q.decided_at, q.consumed_at, q.consumed_by_run_id,
  q.revoked_at, q.revoked_by, q.expires_at, q.answer_digest, q.audience,
  q.created_at, q.updated_at, q.version`;

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
const isoOrNull = (value: Date | string | null) =>
  value === null ? null : iso(value);

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

export function toApproval(row: ApprovalRow) {
  return contractSchemas.Approval.parse({
    id: row.id,
    kind: "approval",
    taskId: row.task_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    runId: row.consumed_by_run_id,
    prompt: row.prompt,
    status: row.status,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectDigest: row.subject_digest,
    scope: row.scope,
    policyDigest: row.policy_digest,
    decision: row.decision,
    decisionComment: row.decision_comment,
    decidedBy: row.decided_by,
    decidedAt: isoOrNull(row.decided_at),
    consumedAt: isoOrNull(row.consumed_at),
    consumedByRunId: row.consumed_by_run_id,
    revokedAt: isoOrNull(row.revoked_at),
    revokedBy: row.revoked_by,
    expiresAt: isoOrNull(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  });
}

/**
 * Approvals authorize work, so only a human may decide or revoke them.
 * Service accounts, worker identities and agent sessions are refused even when
 * their role carries `approval:decide`.
 */
export function requireHumanPrincipal(context: ActionContext): void {
  const authority = (context as Partial<AuthorizedActionContext>).authority as
    | OrganizationActor
    | undefined;
  if (authority?.subject?.principalType !== PrincipalType.Human) {
    throw new StandardError({
      code: "AUTH_FORBIDDEN",
      params: { reason: "approval_requires_human" },
    });
  }
}

/** Opens a plan-revision approval request bound to the exact revision digest. */
export async function requestPlanApproval(
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    conversationId: string;
    turnId: string;
    taskId: string;
    scope: ScopeFacts;
    revision: {
      id: string;
      revision: number;
      digest: string;
      body: { title: string; repositoryId: string | null };
    };
    stage: string;
    policyDigest: string;
  },
): Promise<string> {
  const generation = await turnGeneration(
    transaction,
    facts.organizationId,
    facts.conversationId,
    facts.turnId,
  );
  const inserted = await transaction.query<{ id: string; version: number }>(
    `insert into bakery.questions (
       organization_id, kind, conversation_id, task_id, turn_id, generation,
       prompt, allow_free_text, audience, expires_at, subject_type, subject_id,
       subject_digest, scope, policy_digest
     ) values ($1, 'approval', $2, $3, $4, $5, $6, false, $7::jsonb,
       now() + ($8 || ' seconds')::interval, 'plan_revision', $9, $10,
       $11::jsonb, $12)
     returning id, version`,
    [
      facts.organizationId,
      facts.conversationId,
      facts.taskId,
      facts.turnId,
      generation,
      `Approve plan revision ${facts.revision.revision}: ${facts.revision.body.title}`,
      JSON.stringify({ type: "task_participants" }),
      String(DEFAULT_QUESTION_TTL_SECONDS),
      facts.revision.id,
      facts.revision.digest,
      JSON.stringify({
        stage: facts.stage,
        repositoryId: facts.revision.body.repositoryId,
      }),
      facts.policyDigest,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("APPROVAL_INSERT_FAILED");
  await appendDomainEvent(transaction, {
    organizationId: facts.organizationId,
    applicationId: facts.scope.application_id,
    repositoryId: facts.scope.repository_id,
    taskId: facts.taskId,
    conversationId: facts.conversationId,
    eventType: "approval.requested",
    aggregateId: row.id,
    aggregateVersion: row.version,
    payload: { resourceId: row.id, resourceVersion: row.version },
    traceId: crypto.randomUUID(),
  });
  await appendAudit(transaction, {
    organizationId: facts.organizationId,
    principalId: null,
    operation: "approvals.request",
    resourceType: "approval",
    resourceId: row.id,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    details: {
      taskId: facts.taskId,
      planRevisionId: facts.revision.id,
      subjectDigest: facts.revision.digest,
    },
  });
  return row.id;
}

async function loadApproval(
  transaction: PgTransactionClient,
  organizationId: string,
  id: string,
  lock = false,
): Promise<ApprovalRow> {
  const result = await transaction.query<ApprovalRow>(
    `select ${COLUMNS} from bakery.questions q
      where q.organization_id = $1 and q.id = $2 and q.kind = 'approval'${
      lock ? " for update of q" : ""
    }`,
    [organizationId, id],
  );
  const row = result.rows[0];
  if (!row) notFound();
  return row;
}

export function createApprovalsListHandler(secret: string) {
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
      action: "approvals.list",
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
      ApprovalRow & { cursor_created_at: string }
    >(
      `select ${COLUMNS},
              to_char(q.created_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from bakery.questions q
        where q.organization_id = $1 and q.kind = 'approval'
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
      items: visible.map(toApproval),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

/** An approval private to named principals does not exist for anyone else. */
function assertAudienceMember(row: ApprovalRow, principalId: string): void {
  if (
    row.audience.type === "principals" &&
    !row.audience.principalIds?.includes(principalId)
  ) notFound();
}

export async function getApproval(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = context.params.id;
  if (!id) notFound();
  const row = await loadApproval(transaction, organizationId, id);
  assertAudienceMember(row, principalId);
  return toApproval(row);
}

type DecisionInput = z.output<typeof contractSchemas.ApprovalDecision>;

const REVISION_STATUS_BY_DECISION = {
  approve: "approved",
  request_changes: "changes_requested",
  reject: "rejected",
} as const;

/**
 * First-decision compare-and-swap on an open approval. The decision also moves
 * the bound plan revision out of `proposed`; a stale or superseded revision,
 * an expired request or a different later decision fails without effect.
 */
export async function decideApproval(
  context: ActionContext,
  rawInput: unknown,
) {
  requireHumanPrincipal(context);
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = context.params.id;
  if (!id) notFound();
  const input = rawInput as DecisionInput;
  const comment = input.comment?.trim() ?? "";
  if (input.decision === "request_changes" && comment.length === 0) {
    throw unprocessable(["comment"], "comment_required");
  }
  const peek = await loadApproval(transaction, organizationId, id);
  // Same refusal as approvals.get, ahead of the archived refusal below: a
  // non-audience caller cannot confirm the approval exists, whatever its
  // conversation state.
  assertAudienceMember(peek, principalId);
  // Conversation first, then the approval: the order turn admission uses.
  // Archived conversation, application or repository refuse, like questions.answer.
  await lockConversationScope(
    transaction,
    organizationId,
    peek.conversation_id,
    "update",
  );
  const row = await loadApproval(transaction, organizationId, id, true);
  assertAudienceMember(row, principalId);
  if (row.subject_type !== "plan_revision") conflict("unsupported");
  const digest = await sha256Hex(
    canonicalJson({ decision: input.decision, comment }),
  );
  if (row.status === "answered") {
    if (row.answer_digest === digest) return toApproval(row);
    conflict("approval_decided");
  }
  if (row.status !== "open") conflict(`approval_${row.status}`);
  if (row.version !== input.expectedVersion) conflict("approval_stale");

  const revision = await transaction.query<
    { id: string; revision: number; digest: string; status: string }
  >(
    `select id, revision, digest, status from bakery.plan_revisions
      where organization_id = $1 and id = $2 for update`,
    [organizationId, row.subject_id],
  );
  const subject = revision.rows[0];
  if (
    !subject || subject.status !== "proposed" ||
    subject.digest !== row.subject_digest
  ) conflict("approval_superseded");

  const updated = await transaction.query<ApprovalRow>(
    `update bakery.questions q
        set status = 'answered', decision = $3, decision_comment = $4,
            decided_by = $5, decided_at = now(), answer = $6::jsonb,
            answered_by = $5, answered_at = now(), answer_digest = $7,
            updated_at = now(), version = version + 1
      where q.organization_id = $1 and q.id = $2 and q.status = 'open'
        and q.version = $8
        and (q.expires_at is null or q.expires_at > now())
      returning ${COLUMNS}`,
    [
      organizationId,
      id,
      input.decision,
      comment === "" ? null : comment,
      principalId,
      JSON.stringify({ decision: input.decision, comment }),
      digest,
      input.expectedVersion,
    ],
  );
  const decided = updated.rows[0];
  if (!decided) conflict("approval_unavailable");
  const revisionUpdate = await transaction.query<{ version: number }>(
    `update bakery.plan_revisions
        set status = $3, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and status = 'proposed'
      returning version`,
    [
      organizationId,
      subject.id,
      REVISION_STATUS_BY_DECISION[input.decision],
    ],
  );
  if (revisionUpdate.rows.length !== 1) conflict("approval_superseded");

  const scope = await scopeOf(
    transaction,
    organizationId,
    decided.conversation_id,
  );
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.application_id,
    repositoryId: scope.repository_id,
    taskId: decided.task_id,
    conversationId: decided.conversation_id,
    eventType: "approval.decided",
    aggregateId: decided.id,
    aggregateVersion: decided.version,
    payload: { resourceId: decided.id, resourceVersion: decided.version },
    traceId: context.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.application_id,
    repositoryId: scope.repository_id,
    taskId: decided.task_id,
    conversationId: decided.conversation_id,
    eventType: "planRevision.updated",
    aggregateId: subject.id,
    aggregateVersion: revisionUpdate.rows[0].version,
    payload: {
      resourceId: subject.id,
      resourceVersion: revisionUpdate.rows[0].version,
    },
    traceId: context.traceId,
  });
  if (input.decision === "request_changes") {
    await queueAgentRequest(transaction, {
      organizationId,
      conversationId: decided.conversation_id,
      authorId: principalId,
      body:
        `Changes requested on plan revision ${subject.revision}: ${comment}`,
      clientMessageId: `approval:${decided.id}:changes`,
      scope,
      traceId: context.traceId,
    });
  }
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "approvals.decide",
    resourceType: "approval",
    resourceId: decided.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      decision: input.decision,
      planRevisionId: subject.id,
      subjectDigest: row.subject_digest,
    },
  });
  return toApproval(decided);
}

type RevokeInput = z.output<typeof contractSchemas.ApprovalRevoke>;

/**
 * Mirror of consumption: one conditional update that wins only while the
 * approval is approved and unconsumed. Revoking after a run consumed it fails
 * with `approval_consumed`; the run keeps its identity and is stopped only
 * through run control.
 */
export async function revokeApproval(
  context: ActionContext,
  rawInput: unknown,
) {
  requireHumanPrincipal(context);
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = context.params.id;
  if (!id) notFound();
  const input = rawInput as RevokeInput;
  // Same refusal as approvals.get, ahead of every state refusal: a non-audience
  // caller cannot confirm a private approval exists or revoke it.
  assertAudienceMember(
    await loadApproval(transaction, organizationId, id),
    principalId,
  );
  const revoked = await transaction.query<ApprovalRow>(
    `update bakery.questions q
        set status = 'revoked', revoked_at = now(), revoked_by = $3,
            updated_at = now(), version = version + 1
      where q.organization_id = $1 and q.id = $2 and q.kind = 'approval'
        and q.status = 'answered' and q.decision = 'approve'
        and q.consumed_at is null and q.revoked_at is null
      returning ${COLUMNS}`,
    [organizationId, id, principalId],
  );
  const row = revoked.rows[0];
  if (!row) {
    const current = await loadApproval(transaction, organizationId, id);
    if (current.status === "revoked") return toApproval(current);
    if (current.status === "consumed") conflict("approval_consumed");
    conflict(`approval_not_revocable`);
  }
  const scope = await scopeOf(transaction, organizationId, row.conversation_id);
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: scope.application_id,
    repositoryId: scope.repository_id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    eventType: "approval.revoked",
    aggregateId: row.id,
    aggregateVersion: row.version,
    payload: { resourceId: row.id, resourceVersion: row.version },
    traceId: context.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "approvals.revoke",
    resourceType: "approval",
    resourceId: row.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { reason: input.reason ?? null },
  });
  return toApproval(row);
}

/**
 * Consumes the approval for one run admission, inside the admission
 * transaction. One conditional update binds organization, task, subject, the
 * current approved revision's id and digest, stage, policy digest, decision,
 * revocation and expiry. Zero rows means `approval_unavailable` and the whole
 * admission rolls back; the run's task and stage come from the admission, so
 * another task's approval never matches even for an identical plan body.
 */
export async function consumeApprovalForAdmission(
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    taskId: string;
    approvalId: string;
    runId: string;
    stage: string;
    policyDigest: string;
    principalId: string;
    requestId: string;
    traceId: string;
  },
): Promise<ApprovedPlanForInstructions> {
  const consumed = await transaction.query<
    {
      id: string;
      version: number;
      conversation_id: string;
      plan_revision_id: string;
      plan_revision: number;
      plan_digest: string;
      plan_body: unknown;
    }
  >(
    `with current_revision as (
       select r.id, r.digest, r.revision, r.body from bakery.plan_revisions r
        where r.organization_id = $2 and r.task_id = $3 and r.status = 'approved'
        order by r.revision desc limit 1)
     update bakery.questions q
        set status = 'consumed', consumed_at = now(),
            consumed_by_run_id = $4, updated_at = now(), version = version + 1
       from current_revision
      where q.id = $1 and q.organization_id = $2 and q.task_id = $3
        and q.kind = 'approval' and q.subject_type = 'plan_revision'
        and q.subject_id = current_revision.id
        and q.subject_digest = current_revision.digest
        and q.scope->>'stage' = $5 and q.policy_digest = $6
        and q.status = 'answered' and q.decision = 'approve'
        and q.revoked_at is null
        and (q.expires_at is null or q.expires_at > now())
      returning q.id, q.version, q.conversation_id,
        current_revision.id as plan_revision_id,
        current_revision.revision as plan_revision,
        current_revision.digest as plan_digest,
        current_revision.body as plan_body`,
    [
      facts.approvalId,
      facts.organizationId,
      facts.taskId,
      facts.runId,
      facts.stage,
      facts.policyDigest,
    ],
  );
  const row = consumed.rows[0];
  if (!row) conflict("approval_unavailable");
  const scope = await scopeOf(
    transaction,
    facts.organizationId,
    row.conversation_id,
  );
  await appendDomainEvent(transaction, {
    organizationId: facts.organizationId,
    applicationId: scope.application_id,
    repositoryId: scope.repository_id,
    taskId: facts.taskId,
    conversationId: row.conversation_id,
    eventType: "approval.consumed",
    aggregateId: row.id,
    aggregateVersion: row.version,
    payload: { resourceId: row.id, resourceVersion: row.version },
    traceId: facts.traceId,
  });
  await appendAudit(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: "approvals.consume",
    resourceType: "approval",
    resourceId: row.id,
    requestId: facts.requestId,
    traceId: facts.traceId,
    details: { runId: facts.runId, taskId: facts.taskId, stage: facts.stage },
  });
  // Stored bodies were validated by PlanRevisionBodySchema at insert and are immutable.
  const body = row.plan_body as PlanRevisionBody;
  return {
    planRevisionId: row.plan_revision_id,
    revision: Number(row.plan_revision),
    digest: row.plan_digest,
    title: body.title,
    steps: body.steps,
  };
}
