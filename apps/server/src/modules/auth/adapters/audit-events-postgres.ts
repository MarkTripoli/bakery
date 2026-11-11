import type { z } from "zod";
import { contractSchemas } from "@bakery/contracts/contracts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../../platform/cursor.ts";
import type { PgTransactionClient } from "../../../platform/database.ts";

/** Listing window applied when the caller names no lower bound. */
export const DEFAULT_AUDIT_WINDOW_DAYS = 90;

export type AuditRow = {
  id: string;
  organizationId: string | null;
  principalId: string | null;
  operation: string;
  resourceType: string;
  resourceId: string;
  outcome: string;
  requestId: string;
  traceId: string;
  details: unknown;
  createdAt: Date;
  cursorCreatedAt: string;
};

export type AuditScope =
  | { kind: "organization"; organizationId: string }
  | { kind: "installation" };

/** Column list that selects an `AuditRow`; shared by the list and the paid export. */
export const AUDIT_COLUMNS = `id, organization_id as "organizationId",
  principal_id as "principalId", operation, resource_type as "resourceType",
  resource_id as "resourceId", outcome, request_id as "requestId",
  trace_id as "traceId", details, created_at as "createdAt",
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorCreatedAt"`;

/** Parses one stored row into the redacted `AuditEvent` contract shape. */
export function toAuditEvent(row: AuditRow) {
  return contractSchemas.AuditEvent.parse({
    id: row.id,
    organizationId: row.organizationId,
    principalId: row.principalId,
    operation: row.operation,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    outcome: row.outcome,
    requestId: row.requestId,
    traceId: row.traceId,
    details: row.details,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Newest-first page of audit rows for one scope: an organization's rows, or the
 * installation-level rows that carry no organization. Filters and the keyset
 * cursor bind to the caller, the scope and the filter set, so a cursor from
 * another scope or filter fails closed.
 */
export async function listAuditEvents(
  transaction: PgTransactionClient,
  input: {
    action: string;
    principalId: string;
    scope: AuditScope;
    query: z.output<typeof contractSchemas.AuditQuery>;
    secret: string;
    now?: Date;
  },
) {
  const { query, scope } = input;
  const since = query.since ??
    new Date(
      (input.now ?? new Date()).getTime() -
        DEFAULT_AUDIT_WINDOW_DAYS * 86_400_000,
    ).toISOString();
  const filters = JSON.stringify({
    principalId: query.principalId ?? null,
    operation: query.operation ?? null,
    outcome: query.outcome ?? null,
    since: query.since ?? null,
    until: query.until ?? null,
  });
  const binding: CursorBinding = {
    action: input.action,
    principalId: input.principalId,
    ...(scope.kind === "organization"
      ? { organizationId: scope.organizationId }
      : {}),
    ordering: "createdAt:desc,id:desc",
    filters,
    schemaVersion: 1,
  };
  const cursor = await decodeCursor(input.secret, query.cursor, binding);
  const limit = query.limit ?? 25;
  const result = await transaction.query<AuditRow>(
    `select ${AUDIT_COLUMNS} from bakery.audit_events
     where ${
      scope.kind === "organization"
        ? "organization_id = $1::uuid"
        : "organization_id is null and $1::uuid is null"
    }
       and created_at >= $2::timestamptz
       and ($3::timestamptz is null or created_at <= $3::timestamptz)
       and ($4::uuid is null or principal_id = $4::uuid)
       and ($5::text is null or operation = $5::text)
       and ($6::text is null or outcome = $6::text)
       and ($7::timestamptz is null
         or (created_at, id) < ($7::timestamptz, $8::uuid))
     order by created_at desc, id desc limit $9`,
    [
      scope.kind === "organization" ? scope.organizationId : null,
      since,
      query.until ?? null,
      query.principalId ?? null,
      query.operation ?? null,
      query.outcome ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const page = result.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toAuditEvent),
    nextCursor: result.rows.length > limit && last
      ? await encodeCursor(input.secret, binding, {
        createdAt: last.cursorCreatedAt,
        id: last.id,
      })
      : null,
  };
}
