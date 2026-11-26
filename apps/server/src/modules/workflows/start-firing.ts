/**
 * Firing a workflow's starts (one engine O8, #406 slice 3).
 *
 * A neutral event that a live start answers earns one firing per start, and the
 * firing becomes a task and a run through the same two commands every other
 * intake uses, as the principal who used the version the start sits on.
 *
 * That principal is not trusted from the day they acted. Each firing re-reads
 * their membership and permissions when it fires (`liveActor`), and a person
 * who has since lost access, or who was never recorded, fails the firing with
 * `actor_unavailable`: the firing row keeps the code and an audit row and a
 * domain event say so, and no task or run exists. Nothing is run on a stale
 * grant.
 *
 * Admitting and starting are one transaction with the route that earned them,
 * so a firing and its route settle together; a firing starts at most one run
 * however often its route is replayed (the unique key is one firing per
 * version, start and event).
 */
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { WorkflowStartsSchema } from "@bakery/contracts/workflow-starts";
import type { PgTransactionClient } from "../../platform/database.ts";
import type { NeutralEvent } from "../integrations/neutral-events.ts";
import { createTaskCommand } from "../work/postgres.ts";
import { createRunCommand } from "../work/run-command.ts";
import { inSavepoint } from "../work/ticket-sync.ts";
import { appendFacts } from "./automations/facts.ts";
import {
  DETERMINISTIC,
  failureCodeOf,
  internalContext,
  liveActor,
} from "./automations/start.ts";
import { type LiveStart, liveStartsFor } from "./start-match.ts";

/** The most firings one workflow admits in an hour; the rest are skipped. */
export const START_FIRINGS_PER_HOUR = 60;

const SAVEPOINT = "workflow_start_firing";

/** What came of one live start answering an event. */
export type StartFiringOutcome = Readonly<{
  workflowId: string;
  versionId: string;
  startId: string;
  result:
    | "started"
    | "failed"
    | "skipped_rate"
    | "superseded"
    | "duplicate";
  /** The stable code of a failed firing. */
  code?: string;
}>;

type Definition = {
  active_version_id: string | null;
  active_version_set_by: string | null;
  enabled: boolean;
  name: string;
};

/**
 * Admits and starts the firing each live start of the organization earns for
 * one event on one Bakery repository. The caller holds the transaction of the
 * route; definitions are locked in id order, as every writer does.
 */
export async function fireStartsFor(
  transaction: PgTransactionClient,
  route: { organizationId: string; inboundEventId: string },
  repository: { id: string },
  event: NeutralEvent,
): Promise<StartFiringOutcome[]> {
  const live = await liveStartsFor(transaction, route.organizationId, event);
  const admitted = await ticketAdmittedWorkflows(
    transaction,
    route.organizationId,
    repository,
    event,
  );
  const outcomes: StartFiringOutcome[] = [];
  for (const start of live) {
    outcomes.push(
      admitted.has(start.workflowId)
        ? {
          workflowId: start.workflowId,
          versionId: start.versionId,
          startId: start.startId,
          result: "duplicate",
          code: "ticket_source_admits",
        }
        : await fireLiveStart(transaction, route, repository, start),
    );
  }
  return outcomes;
}

const TICKET_ADMISSION_EVENT = "work_item.labeled";

async function ticketAdmittedWorkflows(
  transaction: PgTransactionClient,
  organizationId: string,
  repository: { id: string },
  event: NeutralEvent,
): Promise<ReadonlySet<string>> {
  if (event.kind !== TICKET_ADMISSION_EVENT) return new Set();
  const result = await transaction.query<{ workflow_id: string }>(
    `select distinct policy -> 'workflow' ->> 'workflowId' as workflow_id
       from bakery.ticket_sources
      where organization_id = $1 and repository_id = $2 and enabled
        and (policy -> 'automatic' ->> 'enabled')::boolean
        and policy -> 'workflow' ->> 'workflowId' is not null`,
    [organizationId, repository.id],
  );
  return new Set(result.rows.map((row) => row.workflow_id));
}

/**
 * One live start answering one event. It re-reads the definition under its lock
 * and fires only if that version is still the one in use and the workflow is
 * still enabled: the match ran before the lock, and a start answers for the
 * version in use at the moment it fires.
 */
