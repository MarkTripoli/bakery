import type { PgTransactionClient } from "./postgres.ts";

const LIVE_MODEL_KEY_SOURCE = `
       from bakery.worker_provider_bindings as binding
       join bakery.secrets as secret
         on secret.organization_id = binding.organization_id
        and secret.id = binding.secret_id
       join bakery.secret_versions as version
         on version.organization_id = secret.organization_id
        and version.id = secret.active_version_id
      where binding.organization_id = $1
        and binding.worker_host_id = $2
        and binding.billing_route = 'api_metered'
        and binding.auth_mode = 'api_secret'
        and binding.enabled
        and secret.provider = binding.provider
        and secret.provider in ('anthropic', 'openai', 'openrouter')
        and secret.application_id is not null
        and secret.revoked_at is null
        and (secret.expires_at is null or secret.expires_at > clock_timestamp())
        and (version.expires_at is null or version.expires_at > clock_timestamp())`;

export const MODEL_KEY_ACTION = "model.inference";

const HARNESS_COMPONENT_KEYS: Readonly<Record<string, string>> = {
  claude_code: "harness.claude",
  codex: "harness.codex",
  pi: "harness.pi",
};

export type JobKeyScope = Readonly<{
  harness: string | null;
  provider: string | null;
  billingRoute: string | null;
  applicationId: string | null;
  requestedBy: string | null;
  requesterActive: boolean;
}>;

export type CoveringModelKey = Readonly<{
  bindingId: string;
  secretId: string;
  applicationId: string;
  provider: string;
  secretExpiresAt: Date | string | null;
  revision: number;
  keyId: string;
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
}>;

export type ModelKeyCoverage =
  | Readonly<{ ok: true; key: CoveringModelKey }>
  | Readonly<{
    ok: false;
    reason:
      | "model_key_not_metered"
      | "model_key_unbound"
      | "model_key_project_mismatch"
      | "model_key_not_allowed";
  }>;

function textList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function readJobKeyScope(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
): Promise<JobKeyScope | null> {
  const jobs = await transaction.query<JobKeyScope>(
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
    [organizationId, jobId],
  );
  return jobs.rows[0] ?? null;
}

export async function coveringModelKey(
  transaction: PgTransactionClient,
  organizationId: string,
  workerHostId: string,
  job: JobKeyScope | null,
): Promise<ModelKeyCoverage> {
  if (job === null || job.billingRoute !== "api") {
    return { ok: false, reason: "model_key_not_metered" };
  }
  const componentKey = job.harness === null
    ? undefined
    : HARNESS_COMPONENT_KEYS[job.harness];
  if (componentKey === undefined || job.provider === null) {
    return { ok: false, reason: "model_key_unbound" };
  }
  const keys = await transaction.query<
    CoveringModelKey & { allowedPrincipals: unknown; allowedActions: unknown }
  >(
    `select binding.id as "bindingId", secret.id as "secretId",
            secret.application_id as "applicationId",
            secret.provider,
            secret.allowed_principals as "allowedPrincipals",
            secret.allowed_actions as "allowedActions",
            secret.expires_at as "secretExpiresAt",
            version.revision, version.key_id as "keyId",
            version.ciphertext, version.nonce
${LIVE_MODEL_KEY_SOURCE}
        and binding.component_key = $3
        and binding.provider = $4
      order by binding.created_at, binding.id
      limit 1`,
    [organizationId, workerHostId, componentKey, job.provider],
  );
  const key = keys.rows[0];
  if (key === undefined) return { ok: false, reason: "model_key_unbound" };
  if (key.applicationId !== job.applicationId) {
    return { ok: false, reason: "model_key_project_mismatch" };
  }
  if (
    job.requestedBy === null || !job.requesterActive ||
    !textList(key.allowedPrincipals).includes(job.requestedBy) ||
    !textList(key.allowedActions).includes(MODEL_KEY_ACTION)
  ) return { ok: false, reason: "model_key_not_allowed" };
  return { ok: true, key };
}

export async function hostHoldsModelKey(
  transaction: PgTransactionClient,
  organizationId: string,
  workerHostId: string,
): Promise<boolean> {
  const found = await transaction.query(
    `select 1 ${LIVE_MODEL_KEY_SOURCE}
        and secret.allowed_actions ? $3
      limit 1`,
    [organizationId, workerHostId, MODEL_KEY_ACTION],
  );
  return found.rows.length > 0;
}

export function meteredModelWorkOnly(
  gate: Readonly<
    { allBlocked: boolean; blockedCapabilities: readonly string[] }
  >,
  holdsModelKey: boolean,
): boolean {
  return holdsModelKey && !gate.allBlocked &&
    gate.blockedCapabilities.length > 0 &&
    gate.blockedCapabilities.every((capability) => capability === "model");
}
