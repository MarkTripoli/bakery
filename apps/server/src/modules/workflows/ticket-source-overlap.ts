import { unprocessable } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";

export const TICKET_SOURCE_STARTS_OVERLAP =
  "ticket_source_workflow_starts_overlap";

export const TICKET_ADMISSION_EVENT_KINDS: ReadonlySet<string> = new Set([
  "work_item.opened",
  "work_item.edited",
  "work_item.reopened",
  "work_item.labeled",
  "work_item.unlabeled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function startsOverlapAdmission(starts: unknown): boolean {
  return Array.isArray(starts) &&
    starts.some((start) =>
      isRecord(start) && isRecord(start.on) && start.on.kind === "event" &&
      typeof start.on.eventKind === "string" &&
      TICKET_ADMISSION_EVENT_KINDS.has(start.on.eventKind)
    );
}

export async function assertNoAutomaticSourceAdmits(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
  starts: unknown,
): Promise<void> {
  if (!startsOverlapAdmission(starts)) return;
  const named = await transaction.query(
    `select 1 from bakery.ticket_sources
      where organization_id = $1 and enabled
        and (policy -> 'automatic' ->> 'enabled')::boolean
        and policy -> 'workflow' ->> 'workflowId' = $2
      limit 1`,
    [organizationId, workflowId],
  );
  if (named.rows.length > 0) {
    throw unprocessable(["starts"], TICKET_SOURCE_STARTS_OVERLAP);
  }
}

export async function assertStartsLeaveAdmission(
  transaction: PgTransactionClient,
  organizationId: string,
  workflowId: string,
): Promise<void> {
  const active = await transaction.query<{ starts: unknown }>(
    `select version.starts
       from bakery.workflow_definitions definition
       join bakery.workflow_versions version
         on version.organization_id = definition.organization_id
        and version.id = definition.active_version_id
      where definition.organization_id = $1 and definition.id = $2
      for share of definition`,
    [organizationId, workflowId],
  );
  if (startsOverlapAdmission(active.rows[0]?.starts)) {
    throw unprocessable(
      ["policy", "workflow", "workflowId"],
      TICKET_SOURCE_STARTS_OVERLAP,
    );
  }
}
