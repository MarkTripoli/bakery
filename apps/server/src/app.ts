import type { ExecutionTelemetry } from "./modules/execution/telemetry.ts";
import {
  createSkillObjectStore,
  type probeSkillStorage,
} from "./modules/catalog/storage-backend.ts";
import { createSkillStorageRoutes } from "./modules/catalog/skill-storage-actions.ts";
import { createAgentsRoutes } from "./modules/agents/index.ts";
import { createRepositoryRulesRoutes } from "./modules/repository-rules/index.ts";
import { createDeliveryRoutes } from "./modules/delivery/index.ts";
import {
  createFetchGitHubAppClient,
  createInstallationTokenBroker,
  createIntegrationsRoutes,
  createTicketFactIndex,
  createTicketSourceReader,
  type GitHubAppClient,
  type InstallationTokenBroker,
} from "./modules/integrations/index.ts";
import { createWorkflowsRoutes } from "./modules/workflows/index.ts";
import {
  activateDeployedIntegrations,
  createCatalogRoutes,
  deployedIntegrations,
} from "./modules/catalog/index.ts";
import {
  createSkillSourceAdapter,
  type normalizeSkillSourceLocator,
  type SkillSourceAdapter,
} from "./modules/catalog/source-adapters.ts";
import type { SkillImportProcessHooks } from "./modules/catalog/import-workflow.ts";
import { type SkillFileStoreOperations } from "./modules/catalog/storage.ts";
import { createSecretsRoutes } from "./modules/secrets/routes.ts";
import { createWorkflowActionRoutes } from "./modules/workflow-actions/routes.ts";
import { Hono } from "hono";
import {
  assertRuntimeConfig,
  availableLocalesFor,
  type RuntimeConfig,
} from "@bakery/config";
import { contractSchemas } from "@bakery/contracts/contracts";
import { createHealthApp } from "@bakery/contracts/health-app";
import {
  createApiRouter,
  problemResponse,
  StandardError,
} from "@bakery/contracts/http";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { createAuthProvider, createAuthRoutes } from "./modules/auth/index.ts";
import { createAuthActionRegistry } from "./modules/auth/transport/http/v1/routes.ts";
import { createMcpGrantStore } from "./modules/auth/adapters/oauth-grants.ts";
import { resolvePrincipal } from "./modules/auth/application/identity.ts";
import { REMOTE_ADDRESS_HEADER } from "./modules/auth/adapters/better-auth.ts";
import { createMcpMetadataRoutes } from "./platform/mcp/metadata.ts";
import { createMcpRoutes } from "./platform/mcp/server.ts";
import {
  type CollaborationRegistry,
  type CollaborationSocketHandlerOptions,
  type CollaborationSocketLimits,
  createCollaborationRegistry,
  createCollaborationSocketHandler,
} from "./modules/knowledge/collaboration-socket.ts";
import { createMcpToolRunner } from "./platform/mcp/tools.ts";
import { createMcpCatalogTools } from "./platform/mcp/catalog-tools.ts";
import { mcpResourceUrl, oauthIssuerUrl } from "./platform/mcp/scopes.ts";
import {
  type AuthPersistence,
  createPostgresAuthPersistence,
  type SessionStore,
} from "./modules/auth/adapters/postgres.ts";
import { PostgresAuthorityRunner } from "./modules/auth/adapters/authority-postgres.ts";
import type { InstallationSettingsReader } from "./modules/auth/application/installation-settings.ts";
import { createPostgresInstallationSettingsReader } from "./modules/auth/adapters/installation-settings-postgres.ts";
import type { IdentityStore } from "./modules/auth/application/identity.ts";
import { AuthErrorCode } from "./modules/auth/domain/errors.ts";
import {
  type AuthVariables,
  createActionContext,
  createBrowserSessionMiddleware,
  createOriginGuard,
} from "./modules/auth/middleware.ts";
import type { AuthHttpProvider } from "./modules/auth/transport/http/routes.ts";
import {
  createEventsSocketHandler,
  createEventsSocketRegistry,
  type EventsSocketLimits,
  type EventsSocketRegistry,
} from "./modules/work/events-socket.ts";
import {
  createTicketRoutes,
  createWorkTaskHandlers,
} from "./modules/work/index.ts";
import type {
  TicketFactIndex,
  TicketSourceReader,
} from "./modules/work/ticket-source-reader.ts";
import { createPostgresCommandRunner } from "./platform/command-replay.ts";
import type { Database, PgDatabase } from "./platform/database.ts";
import {
  createTaskActionRegistry,
  type TaskActionHandlers,
} from "./task-actions.ts";
import {
  createProjectsActionRegistry,
  createProjectsHandlers,
} from "./modules/projects/index.ts";

