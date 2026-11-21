import { type Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { contractSchemas } from "@bakery/contracts/contracts";
import { appendAudit } from "@bakery/persistence/event-audit";
import type { AuthVariables } from "../auth/middleware.ts";
import { spendRateLimitAttempt } from "../auth/adapters/rate-limit-postgres.ts";
import { jsonResponse, parseContract } from "./http.ts";
import { machineTransaction, noStoreJsonResponse } from "./machines.ts";
import {
  deviceSecretHash,
  isHostname,
  isSupportedSystem,
  linkCodeHash,
  mintShortCode,
  normalizeShortCode,
  reportedOs,
  SUPPORTED_WORKER_SYSTEMS,
  userCodeHash,
} from "./link-codes.ts";
import {
  ENROLLMENT_TTL_MS,
  type ExecutionRouteOptions,
  iso,
  normalizeArchitecture,
  normalizeCapabilities,
  parseIdempotencyKey,
  type PgTransactionClient,
  randomSecret,
  requestDigest,
  requestMetadata,
  sha256Hex,
  withPgTransaction,
} from "./shared.ts";

/**
 * The one-paste machine link (#70): inspecting a link code before the machine
 * asks its one question, and the link request a machine with no code makes
 * for an Admin to approve. A link code names an existing enrollment row by its
 * hash; the worker still mints its own long-lived credential when it
 * registers (`registration.ts`), which is the only thing that uses a code up.
 */

const TEN_MINUTES_MS = 10 * 60 * 1000;
const LINK_REQUEST_TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_SECONDS = 5;
/** Per source: one person retrying is far below these; a guesser is not. */
const INSPECT_PER_SOURCE = { max: 30, windowMs: TEN_MINUTES_MS };
const INSPECT_PER_CODE = { max: 10, windowMs: TEN_MINUTES_MS };
const CREATE_PER_SOURCE = { max: 10, windowMs: TEN_MINUTES_MS };
/** A terminal polls every five seconds for ten minutes: 120 polls. */
const POLL_PER_SOURCE = { max: 240, windowMs: TEN_MINUTES_MS };
const LOOKUP_PER_PRINCIPAL = { max: 30, windowMs: TEN_MINUTES_MS };
const LOOKUP_PER_CODE = { max: 10, windowMs: TEN_MINUTES_MS };
export const REGISTER_LINK_PER_SOURCE = { max: 20, windowMs: TEN_MINUTES_MS };

const RATE_LIMIT_PREFIX = "bakery:worker-link";

export type LinkRefusalReason = "not_found" | "expired" | "used" | "declined";

/** Unknown is a 404, the rest a 409; each names its reason and nothing about the organization. */
export function linkRefusal(reason: LinkRefusalReason): StandardError {
  return new StandardError({
    code: reason === "not_found" ? "RESOURCE_NOT_FOUND" : "STATE_CONFLICT",
    params: { reason },
  });
}

/** The peer address the server saw, never a forwarded header a caller can write. */
export function requestSource(context: Context): string {
  const peer = (context.env as { remoteAddr?: Deno.Addr } | undefined)
    ?.remoteAddr;
  return peer?.transport === "tcp" ? peer.hostname : "unknown";
}

/** Spends one attempt before any lookup, so a failed guess counts. */
export async function spendLinkAttempt(
  options: ExecutionRouteOptions,
  key: string,
  rule: { max: number; windowMs: number },
): Promise<void> {
  const retryAfterSeconds = await spendRateLimitAttempt(
    options.database,
    `${RATE_LIMIT_PREFIX}:${key}`,
    rule,
    Date.now(),
  );
  if (retryAfterSeconds !== undefined) {
    throw new StandardError({
      code: "RATE_LIMITED",
      params: { retryAfterSeconds },
    });
  }
}

function reportedSystem(input: { os: string; architecture: string }): {
  os: "linux" | "macos" | null;
  architecture: string;
  supported: boolean;
} {
  const os = reportedOs(input.os);
  const architecture = normalizeArchitecture(input.architecture);
  if (!/^[a-z0-9_]{1,100}$/.test(architecture)) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "architecture" },
    });
  }
  return { os, architecture, supported: isSupportedSystem(os, architecture) };
}

