import { z } from "zod";
import type {
  ActionContext,
  ActionDefinition,
} from "@bakery/contracts/action-registry";
import { contractSchemas, PrincipalType } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { IntegrationsImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import type { SecretsKeyConfig } from "@bakery/config";
import { appendDomainEvent } from "@bakery/persistence";
import type { AuthorizedActionContext } from "../auth/application/authority.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { sha256Hex } from "../../platform/canonical-json.ts";
import { loadSecretKey } from "../secrets/crypto.ts";
import { organizationActor } from "./auth-attempts.ts";
import { callbackPrincipal } from "./callbacks.ts";
import { readStoredClientCredentials } from "./client-credentials.ts";
import {
  type OAuth2Fetch,
  readBounded,
  readOAuth2Client,
} from "./oauth2-connect.ts";
import { requireBrowserSession } from "./postgres.ts";
import {
  type ClaimedSlackIdentityAttempt,
  claimSlackIdentityAttempt,
  completeSlackIdentityAttempt,
  createSlackIdentityAttempt,
  failSlackIdentityAttempt,
  type SlackAttemptFailureCode,
} from "./slack-identity-attempts.ts";
import {
  linkSlackIdentity,
  revokeSlackIdentityLink,
  SLACK_LINK_PROVIDER,
  type SlackLinkRevokeReason,
} from "./slack-identity-links.ts";
import {
  SLACK_OIDC_ISSUER,
  type SlackIdentityKey,
  type VerifiedSlackIdentity,
  verifySlackIdentityToken,
} from "./slack-identity.ts";

type MySlackLink = z.output<typeof contractSchemas.MySlackLink>;
type AttemptCreated = z.output<
  typeof contractSchemas.MySlackLinkAttemptCreated
>;
type AuthRedirect = z.output<typeof contractSchemas.AuthRedirect>;
type Next = (context: ActionContext) => Promise<unknown>;

export const SLACK_IDENTITY_CALLBACK_PATH =
  "/v1/integration-auth/slack/identity-callback";
export const SLACK_LINK_RETURN_PATH = "/settings/security";
export const SLACK_OIDC_AUTHORIZE_URL =
  "https://slack.com/openid/connect/authorize";
export const SLACK_OIDC_TOKEN_URL =
  "https://slack.com/api/openid.connect.token";
export const SLACK_OIDC_KEYS_URL = "https://slack.com/openid/connect/keys";

const SLACK = "slack";
const IDENTITY_LINK_CHANGED = "integration.identity_link_changed";
const CALLBACK_DEADLINE_MS = 30_000;
const PROVIDER_DEADLINE_MS = 10_000;
const TOKEN_RESPONSE_MAX_BYTES = 65_536;
const KEYS_RESPONSE_MAX_BYTES = 65_536;
const KEYS_CACHE_MS = 5 * 60_000;
const MAX_KEYS = 20;

export const SlackLinkResult = Object.freeze(
  {
    Linked: "linked",
    Relinked: "relinked",
    Unchanged: "unchanged",
    ProviderDenied: "provider_denied",
    LinkRefused: "link_refused",
    NotAMember: "not_a_member",
    ExchangeFailed: "exchange_failed",
    TokenInvalid: "token_invalid",
    NonceUnreadable: "nonce_unreadable",
    Superseded: "superseded",
    Expired: "expired",
    WrongWorkspace: "wrong_workspace",
  } as const,
);
export type SlackLinkResult =
  (typeof SlackLinkResult)[keyof typeof SlackLinkResult];

export const SlackLinkStartRefusal = Object.freeze(
  {
    NotConnected: "slack_not_connected",
    ConnectionNotWorking: "slack_connection_not_working",
    AppCredentialsMissing: "slack_app_credentials_missing",
    WorkspaceUnregistered: "slack_workspace_unregistered",
  } as const,
);

export function slackIdentityCallbackUrl(publicBaseUrl: string): string {
  return new URL(SLACK_IDENTITY_CALLBACK_PATH, publicBaseUrl).href;
}

export function slackLinkRedirect(result: SlackLinkResult): AuthRedirect {
  const url = new URL(SLACK_LINK_RETURN_PATH, "https://bakery.invalid");
  url.searchParams.set("slackLink", result);
  url.hash = "slack";
  return {
    status: "303",
    location: `${url.pathname}${url.search}${url.hash}`,
  };
}

type ConnectionRow = {
  teamId: string;
  label: string;
  status: string;
  health: string;
};

export type SlackConnectionState = MySlackLink["connection"];

export type SlackConnectionView = Readonly<{
  state: SlackConnectionState;
  teamId: string | null;
  workspaceName: string | null;
}>;

function connectionState(row: ConnectionRow): SlackConnectionState {
  if (row.status === "enabled") {
    return row.health === "healthy" || row.health === "unknown"
      ? "working"
      : "not_working";
  }
  if (row.status === "disabled" || row.status === "revoked") {
    return "not_working";
  }
  return "setup_unfinished";
}

export async function readSlackConnection(
  transaction: Pick<PgTransactionClient, "query">,
  organizationId: string,
): Promise<SlackConnectionView> {
  const result = await transaction.query<ConnectionRow>(
    `select external_account_id as "teamId", label, status, health
       from bakery.integration_connections
      where organization_id = $1 and provider = $2 and archived_at is null
      order by (status = 'enabled') desc, created_at, id
      limit 1`,
    [organizationId, SLACK],
  );
  const row = result.rows[0];
  if (row !== undefined) {
    return {
      state: connectionState(row),
      teamId: row.teamId,
      workspaceName: row.label.length === 0 ? null : row.label,
    };
  }
  const credentials = await readStoredClientCredentials(transaction, SLACK);
  return {
    state: credentials === null ? "none" : "setup_unfinished",
    teamId: null,
    workspaceName: null,
  };
}

type LinkStateRow = {
  state: "active" | "revoked";
  verifiedAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
};

export async function readMySlackLink(
  transaction: Pick<PgTransactionClient, "query">,
  input: { readonly organizationId: string; readonly principalId: string },
): Promise<MySlackLink> {
  const connection = await readSlackConnection(
    transaction,
    input.organizationId,
  );
  const links = await transaction.query<LinkStateRow>(
    `select state, verified_at as "verifiedAt", revoked_at as "revokedAt",
            revoke_reason as "revokeReason"
       from bakery.external_identity_links
      where organization_id = $1 and principal_id = $2 and provider = $3
        and ($4::text is null or identity_scope = $4)
      order by (state = 'active') desc,
               coalesce(revoked_at, verified_at) desc, id
      limit 1`,
    [
      input.organizationId,
      input.principalId,
      SLACK_LINK_PROVIDER,
      connection.teamId,
    ],
  );
  const base = {
    connection: connection.state,
    ...(connection.workspaceName === null
      ? {}
      : { workspaceName: connection.workspaceName }),
  };
  const link = links.rows[0];
  if (link?.state === "active") {
    return {
      ...base,
      state: "linked",
      linkedAt: new Date(link.verifiedAt).toISOString(),
    };
  }
  if (
    link?.state === "revoked" && link.revokeReason === "revoked_by_admin" &&
    link.revokedAt !== null
  ) {
    return {
      ...base,
      state: "removed_by_admin",
      removedAt: new Date(link.revokedAt).toISOString(),
    };
  }
  return { ...base, state: "not_linked" };
}

export function authorizeLinkingSelf(context: ActionContext): void {
  const { actor } = organizationActor(context);
  if (actor.subject.principalType !== PrincipalType.Human) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

export async function getMySlackLink(
  context: ActionContext,
): Promise<MySlackLink> {
  const { context: value, actor } = organizationActor(context);
  return await readMySlackLink(value.transaction, {
    organizationId: actor.organizationId,
    principalId: actor.subject.principalId,
  });
}

async function revokeMemberSlackLinks(
  transaction: PgTransactionClient,
  context: ActionContext & { traceId: string },
  input: {
    readonly organizationId: string;
    readonly principalId: string;
    readonly reason: SlackLinkRevokeReason;
    readonly operation: string;
    readonly workspace?: { readonly appId: string; readonly teamId: string };
    readonly keepLinkId?: string;
  },
): Promise<void> {
  const { organizationId, principalId, workspace } = input;
  const active = await transaction.query<{ id: string }>(
    `select id from bakery.external_identity_links
      where organization_id = $1 and principal_id = $2 and provider = $3
        and state = 'active'
        and ($4::text is null or external_app_id = $4)
        and ($5::text is null or identity_scope = $5)
        and ($6::uuid is null or id <> $6)
      order by id
      for update`,
    [
      organizationId,
      principalId,
      SLACK_LINK_PROVIDER,
      workspace?.appId ?? null,
      workspace?.teamId ?? null,
      input.keepLinkId ?? null,
    ],
  );
  const at = new Date();
  for (const row of active.rows) {
    const revoked = await revokeSlackIdentityLink(transaction, {
      organizationId,
      linkId: row.id,
      revokedBy: principalId,
      reason: input.reason,
      at,
    });
    if (!revoked.ok) throw new StandardError({ code: "INTERNAL" });
    await recordAuthAudit(transaction, context, {
      organizationId,
      principalId,
      operation: input.operation,
      resourceType: "external_identity_link",
      resourceId: row.id,
      details: {
        provider: SLACK_LINK_PROVIDER,
        reason: input.reason,
        version: revoked.link.version,
      },
    });
    await appendDomainEvent(transaction, {
      organizationId,
      eventType: IDENTITY_LINK_CHANGED,
      aggregateId: row.id,
      aggregateVersion: revoked.link.version,
      payload: { resourceId: row.id, resourceVersion: revoked.link.version },
      traceId: context.traceId,
    });
  }
}

export async function unlinkMySlackLink(
  context: ActionContext,
): Promise<MySlackLink> {
  const { context: value, actor } = organizationActor(context);
  const transaction = value.transaction;
  const organizationId = actor.organizationId;
  const principalId = actor.subject.principalId;
  await revokeMemberSlackLinks(transaction, value, {
    organizationId,
    principalId,
    reason: "unlinked_by_member",
    operation: Action.MySlackLinkDelete,
  });
  return await readMySlackLink(transaction, { organizationId, principalId });
}

function refuseStart(reason: string): StandardError {
  return new StandardError({
    code: "STATE_CONFLICT",
    params: {
      issues: [{
        path: [],
        code: reason,
        message: reason.replaceAll("_", " "),
      }],
    },
  });
}

export type SlackLinkStartDependencies = Readonly<{
  publicBaseUrl: string;
  secretsKey?: SecretsKeyConfig;
}>;

export async function startMySlackLink(
  context: ActionContext,
  dependencies: SlackLinkStartDependencies,
): Promise<AttemptCreated> {
  const { context: value, actor } = organizationActor(context);
  const transaction = value.transaction;
  const sessionId = requireBrowserSession(context);
  const organizationId = actor.organizationId;
  const principalId = actor.subject.principalId;

  const connection = await readSlackConnection(transaction, organizationId);
  if (connection.state === "none" || connection.state === "setup_unfinished") {
    throw refuseStart(SlackLinkStartRefusal.NotConnected);
  }
  if (connection.state !== "working" || connection.teamId === null) {
    throw refuseStart(SlackLinkStartRefusal.ConnectionNotWorking);
  }
  const credentials = await readStoredClientCredentials(transaction, SLACK);
  if (credentials === null) {
    throw refuseStart(SlackLinkStartRefusal.AppCredentialsMissing);
  }
  const installations = await transaction.query<
    { appId: string; enterpriseId: string | null }
  >(
    `select app_id as "appId", enterprise_id as "enterpriseId"
       from bakery.slack_installations
      where organization_id = $1 and team_id = $2 and status = 'active'
      order by created_at, id
      limit 2`,
    [organizationId, connection.teamId],
  );
  const installation = installations.rows[0];
  if (installation === undefined || installations.rows.length !== 1) {
    throw refuseStart(SlackLinkStartRefusal.WorkspaceUnregistered);
  }

  const secretsKey = await loadSecretKey(dependencies.secretsKey);
  const created = await createSlackIdentityAttempt(transaction, {
    organizationId,
    principalId,
    sessionId,
    binding: {
      appId: installation.appId,
      clientId: credentials.clientId,
      teamId: connection.teamId,
      ...(installation.enterpriseId === null
        ? {}
        : { enterpriseId: installation.enterpriseId }),
    },
    secretsKey,
    keyId: dependencies.secretsKey!.keyId,
  });
  if (!created.ok) {
    if (created.reason === "not_a_member") {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    throw refuseStart(SlackLinkStartRefusal.AppCredentialsMissing);
  }
  await recordAuthAudit(transaction, value, {
    organizationId,
    principalId,
    operation: Action.MySlackLinkAttemptsCreate,
    resourceType: "slack_identity_attempt",
    resourceId: created.attemptId,
    details: {
      provider: SLACK_LINK_PROVIDER,
      teamId: connection.teamId,
      expiresAt: created.expiresAt,
    },
  });

  const url = new URL(SLACK_OIDC_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("client_id", credentials.clientId);
  url.searchParams.set(
    "redirect_uri",
    slackIdentityCallbackUrl(dependencies.publicBaseUrl),
  );
  url.searchParams.set("state", created.state);
  url.searchParams.set("nonce", created.nonce);
  url.searchParams.set("team", connection.teamId);
  return { authorizationUrl: url.href, expiresAt: created.expiresAt };
}

const SlackOidcTokenResponse = z.object({
  ok: z.literal(true).describe("Slack reports the code exchange succeeded."),
  id_token: z.string().min(1).max(16_384).describe(
    "The signed identity token Bakery verifies; it is never stored.",
  ),
}).describe(
  "The fields Bakery reads from Slack's openid.connect.token response; every other field, the access token included, is dropped unread.",
);

const SlackKeySet = z.object({
  keys: z.array(
    z.object({
      kty: z.string().describe("Key type; only RSA keys are kept."),
      kid: z.string().min(1).max(256).describe("Key id a token names."),
      n: z.string().min(1).max(4096).describe("RSA modulus, base64url."),
      e: z.string().min(1).max(64).describe("RSA public exponent, base64url."),
      alg: z.string().optional().describe("Algorithm the key is meant for."),
      use: z.string().optional().describe("Intended use of the key."),
    }).describe("One public signing key Slack publishes."),
  ).max(MAX_KEYS).describe("Slack's current public signing keys."),
}).describe("Slack's published OpenID Connect key set.");

const deadline = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_DEADLINE_MS)]);

async function readJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const body = await readBounded(response, maxBytes);
  if (!response.ok) throw new Error(`Slack answered ${response.status}`);
  return JSON.parse(new TextDecoder().decode(body));
}

