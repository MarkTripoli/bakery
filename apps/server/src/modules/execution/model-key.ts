import type { Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { sha256Hex } from "../../platform/canonical-json.ts";
import { appendAudit } from "@bakery/persistence/event-audit";
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
export const MODEL_KEY_ACTION = "model.inference";
const HARNESS_COMPONENT_KEYS: Readonly<Record<string, string>> = {
  claude_code: "harness.claude",
  codex: "harness.codex",
  pi: "harness.pi",
};

function textList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

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
      const jobs = await transaction.query<{
        harness: string | null;
        provider: string | null;
        billingRoute: string | null;
        applicationId: string | null;
        requestedBy: string | null;
        requesterActive: boolean;
      }>(
        `select job.agent_config->>'harness' as harness,
                job.billing->>'provider' as provider,
                job.billing->>'billingRoute' as "billingRoute",
                run.application_id as "applicationId",
                run.requested_by as "requestedBy",
                coalesce(
                  membership.status = 'active' and requester.disabled_at is null,
                  false
                ) as "requesterActive"
           from bakery.jobs as job
           join bakery.run_steps as step
             on step.organization_id = job.organization_id
            and step.id = job.run_step_id
           join bakery.workflow_runs as run
             on run.organization_id = step.organization_id
            and run.id = step.run_id
           left join bakery.principals as requester
             on requester.id = run.requested_by
           left join bakery.organization_memberships as membership
             on membership.organization_id = job.organization_id
            and membership.principal_id = run.requested_by
          where job.organization_id = $1 and job.id = $2`,
        [attempt.organization_id, attempt.job_id],
      );
      const job = jobs.rows[0];
      if (job === undefined || job.billingRoute !== "api") {
        throw modelKeyRefusal("model_key_not_metered");
      }
      const componentKey = job.harness === null
        ? undefined
        : HARNESS_COMPONENT_KEYS[job.harness];
      if (componentKey === undefined || job.provider === null) {
        throw modelKeyRefusal("model_key_unbound");
      }
      const keys = await transaction.query<{
        bindingId: string;
        secretId: string;
        applicationId: string;
        provider: string;
        allowedPrincipals: unknown;
        allowedActions: unknown;
        secretExpiresAt: Date | string | null;
        revision: number;
        keyId: string;
        ciphertext: Uint8Array<ArrayBuffer>;
        nonce: Uint8Array<ArrayBuffer>;
      }>(
        `select binding.id as "bindingId", secret.id as "secretId",
                secret.application_id as "applicationId",
                secret.provider,
                secret.allowed_principals as "allowedPrincipals",
                secret.allowed_actions as "allowedActions",
                secret.expires_at as "secretExpiresAt",
                version.revision, version.key_id as "keyId",
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
            and binding.component_key = $3
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
          componentKey,
          job.provider,
        ],
      );
      const key = keys.rows[0];
      if (key === undefined || !isModelKeyProvider(key.provider)) {
        throw modelKeyRefusal("model_key_unbound");
      }
      if (key.applicationId !== job.applicationId) {
        throw modelKeyRefusal("model_key_project_mismatch");
      }
      if (
        job.requestedBy === null || !job.requesterActive ||
        !textList(key.allowedPrincipals).includes(job.requestedBy) ||
        !textList(key.allowedActions).includes(MODEL_KEY_ACTION)
      ) throw modelKeyRefusal("model_key_not_allowed");
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
          startedBy: job.requestedBy,
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
