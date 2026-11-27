import type { ActionContext } from "@bakery/contracts/action-registry";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  type PgTransactionClient,
} from "@bakery/persistence";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  accessScopeClause,
  BINDING_ROLES,
  bindingAllows,
  bindingCovers,
} from "../auth/application/bindings.ts";
import {
  type CatalogActionName,
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "@bakery/contracts/contracts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import {
  authorize,
  permissionForAction,
} from "../auth/application/authorize.ts";
import type { OrganizationActor } from "../auth/application/authority.ts";
import { roleHasPermission } from "../auth/application/permissions.ts";
import {
  hasLiveRunGrant,
  RUN_GRANT_ACTIONS,
  type RunPower,
} from "../auth/application/run-grants.ts";
import {
  AgentPower,
  assertAgentMayExercise,
  type ExercisedPower,
  grantRefusal,
  matchingGrants,
} from "../auth/application/agent-power-grants.ts";
import { passedOnFromJoin } from "./request-passed-on.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

/** An agent asked on a run other than the one its session belongs to. */
export const AGENT_ASK_OWN_RUN_ONLY = "agent_ask_own_run_only";
/** An agent asked a person, role or group no live ask grant names. */
export const AGENT_ASK_AUDIENCE_NOT_GRANTED = "agent_ask_audience_not_granted";

export const REQUEST_POWER_NOT_HELD = "request_power_not_held";

type QuestionAudience = Readonly<
  { type: string; principalIds?: readonly string[] }
>;

function decidesItself(
  audience: QuestionAudience | null,
  principalId: string,
): boolean {
  if (audience === null || audience.type !== "principals") return true;
  return (audience.principalIds ?? []).includes(principalId);
}

/**
 * Requests on a run (issue #456, chapter 25 section 19).
 *
 * A request is one person asking another, on one run, for one thing. It gives
 * the person asked the right to see that run (migration 0247) and, in a later
 * slice, one narrow power on one thing in it. This slice is the record, the
 * observe grant, owner fallback, withdrawal and the decisions-ledger entries.
 *
 * "Request" is the product word; the access it carries is stated to the asker
 * before sending and to the person asked on arrival.
 */

/** A request expires seven days after it is made (O63); silence never approves. */
export const REQUEST_LIFETIME_DAYS = 7;
export const REQUEST_NOTE_MAX = 280;
/** The "People asked" list is bounded. */
export const REQUEST_LIST_LIMIT = 50;
/**
 * The most people one role or group ask may reach. It is the "People asked"
 * list's bound, so every request an ask makes can be shown on one page; a
 * bigger audience is refused whole (STATE_CONFLICT request_audience_too_large)
 * rather than fanning out unbounded rows or asking a silent subset.
 */
export const REQUEST_AUDIENCE_MAX = REQUEST_LIST_LIMIT;

export type RequestIntent =
  | "fyi"
  | "review"
  | "approve"
  | "answer"
  | "take_over";

/**
 * Intents whose power exists. The others are accepted by the contract and
 * refused here until their power is built, so no request promises a right it
 * cannot grant.
 */
const POWER_OF_INTENT: Readonly<Partial<Record<RequestIntent, RunPower>>> = {
  approve: "approve",
  answer: "answer",
  review: "review",
  take_over: "take_over",
};

const GRANT_TARGET: Readonly<
  Record<RunPower, { kind: string; column: string }>
> = {
  approve: { kind: "question", column: "question_id" },
  answer: { kind: "question", column: "question_id" },
  review: { kind: "artifact_version", column: "artifact_version_id" },
  take_over: { kind: "run_step", column: "run_step_id" },
};

const NO_TARGET = "00000000-0000-0000-0000-000000000000";

/** Roles that already read every run, so a grant would add nothing. */
const SYSTEM_ROLES = ["admin", "developer", "viewer", "guest"] as const;

const RUN_GRANT_PERMISSIONS = [
  ...new Set(
    (Object.keys(RUN_GRANT_ACTIONS) as CatalogActionName[]).map(
      permissionForAction,
    ),
  ),
];
const RUN_READ_PERMISSION = permissionForAction("runs.get");
const RUN_READ_SYSTEM_ROLES = SYSTEM_ROLES.filter((role) =>
  roleHasPermission(role, RUN_READ_PERMISSION)
);
const RUN_READ_BINDING_ROLES = BINDING_ROLES.filter((role) =>
  roleHasPermission(role, RUN_READ_PERMISSION)
);

type RequestRow = {
  id: string;
  run_id: string;
  step_key: string | null;
  target_id: string | null;
  intent: RequestIntent;
  recipient_id: string;
  recipient_name: string;
  asked_by: string | null;
  asked_by_name: string | null;
  asked_by_kind: "person" | "agent" | "workflow";
  note: string | null;
  needed_by: Date | string | null;
  status: "open" | "answered" | "handled" | "expired" | "withdrawn";
  expires_at: Date | string;
  fallback_for_name: string | null;
  audience_role_key: string | null;
  audience_group_id: string | null;
  audience_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  first_asked_at: Date | string | null;
  next_ask_hours: number | null;
  next_asked_at: Date | string | null;
  next_asked_name: string | null;
  next_role_key: string | null;
  next_planned_name: string | null;
  next_already_asked: boolean | null;
  next_ask_claimed: boolean;
  next_audience_has_new: boolean | null;
  passed_on_from: string | null;
};

const DEFAULT_NEXT_ASK_HOURS = 24;

