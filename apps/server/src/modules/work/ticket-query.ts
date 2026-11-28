import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  latestReportsFor,
  nonterminalRequestsFor,
  type TicketRequest,
} from "./ticket-store.ts";
import { deliveryFor } from "./ticket-delivery-line.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

/**
 * Reads of ticket sources and cached external tickets. Every statement names
 * `organization_id`, so another organization's id answers exactly as a missing
 * one. Lists are keyset pages ordered newest first, bound to the action, the
 * caller and the filters in force by the signed cursor. They never reach the
 * provider: tickets are the last stored snapshots.
 */

type TicketSourceOutput = z.output<typeof contractSchemas.TicketSource>;
type ExternalTicketOutput = z.output<typeof contractSchemas.ExternalTicket>;
type SourceQuery = z.output<typeof contractSchemas.TicketSourceQuery>;
type TicketQuery = z.output<typeof contractSchemas.ExternalTicketQuery>;
type LinkQuery = z.output<typeof contractSchemas.TicketTaskLinkQuery>;
type LinkOutput = z.output<typeof contractSchemas.TicketTaskLink>;

const ORDERING = "createdAt:desc,id:desc";
const CURSOR_TIME = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

const SOURCE_COLUMNS = `id, organization_id, integration_connection_id,
  integration_resource_id, application_id, repository_id,
  external_container_id, enabled, policy, policy_revision, sync_health,
  last_synced_at, last_problem_code, created_at, updated_at, version`;

type SourceRow = {
  id: string;
  organization_id: string;
  integration_connection_id: string;
  integration_resource_id: string;
  application_id: string | null;
  repository_id: string | null;
  external_container_id: string;
  enabled: boolean;
  policy: unknown;
  policy_revision: number;
  sync_health: TicketSourceOutput["syncHealth"];
  last_synced_at: Date | null;
  last_problem_code: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  cursor_created_at?: string;
};

function toSourceOutput(row: SourceRow): TicketSourceOutput {
  return {
    id: row.id,
    organizationId: row.organization_id,
    integrationConnectionId: row.integration_connection_id,
    integrationResourceId: row.integration_resource_id,
    applicationId: row.application_id,
    repositoryId: row.repository_id,
    externalContainerId: row.external_container_id,
    enabled: row.enabled,
    policy: row.policy,
    policyRevision: row.policy_revision,
    syncHealth: row.sync_health,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    lastProblemCode: row.last_problem_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  } as TicketSourceOutput;
}

