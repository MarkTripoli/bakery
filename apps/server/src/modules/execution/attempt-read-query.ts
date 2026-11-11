import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type ContractOutput,
  contractSchemas,
} from "@bakery/contracts/contracts";
import { z } from "zod";

type Outcome = ContractOutput<"JobAttemptOutcome">;
const emptyOutcome: Outcome = {
  resultStatus: null,
  reasonCode: null,
  exitCode: null,
  processExited: null,
  terminationStatus: null,
  exitedAt: null,
  usage: null,
};
/** Frozen harness fault codes that project to the public `timeout` reason. */
const harnessTimeoutFaultCodes: ReadonlySet<string> = new Set([
  "CLAUDE_HARNESS_TIMEOUT",
  "CODEX_HARNESS_TIMEOUT",
  "PI_HARNESS_TIMEOUT",
]);
function safe<K extends keyof Outcome>(
  name: K,
  value: unknown,
): Outcome[K] | null {
  const parsed = contractSchemas.JobAttemptOutcome.safeParse({
    ...emptyOutcome,
    [name]: value,
  });
  return parsed.success ? parsed.data[name] : null;
}

export async function readAttemptRows(
  transaction: PgTransactionClient,
  scope: Readonly<
    {
      organizationId: string;
      jobId: string;
      taskId: string;
      afterId: string | null;
      afterDate: string | null;
      limit: number;
    }
  >,
): Promise<readonly ContractOutput<"JobAttemptRead">[]> {
  const result = await transaction.query<
    { identity: unknown; outcome: Record<string, unknown> }
  >(
    `select jsonb_build_object(
       'id', a.id, 'jobId', a.job_id, 'taskId', $3::uuid, 'runStepId', job.run_step_id,
       'workerHostId', a.worker_host_id, 'workerName', left(host.name, 200),
       'attemptNo', a.attempt_no, 'status', a.status,
       'isCurrent', a.fence = job.current_fence,
       'leaseState', case when a.status = 'lost' then 'lost'
         when a.status in ('completed','failed','canceled') then 'closed'
         when a.status = 'quarantined' or a.fence <> job.current_fence then 'unknown'
         when a.lease_expires_at <= current_timestamp then 'expired' else 'active' end,
       'leaseExpiresAt', a.lease_expires_at, 'startedAt', a.started_at,
       'endedAt', a.ended_at, 'createdAt', to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
       'updatedAt', a.updated_at) as identity,
       jsonb_build_object(
         'resultStatus', case when a.result->'result'->>'status' in ('completed','failed','canceled','timed_out') then a.result->'result'->'status' else a.result->'status' end,
         'reasonCode', a.result->'fault'->'code', 'reason', a.result->'fault'->'reason', 'leaseReason',
           (select to_jsonb('lease_expired'::text) from bakery.audit_events audit
             where audit.organization_id = a.organization_id and audit.resource_id = a.id::text
               and audit.operation = 'workers.attempt_reclaimed' and audit.details->>'reason' = 'lease_expired' limit 1),
         'exitCode', coalesce(a.result->'result'->'exitCode', a.result->'fault'->'exitCode'),
         'processExited', a.result->'cancellation'->'processExited',
         'terminationStatus', a.result->'cancellation'->'terminationStatus',
         'exitedAt', a.result->'cancellation'->'exitedAt',
         'usage', usage.value) as outcome
     from bakery.job_attempts a
     join bakery.jobs job on job.organization_id = a.organization_id and job.id = a.job_id
     join bakery.worker_hosts host on host.organization_id = a.organization_id and host.id = a.worker_host_id
     left join lateral (
       select case when count(*) > 0 then jsonb_build_object(
         'inputTokens', sum(receipt.input_tokens)::text,
         'outputTokens', sum(receipt.output_tokens)::text,
         'costUsd', sum(receipt.cost_usd)::text) else null end as value
       from bakery.usage_records u
       join bakery.budget_action_intents intent on intent.organization_id = u.organization_id
         and intent.installation_reservation_id = u.budget_reservation_id
       join bakery.provider_authoritative_receipts receipt on receipt.organization_id = u.organization_id
         and receipt.provider_call_intent_id = intent.provider_call_intent_id
         and receipt.provider_call_id = u.provider_call_id and receipt.usage_fact_id = u.usage_fact_id
         and receipt.input_tokens is not distinct from u.input_tokens
         and receipt.output_tokens is not distinct from u.output_tokens
         and receipt.cost_usd is not distinct from u.cost_usd
         and receipt.measurement = u.measurement and receipt.occurred_at = u.occurred_at
       where u.organization_id = a.organization_id and u.attempt_id = a.id
         and u.provenance = 'provider-authoritative'
     ) usage on true
     where a.organization_id = $1 and a.job_id = $2
       and ($4::timestamptz is null or (a.created_at, a.id) < ($4::timestamptz, $5::uuid))
     order by a.created_at desc, a.id desc limit $6`,
    [
      scope.organizationId,
      scope.jobId,
      scope.taskId,
      scope.afterDate,
      scope.afterId,
      scope.limit,
    ],
  );
  return result.rows.map(({ identity, outcome }) => {
    const base = z.record(
      z.string().describe("Selected field name."),
      z.unknown().describe("Selected database field value."),
    ).describe(
      "Database selected identity fields.",
    ).parse(identity);
    const exit = safe("exitCode", outcome.exitCode);
    const resultStatus = safe("resultStatus", outcome.resultStatus);
    const parsedReason = safe("reasonCode", outcome.reasonCode) ??
      safe("reasonCode", outcome.reason) ??
      safe("reasonCode", outcome.leaseReason);
    const reasonCode = parsedReason ??
      (resultStatus === "failed" &&
          typeof outcome.reasonCode === "string" &&
          harnessTimeoutFaultCodes.has(outcome.reasonCode)
        ? "timeout"
        : null);
    return contractSchemas.JobAttemptRead.parse({
      ...base,
      outcome: {
        resultStatus,
        reasonCode,
        exitCode: exit !== null && exit >= 0 && exit <= 255 ? exit : null,
        processExited: safe(
          "processExited",
          outcome.processExited,
        ),
        terminationStatus: safe(
          "terminationStatus",
          outcome.terminationStatus,
        ),
        exitedAt: safe("exitedAt", outcome.exitedAt),
        usage: safe("usage", outcome.usage),
      },
    });
  });
}
