import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { parseIdempotencyKey, StandardError } from "@bakery/contracts/http";
import { IntegrationsImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import { appendDomainEvent } from "@bakery/persistence";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { effectivePermissions } from "../auth/application/authorize.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  encryptAuthAttemptVerifier,
  loadSecretKey,
} from "../secrets/crypto.ts";
import {
  gitHubAuthorizationUrl,
  gitHubInstallationUrl,
  gitHubOAuthCallbackUrl,
  isAllowlistedGitHubAuthorizationUrl,
  isAllowlistedGitHubInstallationUrl,
} from "./github-app.ts";
import {
  base64Url,
  GITHUB_PROVIDER,
  type IntegrationsDependencies,
  requireBrowserSession,
} from "./postgres.ts";

type CreateInput = z.output<
  typeof contractSchemas.IntegrationAuthAttemptCreate
>;
type Created = z.output<typeof contractSchemas.IntegrationAuthAttemptCreated>;

/** Minutes a GitHub auth attempt's state stays valid after first creation. */
export const AUTH_ATTEMPT_TTL_MINUTES = 15;
const AUTH_ATTEMPT_CHANGED = "integration.auth_attempt_changed";
const IDEMPOTENCY_UNIQUE = "integration_auth_attempts_idempotency_unique";
const TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** The current organization member the authority runner resolved. */
export function organizationActor(context: ActionContext): {
  context: AuthorizedActionContext;
  actor: OrganizationActor;
} {
  const value = context as Partial<AuthorizedActionContext>;
  const actor = value.authority as Partial<OrganizationActor> | undefined;
  if (
    !value.transaction || !value.principal || !actor?.organizationId ||
    !actor.subject || actor.subject.principalId !== value.principal.principalId
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return {
    context: value as AuthorizedActionContext,
    actor: actor as OrganizationActor,
  };
}

/** A Bakery-relative path: one leading slash, no scheme, authority or backslash. */
function requireReturnPath(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (
    !value.startsWith("/") || value.startsWith("//") || value.includes("\\") ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return value;
}

function randomToken(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  try {
    return base64Url(random);
  } finally {
    random.fill(0);
  }
}

/** RFC 7636 S256: base64url(SHA-256(ASCII(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

/**
 * A reconnect target is a live GitHub connection of the actor's own
 * organization. An unknown, archived or other organization's id is
 * RESOURCE_NOT_FOUND before anything is written, so ids disclose nothing.
 */
async function requireReconnectTarget(
  transaction: AuthorizedActionContext["transaction"],
  organizationId: string,
  connectionId: string | undefined,
): Promise<string | null> {
  if (connectionId === undefined) return null;
  const result = await transaction.query(
    `select 1 from bakery.integration_connections
      where organization_id = $1 and id = $2 and provider = $3
        and archived_at is null`,
    [organizationId, connectionId, GITHUB_PROVIDER],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return connectionId;
}

type ReplayRow = {
  id: string;
  requestDigest: string;
  sessionId: string;
  status: string;
  live: boolean;
  version: number;
  expiresAt: string;
};

/**
 * integrationAuthAttempts.create. The state and PKCE verifier are returned
 * once, inside the authorization URL; Postgres keeps only the state hash and
 * the verifier ciphertext. A retry under the same Idempotency-Key rotates
 * both on the same attempt rather than replaying a stored response.
 */
export async function createAuthAttempt(
  context: ActionContext,
  input: CreateInput,
  dependencies: IntegrationsDependencies,
): Promise<Created> {
  const { context: value, actor } = organizationActor(context);
  const sessionId = requireBrowserSession(value);
  const idempotencyKey = parseIdempotencyKey(
    value.request.headers.get("idempotency-key"),
  );
  const returnPath = requireReturnPath(input.returnPath);
  const transaction = value.transaction;
  const reconnectConnectionId = await requireReconnectTarget(
    transaction,
    actor.organizationId,
    input.reconnectConnectionId,
  );
  const registration = await transaction.query<
    { clientId: string; slug: string }
  >(
    `select client_id as "clientId", slug from bakery.integration_app_registrations
      where provider = $1`,
    [GITHUB_PROVIDER],
  );
  const clientId = registration.rows[0]?.clientId;
  const slug = registration.rows[0]?.slug;
  if (clientId === undefined || slug === undefined) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "provider_unregistered" },
    });
  }
  const key = await loadSecretKey(dependencies.secretsKey);
  const keyId = dependencies.secretsKey!.keyId;
  const organizationId = actor.organizationId;
  const principalId = actor.subject.principalId;
  const keyHash = await sha256Hex(idempotencyKey);
  const requestDigest = await sha256Hex(canonicalJson({
    provider: input.provider,
    returnPath,
    ...(reconnectConnectionId === null ? {} : { reconnectConnectionId }),
  }));
  const state = randomToken();
  const verifier = randomToken();
  const stateHash = await sha256Hex(state);
  const seal = (attemptId: string) =>
    encryptAuthAttemptVerifier(
      key,
      { organizationId, attemptId, stateHash, keyId },
      verifier,
    );

  const attemptId = crypto.randomUUID();
  const cipher = await seal(attemptId);
  const inserted = await transaction.query<
    { id: string; expiresAt: string; version: number }
  >(
    `insert into bakery.integration_auth_attempts (
       id, organization_id, initiating_principal_id, session_id, provider,
       return_path, state_hash, pkce_verifier_ciphertext, pkce_verifier_nonce,
       pkce_key_id, idempotency_key_hash, request_digest, expires_at, status,
       reconnect_connection_id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       now() + make_interval(mins => $13::int), 'pending', $14)
     on conflict on constraint ${IDEMPOTENCY_UNIQUE} do nothing
     returning id, version,
       to_char(expires_at at time zone 'UTC', ${TIMESTAMP}) as "expiresAt"`,
    [
      attemptId,
      organizationId,
      principalId,
      sessionId,
      GITHUB_PROVIDER,
      returnPath,
      stateHash,
      cipher.ciphertext,
      cipher.nonce,
      keyId,
      keyHash,
      requestDigest,
      AUTH_ATTEMPT_TTL_MINUTES,
      reconnectConnectionId,
    ],
  );
  const replayed = inserted.rows[0] === undefined;
  const attempt = replayed ? await rotate() : inserted.rows[0];
  // Every issued state is audited; neither the state nor the verifier is.
  await recordAuthAudit(transaction, value, {
    organizationId,
    principalId,
    operation: Action.IntegrationAuthAttemptsCreate,
    resourceType: "integration_auth_attempt",
    resourceId: attempt.id,
    details: {
      provider: GITHUB_PROVIDER,
      returnPath,
      reconnectConnectionId,
      expiresAt: attempt.expiresAt,
      version: attempt.version,
      replayed,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: AUTH_ATTEMPT_CHANGED,
    aggregateId: attempt.id,
    aggregateVersion: attempt.version,
    payload: { resourceId: attempt.id, resourceVersion: attempt.version },
    traceId: value.traceId,
  });

  const redirectUri = gitHubOAuthCallbackUrl(dependencies.publicBaseUrl);
  const authorizationUrl = gitHubAuthorizationUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge: await pkceChallenge(verifier),
  });
  if (
    !isAllowlistedGitHubAuthorizationUrl(authorizationUrl, {
      clientId,
      redirectUri,
    })
  ) {
    throw new StandardError({ code: "INTERNAL" });
  }
  // Same state: GitHub hands it to the Setup URL, binding the install.
  const installationUrl = gitHubInstallationUrl(slug, state);
  if (!isAllowlistedGitHubInstallationUrl(installationUrl, slug)) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return {
    id: attempt.id,
    authorizationUrl,
    installationUrl,
    expiresAt: attempt.expiresAt,
  };

  /** Same key: the same caller, body and session get a fresh state on the same attempt. */
  async function rotate() {
    const existing = await transaction.query<ReplayRow>(
      `select id, request_digest as "requestDigest", session_id as "sessionId",
         status, expires_at > now() as live, version,
         to_char(expires_at at time zone 'UTC', ${TIMESTAMP}) as "expiresAt"
       from bakery.integration_auth_attempts
       where organization_id = $1 and initiating_principal_id = $2
         and idempotency_key_hash = $3
       for update`,
      [organizationId, principalId, keyHash],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new StandardError({ code: "INTERNAL" });
    if (row.requestDigest !== requestDigest) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    if (row.sessionId !== sessionId || row.status !== "pending" || !row.live) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "attempt_not_replayable" },
      });
    }
    const rotated = await seal(row.id);
    const updated = await transaction.query<{ version: number }>(
      `update bakery.integration_auth_attempts
          set state_hash = $2, pkce_verifier_ciphertext = $3,
              pkce_verifier_nonce = $4, pkce_key_id = $5,
              version = version + 1, updated_at = now()
        where id = $1 and status = 'pending'
        returning version`,
      [row.id, stateHash, rotated.ciphertext, rotated.nonce, keyId],
    );
    if (updated.rows.length !== 1) {
      throw new StandardError({ code: "INTERNAL" });
    }
    return {
      id: row.id,
      expiresAt: row.expiresAt,
      version: updated.rows[0].version,
    };
  }
}

