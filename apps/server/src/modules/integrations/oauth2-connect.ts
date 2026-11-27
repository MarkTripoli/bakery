import { z } from "zod";
import type {
  ActionContext,
  ActionDefinition,
} from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { SecretsKeyConfig } from "@bakery/config";
import type {
  ConnectedResource,
  ConnectRefusal,
  Identity,
  OAuth2Profile,
  ProviderRequestPort,
  SignedEventSource,
} from "@bakery/integration-sdk/provider";
import type { AuthorizedActionContext } from "../auth/application/authority.ts";
import type { AuthenticatedSubject } from "../auth/application/identity.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { sha256Hex } from "../../platform/canonical-json.ts";
import { loadSecretKey } from "../secrets/crypto.ts";
import {
  openInstallationSecret,
  readInstallationSecretRevision,
  sealInstallationSecret,
  writeInstallationSecretVersion,
} from "../secrets/installation-secrets.ts";
import {
  attemptChanged,
  audit,
  type CallbackAttempt,
  callbackPrincipal,
  claimCallback,
  ConnectionOutcome,
  connectionRedirect,
  failAttempt,
  isCurrentAdmin,
  openVerifier,
} from "./callbacks.ts";
import {
  providerCallbackUrl,
  readStoredClientCredentials,
} from "./client-credentials.ts";
import { encodeSecretSlots } from "./provider-credential-port.ts";
import { bindConnectedResource } from "./connected-resource.ts";
import { connectSlackInstallation } from "./slack-receipts.ts";
import { PROVIDERS } from "./registry.ts";
import { isSelectionTaken } from "./postgres.ts";

type AuthRedirect = z.output<typeof contractSchemas.AuthRedirect>;

export type OAuth2Fetch = (input: URL, init: RequestInit) => Promise<Response>;

export type OAuth2Provider = Readonly<{
  slug: string;
  profile: OAuth2Profile;
}>;

const PROVIDER_DEADLINE_MS = 10_000;
const CALLBACK_DEADLINE_MS = 30_000;
const TOKEN_RESPONSE_MAX_BYTES = 65_536;
const IDENTIFY_ACCOUNT_TYPE = "account";
const NO_REPOSITORY_SELECTION = "none";

export function oauth2ProviderFor(slug: string): OAuth2Provider | undefined {
  const provider = PROVIDERS.providers.find((candidate) =>
    candidate.manifest.slug === slug
  );
  if (provider === undefined || provider.manifest.connect.kind !== "oauth2") {
    return undefined;
  }
  const connect = provider.impl.connect;
  if (!isOAuth2Profile(connect)) return undefined;
  return { slug, profile: connect };
}

function isOAuth2Profile(connect: unknown): connect is OAuth2Profile {
  return typeof connect === "object" && connect !== null &&
    "authorizeUrl" in connect && "tokenUrl" in connect &&
    "identify" in connect;
}

export function oauth2AuthorizationUrl(
  profile: OAuth2Profile,
  request: Readonly<{
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }>,
): string {
  const url = new URL(profile.authorizeUrl);
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", profile.scopes.join(profile.scopeDelimiter));
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

export function isAllowlistedOAuth2AuthorizationUrl(
  value: string,
  profile: OAuth2Profile,
): boolean {
  const url = new URL(value);
  return url.origin === profile.authorizeUrl.origin &&
    url.pathname === profile.authorizeUrl.pathname && url.hash === "" &&
    url.username === "" && url.password === "";
}

const GrantedTokensSchema = z.object({
  access_token: z.string().min(1).describe(
    "The access token the provider granted; stored sealed, never returned.",
  ),
  refresh_token: z.string().min(1).optional().describe(
    "The refresh token when the provider rotates access tokens; stored sealed.",
  ),
  scope: z.string().optional().describe(
    "The scopes the provider reports as granted, in its own delimiter.",
  ),
}).describe(
  "The standard OAuth2 token fields read after the provider's own response schema accepted the body.",
);

export type GrantedTokens = z.output<typeof GrantedTokensSchema>;

export type ExchangedTokens =
  & GrantedTokens
  & Readonly<{
    providerResponse: unknown;
  }>;

function providerSchema(profile: OAuth2Profile): z.ZodType {
  if (!(profile.tokenResponse instanceof z.ZodType)) {
    throw new Error("provider token response is not a schema");
  }
  return profile.tokenResponse;
}

export async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("provider response exceeds its bound");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const deadline = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_DEADLINE_MS)]);

