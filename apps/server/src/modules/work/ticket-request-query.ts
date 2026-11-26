import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  isLegacyPresetPin,
  isTicketRequestDisposition,
  TicketAuthorityEvidenceSchema,
  TicketPinSchema,
} from "@bakery/contracts/ticket-admission";
import { TICKET_PRESET_IDS } from "@bakery/contracts/workflow-presets";
import type { TicketPresetId } from "@bakery/contracts/ticket-admission";
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
  pinned_origin_kind: string | null;
  pinned_catalog_key: string | null;
  pinned_revision: number | null;
  run_status: string | null;
  stopped_by: string | null;
  stopped_by_name: string | null;
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
    pinned_workflow.origin_kind as pinned_origin_kind,
    pinned_workflow.origin_catalog_key as pinned_catalog_key,
    pinned_version.revision as pinned_revision,
    run.status as run_status, stop.principal_id as stopped_by,
    stop.display_name as stopped_by_name, request.created_at, request.updated_at,
    request.version,
    to_char(request.created_at at time zone 'UTC', ${CURSOR_TIME})
      as cursor_created_at
   from bakery.ticket_requests as request
   left join bakery.workflow_versions as pinned_version
     on pinned_version.organization_id = request.organization_id
    and pinned_version.id = (request.pinned_preset ->> 'versionId')::uuid
   left join bakery.workflow_definitions as pinned_workflow
     on pinned_workflow.organization_id = pinned_version.organization_id
    and pinned_workflow.id = pinned_version.workflow_id
   left join bakery.workflow_runs as run
     on run.organization_id = request.organization_id
    and run.id = request.workflow_run_id
   left join lateral (
     select audit.principal_id, who.display_name
       from bakery.audit_events as audit
       left join bakery.principals as who on who.id = audit.principal_id
      where (request.disposition = 'canceled' or run.status = 'canceled')
        and audit.organization_id = request.organization_id
        and (
          (audit.operation = 'ticketRequests.cancel'
            and audit.resource_type = 'ticket_request'
            and audit.resource_id = request.id::text)
          or (request.workflow_run_id is not null
            and audit.operation in ('runs.control', 'runs.control.agent')
            and audit.resource_type = 'workflow_run'
            and audit.resource_id = request.workflow_run_id::text
            and audit.details ->> 'action' = 'cancel'))
      order by audit.created_at desc, audit.id desc
      limit 1
   ) as stop on true`;

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

function shownBuiltIn(
  row: ViewRow,
): { presetId?: TicketPresetId; presetRevision?: number } {
  const builtIn = row.pinned_origin_kind === "catalog"
    ? TICKET_PRESET_IDS.find((id) => id === row.pinned_catalog_key)
    : undefined;
  return builtIn === undefined || row.pinned_revision === null
    ? {}
    : { presetId: builtIn, presetRevision: row.pinned_revision };
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
  const pinned = TicketPinSchema.parse(row.pinned_preset);
  const shown = isLegacyPresetPin(pinned)
    ? { presetId: pinned.id, presetRevision: pinned.revision }
    : shownBuiltIn(row);
  const progress = ticketRequestProgress(
    row.disposition,
    row.run_status,
    requestDeliveryVerdict(facts, row.run_status === "completed").delivered,
  );
  // Who stopped it: the person on the cancel's audit row (#61), read only for
  // a stopped request. Null for a run that ended canceled without a person.
  const stopped = progress === "canceled";
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
    progress,
    workflowRunId: row.workflow_run_id,
    stoppedByPrincipalId: stopped ? row.stopped_by : null,
    stoppedByName: stopped ? row.stopped_by_name : null,
    ...shown,
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