async function exchangeSlackIdentityCode(
  fetcher: OAuth2Fetch,
  request: Readonly<{
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }>,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetcher(new URL(SLACK_OIDC_TOKEN_URL), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: request.clientId,
      client_secret: request.clientSecret,
      code: request.code,
      redirect_uri: request.redirectUri,
    }),
    redirect: "error",
    signal: deadline(signal),
  });
  return SlackOidcTokenResponse.parse(
    await readJson(response, TOKEN_RESPONSE_MAX_BYTES),
  ).id_token;
}

function createSlackKeyCache(fetcher: OAuth2Fetch, now: () => number) {
  let cached: { keys: SlackIdentityKey[]; until: number } | undefined;
  const load = async (signal: AbortSignal) => {
    const response = await fetcher(new URL(SLACK_OIDC_KEYS_URL), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: deadline(signal),
    });
    const parsed = SlackKeySet.parse(
      await readJson(response, KEYS_RESPONSE_MAX_BYTES),
    );
    const keys = parsed.keys.flatMap((key): SlackIdentityKey[] =>
      key.kty === "RSA"
        ? [{
          kty: "RSA",
          kid: key.kid,
          n: key.n,
          e: key.e,
          ...(key.alg === undefined ? {} : { alg: key.alg }),
          ...(key.use === undefined ? {} : { use: key.use }),
        }]
        : []
    );
    cached = { keys, until: now() + KEYS_CACHE_MS };
    return keys;
  };
  return async (kid: string | undefined, signal: AbortSignal) => {
    if (
      cached !== undefined && cached.until > now() &&
      (kid === undefined || cached.keys.some((key) => key.kid === kid))
    ) return cached.keys;
    return await load(signal);
  };
}

