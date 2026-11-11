import { z } from "zod";
import type {
  ActionContext,
  ActionDefinition,
} from "@bakery/contracts/action-registry";
import {
  contractSchemas,
  organizationId,
  principalId,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { appendDomainEvent } from "@bakery/persistence";
import type { AuthorizedActionContext } from "../auth/application/authority.ts";
import type { AuthenticatedSubject } from "../auth/application/identity.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import type { SecretsKeyConfig } from "@bakery/config";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { sha256Hex } from "../../platform/canonical-json.ts";
import {
  decryptAuthAttemptVerifier,
  decryptInstallationSecret,
  loadSecretKey,
  SecretCipherSchema,
} from "../secrets/crypto.ts";
import {
  GITHUB_API_VERSION,
  type GitHubAppClient,
  type GitHubInstallation,
  gitHubOAuthCallbackUrl,
  type GitHubRepository,
  isGitHubOAuthCode,
  parseGitHubInstallationId,
  RepositoryFullNameSchema,
} from "./github-app.ts";
import { managesAttempts } from "./auth-attempts.ts";
import {
  fanOutConnections,
  InstallationStatus,
} from "./installation-fan-out.ts";
import {
  GITHUB_PROVIDER,
  isSelectionTaken,
  requireBrowserSession,
} from "./postgres.ts";

type AuthRedirect = z.output<typeof contractSchemas.AuthRedirect>;

/** Connection setup page the GitHub callbacks return the browser to. */
export const CONNECTION_SETUP_PATH = "/settings/organization/integrations";

/**
 * Coarse callback outcome carried to the setup page; never a provider
 * detail. Failure outcomes double as the attempt's stored failure code.
 */
export const ConnectionOutcome = Object.freeze(
  {
    Pending: "pending",
    AwaitingAuthorization: "awaiting_authorization",
    AwaitingInstallation: "awaiting_installation",
    InstallationRequested: "installation_requested",
    StateRejected: "state_rejected",
    Expired: "expired",
    AuthorizationDenied: "authorization_denied",
    ProviderUnregistered: "provider_unregistered",
    ExchangeFailed: "exchange_failed",
    InstallationListingFailed: "installation_listing_failed",
    RepositoryListingFailed: "repository_listing_failed",
    InstallationUnverified: "installation_unverified",
    InstallationCheckFailed: "installation_check_failed",
    InstallationSuspended: "installation_suspended",
    AdminRequired: "admin_required",
    AlreadyConnected: "already_connected",
    Refreshed: "refreshed",
    ReconnectUnavailable: "reconnect_unavailable",
    StorageFailed: "storage_failed",
  } as const,
);
export type ConnectionOutcome =
  (typeof ConnectionOutcome)[keyof typeof ConnectionOutcome];

/**
 * 303 target: the attempt's Bakery-relative return path (validated when the
 * attempt was created) or the setup page, with only the outcome and, once
 * bound, the new connection id in the query.
 */
export function connectionRedirect(
  outcome: ConnectionOutcome,
  returnPath: string | null = null,
  connectionId?: string,
): AuthRedirect {
  const url = new URL(
    returnPath ?? CONNECTION_SETUP_PATH,
    "https://bakery.invalid",
  );
  url.searchParams.set("githubConnection", outcome);
  if (connectionId !== undefined) {
    url.searchParams.set("connectionId", connectionId);
  }
  return { status: "303", location: `${url.pathname}${url.search}${url.hash}` };
}

/** The browser that presents a state: its principal and session. */
export type CallbackBinding = {
  stateHash: string;
  principalId: string;
  sessionId: string;
};

/**
 * Callbacks act for the browser session only: a Bakery access token is
 * refused, and the state must come back to the principal and session that
 * created the attempt.
 */
export function callbackPrincipal(
  context: ActionContext,
): { principal: AuthenticatedSubject; sessionId: string } {
  if (context.accessToken !== undefined) {
    throw new StandardError({ code: "SESSION_REQUIRED" });
  }
  const principal = context.principal as AuthenticatedSubject | undefined;
  if (!principal?.principalId) {
    throw new StandardError({ code: "AUTH_REQUIRED" });
  }
  return { principal, sessionId: requireBrowserSession(context) };
}

const ATTEMPT_CHANGED = "integration.auth_attempt_changed";

/** Attempt fields a callback step needs; never the state hash or verifier. */
export type CallbackAttempt = {
  id: string;
  organizationId: string;
  initiatingPrincipalId: string;
  returnPath: string | null;
  /** Connection this attempt reconnects, when it is a reconnect. */
  reconnectConnectionId: string | null;
  setupInstallationId: string | null;
  exchanged: boolean;
  verifiedInstallationIds: string[] | null;
  /** True when the hinted installation's repositories were completely scanned. */
  hintDiscovered: boolean;
  version: number;
};

const attemptColumns = `id, organization_id as "organizationId",
  initiating_principal_id as "initiatingPrincipalId",
  return_path as "returnPath",
  reconnect_connection_id as "reconnectConnectionId",
  setup_installation_id as "setupInstallationId",
  exchanged_at is not null as exchanged,
  verified_installation_ids as "verifiedInstallationIds",
  coalesce(discovered_repositories ? setup_installation_id, false)
    as "hintDiscovered",
  version`;

/** Live, unexpired attempt presented by its own principal and session. */
const boundAttempt = `state_hash = $1 and provider = '${GITHUB_PROVIDER}'
  and initiating_principal_id = $2 and session_id = $3
  and expires_at > now()`;

async function attemptChanged(
  transaction: PgTransactionClient,
  context: ActionContext,
  attempt: { id: string; organizationId: string; version: number },
): Promise<void> {
  await appendDomainEvent(transaction, {
    organizationId: attempt.organizationId,
    eventType: ATTEMPT_CHANGED,
    aggregateId: attempt.id,
    aggregateVersion: attempt.version,
    payload: { resourceId: attempt.id, resourceVersion: attempt.version },
    traceId: context.traceId,
  });
}

async function audit(
  transaction: PgTransactionClient,
  context: ActionContext,
  operation: string,
  attempt: {
    id: string;
    organizationId: string;
    initiatingPrincipalId: string;
  },
  resource: { type: string; id: string },
  details: Record<string, unknown>,
): Promise<void> {
  await recordAuthAudit(transaction, context, {
    organizationId: attempt.organizationId,
    principalId: attempt.initiatingPrincipalId,
    operation,
    resourceType: resource.type,
    resourceId: resource.id,
    details: { provider: GITHUB_PROVIDER, attemptId: attempt.id, ...details },
  });
}

/**
 * integrationAuth.githubSetup, first half: records the installation hint
 * once on a pending or exchanging attempt. The hint proves nothing yet; the
 * returned attempt says whether the OAuth callback already verified the
 * user's installations, in which case this request binds.
 */
export async function recordSetupHint(
  transaction: PgTransactionClient,
  context: ActionContext,
  operation: string,
  binding: CallbackBinding,
  installationId: string,
): Promise<CallbackAttempt | null> {
  const result = await transaction.query<CallbackAttempt>(
    `update bakery.integration_auth_attempts
        set setup_installation_id = $4, setup_received_at = now(),
            version = version + 1, updated_at = now()
      where ${boundAttempt}
        and status in ('pending', 'exchanging') and setup_received_at is null
      returning ${attemptColumns}`,
    [binding.stateHash, binding.principalId, binding.sessionId, installationId],
  );
  const attempt = result.rows[0];
  if (attempt === undefined) return null;
  await attemptChanged(transaction, context, attempt);
  await audit(transaction, context, operation, attempt, {
    type: "integration_auth_attempt",
    id: attempt.id,
  }, { step: "setup_hint", installationId, version: attempt.version });
  return attempt;
}

/** Registered App identity and its encrypted credentials, as stored. */
type StoredSecret = {
  secretId: string;
  revision: number;
  keyId: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
};
export type AppCredentials = {
  registrationId: string;
  appId: number;
  clientId: string;
  clientSecret: StoredSecret;
  privateKey: StoredSecret;
};

/** Reads the registered App and its active client secret and private key versions. */
export async function readAppCredentials(
  transaction: PgTransactionClient,
): Promise<AppCredentials | null> {
  const result = await transaction.query<{
    registrationId: string;
    appId: string;
    clientId: string;
    clientSecretId: string;
    clientRevision: number;
    clientKeyId: string;
    clientCiphertext: Uint8Array;
    clientNonce: Uint8Array;
    keySecretId: string;
    keyRevision: number;
    keyKeyId: string;
    keyCiphertext: Uint8Array;
    keyNonce: Uint8Array;
  }>(
    `select registration.id as "registrationId",
       registration.external_app_id::text as "appId",
       registration.client_id as "clientId",
       client.id as "clientSecretId", client_version.revision as "clientRevision",
       client_version.key_id as "clientKeyId",
       client_version.ciphertext as "clientCiphertext",
       client_version.nonce as "clientNonce",
       private_key.id as "keySecretId", key_version.revision as "keyRevision",
       key_version.key_id as "keyKeyId",
       key_version.ciphertext as "keyCiphertext", key_version.nonce as "keyNonce"
     from bakery.integration_app_registrations as registration
     join bakery.secrets as client on client.id = registration.client_secret_id
       and client.organization_id is null and client.application_id is null
     join bakery.secret_versions as client_version
       on client_version.id = client.active_version_id
       and client_version.secret_id = client.id
     join bakery.secrets as private_key
       on private_key.id = registration.private_key_secret_id
       and private_key.organization_id is null
       and private_key.application_id is null
     join bakery.secret_versions as key_version
       on key_version.id = private_key.active_version_id
       and key_version.secret_id = private_key.id
     where registration.provider = $1`,
    [GITHUB_PROVIDER],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    registrationId: row.registrationId,
    appId: Number(row.appId),
    clientId: row.clientId,
    clientSecret: {
      secretId: row.clientSecretId,
      revision: row.clientRevision,
      keyId: row.clientKeyId,
      ciphertext: row.clientCiphertext,
      nonce: row.clientNonce,
    },
    privateKey: {
      secretId: row.keySecretId,
      revision: row.keyRevision,
      keyId: row.keyKeyId,
      ciphertext: row.keyCiphertext,
      nonce: row.keyNonce,
    },
  };
}

/** Decrypts one installation-owned App credential under its own binding. */
export async function openAppSecret(
  key: CryptoKey,
  secret: StoredSecret,
): Promise<string> {
  const bytes = await decryptInstallationSecret(
    key,
    {
      secretId: secret.secretId,
      revision: secret.revision,
      keyId: secret.keyId,
    },
    SecretCipherSchema.parse({
      ciphertext: secret.ciphertext,
      nonce: secret.nonce,
    }),
  );
  try {
    return new TextDecoder().decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

export type CallbackClaim = CallbackAttempt & {
  stateHash: string;
  verifierCiphertext: Uint8Array;
  verifierNonce: Uint8Array;
  verifierKeyId: string;
};

/**
 * integrationAuth.githubCallback, first step: moves the attempt from pending
 * to exchanging in one conditional update, committed before any GitHub call.
 * A consumed, expired, unknown or foreign state matches nothing.
 */
export async function claimCallback(
  transaction: PgTransactionClient,
  context: ActionContext,
  binding: CallbackBinding,
): Promise<CallbackClaim | null> {
  const result = await transaction.query<CallbackClaim>(
    `update bakery.integration_auth_attempts
        set status = 'exchanging', consumed_at = now(),
            version = version + 1, updated_at = now()
      where ${boundAttempt} and status = 'pending' and consumed_at is null
      returning ${attemptColumns}, state_hash as "stateHash",
        pkce_verifier_ciphertext as "verifierCiphertext",
        pkce_verifier_nonce as "verifierNonce",
        pkce_key_id as "verifierKeyId"`,
    [binding.stateHash, binding.principalId, binding.sessionId],
  );
  const claim = result.rows[0];
  if (claim === undefined) return null;
  await attemptChanged(transaction, context, claim);
  return claim;
}

/** Decrypts the PKCE verifier bound to this attempt and state. */
export async function openVerifier(
  key: CryptoKey,
  claim: CallbackClaim,
): Promise<string> {
  const bytes = await decryptAuthAttemptVerifier(
    key,
    {
      organizationId: claim.organizationId,
      attemptId: claim.id,
      stateHash: claim.stateHash,
      keyId: claim.verifierKeyId,
    },
    SecretCipherSchema.parse({
      ciphertext: claim.verifierCiphertext,
      nonce: claim.verifierNonce,
    }),
  );
  try {
    return new TextDecoder().decode(bytes);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Fails an exchanging attempt with a safe code and drops any verified ids.
 * The state is already consumed, so the user starts a new attempt.
 */
export async function failAttempt(
  transaction: PgTransactionClient,
  context: ActionContext,
  operation: string,
  attemptId: string,
  outcome: ConnectionOutcome,
): Promise<{ returnPath: string | null; outcome: ConnectionOutcome } | null> {
  // Reads derive expired for an exchanging attempt past its expiry, so a
  // failure settled after that point is stored as expired too.
  const result = await transaction.query<
    CallbackAttempt & { failureCode: ConnectionOutcome }
  >(
    `update bakery.integration_auth_attempts
        set status = 'failed',
            failure_code = case when expires_at <= now() then $3 else $2 end,
            verified_installation_ids = null, discovered_repositories = null,
            version = version + 1, updated_at = now()
      where id = $1 and status = 'exchanging'
      returning ${attemptColumns}, failure_code as "failureCode"`,
    [attemptId, outcome, ConnectionOutcome.Expired],
  );
  const attempt = result.rows[0];
  if (attempt === undefined) return null;
  await attemptChanged(transaction, context, attempt);
  await audit(transaction, context, operation, attempt, {
    type: "integration_auth_attempt",
    id: attempt.id,
  }, {
    step: "failed",
    failureCode: attempt.failureCode,
    version: attempt.version,
  });
  return { returnPath: attempt.returnPath, outcome: attempt.failureCode };
}

/** One repository the connecting user administers, as kept until the bind. */
export const DiscoveredRepositorySchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(
    "Numeric GitHub repository id; the resource's provider identity.",
  ),
  // Rechecked at the bind: the safe URL is built from this value.
  fullName: RepositoryFullNameSchema,
  private: z.boolean().describe("Whether the repository is private."),
  archived: z.boolean().describe("Whether the repository is archived."),
}).describe(
  "Identity of one administered repository; unknown fields are dropped, and no token or provider URL is kept.",
);
export type DiscoveredRepository = z.output<typeof DiscoveredRepositorySchema>;

/**
 * Administered repositories per completely scanned installation id. An
 * installation whose scan failed or was cut short has no key; one whose
 * user administers nothing has an empty list.
 */
export type DiscoveredRepositories = Record<string, DiscoveredRepository[]>;

/**
 * Records the ids of every installation of the registered App the user token
 * could access, the administered repositories of each scanned installation,
 * and that the listing finished. The token itself is never passed here.
 * Returns the attempt, whose setup hint (if setup came first) means this
 * request binds.
 */
export async function recordVerifiedInstallations(
  transaction: PgTransactionClient,
  context: ActionContext,
  attemptId: string,
  installationIds: string[],
  discovered: DiscoveredRepositories,
): Promise<CallbackAttempt | null> {
  const result = await transaction.query<CallbackAttempt>(
    `update bakery.integration_auth_attempts
        set exchanged_at = now(), verified_installation_ids = $2::jsonb,
            discovered_repositories = $3::jsonb,
            version = version + 1, updated_at = now()
      where id = $1 and status = 'exchanging' and exchanged_at is null
        and expires_at > now()
      returning ${attemptColumns}`,
    [attemptId, JSON.stringify(installationIds), JSON.stringify(discovered)],
  );
  const attempt = result.rows[0];
  if (attempt === undefined) return null;
  await attemptChanged(transaction, context, attempt);
  return attempt;
}

/** Request-private input to the binding transaction; never logged or returned. */
export type BindingPreparation = {
  attemptId: string;
  registrationId: string;
  installation: GitHubInstallation;
};

/**
 * True when the principal is still a current Admin of the organization.
 * The membership, its custom role and the principal are share-locked first,
 * so a demotion, removal, role edit or disable cannot commit between this
 * check and the connection insert in the same transaction; one already
 * committed is read after the lock. Capability grants and the SCIM link are
 * read at statement time but not locked: the application role holds no
 * UPDATE privilege on them, which row locks require.
 */
async function isCurrentAdmin(
  transaction: PgTransactionClient,
  principal: string,
  organization: string,
): Promise<boolean> {
  const membership = await transaction.query<{ customRoleId: string | null }>(
    `select custom_role_id as "customRoleId"
       from bakery.organization_memberships
      where organization_id = $1 and principal_id = $2
      for share`,
    [organization, principal],
  );
  const row = membership.rows[0];
  if (row === undefined) return false;
  if (row.customRoleId !== null) {
    await transaction.query(
      `select 1 from bakery.organization_roles
        where organization_id = $1 and id = $2 for share`,
      [organization, row.customRoleId],
    );
  }
  await transaction.query(
    "select 1 from bakery.principals where id = $1 for share",
    [principal],
  );
  try {
    const actor = await resolveOrganizationActor(
      transaction,
      principalId(principal),
      organizationId(organization),
    );
    return managesAttempts(actor);
  } catch (error) {
    if (error instanceof StandardError) return false;
    throw error;
  }
}

/**
 * The binding transaction. Locks the attempt, rechecks that the hint is one
 * of the verified installations, that its repositories were completely
 * scanned and that the initiating principal is still an Admin, then stores
 * the installation, one pending connection, its administered repositories as
 * available unselected resources and the completed attempt with audit and
 * events, or fails the attempt and binds nothing.
 */
export async function bindConnection(
  context: ActionContext,
  operation: string,
  prepared: BindingPreparation,
): Promise<AuthRedirect> {
  const value = context as Partial<AuthorizedActionContext>;
  if (!value.transaction) throw new StandardError({ code: "INTERNAL" });
  const transaction = value.transaction;
  const locked = await transaction.query<
    CallbackAttempt & { expired: boolean; repositories: unknown }
  >(
    `select ${attemptColumns}, expires_at <= now() as expired,
       discovered_repositories -> setup_installation_id as repositories
       from bakery.integration_auth_attempts
      where id = $1 and status = 'exchanging' and exchanged_at is not null
        and setup_received_at is not null
      for update`,
    [prepared.attemptId],
  );
  const attempt = locked.rows[0];
  if (attempt === undefined) {
    return connectionRedirect(ConnectionOutcome.StateRejected);
  }
  const fail = async (outcome: ConnectionOutcome) => {
    const failed = await failAttempt(
      transaction,
      context,
      operation,
      attempt.id,
      outcome,
    );
    return connectionRedirect(failed?.outcome ?? outcome, attempt.returnPath);
  };
  // Reads derive expiry for exchanging attempts; storage must agree, so a
  // binding that outlived the attempt settles expired instead of completing.
  if (attempt.expired) return await fail(ConnectionOutcome.Expired);
  const installation = prepared.installation;
  if (
    attempt.setupInstallationId !== String(installation.id) ||
    !(attempt.verifiedInstallationIds ?? []).includes(String(installation.id))
  ) {
    return await fail(ConnectionOutcome.InstallationUnverified);
  }
  // Only a complete scan of the bound installation may seed its resources.
  const scanned = attempt.repositories === null
    ? null
    : z.array(DiscoveredRepositorySchema).describe(
      "Administered repositories of the bound installation.",
    ).safeParse(attempt.repositories);
  if (!scanned?.success) {
    return await fail(ConnectionOutcome.RepositoryListingFailed);
  }
  const repositories = scanned.data;
  if (
    !await isCurrentAdmin(
      transaction,
      attempt.initiatingPrincipalId,
      attempt.organizationId,
    )
  ) {
    return await fail(ConnectionOutcome.AdminRequired);
  }

  const externalId = String(installation.id);
  const accountId = String(installation.account.id);
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.integration_installations (
       id, provider, registration_id, external_authorization_id,
       external_account_id, account_login, account_type, repository_selection,
       granted_permissions, status
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'enabled')
     on conflict on constraint integration_installations_identity_unique
     do nothing
     returning id`,
    [
      crypto.randomUUID(),
      GITHUB_PROVIDER,
      prepared.registrationId,
      externalId,
      accountId,
      installation.account.login,
      installation.account.type,
      installation.repositorySelection,
      JSON.stringify(installation.permissions),
    ],
  );
  let installationId = inserted.rows[0]?.id;
  if (installationId === undefined) {
    const existing = await transaction.query<
      { id: string; externalAccountId: string; status: string }
    >(
      `select id, external_account_id as "externalAccountId", status
         from bakery.integration_installations
        where registration_id = $1 and external_authorization_id = $2
        for update`,
      [prepared.registrationId, externalId],
    );
    const row = existing.rows[0];
    // The account behind an installation id never changes on GitHub.
    if (row === undefined || row.externalAccountId !== accountId) {
      return await fail(ConnectionOutcome.InstallationUnverified);
    }
    // Revoked is terminal: GitHub never reuses a deleted installation's id,
    // so setup never brings the row back.
    if (row.status === InstallationStatus.Revoked) {
      return await fail(ConnectionOutcome.InstallationUnverified);
    }
    installationId = row.id;
    await transaction.query(
      `update bakery.integration_installations
          set account_login = $2, repository_selection = $3,
              granted_permissions = $4::jsonb, status = 'enabled',
              version = version + 1, updated_at = now()
        where id = $1`,
      [
        installationId,
        installation.account.login,
        installation.repositorySelection,
        JSON.stringify(installation.permissions),
      ],
    );
    // GitHub reports it active again: like a reconcile that observes the
    // unsuspend, clear the suspension from its connections and leave them
    // for the sweep to revalidate.
    if (row.status === InstallationStatus.Suspended) {
      const connections = await fanOutConnections(
        transaction,
        installationId,
        InstallationStatus.Suspended,
        InstallationStatus.Enabled,
        context.traceId,
        {
          operation,
          actor: {
            organizationId: attempt.organizationId,
            principalId: attempt.initiatingPrincipalId,
          },
        },
      );
      await audit(
        transaction,
        context,
        operation,
        attempt,
        { type: "integration_installation", id: installationId },
        {
          installation: {
            from: InstallationStatus.Suspended,
            to: InstallationStatus.Enabled,
          },
          connections,
        },
      );
    }
  }

  if (attempt.reconnectConnectionId !== null) {
    const target = await transaction.query<{
      externalAuthorizationId: string;
      externalAccountId: string;
      archived: boolean;
    }>(
      `select external_authorization_id as "externalAuthorizationId",
         external_account_id as "externalAccountId",
         archived_at is not null as archived
         from bakery.integration_connections
        where organization_id = $1 and id = $2 and provider = $3
        for update`,
      [attempt.organizationId, attempt.reconnectConnectionId, GITHUB_PROVIDER],
    );
    const row = target.rows[0];
    if (row === undefined || row.archived) {
      return await fail(ConnectionOutcome.ReconnectUnavailable);
    }
    // Identity is the verified account. A different account never rebinds
    // the target: it falls through to a new pending connection below.
    if (row.externalAccountId === accountId) {
      return await refreshConnection(
        attempt.reconnectConnectionId,
        installationId,
        row.externalAuthorizationId !== externalId,
      );
    }
  }

  const connection = await transaction.query<{ id: string; version: number }>(
    `insert into bakery.integration_connections (
       id, organization_id, provider, installation_id,
       external_authorization_id, external_account_id, label,
       adapter_version, granted_permissions, status, health, created_by
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending',
       'unknown', $10)
     on conflict (organization_id, installation_id) where archived_at is null
     do nothing
     returning id, version`,
    [
      crypto.randomUUID(),
      attempt.organizationId,
      GITHUB_PROVIDER,
      installationId,
      externalId,
      accountId,
      installation.account.login,
      `${GITHUB_PROVIDER}@${GITHUB_API_VERSION}`,
      JSON.stringify(installation.permissions),
      attempt.initiatingPrincipalId,
    ],
  );
  const created = connection.rows[0];
  if (created === undefined) {
    return await fail(ConnectionOutcome.AlreadyConnected);
  }
  if (repositories.length > 0) {
    // New discovery is available and unselected; selection is an Admin step.
    await transaction.query(
      `insert into bakery.integration_resources (
         id, organization_id, connection_id, installation_id, kind,
         external_id, display_name, safe_url, capability_snapshot,
         last_discovery_generation
       )
       select resource.id, $1, $2, $3, 'repository', resource.external_id,
         resource.display_name, resource.safe_url,
         jsonb_build_object('private', resource.private,
           'archived', resource.archived),
         1
         from unnest($4::uuid[], $5::text[], $6::text[], $7::text[],
           $8::boolean[], $9::boolean[])
           as resource(id, external_id, display_name, safe_url, private,
             archived)`,
      [
        attempt.organizationId,
        created.id,
        installationId,
        repositories.map(() => crypto.randomUUID()),
        repositories.map((repository) => String(repository.id)),
        repositories.map((repository) => repository.fullName),
        repositories.map((repository) => gitHubRepositoryUrl(repository)),
        repositories.map((repository) => repository.private),
        repositories.map((repository) => repository.archived),
      ],
    );
  }
  await completeAttempt(created.id, {
    step: "bound",
    status: "pending",
    installationId: externalId,
    accountId,
    accountLogin: installation.account.login,
    repositories: repositories.length,
    reconnectConnectionId: attempt.reconnectConnectionId,
  });
  return connectionRedirect(
    ConnectionOutcome.Pending,
    attempt.returnPath,
    created.id,
  );

  /**
   * Completes the attempt with its result connection, clears the callback
   * results, and records the event and the audit row for the bind step.
   */
  async function completeAttempt(
    connectionId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const completed = await transaction.query<{ version: number }>(
      `update bakery.integration_auth_attempts
          set status = 'completed', result_connection_id = $2,
              verified_installation_ids = null, discovered_repositories = null,
              version = version + 1, updated_at = now()
        where id = $1 and status = 'exchanging'
        returning version`,
      [attempt.id, connectionId],
    );
    if (completed.rows.length !== 1) {
      throw new StandardError({ code: "INTERNAL" });
    }
    await attemptChanged(transaction, context, {
      ...attempt,
      version: completed.rows[0].version,
    });
    await audit(transaction, context, operation, attempt, {
      type: "integration_connection",
      id: connectionId,
    }, details);
  }

  /**
   * Same verified account: the target keeps its id and account and gains a
   * new authorization revision with the installation's current permissions;
   * a revoked target returns to pending. A same-account reinstall arrives as
   * a new installation id, so the target moves to it (its resources follow
   * by ON UPDATE CASCADE); the composite installation-identity key and the
   * ungranted account column make a move to another account impossible.
   * Resources are not rediscovered here: after a reinstall they keep the
   * availability the last complete discovery recorded, and the connection
   * check and token broker children (#486-#488) recheck what the new
   * installation still grants before any resource is used.
   */
  async function refreshConnection(
    connectionId: string,
    installationRowId: string,
    reinstalled: boolean,
  ): Promise<AuthRedirect> {
    if (reinstalled) {
      const held = await transaction.query(
        `select 1 from bakery.integration_connections
          where organization_id = $1 and installation_id = $2
            and archived_at is null and id <> $3`,
        [attempt.organizationId, installationRowId, connectionId],
      );
      if (held.rows.length > 0) {
        return await fail(ConnectionOutcome.AlreadyConnected);
      }
    }
    // A reinstall carries the connection's selections to the new
    // installation, where another organization may already hold one of the
    // same repositories (migration 0137). That refusal names nobody.
    await transaction.query("savepoint reconnect_move");
    const refreshed = await transaction.query<{
      version: number;
      authorizationRevision: number;
      status: string;
    }>(
      `update bakery.integration_connections
          set installation_id = $3, external_authorization_id = $4,
              granted_permissions = $5::jsonb,
              authorization_revision = authorization_revision + 1,
              status = case when status = 'revoked' then 'pending'
                else status end,
              version = version + 1, updated_at = now()
        where organization_id = $1 and id = $2 and external_account_id = $6
        returning version, authorization_revision as "authorizationRevision",
          status`,
      [
        attempt.organizationId,
        connectionId,
        installationRowId,
        externalId,
        JSON.stringify(installation.permissions),
        accountId,
      ],
    ).catch((error: unknown) => {
      if (!isSelectionTaken(error)) throw error;
      return null;
    });
    if (refreshed === null) {
      await transaction.query("rollback to savepoint reconnect_move");
      return await fail(ConnectionOutcome.ReconnectUnavailable);
    }
    await transaction.query("release savepoint reconnect_move");
    const updated = refreshed.rows[0];
    if (updated === undefined) throw new StandardError({ code: "INTERNAL" });
    await completeAttempt(connectionId, {
      step: "refreshed",
      status: updated.status,
      installationId: externalId,
      accountId,
      reinstalled,
      authorizationRevision: updated.authorizationRevision,
      version: updated.version,
    });
    return connectionRedirect(
      ConnectionOutcome.Refreshed,
      attempt.returnPath,
      connectionId,
    );
  }
}

/** Listing pages read before an incomplete listing fails verification. */
export const MAX_INSTALLATION_PAGES = 50;

/**
 * Ids of every installation of the registered App the user token can access,
 * across every page. A listing that does not end within the page cap never
 * verifies anything.
 */
async function listInstallationIds(
  github: GitHubAppClient,
  accessToken: string,
  appId: number,
  signal: AbortSignal,
): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const result = await github.listUserInstallations(
      accessToken,
      page,
      signal,
    );
    for (const installation of result.installations) {
      if (installation.appId === appId) ids.add(String(installation.id));
    }
    if (!result.hasNext) return [...ids];
  }
  throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
}

/** Repository listing pages read per installation before its scan is dropped. */
export const MAX_REPOSITORY_PAGES = 50;
/** Repository listing pages read per callback across every installation. */
export const MAX_DISCOVERY_PAGES = 100;

/**
 * The repository page the bind will offer, built from the validated full
 * name; the provider's own URL is never stored.
 */
export function gitHubRepositoryUrl(repository: { fullName: string }): string {
  return `https://github.com/${repository.fullName}`;
}

/**
 * Installations to scan: the setup hint alone once setup named a verified
 * one, otherwise every verified installation, since the token is gone by the
 * time setup names one.
 */
export function discoveryTargets(
  hint: string | null,
  installationIds: string[],
): string[] {
  return hint !== null && installationIds.includes(hint)
    ? [hint]
    : installationIds;
}

/**
 * Scans each target installation's repositories with the user token, every
 * page, keeping only those the user administers. A scan that fails or
 * outruns a page cap is dropped (no key), so the bind of that installation
 * fails instead of recording a partial set; later installations are not
 * scanned once the per-callback cap is spent.
 */
async function discoverRepositories(
  github: GitHubAppClient,
  accessToken: string,
  installationIds: string[],
  signal: AbortSignal,
  onFailure: (error: unknown) => void,
): Promise<DiscoveredRepositories> {
  const discovered: DiscoveredRepositories = {};
  let budget = MAX_DISCOVERY_PAGES;
  for (const installationId of installationIds) {
    const id = Number(installationId);
    const administered = new Map<number, GitHubRepository>();
    let complete = false;
    try {
      for (
        let page = 1;
        page <= MAX_REPOSITORY_PAGES && budget > 0;
        page++
      ) {
        budget -= 1;
        const result = await github.listUserInstallationRepositories(
          accessToken,
          id,
          page,
          signal,
        );
        for (const repository of result.repositories) {
          if (repository.admin) administered.set(repository.id, repository);
        }
        if (!result.hasNext) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
    } catch (error) {
      onFailure(error);
      if (budget <= 0) break;
      continue;
    }
    discovered[installationId] = [...administered.values()].map((
      repository,
    ) => ({
      id: repository.id,
      fullName: repository.fullName,
      private: repository.private,
      archived: repository.archived,
    }));
  }
  return discovered;
}

type CallbackStage =
  | "exchange"
  | "list_installations"
  | "list_repositories"
  | "get_installation"
  | "bind"
  | "record_outcome";

/**
 * One structured line per swallowed failure: stage, outcome, error class and
 * problem code only. Never the code, state, token, provider body or message.
 */
function logCallbackFailure(
  context: ActionContext,
  stage: CallbackStage,
  outcome: ConnectionOutcome,
  error: unknown,
) {
  console.warn(JSON.stringify({
    component: "integrations",
    event: "github_connection_failed",
    stage,
    outcome,
    errorClass: error instanceof Error ? error.name : typeof error,
    code: error instanceof StandardError ? error.code : null,
    requestId: context.requestId,
    traceId: context.traceId,
  }));
}

const bindingSlot = Symbol("private GitHub connection binding preparation");
type BindingContext = ActionContext & { [bindingSlot]?: BindingPreparation };

/** The preparation the callback runner attached for the binding handler. */
export function bindingPreparation(context: ActionContext): BindingPreparation {
  const prepared = (context as BindingContext)[bindingSlot];
  if (!prepared) throw new StandardError({ code: "INTERNAL" });
  return prepared;
}

export type CallbackDependencies = {
  publicBaseUrl: string;
  secretsKey?: SecretsKeyConfig;
  github: GitHubAppClient;
};

type Next = (authorizedContext: ActionContext) => Promise<unknown>;

/**
 * Authority and sequencing for integrationAuth.githubSetup and
 * integrationAuth.githubCallback (organization context derived from the
 * bound attempt). Every step commits on its own before GitHub is called:
 * 1. setup records its hint once; the callback claims pending to exchanging;
 * 2. the callback exchanges the code, lists every page of installations and
 *    of the target installations' repositories outside any transaction,
 *    keeping only the verified ids and the administered repositories, then
 *    drops the token;
 * 3. whichever request finds both the hint and the verified ids reads the
 *    installation with App authority and binds through `next` in a fresh
 *    transaction that rechecks the Admin.
 * A refused state writes nothing and redirects with state_rejected.
 */
export function createGitHubCallbackRunner(
  database: PgDatabase,
  dependencies: CallbackDependencies,
) {
  const inTransaction = <T>(
    run: (transaction: PgTransactionClient) => Promise<T>,
  ) => withPgTransaction(database, run);

  /** Fails the attempt; a failure here is logged and never masks the redirect. */
  const settle = async (
    context: ActionContext,
    operation: string,
    attempt: { id: string; returnPath: string | null },
    outcome: ConnectionOutcome,
  ): Promise<AuthRedirect> => {
    let stored = outcome;
    try {
      const failed = await inTransaction((transaction) =>
        failAttempt(transaction, context, operation, attempt.id, outcome)
      );
      stored = failed?.outcome ?? outcome;
    } catch (error) {
      logCallbackFailure(context, "record_outcome", outcome, error);
    }
    return connectionRedirect(stored, attempt.returnPath);
  };

  /** Second half present: verify with App authority, then bind. */
  const complete = async (
    context: ActionContext,
    operation: string,
    attempt: CallbackAttempt,
    principal: AuthenticatedSubject,
    next: Next,
  ): Promise<AuthRedirect> => {
    const hint = attempt.setupInstallationId;
    const installationId = hint === null
      ? null
      : parseGitHubInstallationId(hint);
    if (
      hint === null || installationId === null ||
      !(attempt.verifiedInstallationIds ?? []).includes(hint)
    ) {
      return await settle(
        context,
        operation,
        attempt,
        ConnectionOutcome.InstallationUnverified,
      );
    }
    if (!attempt.hintDiscovered) {
      return await settle(
        context,
        operation,
        attempt,
        ConnectionOutcome.RepositoryListingFailed,
      );
    }
    let credentials: AppCredentials | null;
    try {
      credentials = await inTransaction(readAppCredentials);
    } catch (error) {
      logCallbackFailure(
        context,
        "bind",
        ConnectionOutcome.StorageFailed,
        error,
      );
      return await settle(
        context,
        operation,
        attempt,
        ConnectionOutcome.StorageFailed,
      );
    }
    if (credentials === null) {
      return await settle(
        context,
        operation,
        attempt,
        ConnectionOutcome.ProviderUnregistered,
      );
    }
    let installation: GitHubInstallation;
    try {
      const key = await loadSecretKey(dependencies.secretsKey);
      installation = await dependencies.github.getInstallation({
        appId: credentials.appId,
        privateKeyPem: await openAppSecret(key, credentials.privateKey),
        installationId,
      }, context.signal);
    } catch (error) {
      logCallbackFailure(
        context,
        "get_installation",
        ConnectionOutcome.InstallationCheckFailed,
        error,
      );
      return await settle(
        context,
        operation,
        attempt,
        ConnectionOutcome.InstallationCheckFailed,
      );
    }
    if (
      installation.id !== installationId ||
      installation.appId !== credentials.appId
    ) {
      return await settle(
        context,
        operation,
        attempt,
        ConnectionOutcome.InstallationUnverified,
      );
    }
    if (installation.suspended) {
      return await settle(
        context,
        operation,
        attempt,
        ConnectionOutcome.InstallationSuspended,
      );
    }
    const prepared: BindingPreparation = {
      attemptId: attempt.id,
      registrationId: credentials.registrationId,
      installation,
    };
    try {
      return await inTransaction((transaction) =>
        next(
          Object.assign({}, context, {
            principal,
            authority: principal,
            transaction,
            [bindingSlot]: prepared,
          }) as BindingContext,
        )
      ) as AuthRedirect;
    } catch (error) {
      logCallbackFailure(
        context,
        "bind",
        ConnectionOutcome.StorageFailed,
        error,
      );
      return await settle(
        context,
        operation,
        attempt,
        ConnectionOutcome.StorageFailed,
      );
    }
  };

  const setup = async (
    action: ActionDefinition,
    context: ActionContext,
    input: unknown,
    next: Next,
  ): Promise<AuthRedirect> => {
    const parsed = contractSchemas.GitHubSetupCallback.parse(input);
    const { principal, sessionId } = callbackPrincipal(context);
    // setup_action=request: an owner must still approve the install, so
    // there is nothing to record yet.
    if (parsed.installationId === undefined) {
      return connectionRedirect(ConnectionOutcome.InstallationRequested);
    }
    if (parseGitHubInstallationId(parsed.installationId) === null) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const binding = {
      stateHash: await sha256Hex(parsed.state),
      principalId: principal.principalId,
      sessionId,
    };
    const attempt = await inTransaction((transaction) =>
      recordSetupHint(
        transaction,
        context,
        action.name,
        binding,
        parsed.installationId!,
      )
    );
    if (attempt === null) {
      return connectionRedirect(ConnectionOutcome.StateRejected);
    }
    if (!attempt.exchanged) {
      return connectionRedirect(
        ConnectionOutcome.AwaitingAuthorization,
        attempt.returnPath,
      );
    }
    // The hint is now recorded and the code already spent: a browser
    // disconnect must not cancel the installation read or the binding.
    return await complete(
      { ...context, signal: new AbortController().signal },
      action.name,
      attempt,
      principal,
      next,
    );
  };

  const callback = async (
    action: ActionDefinition,
    context: ActionContext,
    input: unknown,
    next: Next,
  ): Promise<AuthRedirect> => {
    const parsed = contractSchemas.OAuthCallback.parse(input);
    if (
      parsed.code === undefined
        ? parsed.error === undefined
        : !isGitHubOAuthCode(parsed.code)
    ) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const { principal, sessionId } = callbackPrincipal(context);
    const claim = await inTransaction(async (transaction) =>
      claimCallback(transaction, context, {
        stateHash: await sha256Hex(parsed.state),
        principalId: principal.principalId,
        sessionId,
      })
    );
    if (claim === null) {
      return connectionRedirect(ConnectionOutcome.StateRejected);
    }
    const fail = (outcome: ConnectionOutcome) =>
      settle(context, action.name, claim, outcome);
    if (parsed.code === undefined || parsed.error !== undefined) {
      return await fail(ConnectionOutcome.AuthorizationDenied);
    }
    let credentials: AppCredentials | null;
    try {
      credentials = await inTransaction(readAppCredentials);
    } catch (error) {
      logCallbackFailure(
        context,
        "exchange",
        ConnectionOutcome.StorageFailed,
        error,
      );
      return await fail(ConnectionOutcome.StorageFailed);
    }
    if (credentials === null) {
      return await fail(ConnectionOutcome.ProviderUnregistered);
    }
    // The claim spent the state and the code is single-use: a browser
    // disconnect must not cancel the exchange; the client keeps its timeout.
    const signal = new AbortController().signal;
    let accessToken: string;
    try {
      const key = await loadSecretKey(dependencies.secretsKey);
      ({ accessToken } = await dependencies.github.exchangeCode({
        clientId: credentials.clientId,
        clientSecret: await openAppSecret(key, credentials.clientSecret),
        code: parsed.code,
        codeVerifier: await openVerifier(key, claim),
        redirectUri: gitHubOAuthCallbackUrl(dependencies.publicBaseUrl),
      }, signal));
    } catch (error) {
      // Whether GitHub spent the code is unknown: fresh authorization only.
      logCallbackFailure(
        context,
        "exchange",
        ConnectionOutcome.ExchangeFailed,
        error,
      );
      return await fail(ConnectionOutcome.ExchangeFailed);
    }
    let installationIds: string[];
    let discovered: DiscoveredRepositories;
    try {
      installationIds = await listInstallationIds(
        dependencies.github,
        accessToken,
        credentials.appId,
        signal,
      );
      discovered = await discoverRepositories(
        dependencies.github,
        accessToken,
        discoveryTargets(claim.setupInstallationId, installationIds),
        signal,
        (error) =>
          logCallbackFailure(
            context,
            "list_repositories",
            ConnectionOutcome.RepositoryListingFailed,
            error,
          ),
      );
    } catch (error) {
      logCallbackFailure(
        context,
        "list_installations",
        ConnectionOutcome.InstallationListingFailed,
        error,
      );
      return await fail(ConnectionOutcome.InstallationListingFailed);
    } finally {
      // Setup-only user token: never stored, logged or kept past the
      // installation and repository listings.
      accessToken = "";
    }
    let attempt: CallbackAttempt | null;
    try {
      attempt = await inTransaction((transaction) =>
        recordVerifiedInstallations(
          transaction,
          context,
          claim.id,
          installationIds,
          discovered,
        )
      );
    } catch (error) {
      logCallbackFailure(
        context,
        "list_installations",
        ConnectionOutcome.StorageFailed,
        error,
      );
      return await fail(ConnectionOutcome.StorageFailed);
    }
    if (attempt === null) {
      // The listing outlived the attempt: settle it expired, as reads show.
      return await fail(ConnectionOutcome.Expired);
    }
    if (attempt.setupInstallationId === null) {
      return connectionRedirect(
        ConnectionOutcome.AwaitingInstallation,
        attempt.returnPath,
      );
    }
    return await complete(
      { ...context, signal },
      action.name,
      attempt,
      principal,
      next,
    );
  };

  return { setup, callback };
}
