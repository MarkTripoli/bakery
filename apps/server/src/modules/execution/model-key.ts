import type { Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { sha256Hex } from "../../platform/canonical-json.ts";
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
  provider: ModelKeyProvider;
};

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

function isModelKeyProvider(value: string): value is ModelKeyProvider {
  return (MODEL_KEY_PROVIDERS as readonly string[]).includes(value);
}

function modelKeyRefusal(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

async function sealedModelKey(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<SealedModelKey> {
  const attemptId = readAttemptId(context);
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
      const jobs = await transaction.query<{
        harness: string | null;
        provider: string | null;
        billingRoute: string | null;
      }>(
        `select agent_config->>'harness' as harness,
                billing->>'provider' as provider,
                billing->>'billingRoute' as "billingRoute"
           from bakery.jobs where organization_id = $1 and id = $2`,
        [attempt.organization_id, attempt.job_id],
      );
      const job = jobs.rows[0];
      if (
        job === undefined || job.billingRoute !== "api"
      ) throw modelKeyRefusal("model_key_not_metered");
      if (job.harness === null || job.provider === null) {
        throw modelKeyRefusal("model_key_unbound");
      }
      const keys = await transaction.query<{
        secretId: string;
        applicationId: string;
        provider: string;
        revision: number;
        keyId: string;
        ciphertext: Uint8Array<ArrayBuffer>;
        nonce: Uint8Array<ArrayBuffer>;
      }>(
        `select secret.id as "secretId",
                secret.application_id as "applicationId",
                secret.provider, version.revision, version.key_id as "keyId",
                version.ciphertext, version.nonce
           from bakery.worker_provider_bindings as binding
           join bakery.secrets as secret
             on secret.organization_id = binding.organization_id
            and secret.id = binding.secret_id
           join bakery.secret_versions as version
             on version.organization_id = secret.organization_id
            and version.id = secret.active_version_id
          where binding.organization_id = $1
            and binding.worker_host_id = $2
            and binding.component_key = 'harness.' || $3
            and binding.provider = $4
            and binding.billing_route = 'api_metered'
            and binding.auth_mode = 'api_secret'
            and binding.enabled
            and secret.provider = binding.provider
            and secret.application_id is not null
            and secret.revoked_at is null
            and (secret.expires_at is null or secret.expires_at > clock_timestamp())
            and (version.expires_at is null or version.expires_at > clock_timestamp())
          order by binding.created_at, binding.id
          limit 1`,
        [
          attempt.organization_id,
          identity.host.id,
          job.harness,
          job.provider,
        ],
      );
      const key = keys.rows[0];
      if (key === undefined || !isModelKeyProvider(key.provider)) {
        throw modelKeyRefusal("model_key_unbound");
      }
      return {
        organizationId: attempt.organization_id,
        applicationId: key.applicationId,
        secretId: key.secretId,
        revision: key.revision,
        keyId: key.keyId,
        ciphertext: key.ciphertext,
        nonce: key.nonce,
        provider: key.provider,
      };
    },
  );
}

export async function workerModelKeyRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const sealed = await sealedModelKey(context, options);
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
    const apiKey = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const response = jsonResponse({ provider: sealed.provider, apiKey }, 200);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } finally {
    plaintext?.fill(0);
    sealed.ciphertext.fill(0);
    sealed.nonce.fill(0);
  }
}
