/**
 * Starting a firing (issue #36): the firing an automation clock admitted
 * becomes a task and a run, through the same two commands every other intake
 * uses (`createTaskCommand`, `createRunCommand`), as the version's actor, in
 * the firing's own organization.
 *
 * Creating the run and marking the firing are one transaction, so a firing
 * starts at most one run however often it is started. A refusal that will not
 * change by waiting (an input the workflow rejects, an actor who no longer
 * holds the permissions, a missing target) marks the firing `failed` with a
 * stable code and leaves nothing else behind; anything else (a database or
 * dependency fault) is thrown and the firing stays queued for the next try.
 */
import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  contractSchemas,
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../platform/database.ts";
import { resolveOrganizationActor } from "../../auth/adapters/authority-postgres.ts";
import type { OrganizationActor } from "../../auth/application/authority.ts";
import { authorize } from "../../auth/application/authorize.ts";
import { createRunCommand } from "../../work/run-command.ts";
import { createTaskCommand } from "../../work/postgres.ts";
import { inSavepoint } from "../../work/ticket-sync.ts";
import { appendFacts } from "./facts.ts";
import { hasActiveRun } from "./overlap.ts";

export type StartOutcome =
  | Readonly<{ kind: "started"; runId: string; run: StartedRun }>
  | Readonly<{ kind: "failed"; code: string }>
  /** The firing is not queued, already has a run, or does not exist. */
  | Readonly<{ kind: "not_startable" }>
  /** An earlier run of the automation is still active: the firing stays queued. */
  | Readonly<{ kind: "held" }>;

type FiringFacts = {
  organization_id: string;
  automation_id: string;
  scheduled_at: Date | string;
  actor_id: string;
  workflow_version_id: string;
  inputs: unknown;
  application_id: string | null;
  repository_id: string | null;
  budget_limit_usd: string;
  brief: string | null;
  name: string;
};

/** Refusals that waiting does not change: the firing fails instead of retrying. */
export const DETERMINISTIC = new Set([
  "UNPROCESSABLE",
  "VALIDATION_FAILED",
  "STATE_CONFLICT",
  "VERSION_CONFLICT",
  "RESOURCE_NOT_FOUND",
  "AUTH_FORBIDDEN",
  "BUDGET_CAP_EXCEEDED",
]);

/** A short stable code for a refusal: the reason of an unprocessable input, else a conflict's reason, else the fault's own code. */
export function failureCodeOf(error: StandardError): string {
  const issues = error.params?.["issues"];
  if (Array.isArray(issues)) {
    const first = issues[0] as { code?: unknown } | undefined;
    if (typeof first?.code === "string" && first.code !== "") {
      return first.code.slice(0, 64);
    }
  }
  const reason = error.params?.["reason"];
  if (typeof reason === "string" && reason !== "") return reason.slice(0, 64);
  return error.code.toLowerCase();
}

/** Live actor holding `task:write` and `run:write` in the organization, or null. */
export async function liveActor(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
): Promise<OrganizationActor | null> {
  try {
    const actor = await resolveOrganizationActor(
      transaction,
      toPrincipalId(principalId),
      toOrganizationId(organizationId),
    );
    authorize(actor, "task:write");
    authorize(actor, "run:write");
    return actor;
  } catch (error) {
    if (error instanceof StandardError) return null;
    throw error;
  }
}

export function internalContext(
  transaction: PgTransactionClient,
  actor: OrganizationActor,
  trace: { requestId: string; traceId: string },
  params: Record<string, string>,
  commandMetadata?: {
    operation: string;
    idempotencyKey: string;
    target: string;
  },
): ActionContext {
  return {
    request: new Request("https://internal.invalid/automation-firing"),
    params,
    requestId: trace.requestId,
    traceId: trace.traceId,
    signal: new AbortController().signal,
    principal: actor.subject,
    authority: actor,
    transaction,
    ...(commandMetadata === undefined ? {} : { commandMetadata }),
  } as ActionContext;
}

