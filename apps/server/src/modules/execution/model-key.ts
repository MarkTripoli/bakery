import type { Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { sha256Hex } from "../../platform/canonical-json.ts";
import { appendAudit } from "@bakery/persistence/event-audit";
import {
  coveringModelKey,
  readJobKeyScope,
} from "@bakery/persistence/model-key-coverage";
import { decryptSecret, loadSecretKey } from "../secrets/crypto.ts";
import {
  MODEL_KEY_PROVIDERS,
  type ModelKeyProvider,
} from "../secrets/broker.ts";
import { assertActiveLease, lockAttempt } from "./events.ts";
import { jsonResponse } from "./http.ts";
import { UUID } from "./plugin-attempt.ts";
import {
  assertAttemptMutationSession,
  assertCurrentWorkerSession,
  assertWorkerMutationSessionShape,
  type ExecutionRouteOptions,
  readAttemptId,
  requestMetadata,
  workerTransaction,
} from "./shared.ts";

type SealedModelKey = {
  organizationId: string;
  applicationId: string;
  secretId: string;
  revision: number;
  keyId: string;
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
};

type ReleasedModelKey = { provider: ModelKeyProvider; apiKey: string };

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const LIVE_ATTEMPT_STATUSES = new Set(["leased", "running"]);
function isModelKeyProvider(value: string): value is ModelKeyProvider {
  return (MODEL_KEY_PROVIDERS as readonly string[]).includes(value);
}

function modelKeyRefusal(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

async function releasedModelKey(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<ReleasedModelKey> {
  const attemptId = readAttemptId(context);
  const metadata = requestMetadata(context);
  const headers = context.req.raw.headers;
  const leaseToken = headers.get("X-Worker-Lease-Token") ?? "";
  const fence = headers.get("X-Worker-Fence") ?? "";
  const sessionId = headers.get("X-Worker-Session-Id") ?? "";
  const generation = headers.get("X-Worker-Session-Generation") ?? "";
  if (
    leaseToken.length === 0 || leaseToken.length > 512 ||
    !DECIMAL.test(fence) || !UUID.test(sessionId) || !DECIMAL.test(generation)
  ) throw new StandardError({ code: "MALFORMED_REQUEST" });
  const tokenHash = await sha256Hex(leaseToken);
  return await workerTransaction(
    options.database,
    headers,
    async (transaction, identity) => {
      assertWorkerMutationSessionShape(identity.host, sessionId, generation);
      const attempt = await lockAttempt(
        transaction,
        identity,
        attemptId,
        "no key update",
      );
      assertCurrentWorkerSession(identity.host, sessionId, generation);
      assertAttemptMutationSession(
        identity.host,
        attempt,
        sessionId,
        generation,
      );
      assertActiveLease(attempt, identity, tokenHash, fence);
      if (!LIVE_ATTEMPT_STATUSES.has(attempt.status)) {
        throw modelKeyRefusal("model_key_attempt_ending");
      }
      const job = await readJobKeyScope(
        transaction,
        attempt.organization_id,
        attempt.job_id,
      );
      const coverage = await coveringModelKey(
        transaction,
        attempt.organization_id,
        identity.host.id,
        job,
      );
      if (!coverage.ok) throw modelKeyRefusal(coverage.reason);
      const key = coverage.key;
      if (!isModelKeyProvider(key.provider)) {
        throw modelKeyRefusal("model_key_unbound");
      }
      const apiKey = await decryptModelKey(options, {
        organizationId: attempt.organization_id,
        applicationId: key.applicationId,
        secretId: key.secretId,
        revision: key.revision,
        keyId: key.keyId,
        ciphertext: key.ciphertext,
        nonce: key.nonce,
      });
      await appendAudit(transaction, {
        organizationId: attempt.organization_id,
        principalId: identity.host.principal_id,
        operation: "worker.modelKey",
        resourceType: "secret",
        resourceId: key.secretId,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        details: {
          attemptId: attempt.id,
          workerHostId: identity.host.id,
          startedBy: job?.requestedBy ?? null,
          bindingId: key.bindingId,
          provider: key.provider,
          revision: key.revision,
          secretExpiresAt: key.secretExpiresAt === null
            ? null
            : new Date(key.secretExpiresAt).toISOString(),
          leaseExpiresAt: new Date(attempt.lease_expires_at).toISOString(),
        },
      });
      return { provider: key.provider, apiKey };
    },
  );
}

async function decryptModelKey(
  options: ExecutionRouteOptions,
  sealed: SealedModelKey,
): Promise<string> {
  let plaintext: Uint8Array | undefined;
  try {
    if (!options.secretsKey || sealed.keyId !== options.secretsKey.keyId) {
      throw modelKeyRefusal("model_key_unreadable");
    }
    const key = await loadSecretKey(options.secretsKey);
    plaintext = await decryptSecret(key, {
      organizationId: sealed.organizationId,
      applicationId: sealed.applicationId,
      secretId: sealed.secretId,
      revision: sealed.revision,
      keyId: sealed.keyId,
    }, { ciphertext: sealed.ciphertext, nonce: sealed.nonce });
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw modelKeyRefusal("model_key_unreadable");
  } finally {
    plaintext?.fill(0);
    sealed.ciphertext.fill(0);
    sealed.nonce.fill(0);
  }
}

export async function workerModelKeyRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const released = await releasedModelKey(context, options);
  const response = jsonResponse(released, 200);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
