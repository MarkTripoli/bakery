import { Hono, type MiddlewareHandler } from "hono";
import { type z } from "zod";
import type { SecretsKeyConfig } from "@bakery/config";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  IntegrationSlackAppImplementedAction as Action,
  integrationSlackAppImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  createApiRouter,
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { loadSecretKey } from "../secrets/crypto.ts";
import { installationActor } from "./postgres.ts";
import {
  readSlackAppCredentials,
  readSlackAppSettings,
  recordSlackCheck,
  removeSlackAppSettings,
  saveSlackAppSettings,
  type SlackAppSettings,
  type SlackCheckResult,
} from "./slack-app-credentials.ts";
import {
  checkSlackClientCredentials,
  type SlackCheckOutcome,
} from "./slack-client-check.ts";
import { openAppSecret } from "./callbacks.ts";

/**
 * The installation's Slack app, as the Integrations screen reads and writes it
 * (#415).
 *
 * ## Why the screen exists
 *
 * Slack cannot be connected by pasting a token: Slack signs every request it sends
 * and Bakery must be able to prove that signature came from it, which means Bakery
 * holds Slack's signing secret. So a person creates a Slack app, copies four values
 * into this screen, and the screen tells them which three URLs Slack wants back.
 *
 * ## What is never returned
 *
 * Both secrets are write-only. A save that omits one keeps it -- the design's
 * "Replace details" sends only what changed -- and a saved secret is reported only
 * as the time it was written, taken from the secret version rather than a duplicated
 * column, so a rotation cannot report its predecessor's date. A replaced secret
 * clears the last check: an answer about a secret that no longer exists says nothing
 * about the new one.
 *
 * ## The two status rows are not the same question
 *
 * "Sign-in details" is asked of Slack directly (`check`), because Slack will not
 * read its own credentials back; `slack-client-check.ts` explains how one call
 * separates a refused ID from a refused secret. "Last request" is not a test at all:
 * the signing secret is only ever proven by a real request arriving, which the
 * ingress route records. A screen that claimed to have "tested" it would be
 * inventing a signal.
 */

type SlackApp = z.output<typeof contractSchemas.IntegrationSlackApp>;
type SlackAppPut = z.output<typeof contractSchemas.IntegrationSlackAppPut>;
type SlackAppCheck = z.output<typeof contractSchemas.IntegrationSlackAppCheck>;

type Dependencies = {
  secretsKey: SecretsKeyConfig | undefined;
  publicBaseUrl: string;
  /** Injected so a test asks Slack nothing; the check is the only network call. */
  fetch?: typeof fetch;
};

const CLIENT_ID_MAX = 200;
const SECRET_MAX = 4096;

/** Every URL Slack asks the app for, derived from this installation's address. */
function slackAppUrls(publicBaseUrl: string) {
  return {
    redirectUrl: new URL(
      "/v1/integration-auth/slack/identity-callback",
      publicBaseUrl,
    ).href,
    eventsUrl: new URL("/v1/webhooks/slack/events", publicBaseUrl).href,
    interactivityUrl: new URL("/v1/webhooks/slack/interactions", publicBaseUrl)
      .href,
  };
}

/** The settings as the screen sees them: no secret, and the URLs Slack wants back. */
function projection(
  settings: SlackAppSettings | null,
  publicBaseUrl: string,
): SlackApp {
  return {
    appId: settings?.appId ?? null,
    clientId: settings?.clientId ?? null,
    configured: settings !== null,
    signingSecretSavedAt: settings?.signingSecretSavedAt ?? null,
    clientSecretSavedAt: settings?.clientSecretSavedAt ?? null,
    detailsCheckedAt: settings?.detailsCheckedAt ?? null,
    detailsCheckResult: settings?.detailsCheckResult ?? null,
    lastRequestAt: settings?.lastRequestAt ?? null,
    lastRequestFailedAt: settings?.lastRequestFailedAt ?? null,
    ...slackAppUrls(publicBaseUrl),
    version: settings?.version ?? 0,
  };
}

/** A pasted value must be what the person meant: printable, trimmed, bounded. */
function assertPasted(
  field: string,
  value: string,
  max: number,
  code: string,
): void {
  if (value.length === 0 || value.length > max || value !== value.trim()) {
    throw unprocessable([field], code);
  }
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point < 0x20 || point === 0x7f) throw unprocessable([field], code);
  }
}

/** integrationSlackApp.get */
export async function getSlackApp(
  context: ActionContext,
  dependencies: Dependencies,
): Promise<SlackApp> {
  const { context: value } = installationActor(context);
  return projection(
    await readSlackAppSettings(value.transaction),
    dependencies.publicBaseUrl,
  );
}

/**
 * integrationSlackApp.put: save what changed, keep what was omitted.
 *
 * `If-Match` is required once an app exists and refused when none does, which is the
 * Linear pair's rule: a first save has no version to quote, and a second editor who
 * never saw the current row must not overwrite it blind.
 */
