import type { z } from "zod";
import type { contractSchemas } from "@bakery/contracts/contracts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { pausedReason } from "./ticket-request-state.ts";

type DeliveryOutput = z.output<typeof contractSchemas.IssueDelivery>;

type DeliveryRow = {
  external_ticket_id: string;
  task_id: string;
  disposition: string;
  disposition_reason: string | null;
  pause_requested_at: Date | null;
  run_id: string | null;
  run_status: string | null;
  step_key: string | null;
  approval_subject: string | null;
  approval_step_key: string | null;
  question_open: boolean;
  question_expired: boolean;
  decision: string | null;
  decision_reason: string | null;
  pull_request_id: string | null;
  pull_request_number: number | null;
  pull_request_status: string | null;
  target_branch: string | null;
  merged_branch: string | null;
  paused_by: string | null;
  paused_by_name: string | null;
  environment: string | null;
  deployment_status: string | null;
};

const STOPPED_RUN = new Set(["failed", "canceled", "blocked", "needs_human"]);
const STARTING_RUN = new Set(["queued", "waiting_capacity"]);
const ENDED_WITHOUT_RUN = new Set(["failed", "canceled", "completed"]);

function approvalFor(subject: string): DeliveryOutput["approvalFor"] {
  if (subject === "plan_revision") return "plan";
  if (subject === "run_stage") return "change";
  return "step";
}

function stateOf(row: DeliveryRow): DeliveryOutput["state"] {
  if (row.deployment_status !== null) return "released";
  if (row.pull_request_status === "merged") return "merged";
  if (row.run_status === "paused" || row.disposition === "suspended") {
    return "paused";
  }
  if (row.approval_subject !== null) return "approval_waiting";
  if (row.question_open) return "question_open";
  if (row.question_expired) return "question_expired";
  if (row.run_status === null) {
    return ENDED_WITHOUT_RUN.has(row.disposition) ? "stopped" : "starting";
  }
  if (STOPPED_RUN.has(row.run_status) || row.decision === "stop") {
    return "stopped";
  }
  if (row.run_status === "completed") return "finished";
  if (STARTING_RUN.has(row.run_status)) return "starting";
  if (row.decision === "repair") return "fixing";
  return "working";
}

const STOP_REASONS = new Set([
  "policy_missing",
  "stale_evidence",
  "checks_unavailable",
  "repeated_blocker",
  "repair_cycles_exhausted",
  "repair_time_exhausted",
  "repair_budget_exhausted",
  "reviewer_unavailable",
  "review_failed",
]);

function stopReasonOf(row: DeliveryRow): DeliveryOutput["stopReason"] | null {
  if (row.decision !== "stop" || row.decision_reason === null) return null;
  return STOP_REASONS.has(row.decision_reason)
    ? row.decision_reason as DeliveryOutput["stopReason"]
    : null;
}

function pausedByOf(row: DeliveryRow): DeliveryOutput["pausedBy"] | null {
  if (row.paused_by !== null) return "person";
  if (row.disposition === "suspended" && row.pause_requested_at !== null) {
    return "bakery";
  }
  return null;
}

function toDelivery(row: DeliveryRow): DeliveryOutput {
  const state = stateOf(row);
  const paused = state === "paused";
  const pausedBy = paused ? pausedByOf(row) : null;
  return {
    taskId: row.task_id,
    runId: row.run_id,
    state,
    stepKey: state === "approval_waiting"
      ? row.approval_step_key ?? row.step_key
      : row.step_key,
    approvalFor: state === "approval_waiting" && row.approval_subject !== null
      ? approvalFor(row.approval_subject)
      : null,
    environment: row.environment,
    releaseStatus: row.deployment_status,
    pullRequestId: row.pull_request_id,
    pullRequestNumber: row.pull_request_number,
    targetBranch: row.target_branch,
    stopReason: state === "stopped" ? stopReasonOf(row) : null,
    mergedBranch: state === "merged" || state === "released"
      ? row.merged_branch
      : null,
    pausedBy,
    pausedByName: pausedBy === "person" ? row.paused_by_name : null,
    pausedReason: pausedBy === "bakery"
      ? pausedReason(row.pause_requested_at, row.disposition_reason)
      : null,
  } as DeliveryOutput;
}

