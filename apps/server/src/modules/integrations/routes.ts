import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  type ActionRegistry,
  coerceQueryInput,
} from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { IntegrationsImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  createApiRouter,
  getTraceId,
  problemResponse,
} from "@bakery/contracts/http";
import type { SecretsKeyConfig } from "@bakery/config";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createIntegrationsActionRegistry } from "./actions.ts";
import { mountIntakeRoute } from "./intake-routes.ts";
import type { InstallationTokenBroker } from "./token-broker.ts";
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
          params: {},
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
function githubQuery(
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

export function createIntegrationsRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  secretsKey?: SecretsKeyConfig;
  githubAppClient?: GitHubAppClient;
  /** The process's token broker; one per registry when absent. */
  broker?: InstallationTokenBroker;
  cursorSecret: string;
}) {
  const registry = createIntegrationsActionRegistry(options.database, {
    publicBaseUrl: options.publicBaseUrl,
    secretsKey: options.secretsKey,
    github: options.githubAppClient ?? createFetchGitHubAppClient(),
    cursorSecret: options.cursorSecret,
    broker: options.broker,
  });
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/integration-app-registrations/github", options.browserSession);
  app.use("/v1/integration-app-registrations/github/*", options.browserSession);
  app.use(GitHubAppPath.ManifestCallback, options.browserSession);
  app.use("/v1/integration-auth-attempts", options.browserSession);
  app.use("/v1/integration-auth-attempts/*", options.browserSession);
  app.use(GitHubAppPath.Setup, options.browserSession);
  app.use(GitHubAppPath.OAuthCallback, options.browserSession);
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
        IntegrationsImplementedAction.GitHubManifestCallback,
        (query) =>
          coerceQueryInput(contractSchemas.GitHubManifestCallback, query),
      ),
  );
  app.get(
    GitHubAppPath.Setup,
    (context) =>
      redirectAction(
        context,
        registry,
        options.publicBaseUrl,
        IntegrationsImplementedAction.GitHubSetup,
        (query) => {
          const input = githubQuery(query, SETUP_QUERY);
          if (!SETUP_ACTIONS.has(input.setupAction)) delete input.setupAction;
          return coerceQueryInput(contractSchemas.GitHubSetupCallback, input);
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
        IntegrationsImplementedAction.GitHubCallback,
        (query) =>
          coerceQueryInput(
            contractSchemas.OAuthCallback,
            githubQuery(query, OAUTH_QUERY),
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
  });
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
