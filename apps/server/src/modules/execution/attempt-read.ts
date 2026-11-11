import { Hono } from "hono";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  attemptReadImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createApiRouter, StandardError } from "@bakery/contracts/http";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { decodeCursor, encodeCursor } from "../../platform/cursor.ts";
import type { ExecutionRouteOptions } from "./shared.ts";
import { readAttemptRows } from "./attempt-read-query.ts";

export const JOB_ATTEMPTS_LIST_ACTION: ActionDefinition = Object.freeze({
  name: "jobAttempts.list",
  method: HttpMethod.Get,
  path: "/v1/jobs/:id/attempts",
  input: contractSchemas.JobAttemptListQuery,
  output: contractSchemas["Page<JobAttemptRead>"],
  policy: {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  },
  transactionIsolation: TransactionIsolation.RepeatableRead,
  handler(): never {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  },
});

async function listAttempts(
  context: ActionContext,
  rawInput: unknown,
  secret: string,
) {
  const input = contractSchemas.JobAttemptListQuery.parse(rawInput);
  const jobId = context.params.id;
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const scope = await transaction.query(
    `select job.id from bakery.jobs job
      join bakery.run_steps step on step.organization_id = job.organization_id and step.id = job.run_step_id
      join bakery.workflow_runs run on run.organization_id = step.organization_id and run.id = step.run_id
      join bakery.tasks task on task.organization_id = run.organization_id and task.id = run.task_id
        and task.archived_at is null and task.application_id = job.application_id
        and task.repository_id is not distinct from job.repository_id
      join bakery.applications app on app.organization_id = job.organization_id and app.id = job.application_id and app.archived_at is null
      left join bakery.repositories repo on repo.organization_id = job.organization_id and repo.id = job.repository_id
        and repo.application_id = app.id and repo.archived_at is null
      where job.organization_id = $1 and job.id = $2 and task.id = $3
        and (job.repository_id is null or repo.id is not null)
      union all
      select job.id from bakery.jobs job
      join bakery.conversation_turns turn
        on turn.organization_id = job.organization_id and turn.id = job.conversation_turn_id
      join bakery.tasks task on task.organization_id = turn.organization_id
        and task.conversation_id = turn.conversation_id and task.archived_at is null
      where job.organization_id = $1 and job.id = $2 and task.id = $3
        and job.action = 'coordinator.turn' and job.run_step_id is null`,
    [organizationId, jobId, input.taskId],
  );
  if (!scope.rows.length || !jobId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const binding = {
    action: "jobAttempts.list",
    principalId,
    organizationId,
    ordering: "createdAt:desc,id:desc",
    schemaVersion: 1,
    filters: await sha256Hex(canonicalJson({ jobId, taskId: input.taskId })),
  };
  const after = await decodeCursor(secret, input.cursor, binding);
  const limit = input.limit ?? 25;
  const rows = await readAttemptRows(transaction, {
    organizationId,
    jobId,
    taskId: input.taskId,
    afterId: after?.id ?? null,
    afterDate: after?.createdAt ?? null,
    limit: limit + 1,
  });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.createdAt,
        id: last.id,
      })
      : null,
  };
}

export function createAttemptReadApp(
  options: ExecutionRouteOptions,
): Hono<{ Variables: AuthVariables }> {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(options.database),
  );
  registry.register({
    ...JOB_ATTEMPTS_LIST_ACTION,
    handler: (context, input) => listAttempts(context, input, options.secret),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, attemptReadImplementedActions);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/jobs/*/attempts", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