function checkedHostname(value: string): string {
  const hostname = value.trim();
  if (!isHostname(hostname)) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "hostname" },
    });
  }
  return hostname;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ? value as string[]
    : [];
}

/** `POST /v1/worker/link-code-inspection`: what a link code would do, before the machine asks. */
export async function inspectLinkCode(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const input = await parseContract(
    context,
    contractSchemas.WorkerLinkCodeInspect,
  );
  await spendLinkAttempt(
    options,
    `inspect:source:${requestSource(context)}`,
    INSPECT_PER_SOURCE,
  );
  const code = normalizeShortCode(input.linkCode);
  if (code === null) throw linkRefusal("not_found");
  const hash = await linkCodeHash(code);
  await spendLinkAttempt(options, `inspect:code:${hash}`, INSPECT_PER_CODE);
  const system = reportedSystem(input);
  const hostname = checkedHostname(input.hostname);
  const metadata = requestMetadata(context);
  return await withPgTransaction(options.database, async (transaction) => {
    const rows = await transaction.query<{
      id: string;
      organization_id: string;
      principal_id: string;
      name: string | null;
      os: string | null;
      architecture: string | null;
      allowed_capabilities: unknown;
      slots: number;
      expires_at: Date;
      consumed_at: Date | null;
      canceled_at: Date | null;
      organization_name: string;
      now: Date;
    }>(
      `select e.id, e.organization_id, e.principal_id, e.name, e.os,
              e.architecture, e.allowed_capabilities, e.slots, e.expires_at,
              e.consumed_at, e.canceled_at, o.name as organization_name,
              clock_timestamp() as now
       from bakery.worker_enrollments e
       join bakery.organizations o on o.id = e.organization_id
       where e.link_code_hash = $1`,
      [hash],
    );
    const row = rows.rows[0];
    if (!row) throw linkRefusal("not_found");
    if (row.consumed_at) throw linkRefusal("used");
    // Canceled means the Admin made a new command: this one stopped working.
    if (row.canceled_at || row.expires_at <= row.now) {
      throw linkRefusal("expired");
    }
    const supported = system.supported &&
      (row.os === null || row.os === system.os) &&
      (row.architecture === null ||
        normalizeArchitecture(row.architecture) === system.architecture);
    await appendAudit(transaction, {
      organizationId: row.organization_id,
      principalId: row.principal_id,
      operation: "worker.inspectLinkCode",
      resourceType: "worker_enrollment",
      resourceId: row.id,
      requestId: metadata.requestId,
      traceId: metadata.traceId,
      details: {
        supported,
        os: system.os,
        architecture: system.architecture,
      },
    });
    const projection = contractSchemas.WorkerLinkCodeInspection.parse({
      organizationName: row.organization_name,
      name: row.name ?? hostname,
      slots: row.slots,
      capabilities: stringList(row.allowed_capabilities),
      supported,
      supportedSystems: SUPPORTED_WORKER_SYSTEMS.map((entry) => ({
        os: entry.os,
        architecture: entry.architecture,
      })),
      expiresAt: iso(row.expires_at),
    });
    return noStoreJsonResponse(projection, 200);
  }, context.req.raw.signal);
}