export class ConnectRefused extends Error {
  constructor(readonly refusal: ConnectRefusal) {
    super(`connect refused: ${refusal}`);
  }
}

const REFUSAL_OUTCOME: Readonly<Record<ConnectRefusal, ConnectionOutcome>> = {
  enterprise_install: ConnectionOutcome.EnterpriseInstall,
};

export async function exchangeOAuth2Code(
  fetcher: OAuth2Fetch,
  profile: OAuth2Profile,
  request: Readonly<{
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }>,
  signal: AbortSignal,
): Promise<ExchangedTokens> {
  const response = await fetcher(profile.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: request.code,
      redirect_uri: request.redirectUri,
      client_id: request.clientId,
      client_secret: request.clientSecret,
      code_verifier: request.codeVerifier,
    }),
    redirect: "error",
    signal: deadline(signal),
  });
  const body = await readBounded(response, TOKEN_RESPONSE_MAX_BYTES);
  if (!response.ok) {
    throw new Error(`token endpoint answered ${response.status}`);
  }
  const raw: unknown = JSON.parse(new TextDecoder().decode(body));
  const refusal = profile.refusal?.(raw) ?? null;
  if (refusal !== null) throw new ConnectRefused(refusal);
  const parsed = providerSchema(profile).parse(raw);
  return { ...GrantedTokensSchema.parse(parsed), providerResponse: parsed };
}

export function bearerRequestPort(
  fetcher: OAuth2Fetch,
  apiBaseUrl: URL,
  token: string,
  signal: AbortSignal,
): ProviderRequestPort {
  const base = apiBaseUrl.href.endsWith("/")
    ? apiBaseUrl.href
    : `${apiBaseUrl.href}/`;
  return {
    async send(request) {
      if (!request.path.startsWith("/") || request.path.startsWith("//")) {
        throw new Error("provider request path must be origin-relative");
      }
      const url = new URL(request.path.slice(1), base);
      if (url.origin !== apiBaseUrl.origin || !url.href.startsWith(base)) {
        throw new Error("provider request left its origin");
      }
      const response = await fetcher(url, {
        method: request.method,
        headers: { ...request.headers, authorization: `Bearer ${token}` },
        ...(request.body === undefined
          ? {}
          : { body: new Uint8Array(request.body) }),
        redirect: "error",
        signal: deadline(signal),
      });
      const body = await readBounded(response, request.maxResponseBytes);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body,
      };
    },
  };
}

export function grantedScopes(
  profile: OAuth2Profile,
  granted: GrantedTokens,
): Record<string, PermissionLevel> {
  const scopes = granted.scope === undefined
    ? [...profile.scopes]
    : granted.scope.split(/[ ,]+/).filter((scope) => scope.length > 0);
  const permissions = new Map<string, PermissionLevel>();
  for (const scope of scopes) {
    const separator = scope.indexOf(":");
    const name = separator > 0 ? scope.slice(0, separator) : scope;
    const level = scopeLevel(
      separator > 0 ? scope.slice(separator + 1).split(".")[0]! : scope,
    );
    if (permissions.get(name) !== "write") permissions.set(name, level);
  }
  return Object.fromEntries(permissions);
}

type PermissionLevel = "read" | "write";

const WRITE_SCOPE_LEVELS: ReadonlySet<string> = new Set([
  "write",
  "create",
  "admin",
]);

function scopeLevel(level: string): PermissionLevel {
  return WRITE_SCOPE_LEVELS.has(level) ? "write" : "read";
}

type OAuth2Client = Readonly<{
  registrationId: string;
  clientId: string;
  clientSecret: string;
}>;

export async function readOAuth2Client(
  transaction: PgTransactionClient,
  slug: string,
  secretsKey: SecretsKeyConfig | undefined,
): Promise<OAuth2Client | null> {
  const stored = await readStoredClientCredentials(transaction, slug);
  if (stored === null) return null;
  return {
    registrationId: stored.id,
    clientId: stored.clientId,
    clientSecret: await openInstallationSecret(
      transaction,
      secretsKey,
      stored.secretId,
    ),
  };
}

