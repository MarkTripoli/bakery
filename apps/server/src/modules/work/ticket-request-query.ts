import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  isTicketRequestDisposition,
  TicketAuthorityEvidenceSchema,
  TicketPresetPinSchema,
} from "@bakery/contracts/ticket-admission";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  readRequestDeliveryFacts,
  type RequestDeliveryFacts,
  requestDeliveryVerdict,
} from "./ticket-delivery-store.ts";
import {
  dispositionReasonCode,
  pausedReason,
  ticketRequestProgress,
} from "./ticket-request-state.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

/**
 * `ticketRequests.list` and `ticketRequests.get` (#69): the start requests
 * of a ticket as its history shows them. Every statement names
 * `organization_id`, so another organization's ticket or request answers 404
 * exactly as a missing one. The progress, reason code and pause reason are
 * computed by the pure functions of `ticket-request-state.ts`.
 */

type ViewOutput = z.output<typeof contractSchemas.TicketRequestView>;
type RequestQuery = z.output<typeof contractSchemas.TicketRequestQuery>;

const ORDERING = "createdAt:desc,id:desc";
const CURSOR_TIME = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

type ViewRow = {
  id: string;
  external_ticket_id: string;
  ticket_task_link_id: string;
  intent: string;
  origin: string;
  authority_principal_id: string | null;
  authority_evidence: unknown;
  disposition: string;
  disposition_reason: string | null;
  pause_requested_at: Date | null;
  workflow_run_id: string | null;
  pinned_preset: unknown;
  run_status: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  cursor_created_at: string;
};

const VIEW_SELECT = `select request.id, request.external_ticket_id,
    request.ticket_task_link_id, request.intent, request.origin,
    request.authority_principal_id, request.authority_evidence,
    request.disposition, request.disposition_reason,
    request.pause_requested_at, request.workflow_run_id, request.pinned_preset,
    run.status as run_status, request.created_at, request.updated_at,
    request.version,
    to_char(request.created_at at time zone 'UTC', ${CURSOR_TIME})
      as cursor_created_at
   from bakery.ticket_requests as request
   left join bakery.workflow_runs as run
     on run.organization_id = request.organization_id
    and run.id = request.workflow_run_id`;

type TargetRow = {
  ticket_request_id: string;
  repository_id: string;
  role: string;
  routing_rule_id: string | null;
  routing_rule_version: number | null;
  child_task_id: string | null;
};

async function targetsFor(
  transaction: PgTransactionClient,
  organizationId: string,
  requestIds: readonly string[],
): Promise<Map<string, ViewOutput["targets"]>> {
  const result = await transaction.query<TargetRow>(
    `select ticket_request_id, repository_id, role, routing_rule_id,
            routing_rule_version, child_task_id
       from bakery.ticket_request_targets
      where organization_id = $1 and ticket_request_id = any($2::uuid[])
      order by ticket_request_id, role, repository_id`,
    [organizationId, requestIds],
  );
  const targets = new Map<string, ViewOutput["targets"]>();
  for (const row of result.rows) {
    const list = targets.get(row.ticket_request_id) ?? [];
    list.push({
      repositoryId: row.repository_id,
      role: row.role,
      routingRuleId: row.routing_rule_id,
      routingRuleVersion: row.routing_rule_version,
      childTaskId: row.child_task_id,
    });
    targets.set(row.ticket_request_id, list);
  }
  return targets;
}

/** The label of a label-based start, from the evidence fixed at admission. */
function triggerLabelName(row: ViewRow): string | null {
  if (row.origin === "manual") return null;
  const evidence = TicketAuthorityEvidenceSchema.safeParse(
    row.authority_evidence,
  );
  return evidence.success ? evidence.data.labelName ?? null : null;
}

function toView(
  row: ViewRow,
  targets: ViewOutput["targets"] | undefined,
  facts: RequestDeliveryFacts | undefined,
): ViewOutput {
  if (!isTicketRequestDisposition(row.disposition)) {
    throw new Error("TICKET_REQUEST_ROW_INVALID");
  }
  const manual = row.origin === "manual" || row.origin === "adoption";
  const preset = TicketPresetPinSchema.parse(row.pinned_preset);
  return {
    id: row.id,
    externalTicketId: row.external_ticket_id,
    ticketTaskLinkId: row.ticket_task_link_id,
    intent: row.intent,
    origin: row.origin,
    requestedByPrincipalId: manual ? row.authority_principal_id : null,
    triggerLabelName: triggerLabelName(row),
    disposition: row.disposition,
    dispositionReasonCode: dispositionReasonCode(row.disposition_reason),
    pausedAt: row.pause_requested_at?.toISOString() ?? null,
    pausedReason: pausedReason(row.pause_requested_at, row.disposition_reason),
    progress: ticketRequestProgress(
      row.disposition,
      row.run_status,
      requestDeliveryVerdict(facts, row.run_status === "completed").delivered,
    ),
    workflowRunId: row.workflow_run_id,
    presetId: preset.id,
    presetRevision: preset.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
    targets: targets ?? [],
  } as ViewOutput;
}

async function project(
  transaction: PgTransactionClient,
  organizationId: string,
  rows: readonly ViewRow[],
): Promise<ViewOutput[]> {
  const ids = rows.map((row) => row.id);
  const targets = await targetsFor(transaction, organizationId, ids);
  const facts = await readRequestDeliveryFacts(
    transaction,
    organizationId,
    ids,
  );
  return rows.map((row) => toView(row, targets.get(row.id), facts.get(row.id)));
}

/** `ticketRequests.list`: one ticket's requests, newest first, keyset paged. */
export function createTicketRequestsListHandler(secret: string) {
  return async (context: ActionContext, input: RequestQuery) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const ticketId = input.externalTicketId;
    const owner = await transaction.query(
      `select 1 from bakery.external_tickets
        where organization_id = $1 and id = $2`,
      [organizationId, ticketId],
    );
    if (owner.rows.length === 0) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const binding: CursorBinding = {
      action: "ticketRequests.list",
      principalId,
      organizationId,
      ordering: ORDERING,
      filters: JSON.stringify({ ticketId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(secret, input.cursor, binding);
    const limit = input.limit ?? 25;
    const result = await transaction.query<ViewRow>(
      `${VIEW_SELECT}
        where request.organization_id = $1
          and request.external_ticket_id = $2
          and ($3::timestamptz is null
               or (request.created_at, request.id) < ($3::timestamptz, $4::uuid))
        order by request.created_at desc, request.id desc
        limit $5`,
      [
        organizationId,
        ticketId,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    const last = result.rows[limit - 1];
    return {
      items: await project(
        transaction,
        organizationId,
        result.rows.slice(0, limit),
      ),
      nextCursor: result.rows.length > limit && last
        ? await encodeCursor(secret, binding, {
          createdAt: last.cursor_created_at,
          id: last.id,
        })
        : null,
    };
  };
}

/** `ticketRequests.get`: one request; a missing or foreign id is 404. */
export async function getTicketRequest(
  context: ActionContext,
): Promise<ViewOutput> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const result = await transaction.query<ViewRow>(
    `${VIEW_SELECT}
      where request.organization_id = $1 and request.id = $2`,
    [organizationId, id],
  );
  if (!result.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return (await project(transaction, organizationId, result.rows))[0];
}