type AuthAttempt = z.output<typeof contractSchemas.IntegrationAuthAttempt>;

// Explicit projection: the state hash, verifier ciphertext, nonce, key id,
// session and idempotency columns are never selected.
const attemptProjection = `select attempt.id,
  attempt.organization_id as "organizationId",
  attempt.initiating_principal_id as "initiatingPrincipalId",
  attempt.provider, attempt.reconnect_connection_id as "reconnectConnectionId",
  attempt.return_path as "returnPath",
  to_char(attempt.expires_at at time zone 'UTC', ${TIMESTAMP}) as "expiresAt",
  attempt.status, attempt.result_connection_id as "resultConnectionId",
  attempt.failure_code as "failureCode",
  to_char(attempt.consumed_at at time zone 'UTC', ${TIMESTAMP}) as "consumedAt",
  to_char(attempt.created_at at time zone 'UTC', ${TIMESTAMP}) as "createdAt",
  to_char(attempt.updated_at at time zone 'UTC', ${TIMESTAMP}) as "updatedAt",
  attempt.version, attempt.expires_at <= now() as expired
  from bakery.integration_auth_attempts as attempt
  where attempt.organization_id = $1 and attempt.id = $2`;

/** True when the actor may manage every attempt in the organization (Admins). */
export function managesAttempts(actor: OrganizationActor): boolean {
  return effectivePermissions(actor).includes("integrationAuthAttempt:manage");
}