const REQUEST_SELECT = `
  select request.id, request.run_id, request.step_key, request.target_id,
         request.intent,
         request.recipient_id, recipient.display_name as recipient_name,
         request.asked_by, asker.display_name as asked_by_name,
         request.asked_by_kind, request.note, request.needed_by,
         case when request.status = 'open' and request.expires_at <= now()
              then 'expired' else request.status end as status,
         request.expires_at, request.fallback_for_name,
         request.audience_role_key, request.audience_group_id,
         request.audience_name, request.created_at, request.updated_at, request.version,
         first_ask.first_asked_at,
         case when step.input ? 'ifNobodyAnswers'
              then coalesce((step.input #>> '{ifNobodyAnswers,afterHours}')::int,
                            ${DEFAULT_NEXT_ASK_HOURS})
         end as next_ask_hours,
         next_request.created_at as next_asked_at,
         next_request.name as next_asked_name,
         step.input #>> '{ifNobodyAnswers,recipientRoleKey}' as next_role_key,
         coalesce(next_person.display_name, next_group.name, next_role.name,
                  next_run_person.display_name) as next_planned_name,
         coalesce(next_person.id, next_run_person.id) = any(first_round.ids)
           as next_already_asked,
         next_claim.asked_at is not null as next_ask_claimed,
         next_audience.has_new as next_audience_has_new,
         passed_on.name as passed_on_from
    from bakery.person_requests as request
    join bakery.principals as recipient on recipient.id = request.recipient_id
    left join bakery.principals as asker on asker.id = request.asked_by
    left join bakery.run_steps as step
      on step.organization_id = request.organization_id
     and step.run_id = request.run_id and step.step_key = request.step_key
     and step.iteration = request.step_iteration
     and jsonb_typeof(step.input -> 'ifNobodyAnswers') = 'object'
    left join lateral (
      select min(sibling.created_at) as first_asked_at
        from bakery.person_requests as sibling
       where step.id is not null
         and sibling.organization_id = request.organization_id
         and sibling.run_id = request.run_id
         and sibling.step_key = request.step_key
         and sibling.step_iteration = request.step_iteration
    ) as first_ask on true
    left join lateral (
      select array_agg(first.recipient_id) as ids
        from bakery.person_requests as first
       where step.id is not null
         and first.organization_id = request.organization_id
         and first.run_id = request.run_id
         and first.step_key = request.step_key
         and first.step_iteration = request.step_iteration
         and first.created_at = first_ask.first_asked_at
    ) as first_round on true
    left join bakery.person_request_next_asks as next_claim
      on step.id is not null
     and next_claim.organization_id = request.organization_id
     and next_claim.run_id = request.run_id
     and next_claim.step_key = request.step_key
     and next_claim.step_iteration = request.step_iteration
    left join lateral (
      select later.created_at,
             coalesce(later.audience_name, later_recipient.display_name) as name
        from bakery.person_requests as later
        join bakery.principals as later_recipient
          on later_recipient.id = later.recipient_id
       where step.id is not null
         and later.organization_id = request.organization_id
         and later.run_id = request.run_id
         and later.step_key = request.step_key
         and later.step_iteration = request.step_iteration
         and later.created_at > first_ask.first_asked_at
       order by later.created_at, later.id
       limit 1
    ) as next_request on true
    left join lateral (
      select principal.id, principal.display_name
        from bakery.principals as principal
        join bakery.organization_memberships as membership
          on membership.principal_id = principal.id
         and membership.organization_id = request.organization_id
         and membership.status = 'active'
       where principal.id::text = step.input #>> '{ifNobodyAnswers,recipientId}'
         and principal.disabled_at is null
    ) as next_person on true
    left join bakery.organization_groups as next_group
      on next_group.organization_id = request.organization_id
     and next_group.id::text = step.input #>> '{ifNobodyAnswers,recipientGroupId}'
    left join bakery.organization_roles as next_role
      on next_role.organization_id = request.organization_id
     and next_role.key = step.input #>> '{ifNobodyAnswers,recipientRoleKey}'
    left join bakery.workflow_runs as next_run
      on step.input #>> '{ifNobodyAnswers,recipientRunRole}' is not null
     and next_run.organization_id = request.organization_id
     and next_run.id = request.run_id
    left join bakery.tasks as next_task
      on next_task.organization_id = next_run.organization_id
     and next_task.id = next_run.task_id
    left join lateral (
      select principal.id, principal.display_name
        from bakery.principals as principal
        join bakery.organization_memberships as membership
          on membership.principal_id = principal.id
         and membership.organization_id = request.organization_id
         and membership.status = 'active'
       where principal.disabled_at is null
         and principal.id = case step.input #>> '{ifNobodyAnswers,recipientRunRole}'
           when 'starter' then next_run.requested_by
           when 'task_owner' then next_task.created_by
         end
    ) as next_run_person on true
    left join lateral (
      select exists (
        select 1
          from bakery.organization_memberships as membership
          join bakery.principals as principal
            on principal.id = membership.principal_id
         where membership.organization_id = request.organization_id
           and membership.status = 'active'
           and principal.principal_type = 'human'
           and principal.disabled_at is null
           and membership.principal_id <> all(coalesce(first_round.ids, '{}'))
           and (
             exists (
               select 1 from bakery.organization_group_members as member
                where member.organization_id = request.organization_id
                  and member.group_id = next_group.id
                  and member.principal_id = membership.principal_id
             )
             or (membership.custom_role_id is null
                 and membership.role in ('admin', 'developer')
                 and membership.role
                   = step.input #>> '{ifNobodyAnswers,recipientRoleKey}')
             or membership.custom_role_id = next_role.id
           )
      ) as has_new
       where next_group.id is not null
          or step.input #>> '{ifNobodyAnswers,recipientRoleKey}' is not null
    ) as next_audience on true
    ${passedOnFromJoin("request", "passed_on")}`;

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function unprocessable(path: string[], code: string, message: string): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path, code, message }] },
  });
}

function toRunRequest(row: RequestRow) {
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    questionId: row.intent === "approve" || row.intent === "answer"
      ? row.target_id
      : null,
    artifactVersionId: row.intent === "review" ? row.target_id : null,
    intent: row.intent,
    recipient: {
      principalId: row.recipient_id,
      displayName: row.recipient_name,
    },
    askedBy: row.asked_by === null || row.asked_by_name === null
      ? null
      : { principalId: row.asked_by, displayName: row.asked_by_name },
    askedByKind: row.asked_by_kind,
    note: row.note,
    neededBy: row.needed_by === null ? null : iso(row.needed_by),
    status: row.status,
    expiresAt: iso(row.expires_at),
    ownerFallback: row.fallback_for_name !== null,
    fallbackForName: row.fallback_for_name,
    audience: row.audience_name === null ? null : {
      roleKey: row.audience_role_key,
      groupId: row.audience_group_id,
      name: row.audience_name,
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
    ...nextAskOf(row),
  };
}

function plannedNextName(row: RequestRow): string | null {
  const systemRole = row.next_role_key === null
    ? undefined
    : SYSTEM_ROLE_NAMES[row.next_role_key];
  return systemRole ?? row.next_planned_name;
}

function nextAskOf(row: RequestRow) {
  if (row.next_ask_hours === null || row.first_asked_at === null) {
    return { nextAsk: null, passedOn: false };
  }
  const firstAskedAt = new Date(iso(row.first_asked_at)).getTime();
  if (new Date(iso(row.created_at)).getTime() > firstAskedAt) {
    return { nextAsk: null, passedOn: row.passed_on_from !== null };
  }
  const reachesNobodyNew = row.next_already_asked === true ||
    row.next_audience_has_new === false ||
    (row.next_ask_claimed && row.next_asked_at === null);
  if (reachesNobodyNew) return { nextAsk: null, passedOn: false };
  return {
    nextAsk: {
      dueAt: new Date(firstAskedAt + row.next_ask_hours * 3_600_000)
        .toISOString(),
      askedAt: row.next_asked_at === null ? null : iso(row.next_asked_at),
      who: row.next_asked_at === null
        ? plannedNextName(row)
        : row.next_asked_name,
    },
    passedOn: false,
  };
}

type RunFacts = {
  id: string;
  task_id: string;
  application_id: string;
  repository_id: string | null;
  requested_by: string | null;
  task_created_by: string | null;
  workflow_owner: string | null;
};

/** The run, if the caller may see its task; a hidden run is a missing run. */
async function loadRun(
  context: ActionContext,
  transaction: PgTransactionClient,
  organizationId: string,
  accessScope: ReturnType<typeof requireWorkTransaction>["accessScope"],
): Promise<RunFacts> {
  const runId = context.params.id;
  if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const values: unknown[] = [organizationId, runId];
  let scopeSql = "";
  if (accessScope !== undefined) {
    const scoped = accessScopeClause(
      accessScope,
      { application: "task.application_id", repository: "task.repository_id" },
      values.length + 1,
    );
    values.push(...scoped.values);
    scopeSql = ` and ${scoped.sql}`;
  }
  const found = await transaction.query<RunFacts>(
    `select run.id, run.task_id, task.application_id, task.repository_id,
            run.requested_by, task.created_by as task_created_by,
            definition.owner_principal_id as workflow_owner
       from bakery.workflow_runs as run
       join bakery.tasks as task
         on task.organization_id = run.organization_id
        and task.id = run.task_id
       left join bakery.workflow_versions as version
         on version.organization_id = run.organization_id
        and version.id = run.workflow_version_id
       left join bakery.workflow_definitions as definition
         on definition.organization_id = version.organization_id
        and definition.id = version.workflow_id
      where run.organization_id = $1 and run.id = $2${scopeSql}`,
    values,
  );
  const run = found.rows[0];
  if (!run) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return run;
}