/** `POST /v1/worker/link-requests`: a machine with no code asks to be linked. Grants nothing. */
export async function createLinkRequest(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const input = await parseContract(
    context,
    contractSchemas.WorkerLinkRequestCreate,
  );
  await spendLinkAttempt(
    options,
    `create:source:${requestSource(context)}`,
    CREATE_PER_SOURCE,
  );
  const system = reportedSystem(input);
  const hostname = checkedHostname(input.hostname);
  const deviceSecret = randomSecret();
  const secretHash = await deviceSecretHash(deviceSecret);
  return await withPgTransaction(options.database, async (transaction) => {
    // A user code is unique among stored requests; a collision just draws again.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const userCode = mintShortCode();
      const inserted = await transaction.query<
        { id: string; expires_at: Date }
      >(
        `insert into bakery.worker_link_requests (
           user_code_hash, device_secret_hash, hostname, os, architecture,
           supported, expires_at
         ) values ($1, $2, $3, $4, $5, $6,
           clock_timestamp() + ($7::integer * interval '1 second'))
         on conflict (user_code_hash) do nothing
         returning id, expires_at`,
        [
          await userCodeHash(userCode),
          secretHash,
          hostname,
          system.os ?? input.os.trim().toLowerCase().slice(0, 50),
          system.architecture,
          system.supported,
          LINK_REQUEST_TTL_SECONDS,
        ],
      );
      const row = inserted.rows[0];
      if (!row) continue;
      const created = contractSchemas.WorkerLinkRequestCreated.parse({
        requestId: row.id,
        userCode,
        deviceSecret,
        expiresAt: iso(row.expires_at),
        pollIntervalSeconds: POLL_INTERVAL_SECONDS,
      });
      return noStoreJsonResponse(created, 201);
    }
    throw new Error("WORKER_LINK_REQUEST_CODE_EXHAUSTED");
  }, context.req.raw.signal);
}

type LinkRequestRow = {
  id: string;
  device_secret_hash: string;
  hostname: string;
  os: string;
  architecture: string;
  supported: boolean;
  created_at: Date;
  expires_at: Date;
  organization_id: string | null;
  decision: string | null;
  decided_at: Date | null;
  decided_by: string | null;
  decision_idempotency_key: string | null;
  decision_request_digest: string | null;
  enrollment_id: string | null;
  worker_host_id: string | null;
  enrollment_principal_id: string | null;
  enrollment_expires_at: Date | null;
  enrollment_consumed_at: Date | null;
  enrollment_canceled_at: Date | null;
  now: Date;
};

const LINK_REQUEST_COLUMNS = `r.id, r.device_secret_hash, r.hostname, r.os,
  r.architecture, r.supported, r.created_at, r.expires_at, r.organization_id,
  r.decision, r.decided_at, r.decided_by, r.decision_idempotency_key,
  r.decision_request_digest, r.enrollment_id,
  e.worker_host_id, e.principal_id as enrollment_principal_id,
  e.expires_at as enrollment_expires_at,
  e.consumed_at as enrollment_consumed_at,
  e.canceled_at as enrollment_canceled_at,
  clock_timestamp() as now`;

async function loadLinkRequest(
  transaction: PgTransactionClient,
  where: string,
  value: string,
): Promise<LinkRequestRow | undefined> {
  const rows = await transaction.query<LinkRequestRow>(
    `select ${LINK_REQUEST_COLUMNS}
     from bakery.worker_link_requests r
     left join bakery.worker_enrollments e
       on e.organization_id = r.organization_id and e.id = r.enrollment_id
     where ${where} = $1
     for update of r`,
    [value],
  );
  return rows.rows[0];
}

function requestState(
  row: LinkRequestRow,
): "pending" | "approved" | "declined" | "expired" {
  if (row.decision === "approved") return "approved";
  if (row.decision === "declined") return "declined";
  return row.expires_at <= row.now ? "expired" : "pending";
}

