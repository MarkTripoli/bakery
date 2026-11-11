import type { Context } from "hono";
import {
  SecretIdentityInvocationProofSchema,
  SecretIdentityToolRequestSchema,
  type SecretIdentityToolResult,
  SecretIdentityToolResultSchema,
} from "@bakery/contracts/secret-identity";
import { StandardError } from "@bakery/contracts/http";
import {
  beginPreparedIdentityInvocation,
  completePreparedIdentityInvocation,
  type PreparedOperationWorkerIdentity,
} from "@bakery/persistence/secret-identity";
import { decryptSecret, loadSecretKey } from "../secrets/crypto.ts";
import { verifyGitHubCredential } from "../secrets/broker.ts";
import { jsonResponse, parseContract } from "./http.ts";
import {
  type ExecutionRouteOptions,
  parseIdempotencyKey,
  readAttemptId,
  type WorkerIdentity,
  workerTransaction,
} from "./shared.ts";

function preparedIdentity(
  identity: WorkerIdentity,
): PreparedOperationWorkerIdentity {
  return {
    host: {
      id: identity.host.id,
      organizationId: identity.host.organization_id,
      workerSessionId: identity.host.worker_session_id,
      workerSessionGeneration: identity.host.worker_session_generation,
    },
  };
}

function proofFromHeaders(headers: Headers) {
  const parsed = SecretIdentityInvocationProofSchema.safeParse({
    leaseToken: headers.get("X-Worker-Lease-Token"),
    fence: headers.get("X-Worker-Fence"),
    workerSessionId: headers.get("X-Worker-Session-Id"),
    workerSessionGeneration: headers.get("X-Worker-Session-Generation"),
  });
  if (!parsed.success) {
    throw new StandardError({ code: "MALFORMED_REQUEST", cause: parsed.error });
  }
  return parsed.data;
}

export async function secretIdentityToolRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const contentLength = context.req.header("content-length");
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > 128)
  ) throw new StandardError({ code: "BODY_TOO_LARGE" });
  const attemptId = readAttemptId(context);
  const request = await parseContract(context, SecretIdentityToolRequestSchema);
  if (
    parseIdempotencyKey(context.req.header("Idempotency-Key")) !==
      request.preparedOperationId
  ) throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  const proof = proofFromHeaders(context.req.raw.headers);
  const begun = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) =>
      await beginPreparedIdentityInvocation(
        transaction,
        preparedIdentity(identity),
        attemptId,
        request.preparedOperationId,
        proof,
      ),
  );
  if (begun.kind === "terminal") {
    return jsonResponse(begun.result, 200, begun.replayed);
  }
  const invocation = begun.value;
  let plaintext: Uint8Array | undefined;
  let providerResult: SecretIdentityToolResult = {
    status: "uncertain",
    code: "PROVIDER_OUTCOME_UNCERTAIN",
  };
  try {
    if (!options.secretsKey || invocation.keyId !== options.secretsKey.keyId) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    const key = await loadSecretKey(options.secretsKey);
    plaintext = await decryptSecret(key, {
      organizationId: invocation.organizationId,
      applicationId: invocation.applicationId,
      secretId: invocation.secretId,
      revision: invocation.revision,
      keyId: invocation.keyId,
    }, {
      ciphertext: invocation.ciphertext,
      nonce: invocation.nonce,
    });
    const credential = new TextDecoder("utf-8", { fatal: true }).decode(
      plaintext,
    );
    const identity = await verifyGitHubCredential(
      credential,
      context.req.raw.signal,
      options.secretsFetch,
    );
    providerResult = SecretIdentityToolResultSchema.parse({
      status: "completed",
      accountId: identity.accountId,
      login: identity.login,
    });
  } catch {
    providerResult = {
      status: "uncertain",
      code: "PROVIDER_OUTCOME_UNCERTAIN",
    };
  } finally {
    plaintext?.fill(0);
    invocation.ciphertext.fill(0);
    invocation.nonce.fill(0);
  }
  const completed = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) =>
      await completePreparedIdentityInvocation(
        transaction,
        preparedIdentity(identity),
        attemptId,
        invocation.operationId,
        invocation.requestDigest,
        providerResult,
      ),
  );
  return jsonResponse(completed, 200);
}
