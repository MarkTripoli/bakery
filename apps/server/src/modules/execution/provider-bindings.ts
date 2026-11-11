import { type Context } from "hono";
import type { AuthVariables } from "../auth/middleware.ts";
import { StandardError } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  contractSchemas,
  type OrganizationId,
} from "@bakery/contracts/contracts";
import { iso } from "./shared.ts";
import { jsonResponse, parseContract } from "./http.ts";
import {
  machineTransaction,
  type MachineTransactionClient,
  noStoreJsonResponse,
  readinessWorkflows,
} from "./machines.ts";
import type { ExecutionRouteOptions } from "./shared.ts";
import { workerTransaction } from "./shared.ts";

export async function listModelProviderAccounts(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "modelProviderAccounts.list",
    async (transaction, organization, principal) => {
      const binding: CursorBinding = {
        action: "modelProviderAccounts.list",
        organizationId: organization,
        principalId: principal.principalId,
        ordering: "createdAt:asc,id:asc",
        filters: JSON.stringify({}),
        schemaVersion: 1,
      };
      const cursor = context.req.query("cursor") ?? undefined;
      const limit = Math.min(Number(context.req.query("limit") ?? 25), 100);
      const position = await decodeCursor(options.secret, cursor, binding);
      const rows = await transaction.query<
        Record<string, unknown> & {
          created_at: Date;
          id: string;
        }
      >(
        `select id, provider, billing_route as "billingRoute",
                display_identity as "displayIdentity", verified_at as "verifiedAt",
                auth_state as "authState", last_checked_at as "lastCheckedAt",
                quota_source as "quotaSource", quota_remaining as "quotaRemaining",
                quota_observed_at as "quotaObservedAt", created_at
         from bakery.model_provider_accounts
         where organization_id = $1
           and ($2::timestamptz is null or (created_at, id) > ($2, $3::uuid))
         order by created_at asc, id asc
         limit $4`,
        [
          organization,
          position?.createdAt ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const visible = rows.rows.slice(0, limit);
      const items = visible.map((row) =>
        contractSchemas.ModelProviderAccount.parse({
          ...row,
          verifiedAt: row.verifiedAt ? iso(row.verifiedAt as Date) : null,
          lastCheckedAt: row.lastCheckedAt
            ? iso(row.lastCheckedAt as Date)
            : null,
          quotaObservedAt: row.quotaObservedAt
            ? iso(row.quotaObservedAt as Date)
            : null,
          createdAt: undefined,
          id: row.id,
        })
      );
      const last = visible.at(-1);
      const nextCursor = rows.rows.length > limit && last
        ? await encodeCursor(options.secret, binding, {
          createdAt: last.created_at.toISOString(),
          id: last.id,
        })
        : null;
      const page = contractSchemas["Page<ModelProviderAccount>"].parse({
        items,
        nextCursor,
      });
      return jsonResponse(page, 200, false);
    },
  );
}

export async function listProviderBindings(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerProviderBindings.list",
    async (transaction, organization, principal) => {
      const binding: CursorBinding = {
        action: "workerProviderBindings.list",
        organizationId: organization,
        principalId: principal.principalId,
        ordering: "createdAt:asc,id:asc",
        filters: JSON.stringify({ workerHostId }),
        schemaVersion: 1,
      };
      const cursor = context.req.query("cursor") ?? undefined;
      const limit = Math.min(Number(context.req.query("limit") ?? 25), 100);
      const position = await decodeCursor(options.secret, cursor, binding);
      const rows = await transaction.query<
        Record<string, unknown> & {
          created_at: Date;
          id: string;
        }
      >(
        `select id, worker_host_id as "workerHostId",
                component_key as "componentKey", provider,
                billing_route as "billingRoute", enabled,
                auth_mode as "authMode", credential_location as "credentialLocation",
                model_provider_account_id as "modelProviderAccountId",
                auth_generation as "authGeneration",
                last_checked_at as "lastCheckedAt", safe_problem as "safeProblem",
                created_at
         from bakery.worker_provider_bindings
         where organization_id = $1 and worker_host_id = $2
           and ($3::timestamptz is null or (created_at, id) > ($3, $4::uuid))
         order by created_at asc, id asc
         limit $5`,
        [
          organization,
          workerHostId,
          position?.createdAt ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const visible = rows.rows.slice(0, limit);
      const items = visible.map(({ created_at: _created_at, ...binding }) =>
        contractSchemas.WorkerProviderBinding.parse({
          ...binding,
          lastCheckedAt: binding.lastCheckedAt
            ? iso(binding.lastCheckedAt as Date)
            : null,
        })
      );
      const last = visible.at(-1);
      const nextCursor = rows.rows.length > limit && last
        ? await encodeCursor(options.secret, binding, {
          createdAt: last.created_at.toISOString(),
          id: last.id,
        })
        : null;
      const page = contractSchemas["Page<WorkerProviderBinding>"].parse({
        items,
        nextCursor,
      });
      return jsonResponse(page, 200, false);
    },
  );
}

export async function createProviderBinding(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const input = await parseContract(
    context,
    contractSchemas.WorkerProviderBindingCreate,
  );
  const metadata = requestMetadataLocal(context);
  const response = await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerProviderBindings.create",
    async (transaction, organization, principal) => {
      const workflows = readinessWorkflows(transaction, options);
      const result = await workflows.createProviderBinding({
        organizationId: organization,
        principalId: principal.principalId,
        workerHostId,
        input,
        metadata,
        now: new Date(),
      });
      const bindingId = result.response.bindingId as string;
      const projection = await bindingProjection(
        transaction,
        organization,
        workerHostId,
        bindingId,
      );
      return { response: projection, replayed: result.replayed };
    },
  );
  return jsonResponse(response.response, 201, response.replayed);
}

export async function updateProviderBinding(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const bindingId = context.req.param("bindingId") ?? "";
  const input = await parseContract(
    context,
    contractSchemas.WorkerProviderBindingUpdate,
  );
  const metadata = requestMetadataLocal(context);
  const expectedVersion = await requireIfMatchVersion(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerProviderBindings.update",
    async (transaction, organization, principal) => {
      const workflows = readinessWorkflows(transaction, options);
      const result = await workflows.updateProviderBinding({
        organizationId: organization,
        principalId: principal.principalId,
        workerHostId,
        bindingId,
        expectedVersion,
        input,
        metadata,
        now: new Date(),
      });
      const projection = await bindingProjection(
        transaction,
        organization,
        workerHostId,
        bindingId,
      );
      return jsonResponse(projection, 200, result.replayed);
    },
  );
}

export async function createProviderAuthAttempt(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const bindingId = context.req.param("bindingId") ?? "";
  await parseContract(context, contractSchemas.WorkerProviderAuthAttemptCreate);
  const metadata = requestMetadataLocal(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerProviderAuth.create",
    async (transaction, organization, principal) => {
      const workflows = readinessWorkflows(transaction, options);
      const result = await workflows.createProviderAuthAttempt({
        organizationId: organization,
        principalId: principal.principalId,
        workerHostId,
        bindingId,
        metadata,
        now: new Date(),
      });
      const response = contractSchemas.WorkerProviderAuthAttemptCreated.parse(
        result.response,
      );
      // The protected challenge is session-scoped and non-cacheable; it is
      // delivered once here and never again, and never as an event.
      return noStoreJsonResponse(response, 201);
    },
  );
}

export async function getProviderAuthAttempt(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const bindingId = context.req.param("bindingId") ?? "";
  const authAttemptId = context.req.param("authAttemptId") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerProviderAuth.get",
    async (transaction, organization) => {
      const workflows = readinessWorkflows(transaction, options);
      const result = await workflows.getProviderAuthAttempt({
        organizationId: organization,
        workerHostId,
        bindingId,
        authAttemptId,
        now: new Date(),
      });
      const response = contractSchemas.WorkerProviderAuthAttempt.parse(
        result.response,
      );
      return jsonResponse(response, 200, result.replayed);
    },
  );
}

