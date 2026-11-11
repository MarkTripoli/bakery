import type { Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import {
  closeOutputBinding,
  loadFinalizationGrant,
  openOutputBinding,
  recordFinalizationFailure,
  replayOutputReceipt,
  saveOutputReceipt,
} from "@bakery/persistence";
import {
  finalizeOutputTranscript,
  revokeOutputTranscript,
} from "./output-transcript.ts";
import { withPgTransaction } from "@bakery/persistence";
import { jsonResponse, parseContract } from "./http.ts";
import { assertActiveLease, lockAttempt, outputProducer } from "./events.ts";
import {
  assertAttemptMutationSession,
  assertWorkerMutationSessionShape,
  canonicalJson,
  contractSchemas,
  type ExecutionRouteOptions,
  readAttemptId,
  sha256Hex,
  workerIdempotencyUuid,
  workerTransaction,
} from "./shared.ts";

let finalizationResponseDropForTest:
  | ((rawResponse: string) => void)
  | null = null;

/** One-shot fixture seam for simulating transport loss after commit. */
export function setOutputFinalizationResponseDropForTest(
  observe: ((rawResponse: string) => void) | null,
): void {
  finalizationResponseDropForTest = observe;
}

export async function outputBindingRoute(
  context: Context,
  options: ExecutionRouteOptions,
  operation: "open" | "close",
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const input = operation === "open"
    ? await parseContract(context, contractSchemas.WorkerOutputOpen)
    : await parseContract(context, contractSchemas.WorkerOutputClose);
  const key = workerIdempotencyUuid(context.req.header("Idempotency-Key"));
  const digest = await sha256Hex(canonicalJson(input));
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
      const producer = outputProducer(attempt);
      const saved = await replayOutputReceipt(
        transaction,
        producer,
        operation,
        key,
        digest,
      );
      if (saved) {
        let grantId: string | null = null;
        if (operation === "close") {
          const grant = (await transaction.query<{ id: string }>(
            `select id from bakery.session_output_finalizations where organization_id=$1 and session_id=$2`,
            [identity.host.organization_id, saved.sessionId],
          )).rows[0];
          grantId = grant?.id ?? null;
        }
        return { response: saved, replayed: true, grantId };
      }
      assertAttemptMutationSession(
        identity.host,
        attempt,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      const tokenHash = await sha256Hex(input.leaseToken);
      assertActiveLease(attempt, identity, tokenHash, input.fence);
      const response = operation === "open"
        ? await openOutputBinding(transaction, producer)
        : await closeOutputBinding(
          transaction,
          producer,
          contractSchemas.WorkerOutputClose.parse(input),
        );
      // A lease may expire while scope/storage validation runs. Roll back rather than issue authority late.
      assertActiveLease(
        await lockAttempt(transaction, identity, attemptId),
        identity,
        tokenHash,
        input.fence,
      );
      await saveOutputReceipt(
        transaction,
        producer,
        operation,
        key,
        digest,
        response,
      );
      let grantId: string | null = null;
      if (operation === "close") {
        const grant = (await transaction.query<{ id: string }>(
          `select id from bakery.session_output_finalizations where organization_id=$1 and session_id=$2`,
          [identity.host.organization_id, response.sessionId],
        )).rows[0];
        grantId = grant?.id ?? null;
      }
      return { response, replayed: false, grantId };
    },
  );
  if (operation === "close" && result.grantId) {
    try {
      await workerTransaction(
        options.database,
        context.req.raw.headers,
        async (transaction, identity) => {
          const grant = await loadFinalizationGrant(
            transaction,
            identity.host.organization_id,
            result.grantId!,
          );
          await finalizeOutputTranscript(transaction, {
            organizationId: identity.host.organization_id,
            workerHostId: identity.host.id,
            workerPrincipalId: identity.host.principal_id,
            attemptId: grant.attempt_id,
          }, {
            grantId: result.grantId!,
            sessionId: result.response.sessionId,
            frozenHighwater: result.response.highwater,
            payloadDigest: grant.payload_digest ?? "",
          });
        },
      );
    } catch (_error) {
      await withPgTransaction(options.database, async (transaction) => {
        await recordFinalizationFailure(
          transaction,
          result.response.organizationId,
          result.grantId!,
          true,
        );
      });
    }
  }
  // The worker binding keeps main's exact shape; the grant id stays
  // server-side because no worker reads it and strict older workers reject it.
  const response = result.response;
  return jsonResponse(response, 200, result.replayed);
}

export async function outputFinalizationRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const grantId = context.req.param("grantId");
  if (!grantId) throw new StandardError({ code: "MALFORMED_REQUEST" });
  const input = await parseContract(
    context,
    contractSchemas.WorkerOutputFinalize,
  );
  if (input.grantId !== grantId) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  let organizationId = "";
  let result: Awaited<ReturnType<typeof finalizeOutputTranscript>>;
  try {
    result = await workerTransaction(
      options.database,
      context.req.raw.headers,
      async (transaction, identity) => {
        organizationId = identity.host.organization_id;
        return await finalizeOutputTranscript(transaction, {
          organizationId,
          workerHostId: identity.host.id,
          workerPrincipalId: identity.host.principal_id,
          attemptId,
        }, input);
      },
    );
  } catch (error) {
    const terminalPrecondition = error instanceof StandardError &&
      error.code === "PRECONDITION_FAILED";
    if (
      organizationId &&
      (!(error instanceof StandardError) || terminalPrecondition)
    ) {
      await withPgTransaction(options.database, async (transaction) => {
        await recordFinalizationFailure(
          transaction,
          organizationId,
          grantId,
          !terminalPrecondition,
        );
      });
    }
    throw error;
  }
  const response = jsonResponse(result.response, 200, result.replayed);
  const drop = finalizationResponseDropForTest;
  if (drop) {
    finalizationResponseDropForTest = null;
    drop(await response.clone().text());
    throw new Error("OUTPUT_FINALIZATION_RESPONSE_DROPPED");
  }
  return response;
}

export async function outputFinalizationRevokeRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const grantId = context.req.param("grantId");
  if (!grantId) throw new StandardError({ code: "MALFORMED_REQUEST" });
  const input = await parseContract(
    context,
    contractSchemas.WorkerOutputRevoke,
  );
  if (input.grantId !== grantId) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const key = workerIdempotencyUuid(context.req.header("Idempotency-Key"));
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      const attempt = await lockAttempt(transaction, identity, attemptId);
      assertAttemptMutationSession(
        identity.host,
        attempt,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      const tokenHash = await sha256Hex(input.leaseToken);
      return await revokeOutputTranscript(
        transaction,
        {
          organizationId: identity.host.organization_id,
          workerHostId: identity.host.id,
          workerPrincipalId: identity.host.principal_id,
          attemptId,
          tokenHash,
          fence: input.fence,
          workerSessionId: input.workerSessionId,
          workerSessionGeneration: input.workerSessionGeneration,
        },
        { grantId, idempotencyKey: key },
        () => {
          assertActiveLease(attempt, identity, tokenHash, input.fence);
        },
      );
    },
  );
  return jsonResponse(result.response, 200, result.replayed);
}
