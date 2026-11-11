import { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgDatabase,
  type PgTransactionClient,
} from "@bakery/persistence";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  approvalPolicyDigest,
  effectiveApprovalPolicy,
  PLAN_STAGE,
} from "../work/stage-policy.ts";
import type { CoordinatorEffect } from "./coordinator.ts";
import { requestPlanApproval } from "./approvals.ts";
import { scopeOf } from "./questions.ts";

type PlanEffect = Extract<CoordinatorEffect, { type: "planRevision" }>;

/** Stored, immutable plan content; the digest covers the task, revision and this body. */
export const PlanRevisionBodySchema = z.object({
  title: z.string().min(1).max(300).describe("Plan title."),
  steps: z.array(
    z.object({
      id: z.string().min(1).max(100).describe("Stable step identifier."),
      title: z.string().min(1).max(300).describe("Short step title."),
      detail: z.string().max(4000).describe("Step detail text."),
    }).strict().describe("One plan step."),
  ).min(1).max(100).describe("Ordered plan steps."),
  repositoryId: z.string().uuid().nullable().describe(
    "Repository the plan is scoped to, or null for an organization-wide conversation.",
  ),
}).strict().describe(
  "Plan revision body: title, ordered steps and the repository scope.",
);
export type PlanRevisionBody = z.infer<typeof PlanRevisionBodySchema>;