import { createExecutionRoutes } from "./modules/execution/index.ts";
import {
  createArtifactPreviewHost,
  createPreviewHostDispatch,
} from "./modules/knowledge/previews/index.ts";
import { createDraftIsolation } from "./modules/knowledge/draft-isolation.ts";
import { createArtifactActions } from "./modules/knowledge/resource-routes.ts";
import { createDraftResourceRoutes } from "./modules/knowledge/draft-resource-routes.ts";
import type { DraftIsolation } from "./modules/knowledge/draft-isolation.ts";
import {
  createConversationRegistry,
  createConversationRoutes,
} from "./modules/conversation/index.ts";
import { createCoordinationRoutes } from "./modules/work/coordination-routes.ts";
import { createApprovalRoutes } from "./modules/conversation/approval-routes.ts";

export function createApp(options: {
  /**
   * Told of lease renewals, completions and usage settlements after they have
   * committed. Optional: the server behaves the same without it.
   */
  telemetry?: ExecutionTelemetry;
  config: RuntimeConfig;
  database: Database;
  pgDatabase: PgDatabase;
  auth?: AuthHttpProvider;
  authPersistence?: AuthPersistence & IdentityStore & SessionStore;
  installationSettings?: InstallationSettingsReader;
  taskHandlers?: TaskActionHandlers;
  secretsFetch?: typeof fetch;
  /** GitHub App API port; the fetch client against api.github.com by default. */
  githubAppClient?: GitHubAppClient;
  /**
   * The process's installation token broker; tests inject one to drive a
   * reconcile against the same cache the API uses.
   */
  installationTokenBroker?: InstallationTokenBroker;
  /** Ticket reads for admission; the GitHub-backed reader by default, an in-memory one in tests. */
  ticketReader?: TicketSourceReader;
  /** Fact index sync candidates come from; the stored-fact index by default. */
  ticketFactIndex?: TicketFactIndex;
  draftIsolation?: DraftIsolation;
  skillFileStore?: SkillFileStoreOperations;
  /** Verification probe override; tests inject one so none reaches a provider. */
  skillStorageProbe?: typeof probeSkillStorage;
  skillSourceAdapter?: SkillSourceAdapter;
  skillSourceLocatorNormalizer?: typeof normalizeSkillSourceLocator;
  skillImportProcessHooks?: SkillImportProcessHooks;
  eventsSocket?: {
    registry?: EventsSocketRegistry;
    limits?: Partial<EventsSocketLimits>;
  };
  /** Collaboration socket overrides; tests share the registry and tighten the bounds. */
  collaborationSocket?: {
    registry?: CollaborationRegistry;
    limits?: Partial<CollaborationSocketLimits>;
    now?: () => Date;
    upgradeWebSocket?: CollaborationSocketHandlerOptions["upgradeWebSocket"];
  };
}) {
  assertRuntimeConfig(options.config);
  // Fails startup closed when a deployed native violates manifest, profile or handler parity.
  activateDeployedIntegrations(deployedIntegrations);
  if (!options.config.auth) throw new Error(AuthErrorCode.ConfigRequired);
  const installationSettings = options.installationSettings ??
    createPostgresInstallationSettingsReader(options.pgDatabase);
  const persistence = options.authPersistence ??
    createPostgresAuthPersistence(options.pgDatabase);
  const skillStorage = {
    filesystemRoot: options.config.skillFileRoot?.root,
    secretsKey: options.config.secretsKey,
    allowLoopbackEndpoint: options.config.environment === "test",
  };
  const skillFileStore = options.skillFileStore ??
    createSkillObjectStore(options.pgDatabase, skillStorage);
  const skillSourceAdapter = options.skillSourceAdapter ??
    createSkillSourceAdapter(options.config.skillFileRoot?.root);
  const auth = options.auth ?? createAuthProvider({
    pgDatabase: options.pgDatabase,
    config: options.config.auth,
    persistence,
    installationSettings,
  });
  // One GitHub client and one token broker per process: the API and the
  // background lifecycle functions invalidate the same token cache.
  const githubAppClient = options.githubAppClient ??
    createFetchGitHubAppClient();
  const installationTokenBroker = options.installationTokenBroker ??
    createInstallationTokenBroker({
      github: githubAppClient,
      secretsKey: options.config.secretsKey,
    });
  const integrations = {
    github: githubAppClient,
    secretsKey: options.config.secretsKey,
    broker: installationTokenBroker,
  };
  const app = new Hono();
  app.onError((error, context) =>
    problemResponse(context, error, {
      publicBaseUrl: options.config.publicBaseUrl,
    })
  );
  app.notFound((context) =>
    problemResponse(
      context,
      new StandardError({ code: "RESOURCE_NOT_FOUND" }),
      { publicBaseUrl: options.config.publicBaseUrl },
    )
  );
  // Artifact previews run on a separate origin served by this same listener.
  // Dispatch happens first, by Host: the preview host answers only its two
  // routes and sees no Bakery middleware, cookie or header; the application
  // host does not serve those routes at all.
  const previewOrigin = options.config.artifactPreviewOrigin;
  const previewHandler = previewOrigin
    ? createArtifactPreviewHost({
      database: options.pgDatabase,
      previewOrigin,
      publicBaseUrl: options.config.publicBaseUrl,
      secret: options.config.auth.secret,
    })
    : undefined;
  app.use("*", createPreviewHostDispatch(previewOrigin, previewHandler));
  app.route(
    "/",
    createHealthApp({
      service: "bakery-server",
      version: options.config.version,
      config: options.config,
      dependencies: [
        {
          name: "database",
          check: async () => {
            await options.database`select 1`;
            return true;
          },
        },
        {
          name: "postgres",
          check: async () => {
            await options.pgDatabase.query("select 1");
            return true;
          },
        },
      ],
    }),
  );
  // Shared by the REST routers and the MCP catalog tools, so both transports
  // run the same registry instances.
  const conversationRegistry = createConversationRegistry({
    database: options.pgDatabase,
    cursorSecret: options.config.auth.secret,
  });
  const artifactActions = createArtifactActions({
    database: options.pgDatabase,
    publicBaseUrl: options.config.publicBaseUrl,
    secret: options.config.auth.secret,
    artifactPreviewOrigin: previewOrigin,
  });
  const taskRegistry = createTaskActionRegistry(
    options.taskHandlers ??
      createWorkTaskHandlers(options.config.auth.secret, {
        budget: options.config.budget,
      }),
    {
      authorityRunner: new PostgresAuthorityRunner(options.pgDatabase),
      commandRunner: createPostgresCommandRunner(),
    },
  );
  const projectsRegistry = createProjectsActionRegistry(
    createProjectsHandlers(options.config.auth.secret),
    {
      authorityRunner: new PostgresAuthorityRunner(options.pgDatabase),
      commandRunner: createPostgresCommandRunner(),
    },
  );
  // The MCP resource acts as the grant's person, loaded live on every call.
  const loadMcpSubject = async (providerUserId: string) => {
    const subject = await resolvePrincipal(persistence, providerUserId);
    const user = await options.pgDatabase.query<
      { email: string; twoFactorEnabled: boolean | null }
    >(
      'select email, "twoFactorEnabled" from public."user" where id = $1',
      [providerUserId],
    );
    return {
      ...subject,
      providerUserId,
      email: user.rows[0]?.email,
      twoFactorEnabled: user.rows[0]?.twoFactorEnabled === true,
    };
  };
  const authRegistry = createAuthActionRegistry({
    database: options.pgDatabase,
    secret: options.config.auth.secret,
    installationSettings,
    availableLocales: availableLocalesFor(options.config.environment),
    publicBaseUrl: options.config.publicBaseUrl,
  });
  app.route(
    "/",
    createAuthRoutes({
      auth,
      database: options.pgDatabase,
      store: persistence,
      publicBaseUrl: options.config.publicBaseUrl,
      trustedOrigins: options.config.auth.trustedOrigins,
      secret: options.config.auth.secret,
      installationSettings,
      availableLocales: availableLocalesFor(options.config.environment),
      registry: authRegistry,
    }),
  );
  const publicOrigin = options.config.auth.publicOrigin;
  const jwksCacheKey = {};
  app.route(
    "/",
    createMcpMetadataRoutes({
      publicOrigin,
      providerHandler: (request) => auth.handler(request),
    }),
  );
  app.route(
    "/",
    createMcpRoutes({
      allowedOrigins: [
        new URL(publicOrigin).origin,
        ...options.config.auth.trustedOrigins,
      ],
      guard: {
        publicOrigin,
        store: createMcpGrantStore(options.pgDatabase),
        verifyToken: (token) =>
          verifyJwsAccessToken(token, {
            jwksCacheKey,
            jwksFetch: async () => {
              const response = await auth.handler(
                new Request(`${new URL(publicOrigin).origin}/api/auth/jwks`, {
                  headers: { [REMOTE_ADDRESS_HEADER]: "127.0.0.1" },
                }),
              );
              return response.ok ? await response.json() : undefined;
            },
            verifyOptions: {
              issuer: oauthIssuerUrl(publicOrigin),
              audience: mcpResourceUrl(publicOrigin),
            },
          }),
      },
      tools: createMcpToolRunner({
        publicOrigin,
        registry: authRegistry,
        loadSubject: loadMcpSubject,
      }),
      catalog: createMcpCatalogTools({
        publicOrigin,
        registries: [
          taskRegistry,
          projectsRegistry,
          artifactActions.registry,
          conversationRegistry,
        ],
        loadSubject: loadMcpSubject,
        overrides: {
          // Content is never returned to a model as bytes: the tool answers
          // with an authorized reference, read under the content action's own
          // authority, plus the URI an authenticated client can fetch.
          "artifactVersions.content": async (
            { request, principal, params },
          ) => {
            // The same parsing as the REST route, so a malformed id is the
            // same MALFORMED_REQUEST here as there (toProblem maps it).
            const { id } = contractSchemas.IdPath.parse(params);
            contractSchemas.ContentRangeQuery.parse({});
            const reference = await artifactActions.authority.run(
              artifactActions.registry.get("artifactVersions.content"),
              {
                request,
                params: { id },
                requestId: crypto.randomUUID(),
                traceId: crypto.randomUUID().replaceAll("-", ""),
                signal: AbortSignal.timeout(15_000),
                principal,
              } as Parameters<typeof artifactActions.authority.run>[1],
              {},
              (context) =>
                artifactActions.handlers.readArtifactVersionReference(context),
            ) as { versionId: string };
            return {
              ...reference,
              resourceUri: `bakery://artifact-versions/${reference.versionId}`,
              contentUrl:
                `${publicOrigin}/v1/artifact-versions/${reference.versionId}/content`,
            };
          },
        },
      }),
    }),
  );
  const browserSession = createBrowserSessionMiddleware({
    auth,
    store: persistence,
    publicBaseUrl: options.config.publicBaseUrl,
    trustedOrigins: options.config.auth.trustedOrigins,
    secret: options.config.auth.secret,
  });
  // Same session middleware, additionally accepting access tokens. Only for
  // routers whose every action runs through `PostgresAuthorityRunner`, which
  // enforces a token's organization and scopes.
  const tokenSession = createBrowserSessionMiddleware({
    auth,
    store: persistence,
    publicBaseUrl: options.config.publicBaseUrl,
    trustedOrigins: options.config.auth.trustedOrigins,
    secret: options.config.auth.secret,
    acceptAccessTokens: true,
  });
  // One isolation for REST draft edits and collaboration-socket updates.
  const draftIsolation = options.draftIsolation ??
    createDraftIsolation({
      launcher: options.config.draftIsolationLauncher ?? "systemd",
    });
  app.route(
    "/",
    createDraftResourceRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      isolation: draftIsolation,
    }),
  );
  const eventsRegistry = options.eventsSocket?.registry ??
    createEventsSocketRegistry();
  const eventsHandler = createEventsSocketHandler({
    database: options.pgDatabase,
    store: persistence,
    secret: options.config.auth.secret,
    publicBaseUrl: options.config.publicBaseUrl,
    registry: eventsRegistry,
    limits: options.eventsSocket?.limits,
  });
  app.use(
    "/v1/events",
    createOriginGuard({
      publicBaseUrl: options.config.publicBaseUrl,
      trustedOrigins: options.config.auth.trustedOrigins,
    }),
  );
  app.use("/v1/events", browserSession);
  const collaborationHandler = createCollaborationSocketHandler({
    isolation: draftIsolation,
    database: options.pgDatabase,
    store: persistence,
    secret: options.config.auth.secret,
    publicBaseUrl: options.config.publicBaseUrl,
    registry: options.collaborationSocket?.registry ??
      createCollaborationRegistry(),
    limits: options.collaborationSocket?.limits,
    now: options.collaborationSocket?.now,
    upgradeWebSocket: options.collaborationSocket?.upgradeWebSocket,
  });
  app.use(
    "/v1/collaboration",
    createOriginGuard({
      publicBaseUrl: options.config.publicBaseUrl,
      trustedOrigins: options.config.auth.trustedOrigins,
    }),
  );
  app.use("/v1/collaboration", browserSession);
  app.get("/v1/collaboration", collaborationHandler);
  app.all("/v1/collaboration", (context) =>
    problemResponse(
      context,
      new StandardError({ code: "METHOD_NOT_ALLOWED" }),
      { publicBaseUrl: options.config.publicBaseUrl, allow: "GET" },
    ));
  app.get("/v1/events", eventsHandler);
  app.all("/v1/events", (context) =>
    problemResponse(
      context,
      new StandardError({ code: "METHOD_NOT_ALLOWED" }),
      { publicBaseUrl: options.config.publicBaseUrl, allow: "GET" },
    ));
  app.route(
    "/",
    createExecutionRoutes({
      telemetry: options.telemetry,
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      secret: options.config.auth.secret,
      skillFileStore,
      budget: options.config.budget,
      inngest: options.config.inngest,
      secretsKey: options.config.secretsKey,
      secretsFetch: options.secretsFetch,
      artifactPreviewOrigin: previewOrigin,
      artifactActions,
      integrations,
      ...(skillFileStore
        ? {
          skillImport: {
            sourceAdapter: skillSourceAdapter,
            skillFileStore,
            processHooks: options.skillImportProcessHooks,
          },
        }
        : {}),
    }),
  );
  const tasks = new Hono<{ Variables: AuthVariables }>();
  tasks.use("/v1/tasks/*", tokenSession);
  tasks.use("/v1/runs/*", tokenSession);
  tasks.use("/v1/workflow-presets", tokenSession);
  tasks.use("/v1/sync", tokenSession);
  tasks.use("/v1/usage", tokenSession);
  tasks.route(
    "/",
    createApiRouter({
      registry: taskRegistry,
      publicBaseUrl: options.config.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  app.route("/", tasks);
  app.route(
    "/",
    createConversationRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      registry: conversationRegistry,
    }),
  );
  app.route(
    "/",
    createApprovalRoutes({
      database: options.pgDatabase,
      session: tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
    }),
  );
  const projects = new Hono<{ Variables: AuthVariables }>();
  projects.use("/v1/applications/*", tokenSession);
  projects.use("/v1/repositories/*", tokenSession);
  projects.use("/v1/repository-onboardings/*", tokenSession);
  projects.use("/v1/repository-profile-observations/*", tokenSession);
  projects.route(
    "/",
    createApiRouter({
      registry: projectsRegistry,
      publicBaseUrl: options.config.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  app.route("/", projects);
  app.route(
    "/",
    createCoordinationRoutes({
      database: options.pgDatabase,
      session: tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
    }),
  );
  app.route(
    "/",
    createAgentsRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
    }),
  );
  app.route(
    "/",
    createRepositoryRulesRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
    }),
  );
  app.route(
    "/",
    createDeliveryRoutes({
      database: options.pgDatabase,
      session: tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
    }),
  );
  app.route(
    "/",
    createTicketRoutes({
      database: options.pgDatabase,
      session: tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      reader: options.ticketReader ?? createTicketSourceReader({
        ...integrations,
        database: options.pgDatabase,
      }),
      factIndex: options.ticketFactIndex ?? createTicketFactIndex(),
      budget: options.config.budget,
    }),
  );
  app.route(
    "/",
    createIntegrationsRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      secretsKey: options.config.secretsKey,
      githubAppClient,
      broker: installationTokenBroker,
      cursorSecret: options.config.auth.secret,
    }),
  );
  app.route(
    "/",
    createWorkflowsRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
    }),
  );
  app.route(
    "/",
    createExecutionRoutes({
      telemetry: options.telemetry,
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      secret: options.config.auth.secret,
      budget: options.config.budget,
      inngest: options.config.inngest,
      secretsKey: options.config.secretsKey,
      secretsFetch: options.secretsFetch,
      artifactPreviewOrigin: previewOrigin,
    }),
  );

  app.route(
    "/",
    createSecretsRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      key: options.config.secretsKey,
      fetcher: options.secretsFetch,
    }),
  );
  app.route(
    "/",
    createWorkflowActionRoutes({
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
    }),
  );
  app.route(
    "/",
    createSkillStorageRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      dependencies: { ...skillStorage, probe: options.skillStorageProbe },
    }),
  );
  app.route(
    "/",
    createCatalogRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      skillFileRoot: options.config.skillFileRoot?.root,
      skillFileStore,
      normalizeSourceLocator: options.skillSourceLocatorNormalizer,
    }),
  );
  return app;
}
