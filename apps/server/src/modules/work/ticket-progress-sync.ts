import type { PgDatabase } from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import { isNonterminalTicketDisposition } from "@bakery/contracts/ticket-admission";
import {
  readRequestDeliveryFacts,
  requestDeliveryVerdict,
} from "./ticket-delivery-store.ts";
import { noteProblemCode, type TicketNoteWriter } from "./ticket-notes.ts";
import {
  type TicketAudience,
  ticketProgressBody,
  ticketProgressPhase,
} from "./ticket-progress.ts";
import { ticketRequestProgress } from "./ticket-request-state.ts";

/**
 * Keeps Bakery's one status note on each ticket of a source true as its
 * request moves through phases (#32). It runs after a source's poll step, with
 * no transaction open during a provider write, and writes only when a ticket's
 * phase differs from the phase last recorded on its link:
 * 1. a short transaction reads the candidates and, per ticket, claims the link
 *    (`sync_health` `pending`, version bumped; a link changed since it was read
 *    is left to whoever changed it);
 * 2. the writer posts or rewrites the note;
 * 3. a second transaction records `healthy` with the phase, or `failed` with a
 *    fixed problem code.
 * A failed write keeps the link's last good phase and never touches the
 * request: accepted work is not undone by a note that did not post, and the
 * failure is retried after `PROGRESS_RETRY_SECONDS`. A claim whose writer
 * never answered stops counting as in flight after `PROGRESS_IN_FLIGHT_SECONDS`.
 * A ticket with no primary link, no author principal, or no issue number has
 * nothing to write to and is skipped.
 */

/** Most tickets one call writes; the rest wait for the next poll. */
export const PROGRESS_SYNC_LIMIT = 25;
/** How long a failed note waits before it is written again. */
export const PROGRESS_RETRY_SECONDS = 900;
/** How long a claimed write counts as in flight. */
export const PROGRESS_IN_FLIGHT_SECONDS = 600;

type Candidate = {
  link_id: string;
  link_version: number;
  request_id: string;
  disposition: string;
  run_status: string | null;
  task_status: string;
  task_title: string;
  authority_principal_id: string | null;
  provider: string;
  connection_id: string;
  resource_id: string;
  number: string | null;
  visibility: string;
  status_comment_external_id: string | null;
  last_synced_run_revision: number | null;
  sync_health: string;
  in_flight: boolean;
  backing_off: boolean;
};

/** What one call did. */
export type ProgressSyncResult = {
  posted: number;
  failed: number;
  skipped: number;
};

const READ_CANDIDATES = `
  select link.id as link_id, link.version as link_version,
         request.id as request_id, request.disposition,
         run.status as run_status, task.status as task_status,
         task.title as task_title, request.authority_principal_id,
         source.provider, source.integration_connection_id as connection_id,
         source.integration_resource_id as resource_id, ticket.number,
         ticket.visibility, link.status_comment_external_id,
         link.last_synced_run_revision, link.sync_health,
         (link.sync_health = 'pending'
            and link.updated_at > now() - make_interval(secs => $3)) as in_flight,
         (link.sync_health = 'failed'
            and link.updated_at > now() - make_interval(secs => $4)) as backing_off
    from bakery.ticket_requests as request
    join bakery.ticket_task_links as link
      on link.organization_id = request.organization_id
     and link.id = request.ticket_task_link_id and link.role = 'primary'
    join bakery.external_tickets as ticket
      on ticket.organization_id = link.organization_id
     and ticket.id = link.external_ticket_id
    join bakery.ticket_sources as source
      on source.organization_id = ticket.organization_id
     and source.id = ticket.ticket_source_id
    join bakery.tasks as task
      on task.organization_id = link.organization_id and task.id = link.task_id
    left join bakery.workflow_runs as run
      on run.organization_id = request.organization_id
     and run.id = request.workflow_run_id
   where request.organization_id = $1 and source.id = $2
     and request.generation = (
       select max(newest.generation) from bakery.ticket_requests as newest
        where newest.organization_id = request.organization_id
          and newest.ticket_task_link_id = request.ticket_task_link_id)
     and request.disposition not in ('pending', 'rejected')
     and (link.sync_health = 'failed'
          or link.last_synced_run_revision is not null
          or request.disposition in ('waiting', 'admitted', 'active', 'suspended'))
   order by link.updated_at, link.id
   limit $5`;

/**
 * Writes the note of each ticket of one source whose phase changed, up to
 * `PROGRESS_SYNC_LIMIT`, least recently touched first.
 */