/** One source of the organization as the API shows it; a missing or foreign id is `RESOURCE_NOT_FOUND`. */
export async function loadTicketSource(
  transaction: PgTransactionClient,
  organizationId: string,
  sourceId: string,
): Promise<TicketSourceOutput> {
  const result = await transaction.query<SourceRow>(
    `select ${SOURCE_COLUMNS} from bakery.ticket_sources
      where organization_id = $1 and id = $2`,
    [organizationId, sourceId],
  );
  if (!result.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return toSourceOutput(result.rows[0]);
}

function routeId(context: ActionContext): string {
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return id;
}

/** The cursor of the page after `rows`, or null when `rows` did not overflow `limit`. */
async function nextCursor(
  secret: string,
  binding: CursorBinding,
  rows: readonly { id: string; cursor_created_at?: string }[],
  limit: number,
): Promise<string | null> {
  const last = rows[limit - 1];
  if (rows.length <= limit || !last?.cursor_created_at) return null;
  return await encodeCursor(secret, binding, {
    createdAt: last.cursor_created_at,
    id: last.id,
  });
}

export function createTicketSourcesListHandler(secret: string) {
  return async (context: ActionContext, input: SourceQuery) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const binding: CursorBinding = {
      action: "ticketSources.list",
      principalId,
      organizationId,
      ordering: ORDERING,
      filters: JSON.stringify({
        connectionId: input.connectionId ?? null,
        enabled: input.enabled ?? null,
      }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<SourceRow>(
      `select ${SOURCE_COLUMNS},
              to_char(created_at at time zone 'UTC', ${CURSOR_TIME})
                as cursor_created_at
         from bakery.ticket_sources
        where organization_id = $1
          and ($2::uuid is null or integration_connection_id = $2::uuid)
          and ($3::boolean is null or enabled = $3::boolean)
          and ($4::timestamptz is null
               or (created_at, id) < ($4::timestamptz, $5::uuid))
        order by created_at desc, id desc
        limit $6`,
      [
        organizationId,
        input.connectionId ?? null,
        input.enabled ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    return {
      items: result.rows.slice(0, limit).map(toSourceOutput),
      nextCursor: await nextCursor(secret, binding, result.rows, limit),
    };
  };
}

export async function getTicketSource(
  context: ActionContext,
): Promise<TicketSourceOutput> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  return await loadTicketSource(transaction, organizationId, routeId(context));
}

const TICKET_COLUMNS = `ticket.id, ticket.organization_id,
  ticket.ticket_source_id, ticket.external_ticket_id, ticket.key,
  ticket.number, ticket.safe_url, ticket.snapshot, ticket.requirements_digest,
  ticket.provider_update_marker, ticket.visibility, ticket.state,
  ticket.last_observed_at, ticket.created_at, ticket.updated_at,
  ticket.version`;

type TicketRowOut = {
  id: string;
  organization_id: string;
  ticket_source_id: string;
  external_ticket_id: string;
  key: string;
  number: string | null;
  safe_url: string;
  snapshot: unknown;
  requirements_digest: string;
  provider_update_marker: string;
  visibility: "public" | "private";
  state: string;
  last_observed_at: Date;
  created_at: Date;
  updated_at: Date;
  version: number;
  cursor_created_at?: string;
};

function activeRequestOf(request: TicketRequest | undefined) {
  return request === undefined ? null : {
    id: request.id,
    intent: request.intent,
    generation: request.generation,
    disposition: request.disposition,
    dispositionReason: request.dispositionReason,
    workflowRunId: request.workflowRunId,
  };
}

/** At most this many linked task ids are listed per ticket. */
const MAX_LINKED_TASK_IDS = 25;

type LinkedTasks = { ids: string[]; count: number };

/**
 * Each ticket's linked tasks from `ticket_task_links`, most recently linked
 * first and cut at `MAX_LINKED_TASK_IDS`, with the uncut count. One statement
 * per page, scoped to the organization.
 */
async function linkedTasksFor(
  transaction: PgTransactionClient,
  organizationId: string,
  ticketIds: readonly string[],
): Promise<Map<string, LinkedTasks>> {
  const result = await transaction.query<
    { external_ticket_id: string; task_ids: string[]; total: number }
  >(
    `select ranked.external_ticket_id,
            array_agg(ranked.task_id order by ranked.position)
              filter (where ranked.position <= $3) as task_ids,
            count(*)::integer as total
       from (
         select link.external_ticket_id, link.task_id,
                row_number() over (
                  partition by link.external_ticket_id
                  order by link.created_at desc, link.id desc
                ) as position
           from bakery.ticket_task_links as link
          where link.organization_id = $1
            and link.external_ticket_id = any($2::uuid[])
       ) as ranked
      group by ranked.external_ticket_id`,
    [organizationId, ticketIds, MAX_LINKED_TASK_IDS],
  );
  return new Map(
    result.rows.map((row) => [
      row.external_ticket_id,
      { ids: row.task_ids, count: row.total },
    ]),
  );
}

/**
 * Open questions on the task of each ticket's nonterminal request (#61), by
 * ticket id: questions (not approvals) that are open and not past their
 * expiry, as `questions.list` reads an expired one. One statement per page,
 * scoped to the organization; a ticket with no nonterminal request has none.
 */
async function openQuestionsFor(
  transaction: PgTransactionClient,
  organizationId: string,
  requests: ReadonlyMap<string, TicketRequest>,
): Promise<Map<string, number>> {
  const ticketOfTask = new Map<string, string>();
  for (const [ticketId, request] of requests) {
    ticketOfTask.set(request.taskId, ticketId);
  }
  if (ticketOfTask.size === 0) return new Map();
  const result = await transaction.query<{ task_id: string; open: number }>(
    `select task_id, count(*)::integer as open
       from bakery.questions
      where organization_id = $1 and task_id = any($2::uuid[])
        and kind = 'question' and status = 'open'
        and (expires_at is null or expires_at > now())
      group by task_id`,
    [organizationId, [...ticketOfTask.keys()]],
  );
  return new Map(
    result.rows.map((row) => [ticketOfTask.get(row.task_id)!, row.open]),
  );
}

/** The ticket rows with the newest report and the nonterminal request each owns. */
async function projectTickets(
  transaction: PgTransactionClient,
  organizationId: string,
  rows: readonly TicketRowOut[],
): Promise<ExternalTicketOutput[]> {
  const ids = rows.map((row) => row.id);
  const reports = await latestReportsFor(transaction, organizationId, ids);
  const requests = await nonterminalRequestsFor(
    transaction,
    organizationId,
    ids,
  );
  const links = await linkedTasksFor(transaction, organizationId, ids);
  const questions = await openQuestionsFor(
    transaction,
    organizationId,
    requests,
  );
  const deliveries = await deliveryFor(transaction, organizationId, ids);
  return rows.map((row) => {
    const stored = reports.get(row.id);
    const linked = links.get(row.id);
    return {
      id: row.id,
      organizationId: row.organization_id,
      ticketSourceId: row.ticket_source_id,
      externalTicketId: row.external_ticket_id,
      key: row.key,
      number: row.number,
      safeUrl: row.safe_url,
      snapshot: row.snapshot,
      requirementsDigest: row.requirements_digest,
      providerUpdateMarker: row.provider_update_marker,
      visibility: row.visibility,
      state: row.state,
      lastObservedAt: row.last_observed_at.toISOString(),
      latestReadiness: stored === undefined ? null : {
        id: stored.id,
        version: stored.sequence,
        verdict: stored.report.verdict,
        checks: stored.report.checks,
        requirementsDigest: stored.report.requirementsDigest,
        dependencyDigest: stored.report.dependencyDigest,
        basisDigest: stored.report.basisDigest,
        sourcePolicyRevision: stored.report.sourcePolicyRevision,
        evaluatedAt: stored.evaluatedAt,
      },
      activeRequest: activeRequestOf(requests.get(row.id)),
      linkedTaskIds: linked?.ids ?? [],
      linkedTaskCount: linked?.count ?? 0,
      openQuestionCount: questions.get(row.id) ?? 0,
      delivery: deliveries.get(row.id) ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      version: row.version,
    } as ExternalTicketOutput;
  });
}

export function createExternalTicketsListHandler(secret: string) {
  return async (context: ActionContext, input: TicketQuery) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const binding: CursorBinding = {
      action: "externalTickets.list",
      principalId,
      organizationId,
      ordering: ORDERING,
      filters: JSON.stringify({
        sourceId: input.sourceId ?? null,
        state: input.state ?? null,
        linked: input.linked ?? null,
        taskId: input.taskId ?? null,
      }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<TicketRowOut>(
      `select ${TICKET_COLUMNS},
              to_char(ticket.created_at at time zone 'UTC', ${CURSOR_TIME})
                as cursor_created_at
         from bakery.external_tickets as ticket
        where ticket.organization_id = $1
          and ($2::uuid is null or ticket.ticket_source_id = $2::uuid)
          and ($3::text is null or ticket.state = $3::text)
          and ($4::boolean is null or $4::boolean = exists (
                select 1 from bakery.ticket_task_links as link
                 where link.organization_id = ticket.organization_id
                   and link.external_ticket_id = ticket.id))
          and ($5::uuid is null or exists (
                select 1 from bakery.ticket_task_links as link
                 where link.organization_id = ticket.organization_id
                   and link.external_ticket_id = ticket.id
                   and link.task_id = $5::uuid))
          and ($6::timestamptz is null
               or (ticket.created_at, ticket.id) < ($6::timestamptz, $7::uuid))
        order by ticket.created_at desc, ticket.id desc
        limit $8`,
      [
        organizationId,
        input.sourceId ?? null,
        input.state ?? null,
        input.linked ?? null,
        input.taskId ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    return {
      items: await projectTickets(
        transaction,
        organizationId,
        result.rows.slice(0, limit),
      ),
      nextCursor: await nextCursor(secret, binding, result.rows, limit),
    };
  };
}

export async function getExternalTicket(
  context: ActionContext,
): Promise<ExternalTicketOutput> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const result = await transaction.query<TicketRowOut>(
    `select ${TICKET_COLUMNS} from bakery.external_tickets as ticket
      where ticket.organization_id = $1 and ticket.id = $2`,
    [organizationId, routeId(context)],
  );
  if (!result.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return (await projectTickets(transaction, organizationId, result.rows))[0];
}

/** One `ticket_task_links` row as `LINK_COLUMNS` reads it. */
export type LinkRow = {
  id: string;
  external_ticket_id: string;
  task_id: string;
  role: LinkOutput["role"];
  status_comment_external_id: string | null;
  last_synced_run_revision: number | null;
  sync_health: LinkOutput["syncHealth"];
  last_problem_code: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  cursor_created_at?: string;
};

/** One link as the API shows it. */
export function toLinkOutput(
  organizationId: string,
  row: LinkRow,
): LinkOutput {
  return {
    id: row.id,
    organizationId,
    externalTicketId: row.external_ticket_id,
    taskId: row.task_id,
    role: row.role,
    statusCommentExternalId: row.status_comment_external_id,
    lastSyncedRunRevision: row.last_synced_run_revision,
    syncHealth: row.sync_health,
    lastProblemCode: row.last_problem_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  } as LinkOutput;
}

/** The columns `toLinkOutput` reads. */
export const LINK_COLUMNS = `id, external_ticket_id, task_id, role,
  status_comment_external_id, last_synced_run_revision, sync_health,
  last_problem_code, created_at, updated_at, version`;

/**
 * `ticketTaskLinks.list` (#69): the links of one ticket or of one task,
 * newest first, keyset paged. Exactly one side is named; a ticket or task the
 * organization does not hold answers `RESOURCE_NOT_FOUND`, as a missing one
 * would. Each link carries the sync health of Bakery's status note.
 */
export function createTicketTaskLinksListHandler(secret: string) {
  return async (context: ActionContext, input: LinkQuery) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const ticketId = input.externalTicketId ?? null;
    const taskId = input.taskId ?? null;
    if ((ticketId === null) === (taskId === null)) {
      throw unprocessable(
        ["externalTicketId"],
        "ticket_task_link_scope_required",
      );
    }
    const owner = ticketId === null
      ? await transaction.query(
        `select 1 from bakery.tasks where organization_id = $1 and id = $2`,
        [organizationId, taskId],
      )
      : await transaction.query(
        `select 1 from bakery.external_tickets
          where organization_id = $1 and id = $2`,
        [organizationId, ticketId],
      );
    if (owner.rows.length === 0) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const binding: CursorBinding = {
      action: "ticketTaskLinks.list",
      principalId,
      organizationId,
      ordering: ORDERING,
      filters: JSON.stringify({ ticketId, taskId, role: input.role ?? null }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<LinkRow>(
      `select ${LINK_COLUMNS},
              to_char(created_at at time zone 'UTC', ${CURSOR_TIME})
                as cursor_created_at
         from bakery.ticket_task_links
        where organization_id = $1
          and ($2::uuid is null or external_ticket_id = $2::uuid)
          and ($3::uuid is null or task_id = $3::uuid)
          and ($4::text is null or role = $4::text)
          and ($5::timestamptz is null
               or (created_at, id) < ($5::timestamptz, $6::uuid))
        order by created_at desc, id desc
        limit $7`,
      [
        organizationId,
        ticketId,
        taskId,
        input.role ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    return {
      items: result.rows.slice(0, limit).map((row) =>
        toLinkOutput(organizationId, row)
      ),
      nextCursor: await nextCursor(secret, binding, result.rows, limit),
    };
  };
}