export async function cancelProviderAuthAttempt(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const bindingId = context.req.param("bindingId") ?? "";
  const authAttemptId = context.req.param("authAttemptId") ?? "";
  await parseContract(context, contractSchemas.Empty);
  const metadata = requestMetadataLocal(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerProviderAuth.cancel",
    async (transaction, organization, principal) => {
      const workflows = readinessWorkflows(transaction, options);
      const result = await workflows.cancelProviderAuthAttempt({
        organizationId: organization,
        principalId: principal.principalId,
        workerHostId,
        bindingId,
        authAttemptId,
        metadata,
        now: new Date(),
      });
      const response = contractSchemas.WorkerProviderAuthAttempt.parse(
        result.response,
      );
      return jsonResponse(response, 200, result.replayed);
    },
  );
}

export async function reportProviderAuth(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const authAttemptId = context.req.param("id") ?? "";
  const input = await parseContract(
    context,
    contractSchemas.WorkerProviderAuthAttemptReport,
  );
  const metadata = requestMetadataLocal(context);
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      const workflows = readinessWorkflows(transaction, options);
      return await workflows.reportProviderAuth({
        identity: {
          tokenHash: identity.tokenHash,
          host: {
            id: identity.host.id,
            organizationId: identity.host.organization_id,
            principalId: identity.host.principal_id,
            credentialGeneration: identity.host.credential_generation,
          },
        },
        authAttemptId,
        input,
        metadata,
        now: new Date(),
      });
    },
  );
  const response = contractSchemas.WorkerProviderAuthAttempt.parse(
    result.response,
  );
  return noStoreJsonResponse(response, 200);
}

function requireIfMatchVersion(
  context: Context<{ Variables: AuthVariables }>,
): number {
  const ifMatch = context.req.header("If-Match");
  if (ifMatch === undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const version = Number(ifMatch.replaceAll('"', ""));
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  return version;
}

function requestMetadataLocal(context: Context<{ Variables: AuthVariables }>) {
  return {
    requestId: context.req.header("X-Bakery-Request-Id") ??
      crypto.randomUUID(),
    traceId: context.req.header("X-Bakery-Trace-Id") ?? crypto.randomUUID(),
  };
}

async function bindingProjection(
  transaction: MachineTransactionClient,
  organizationId: OrganizationId,
  workerHostId: string,
  bindingId: string,
): Promise<Record<string, unknown>> {
  const rows = await transaction.query<Record<string, unknown>>(
    `select id, worker_host_id as "workerHostId", component_key as "componentKey",
            provider, billing_route as "billingRoute", enabled,
            auth_mode as "authMode", credential_location as "credentialLocation",
            model_provider_account_id as "modelProviderAccountId",
            auth_generation as "authGeneration",
            last_checked_at as "lastCheckedAt", safe_problem as "safeProblem"
     from bakery.worker_provider_bindings
     where organization_id = $1 and worker_host_id = $2 and id = $3`,
    [organizationId, workerHostId, bindingId],
  );
  const row = rows.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return contractSchemas.WorkerProviderBinding.parse({
    ...row,
    lastCheckedAt: row.lastCheckedAt ? iso(row.lastCheckedAt as Date) : null,
  }) as unknown as Record<string, unknown>;
}
