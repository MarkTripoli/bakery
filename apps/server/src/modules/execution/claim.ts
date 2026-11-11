import { type Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import type {
  PgDatabase,
  WorkerIdentity as PersistenceWorkerIdentity,
} from "@bakery/persistence";
import {
  claimIdentity,
  createClaimsRepository,
} from "@bakery/persistence/claims";
import { jsonResponse, noContentResponse, parseContract } from "./http.ts";
import { type ClaimUnitOfWork, executeClaim } from "./claim-application.ts";
import {
  contractSchemas,
  type ExecutionRouteOptions,
  type WorkerIdentity,
  workerTransaction,
} from "./shared.ts";

function persistenceIdentity(
  identity: WorkerIdentity,
): PersistenceWorkerIdentity {
  return {
    tokenHash: identity.tokenHash,
    host: {
      id: identity.host.id,
      organizationId: identity.host.organization_id,
      principalId: identity.host.principal_id,
      principalType: identity.host.principal_type,
      name: identity.host.name,
      os: identity.host.os,
      architecture: identity.host.architecture,
      capabilities: identity.host.capabilities,
      slots: identity.host.slots,
      status: identity.host.status,
      desiredMode: identity.host.desired_mode,
      credentialHash: identity.host.credential_hash,
      credentialGeneration: identity.host.credential_generation,
      inventoryRevision: identity.host.inventory_revision,
      readinessRevision: identity.host.readiness_revision,
      protocolVersion: identity.host.protocol_version,
      workerSessionId: identity.host.worker_session_id,
      workerSessionGeneration: identity.host.worker_session_generation,
      lastHeartbeatAt: identity.host.last_heartbeat_at,
    },
  };
}

function createClaimUnitOfWork(database: PgDatabase): ClaimUnitOfWork {
  return {
    async run(headers, workerHostId, work) {
      return await workerTransaction(
        database,
        headers,
        async (transaction, identity) => {
          if (workerHostId !== identity.host.id) {
            throw new StandardError({ code: "AUTH_FORBIDDEN" });
          }
          const persistence = createClaimsRepository(
            transaction,
            persistenceIdentity(identity),
          );
          return await work({
            identity: claimIdentity(persistenceIdentity(identity)),
            persistence,
          });
        },
      );
    },
  };
}

export async function claimJob(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const input = await parseContract(
    context,
    contractSchemas.WorkerClaim,
  );
  const result = await executeClaim({
    secret: options.secret,
    headers: context.req.raw.headers,
    unitOfWork: createClaimUnitOfWork(options.database),
    input,
  });
  if (result.status === 204) return noContentResponse(result.replayed);
  return jsonResponse(result.response, 200, result.replayed);
}