function tokenKeyId(token: string): string | undefined {
  try {
    const header = JSON.parse(
      atob(token.split(".")[0]!.replaceAll("-", "+").replaceAll("_", "/")),
    ) as unknown;
    return typeof header === "object" && header !== null &&
        typeof (header as { kid?: unknown }).kid === "string"
      ? (header as { kid: string }).kid
      : undefined;
  } catch {
    return undefined;
  }
}

const STORED_FAILURE: Readonly<
  Partial<Record<SlackLinkResult, SlackAttemptFailureCode>>
> = {
  provider_denied: "provider_denied",
  exchange_failed: "exchange_failed",
  token_invalid: "token_invalid",
  wrong_workspace: "wrong_workspace",
};

function logFailure(
  context: ActionContext,
  stage: string,
  result: SlackLinkResult,
  error: unknown,
) {
  console.warn(JSON.stringify({
    component: "integrations",
    event: "slack_identity_link_failed",
    stage,
    result,
    errorClass: error instanceof Error ? error.name : typeof error,
    code: error instanceof StandardError ? error.code : null,
    requestId: context.requestId,
    traceId: context.traceId,
  }));
}

async function refusedResult(
  transaction: PgTransactionClient,
  binding: { stateHash: string; sessionHash: string; principalId: string },
): Promise<SlackLinkResult> {
  const found = await transaction.query<
    { status: string; failureCode: string | null; expired: boolean }
  >(
    `select status, failure_code as "failureCode", expires_at <= now() as expired
       from bakery.slack_identity_attempts
      where state_hash = $1 and session_id = $2 and initiating_principal_id = $3`,
    [binding.stateHash, binding.sessionHash, binding.principalId],
  );
  const row = found.rows[0];
  if (row?.status === "failed" && row.failureCode === "superseded") {
    return SlackLinkResult.Superseded;
  }
  if (row?.status === "failed" && row.failureCode === "nonce_unreadable") {
    return SlackLinkResult.NonceUnreadable;
  }
  return SlackLinkResult.Expired;
}

