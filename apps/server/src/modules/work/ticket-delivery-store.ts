import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type TicketCompletionPolicy,
  type TicketDeliveryEvidence,
  type TicketDeliveryVerdict,
  ticketDeliveryVerdict,
} from "./ticket-delivery.ts";

/**
 * What a request's delivery is judged on (#32): the completion policy of its
 * source and the pull requests registered for the task it runs on, and for the
 * child tasks its routed targets run on. Every statement names the
 * organization. The policy is the source's current one: it widens nothing an
 * admission pinned, it only says when finished work counts as delivered.
 */

export type RequestDeliveryFacts = Readonly<{
  policy: TicketCompletionPolicy;
  pullRequests: TicketDeliveryEvidence["pullRequests"];
  finishedSecondsAgo: number | null;
}>;

type FactsRow = {
  request_id: string;
  intent: string;
  completion: string | null;
  pull_request_statuses: string[];
  finished_seconds_ago: string | null;
};

const POLICIES: readonly TicketCompletionPolicy[] = [
  "task",
  "merged",
  "deployed_healthy",
];

function isPolicy(value: string | null): value is TicketCompletionPolicy {
  return value !== null && (POLICIES as readonly string[]).includes(value);
}

function isPullRequestStatus(
  value: string,
): value is "open" | "closed" | "merged" {
  return value === "open" || value === "closed" || value === "merged";
}

/**
 * The delivery facts of each request, by request id. A policy that is missing
 * or unknown reads as `merged`, the stored default, so a source saved before
 * the field existed keeps working.
 */
export async function readRequestDeliveryFacts(
  transaction: PgTransactionClient,
  organizationId: string,
  requestIds: readonly string[],
): Promise<Map<string, RequestDeliveryFacts>> {
  const facts = new Map<string, RequestDeliveryFacts>();
  if (requestIds.length === 0) return facts;
  const result = await transaction.query<FactsRow>(
    `select request.id as request_id, request.intent,
            source.policy ->> 'completion' as completion,
            array(
              select pull_request.status
                from bakery.pull_requests as pull_request
               where pull_request.organization_id = request.organization_id
                 and (pull_request.task_id = link.task_id
                   or pull_request.task_id in (
                     select target.child_task_id
                       from bakery.ticket_request_targets as target
                      where target.organization_id = request.organization_id
                        and target.ticket_request_id = request.id
                        and target.child_task_id is not null))
            ) as pull_request_statuses,
            (select floor(min(extract(epoch from now() - run.finished_at)))::text
               from bakery.workflow_runs as run
              where run.organization_id = request.organization_id
                and run.finished_at is not null
                and (run.task_id = link.task_id
                  or run.task_id in (
                    select target.child_task_id
                      from bakery.ticket_request_targets as target
                     where target.organization_id = request.organization_id
                       and target.ticket_request_id = request.id
                       and target.child_task_id is not null))
            ) as finished_seconds_ago
       from bakery.ticket_requests as request
       join bakery.ticket_task_links as link
         on link.organization_id = request.organization_id
        and link.id = request.ticket_task_link_id
       join bakery.external_tickets as ticket
         on ticket.organization_id = request.organization_id
        and ticket.id = request.external_ticket_id
       join bakery.ticket_sources as source
         on source.organization_id = ticket.organization_id
        and source.id = ticket.ticket_source_id
      where request.organization_id = $1 and request.id = any($2::uuid[])`,
    [organizationId, requestIds],
  );
  for (const row of result.rows) {
    facts.set(row.request_id, {
      // A planning-only request opens no pull request: its plan is the work,
      // so it is delivered when the run finishes, whatever the source says.
      policy: row.intent === "plan"
        ? "task"
        : isPolicy(row.completion)
        ? row.completion
        : "merged",
      pullRequests: row.pull_request_statuses.filter(isPullRequestStatus).map(
        (status) => ({ status }),
      ),
      finishedSecondsAgo: row.finished_seconds_ago === null
        ? null
        : Number(row.finished_seconds_ago),
    });
  }
  return facts;
}

/**
 * The verdict for one request. Release health is not recorded anywhere yet, so
 * `deployed_healthy` has no healthy evidence: a merge alone does not meet it.
 */
export function requestDeliveryVerdict(
  facts: RequestDeliveryFacts | undefined,
  workFinished: boolean,
): TicketDeliveryVerdict {
  return ticketDeliveryVerdict(facts?.policy ?? "merged", {
    workFinished,
    pullRequests: facts?.pullRequests ?? [],
    deployment: null,
    finishedSecondsAgo: facts?.finishedSecondsAgo ?? null,
  });
}
