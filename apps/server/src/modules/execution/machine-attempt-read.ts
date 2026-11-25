import type { Context } from "hono";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { AuthVariables } from "../auth/middleware.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { jsonResponse } from "./http.ts";
import {
  machineTransaction,
  type MachineTransactionClient,
} from "./machines.ts";
import type { ExecutionRouteOptions } from "./shared.ts";

type AttemptState = "now" | "needs_attention" | "finished";

const ATTEMPT_STATE_SQL = `case
  when a.status = 'lost' then 'needs_attention'
  when a.status in ('completed', 'failed', 'canceled') then 'finished'
  when a.status = 'quarantined' or a.fence <> job.current_fence
    or a.lease_expires_at <= clock_timestamp() then 'needs_attention'
  else 'now' end`;

const LEASE_STATE_SQL = `case
  when a.status = 'lost' then 'lost'
  when a.status in ('completed', 'failed', 'canceled') then 'closed'
  when a.status = 'quarantined' or a.fence <> job.current_fence then 'unknown'
  when a.lease_expires_at <= clock_timestamp() then 'expired'
  else 'active' end`;

function parseQuery(context: Context<{ Variables: AuthVariables }>) {
  const search = new URL(context.req.url).searchParams;
  const single = (name: string) => {
    const values = search.getAll(name);
    if (values.length > 1) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    return values[0];
  };
  const limit = single("limit");
  const cursor = single("cursor");
  const parsed = contractSchemas.WorkerAttemptListQuery.safeParse({
    state: single("state"),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  });
  if (!parsed.success) throw new StandardError({ code: "MALFORMED_REQUEST" });
  return {
    state: parsed.data.state as AttemptState,
    cursor: parsed.data.cursor,
    limit: parsed.data.limit ?? 25,
  };
}

async function readMachineAttempts(
  transaction: MachineTransactionClient,
  scope: Readonly<{
    organizationId: string;
    workerHostId: string;
    state: AttemptState;
    afterDate: string | null;
    afterId: string | null;
    limit: number;
  }>,
) {
  const result = await transaction.query<{ row: unknown }>(
    `select jsonb_build_object(
       'id', a.id, 'jobId', a.job_id,
       'taskId', coalesce(run_task.id, turn_task.id),
       'taskTitle', left(coalesce(run_task.title, turn_task.title), 200),
       'runStepId', job.run_step_id, 'stepKey', step.step_key,
       'jobAction', job.action,
       'codingAgent', case when job.agent_config->>'harness'
           in ('pi', 'claude_code', 'codex', 'mastra')
         then job.agent_config->>'harness' end,
       'model', left(job.billing->>'model', 200),
       'status', a.status,
       'leaseState', ${LEASE_STATE_SQL},
       'startedAt', a.started_at,
       'createdAt', to_char(a.created_at at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as row
     from bakery.job_attempts a
     join bakery.jobs job
       on job.organization_id = a.organization_id and job.id = a.job_id
     left join bakery.run_steps step
       on step.organization_id = job.organization_id and step.id = job.run_step_id
     left join bakery.workflow_runs run
       on run.organization_id = step.organization_id and run.id = step.run_id
     left join bakery.tasks run_task
       on run_task.organization_id = run.organization_id and run_task.id = run.task_id
     left join bakery.conversation_turns turn
       on job.run_step_id is null
      and turn.organization_id = job.organization_id
      and turn.id = job.conversation_turn_id
     left join lateral (
       select candidate.id, candidate.title from bakery.tasks candidate
        where candidate.organization_id = turn.organization_id
          and candidate.conversation_id = turn.conversation_id
        order by candidate.created_at, candidate.id
        limit 1
     ) turn_task on true
     where a.organization_id = $1 and a.worker_host_id = $2
       and ${ATTEMPT_STATE_SQL} = $3
       and ($4::timestamptz is null or (a.created_at, a.id) < ($4::timestamptz, $5::uuid))
     order by a.created_at desc, a.id desc
     limit $6`,
    [
      scope.organizationId,
      scope.workerHostId,
      scope.state,
      scope.afterDate,
      scope.afterId,
      scope.limit,
    ],
  );
  return result.rows.map(({ row }) =>
    contractSchemas.WorkerAttemptRead.parse(row)
  );
}

export async function listMachineAttempts(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:read",
    "workerAttempts.list",
    async (transaction, organization, principal) => {
      const hosts = await transaction.query(
        `select 1 from bakery.worker_hosts
          where organization_id = $1 and id::text = $2`,
        [organization, workerHostId],
      );
      if (hosts.rows.length === 0) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const query = parseQuery(context);
      const binding: CursorBinding = {
        action: "workerAttempts.list",
        organizationId: organization,
        principalId: principal.principalId,
        ordering: "createdAt:desc,id:desc",
        filters: JSON.stringify({ workerHostId, state: query.state }),
        schemaVersion: 1,
      };
      const position = await decodeCursor(
        options.secret,
        query.cursor,
        binding,
      );
      const rows = await readMachineAttempts(transaction, {
        organizationId: organization,
        workerHostId,
        state: query.state,
        afterDate: position?.createdAt ?? null,
        afterId: position?.id ?? null,
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const nextCursor = rows.length > query.limit && last
        ? await encodeCursor(options.secret, binding, {
          createdAt: last.createdAt,
          id: last.id,
        })
        : null;
      return jsonResponse(
        contractSchemas["Page<WorkerAttemptRead>"].parse({ items, nextCursor }),
        200,
        false,
      );
    },
  );
}
