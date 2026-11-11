import type { z } from "zod";
import { contractSchemas } from "@bakery/contracts/contracts";
import {
  AUDIT_COLUMNS,
  type AuditRow,
  toAuditEvent,
} from "../adapters/audit-events-postgres.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../../platform/cursor.ts";
import type { PgTransactionClient } from "../../../platform/database.ts";

/** Default events in one stream batch. */
export const DEFAULT_STREAM_BATCH_ROWS = 500;
/** Most events one stream batch returns. */
export const MAX_STREAM_BATCH_ROWS = 1_000;
/** Most JSON Lines bytes one stream batch returns before it is cut. */
export const MAX_STREAM_BATCH_BYTES = 1024 * 1024;
/**
 * Events younger than this are held back for a later batch. A transaction that
 * commits after a later row was read could otherwise land behind the cursor
 * and never be delivered; the lag is the documented bound on that window.
 */
export const STREAM_SETTLE_SECONDS = 30;

/** Input of one audit stream read: one organization, one resumable position. */
export type AuditStreamInput = Readonly<{
  action: string;
  principalId: string;
  organizationId: string;
  query: z.output<typeof contractSchemas.AuditStreamQuery>;
  secret: string;
  now?: Date;
}>;

/**
 * Oldest-first, resumable read of one organization's audit trail for an
 * external collector. Each line is the same redacted `AuditEvent` the in-app
 * list returns (shared column list and mapper). The cursor is signed and bound
 * to the caller, the organization and the filter set; a batch always returns a
 * cursor to resume from, so polling with it delivers each settled event once.
 */
export async function streamAuditEvents(
  transaction: Pick<PgTransactionClient, "query">,
  input: AuditStreamInput,
): Promise<z.output<typeof contractSchemas.AuditStreamBatch>> {
  const { query } = input;
  const now = input.now ?? new Date();
  const binding: CursorBinding = {
    action: input.action,
    principalId: input.principalId,
    organizationId: input.organizationId,
    ordering: "createdAt:asc,id:asc",
    filters: JSON.stringify({
      operation: query.operation ?? null,
      outcome: query.outcome ?? null,
    }),
    schemaVersion: 1,
  };
  const cursor = await decodeCursor(input.secret, query.cursor, binding);
  const limit = Math.min(
    query.limit ?? DEFAULT_STREAM_BATCH_ROWS,
    MAX_STREAM_BATCH_ROWS,
  );
  const settledBefore = new Date(now.getTime() - STREAM_SETTLE_SECONDS * 1000);
  const result = await transaction.query<AuditRow>(
    `select ${AUDIT_COLUMNS} from bakery.audit_events
     where organization_id = $1::uuid
       and created_at <= $2::timestamptz
       and ($3::text is null or operation = $3::text)
       and ($4::text is null or outcome = $4::text)
       and ($5::timestamptz is null
         or (created_at, id) > ($5::timestamptz, $6::uuid))
     order by created_at asc, id asc
     limit $7`,
    [
      input.organizationId,
      settledBefore,
      query.operation ?? null,
      query.outcome ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ],
  );
  const lines: string[] = [];
  let last: AuditRow | undefined;
  let bytes = 0;
  let more = result.rows.length > limit;
  const encoder = new TextEncoder();
  for (const row of result.rows.slice(0, limit)) {
    const line = JSON.stringify(toAuditEvent(row));
    const size = encoder.encode(line).byteLength + 1;
    if (lines.length > 0 && bytes + size > MAX_STREAM_BATCH_BYTES) {
      more = true;
      break;
    }
    bytes += size;
    lines.push(line);
    last = row;
  }
  const nextCursor = last
    ? await encodeCursor(input.secret, binding, {
      createdAt: last.cursorCreatedAt,
      id: last.id,
    })
    : query.cursor ?? null;
  return {
    contentType: "application/x-ndjson",
    lineCount: lines.length,
    content: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    nextCursor,
    caughtUp: !more,
    settledBefore: settledBefore.toISOString(),
  };
}