export async function putSlackApp(
  context: ActionContext,
  input: SlackAppPut,
  dependencies: Dependencies,
): Promise<SlackApp> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;

  const appId = input.appId.trim();
  const clientId = input.clientId.trim();
  assertPasted("appId", appId, CLIENT_ID_MAX, "invalid_app_id");
  assertPasted("clientId", clientId, CLIENT_ID_MAX, "invalid_client_id");
  if (input.clientSecret !== undefined) {
    assertPasted(
      "clientSecret",
      input.clientSecret,
      SECRET_MAX,
      "invalid_client_secret",
    );
  }
  if (input.signingSecret !== undefined) {
    assertPasted(
      "signingSecret",
      input.signingSecret,
      SECRET_MAX,
      "invalid_signing_secret",
    );
  }

  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  const existing = await readSlackAppSettings(transaction);
  if (existing !== null) {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expectedVersion !== existing.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  } else if (expectedVersion !== undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }

  const key = await loadSecretKey(dependencies.secretsKey);
  const saved = await saveSlackAppSettings(transaction, {
    appId,
    clientId,
    ...(input.clientSecret === undefined
      ? {}
      : { clientSecret: input.clientSecret }),
    ...(input.signingSecret === undefined
      ? {}
      : { signingSecret: input.signingSecret }),
    principalId,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    key,
    keyId: dependencies.secretsKey!.keyId,
    operation: Action.IntegrationSlackAppPut,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return projection(saved, dependencies.publicBaseUrl);
}

/**
 * integrationSlackApp.delete: remove the details, keep the people.
 *
 * The design's dialog promises that a person linked with Slack can link again when
 * details are entered again, so the identity links and organization connections
 * survive; the two secrets go, because the app they belonged to is gone.
 */
export async function deleteSlackApp(
  context: ActionContext,
  _input: unknown,
  dependencies: Dependencies,
): Promise<SlackApp> {
  const { context: value, actor } = installationActor(context);
  await removeSlackAppSettings(value.transaction, {
    principalId: actor.subject.principalId,
    operation: Action.IntegrationSlackAppDelete,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  return projection(null, dependencies.publicBaseUrl);
}

/**
 * integrationSlackApp.check: ask Slack, then record the answer.
 *
 * Nothing about the pair is trusted before Slack answers, and the answer is stored
 * so the row still says what happened after a reload. When no app is saved there is
 * nothing to ask about, and that is a precondition, not an empty check.
 */
export async function checkSlackApp(
  context: ActionContext,
  _input: unknown,
  dependencies: Dependencies,
): Promise<SlackAppCheck> {
  const { context: value, actor } = installationActor(context);
  const transaction = value.transaction;
  // A check writes the row it read, so it names the version it is checking:
  // without one there is nothing to compare a second editor's answer against.
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const settings = await readSlackAppSettings(transaction);
  if (settings === null) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  if (settings.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const stored = await readSlackAppCredentials(transaction);
  if (stored === null) {
    // A settings row whose secrets cannot be opened is not a check result; asking
    // Slack with nothing would produce a sentence about a credential we do not have.
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const key = await loadSecretKey(dependencies.secretsKey);
  const [clientSecret] = await Promise.all([
    openAppSecret(key, stored.clientSecret),
  ]);
  const outcome: SlackCheckOutcome = await checkSlackClientCredentials({
    clientId: settings.clientId,
    clientSecret,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  await recordSlackCheck(
    transaction,
    outcome.result satisfies SlackCheckResult,
    {
      principalId: actor.subject.principalId,
      operation: Action.IntegrationSlackAppCheck,
      requestId: context.requestId,
      traceId: context.traceId,
    },
  );
  const after = await readSlackAppSettings(transaction);
  return {
    result: outcome.result,
    checkedAt: after?.detailsCheckedAt ?? new Date().toISOString(),
  };
}

export function createSlackAppActionRegistry(
  database: PgDatabase,
  dependencies: Dependencies,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
    "natural-idempotency",
  );
  const policy = {
    access: ActionAccess.InstallationAdministrator,
    organizationContext:
      OrganizationContextPolicy.InstallationAdministratorScope,
  } as const;
  registry.register({
    name: Action.IntegrationSlackAppGet,
    method: HttpMethod.Get,
    path: "/v1/integrations/slack/app",
    input: contractSchemas.Empty,
    output: contractSchemas.IntegrationSlackApp,
    policy: { ...policy, type: ActionKind.Query },
    handler: (context) => getSlackApp(context, dependencies),
  }).register({
    name: Action.IntegrationSlackAppPut,
    method: HttpMethod.Put,
    path: "/v1/integrations/slack/app",
    input: contractSchemas.IntegrationSlackAppPut,
    output: contractSchemas.IntegrationSlackApp,
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      putSlackApp(context, input as SlackAppPut, dependencies),
  }).register({
    name: Action.IntegrationSlackAppDelete,
    method: HttpMethod.Delete,
    path: "/v1/integrations/slack/app",
    input: contractSchemas.Empty,
    output: contractSchemas.IntegrationSlackApp,
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) => deleteSlackApp(context, input, dependencies),
  }).register({
    name: Action.IntegrationSlackAppCheck,
    method: HttpMethod.Post,
    path: "/v1/integrations/slack/app/check",
    input: contractSchemas.Empty,
    output: contractSchemas.IntegrationSlackAppCheck,
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) => checkSlackApp(context, input, dependencies),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(
    registry,
    integrationSlackAppImplementedActions,
  );
  return registry;
}

export function createSlackAppRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  secretsKey: SecretsKeyConfig | undefined;
  fetch?: typeof fetch;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/integrations/slack/app", options.browserSession);
  app.use("/v1/integrations/slack/app/check", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createSlackAppActionRegistry(options.database, {
        secretsKey: options.secretsKey,
        publicBaseUrl: options.publicBaseUrl,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
