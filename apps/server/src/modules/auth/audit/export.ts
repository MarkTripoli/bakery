import type { z } from "zod";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  AUDIT_COLUMNS,
  type AuditRow,
  toAuditEvent,
} from "../adapters/audit-events-postgres.ts";
import type { PgTransactionClient } from "../../../platform/database.ts";

/** Widest window one export may span. */
export const MAX_EXPORT_WINDOW_DAYS = 366;
/** Most events one export returns; a larger match is reported as truncated. */
export const MAX_EXPORT_ROWS = 10_000;
/** Most JSON Lines bytes one export returns before it is cut and flagged. */
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

const DAY_MS = 86_400_000;

/** Input of the audit export: one organization, a bounded window. */
export type AuditExportInput = Readonly<{
  organizationId: string;
  query: z.output<typeof contractSchemas.AuditExportQuery>;
  now?: Date;
}>;

function instant(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return date;
}

function filename(since: Date, until: Date, operation?: string): string {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const scope = operation
    ? `-${operation.replaceAll(/[^A-Za-z0-9.]/g, "_")}`
    : "";
  return `audit-events-${day(since)}-${day(until)}${scope}.jsonl`;
}

/**
 * Bounded JSON Lines export of one organization's audit trail, oldest first.
 * Each line is the same redacted `AuditEvent` the list returns (shared column
 * list and mapper), so the export can never carry more than the in-app trail.
 * Cut by row count and byte budget; a cut is reported through `truncated`.
 */
export async function exportAuditEvents(
  transaction: Pick<PgTransactionClient, "query">,
  input: AuditExportInput,
): Promise<z.output<typeof contractSchemas.AuditExport>> {
  const now = input.now ?? new Date();
  const since = instant(input.query.since);
  const until = instant(input.query.until ?? now.toISOString());
  if (
    until.getTime() < since.getTime() ||
    until.getTime() - since.getTime() > MAX_EXPORT_WINDOW_DAYS * DAY_MS
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const result = await transaction.query<AuditRow>(
    `select ${AUDIT_COLUMNS} from bakery.audit_events
     where organization_id = $1::uuid
       and created_at >= $2::timestamptz and created_at <= $3::timestamptz
       and ($4::text is null or operation = $4::text)
       and ($5::text is null or outcome = $5::text)
     order by created_at asc, id asc
     limit $6`,
    [
      input.organizationId,
      since,
      until,
      input.query.operation ?? null,
      input.query.outcome ?? null,
      MAX_EXPORT_ROWS + 1,
    ],
  );
  const lines: string[] = [];
  let bytes = 0;
  let truncated = result.rows.length > MAX_EXPORT_ROWS;
  for (const row of result.rows.slice(0, MAX_EXPORT_ROWS)) {
    const line = JSON.stringify(toAuditEvent(row));
    bytes += new TextEncoder().encode(line).byteLength + 1;
    if (bytes > MAX_EXPORT_BYTES) {
      truncated = true;
      break;
    }
    lines.push(line);
  }
  return {
    filename: filename(since, until, input.query.operation),
    contentType: "application/x-ndjson",
    lineCount: lines.length,
    truncated,
    content: lines.length > 0 ? `${lines.join("\n")}\n` : "",
  };
}