/**
 * Action guard for integrationAuthAttempts.get ("Initiating principal or
 * Admin"): a member who neither started the attempt nor manages attempts, or
 * an id from another organization, gets RESOURCE_NOT_FOUND.
 */
export async function authorizeAuthAttemptRead(
  context: ActionContext,
  input: unknown,
): Promise<void> {
  const { context: value, actor } = organizationActor(context);
  if (managesAttempts(actor)) return;
  const { id } = contractSchemas.IdPath.parse(input);
  const result = await value.transaction.query(
    `select 1 from bakery.integration_auth_attempts
      where organization_id = $1 and id = $2 and initiating_principal_id = $3`,
    [actor.organizationId, id, actor.subject.principalId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

/**
 * integrationAuthAttempts.get: the initiating principal, or a member who may
 * manage auth attempts (an organization Admin), reads the safe status. Anyone else, and any other organization, gets
 * RESOURCE_NOT_FOUND so attempt ids disclose nothing.
 */
export async function getAuthAttempt(
  context: ActionContext,
  input: z.output<typeof contractSchemas.IdPath>,
): Promise<AuthAttempt> {
  const { context: value, actor } = organizationActor(context);
  const result = await value.transaction.query<
    Omit<AuthAttempt, "status"> & { status: string; expired: boolean }
  >(attemptProjection, [actor.organizationId, input.id]);
  const row = result.rows[0];
  if (
    row === undefined ||
    (row.initiatingPrincipalId !== actor.subject.principalId &&
      !managesAttempts(actor))
  ) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const { expired, ...attempt } = row;
  // Expiry is derived on read; the stored status stays pending or
  // exchanging. Every later write agrees: a late setup redirect is refused,
  // and a callback step that finishes past expiry settles failed/expired.
  const lapsed = expired &&
    (attempt.status === "pending" || attempt.status === "exchanging");
  return contractSchemas.IntegrationAuthAttempt.parse({
    ...attempt,
    status: lapsed ? "failed" : attempt.status,
    failureCode: lapsed ? "expired" : attempt.failureCode,
  });
}