/** What `createRunCommand` returned for the run a firing started. */
export type StartedRun = Awaited<ReturnType<typeof createRunCommand>>;

/** How a start differs when a person asks for it by hand (`automations.run`). */
export type StartOptions = Readonly<{
  /** Overrides the version's stored inputs for this run only, key by key. */
  inputs?: unknown;
  /**
   * `mark` (default): a refusal waiting will not change marks the firing
   * failed. `throw`: the refusal is thrown to the caller, who asked for this
   * run and is told why, and the caller's transaction undoes the firing.
   */
  refusals?: "mark" | "throw";
  /**
   * Leave the firing queued while a run of the automation is still active
   * (the promotion of a waiting firing). A manual run checks this itself.
   */
  holdWhileActive?: boolean;
}>;

const SAVEPOINT = "automation_firing_start";

/** The stored inputs with the caller's replaced by name; neither is edited. */
export function mergedInputs(stored: unknown, override: unknown): unknown {
  if (override === undefined) return stored;
  const plain = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!plain(override)) {
    throw unprocessable(["inputs"], "inputs_invalid");
  }
  return plain(stored) ? { ...stored, ...override } : { ...override };
}

/**
 * Starts one queued firing. Safe to call again and from several workers at
 * once: the definition and then the firing are locked, and a firing that is no
 * longer queued, or has a run, is left alone.
 */
export async function startFiring(options: {
  database: PgDatabase;
  firingId: string;
  holdWhileActive?: boolean;
}): Promise<StartOutcome> {
  return await withPgTransaction(
    options.database,
    (transaction) =>
      startFiringIn(transaction, options.firingId, {
        ...(options.holdWhileActive === true ? { holdWhileActive: true } : {}),
      }),
  );
}

