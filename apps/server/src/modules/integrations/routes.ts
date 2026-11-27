import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  type ActionRegistry,
  coerceQueryInput,
} from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import type { WebhookIngress } from "@bakery/integration-sdk";
import { IntegrationsImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  type ActionContextSeed,
  createApiRouter,
  getTraceId,
  problemResponse,
} from "@bakery/contracts/http";
import type { SecretsKeyConfig } from "@bakery/config";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createIntegrationsActionRegistry } from "./actions.ts";
import { mountIntakeRoute } from "./intake-routes.ts";
import { mountSlackIntakeRoute } from "./slack-intake-routes.ts";
import type { InstallationTokenBroker } from "./token-broker.ts";
import type { OAuth2Fetch } from "./oauth2-connect.ts";
import type {
  ActiveIntegrationRegistry,
  ProviderRequestPort,
} from "../catalog/integration-gate.ts";
import {
  createFetchGitHubAppClient,
  type GitHubAppClient,
  GitHubAppPath,
} from "./github-app.ts";

/**
 * GitHub's redirects are top-level browser navigations, so these callbacks
 * answer 303 instead of JSON. Each runs the same registered action
 * (authority, input schema, output schema) as every other transport would.
 */
async function redirectAction(
  context: Context<{ Variables: AuthVariables }>,
  registry: ActionRegistry,
  publicBaseUrl: string,
  action: string,
  input: (query: Record<string, string>) => unknown,
): Promise<Response> {
  const request = context.req.raw;
  const requestId = context.req.header("x-request-id") ?? crypto.randomUUID();
  const traceId = getTraceId(request);
  const seed = createActionContext(context);
  try {
    const result = contractSchemas.AuthRedirect.parse(
      await registry.execute(
        action,
        {
          request,
          params: context.req.param(),
          requestId,
          traceId,
          signal: request.signal,
          ...seed,
        },
        input(context.req.query()),
      ),
    );
    return new Response(null, {
      status: Number(result.status),
      headers: {
        location: result.location,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    return problemResponse(context, error, {
      publicBaseUrl,
      requestId,
      traceId,
      locale: seed.locale,
    });
  }
}

/**
 * Renames GitHub's snake_case query parameters to the contract's fields and
 * drops every other parameter; values are validated by the action schema.
 */
function providerQuery(
  query: Record<string, string>,
  names: Readonly<Record<string, string>>,
): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [wire, field] of Object.entries(names)) {
    const value = query[wire];
    if (value !== undefined) input[field] = value;
  }
  return input;
}

const SETUP_QUERY = Object.freeze({
  state: "state",
  installation_id: "installationId",
  setup_action: "setupAction",
});
/** setup_action values the contract models; `request` carries no installation. */
const SETUP_ACTIONS = new Set(["install", "update"]);
const OAUTH_QUERY = Object.freeze({
  code: "code",
  state: "state",
  error: "error",
  error_description: "errorDescription",
});

const PROVIDER_CALLBACK_PATH = "/v1/integration-auth/:provider/callback";

export function createIntegrationsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  secretsKey?: SecretsKeyConfig;
  githubAppClient?: GitHubAppClient;
  /** The process's token broker; one per registry when absent. */
  broker?: InstallationTokenBroker;
  cursorSecret: string;
  /**
   * The process's activated integration registry, bound once in `app.ts`. The
   * invoke door is the only route that needs it: it resolves the connection's
   * provider by name through it instead of re-deriving which providers exist.
   */
  integrationRegistry: ActiveIntegrationRegistry;
  /** The provider request port the invoke door sends through. */
  providerRequests?: ProviderRequestPort;
  oauth2Fetch?: OAuth2Fetch;
  /**
   * The ingress port that verifies and classifies a signed webhook delivery.
   *
   * Passed through from the composition root, which is the one place that
   * names which provider serves the webhook path.
   */
  ingress: WebhookIngress;
}) {
  const registry = createIntegrationsActionRegistry(options.database, {
    publicBaseUrl: options.publicBaseUrl,
    secretsKey: options.secretsKey,
    github: options.githubAppClient ?? createFetchGitHubAppClient(),
    cursorSecret: options.cursorSecret,
    broker: options.broker,
    integrationRegistry: options.integrationRegistry,
    ...(options.providerRequests === undefined
      ? {}
      : { providerRequests: options.providerRequests }),
    ...(options.oauth2Fetch === undefined
      ? {}
      : { oauth2Fetch: options.oauth2Fetch }),
  });
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/integration-app-registrations/github", options.browserSession);
  app.use("/v1/integration-app-registrations/github/*", options.browserSession);
  app.use(GitHubAppPath.ManifestCallback, options.browserSession);
  app.use("/v1/integration-auth-attempts", options.browserSession);
  app.use("/v1/integration-auth-attempts/*", options.browserSession);
  app.use(GitHubAppPath.Setup, options.browserSession);
  app.use(GitHubAppPath.OAuthCallback, options.browserSession);
  app.use(PROVIDER_CALLBACK_PATH, options.browserSession);
  app.use("/v1/integration-installations", options.browserSession);
  app.use("/v1/integration-installations/*", options.browserSession);
  app.use("/v1/integration-connections", options.browserSession);
  app.use("/v1/integration-connections/*", options.browserSession);
  // Registered before the JSON router so the redirect handlers serve these paths.
  app.get(
    GitHubAppPath.ManifestCallback,
    (context) =>
      redirectAction(
        context,
        registry,
        options.publicBaseUrl,
        IntegrationsImplementedAction.IntegrationManifestCallback,
        (query) =>
          coerceQueryInput(contractSchemas.IntegrationManifestCallback, query),
      ),
  );
  app.get(
    GitHubAppPath.Setup,
    (context) =>
      redirectAction(
        context,
        registry,
        options.publicBaseUrl,
        IntegrationsImplementedAction.IntegrationSetup,
        (query) => {
          const input = providerQuery(query, SETUP_QUERY);
          if (!SETUP_ACTIONS.has(input.setupAction)) delete input.setupAction;
          return coerceQueryInput(
            contractSchemas.IntegrationSetupCallback,
            input,
          );
        },
      ),
  );
  app.get(
    GitHubAppPath.OAuthCallback,
    (context) =>
      redirectAction(
        context,
        registry,
        options.publicBaseUrl,
        IntegrationsImplementedAction.IntegrationAuthorizationCallback,
        (query) =>
          coerceQueryInput(
            contractSchemas.OAuthCallback,
            providerQuery(query, OAUTH_QUERY),
          ),
      ),
  );
  app.get(
    PROVIDER_CALLBACK_PATH,
    (context) =>
      redirectAction(
        context,
        registry,
        options.publicBaseUrl,
        IntegrationsImplementedAction.IntegrationProviderAuthorizationCallback,
        (query) =>
          coerceQueryInput(
            contractSchemas.OAuthCallback,
            providerQuery(query, OAUTH_QUERY),
          ),
      ),
  );
  // GitHub's signed webhook is raw bytes with no session, so its handler is
  // mounted before the JSON router, which would otherwise own this path.
  mountIntakeRoute(app, {
    registry,
    database: options.database,
    secretsKey: options.secretsKey,
    publicBaseUrl: options.publicBaseUrl,
    ingress: options.ingress,
  });
  mountSlackIntakeRoute(app, {
    database: options.database,
    secretsKey: options.secretsKey,
  });
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      // The invoke door drives the effect ledger, which opens its own
      // transactions (lease claim, effect row, dispatch) and therefore needs the
      // pool, not the authority transaction. `createActionContext` seeds the
      // principal and nothing else, so without this the door's own
      // `contextDatabase` guard answered INTERNAL on every granted call.
      createContext: (context) =>
        ({
          ...createActionContext(context),
          database: options.database,
        }) as ActionContextSeed & { database: PgDatabase },
    }),
  );
  return app;
}