export async function deliveryFor(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketIds: readonly string[],
): Promise<Map<string, DeliveryOutput>> {
  if (ticketIds.length === 0) return new Map();
  const result = await transaction.query<DeliveryRow>(
    `with latest as (
       select distinct on (request.external_ticket_id)
              request.id as request_id, request.external_ticket_id,
              request.disposition, request.disposition_reason,
              request.pause_requested_at, request.workflow_run_id,
              link.task_id
         from bakery.ticket_requests as request
         join bakery.ticket_task_links as link
           on link.organization_id = request.organization_id
          and link.id = request.ticket_task_link_id
        where request.organization_id = $1
          and request.external_ticket_id = any($2::uuid[])
          and request.disposition <> 'rejected'
        order by request.external_ticket_id, request.generation desc
     )
     select latest.external_ticket_id, latest.task_id, latest.disposition,
            latest.disposition_reason, latest.pause_requested_at,
            run.id as run_id, run.status as run_status,
            step.step_key, approval.subject_type as approval_subject,
            approval.step_key as approval_step_key,
            coalesce(question.open, false) as question_open,
            coalesce(question.expired, false) as question_expired,
            decision.decision, decision.reason as decision_reason,
            pull.id as pull_request_id,
            pull.provider_number as pull_request_number,
            pull.status as pull_request_status,
            pull.default_branch as target_branch,
            pull.merged_branch,
            pauser.principal_id as paused_by,
            pauser.display_name as paused_by_name,
            deployment.environment, deployment.status as deployment_status
       from latest
       join bakery.tasks as task
         on task.organization_id = $1 and task.id = latest.task_id
       left join bakery.workflow_runs as run
         on run.organization_id = $1
        and run.id = coalesce(latest.workflow_run_id, task.current_run_id)
       left join lateral (
         select candidate.step_key from bakery.run_steps as candidate
          where candidate.organization_id = $1 and candidate.run_id = run.id
            and candidate.status in ('running', 'waiting')
          order by candidate.position desc, candidate.iteration desc
          limit 1
       ) as step on true
       left join lateral (
         select pending.subject_type, pending.step_key
           from bakery.questions as pending
          where pending.organization_id = $1 and pending.task_id = latest.task_id
            and pending.kind = 'approval' and pending.status = 'open'
            and (pending.expires_at is null or pending.expires_at > now())
          order by pending.created_at desc, pending.id desc
          limit 1
       ) as approval on true
       left join lateral (
         select newest.status = 'open'
                  and (newest.expires_at is null or newest.expires_at > now())
                  as open,
                newest.status = 'expired'
                  or (newest.status = 'open' and newest.expires_at <= now())
                  as expired
           from bakery.questions as newest
          where newest.organization_id = $1 and newest.task_id = latest.task_id
            and newest.kind = 'question'
          order by newest.created_at desc, newest.id desc
          limit 1
       ) as question on true
       left join lateral (
         select made.decision, made.reason from bakery.delivery_decisions as made
          where made.organization_id = $1 and made.run_id = run.id
          order by made.ordinal desc
          limit 1
       ) as decision on true
       left join lateral (
         select opened.id, opened.provider_number, opened.status,
                repository.default_branch, landed.base_branch as merged_branch
           from bakery.pull_requests as opened
           join bakery.repositories as repository
             on repository.organization_id = opened.organization_id
            and repository.id = opened.repository_id
           left join lateral (
             select attempt.base_branch
               from bakery.pull_request_merge_attempts as attempt
              where attempt.organization_id = opened.organization_id
                and attempt.pull_request_id = opened.id
                and attempt.state = 'merged'
              order by attempt.created_at desc, attempt.id desc
              limit 1
           ) as landed on true
          where opened.organization_id = $1
            and opened.task_id = latest.task_id
          order by opened.created_at desc, opened.id desc
          limit 1
       ) as pull on true
       left join lateral (
         select shipped.environment, shipped.status
           from bakery.deployments as shipped
          where shipped.organization_id = $1 and shipped.run_id = run.id
          order by shipped.created_at desc, shipped.id desc
          limit 1
       ) as deployment on true
       left join lateral (
         select batch.paused_by as principal_id, who.display_name
           from bakery.batch_issues as member
           join bakery.batches as batch
             on batch.organization_id = member.organization_id
            and batch.id = member.batch_id
           left join bakery.principals as who on who.id = batch.paused_by
          where member.organization_id = $1
            and member.ticket_request_id = latest.request_id
            and batch.state = 'paused'
            and batch.paused_by is not null
          order by batch.paused_at desc nulls last, batch.id desc
          limit 1
       ) as pauser on true`,
    [organizationId, [...ticketIds]],
  );
  return new Map(
    result.rows.map((row) => [row.external_ticket_id, toDelivery(row)]),
  );
}