export type SlackIdentityCallbackDependencies = Readonly<{
  publicBaseUrl: string;
  secretsKey?: SecretsKeyConfig;
  oauth2Fetch?: OAuth2Fetch;
  now?: () => number;
}>;

export type SlackIdentityBinding = Readonly<{
  attempt: ClaimedSlackIdentityAttempt;
  identity: VerifiedSlackIdentity;
}>;

const bindingSlot = Symbol("verified Slack identity binding");
type BindingContext = ActionContext & { [bindingSlot]?: SlackIdentityBinding };

function verifiedBinding(context: ActionContext): SlackIdentityBinding {
  const binding = (context as BindingContext)[bindingSlot];
  if (binding === undefined) throw new StandardError({ code: "AUTH_INVALID" });
  return binding;
}

export function createSlackIdentityCallbackRunner(
  database: PgDatabase,
  dependencies: SlackIdentityCallbackDependencies,
) {
  const inTransaction = <T>(
    run: (transaction: PgTransactionClient) => Promise<T>,
  ) => withPgTransaction(database, run);
  const fetcher: OAuth2Fetch = dependencies.oauth2Fetch ??
    ((input, init) => fetch(input, init));
  const now = dependencies.now ?? Date.now;
  const keysFor = createSlackKeyCache(fetcher, now);

  return async (
    _action: ActionDefinition,
    context: ActionContext,
    input: unknown,
    next: Next,
  ): Promise<AuthRedirect> => {
    const parsed = contractSchemas.OAuthCallback.parse(input);
    if (parsed.code === undefined && parsed.error === undefined) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    const { principal, sessionId } = callbackPrincipal(context);
    const secretsKey = await loadSecretKey(dependencies.secretsKey);
    const keyId = dependencies.secretsKey!.keyId;
    const claim = await inTransaction((transaction) =>
      claimSlackIdentityAttempt(transaction, {
        state: parsed.state,
        sessionId,
        principalId: principal.principalId,
        secretsKey,
        keyId,
      })
    );
    if (!claim.ok) {
      const binding = {
        stateHash: await sha256Hex(parsed.state),
        sessionHash: await sha256Hex(sessionId),
        principalId: principal.principalId,
      };
      return slackLinkRedirect(
        await inTransaction((transaction) =>
          refusedResult(transaction, binding)
        ),
      );
    }
    const attempt = claim.attempt;
    const fail = async (
      stage: string,
      result: SlackLinkResult,
      error?: unknown,
    ) => {
      if (error !== undefined) logFailure(context, stage, result, error);
      const code = STORED_FAILURE[result] ?? "exchange_failed";
      try {
        await inTransaction((transaction) =>
          failSlackIdentityAttempt(transaction, {
            attemptId: attempt.attemptId,
            code,
          })
        );
      } catch (recordError) {
        logFailure(context, "record_outcome", result, recordError);
      }
      return slackLinkRedirect(result);
    };
    if (parsed.code === undefined || parsed.error !== undefined) {
      return await fail("authorize", SlackLinkResult.ProviderDenied);
    }
    const code = parsed.code;
    let client: Awaited<ReturnType<typeof readOAuth2Client>>;
    try {
      client = await inTransaction((transaction) =>
        readOAuth2Client(transaction, SLACK, dependencies.secretsKey)
      );
    } catch (error) {
      return await fail("credentials", SlackLinkResult.ExchangeFailed, error);
    }
    if (client === null || client.clientId !== attempt.clientId) {
      return await fail("credentials", SlackLinkResult.ExchangeFailed);
    }
    const signal = AbortSignal.timeout(CALLBACK_DEADLINE_MS);
    let idToken: string;
    try {
      idToken = await exchangeSlackIdentityCode(fetcher, {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        redirectUri: slackIdentityCallbackUrl(dependencies.publicBaseUrl),
      }, signal);
    } catch (error) {
      return await fail("exchange", SlackLinkResult.ExchangeFailed, error);
    }
    let keys: SlackIdentityKey[];
    try {
      keys = await keysFor(tokenKeyId(idToken), signal);
    } catch (error) {
      return await fail("keys", SlackLinkResult.ExchangeFailed, error);
    }
    const verified = await verifySlackIdentityToken(
      idToken,
      {
        issuer: SLACK_OIDC_ISSUER,
        audience: attempt.clientId,
        nonce: attempt.nonce,
        teamId: attempt.teamId,
        ...(attempt.enterpriseId === undefined
          ? {}
          : { enterpriseId: attempt.enterpriseId }),
      },
      keys,
      now(),
    );
    if (!verified.ok) {
      return await fail(
        "verify",
        verified.reason === "wrong_workspace"
          ? SlackLinkResult.WrongWorkspace
          : SlackLinkResult.TokenInvalid,
      );
    }
    try {
      return await inTransaction((transaction) =>
        next(
          Object.assign({}, context, {
            principal,
            authority: principal,
            transaction,
            [bindingSlot]: { attempt, identity: verified.identity },
          }) as BindingContext,
        )
      ) as AuthRedirect;
    } catch (error) {
      return await fail("bind", SlackLinkResult.ExchangeFailed, error);
    }
  };
}

