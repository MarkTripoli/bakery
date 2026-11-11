import { type Context } from "hono";
import { jsonBodyResponse, parseContract } from "./http.ts";
import { createHeartbeatRepository } from "@bakery/persistence/heartbeat";
import type { ExecutionRouteOptions, WorkerIdentity } from "./shared.ts";
import {
  assertWorkerSessionPair,
  contractSchemas,
  parseIdempotencyKey,
  parseWorkerProtocolVersion,
  requestDigest,
  requestMetadata,
  workerTransaction,
} from "./shared.ts";

function persistenceIdentity(identity: WorkerIdentity) {
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

export async function heartbeat(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const protocolVersion = parseWorkerProtocolVersion(
    context.req.raw.headers,
  );
  const input = await parseContract(context, contractSchemas.WorkerHeartbeat);
  const idempotencyKey = parseIdempotencyKey(
    context.req.header("Idempotency-Key"),
  );
  const digest = await requestDigest({ ...input, protocolVersion });
  const metadata = requestMetadata(context);
  assertWorkerSessionPair(
    input.workerSessionId,
    input.workerSessionGeneration,
  );
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      const repository = createHeartbeatRepository(transaction);
      return await repository.heartbeat({
        identity: persistenceIdentity(identity),
        input,
        idempotencyKey,
        requestDigest: digest,
        protocolVersion,
        metadata,
        makeResponse: (value: unknown) =>
          contractSchemas.WorkerHeartbeatResult.parse(value),
      });
    },
  );
  return jsonBodyResponse(result.body, result.status, result.replayed);
}