/** `startFiring` inside a transaction the caller owns. */
export async function startFiringIn(
  transaction: PgTransactionClient,
  firingId: string,
  startOptions: StartOptions = {},
): Promise<StartOutcome> {
  const located = await transaction.query<
    { organization_id: string; automation_id: string }
  >(
    `select f.organization_id, v.automation_id
         from bakery.automation_firings f
         join bakery.automation_versions v
           on v.organization_id = f.organization_id
          and v.id = f.automation_version_id
        where f.id = $1`,
    [firingId],
  );
  const place = located.rows[0];
  if (!place) return { kind: "not_startable" } as const;

  // The definition first, then the firing: the order every writer uses.
  await transaction.query(
    `select 1 from bakery.automation_definitions
        where organization_id = $1 and id = $2
        for update`,
    [place.organization_id, place.automation_id],
  );
  const facts = await transaction.query<
    FiringFacts & { status: string; run_id: string | null }
  >(
    `select f.organization_id, v.automation_id, f.scheduled_at, f.status,
              f.run_id, v.actor_id, v.workflow_version_id, v.inputs,
              v.application_id, v.repository_id,
              v.budget_limit_usd::text as budget_limit_usd, v.brief, d.name
         from bakery.automation_firings f
         join bakery.automation_versions v
           on v.organization_id = f.organization_id
          and v.id = f.automation_version_id
         join bakery.automation_definitions d
           on d.organization_id = v.organization_id and d.id = v.automation_id
        where f.id = $1
        for update of f`,
    [firingId],
  );
  const firing = facts.rows[0];
  if (!firing || firing.status !== "queued" || firing.run_id !== null) {
    return { kind: "not_startable" } as const;
  }
  if (
    startOptions.holdWhileActive === true &&
    await hasActiveRun(
      transaction,
      firing.organization_id,
      firing.automation_id,
    )
  ) return { kind: "held" } as const;
  const trace = {
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID().replaceAll("-", ""),
  };

  const fail = async (code: string) => {
    const marked = await transaction.query<{ version: number }>(
      `update bakery.automation_firings
            set status = 'failed', pending = false, failure_code = $2,
                updated_at = now(), version = version + 1
          where id = $1
          returning version`,
      [firingId, code],
    );
    await appendFacts(transaction, {
      organizationId: firing.organization_id,
      principalId: firing.actor_id,
      operation: "automationFirings.start",
      resourceType: "automation_firing",
      resourceId: firingId,
      eventType: "automation.firing_failed",
      resourceVersion: marked.rows[0]!.version,
      requestId: trace.requestId,
      traceId: trace.traceId,
      outcome: "failed",
      details: { code },
    });
    return { kind: "failed", code } as const;
  };

  // A refusal of a firing is marked on it; one a person asked for is theirs.
  const refuse = async (code: string) => {
    if (startOptions.refusals === "throw") {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: code },
      });
    }
    return await fail(code);
  };
  if (firing.application_id === null) return await refuse("target_missing");
  const actor = await liveActor(
    transaction,
    firing.organization_id,
    firing.actor_id,
  );
  if (actor === null) return await refuse("actor_unavailable");

  try {
    const started = await inSavepoint(transaction, SAVEPOINT, async () => {
      const scheduledAt = new Date(firing.scheduled_at).toISOString();
      const taskInput = contractSchemas.TaskCreate.safeParse({
        applicationId: firing.application_id,
        ...(firing.repository_id === null
          ? {}
          : { repositoryId: firing.repository_id }),
        taskType: firing.repository_id === null ? "maintenance" : "feature",
        title: `${firing.name.slice(0, 440)} ${scheduledAt}`,
        ...(firing.brief === null ? {} : { description: firing.brief }),
      });
      if (!taskInput.success) {
        throw unprocessable(["title"], "task_input_invalid", taskInput.error);
      }
      const task = await createTaskCommand(
        internalContext(transaction, actor, trace, {}),
        taskInput.data,
      ) as { id: string; repositoryProfileId: string | null };
      const runInput = contractSchemas.RunCreate.safeParse({
        workflowVersionId: firing.workflow_version_id,
        executionMode: firing.repository_id === null
          ? "cloud_only"
          : "repository",
        ...(task.repositoryProfileId === null
          ? {}
          : { repositoryProfileId: task.repositoryProfileId }),
        budgetLimitUsd: String(Number(firing.budget_limit_usd)),
        inputs: mergedInputs(firing.inputs, startOptions.inputs),
      });
      if (!runInput.success) {
        throw unprocessable(["inputs"], "run_input_invalid", runInput.error);
      }
      const run = await createRunCommand(
        internalContext(transaction, actor, trace, { id: task.id }, {
          operation: "runs.create",
          idempotencyKey: `automation-firing:${firingId}`,
          target: `/v1/tasks/${task.id}/runs`,
        }),
        runInput.data,
      );
      const marked = await transaction.query<{ version: number }>(
        `update bakery.automation_firings
              set status = 'started', pending = false, run_id = $2,
                  updated_at = now(), version = version + 1
            where id = $1 and status = 'queued' and run_id is null
            returning version`,
        [firingId, run.id],
      );
      return { runId: run.id, run, version: marked.rows[0]!.version };
    });
    await appendFacts(transaction, {
      organizationId: firing.organization_id,
      principalId: firing.actor_id,
      operation: "automationFirings.start",
      resourceType: "automation_firing",
      resourceId: firingId,
      eventType: "automation.firing_started",
      resourceVersion: started.version,
      requestId: trace.requestId,
      traceId: trace.traceId,
    });
    return {
      kind: "started",
      runId: started.runId,
      run: started.run,
    } as const;
  } catch (error) {
    // inSavepoint has rolled the task and run back: only the firing is marked.
    if (
      startOptions.refusals !== "throw" && error instanceof StandardError &&
      DETERMINISTIC.has(error.code)
    ) return await fail(failureCodeOf(error));
    throw error;
  }
}
