import {
  type ActionContext,
  type CommandRunner,
  type EncodedSuccessResponse,
  type NormalizedCommandMetadata,
  type StableResponseHeaders,
} from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import { canonicalJson, sha256Hex } from "./canonical-json.ts";
import type { PgTransactionClient } from "./database.ts";

/**
 * Versioned digest of the exact request semantics the replay scope protects.
 * Excludes cookies, tokens, request/trace ids, deadlines, and transport framing.
 */
export function commandFingerprint(options: {
  metadata: Pick<
    NormalizedCommandMetadata,
    "operation" | "target" | "expectedVersion"
  >;
  input: unknown;
}): Promise<string> {
  return sha256Hex(canonicalJson({
    version: 1,
    operation: options.metadata.operation,
    target: options.metadata.target,
    input: options.input,
    ifMatch: options.metadata.expectedVersion ?? null,
  }));
}

/** Advisory-lock identity derived from the full replay scope, not the digest. */
export function idempotencyLockKey(options: {
  scope: "organization" | "installation";
  organizationId: string | null;
  principalId: string;
  operation: string;
  key: string;
}): string {
  return [
    options.scope,
    options.organizationId ?? "",
    options.principalId,
    options.operation,
    options.key,
  ].join("\u001f");
}
/** Completed command receipts remain replayable for a 24-hour idempotency window. */
const IDEMPOTENCY_TTL_SQL = "interval '24 hours'";
type IdempotencyRow = {
  request_digest: string;
  response_status: number | null;
  response_body: string | null;
  response_headers: unknown;
};

type ReplayScope = {
  transaction: PgTransactionClient;
  scope: "organization" | "installation";
  organizationId: string | null;
  principalId: string;
};

function requireReplayScope(context: ActionContext): ReplayScope {
  const authorized = context as ActionContext & {
    authority?: unknown;
    transaction?: PgTransactionClient;
  };
  const authority = authorized.authority;
  const authorityRecord = authority && typeof authority === "object"
    ? authority as Record<string, unknown>
    : undefined;
  const subject = authorityRecord && "subject" in authorityRecord
    ? authorityRecord.subject
    : authority ?? context.principal;
  const subjectRecord = subject && typeof subject === "object"
    ? subject as Record<string, unknown>
    : undefined;
  const principalId = subjectRecord?.principalId;
  const organizationId = authorityRecord?.organizationId;
  if (
    !authorized.transaction ||
    typeof principalId !== "string" ||
    (organizationId !== undefined && typeof organizationId !== "string")
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return {
    transaction: authorized.transaction,
    scope: organizationId === undefined ? "installation" : "organization",
    organizationId: organizationId === undefined ? null : organizationId,
    principalId,
  };
}

function decodeEnvelope(row: IdempotencyRow): EncodedSuccessResponse {
  if (
    typeof row.response_status !== "number" ||
    typeof row.response_body !== "string" ||
    row.response_headers === null ||
    typeof row.response_headers !== "object" ||
    Array.isArray(row.response_headers)
  ) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  return {
    status: row.response_status,
    body: new TextEncoder().encode(row.response_body),
    headers: row.response_headers as StableResponseHeaders,
    replayed: true,
  };
}

/** Short transaction-owned completed receipt probe; uses the normal command semantics. */
export async function readCompletedCommandReplay(options: {
  context: ActionContext;
  input: unknown;
  metadata: NormalizedCommandMetadata;
}): Promise<EncodedSuccessResponse | undefined> {
  const { context, input, metadata } = options;
  const { transaction, scope: replayScope, organizationId, principalId } =
    requireReplayScope(context);
  const scope = {
    scope: replayScope,
    organizationId,
    principalId,
    operation: metadata.operation,
    key: metadata.idempotencyKey,
  };
  const lock = await transaction.query<{ locked: boolean }>(
    "select pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) as locked",
    [idempotencyLockKey(scope)],
  );
  if (lock.rows[0]?.locked !== true) {
    throw new StandardError({ code: "IDEMPOTENCY_IN_FLIGHT" });
  }
  const digest = await commandFingerprint({ metadata, input });
  const existing = await transaction.query<IdempotencyRow>(
    `select request_digest, response_status, response_body,
            response_headers
         from bakery.idempotency_records
         where scope = $1 and organization_id is not distinct from $2
           and principal_id = $3 and operation = $4 and key = $5
           and expires_at > current_timestamp`,
    [
      replayScope,
      organizationId,
      principalId,
      metadata.operation,
      metadata.idempotencyKey,
    ],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.request_digest !== digest) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    return decodeEnvelope(row);
  }
  return undefined;
}

/**
 * One injected command runner owns the transaction-scoped advisory lock, the
 * fingerprint comparison, and the stored-response lifecycle. It reuses the
 * authority transaction so replay, mutation, audit, event, outbox, and the
 * completed idempotency row commit together.
 */
export function createPostgresCommandRunner(): CommandRunner {
  return {
    async run(request) {
      const { context, input, metadata, invokeAndEncode } = request;
      const {
        transaction,
        scope: replayScope,
        organizationId,
        principalId,
      } = requireReplayScope(context);
      const replay = await readCompletedCommandReplay({
        context,
        input,
        metadata,
      });
      if (replay) return replay;
      const digest = await commandFingerprint({ metadata, input });
      const handlerContext = Object.assign({}, context, {
        commandMetadata: metadata,
      }) as ActionContext;
      const encoded = await invokeAndEncode(handlerContext);
      const body = new TextDecoder().decode(encoded.body);
      const refreshed = await transaction.query<{ id: string }>(
        `insert into bakery.idempotency_records as record (
           scope, organization_id, principal_id, operation, key,
           request_digest, status, response_status, response_body,
           response_headers, expires_at
         ) values (
           $1, $2, $3, $4, $5, $6, 'completed', $7, $8, $9::jsonb,
           now() + ${IDEMPOTENCY_TTL_SQL}
         )
         on conflict on constraint idempotency_records_scope_unique
         do update set
           request_digest = excluded.request_digest,
           status = excluded.status,
           response_status = excluded.response_status,
           response_body = excluded.response_body,
           response_headers = excluded.response_headers,
           updated_at = current_timestamp,
           expires_at = excluded.expires_at
         where record.expires_at <= current_timestamp
         returning record.id`,
        [
          replayScope,
          organizationId,
          principalId,
          metadata.operation,
          metadata.idempotencyKey,
          digest,
          encoded.status,
          body,
          JSON.stringify(encoded.headers),
        ],
      );
      if (refreshed.rows.length !== 1) {
        throw new Error("IDEMPOTENCY_RECORD_REFRESH_FAILED");
      }
      return encoded;
    },
  };
}