export async function fireLiveStart(
  transaction: PgTransactionClient,
  route: { organizationId: string; inboundEventId: string },
  repository: { id: string },
  start: LiveStart,
): Promise<StartFiringOutcome> {
  const outcome = (
    result: StartFiringOutcome["result"],
    code?: string,
  ): StartFiringOutcome => ({
    workflowId: start.workflowId,
    versionId: start.versionId,
    startId: start.startId,
    result,
    ...(code === undefined ? {} : { code }),
  });

  // The definition is locked, then read again: the match ran before the lock,
  // and a person may have used another version in between. A start answers
  // only for the version in use at the moment it fires.
  const locked = await transaction.query<Definition>(
    `select active_version_id, active_version_set_by, enabled, name
       from bakery.workflow_definitions
      where organization_id = $1 and id = $2
        for update`,
    [route.organizationId, start.workflowId],
  );
  const definition = locked.rows[0];
  if (
    definition === undefined || !definition.enabled ||
    definition.active_version_id !== start.versionId
  ) return outcome("superseded");

  const application = await transaction.query<{ application_id: string }>(
    `select application_id from bakery.repositories
      where organization_id = $1 and id = $2`,
    [route.organizationId, repository.id],
  );
  const applicationId = application.rows[0]?.application_id;
  if (applicationId === undefined) return outcome("superseded");

  const recent = await transaction.query<{ count: string }>(
    `select count(*)::text as count from bakery.workflow_start_firings
      where organization_id = $1 and workflow_id = $2
        and status <> 'skipped'
        and created_at > now() - interval '1 hour'`,
    [route.organizationId, start.workflowId],
  );
  const overRate = Number(recent.rows[0]?.count ?? 0) >= START_FIRINGS_PER_HOUR;

  const inserted = await transaction.query<{ id: string; version: number }>(
    `insert into bakery.workflow_start_firings (
       organization_id, workflow_id, workflow_version_id, start_id,
       trigger_event_id, application_id, repository_id, actor_id, status,
       failure_code
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict do nothing
     returning id, version`,
    [
      route.organizationId,
      start.workflowId,
      start.versionId,
      start.startId,
      route.inboundEventId,
      applicationId,
      repository.id,
      definition.active_version_set_by,
      overRate ? "skipped" : "queued",
      overRate ? "rate_limited" : null,
    ],
  );
  const firing = inserted.rows[0];
  if (firing === undefined) return outcome("duplicate");
  if (overRate) return outcome("skipped_rate", "rate_limited");
  return await startFiringIn(transaction, {
    firingId: firing.id,
    organizationId: route.organizationId,
    workflowId: start.workflowId,
    versionId: start.versionId,
    startId: start.startId,
    applicationId,
    repositoryId: repository.id,
    actorId: definition.active_version_set_by,
    name: definition.name,
  }, outcome);
}

type FiringToStart = Readonly<{
  firingId: string;
  organizationId: string;
  workflowId: string;
  versionId: string;
  startId: string;
  applicationId: string;
  repositoryId: string;
  actorId: string | null;
  name: string;
}>;

