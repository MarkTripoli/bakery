import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import type { z } from "zod";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { enqueueWorkerControlCommand } from "../execution/coordination.ts";
import { formatMicroUsd, parseMicroUsd } from "./budget.ts";
import {
  AD_HOC_ORIGIN,
  type AliasCandidate,
  coordinationOriginKey,
  coordinationPlanDigest,
  CoordinationPlanInvalidError,
  type CoordinationPlanOrigin,
  CoordinationPlanOriginSchema,
  type CoordinationPlanSpec,
  CoordinationPlanSpecSchema,
  resolveCoordinationPlan,
} from "./coordination-plan.ts";
import { decideLaneReuse } from "./coordination-reuse.ts";
import {
  findParallelNode,
  mapParallelNodeToPlanSpec,
  WorkflowMappingError,
} from "./coordination-workflow.ts";
import {
  laneStatusFromChild,
  loadPlanLanes,
  loadPlanOutput,
  PLAN_COLUMNS,
  toRole,
  toTaskRepository,
} from "./coordination-query.ts";
import {
  bumpPlan,
  type Facts,
  loadPlanForUpdate,
  type PlanRecord,
  reconcileCoordinationPlan,
  recordFacts,
  setLaneStatus,
} from "./coordination-projection.ts";
import {
  createTaskCommand,
  loadTaskScope,
  lockApplication,
} from "./postgres.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

type PlanCreateInput = z.output<typeof contractSchemas.CoordinationPlanCreate>;
type PlanCreateFromWorkflowInput = z.output<
  typeof contractSchemas.CoordinationPlanCreateFromWorkflow
>;

function factsOf(context: ActionContext): Facts {
  const { organizationId, principalId } = requireWorkTransaction(context);
  return {
    organizationId,
    principalId,
    requestId: context.requestId,
    traceId: context.traceId,
  };
}

function planInvalid(error: CoordinationPlanInvalidError): StandardError {
  return new StandardError({
    code: "UNPROCESSABLE",
    cause: error,
    params: {
      issues: error.issues.map((issue) => ({
        path: [...issue.path],
        code: issue.code,
        message: issue.code.replaceAll("_", " "),
      })),
    },
  });
}