/** An active human member of this organization, by id. */
async function activeHuman(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<{ displayName: string } | null> {
  const found = await transaction.query<{ display_name: string }>(
    `select principal.display_name
       from bakery.principals as principal
       join bakery.organization_memberships as membership
         on membership.principal_id = principal.id
      where membership.organization_id = $1 and membership.status = 'active'
        and principal.principal_type = 'human'
        and principal.disabled_at is null and principal.id = $2`,
    [organizationId, principalId],
  );
  const row = found.rows[0];
  return row ? { displayName: row.display_name } : null;
}

/**
 * Whether the person already reads every run through their role, so a grant
 * would only add a row that explains nothing. A custom role counts when it
 * holds run:read. A binding is not consulted: a grant on top of one is
 * harmless and removing it changes nothing.
 */
export async function hasStandingRunAccess(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<boolean> {
  const found = await transaction.query<
    { role: string | null; permissions: string[] | null }
  >(
    `select membership.role, custom.permissions
       from bakery.organization_memberships as membership
       left join bakery.organization_roles as custom
         on custom.organization_id = membership.organization_id
        and custom.id = membership.custom_role_id
      where membership.organization_id = $1 and membership.principal_id = $2
        and membership.status = 'active'`,
    [organizationId, principalId],
  );
  const row = found.rows[0];
  if (!row) return false;
  const custom = row.permissions;
  if (custom !== null) {
    return RUN_GRANT_PERMISSIONS.every((permission) =>
      custom.includes(permission)
    );
  }
  const role = SYSTEM_ROLES.find((name) => name === row.role);
  return role !== undefined &&
    RUN_GRANT_PERMISSIONS.every((permission) =>
      roleHasPermission(role, permission)
    );
}

async function ledger(
  transaction: PgTransactionClient,
  facts: Readonly<{
    organizationId: string;
    taskId: string;
    runId: string;
    kind: string;
    decidedBy: string;
    text: string;
    detail: Record<string, unknown>;
  }>,
): Promise<void> {
  await transaction.query(
    `insert into bakery.decisions_ledger
       (organization_id, task_id, run_id, kind, subject_kind, subject_id,
        decided_by, text, detail)
     values ($1, $2, $3, $4, 'run', $3, $5, $6, $7::jsonb)`,
    [
      facts.organizationId,
      facts.taskId,
      facts.runId,
      facts.kind,
      facts.decidedBy,
      facts.text,
      JSON.stringify(facts.detail),
    ],
  );
}

async function appendFacts(
  transaction: PgTransactionClient,
  context: ActionContext,
  facts: Readonly<{
    organizationId: string;
    principalId: string;
    agentSessionId?: string | null;
    operation: string;
    eventType: string;
    requestId: string;
    version: number;
    taskId: string;
    runId: string;
    details: Record<string, unknown>;
  }>,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    agentSessionId: facts.agentSessionId ?? null,
    operation: facts.operation,
    resourceType: "person_request",
    resourceId: facts.requestId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: facts.details,
  });
  await appendDomainEvent(transaction, {
    organizationId: facts.organizationId,
    taskId: facts.taskId,
    eventType: facts.eventType,
    aggregateId: facts.requestId,
    aggregateVersion: facts.version,
    payload: { resourceId: facts.requestId, resourceVersion: facts.version },
    traceId: context.traceId,
  });
}

async function readRequest(
  transaction: PgTransactionClient,
  organizationId: string,
  requestId: string,
): Promise<RequestRow> {
  const found = await transaction.query<RequestRow>(
    `${REQUEST_SELECT} where request.organization_id = $1 and request.id = $2`,
    [organizationId, requestId],
  );
  const row = found.rows[0];
  if (!row) throw new Error("REQUEST_READ_FAILED");
  return row;
}

/** runRequests.create */
export async function createRunRequest(context: ActionContext, input: unknown) {
  return await requestOnRun(context, input, null);
}

export type WorkflowStepAsk = Readonly<{
  stepKey: string;
  recipientId?: string;
  recipientRoleKey?: string;
  recipientGroupId?: string;
  intent: "fyi" | "review";
  artifactVersionId?: string;
  note?: string;
  iteration: number;
}>;

export async function askFromWorkflowStep(
  context: ActionContext,
  ask: WorkflowStepAsk,
) {
  const { iteration, ...rest } = ask;
  return await requestOnRun(context, rest, {
    stepKey: ask.stepKey,
    iteration,
  });
}

async function requestOnRun(
  context: ActionContext,
  input: unknown,
  step: Readonly<{ stepKey: string; iteration: number }> | null,
  unresolvedName: string | null = null,
) {
  const { transaction, organizationId, principalId, accessScope } =
    requireWorkTransaction(context);
  const asker = step === null ? principalId : null;
  const value = input as {
    recipientId?: string;
    recipientRoleKey?: string;
    recipientGroupId?: string;
    intent: RequestIntent;
    stepKey?: string;
    questionId?: string;
    artifactVersionId?: string;
    note?: string;
    neededBy?: string;
  };
  const run = await loadRun(context, transaction, organizationId, accessScope);

  const named = [
    value.recipientId ?? unresolvedName ?? undefined,
    value.recipientRoleKey,
    value.recipientGroupId,
  ].filter((recipient) => recipient !== undefined).length;
  if (named !== 1) {
    unprocessable(
      ["recipientId"],
      "request_recipient_required",
      "Name one person, one role or one group to ask",
    );
  }
  // An agent asks only where a person granted it, and only whom the grant
  // names; checked before anything is written.
  const exercised = await guardAgentAsk(transaction, context, {
    organizationId,
    principalId,
    runId: run.id,
    roleKey: value.recipientRoleKey ?? null,
    groupId: value.recipientGroupId ?? null,
  });

  const power = POWER_OF_INTENT[value.intent];
  const asksQuestion = value.intent === "approve" || value.intent === "answer";
  if (!asksQuestion && value.questionId !== undefined) {
    unprocessable(
      ["questionId"],
      "request_question_unexpected",
      "Only an approve or answer request names a question",
    );
  }
  if (value.intent !== "review" && value.artifactVersionId !== undefined) {
    unprocessable(
      ["artifactVersionId"],
      "request_artifact_version_unexpected",
      "Only a review request names an artifact version",
    );
  }
  let targetId: string | null = null;
  if (asksQuestion) {
    if (value.questionId === undefined) {
      unprocessable(
        ["questionId"],
        "request_question_required",
        "Name the approval or question the request asks about",
      );
    }
    const target = await transaction.query<{
      kind: string;
      subject_type: string | null;
      status: string;
      expires_at: Date | null;
      audience: QuestionAudience | null;
    }>(
      `select kind, subject_type, status, expires_at, audience
         from bakery.questions
        where organization_id = $1 and id = $2 and run_id = $3`,
      [organizationId, value.questionId, run.id],
    );
    const found = target.rows[0];
    if (!found) {
      unprocessable(
        ["questionId"],
        "request_question_not_found",
        "No such approval or question on this run",
      );
    }
    if (
      attributeAction(context, principalId).actorKind === "person" &&
      !decidesItself(found.audience, principalId)
    ) {
      forbidden(REQUEST_POWER_NOT_HELD);
    }
    const kindMatches = power === "approve"
      ? found.kind === "approval" && found.subject_type === "run_step"
      : found.kind === "question";
    if (!kindMatches) {
      unprocessable(
        ["questionId"],
        "request_question_wrong_kind",
        power === "approve"
          ? "That is not a step approval"
          : "That is not a question",
      );
    }
    if (
      found.status !== "open" ||
      (found.expires_at !== null && found.expires_at.getTime() <= Date.now())
    ) {
      unprocessable(
        ["questionId"],
        "request_question_closed",
        "That approval or question is no longer open",
      );
    }
    targetId = value.questionId;
  } else if (value.intent === "review") {
    if (value.artifactVersionId === undefined) {
      unprocessable(
        ["artifactVersionId"],
        "request_artifact_version_required",
        "Name the artifact version the request asks someone to review",
      );
    }
    const produced = await transaction.query(
      `select 1 from bakery.artifact_versions version
         join bakery.run_steps step
           on step.organization_id = version.organization_id
          and step.id = version.run_step_id
        where version.organization_id = $1 and version.id = $2
          and step.run_id = $3`,
      [organizationId, value.artifactVersionId, run.id],
    );
    if (produced.rows.length === 0) {
      unprocessable(
        ["artifactVersionId"],
        "request_artifact_version_not_found",
        "No such artifact version on this run",
      );
    }
    targetId = value.artifactVersionId;
  } else if (value.intent === "take_over") {
    if (value.stepKey === undefined) {
      unprocessable(
        ["stepKey"],
        "request_step_required",
        "Name the step the request asks someone to take over",
      );
    }
    const step = await transaction.query<{ id: string; status: string }>(
      `select id, status from bakery.run_steps
        where organization_id = $1 and run_id = $2 and step_key = $3
        order by iteration desc limit 1`,
      [organizationId, run.id, value.stepKey],
    );
    const found = step.rows[0];
    if (!found) {
      unprocessable(["stepKey"], "request_step_not_found", "No such step");
    }
    if (!["pending", "running", "waiting"].includes(found.status)) {
      unprocessable(
        ["stepKey"],
        "request_step_finished",
        "That step is already finished",
      );
    }
    targetId = found.id;
  }
  const note = value.note?.trim() ?? "";
  if (note.length > REQUEST_NOTE_MAX) {
    unprocessable(["note"], "request_note_too_long", "The note is too long");
  }
  if (value.stepKey !== undefined) {
    const step = await transaction.query(
      `select 1 from bakery.run_steps
        where organization_id = $1 and run_id = $2 and step_key = $3`,
      [organizationId, run.id, value.stepKey],
    );
    if (step.rows.length === 0) {
      unprocessable(["stepKey"], "request_step_not_found", "No such step");
    }
  }
  const neededBy = value.neededBy === undefined
    ? null
    : new Date(value.neededBy);
  if (neededBy !== null && Number.isNaN(neededBy.getTime())) {
    unprocessable(["neededBy"], "request_needed_by_invalid", "Not a date");
  }
  if (neededBy !== null) {
    const limit = Date.now() + REQUEST_LIFETIME_DAYS * 86_400_000;
    if (neededBy.getTime() > limit) {
      unprocessable(
        ["neededBy"],
        "request_needed_by_after_expiry",
        "Needed by must be before the request expires",
      );
    }
  }
  // Who is asked: one person, or every active member of one role or one group,
  // resolved now and frozen on one request row each.
  const roleKey = value.recipientRoleKey ?? null;
  const groupId = value.recipientGroupId ?? null;
  const recipients: Recipient[] = [];
  let audience: Audience | null = null;
  if (roleKey !== null || groupId !== null) {
    const resolved = await audienceMembers(
      transaction,
      organizationId,
      roleKey,
      groupId,
    );
    audience = { roleKey, groupId, name: resolved.name };
    const others = resolved.members.filter((id) => id !== asker);
    if (others.length === 0) {
      const path = roleKey !== null ? "recipientRoleKey" : "recipientGroupId";
      if (resolved.members.length > 0) {
        unprocessable([path], "request_self", "You cannot ask yourself");
      }
      unprocessable(
        [path],
        "request_audience_empty",
        "Nobody holds that role or is in that group right now",
      );
    }
    if (others.length > REQUEST_AUDIENCE_MAX) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "request_audience_too_large" },
      });
    }
    for (const id of others) {
      recipients.push({ principalId: id, fallbackForName: null });
    }
  } else {
    const meantId = value.recipientId ?? null;
    if (meantId !== null && meantId === asker) {
      unprocessable(["recipientId"], "request_self", "You cannot ask yourself");
    }
    const resolved = meantId === null
      ? null
      : await activeHuman(transaction, organizationId, meantId);
    if (meantId === null || resolved === null) {
      const meant = meantId === null
        ? unresolvedName
        : (await transaction.query<{ display_name: string }>(
          `select principal.display_name from bakery.principals as principal
             join bakery.organization_memberships as membership
               on membership.principal_id = principal.id
              and membership.organization_id = $2
            where principal.id = $1`,
          [meantId, organizationId],
        )).rows[0]?.display_name ?? null;
      const owner = await fallbackOwner(
        transaction,
        organizationId,
        run,
        asker,
      );
      if (owner === null) {
        unprocessable(
          ["recipientId"],
          "request_recipient_unavailable",
          "That person cannot be asked and nobody else can be asked in their place",
        );
      }
      recipients.push({
        principalId: owner,
        fallbackForName: meant ?? "someone",
      });
    } else {
      recipients.push({ principalId: meantId, fallbackForName: null });
    }
  }

  const actor: Actor = {
    kind: step === null
      ? attributeAction(context, principalId).actorKind
      : "workflow",
    sessionId: exercised?.origin?.agentSessionId ?? null,
    fromRunId: exercised?.origin?.runId ?? null,
  };
  let first: string | null = null;
  for (const recipient of recipients) {
    const id = await askOne(context, transaction, {
      organizationId,
      principalId,
      run,
      intent: value.intent,
      stepKey: value.stepKey ?? null,
      stepIteration: step?.iteration ?? null,
      targetId,
      power,
      note: note === "" ? null : note,
      neededBy,
      recipient,
      audience,
      actor,
    });
    first ??= id;
  }
  if (first === null) throw new Error("REQUEST_INSERT_FAILED");
  return toRunRequest(await readRequest(transaction, organizationId, first));
}