async function startFiringIn(
  transaction: PgTransactionClient,
  firing: FiringToStart,
  outcome: (
    result: StartFiringOutcome["result"],
    code?: string,
  ) => StartFiringOutcome,
): Promise<StartFiringOutcome> {
  const trace = {
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID().replaceAll("-", ""),
  };
  // The actor of the facts is the one the firing runs as; with none recorded
  // the organization's own audit needs somebody, so the version's author stands
  // in for the audit row only (the firing itself still fails).
  const auditor = firing.actorId ?? await authorOf(transaction, firing);
  const fail = async (code: string) => {
    const marked = await transaction.query<{ version: number }>(
      `update bakery.workflow_start_firings
          set status = 'failed', failure_code = $2, updated_at = now(),
              version = version + 1
        where id = $1 and status = 'queued'
        returning version`,
      [firing.firingId, code],
    );
    await appendFacts(transaction, {
      organizationId: firing.organizationId,
      principalId: auditor,
      operation: "workflowStartFirings.start",
      resourceType: "workflow_start_firing",
      resourceId: firing.firingId,
      eventType: "workflow.start_firing_failed",
      resourceVersion: marked.rows[0]!.version,
      requestId: trace.requestId,
      traceId: trace.traceId,
      outcome: "failed",
      details: {
        code,
        workflowId: firing.workflowId,
        startId: firing.startId,
      },
    });
    return outcome("failed", code);
  };

  if (firing.actorId === null) return await fail("actor_unavailable");
  // The re-check the whole design rests on: the principal who used this
  // version must hold task:write and run:write in the organization now.
  const actor = await liveActor(
    transaction,
    firing.organizationId,
    firing.actorId,
  );
  if (actor === null) return await fail("actor_unavailable");

  const budget = await transaction.query<{ starts: unknown }>(
    `select starts from bakery.workflow_versions
      where organization_id = $1 and id = $2`,
    [firing.organizationId, firing.versionId],
  );
  const start = WorkflowStartsSchema.parse(budget.rows[0]?.starts ?? [])
    .find((candidate) => candidate.id === firing.startId);
  if (start === undefined) return await fail("start_missing");

  try {
    const started = await inSavepoint(transaction, SAVEPOINT, async () => {
      const taskInput = contractSchemas.TaskCreate.safeParse({
        applicationId: firing.applicationId,
        repositoryId: firing.repositoryId,
        taskType: "feature",
        title: `${firing.name.slice(0, 400)} ${new Date().toISOString()}`,
      });
      if (!taskInput.success) {
        throw unprocessable(["title"], "task_input_invalid", taskInput.error);
      }
      const task = await createTaskCommand(
        internalContext(transaction, actor, trace, {}),
        taskInput.data,
      ) as { id: string; repositoryProfileId: string | null };
      const runInput = contractSchemas.RunCreate.safeParse({
        workflowVersionId: firing.versionId,
        executionMode: "repository",
        ...(task.repositoryProfileId === null
          ? {}
          : { repositoryProfileId: task.repositoryProfileId }),
        budgetLimitUsd: String(start.budgetUsd ?? 0),
        inputs: start.inputs ?? {},
      });
      if (!runInput.success) {
        throw unprocessable(["inputs"], "run_input_invalid", runInput.error);
      }
      const run = await createRunCommand(
        internalContext(transaction, actor, trace, { id: task.id }, {
          operation: "runs.create",
          idempotencyKey: `workflow-start-firing:${firing.firingId}`,
          target: `/v1/tasks/${task.id}/runs`,
        }),
        runInput.data,
      );
      const marked = await transaction.query<{ version: number }>(
        `update bakery.workflow_start_firings
            set status = 'started', run_id = $2, updated_at = now(),
                version = version + 1
          where id = $1 and status = 'queued' and run_id is null
          returning version`,
        [firing.firingId, run.id],
      );
      return { runId: run.id, version: marked.rows[0]!.version };
    });
    await appendFacts(transaction, {
      organizationId: firing.organizationId,
      principalId: firing.actorId,
      operation: "workflowStartFirings.start",
      resourceType: "workflow_start_firing",
      resourceId: firing.firingId,
      eventType: "workflow.start_firing_started",
      resourceVersion: started.version,
      requestId: trace.requestId,
      traceId: trace.traceId,
      details: { workflowId: firing.workflowId, startId: firing.startId },
    });
    return outcome("started");
  } catch (error) {
    // inSavepoint rolled the task and run back: only the firing is marked. A
    // refusal waiting will not change is recorded; any other fault is thrown
    // and the route retries.
    if (error instanceof StandardError && DETERMINISTIC.has(error.code)) {
      return await fail(failureCodeOf(error));
    }
    throw error;
  }
}

/** The version's author, the audit row's stand-in when no actor was recorded. */
async function authorOf(
  transaction: PgTransactionClient,
  firing: FiringToStart,
): Promise<string> {
  const author = await transaction.query<{ created_by: string }>(
    `select created_by from bakery.workflow_versions
      where organization_id = $1 and id = $2`,
    [firing.organizationId, firing.versionId],
  );
  return author.rows[0]!.created_by;
}