async function recordSignedEventSource(
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    provider: string;
    source: SignedEventSource;
  }>,
): Promise<Record<string, unknown>> {
  const stored = await readStoredClientCredentials(transaction, input.provider);
  const signingSecretId = stored?.signingSecretId ?? null;
  const recorded = await connectSlackInstallation(transaction, {
    organizationId: input.organizationId,
    installation: {
      kind: "workspace",
      appId: input.source.appId,
      teamId: input.source.workspaceId,
      ...(input.source.enterpriseId === undefined
        ? {}
        : { enterpriseId: input.source.enterpriseId }),
      botUserId: input.source.botUserId,
      scopes: [],
    },
    signingSecretId,
  });
  return {
    signedEvents: recorded.ok
      ? (recorded.reclaimed ? "reclaimed" : "recorded")
      : recorded.reason,
    signingSecretSaved: signingSecretId !== null,
  };
}

async function installedForAnotherApp(
  transaction: PgTransactionClient,
  appId: string,
): Promise<boolean> {
  const other = await transaction.query(
    "select 1 from bakery.slack_installations where app_id <> $1 limit 1",
    [appId],
  );
  return other.rows.length > 0;
}

export type OAuth2BindingPreparation = Readonly<{
  attemptId: string;
  provider: string;
  registrationId: string;
  identity: Pick<Identity, "externalAccountId" | "accountLabel">;
  grantedPermissions: Readonly<Record<string, string>>;
  secretSlots: string;
  connectedResource: ConnectedResource | null;
}>;

const preparationSlot = Symbol("private OAuth2 binding preparation");
type PreparedContext = ActionContext & {
  [preparationSlot]?: OAuth2BindingPreparation;
};

export function oauth2BindingPreparation(
  context: ActionContext,
): OAuth2BindingPreparation {
  const prepared = (context as PreparedContext)[preparationSlot];
  if (!prepared) throw new StandardError({ code: "INTERNAL" });
  return prepared;
}

export type OAuth2CallbackDependencies = Readonly<{
  publicBaseUrl: string;
  secretsKey?: SecretsKeyConfig;
  oauth2Fetch?: OAuth2Fetch;
}>;

type Next = (authorizedContext: ActionContext) => Promise<unknown>;

function logCallbackFailure(
  context: ActionContext,
  step: string,
  outcome: ConnectionOutcome,
  error: unknown,
): void {
  console.error(JSON.stringify({
    event: "integration_oauth2_callback_failed",
    requestId: context.requestId,
    traceId: context.traceId,
    step,
    outcome,
    error: error instanceof Error ? error.name : "unknown",
  }));
}