export type WorkflowApprovalAsk = Readonly<{
  stepKey: string;
  iteration: number;
  questionId: string;
  recipients: readonly Readonly<{
    principalId: string;
    fallbackForName: string | null;
    audience: Audience | null;
  }>[];
}>;

export async function askApproversFromWorkflowStep(
  context: ActionContext,
  ask: WorkflowApprovalAsk,
): Promise<void> {
  const { transaction, organizationId, principalId, accessScope } =
    requireWorkTransaction(context);
  const run = await loadRun(context, transaction, organizationId, accessScope);
  for (const recipient of ask.recipients) {
    await askOne(context, transaction, {
      organizationId,
      principalId,
      run,
      intent: "approve",
      stepKey: ask.stepKey,
      stepIteration: ask.iteration,
      targetId: ask.questionId,
      power: POWER_OF_INTENT.approve,
      note: null,
      neededBy: null,
      recipient: {
        principalId: recipient.principalId,
        fallbackForName: recipient.fallbackForName,
      },
      audience: recipient.audience,
      actor: { kind: "workflow", sessionId: null, fromRunId: null },
    });
  }
}

const SYSTEM_ROLE_HANDLES: Readonly<Record<string, string>> = {
  admins: "admin",
  developers: "developer",
};

export async function audienceByHandle(
  transaction: PgTransactionClient,
  organizationId: string,
  handle: string,
): Promise<(Audience & { members: string[] }) | null> {
  const systemRole = SYSTEM_ROLE_HANDLES[handle];
  if (systemRole !== undefined) {
    const found = await audienceMembers(
      transaction,
      organizationId,
      systemRole,
      null,
    );
    return { roleKey: systemRole, groupId: null, ...found };
  }
  const group = await transaction.query<{ id: string }>(
    `select id from bakery.organization_groups
      where organization_id = $1 and mention_name = $2`,
    [organizationId, handle],
  );
  const groupId = group.rows[0]?.id;
  if (groupId !== undefined) {
    const found = await audienceMembers(
      transaction,
      organizationId,
      null,
      groupId,
    );
    return { roleKey: null, groupId, ...found };
  }
  const role = await transaction.query(
    `select 1 from bakery.organization_roles
      where organization_id = $1 and key = $2`,
    [organizationId, handle],
  );
  if (role.rows.length === 0) return null;
  const found = await audienceMembers(
    transaction,
    organizationId,
    handle,
    null,
  );
  return { roleKey: handle, groupId: null, ...found };
}