function linkRequestProjection(row: LinkRequestRow, userCode: string | null) {
  return contractSchemas.WorkerLinkRequest.parse({
    id: row.id,
    userCode,
    hostname: row.hostname,
    os: row.os,
    architecture: row.architecture,
    supported: row.supported,
    state: requestState(row),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    decidedBy: row.decided_by,
    enrollmentId: row.enrollment_id,
    workerHostId: row.worker_host_id,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `POST /v1/worker/link-requests/{requestId}/polls`: the waiting terminal asks
 * where its request stands. Only the request whose device secret matches is
 * answered; an approval mints a fresh link code bound to the approved
 * settings, replacing any earlier one, so the code never sits in storage.
 */
export async function pollLinkRequest(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const requestId = context.req.param("requestId") ?? "";
  const input = await parseContract(
    context,
    contractSchemas.WorkerLinkRequestPoll,
  );
  await spendLinkAttempt(
    options,
    `poll:source:${requestSource(context)}`,
    POLL_PER_SOURCE,
  );
  if (!UUID.test(requestId)) throw linkRefusal("not_found");
  const secretHash = await deviceSecretHash(input.deviceSecret);
  const metadata = requestMetadata(context);
  return await withPgTransaction(options.database, async (transaction) => {
    const row = await loadLinkRequest(transaction, "r.id", requestId);
    if (!row || row.device_secret_hash !== secretHash) {
      throw linkRefusal("not_found");
    }
    const state = requestState(row);
    if (state !== "approved") {
      return noStoreJsonResponse(
        contractSchemas.WorkerLinkRequestPollResult.parse({ state }),
        200,
      );
    }
    if (row.enrollment_consumed_at) {
      // The machine registered: nothing left to hand out.
      return noStoreJsonResponse(
        contractSchemas.WorkerLinkRequestPollResult.parse({ state }),
        200,
      );
    }
    if (
      row.enrollment_canceled_at || !row.enrollment_expires_at ||
      row.enrollment_expires_at <= row.now
    ) {
      return noStoreJsonResponse(
        contractSchemas.WorkerLinkRequestPollResult.parse({
          state: "expired",
        }),
        200,
      );
    }
    const linkCode = mintShortCode();
    await transaction.query(
      `update bakery.worker_enrollments
       set link_code_hash = $3, updated_at = current_timestamp
       where organization_id = $1 and id = $2 and consumed_at is null`,
      [row.organization_id, row.enrollment_id, await linkCodeHash(linkCode)],
    );
    await appendAudit(transaction, {
      organizationId: row.organization_id!,
      principalId: row.enrollment_principal_id!,
      operation: "worker.pollLinkRequest",
      resourceType: "worker_enrollment",
      resourceId: row.enrollment_id!,
      requestId: metadata.requestId,
      traceId: metadata.traceId,
      details: { linkRequestId: row.id, linkCodeIssued: true },
    });
    return noStoreJsonResponse(
      contractSchemas.WorkerLinkRequestPollResult.parse({ state, linkCode }),
      200,
    );
  }, context.req.raw.signal);
}

/**
 * `POST /v1/worker-link-requests/lookups`: an Admin types the terminal's code.
 * A pending request shows only what the machine said about itself; a request
 * another organization already decided is not found.
 */
export async function findLinkRequest(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const input = await parseContract(
    context,
    contractSchemas.WorkerLinkRequestLookup,
  );
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerLinkRequests.find",
    async (transaction, organization, principal) => {
      await spendLinkAttempt(
        options,
        `lookup:principal:${principal.principalId}`,
        LOOKUP_PER_PRINCIPAL,
      );
      const code = normalizeShortCode(input.userCode);
      if (code === null) throw linkRefusal("not_found");
      const hash = await userCodeHash(code);
      await spendLinkAttempt(options, `lookup:code:${hash}`, LOOKUP_PER_CODE);
      const row = await loadLinkRequest(transaction, "r.user_code_hash", hash);
      if (
        !row ||
        (row.organization_id !== null && row.organization_id !== organization)
      ) throw linkRefusal("not_found");
      return jsonResponse(linkRequestProjection(row, code), 200, false);
    },
  );
}

async function decideLinkRequest(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
  decision: "approved" | "declined",
): Promise<Response> {
  const requestId = context.req.param("id") ?? "";
  const input = decision === "approved"
    ? await parseContract(context, contractSchemas.WorkerLinkRequestApprove)
    : (await parseContract(
      context,
      contractSchemas.WorkerLinkRequestDecline,
    ),
      null);
  const idempotencyKey = parseIdempotencyKey(
    context.req.header("Idempotency-Key"),
  );
  const capabilities = input === null
    ? []
    : normalizeCapabilities(input.capabilities);
  const name = input?.name?.trim() ?? "";
  const digest = await requestDigest({
    requestId,
    decision,
    name,
    slots: input?.slots ?? null,
    capabilities,
  });
  const metadata = requestMetadata(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    decision === "approved"
      ? "workerLinkRequests.approve"
      : "workerLinkRequests.decline",
    async (transaction, organization, principal) => {
      if (!UUID.test(requestId)) throw linkRefusal("not_found");
      const row = await loadLinkRequest(transaction, "r.id", requestId);
      if (
        !row ||
        (row.organization_id !== null && row.organization_id !== organization)
      ) throw linkRefusal("not_found");
      if (row.decision !== null) {
        if (
          row.decision_idempotency_key === idempotencyKey &&
          row.decided_by === principal.principalId
        ) {
          if (row.decision_request_digest !== digest) {
            throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
          }
          return jsonResponse(linkRequestProjection(row, null), 200, true);
        }
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: row.decision },
        });
      }
      if (row.expires_at <= row.now) throw linkRefusal("expired");
      let enrollmentId: string | null = null;
      if (decision === "approved" && input !== null) {
        if (
          !Number.isSafeInteger(input.slots) || input.slots < 1 ||
          input.slots > 100
        ) {
          throw new StandardError({
            code: "UNPROCESSABLE",
            params: { field: "slots" },
          });
        }
        // The enrollment the approval creates. Its long token is never shown
        // to anyone: the waiting terminal is handed a link code on its next
        // poll, and that code is the only way to use this row.
        const inserted = await transaction.query<{ id: string }>(
          `insert into bakery.worker_enrollments (
             organization_id, principal_id, name, os, architecture,
             allowed_capabilities, slots, token_hash, expires_at
           ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8,
             clock_timestamp() + ($9::integer * interval '1 second'))
           returning id`,
          [
            organization,
            principal.principalId,
            name || row.hostname,
            reportedOs(row.os),
            row.architecture,
            JSON.stringify(capabilities),
            input.slots,
            await sha256Hex(randomSecret()),
            ENROLLMENT_TTL_MS / 1000,
          ],
        );
        enrollmentId = inserted.rows[0]?.id ?? null;
        if (!enrollmentId) throw new Error("WORKER_ENROLLMENT_INSERT_FAILED");
      }
      await transaction.query(
        `update bakery.worker_link_requests
         set organization_id = $2, decision = $3,
             decided_at = clock_timestamp(), decided_by = $4,
             decision_idempotency_key = $5, decision_request_digest = $6,
             enrollment_id = $7, version = version + 1
         where id = $1`,
        [
          row.id,
          organization,
          decision,
          principal.principalId,
          idempotencyKey,
          digest,
          enrollmentId,
        ],
      );
      await appendAudit(transaction, {
        organizationId: organization,
        principalId: principal.principalId,
        operation: decision === "approved"
          ? "workerLinkRequests.approve"
          : "workerLinkRequests.decline",
        resourceType: "worker_link_request",
        resourceId: row.id,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        details: {
          hostname: row.hostname,
          ...(enrollmentId === null ? {} : { enrollmentId }),
        },
      });
      const decided = await loadLinkRequest(transaction, "r.id", row.id);
      if (!decided) throw new Error("WORKER_LINK_REQUEST_VANISHED");
      return jsonResponse(linkRequestProjection(decided, null), 200, false);
    },
  );
}

/** `POST /v1/worker-link-requests/{id}/approvals` (Admin). */
export async function approveLinkRequest(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  return await decideLinkRequest(context, options, "approved");
}

/** `POST /v1/worker-link-requests/{id}/declines` (Admin). */
export async function declineLinkRequest(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  return await decideLinkRequest(context, options, "declined");
}