export type PlanRevisionRow = {
  id: string;
  task_id: string;
  conversation_id: string;
  revision: number;
  body: PlanRevisionBody;
  digest: string;
  status: string;
  proposed_by_turn_id: string | null;
  supersedes_revision: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

const COLUMNS = `r.id, r.task_id, r.conversation_id, r.revision, r.body,
  r.digest, r.status, r.proposed_by_turn_id, r.supersedes_revision,
  r.created_at, r.updated_at, r.version`;

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toPlanRevision(row: PlanRevisionRow) {
  return contractSchemas.PlanRevision.parse({
    id: row.id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    revision: row.revision,
    body: row.body,
    digest: row.digest,
    status: row.status,
    proposedByTurnId: row.proposed_by_turn_id,
    supersedesRevision: row.supersedes_revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  });
}

/** Digest over task, revision and body: equal bodies on two tasks never share one. */
export async function planRevisionDigest(
  taskId: string,
  revision: number,
  body: PlanRevisionBody,
): Promise<string> {
  return await sha256Hex(canonicalJson({ taskId, revision, body }));
}

/** Latest revision of a task, the only one that can still be approved. */
export async function readCurrentPlanRevision(
  database: PgDatabase,
  organizationId: string,
  taskId: string,
): Promise<PlanRevisionRow | null> {
  const result = await database.query<PlanRevisionRow>(
    `select ${COLUMNS} from bakery.plan_revisions r
      where r.organization_id = $1 and r.task_id = $2
      order by r.revision desc limit 1`,
    [organizationId, taskId],
  );
  return result.rows[0] ?? null;
}

/** Plan summary for the coordinator's pinned context. */
export async function readCurrentPlanContext(
  database: PgDatabase,
  organizationId: string,
  taskId: string | null,
): Promise<unknown | null> {
  if (taskId === null) return null;
  const row = await readCurrentPlanRevision(database, organizationId, taskId);
  return row === null ? null : {
    id: row.id,
    revision: row.revision,
    status: row.status,
    digest: row.digest,
    body: row.body,
  };
}

/**
 * Creates revision N+1 for every `planRevision` effect of a completed turn,
 * inside the turn's transaction. Older revisions become `superseded` and their
 * unconsumed approvals stop authorizing anything. When the task's stage policy
 * waits for a human at the plan stage, each revision gets an approval request.
 */
export async function proposePlanRevisions(
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    conversationId: string;
    turnId: string;
    effects: readonly CoordinatorEffect[];
  },
): Promise<void> {
  const effects = facts.effects.filter((effect): effect is PlanEffect =>
    effect.type === "planRevision"
  );
  if (effects.length === 0) return;
  const scope = await scopeOf(
    transaction,
    facts.organizationId,
    facts.conversationId,
  );
  if (scope.task_id === null) throw new Error("PLAN_REVISION_TASK_REQUIRED");
  // The task row serializes revision numbering across concurrent turns.
  const task = await transaction.query<{ approval_policy: unknown }>(
    `select approval_policy from bakery.tasks
      where organization_id = $1 and id = $2 for update`,
    [facts.organizationId, scope.task_id],
  );
  const policy = effectiveApprovalPolicy(task.rows[0]?.approval_policy);
  const policyDigest = await approvalPolicyDigest(policy);
  for (const effect of effects) {
    const latest = await transaction.query<{ revision: number }>(
      `select coalesce(max(revision), 0)::int as revision
         from bakery.plan_revisions
        where organization_id = $1 and task_id = $2`,
      [facts.organizationId, scope.task_id],
    );
    const previous = latest.rows[0]?.revision ?? 0;
    const revision = previous + 1;
    const body = PlanRevisionBodySchema.parse({
      title: effect.title,
      steps: effect.steps,
      repositoryId: scope.repository_id,
    });
    const digest = await planRevisionDigest(scope.task_id, revision, body);
    const inserted = await transaction.query<PlanRevisionRow>(
      `insert into bakery.plan_revisions (
         organization_id, task_id, conversation_id, revision, body, digest,
         proposed_by_turn_id, supersedes_revision
       ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       returning ${COLUMNS.replaceAll("r.", "")}`,
      [
        facts.organizationId,
        scope.task_id,
        facts.conversationId,
        revision,
        JSON.stringify(body),
        digest,
        facts.turnId,
        previous === 0 ? null : previous,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("PLAN_REVISION_INSERT_FAILED");
    await supersedeOlder(transaction, {
      organizationId: facts.organizationId,
      taskId: scope.task_id,
      revision,
    });
    await appendDomainEvent(transaction, {
      organizationId: facts.organizationId,
      applicationId: scope.application_id,
      repositoryId: scope.repository_id,
      taskId: scope.task_id,
      conversationId: facts.conversationId,
      eventType: "planRevision.proposed",
      aggregateId: row.id,
      aggregateVersion: row.version,
      payload: { resourceId: row.id, resourceVersion: row.version },
      traceId: crypto.randomUUID(),
    });
    await appendAudit(transaction, {
      organizationId: facts.organizationId,
      principalId: null,
      operation: "planRevisions.create",
      resourceType: "plan_revision",
      resourceId: row.id,
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      details: {
        taskId: scope.task_id,
        revision,
        digest,
        turnId: facts.turnId,
      },
    });
    if (policy.plan === "human_approval") {
      await requestPlanApproval(transaction, {
        organizationId: facts.organizationId,
        conversationId: facts.conversationId,
        turnId: facts.turnId,
        taskId: scope.task_id,
        scope,
        revision: row,
        stage: PLAN_STAGE,
        policyDigest,
      });
    }
  }
}

/** Older revisions and their unconsumed approvals stop authorizing anything. */
async function supersedeOlder(
  transaction: PgTransactionClient,
  facts: { organizationId: string; taskId: string; revision: number },
): Promise<void> {
  await transaction.query(
    `update bakery.plan_revisions
        set status = 'superseded', updated_at = now(), version = version + 1
      where organization_id = $1 and task_id = $2 and revision < $3
        and status <> 'superseded'`,
    [facts.organizationId, facts.taskId, facts.revision],
  );
  await transaction.query(
    `update bakery.questions q
        set status = 'superseded', updated_at = now(), version = version + 1
      where q.organization_id = $1 and q.task_id = $2 and q.kind = 'approval'
        and q.subject_type = 'plan_revision'
        and q.subject_id in (
          select r.id from bakery.plan_revisions r
           where r.organization_id = $1 and r.task_id = $2 and r.revision < $3)
        and (q.status = 'open'
          or (q.status = 'answered' and q.decision = 'approve'
              and q.consumed_at is null and q.revoked_at is null))`,
    [facts.organizationId, facts.taskId, facts.revision],
  );
}

export function createPlanRevisionsListHandler(secret: string) {
  return async (context: ActionContext, rawInput: unknown) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const input = rawInput as {
      cursor?: string;
      limit?: number;
      taskId?: string;
    };
    const binding: CursorBinding = {
      action: "planRevisions.list",
      principalId,
      organizationId,
      ordering: "createdAt:desc,id:desc",
      filters: canonicalJson({ taskId: input.taskId ?? null }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<
      PlanRevisionRow & { cursor_created_at: string }
    >(
      `select ${COLUMNS},
              to_char(r.created_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
         from bakery.plan_revisions r
        where r.organization_id = $1
          and ($2::uuid is null or r.task_id = $2)
          and ($3::timestamptz is null or (r.created_at, r.id) < ($3, $4::uuid))
        order by r.created_at desc, r.id desc
        limit $5`,
      [
        organizationId,
        input.taskId ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(toPlanRevision),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

export async function getPlanRevision(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const result = await transaction.query<PlanRevisionRow>(
    `select ${COLUMNS} from bakery.plan_revisions r
      where r.organization_id = $1 and r.id = $2`,
    [organizationId, id],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toPlanRevision(row);
}
