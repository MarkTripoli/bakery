import { type Context } from "hono";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { assertActiveLease, lockAttempt } from "./events.ts";
import { jsonResponse, parseContract } from "./http.ts";
import {
  assertAttemptMutationSession,
  assertWorkerMutationSessionShape,
  type ExecutionRouteOptions,
  readAttemptId,
  requestMetadata,
  sha256Hex,
  workerIdempotencyUuid,
  workerTransaction,
} from "./shared.ts";
import {
  registerPreview,
  ROUTE_KEY_PATTERN,
} from "../knowledge/previews/running-store.ts";

/**
 * `POST /v1/worker/attempts/{id}/previews`: the worker of a live attempt says
 * which local port serves the app it is running. The lease, the fence and the
 * worker session are proved first, exactly as for every other attempt
 * mutation, so a fenced, expired or foreign attempt can never register (or
 * replace) a preview. The route key is a short label, never a host or a path;
 * the port is read only by the preview proxy and never returned.
 */
export async function workerPreviewRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const input = await parseContract(context, contractSchemas.WorkerPreview);
  // Required like every worker mutation; the registration is naturally
  // idempotent (the same attempt, key, port and commit replays).
  workerIdempotencyUuid(context.req.header("Idempotency-Key"));
  if (!ROUTE_KEY_PATTERN.test(input.routeKey)) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "routeKey" },
    });
  }
  const tokenHash = await sha256Hex(input.leaseToken);
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      assertWorkerMutationSessionShape(
        identity.host,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      const attempt = await lockAttempt(transaction, identity, attemptId);
      assertAttemptMutationSession(
        identity.host,
        attempt,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      assertActiveLease(attempt, identity, tokenHash, input.fence);
      const registered = await registerPreview(transaction, {
        organizationId: identity.host.organization_id,
        attemptId: attempt.id,
        routeKey: input.routeKey,
        upstreamPort: input.upstreamPort,
        headSha: input.headSha,
        // The events this registration announces join the request that made it.
        traceId: requestMetadata(context).traceId,
      });
      if (registered.kind === "conflict") {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      return registered;
    },
  );
  return jsonResponse(
    contractSchemas.Preview.parse(result.preview),
    result.kind === "created" ? 201 : 200,
    result.kind === "replayed",
  );
}