export async function syncSourceProgress(
  deps: { database: PgDatabase; writer: TicketNoteWriter },
  call: {
    organizationId: string;
    sourceId: string;
    signal: AbortSignal;
  },
): Promise<ProgressSyncResult> {
  const result: ProgressSyncResult = { posted: 0, failed: 0, skipped: 0 };
  const claims = await withPgTransaction(deps.database, async (transaction) => {
    const read = await transaction.query<Candidate>(READ_CANDIDATES, [
      call.organizationId,
      call.sourceId,
      PROGRESS_IN_FLIGHT_SECONDS,
      PROGRESS_RETRY_SECONDS,
      PROGRESS_SYNC_LIMIT * 4,
    ]);
    const facts = await readRequestDeliveryFacts(
      transaction,
      call.organizationId,
      read.rows.map((row) => row.request_id),
    );
    const claimed: Array<{
      candidate: Candidate;
      phaseCode: number;
      claimedVersion: number;
      body: string;
    }> = [];
    for (const row of read.rows) {
      if (claimed.length >= PROGRESS_SYNC_LIMIT) break;
      const workFinished = row.run_status === null
        ? row.task_status === "completed"
        : row.run_status === "completed";
      const verdict = requestDeliveryVerdict(
        facts.get(row.request_id),
        workFinished,
      );
      const phase = ticketProgressPhase(
        ticketRequestProgress(
          row.disposition as Parameters<typeof ticketRequestProgress>[0],
          row.run_status,
          verdict.delivered,
        ),
        verdict,
      );
      const unchanged = row.sync_health === "healthy" &&
        row.last_synced_run_revision === phase?.code;
      if (
        phase === null || row.number === null ||
        row.authority_principal_id === null || row.in_flight ||
        row.backing_off || unchanged ||
        // A terminal request with a never-tracked link has nothing to catch up.
        (!isNonterminalTicketDisposition(row.disposition as never) &&
          row.last_synced_run_revision === null &&
          row.sync_health !== "failed")
      ) {
        result.skipped++;
        continue;
      }
      const pullRequests = await transaction.query<
        { provider_number: number; status: "open" | "closed" | "merged" }
      >(
        `select pull_request.provider_number, pull_request.status
           from bakery.pull_requests as pull_request
          where pull_request.organization_id = $1
            and pull_request.task_id in (
              select link.task_id from bakery.ticket_task_links as link
               where link.organization_id = $1 and link.id = $2
              union
              select target.child_task_id
                from bakery.ticket_request_targets as target
               where target.organization_id = $1
                 and target.ticket_request_id = $3
                 and target.child_task_id is not null)
          order by pull_request.provider_number
          limit 10`,
        [call.organizationId, row.link_id, row.request_id],
      );
      const claim = await transaction.query<{ version: number }>(
        `update bakery.ticket_task_links
            set sync_health = 'pending', updated_at = now(),
                version = version + 1
          where organization_id = $1 and id = $2 and version = $3
          returning version`,
        [call.organizationId, row.link_id, row.link_version],
      );
      if (claim.rows[0] === undefined) {
        result.skipped++;
        continue;
      }
      claimed.push({
        candidate: row,
        phaseCode: phase.code,
        claimedVersion: claim.rows[0].version,
        body: ticketProgressBody({
          phase,
          // Only a ticket observed as private may carry the task's title.
          audience: (row.visibility === "private"
            ? "private"
            : "public") satisfies TicketAudience,
          taskTitle: row.task_title,
          pullRequests: pullRequests.rows.map((pr) => ({
            number: pr.provider_number,
            status: pr.status,
          })),
        }),
      });
    }
    return claimed;
  }, call.signal);

  for (const claim of claims) {
    const row = claim.candidate;
    let outcome: Awaited<ReturnType<TicketNoteWriter["post"]>>;
    try {
      outcome = await deps.writer.post({
        organizationId: call.organizationId,
        actorPrincipalId: row.authority_principal_id!,
        provider: row.provider,
        connectionId: row.connection_id,
        resourceId: row.resource_id,
        issueNumber: Number(row.number),
        existingExternalId: row.status_comment_external_id,
        body: claim.body,
        idempotencyKey:
          `ticket-progress:${row.link_id}:${claim.claimedVersion}`,
        signal: call.signal,
      });
    } catch {
      outcome = { kind: "failed", problemCode: "note_post_failed" };
    }
    await withPgTransaction(deps.database, (transaction) =>
      transaction.query(
        `update bakery.ticket_task_links
            set sync_health = $4,
                status_comment_external_id = case when $4 = 'healthy' then $5
                  else status_comment_external_id end,
                last_synced_run_revision = case when $4 = 'healthy' then $6::integer
                  else last_synced_run_revision end,
                last_problem_code = $7,
                updated_at = now(), version = version + 1
          where organization_id = $1 and id = $2 and version = $3
            and sync_health = 'pending'`,
        [
          call.organizationId,
          row.link_id,
          claim.claimedVersion,
          outcome.kind === "posted" ? "healthy" : "failed",
          outcome.kind === "posted" ? outcome.externalId : null,
          claim.phaseCode,
          outcome.kind === "posted"
            ? (outcome.recreated ? "note_recreated" : null)
            : noteProblemCode(outcome.problemCode),
        ],
      ), call.signal);
    if (outcome.kind === "posted") result.posted++;
    else result.failed++;
  }
  return result;
}