function parseSpec(value: unknown): CoordinationPlanSpec {
  const parsed = CoordinationPlanSpecSchema.safeParse(value);
  if (!parsed.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      cause: parsed.error,
      params: {
        issues: parsed.error.issues.map((issue) => ({
          path: [
            "spec",
            ...issue.path.map((part) =>
              typeof part === "symbol" ? String(part) : part
            ),
          ],
          code: "spec_invalid",
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

function parseOrigin(value: unknown): CoordinationPlanOrigin {
  const parsed = CoordinationPlanOriginSchema.safeParse(value);
  if (!parsed.success) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      cause: parsed.error,
      params: {
        issues: parsed.error.issues.map((issue) => ({
          path: [
            "origin",
            ...issue.path.map((part) =>
              typeof part === "symbol" ? String(part) : part
            ),
          ],
          code: "origin_invalid",
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

function workflowMappingInvalid(error: WorkflowMappingError): StandardError {
  return new StandardError({
    code: "UNPROCESSABLE",
    cause: error,
    params: {
      issues: [{
        path: [...error.path],
        code: error.code,
        message: error.code.replaceAll("_", " "),
      }],
    },
  });
}

function normalizeBudget(value: string | undefined): string | null {
  if (value === undefined) return null;
  return formatMicroUsd(parseMicroUsd(value, "plan_budget_limit_usd"));
}

// --- Application repository roles and task repository links ---------------

export async function setApplicationRepositoryRoleCommand(
  context: ActionContext,
  input: z.output<typeof contractSchemas.ApplicationRepositoryRoleSet>,
) {
  const { transaction } = requireWorkTransaction(context);
  requireCommandMetadata(context);
  const facts = factsOf(context);
  const applicationId = context.params.id;
  if (!applicationId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  await lockApplication(transaction, facts.organizationId, applicationId);
  const repository = await transaction.query(
    `select 1 from bakery.repositories
      where organization_id = $1 and application_id = $2 and id = $3
        and archived_at is null`,
    [facts.organizationId, applicationId, input.repositoryId],
  );
  if (repository.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  // One source of truth: repository_role_bindings (projects, migration 0046).
  // The application lock serializes the find-or-create by (alias, role).
  const existing = await transaction.query(
    `select id from bakery.repository_role_bindings
      where organization_id = $1 and application_id = $2 and alias = $3
        and role = $4 and archived_at is null
      order by created_at, id limit 1
      for update`,
    [facts.organizationId, applicationId, input.alias, input.role],
  );
  const upserted = existing.rows.length === 1
    ? await transaction.query(
      `update bakery.repository_role_bindings
          set repository_id = $4, updated_at = now(), version = version + 1
        where organization_id = $1 and application_id = $2 and id = $3
        returning id, application_id, alias, role, repository_id,
                  created_at, updated_at, version`,
      [
        facts.organizationId,
        applicationId,
        (existing.rows[0] as { id: string }).id,
        input.repositoryId,
      ],
    )
    : await transaction.query(
      `insert into bakery.repository_role_bindings (
         organization_id, application_id, repository_id, role, alias,
         provenance
       ) values ($1, $2, $3, $4, $5, 'coordination')
       returning id, application_id, alias, role, repository_id,
                 created_at, updated_at, version`,
      [
        facts.organizationId,
        applicationId,
        input.repositoryId,
        input.role,
        input.alias,
      ],
    );
  const row = upserted.rows[0] as Record<string, unknown>;
  await recordFacts(transaction, facts, {
    operation: "applicationRepositoryRoles.set",
    resourceType: "application_repository_role",
    resourceId: row.id as string,
    eventType: "applicationRepositoryRole.updated",
    version: row.version as number,
    applicationId,
    repositoryId: input.repositoryId,
    details: { alias: input.alias, role: input.role },
  });
  return toRole(row);
}

export async function setTaskRepositoryCommand(
  context: ActionContext,
  input: z.output<typeof contractSchemas.TaskRepositorySet>,
) {
  const { transaction } = requireWorkTransaction(context);
  requireCommandMetadata(context);
  const facts = factsOf(context);
  const taskId = context.params.id;
  if (!taskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const owner = await loadTaskScope(
    transaction,
    facts.organizationId,
    taskId,
    undefined,
    false,
  );
  await lockApplication(
    transaction,
    facts.organizationId,
    owner.application_id,
  );
  const repository = await transaction.query(
    `select 1 from bakery.repositories
      where organization_id = $1 and application_id = $2 and id = $3
        and archived_at is null`,
    [facts.organizationId, owner.application_id, input.repositoryId],
  );
  if (repository.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const upserted = await transaction.query(
    `insert into bakery.task_repositories (
       organization_id, application_id, task_id, repository_id, role, required,
       provenance, created_by
     ) values ($1, $8, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id, task_id, repository_id) do update
       set role = excluded.role, required = excluded.required,
           provenance = excluded.provenance, updated_at = now(),
           version = bakery.task_repositories.version + 1
     returning id, task_id, repository_id, role, required, provenance,
               created_by, created_at, updated_at, version`,
    [
      facts.organizationId,
      taskId,
      input.repositoryId,
      input.role,
      input.required,
      input.provenance,
      facts.principalId,
      owner.application_id,
    ],
  );
  const row = upserted.rows[0] as Record<string, unknown>;
  await recordFacts(transaction, facts, {
    operation: "taskRepositories.set",
    resourceType: "task_repository",
    resourceId: row.id as string,
    eventType: "taskRepository.updated",
    version: row.version as number,
    applicationId: owner.application_id,
    repositoryId: input.repositoryId,
    taskId,
    details: { role: input.role, required: input.required },
  });
  return toTaskRepository(row);
}

// --- Plan creation --------------------------------------------------------

async function loadScope(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
  parentTaskId: string,
) {
  const roles = await transaction.query<
    { alias: string; role: string; repository_id: string }
  >(
    `select alias, role, repository_id from bakery.repository_role_bindings
      where organization_id = $1 and application_id = $2
        and alias is not null and archived_at is null`,
    [organizationId, applicationId],
  );
  const aliases = new Map<string, AliasCandidate[]>();
  for (const row of roles.rows) {
    const list = aliases.get(row.alias) ?? [];
    list.push({ repositoryId: row.repository_id, role: row.role });
    aliases.set(row.alias, list);
  }
  const repositories = await transaction.query<{ id: string }>(
    `select id from bakery.repositories
      where organization_id = $1 and application_id = $2
        and archived_at is null`,
    [organizationId, applicationId],
  );
  const links = await transaction.query<{ repository_id: string }>(
    `select repository_id from bakery.task_repositories
      where organization_id = $1 and task_id = $2`,
    [organizationId, parentTaskId],
  );
  return {
    aliases,
    applicationRepositoryIds: new Set(repositories.rows.map((r) => r.id)),
    linkedRepositoryIds: links.rows.length === 0
      ? null
      : new Set(links.rows.map((r) => r.repository_id)),
  };
}

/** `coordinationPlans.create`: ad hoc (default) or ticket-originated plan. */
export async function createCoordinationPlanCommand(
  context: ActionContext,
  input: PlanCreateInput,
) {
  const origin = input.origin === undefined
    ? AD_HOC_ORIGIN
    : parseOrigin(input.origin);
  if (origin.kind === "saved_workflow") {
    // A saved-workflow origin is server-set by createFromWorkflow; a caller
    // must not claim it on a plan it composed itself.
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["origin", "kind"],
          code: "origin_not_allowed",
          message: "origin not allowed",
        }],
      },
    });
  }
  return await createPlan(context, {
    parentTaskId: input.parentTaskId,
    spec: input.spec,
    budgetLimitUsd: input.budgetLimitUsd,
    origin,
  });
}

/**
 * `coordinationPlans.createFromWorkflow`: maps one parallel node of a
 * published workflow version to a plan spec and creates it through the same
 * boundary as every other origin.
 */
export async function createCoordinationPlanFromWorkflowCommand(
  context: ActionContext,
  input: PlanCreateFromWorkflowInput,
) {
  const { transaction } = requireWorkTransaction(context);
  const facts = factsOf(context);
  // Parent access first: a caller without access to the parent gets the same
  // refusal whether or not the workflow version exists or maps.
  await loadTaskScope(
    transaction,
    facts.organizationId,
    input.parentTaskId,
    undefined,
    false,
  );
  const found = await transaction.query<
    {
      workflow_id: string;
      status: string;
      enabled: boolean;
      normalized_spec: unknown;
    }
  >(
    `select v.workflow_id, v.status, d.enabled, v.normalized_spec
       from bakery.workflow_versions v
       join bakery.workflow_definitions d
         on d.organization_id = v.organization_id and d.id = v.workflow_id
      where v.organization_id = $1 and v.id = $2`,
    [facts.organizationId, input.workflowVersionId],
  );
  const version = found.rows[0];
  // Foreign, missing and unpublished versions look the same to the caller.
  if (!version || version.status !== "published") {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (!version.enabled) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "workflow_disabled" },
    });
  }
  let spec: CoordinationPlanSpec;
  try {
    spec = mapParallelNodeToPlanSpec(
      findParallelNode(version.normalized_spec, input.nodeId),
    );
  } catch (error) {
    if (error instanceof WorkflowMappingError) {
      throw workflowMappingInvalid(error);
    }
    throw error;
  }
  return await createPlan(context, {
    parentTaskId: input.parentTaskId,
    spec,
    budgetLimitUsd: input.budgetLimitUsd,
    origin: {
      kind: "saved_workflow",
      workflowId: version.workflow_id,
      workflowVersionId: input.workflowVersionId,
      nodeId: input.nodeId,
    },
  });
}

async function createPlan(
  context: ActionContext,
  input: {
    parentTaskId: string;
    spec: unknown;
    budgetLimitUsd: string | undefined;
    origin: CoordinationPlanOrigin;
  },
) {
  const { transaction } = requireWorkTransaction(context);
  requireCommandMetadata(context);
  const facts = factsOf(context);
  const parent = await loadTaskScope(
    transaction,
    facts.organizationId,
    input.parentTaskId,
    undefined,
    false,
  );
  await lockApplication(
    transaction,
    facts.organizationId,
    parent.application_id,
  );
  const lockedParent = await loadTaskScope(
    transaction,
    facts.organizationId,
    input.parentTaskId,
    parent.application_id,
  );
  if (lockedParent.archived_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "task_archived" },
    });
  }
  const spec = parseSpec(input.spec);
  const scope = await loadScope(
    transaction,
    facts.organizationId,
    parent.application_id,
    input.parentTaskId,
  );
  let lanes;
  try {
    lanes = await resolveCoordinationPlan(spec, scope);
  } catch (error) {
    if (error instanceof CoordinationPlanInvalidError) throw planInvalid(error);
    throw error;
  }
  const budget = normalizeBudget(input.budgetLimitUsd);
  const digest = await coordinationPlanDigest(spec);

  const latest = await transaction.query<PlanRecord>(
    `select ${PLAN_COLUMNS}
       from bakery.coordination_plans p
      where p.organization_id = $1 and p.parent_task_id = $2
      order by p.revision desc limit 1
      for update`,
    [facts.organizationId, input.parentTaskId],
  );
  const previous = latest.rows[0];
  const live = previous !== undefined && previous.digest === digest &&
    previous.status !== "canceled" && previous.status !== "superseded";
  if (live) {
    // Origin labels a plan; the same request through another origin must not
    // replay it or replace it (that would cancel running lanes or mislabel it).
    const previousOrigin = CoordinationPlanOriginSchema.safeParse(
      previous.origin,
    );
    if (
      (await coordinationOriginKey(
        previousOrigin.success ? previousOrigin.data : AD_HOC_ORIGIN,
      )) !== (await coordinationOriginKey(input.origin))
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "coordination_plan_origin_conflict" },
      });
    }
    const sameBudget = (previous.budget_limit_usd === null
      ? null
      : formatMicroUsd(parseMicroUsd(previous.budget_limit_usd))) === budget;
    if (sameBudget) {
      // A plan with a stale lane is not replayed: the same request is rework,
      // so it becomes a new revision that redoes only what is stale.
      const lanes = (await loadPlanLanes(
        transaction,
        facts.organizationId,
        [previous.id],
      )).get(previous.id) ?? [];
      if (
        !lanes.some((lane) =>
          lane.stale
        )
      ) {
        return await loadPlanOutput(
          transaction,
          facts.organizationId,
          previous.id,
        );
      }
    }
  }
  const revision = (previous?.revision ?? 0) + 1;
  const inserted = await transaction.query<{ id: string; version: number }>(
    `insert into bakery.coordination_plans (
       organization_id, application_id, parent_task_id, revision, spec,
       digest, budget_limit_usd, status, created_by, origin
     ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, 'planned', $8, $9::jsonb)
     returning id, version`,
    [
      facts.organizationId,
      parent.application_id,
      input.parentTaskId,
      revision,
      JSON.stringify(spec),
      digest,
      budget,
      facts.principalId,
      JSON.stringify(input.origin),
    ],
  );
  const plan = inserted.rows[0];
  if (!plan) throw new Error("COORDINATION_PLAN_INSERT_FAILED");
  for (const [position, lane] of lanes.entries()) {
    await transaction.query(
      `insert into bakery.coordination_lanes (
         organization_id, application_id, plan_id, lane_key, position,
         repository_id, prerequisites, declared_outputs, lane_digest, status
       ) values ($1, $9, $2, $3, $4, $5, $6::text[], $7::jsonb, $8, 'planned')`,
      [
        facts.organizationId,
        plan.id,
        lane.spec.key,
        position,
        lane.repositoryId,
        lane.spec.prerequisites,
        JSON.stringify(lane.spec.outputs),
        lane.laneDigest,
        parent.application_id,
      ],
    );
  }
  await recordFacts(transaction, facts, {
    operation: "coordinationPlans.create",
    resourceType: "coordination_plan",
    resourceId: plan.id,
    eventType: "coordinationPlan.created",
    version: plan.version,
    applicationId: parent.application_id,
    taskId: input.parentTaskId,
    details: {
      revision,
      digest,
      lanes: lanes.length,
      origin: input.origin.kind,
    },
  });
  return await loadPlanOutput(transaction, facts.organizationId, plan.id);
}

// --- Materialization -------------------------------------------------------

async function applicationOfPlan(
  transaction: PgTransactionClient,
  organizationId: string,
  planId: string,
): Promise<string> {
  const result = await transaction.query<{ application_id: string }>(
    `select application_id from bakery.coordination_plans
      where organization_id = $1 and id = $2`,
    [organizationId, planId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row.application_id;
}

const LIVE_ATTEMPT_LOCK_TRIES = 3;

/**
 * Locks the worker hosts of live attempts, then those attempts. The host set
 * and the attempt set come from two statements, so an attempt leased between
 * them could arrive without its host. Asking for that host after the attempt
 * would invert the worker order (host -> attempt), so on a mismatch the
 * savepoint drops the host and attempt locks taken here and the pair is
 * retaken with the missing hosts added, still in host id order. Bounded; a
 * scope that keeps moving fails with STATE_CONFLICT for the caller to retry.
 */
async function lockLiveAttemptHosts(
  transaction: PgTransactionClient,
  organizationId: string,
  runs: readonly string[],
  live: string,
): Promise<void> {
  let extraHosts: string[] = [];
  for (let attempt = 0; attempt < LIVE_ATTEMPT_LOCK_TRIES; attempt++) {
    await transaction.query("savepoint coordination_live_hosts");
    const hosts = await transaction.query<{ id: string }>(
      `select host.id
         from bakery.worker_hosts host
        where host.organization_id = $1
          and (host.id in (select attempt.worker_host_id ${live})
               or host.id = any($3::uuid[]))
        order by host.id for update`,
      [organizationId, runs, extraHosts],
    );
    const attempts = await transaction.query<{ worker_host_id: string | null }>(
      `select attempt.id, attempt.worker_host_id ${live}
        order by attempt.id for update of attempt`,
      [organizationId, runs],
    );
    const locked = new Set(hosts.rows.map((row) => row.id));
    const missing = attempts.rows.flatMap((row) =>
      row.worker_host_id && !locked.has(row.worker_host_id)
        ? [row.worker_host_id]
        : []
    );
    if (missing.length === 0) {
      await transaction.query("release savepoint coordination_live_hosts");
      return;
    }
    await transaction.query("rollback to savepoint coordination_live_hosts");
    await transaction.query("release savepoint coordination_live_hosts");
    extraHosts = [...new Set([...extraHosts, ...missing])];
  }
  throw new StandardError({ code: "STATE_CONFLICT" });
}

/**
 * LOCK ORDER for everything that touches coordination state (engine step
 * admission and budget reservation, materialize, supersede, cancel, reconcile):
 *   application -> worker hosts of live attempts -> live attempts -> jobs
 *   -> run steps -> runs -> child tasks (id asc) -> parent task
 *   -> plan rows (revision asc) -> budget accounts.
 * Worker transactions (heartbeat, result) lock host, attempt, job in that
 * order (execution/coordination.ts enqueueWorkerControlCommand), and the
 * cooperative cancel below asks for the host again, so the hosts and attempts
 * come before the jobs here. The engine takes job, step, run, child task in
 * that order and its plan-budget lock then takes the parent task, so commands
 * that must lock several children (cancel, supersede) call this before any
 * plan row lock. Plan rows are always last. Reconcile locks only the parent
 * task and plans, never sibling children, so terminal paths holding one child
 * cannot cycle.
 */
async function lockCoordinationScope(
  transaction: PgTransactionClient,
  organizationId: string,
  planId: string,
): Promise<void> {
  const plan = await transaction.query<{ parent_task_id: string }>(
    `select parent_task_id from bakery.coordination_plans
      where organization_id = $1 and id = $2`,
    [organizationId, planId],
  );
  const parentTaskId = plan.rows[0]?.parent_task_id;
  if (!parentTaskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const scope = await transaction.query<
    { child_id: string; run_id: string | null }
  >(
    `select distinct l.child_task_id as child_id, t.current_run_id as run_id
       from bakery.coordination_plans p
       join bakery.coordination_lanes l
         on l.organization_id = p.organization_id and l.plan_id = p.id
       join bakery.tasks t
         on t.organization_id = l.organization_id and t.id = l.child_task_id
      where p.organization_id = $1 and p.parent_task_id = $2
        and l.child_task_id is not null`,
    [organizationId, parentTaskId],
  );
  const children = scope.rows.map((row) => row.child_id).sort();
  const runs = scope.rows.flatMap((row) => row.run_id ? [row.run_id] : [])
    .sort();
  if (runs.length > 0) {
    const live = `from bakery.run_steps step
         join bakery.jobs job
           on job.organization_id = step.organization_id
          and job.run_step_id = step.id
         join bakery.job_attempts attempt
           on attempt.organization_id = job.organization_id
          and attempt.job_id = job.id
        where step.organization_id = $1 and step.run_id = any($2::uuid[])
          and attempt.status in ('leased', 'running', 'canceling')`;
    await lockLiveAttemptHosts(transaction, organizationId, runs, live);
    await transaction.query(
      `select job.id from bakery.jobs job
         join bakery.run_steps step
           on step.organization_id = job.organization_id
          and step.id = job.run_step_id
        where step.organization_id = $1 and step.run_id = any($2::uuid[])
        order by job.id for update of job`,
      [organizationId, runs],
    );
    await transaction.query(
      `select id from bakery.run_steps
        where organization_id = $1 and run_id = any($2::uuid[])
        order by id for update`,
      [organizationId, runs],
    );
    await transaction.query(
      `select id from bakery.workflow_runs
        where organization_id = $1 and id = any($2::uuid[])
        order by id for update`,
      [organizationId, runs],
    );
  }
  if (children.length > 0) {
    await transaction.query(
      `select id from bakery.tasks
        where organization_id = $1 and id = any($2::uuid[])
        order by id for update`,
      [organizationId, children],
    );
  }
  await transaction.query(
    `select id from bakery.tasks
      where organization_id = $1 and id = $2 for update`,
    [organizationId, parentTaskId],
  );
}

export async function materializeCoordinationPlanCommand(
  context: ActionContext,
  _input: unknown,
) {
  const { transaction } = requireWorkTransaction(context);
  requireCommandMetadata(context);
  const facts = factsOf(context);
  const planId = context.params.id;
  if (!planId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const applicationId = await applicationOfPlan(
    transaction,
    facts.organizationId,
    planId,
  );
  await lockApplication(transaction, facts.organizationId, applicationId);
  await lockCoordinationScope(transaction, facts.organizationId, planId);
  const plan = await loadPlanForUpdate(
    transaction,
    facts.organizationId,
    planId,
  );
  if (plan.status === "canceled" || plan.status === "superseded") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "coordination_plan_inactive" },
    });
  }
  const spec = parseSpec(plan.spec);
  const lanes =
    (await loadPlanLanes(transaction, facts.organizationId, [planId]))
      .get(planId) ?? [];
  const pending = lanes.filter((lane) => lane.child_task_id === null);
  if (pending.length === 0 && plan.status !== "planned") {
    // Replay: every lane already has its one child.
    return await loadPlanOutput(transaction, facts.organizationId, planId);
  }

  const reuseByLane = await decideLaneReuse(
    transaction,
    facts.organizationId,
    plan,
    spec,
    lanes,
  );
  const specByKey = new Map(spec.lanes.map((lane) => [lane.key, lane]));
  const aliasRoles = await transaction.query<
    { alias: string; repository_id: string; role: string }
  >(
    `select alias, repository_id, role from bakery.repository_role_bindings
      where organization_id = $1 and application_id = $2
        and alias is not null and archived_at is null`,
    [facts.organizationId, applicationId],
  );
  const childByKey = new Map<string, string>();
  for (const lane of lanes) {
    if (lane.child_task_id) childByKey.set(lane.lane_key, lane.child_task_id);
  }
  for (const lane of pending) {
    const laneSpec = specByKey.get(lane.lane_key);
    if (!laneSpec) throw new Error("COORDINATION_LANE_SPEC_MISSING");
    const reuse = reuseByLane.get(lane.lane_key);
    if (reuse) {
      await transaction.query(
        `update bakery.coordination_lanes
            set child_task_id = $3, reused_from_lane_id = $4, status = 'completed',
                updated_at = now(), version = version + 1
          where organization_id = $1 and id = $2`,
        [facts.organizationId, lane.id, reuse.child_task_id, reuse.id],
      );
      childByKey.set(lane.lane_key, reuse.child_task_id as string);
      continue;
    }
    const child = await createTaskCommand(context, {
      applicationId,
      repositoryId: lane.repository_id,
      taskType: "feature",
      title: laneSpec.title,
      description: laneSpec.instructions,
      parentId: plan.parent_task_id,
    });
    await transaction.query(
      `update bakery.coordination_lanes
          set child_task_id = $3, status = $4, updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2`,
      [
        facts.organizationId,
        lane.id,
        child.id,
        laneSpec.prerequisites.length === 0 ? "ready" : "planned",
      ],
    );
    childByKey.set(lane.lane_key, child.id);
  }
  for (const lane of pending) {
    const child = childByKey.get(lane.lane_key) as string;
    const role = aliasRoles.rows.find((r) =>
      r.repository_id === lane.repository_id
    )?.role ?? "shared";
    for (
      const taskId of new Set([child, plan.parent_task_id])
    ) {
      await transaction.query(
        `insert into bakery.task_repositories (
           organization_id, application_id, task_id, repository_id, role,
           required, provenance, created_by
         ) values ($1, $6, $2, $3, $4, true, 'plan', $5)
         on conflict (organization_id, task_id, repository_id) do nothing`,
        [
          facts.organizationId,
          taskId,
          lane.repository_id,
          role,
          facts.principalId,
          applicationId,
        ],
      );
    }
    for (const prerequisite of lane.prerequisites) {
      const upstream = childByKey.get(prerequisite);
      if (!upstream || upstream === child) continue;
      await transaction.query(
        `insert into bakery.task_dependencies (
           organization_id, task_id, depends_on_task_id, condition, version
         ) values ($1, $2, $3, 'completed', 1)
         on conflict (organization_id, task_id, depends_on_task_id) do nothing`,
        [facts.organizationId, child, upstream],
      );
    }
  }
  await supersedeEarlierRevisions(
    transaction,
    facts,
    plan,
    new Set(childByKey.values()),
  );
  const version = await bumpPlan(
    transaction,
    facts.organizationId,
    planId,
    "materialized",
  );
  await recordFacts(transaction, facts, {
    operation: "coordinationPlans.materialize",
    resourceType: "coordination_plan",
    resourceId: planId,
    eventType: "coordinationPlan.materialized",
    version,
    applicationId,
    taskId: plan.parent_task_id,
    details: { revision: plan.revision, children: pending.length },
  });
  await reconcileCoordinationPlan(transaction, facts, planId);
  return await loadPlanOutput(transaction, facts.organizationId, planId);
}

/**
 * A new revision supersedes the earlier ones. Unfinished children no longer
 * part of the new plan are canceled; completed evidence is never touched.
 */
async function supersedeEarlierRevisions(
  transaction: PgTransactionClient,
  facts: Facts,
  plan: PlanRecord,
  keepChildren: ReadonlySet<string>,
): Promise<void> {
  const earlier = await transaction.query<{ id: string; status: string }>(
    `select id, status from bakery.coordination_plans
      where organization_id = $1 and parent_task_id = $2 and revision < $3
        and status not in ('superseded', 'canceled')
      for update`,
    [facts.organizationId, plan.parent_task_id, plan.revision],
  );
  if (earlier.rows.length === 0) return;
  const grouped = await loadPlanLanes(
    transaction,
    facts.organizationId,
    earlier.rows.map((row) => row.id),
  );
  for (const old of earlier.rows) {
    for (const lane of grouped.get(old.id) ?? []) {
      if (lane.child_task_id === null || keepChildren.has(lane.child_task_id)) {
        continue;
      }
      await cancelChildTask(
        transaction,
        facts,
        old.id,
        lane.child_task_id,
      );
      await setLaneStatus(
        transaction,
        facts.organizationId,
        lane.id,
        "canceled",
      );
    }
    await bumpPlan(transaction, facts.organizationId, old.id, "superseded");
  }
}

// --- Cancellation ----------------------------------------------------------

const TERMINAL_RUN = ["completed", "failed", "canceled", "blocked"] as const;

async function cancelChildTask(
  transaction: PgTransactionClient,
  facts: Facts,
  planId: string,
  childTaskId: string,
): Promise<void> {
  const task = await transaction.query<
    { status: string; current_run_id: string | null }
  >(
    `select status, current_run_id from bakery.tasks
      where organization_id = $1 and id = $2
      for update`,
    [facts.organizationId, childTaskId],
  );
  const row = task.rows[0];
  if (!row || ["completed", "failed", "canceled"].includes(row.status)) return;
  const runId = row.current_run_id;
  if (runId !== null) {
    const attempt = await transaction.query<{ id: string }>(
      `select attempt.id
         from bakery.run_steps step
         join bakery.jobs job
           on job.organization_id = step.organization_id
          and job.run_step_id = step.id
         join bakery.job_attempts attempt
           on attempt.organization_id = job.organization_id
          and attempt.job_id = job.id
        where step.organization_id = $1 and step.run_id = $2
          and attempt.status in ('leased', 'running', 'canceling')
          and job.current_fence = attempt.fence
        order by step.position asc, step.iteration asc,
          attempt.attempt_no desc, attempt.id desc
        limit 1`,
      [facts.organizationId, runId],
    );
    const active = attempt.rows[0];
    if (active) {
      try {
        // Cooperative: the existing run control path asks the worker to stop.
        await enqueueWorkerControlCommand(transaction, {
          organizationId: facts.organizationId,
          attemptId: active.id,
          action: "cancel",
          reason: "coordination_plan_canceled",
          idempotencyKey: `coordination-cancel:${planId}:${runId}`,
          requestDigest: await sha256Hex(canonicalJson({
            planId,
            runId,
            action: "cancel",
          })),
          traceId: facts.traceId,
        });
        return;
      } catch (error) {
        // Only "no live worker authority" (STATE_CONFLICT: stale session,
        // expired lease or superseded fence) and "already terminal" fall
        // through to the durable direct cancel; anything else is a real fault.
        if (
          !(error instanceof StandardError) ||
          (error.code !== "STATE_CONFLICT" && error.code !== "ALREADY_TERMINAL")
        ) throw error;
      }
    }
    // No live worker session. Mirrors finalizeCanceledLifecycle (execution
    // run control): run steps, run and task move to canceled together and the
    // same run/task domain events are emitted. Held budget reservations stay
    // with the budget ledger: they are released only from immutable no-spend
    // evidence or at expiry (releaseWorkflowAction), never by direct updates.
    await transaction.query(
      `update bakery.run_steps
          set status = 'canceled', finished_at = current_timestamp,
              updated_at = current_timestamp, version = version + 1
        where organization_id = $1 and run_id = $2
          and status not in ('completed', 'failed', 'canceled', 'skipped',
                             'blocked')`,
      [facts.organizationId, runId],
    );
    const runUpdate = await transaction.query<{ version: number }>(
      `update bakery.workflow_runs
          set status = 'canceled', finished_at = current_timestamp,
              updated_at = current_timestamp, version = version + 1
        where organization_id = $1 and id = $2
          and status not in (${TERMINAL_RUN.map((s) => `'${s}'`).join(", ")})
        returning version`,
      [facts.organizationId, runId],
    );
    const runVersion = runUpdate.rows[0]?.version;
    const taskUpdate = await transaction.query<{ version: number }>(
      `update bakery.tasks
          set status = 'canceled', updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2
          and status not in ('completed', 'failed', 'canceled')
        returning version`,
      [facts.organizationId, childTaskId],
    );
    await emitChildCanceled(transaction, facts, childTaskId, {
      runId,
      runVersion,
      taskVersion: taskUpdate.rows[0]?.version,
    });
    return;
  }
  const taskUpdate = await transaction.query<{ version: number }>(
    `update bakery.tasks
        set status = 'canceled', updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
        and status not in ('completed', 'failed', 'canceled')
      returning version`,
    [facts.organizationId, childTaskId],
  );
  await emitChildCanceled(transaction, facts, childTaskId, {
    runId: null,
    runVersion: undefined,
    taskVersion: taskUpdate.rows[0]?.version,
  });
}

async function emitChildCanceled(
  transaction: PgTransactionClient,
  facts: Facts,
  childTaskId: string,
  versions: {
    runId: string | null;
    runVersion: number | undefined;
    taskVersion: number | undefined;
  },
): Promise<void> {
  const scope = await transaction.query<
    {
      application_id: string;
      repository_id: string | null;
      conversation_id: string;
    }
  >(
    `select application_id, repository_id, conversation_id
       from bakery.tasks where organization_id = $1 and id = $2`,
    [facts.organizationId, childTaskId],
  );
  const task = scope.rows[0];
  if (!task) return;
  const base = {
    organizationId: facts.organizationId,
    applicationId: task.application_id,
    repositoryId: task.repository_id,
    taskId: childTaskId,
    conversationId: task.conversation_id,
    traceId: facts.traceId,
  };
  if (versions.runId !== null && versions.runVersion !== undefined) {
    await appendDomainEvent(transaction, {
      ...base,
      eventType: "run.updated",
      aggregateId: versions.runId,
      aggregateVersion: versions.runVersion,
      payload: { runId: versions.runId, version: versions.runVersion },
    });
  }
  if (versions.taskVersion !== undefined) {
    await appendDomainEvent(transaction, {
      ...base,
      eventType: "tasks.updated",
      aggregateId: childTaskId,
      aggregateVersion: versions.taskVersion,
      payload: {
        resourceId: childTaskId,
        resourceVersion: versions.taskVersion,
      },
    });
  }
}

export async function cancelCoordinationPlanCommand(
  context: ActionContext,
  _input: unknown,
) {
  const { transaction } = requireWorkTransaction(context);
  requireCommandMetadata(context);
  const facts = factsOf(context);
  const planId = context.params.id;
  if (!planId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const applicationId = await applicationOfPlan(
    transaction,
    facts.organizationId,
    planId,
  );
  await lockApplication(transaction, facts.organizationId, applicationId);
  await lockCoordinationScope(transaction, facts.organizationId, planId);
  const plan = await loadPlanForUpdate(
    transaction,
    facts.organizationId,
    planId,
  );
  if (plan.status === "canceled") {
    return await loadPlanOutput(transaction, facts.organizationId, planId);
  }
  if (plan.status === "superseded") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "coordination_plan_inactive" },
    });
  }
  const lanes =
    (await loadPlanLanes(transaction, facts.organizationId, [planId]))
      .get(planId) ?? [];
  for (const lane of lanes) {
    const status = laneStatusFromChild(lane.child_status);
    // Completed lanes keep their evidence and effects; nothing is rolled back.
    if (lane.child_task_id !== null && status !== "completed") {
      await cancelChildTask(transaction, facts, planId, lane.child_task_id);
    }
    if (status !== "completed") {
      await setLaneStatus(
        transaction,
        facts.organizationId,
        lane.id,
        "canceled",
      );
    }
  }
  const version = await bumpPlan(
    transaction,
    facts.organizationId,
    planId,
    "canceled",
  );
  await recordFacts(transaction, facts, {
    operation: "coordinationPlans.cancel",
    resourceType: "coordination_plan",
    resourceId: planId,
    eventType: "coordinationPlan.canceled",
    version,
    applicationId,
    taskId: plan.parent_task_id,
    details: { revision: plan.revision },
  });
  return await loadPlanOutput(transaction, facts.organizationId, planId);
}