export function createOAuth2CallbackRunner(
  database: PgDatabase,
  dependencies: OAuth2CallbackDependencies,
) {
  const inTransaction = <T>(
    run: (transaction: PgTransactionClient) => Promise<T>,
  ) => withPgTransaction(database, run);
  const fetcher: OAuth2Fetch = dependencies.oauth2Fetch ??
    ((input, init) => fetch(input, init));

  return async (
    action: ActionDefinition,
    context: ActionContext,
    input: unknown,
    next: Next,
  ): Promise<AuthRedirect> => {
    const slug = context.params.provider;
    const provider = slug === undefined ? undefined : oauth2ProviderFor(slug);
    if (provider === undefined) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const parsed = contractSchemas.OAuthCallback.parse(input);
    if (parsed.code === undefined && parsed.error === undefined) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const { principal, sessionId } = callbackPrincipal(context);
    const claim = await inTransaction(async (transaction) =>
      claimCallback(transaction, context, {
        stateHash: await sha256Hex(parsed.state),
        principalId: principal.principalId,
        sessionId,
      }, provider.slug)
    );
    if (claim === null) {
      return connectionRedirect(
        ConnectionOutcome.StateRejected,
        null,
        undefined,
        provider.slug,
      );
    }
    const fail = async (
      step: string,
      outcome: ConnectionOutcome,
      error?: unknown,
    ) => {
      if (error !== undefined) {
        logCallbackFailure(context, step, outcome, error);
      }
      let stored = outcome;
      try {
        const failed = await inTransaction((transaction) =>
          failAttempt(transaction, context, action.name, claim.id, outcome)
        );
        stored = failed?.outcome ?? outcome;
      } catch (recordError) {
        logCallbackFailure(context, "record_outcome", outcome, recordError);
      }
      return connectionRedirect(
        stored,
        claim.returnPath,
        undefined,
        provider.slug,
      );
    };
    if (parsed.code === undefined || parsed.error !== undefined) {
      return await fail("authorize", ConnectionOutcome.AuthorizationDenied);
    }
    const code = parsed.code;
    let client: OAuth2Client | null;
    try {
      client = await inTransaction((transaction) =>
        readOAuth2Client(transaction, provider.slug, dependencies.secretsKey)
      );
    } catch (error) {
      return await fail("exchange", ConnectionOutcome.StorageFailed, error);
    }
    if (client === null) {
      return await fail("exchange", ConnectionOutcome.ProviderUnregistered);
    }
    const signal = AbortSignal.timeout(CALLBACK_DEADLINE_MS);
    let granted: ExchangedTokens;
    try {
      const key = await loadSecretKey(dependencies.secretsKey);
      granted = await exchangeOAuth2Code(fetcher, provider.profile, {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        redirectUri: providerCallbackUrl(
          provider.slug,
          dependencies.publicBaseUrl,
        ),
        codeVerifier: await openVerifier(key, claim),
      }, signal);
    } catch (error) {
      return await fail(
        "exchange",
        error instanceof ConnectRefused
          ? REFUSAL_OUTCOME[error.refusal]
          : ConnectionOutcome.ExchangeFailed,
        error,
      );
    }
    let identity: { externalAccountId: string; accountLabel: string };
    try {
      identity = await provider.profile.identify({
        provider: bearerRequestPort(
          fetcher,
          provider.profile.apiBaseUrl,
          granted.access_token,
          signal,
        ),
        origin: {
          apiBaseUrl: provider.profile.apiBaseUrl,
          webBaseUrl: provider.profile.webBaseUrl,
        },
        signal,
        now: () => new Date(),
      });
    } catch (error) {
      return await fail(
        "identify",
        ConnectionOutcome.InstallationCheckFailed,
        error,
      );
    }
    let connectedResource: ConnectedResource | null;
    try {
      connectedResource = provider.profile.connectedResource?.({
        tokenResponse: granted.providerResponse,
        externalAccountId: identity.externalAccountId,
        accountLabel: identity.accountLabel,
      }) ?? null;
    } catch (error) {
      return await fail(
        "identify",
        ConnectionOutcome.InstallationCheckFailed,
        error,
      );
    }
    const appId = connectedResource?.signedEventSource?.appId;
    if (
      appId !== undefined &&
      await inTransaction((transaction) =>
        installedForAnotherApp(transaction, appId)
      )
    ) {
      return await fail("identify", ConnectionOutcome.WrongApp);
    }
    const prepared: OAuth2BindingPreparation = {
      connectedResource,
      attemptId: claim.id,
      provider: provider.slug,
      registrationId: client.registrationId,
      identity: {
        externalAccountId: identity.externalAccountId,
        accountLabel: identity.accountLabel,
      },
      grantedPermissions: grantedScopes(provider.profile, granted),
      secretSlots: encodeSecretSlots({
        access_token: granted.access_token,
        ...(granted.refresh_token === undefined
          ? {}
          : { refresh_token: granted.refresh_token }),
      }),
    };
    try {
      return await inTransaction((transaction) =>
        next(
          Object.assign({}, context, {
            principal,
            authority: principal,
            transaction,
            [preparationSlot]: prepared,
          }) as PreparedContext,
        )
      ) as AuthRedirect;
    } catch (error) {
      return await fail(
        "bind",
        isSelectionTaken(error)
          ? ConnectionOutcome.HeldElsewhere
          : ConnectionOutcome.StorageFailed,
        error,
      );
    }
  };
}

export type OAuth2BindDependencies = Readonly<{
  secretsKey?: SecretsKeyConfig;
}>;