export async function tagMentionedOnSteer(
  context: ActionContext,
  steer: Readonly<{
    runId: string;
    stepKey: string;
    mentions: readonly string[];
    mentionHandles: readonly string[];
  }>,
): Promise<void> {
  if (steer.mentions.length === 0 && steer.mentionHandles.length === 0) return;
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const authority = (context as { authority?: unknown }).authority;
  if (
    typeof authority !== "object" || authority === null ||
    !("organizationId" in authority)
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const runContext = {
    ...context,
    params: { ...context.params, id: steer.runId },
  } as ActionContext;
  const run = await loadRun(runContext, transaction, organizationId, undefined);
  const asks: {
    input: Record<string, string>;
    unresolvedName: string | null;
    reached: readonly string[];
  }[] = [];
  for (const recipientId of new Set(steer.mentions)) {
    if (recipientId === principalId) continue;
    const person = await activeHuman(transaction, organizationId, recipientId);
    asks.push({
      input: { recipientId },
      unresolvedName: null,
      reached: person === null ? [] : [recipientId],
    });
  }
  for (const raw of new Set(steer.mentionHandles)) {
    const handle = raw.startsWith("@") ? raw.slice(1) : raw;
    const found = await audienceByHandle(transaction, organizationId, handle);
    const others = found?.members.filter((id) => id !== principalId) ?? [];
    if (found !== null && found.members.length > 0 && others.length === 0) {
      continue;
    }
    if (found === null || others.length === 0) {
      asks.push({
        input: {},
        unresolvedName: found?.name ?? `@${handle}`,
        reached: [],
      });
      continue;
    }
    asks.push({
      input: found.groupId === null
        ? { recipientRoleKey: found.roleKey as string }
        : { recipientGroupId: found.groupId },
      unresolvedName: null,
      reached: others,
    });
  }
  if (!mayShareRun(authority as OrganizationActor)) {
    for (const ask of asks) {
      for (const id of ask.reached) {
        if (!(await seesRun(transaction, organizationId, id, run))) {
          throw new StandardError({
            code: "AUTH_FORBIDDEN",
            params: { reason: REQUEST_SHARE_FORBIDDEN },
          });
        }
      }
    }
  }
  for (const ask of asks) {
    await requestOnRun(
      runContext,
      { ...ask.input, intent: "fyi", stepKey: steer.stepKey },
      null,
      ask.unresolvedName,
    );
  }
}

export const REQUEST_SHARE_FORBIDDEN = "request_share_forbidden";

function mayShareRun(actor: OrganizationActor): boolean {
  try {
    authorize(actor, permissionForAction("runRequests.create"));
    return true;
  } catch (error) {
    if (error instanceof StandardError) return false;
    throw error;
  }
}

async function seesRun(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  run: RunFacts,
): Promise<boolean> {
  if (
    await hasLiveRunGrant(
      transaction,
      organizationId,
      principalId,
      "run",
      run.id,
    )
  ) {
    return true;
  }
  let actor: OrganizationActor;
  try {
    actor = await resolveOrganizationActor(
      transaction,
      toPrincipalId(principalId),
      toOrganizationId(organizationId),
      { lockMembership: false },
    );
  } catch (error) {
    if (error instanceof StandardError) return false;
    throw error;
  }
  const permission = permissionForAction("runs.get");
  try {
    authorize(actor, permission);
    return true;
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
  }
  const task = await transaction.query<
    { application_id: string; repository_id: string | null }
  >(
    `select application_id, repository_id from bakery.tasks
      where organization_id = $1 and id = $2`,
    [organizationId, run.task_id],
  );
  const target = task.rows[0];
  if (!target) return false;
  return (actor.bindings ?? []).some((binding) =>
    bindingAllows(binding, permission) &&
    bindingCovers(binding, {
      applicationId: target.application_id,
      repositoryId: target.repository_id,
    })
  );
}

async function fallbackOwner(
  transaction: PgTransactionClient,
  organizationId: string,
  run: RunFacts,
  asker: string | null,
): Promise<string | null> {
  const candidates = [
    run.workflow_owner,
    run.requested_by,
    run.task_created_by,
  ];
  for (const candidate of new Set(candidates)) {
    if (candidate === null || candidate === asker) continue;
    if (await activeHuman(transaction, organizationId, candidate)) {
      return candidate;
    }
  }
  return null;
}

type Recipient = Readonly<{
  principalId: string;
  /** Who was meant when the run's starter is asked in their place (O62). */
  fallbackForName: string | null;
}>;

/** The role or group a request was asked of, frozen with its members. */
type Audience = Readonly<{
  roleKey: string | null;
  groupId: string | null;
  name: string;
}>;

/**
 * Who made the ask, recorded the same way for a person and an agent: the same
 * keys on every ledger and audit row, so an agent's row differs from a
 * person's only in these values (O50).
 */
type Actor = Readonly<{
  kind: "person" | "agent" | "workflow";
  sessionId: string | null;
  fromRunId: string | null;
}>;

/** The names Bakery gives the built-in roles a request can ask. */
const SYSTEM_ROLE_NAMES: Readonly<Record<string, string>> = {
  admin: "Administrators",
  developer: "Developers",
};

/**
 * The active human members of one role or one group, at this moment. A
 * built-in role counts members who hold it with no custom role, as the groups
 * page does; a custom role is named by its key.
 */
async function audienceMembers(
  transaction: PgTransactionClient,
  organizationId: string,
  roleKey: string | null,
  groupId: string | null,
): Promise<{ name: string; members: string[] }> {
  const human = `membership.organization_id = $1
        and membership.status = 'active'
        and principal.principal_type = 'human'
        and principal.disabled_at is null`;
  if (roleKey !== null) {
    const systemName = SYSTEM_ROLE_NAMES[roleKey];
    if (systemName !== undefined) {
      const found = await transaction.query<{ principal_id: string }>(
        `select membership.principal_id
           from bakery.organization_memberships as membership
           join bakery.principals as principal
             on principal.id = membership.principal_id
          where ${human} and membership.role = $2
            and membership.custom_role_id is null
          order by lower(principal.display_name), membership.principal_id`,
        [organizationId, roleKey],
      );
      return {
        name: systemName,
        members: found.rows.map((row) => row.principal_id),
      };
    }
    const role = await transaction.query<{ id: string; name: string }>(
      `select id, name from bakery.organization_roles
        where organization_id = $1 and key = $2`,
      [organizationId, roleKey],
    );
    const custom = role.rows[0];
    if (!custom) {
      unprocessable(
        ["recipientRoleKey"],
        "request_audience_not_found",
        "No such role",
      );
    }
    const found = await transaction.query<{ principal_id: string }>(
      `select membership.principal_id
         from bakery.organization_memberships as membership
         join bakery.principals as principal
           on principal.id = membership.principal_id
        where ${human} and membership.custom_role_id = $2
        order by lower(principal.display_name), membership.principal_id`,
      [organizationId, custom.id],
    );
    return {
      name: custom.name,
      members: found.rows.map((row) => row.principal_id),
    };
  }
  const group = await transaction.query<{ name: string }>(
    `select name from bakery.organization_groups
      where organization_id = $1 and id = $2`,
    [organizationId, groupId],
  );
  const named = group.rows[0];
  if (!named) {
    unprocessable(
      ["recipientGroupId"],
      "request_audience_not_found",
      "No such group",
    );
  }
  const found = await transaction.query<{ principal_id: string }>(
    `select member.principal_id
       from bakery.organization_group_members as member
       join bakery.organization_memberships as membership
         on membership.organization_id = member.organization_id
        and membership.principal_id = member.principal_id
       join bakery.principals as principal
         on principal.id = member.principal_id
      where ${human} and member.group_id = $2
      order by lower(principal.display_name), member.principal_id`,
    [organizationId, groupId],
  );
  return {
    name: named.name,
    members: found.rows.map((row) => row.principal_id),
  };
}

/**
 * Refuses an agent's ask unless a live ask grant names the role or group it
 * asks, and only on the run its session belongs to (a step asks about its own
 * run). A person passes untouched, and so does a seat agent asking one person,
 * which keeps the rule it always had. Called before anything is written.
 */
async function guardAgentAsk(
  transaction: PgTransactionClient,
  context: ActionContext,
  scope: Readonly<{
    organizationId: string;
    principalId: string;
    runId: string;
    roleKey: string | null;
    groupId: string | null;
  }>,
): Promise<ExercisedPower | null> {
  const attribution = attributeAction(context, scope.principalId);
  if (attribution.actorKind === "person") return null;
  const audienceAsk = scope.roleKey !== null || scope.groupId !== null;
  if (context.agentSession === undefined && !audienceAsk) return null;
  const exercised = await assertAgentMayExercise(transaction, context, {
    organizationId: scope.organizationId,
    principalId: scope.principalId,
    power: AgentPower.Ask,
  });
  if (exercised.origin !== null && exercised.origin.runId !== scope.runId) {
    forbidden(AGENT_ASK_OWN_RUN_ONLY);
  }
  if (!audienceAsk) forbidden(AGENT_ASK_AUDIENCE_NOT_GRANTED);
  const grants = (await matchingGrants(transaction, {
    organizationId: scope.organizationId,
    power: AgentPower.Ask,
    workflowId: exercised.origin?.workflowId ?? null,
    accessTokenId: attribution.accessTokenId,
  })).filter((grant) =>
    scope.roleKey !== null
      ? grant.roleKey === scope.roleKey
      : grant.groupId === scope.groupId
  );
  if (grants.length === 0) forbidden(AGENT_ASK_AUDIENCE_NOT_GRANTED);
  if (!grants.some((grant) => !grant.expired)) throw grantRefusal(grants);
  return exercised;
}

function forbidden(reason: string): never {
  throw new StandardError({ code: "AUTH_FORBIDDEN", params: { reason } });
}

/**
 * Asks one person: reminds them of the same open request, or makes a new one
 * with its observe grant and its one power, and records it. Returns the
 * request's id.
 */
async function askOne(
  context: ActionContext,
  transaction: PgTransactionClient,
  ask: Readonly<{
    organizationId: string;
    principalId: string;
    run: RunFacts;
    intent: RequestIntent;
    stepKey: string | null;
    stepIteration: number | null;
    targetId: string | null;
    power: RunPower | undefined;
    note: string | null;
    neededBy: Date | null;
    recipient: Recipient;
    audience: Audience | null;
    actor: Actor;
  }>,
): Promise<string> {
  const { organizationId, principalId, run, actor, audience } = ask;
  const recipientId = ask.recipient.principalId;
  const fallbackForName = ask.recipient.fallbackForName;
  // The same keys on every row a person or an agent writes (O50).
  const actorDetail = {
    actorKind: actor.kind,
    onBehalfOf: actor.kind === "person" ? null : principalId,
    sessionId: actor.sessionId,
    fromRunId: actor.fromRunId,
    audienceRoleKey: audience?.roleKey ?? null,
    audienceGroupId: audience?.groupId ?? null,
  };
  // A request past its time is over; asking again makes a new one.
  await transaction.query(
    `update bakery.person_requests
        set status = 'expired', updated_at = now(), version = version + 1
      where organization_id = $1 and run_id = $2 and recipient_id = $3
        and intent = $4 and status = 'open' and expires_at <= now()`,
    [organizationId, run.id, recipientId, ask.intent],
  );
  const open = await transaction.query<{ id: string }>(
    `select id from bakery.person_requests
      where organization_id = $1 and run_id = $2 and recipient_id = $3
        and intent = $4 and coalesce(step_key, '') = $5 and status = 'open'
        and coalesce(target_id, $6::uuid) = coalesce($7::uuid, $6::uuid)
        and coalesce(step_iteration, -1) = coalesce($8::int, -1)
      for update`,
    [
      organizationId,
      run.id,
      recipientId,
      ask.intent,
      ask.stepKey ?? "",
      NO_TARGET,
      ask.targetId,
      ask.stepIteration,
    ],
  );
  if (open.rows[0]) {
    // Asking again reminds: the same open request, touched. A reminder is an
    // act like any other, so it is recorded: the decisions ledger, the audit
    // trail and the invalidation event all say it happened.
    const reminded = await transaction.query<{ version: number }>(
      `update bakery.person_requests
          set updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2
        returning version`,
      [organizationId, open.rows[0].id],
    );
    const remindedVersion = reminded.rows[0]?.version;
    if (remindedVersion === undefined) throw new Error("REQUEST_REMIND_FAILED");
    await ledger(transaction, {
      organizationId,
      taskId: run.task_id,
      runId: run.id,
      kind: "request_reminded",
      decidedBy: principalId,
      text: ask.intent,
      detail: {
        requestId: open.rows[0].id,
        recipientId,
        intent: ask.intent,
        ...actorDetail,
      },
    });
    await appendFacts(transaction, context, {
      organizationId,
      principalId,
      agentSessionId: actor.sessionId,
      operation: "runRequests.create",
      eventType: "runRequest.created",
      requestId: open.rows[0].id,
      version: remindedVersion,
      taskId: run.task_id,
      runId: run.id,
      details: {
        runId: run.id,
        intent: ask.intent,
        reminded: true,
        ...actorDetail,
      },
    });
    return open.rows[0].id;
  }

  const created = await transaction.query<{ id: string }>(
    `insert into bakery.person_requests (
       organization_id, run_id, task_id, step_key, intent, recipient_id,
       fallback_for_name, asked_by, asked_by_kind, note, needed_by, expires_at,
       target_id, audience_role_key, audience_group_id, audience_name,
       step_iteration)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             now() + make_interval(days => $12), $13, $14, $15, $16, $17)
     returning id`,
    [
      organizationId,
      run.id,
      run.task_id,
      ask.stepKey,
      ask.intent,
      recipientId,
      fallbackForName,
      principalId,
      actor.kind,
      ask.note,
      ask.neededBy,
      REQUEST_LIFETIME_DAYS,
      ask.targetId,
      audience?.roleKey ?? null,
      audience?.groupId ?? null,
      audience?.name ?? null,
      ask.stepIteration,
    ],
  );
  const requestId = created.rows[0]?.id;
  if (!requestId) throw new Error("REQUEST_INSERT_FAILED");

  // The one power, on exactly that row, for as long as the request lasts. It
  // is given whatever role the person already has: observe says nothing about
  // doing, and the gate asks the grant only when the role refuses.
  if (ask.power !== undefined) {
    const target = GRANT_TARGET[ask.power];
    await transaction.query(
      `update bakery.run_power_grants
          set revoked_at = now(), revoked_by = $5, version = version + 1
        where organization_id = $1 and principal_id = $2 and power = $3
          and coalesce(question_id, artifact_version_id, run_step_id) = $4
          and revoked_at is null`,
      [organizationId, recipientId, ask.power, ask.targetId, principalId],
    );
    await transaction.query(
      `insert into bakery.run_power_grants (
         organization_id, run_id, principal_id, power, target_kind,
         ${target.column}, source_request_id, expires_at)
       select $1, $2, $3, $4, $5, $6, $7, expires_at
         from bakery.person_requests
        where organization_id = $1 and id = $7
       on conflict (
         organization_id, principal_id, power,
         (coalesce(question_id, artifact_version_id, run_step_id))
       ) where revoked_at is null do nothing`,
      [
        organizationId,
        run.id,
        recipientId,
        ask.power,
        target.kind,
        ask.targetId,
        requestId,
      ],
    );
  }

  // The right to see this run, unless the person already can through a role.
  // Observe stays after the request ends; only removing access takes it away.
  const standing = await hasStandingRunAccess(
    transaction,
    organizationId,
    recipientId,
  );
  if (!standing) {
    await transaction.query(
      `insert into bakery.run_access_grants (
         organization_id, run_id, task_id, principal_id, source_request_id,
         via, granted_by, granted_by_kind)
       values ($1, $2, $3, $4, $5, 'request', $6, $7)
       on conflict do nothing`,
      [
        organizationId,
        run.id,
        run.task_id,
        recipientId,
        requestId,
        principalId,
        actor.kind,
      ],
    );
  }
  await ledger(transaction, {
    organizationId,
    taskId: run.task_id,
    runId: run.id,
    kind: "request",
    decidedBy: principalId,
    text: ask.intent,
    detail: {
      requestId,
      recipientId,
      intent: ask.intent,
      ownerFallback: fallbackForName !== null,
      ...actorDetail,
    },
  });
  await appendFacts(transaction, context, {
    organizationId,
    principalId,
    agentSessionId: actor.sessionId,
    operation: "runRequests.create",
    eventType: "runRequest.created",
    requestId,
    version: 1,
    taskId: run.task_id,
    runId: run.id,
    details: {
      runId: run.id,
      intent: ask.intent,
      ownerFallback: fallbackForName !== null,
      granted: !standing,
      ...actorDetail,
    },
  });
  return requestId;
}

/** runRequests.list: the requests made on one run, newest first. */
export async function listRunRequests(context: ActionContext) {
  const { transaction, organizationId, accessScope } = requireWorkTransaction(
    context,
  );
  const run = await loadRun(context, transaction, organizationId, accessScope);
  const found = await transaction.query<RequestRow>(
    `${REQUEST_SELECT}
      where request.organization_id = $1 and request.run_id = $2
      order by request.created_at desc, request.id desc limit $3`,
    [organizationId, run.id, REQUEST_LIST_LIMIT],
  );
  return { requests: found.rows.map(toRunRequest) };
}

/**
 * runRequests.mine: the requests addressed to the caller on one run. It needs
 * no run access of its own: a person asked is told what they were asked even
 * after their access was removed, and nothing here names anyone else's
 * requests.
 */
export async function myRunRequests(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const runId = context.params.id;
  if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const found = await transaction.query<RequestRow>(
    `${REQUEST_SELECT}
      where request.organization_id = $1 and request.run_id = $2
        and request.recipient_id = $3
      order by request.created_at desc, request.id desc limit $4`,
    [organizationId, runId, principalId, REQUEST_LIST_LIMIT],
  );
  return { requests: found.rows.map(toRunRequest) };
}

const PROJECT_RUN_PRINCIPALS_SQL = `
  select distinct membership.principal_id
    from bakery.organization_memberships as membership
    join bakery.principals as principal on principal.id = membership.principal_id
    left join bakery.organization_roles as custom
      on custom.organization_id = membership.organization_id
     and custom.id = membership.custom_role_id
   where membership.organization_id = $1 and membership.status = 'active'
     and principal.principal_type = 'human' and principal.disabled_at is null
     and (
       membership.role = any($3::text[])
       or $4 = any(coalesce(custom.permissions, array[]::text[]))
       or exists (
         select 1
           from bakery.access_bindings as binding
          where binding.organization_id = membership.organization_id
            and binding.principal_id = membership.principal_id
            and binding.role_key = any($5::text[])
            and (
              binding.application_id = $6
              or ($7::uuid is not null and binding.repository_id = $7)
            )
       )
     )`;

type RunAccessRow = {
  id: string;
  principal_id: string;
  display_name: string;
  via: string;
  granted_by: string | null;
  granted_by_name: string | null;
  granted_by_kind: "person" | "agent" | "workflow";
  created_at: Date | string;
  cursor_created_at: string;
  cursor_position: number;
  source_request_id: string | null;
  audience_name: string | null;
  version: number;
};

type RunAccessPowerRow = {
  principal_id: string;
  intent: Exclude<RequestIntent, "fyi">;
  step_key: string | null;
  target_id: string;
  expires_at: Date | string;
};

const RUN_ACCESS_ORDERING = "openRequest:desc,createdAt:desc,id:desc";

export async function listRunAccess(
  context: ActionContext,
  input: { cursor?: string; limit?: number },
  cursorSecret: string,
) {
  const {
    transaction,
    organizationId,
    principalId,
    accessScope,
  } = requireWorkTransaction(context);
  const run = await loadRun(context, transaction, organizationId, accessScope);
  const limit = input.limit ?? 20;
  const binding: CursorBinding = {
    action: "runAccess.list",
    organizationId,
    principalId,
    ordering: RUN_ACCESS_ORDERING,
    filters: JSON.stringify({ runId: run.id }),
    schemaVersion: 1,
  };
  const position = await decodeCursor(cursorSecret, input.cursor, binding);
  const projectParameters = [
    organizationId,
    run.id,
    RUN_READ_SYSTEM_ROLES,
    RUN_READ_PERMISSION,
    RUN_READ_BINDING_ROLES,
    run.application_id,
    run.repository_id,
  ];
  const project = await transaction.query<{ count: number }>(
    `with project_principals as (${PROJECT_RUN_PRINCIPALS_SQL})
     select count(*)::int as count from project_principals
      where $2::uuid is not null`,
    projectParameters,
  );
  const direct = await transaction.query<RunAccessRow>(
    `with project_principals as (${PROJECT_RUN_PRINCIPALS_SQL})
     select access_grant.id, access_grant.principal_id, principal.display_name,
            access_grant.via, access_grant.granted_by,
            grantor.display_name as granted_by_name,
            access_grant.granted_by_kind, access_grant.created_at,
            to_char(
              access_grant.created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) as cursor_created_at,
            case when current_open_request.present is not null
              then 1 else 0 end as cursor_position,
            access_grant.source_request_id, request.audience_name,
            access_grant.version
       from bakery.run_access_grants as access_grant
       join bakery.principals as principal
         on principal.id = access_grant.principal_id
       join bakery.organization_memberships as membership
         on membership.organization_id = access_grant.organization_id
        and membership.principal_id = access_grant.principal_id
        and membership.status = 'active'
       left join bakery.principals as grantor
         on grantor.id = access_grant.granted_by
       left join bakery.person_requests as request
         on request.organization_id = access_grant.organization_id
        and request.id = access_grant.source_request_id
       left join lateral (
         select 1 as present
           from bakery.person_requests as current_request
          where current_request.organization_id = access_grant.organization_id
            and current_request.run_id = access_grant.run_id
            and current_request.recipient_id = access_grant.principal_id
            and current_request.status = 'open'
            and current_request.expires_at > now()
          limit 1
       ) as current_open_request on true
      where access_grant.organization_id = $1 and access_grant.run_id = $2
        and access_grant.revoked_at is null
        and principal.principal_type = 'human' and principal.disabled_at is null
        and not exists (
          select 1 from project_principals as project
           where project.principal_id = access_grant.principal_id
        )
        and (
          $8::timestamptz is null or
          (
            case when current_open_request.present is not null
              then 1 else 0 end,
            access_grant.created_at,
            access_grant.id
          ) < ($10::integer, $8, $9::uuid)
        )
      order by (current_open_request.present is not null) desc,
               access_grant.created_at desc, access_grant.id desc
      limit $11`,
    [
      ...projectParameters,
      position?.createdAt ?? null,
      position?.id ?? null,
      position?.position ?? null,
      limit + 1,
    ],
  );
  const directCount = await transaction.query<{ count: number }>(
    `with project_principals as (${PROJECT_RUN_PRINCIPALS_SQL})
     select count(*)::int as count
       from bakery.run_access_grants as access_grant
       join bakery.principals as principal
         on principal.id = access_grant.principal_id
       join bakery.organization_memberships as membership
         on membership.organization_id = access_grant.organization_id
        and membership.principal_id = access_grant.principal_id
        and membership.status = 'active'
      where access_grant.organization_id = $1 and access_grant.run_id = $2
        and access_grant.revoked_at is null
        and principal.principal_type = 'human' and principal.disabled_at is null
        and not exists (
          select 1 from project_principals as project
           where project.principal_id = access_grant.principal_id
        )`,
    projectParameters,
  );
  const visible = direct.rows.slice(0, limit);
  const powers = await transaction.query<RunAccessPowerRow>(
    `select power.principal_id, request.intent, request.step_key,
            request.target_id, power.expires_at
       from bakery.run_power_grants as power
       join bakery.person_requests as request
         on request.organization_id = power.organization_id
        and request.id = power.source_request_id
      where power.organization_id = $1 and power.run_id = $2
        and power.principal_id = any($3::uuid[])
        and power.revoked_at is null and power.expires_at > now()
      order by power.created_at, power.id`,
    [organizationId, run.id, visible.map((row) => row.principal_id)],
  );
  const powersByPrincipal = new Map<string, RunAccessPowerRow[]>();
  for (const power of powers.rows) {
    const current = powersByPrincipal.get(power.principal_id);
    if (current === undefined) {
      powersByPrincipal.set(power.principal_id, [power]);
    } else {
      current.push(power);
    }
  }
  const projectCount = project.rows[0]?.count ?? 0;
  const directTotal = directCount.rows[0]?.count ?? 0;
  const last = visible.at(-1);
  return {
    projectCount,
    totalCount: projectCount + directTotal,
    items: visible.map((row) => ({
      id: row.id,
      principal: {
        principalId: row.principal_id,
        displayName: row.display_name,
      },
      via: row.via,
      grantedBy: row.granted_by === null ? null : {
        principalId: row.granted_by,
        displayName: row.granted_by_name ?? row.granted_by,
      },
      grantedByKind: row.granted_by_kind,
      grantedAt: iso(row.created_at),
      sourceRequestId: row.source_request_id,
      audience: row.audience_name,
      powers: (powersByPrincipal.get(row.principal_id) ?? []).map((power) => ({
        intent: power.intent,
        stepKey: power.step_key,
        targetId: power.target_id,
        expiresAt: iso(power.expires_at),
      })),
      version: row.version,
    })),
    nextCursor: direct.rows.length > limit && last
      ? await encodeCursor(cursorSecret, binding, {
        createdAt: last.cursor_created_at,
        position: last.cursor_position,
        id: last.id,
      })
      : null,
  };
}

export async function removeRunAccess(context: ActionContext) {
  const { transaction, organizationId, principalId, accessScope } =
    requireWorkTransaction(context);
  const run = await loadRun(context, transaction, organizationId, accessScope);
  const targetId = context.params.principalId;
  if (!targetId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const current = await transaction.query<{
    id: string;
    version: number;
    revoked_at: Date | null;
  }>(
    `select id, version, revoked_at
       from bakery.run_access_grants
      where organization_id = $1 and run_id = $2 and principal_id = $3
      order by (revoked_at is null) desc, created_at desc, id desc
      limit 1 for update`,
    [organizationId, run.id, targetId],
  );
  const grant = current.rows[0];
  if (!grant) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (grant.version !== expectedVersion || grant.revoked_at !== null) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await transaction.query(
    `update bakery.run_access_grants
        set revoked_at = now(), revoked_by = $2, version = version + 1
      where id = $1 and revoked_at is null`,
    [grant.id, principalId],
  );
  const withdrawn = await transaction.query<{ id: string }>(
    `update bakery.person_requests
        set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = $4,
            updated_at = now(), version = version + 1
      where organization_id = $1 and run_id = $2 and recipient_id = $3
        and status = 'open'
      returning id`,
    [organizationId, run.id, targetId, principalId],
  );
  const revoked = await transaction.query<{ id: string }>(
    `update bakery.run_power_grants
        set revoked_at = now(), revoked_by = $4, version = version + 1
      where organization_id = $1 and run_id = $2 and principal_id = $3
        and revoked_at is null
      returning id`,
    [organizationId, run.id, targetId, principalId],
  );
  await ledger(transaction, {
    organizationId,
    taskId: run.task_id,
    runId: run.id,
    kind: "run_access_removed",
    decidedBy: principalId,
    text: "access removed",
    detail: {
      principalId: targetId,
      withdrawnRequestCount: withdrawn.rows.length,
      revokedPowerCount: revoked.rows.length,
    },
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "runAccess.remove",
    resourceType: "run_access_grant",
    resourceId: grant.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      runId: run.id,
      principalId: targetId,
      withdrawnRequestCount: withdrawn.rows.length,
      revokedPowerCount: revoked.rows.length,
    },
  });
  return {
    principalId: targetId,
    version: grant.version + 1,
    withdrawnRequestCount: withdrawn.rows.length,
  };
}

/**
 * runRequests.withdraw: only the asker, or an organization Admin, ends an open
 * request. The person keeps seeing the run: ending a request and removing
 * access are different acts.
 */
export async function withdrawRunRequest(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const requestId = context.params.id;
  if (!requestId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const current = await transaction.query<
    {
      run_id: string;
      task_id: string;
      asked_by: string | null;
      status: string;
      version: number;
      recipient_id: string;
    }
  >(
    `select run_id, task_id, asked_by, recipient_id, version,
            case when status = 'open' and expires_at <= now()
                 then 'expired' else status end as status
       from bakery.person_requests
      where organization_id = $1 and id = $2 for update`,
    [organizationId, requestId],
  );
  const row = current.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (row.asked_by !== principalId) {
    const role = await transaction.query<{ role: string | null }>(
      `select role from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2 and status = 'active'`,
      [organizationId, principalId],
    );
    if (role.rows[0]?.role !== "admin") {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
  }
  if (row.status !== "open") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "request_not_open" },
    });
  }
  await transaction.query(
    `update bakery.person_requests
        set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = $3,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [organizationId, requestId, principalId],
  );
  // A withdrawn request takes its power with it; observe stays (only removing
  // access ends that).
  await transaction.query(
    `update bakery.run_power_grants
        set revoked_at = now(), revoked_by = $3, version = version + 1
      where organization_id = $1 and source_request_id = $2
        and revoked_at is null`,
    [organizationId, requestId, principalId],
  );
  await ledger(transaction, {
    organizationId,
    taskId: row.task_id,
    runId: row.run_id,
    kind: "request_withdrawn",
    decidedBy: principalId,
    text: "withdrawn",
    detail: { requestId, recipientId: row.recipient_id },
  });
  await appendFacts(transaction, context, {
    organizationId,
    principalId,
    operation: "runRequests.withdraw",
    eventType: "runRequest.withdrawn",
    requestId,
    version: row.version + 1,
    taskId: row.task_id,
    runId: row.run_id,
    details: { runId: row.run_id },
  });
  return toRunRequest(
    await readRequest(transaction, organizationId, requestId),
  );
}

/**
 * A decision or an answer on a row ends the request that asked for it, and the
 * power it gave: a row is decided once, and the right to act on it is spent.
 * Called by the handlers in the transaction that decides, so the request never
 * says "open" about a row that is done. It closes every open request and
 * revokes every live grant for the row, whoever decided: the asked person's
 * power is spent when anyone else acts first. `principalId` is the actor, kept
 * as the revoker.
 */
export async function completeRequestsOnQuestion(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  questionId: string,
  status: "answered" | "handled",
): Promise<void> {
  const closed = await transaction.query<ClosedRequest>(
    `update bakery.person_requests
        set status = $3, responded_at = now(), updated_at = now(),
            version = version + 1
      where organization_id = $1 and target_id = $2 and status = 'open'
      returning ${CLOSED_REQUEST_COLUMNS}`,
    [organizationId, questionId, status],
  );
  await recordHandled(transaction, organizationId, principalId, closed.rows);
  await transaction.query(
    `update bakery.run_power_grants
        set revoked_at = now(), revoked_by = $3, version = version + 1
      where organization_id = $1 and question_id = $2 and revoked_at is null`,
    [organizationId, questionId, principalId],
  );
}

export async function handleRequestsOnTarget(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  intent: "review" | "take_over",
  targetId: string,
): Promise<void> {
  await closeAnsweredAsk(
    transaction,
    organizationId,
    principalId,
    (alias) => `${alias}.intent = $3 and ${alias}.target_id = $4`,
    [intent, targetId],
  );
}

export async function handleTakeOverRequests(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  runId: string,
  stepKey: string,
): Promise<void> {
  await closeAnsweredAsk(
    transaction,
    organizationId,
    principalId,
    (alias) =>
      `${alias}.intent = 'take_over' and ${alias}.run_id = $3 and ${alias}.step_key = $4`,
    [runId, stepKey],
  );
}

async function closeAnsweredAsk(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  target: (alias: string) => string,
  targetValues: readonly unknown[],
): Promise<void> {
  const closed = await transaction.query<ClosedRequest>(
    `with mine as (
       select own.run_id, own.created_at, own.asked_by,
              own.audience_group_id, own.audience_role_key
         from bakery.person_requests own
        where own.organization_id = $1 and own.recipient_id = $2
          and own.status = 'open' and ${target("own")}
     )
     update bakery.person_requests request
        set status = 'handled', responded_at = now(), updated_at = now(),
            version = request.version + 1
      where request.organization_id = $1 and request.status = 'open'
        and ${target("request")}
        and (
          request.recipient_id = $2 or exists (
            select 1 from mine
             where (mine.audience_group_id is not null
                    or mine.audience_role_key is not null)
               and mine.run_id = request.run_id
               and mine.created_at = request.created_at
               and mine.asked_by is not distinct from request.asked_by
               and mine.audience_group_id
                   is not distinct from request.audience_group_id
               and mine.audience_role_key
                   is not distinct from request.audience_role_key
          )
        )
      returning ${
      CLOSED_REQUEST_COLUMNS.split(", ").map((column) => "request." + column)
        .join(", ")
    }`,
    [organizationId, principalId, ...targetValues],
  );
  await revokeRequestPowers(
    transaction,
    organizationId,
    closed.rows.map((row) => row.id),
    principalId,
  );
  await recordHandled(transaction, organizationId, principalId, closed.rows);
}

async function revokeRequestPowers(
  transaction: PgTransactionClient,
  organizationId: string,
  requestIds: readonly string[],
  revokedBy: string,
): Promise<void> {
  if (requestIds.length === 0) return;
  await transaction.query(
    `update bakery.run_power_grants
        set revoked_at = now(), revoked_by = $3, version = version + 1
      where organization_id = $1 and source_request_id = any($2::uuid[])
        and revoked_at is null`,
    [organizationId, [...requestIds], revokedBy],
  );
}

type ClosedRequest = {
  id: string;
  task_id: string;
  run_id: string;
  recipient_id: string;
  intent: RequestIntent;
  status: "answered" | "handled";
};

const CLOSED_REQUEST_COLUMNS =
  "id, task_id, run_id, recipient_id, intent, status";

async function recordHandled(
  transaction: PgTransactionClient,
  organizationId: string,
  handledBy: string,
  requests: readonly ClosedRequest[],
): Promise<void> {
  for (const request of requests) {
    await ledger(transaction, {
      organizationId,
      taskId: request.task_id,
      runId: request.run_id,
      kind: "request_handled",
      decidedBy: handledBy,
      text: request.intent,
      detail: {
        requestId: request.id,
        recipientId: request.recipient_id,
        intent: request.intent,
        status: request.status,
        handledBy,
        byRecipient: handledBy === request.recipient_id,
      },
    });
  }
}