export async function bindSlackIdentity(
  context: ActionContext,
): Promise<AuthRedirect> {
  const { attempt, identity } = verifiedBinding(context);
  const value = context as Partial<AuthorizedActionContext>;
  const transaction = value.transaction;
  if (transaction === undefined) throw new StandardError({ code: "INTERNAL" });
  const refuse = async (
    result: SlackLinkResult,
    code: SlackAttemptFailureCode,
  ) => {
    if (
      !await failSlackIdentityAttempt(transaction, {
        attemptId: attempt.attemptId,
        code,
      })
    ) throw new StandardError({ code: "INTERNAL" });
    return slackLinkRedirect(result);
  };
  if (
    identity.teamId !== attempt.teamId ||
    identity.enterpriseId !== attempt.enterpriseId
  ) return await refuse(SlackLinkResult.WrongWorkspace, "wrong_workspace");

  const connection = await readSlackConnection(
    transaction,
    attempt.organizationId,
  );
  const installation = await transaction.query(
    `select 1 from bakery.slack_installations
      where organization_id = $1 and app_id = $2 and team_id = $3
        and status = 'active'`,
    [attempt.organizationId, attempt.appId, attempt.teamId],
  );
  if (
    connection.state !== "working" || connection.teamId !== attempt.teamId ||
    installation.rows.length !== 1
  ) {
    return await refuse(SlackLinkResult.Expired, "connection_unavailable");
  }

  const linked = await linkSlackIdentity(transaction, {
    organizationId: attempt.organizationId,
    principalId: attempt.principalId,
    identity: {
      appId: attempt.appId,
      teamId: identity.teamId,
      userId: identity.userId,
    },
    verifiedAt: new Date(),
  });
  if (!linked.ok) {
    if (linked.reason === "not_a_member") {
      return await refuse(SlackLinkResult.NotAMember, "not_a_member");
    }
    if (linked.reason === "linked_to_another_member") {
      return await refuse(SlackLinkResult.LinkRefused, "link_refused");
    }
    return await refuse(SlackLinkResult.TokenInvalid, "token_invalid");
  }
  if (!await completeSlackIdentityAttempt(transaction, attempt)) {
    throw new StandardError({ code: "INTERNAL" });
  }
  await revokeMemberSlackLinks(transaction, context, {
    organizationId: attempt.organizationId,
    principalId: attempt.principalId,
    reason: "replaced_by_new_link",
    operation: Action.IntegrationSlackIdentityCallback,
    workspace: { appId: attempt.appId, teamId: identity.teamId },
    keepLinkId: linked.link.id,
  });
  await recordAuthAudit(transaction, context, {
    organizationId: attempt.organizationId,
    principalId: attempt.principalId,
    operation: Action.IntegrationSlackIdentityCallback,
    resourceType: "external_identity_link",
    resourceId: linked.link.id,
    details: {
      provider: SLACK_LINK_PROVIDER,
      attemptId: attempt.attemptId,
      outcome: linked.outcome,
      version: linked.link.version,
    },
  });
  if (linked.outcome !== "unchanged") {
    await appendDomainEvent(transaction, {
      organizationId: attempt.organizationId,
      eventType: IDENTITY_LINK_CHANGED,
      aggregateId: linked.link.id,
      aggregateVersion: linked.link.version,
      payload: {
        resourceId: linked.link.id,
        resourceVersion: linked.link.version,
      },
      traceId: context.traceId,
    });
  }
  return slackLinkRedirect(linked.outcome);
}