export async function bindOAuth2Connection(
  context: ActionContext,
  operation: string,
  dependencies: OAuth2BindDependencies,
): Promise<AuthRedirect> {
  const prepared = oauth2BindingPreparation(context);
  const value = context as Partial<AuthorizedActionContext>;
  const principal = value.principal as AuthenticatedSubject | undefined;
  if (!value.transaction || !principal) {
    throw new StandardError({ code: "INTERNAL" });
  }
  const transaction = value.transaction;
  const provider = prepared.provider;
  const locked = await transaction.query<
    CallbackAttempt & { expired: boolean }
  >(
    `select id, organization_id as "organizationId",
       initiating_principal_id as "initiatingPrincipalId",
       return_path as "returnPath",
       reconnect_connection_id as "reconnectConnectionId",
       null as "setupInstallationId", false as exchanged,
       null as "verifiedInstallationIds", false as "hintDiscovered",
       version, expires_at <= now() as expired
       from bakery.integration_auth_attempts
      where id = $1 and provider = $2 and status = 'exchanging'
      for update`,
    [prepared.attemptId, provider],
  );
  const attempt = locked.rows[0];
  const redirect = (outcome: ConnectionOutcome, connectionId?: string) =>
    connectionRedirect(
      outcome,
      attempt?.returnPath ?? null,
      connectionId,
      provider,
    );
  if (attempt === undefined) return redirect(ConnectionOutcome.StateRejected);
  const fail = async (outcome: ConnectionOutcome) => {
    const failed = await failAttempt(
      transaction,
      context,
      operation,
      attempt.id,
      outcome,
    );
    return redirect(failed?.outcome ?? outcome);
  };
  if (attempt.expired) return await fail(ConnectionOutcome.Expired);
  if (
    !await isCurrentAdmin(
      transaction,
      attempt.initiatingPrincipalId,
      attempt.organizationId,
    )
  ) {
    return await fail(ConnectionOutcome.AdminRequired);
  }

  const accountId = prepared.identity.externalAccountId;
  const label = prepared.identity.accountLabel;
  const permissions = JSON.stringify(prepared.grantedPermissions);

  if (attempt.reconnectConnectionId !== null) {
    const target = await transaction.query<
      { externalAccountId: string; archived: boolean; status: string }
    >(
      `select external_account_id as "externalAccountId",
         archived_at is not null as archived, status
         from bakery.integration_connections
        where organization_id = $1 and id = $2 and provider = $3
        for update`,
      [attempt.organizationId, attempt.reconnectConnectionId, provider],
    );
    const row = target.rows[0];
    if (row === undefined || row.archived) {
      return await fail(ConnectionOutcome.ReconnectUnavailable);
    }
    if (row.externalAccountId === accountId) {
      return await refreshConnection(
        attempt.reconnectConnectionId,
        row.status === "revoked" ? "restored" : "refreshed",
      );
    }
  }

  const live = await transaction.query<{ id: string; status: string }>(
    `select connection.id, connection.status
       from bakery.integration_connections connection
       join bakery.integration_installations installation
         on installation.id = connection.installation_id
      where connection.organization_id = $1
        and installation.registration_id = $2
        and installation.external_authorization_id = $3
        and connection.archived_at is null
      for update of connection`,
    [attempt.organizationId, prepared.registrationId, accountId],
  );
  const removed = live.rows.find((row) => row.status === "revoked");
  if (removed !== undefined) {
    return await refreshConnection(removed.id, "restored");
  }
  if (live.rows.length > 0) {
    return await fail(ConnectionOutcome.AlreadyConnected);
  }
  const installationId = await storeInstallation();
  const connection = await transaction.query<{ id: string }>(
    `insert into bakery.integration_connections (
       id, organization_id, provider, installation_id,
       external_authorization_id, external_account_id, label,
       adapter_version, granted_permissions, status, health, created_by
     ) values ($1, $2, $3, $4, $5, $5, $6, $7, $8::jsonb, 'enabled',
       'unknown', $9)
     on conflict (organization_id, installation_id) where archived_at is null
     do nothing
     returning id`,
    [
      crypto.randomUUID(),
      attempt.organizationId,
      provider,
      installationId,
      accountId,
      label,
      `${provider}@oauth2`,
      permissions,
      attempt.initiatingPrincipalId,
    ],
  );
  const created = connection.rows[0];
  if (created === undefined) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "already_connected" },
    });
  }
  const signedEvents = await bindPreparedResource(created.id, installationId);
  await completeAttempt(created.id, {
    ...signedEvents,
    step: "bound",
    status: "enabled",
    accountId,
    reconnectConnectionId: attempt.reconnectConnectionId,
  });
  return redirect(ConnectionOutcome.Connected, created.id);

  async function refreshConnection(
    connectionId: string,
    step: "refreshed" | "restored",
  ): Promise<AuthRedirect> {
    const installationId = await storeInstallation();
    const refreshed = await transaction.query<
      { version: number; authorizationRevision: number }
    >(
      `update bakery.integration_connections
          set label = $3, granted_permissions = $4::jsonb,
              authorization_revision = authorization_revision + 1,
              status = 'enabled', health = 'unknown',
              version = version + 1, updated_at = now()
        where organization_id = $1 and id = $2
        returning version, authorization_revision as "authorizationRevision"`,
      [attempt!.organizationId, connectionId, label, permissions],
    );
    const updated = refreshed.rows[0];
    if (updated === undefined) throw new StandardError({ code: "INTERNAL" });
    const signedEvents = await bindPreparedResource(
      connectionId,
      installationId,
      step === "restored",
    );
    await completeAttempt(connectionId, {
      ...signedEvents,
      step,
      regranted: step === "restored" && prepared.connectedResource !== null,
      accountId,
      authorizationRevision: updated.authorizationRevision,
      version: updated.version,
    });
    return redirect(ConnectionOutcome.Refreshed, connectionId);
  }

  async function bindPreparedResource(
    connectionId: string,
    installationId: string,
    regrant = false,
  ): Promise<Record<string, unknown>> {
    if (prepared.connectedResource === null) return {};
    await bindConnectedResource(transaction, {
      organizationId: attempt!.organizationId,
      connectionId,
      installationId,
      grantedBy: attempt!.initiatingPrincipalId,
      resource: prepared.connectedResource,
      regrant,
    });
    const source = prepared.connectedResource.signedEventSource;
    if (source === undefined) return {};
    return await recordSignedEventSource(transaction, {
      organizationId: attempt!.organizationId,
      provider,
      source,
    });
  }

  async function storeInstallation(): Promise<string> {
    const existing = await transaction.query<
      { id: string; secretId: string | null }
    >(
      `select id, credential_secret_id as "secretId"
         from bakery.integration_installations
        where registration_id = $1 and external_authorization_id = $2
        for update`,
      [prepared.registrationId, accountId],
    );
    const row = existing.rows[0];
    const current = row?.secretId == null ? null : {
      secretId: row.secretId,
      revision:
        await readInstallationSecretRevision(transaction, row.secretId) ??
          0,
    };
    const sealed = await sealInstallationSecret(
      dependencies.secretsKey,
      current,
      prepared.secretSlots,
    );
    await writeInstallationSecretVersion(transaction, sealed, {
      name: `${provider}:${accountId}:credential`,
      provider,
      principalId: attempt!.initiatingPrincipalId,
    });
    if (row !== undefined) {
      await transaction.query(
        `update bakery.integration_installations
            set account_login = $2, granted_permissions = $3::jsonb,
                credential_secret_id = $4,
                authorization_revision = authorization_revision + 1,
                status = 'enabled', version = version + 1, updated_at = now()
          where id = $1`,
        [row.id, label, permissions, sealed.secretId],
      );
      return row.id;
    }
    const id = crypto.randomUUID();
    await transaction.query(
      `insert into bakery.integration_installations (
         id, provider, registration_id, external_authorization_id,
         external_account_id, account_login, account_type,
         repository_selection, granted_permissions, credential_secret_id,
         status
       ) values ($1, $2, $3, $4, $4, $5, $6, $7, $8::jsonb, $9, 'enabled')`,
      [
        id,
        provider,
        prepared.registrationId,
        accountId,
        label,
        IDENTIFY_ACCOUNT_TYPE,
        NO_REPOSITORY_SELECTION,
        permissions,
        sealed.secretId,
      ],
    );
    return id;
  }

  async function completeAttempt(
    connectionId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const completed = await transaction.query<{ version: number }>(
      `update bakery.integration_auth_attempts
          set status = 'completed', result_connection_id = $2,
              version = version + 1, updated_at = now()
        where id = $1 and status = 'exchanging'
        returning version`,
      [attempt!.id, connectionId],
    );
    if (completed.rows.length !== 1) {
      throw new StandardError({ code: "INTERNAL" });
    }
    await attemptChanged(transaction, context, {
      ...attempt!,
      version: completed.rows[0]!.version,
    });
    await audit(transaction, context, operation, attempt!, {
      type: "integration_connection",
      id: connectionId,
    }, { provider, ...details });
  }
}
