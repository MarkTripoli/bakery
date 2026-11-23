import type { ExecutionTelemetry } from "./modules/execution/telemetry.ts";
import { createDeliveryStepRunner } from "./modules/delivery/delivery-steps.ts";
import { createToolCallStepRunner } from "./modules/tool-call/tool-call-step.ts";
import { createPostgresMcpPinnedStatePort } from "./modules/mcp/postgres.ts";
import { createRemoteMcpToolTransport } from "./modules/mcp/tool-transport.ts";
import { httpsMcpTransport } from "./modules/mcp/discovery-transport.ts";
import { composeEngineStepRunners } from "./modules/workflow-adapter/engine-steps.ts";
import { createSplitStepRunner } from "./modules/work/coordination-split-step.ts";
import { createLocalDeliveryTargets } from "./modules/delivery/local-delivery-targets.ts";
import {
  createSkillObjectStore,
  type probeSkillStorage,
} from "./modules/catalog/storage-backend.ts";
import { createSkillStorageRoutes } from "./modules/catalog/skill-storage-actions.ts";
import { createBackupRoutes } from "./modules/backups/actions.ts";
import type { probeBackupDestination } from "./modules/backups/s3.ts";
import type { HostResolver } from "./modules/backups/dns.ts";
import {
  type AlertChannelDependencies,
  createAlertChannelRoutes,
} from "./modules/monitoring/alert-channels.ts";
import { createAlertEvaluator } from "./modules/monitoring/alert-evaluator.ts";
import {
  type AlertRuleDependencies,
  createAlertRuleRoutes,
} from "./modules/monitoring/alert-rules.ts";
import {
  createTelemetryDestinationRoutes,
  type TelemetryDestinationDependencies,
} from "./modules/monitoring/telemetry-destinations.ts";
import {
  allowAnyAddress,
  createDestinationFanout,
  createPinnedFetch,
  createProviderRegistry,
  createPublicHttpsPolicy,
  otlpProvider,
} from "./platform/telemetry-destinations/index.ts";
import {
  createEmailSettingsRoutes,
  type EmailSettingsDependencies,
} from "./modules/work/email-actions.ts";
import { createClientCredentialsRoutes } from "./modules/integrations/client-credentials.ts";
import { createAgentsRoutes } from "./modules/agents/index.ts";
import { createProviderReadRoutes } from "./modules/execution/provider-read-routes.ts";
import { createRouteContinuationRoutes } from "./modules/execution/route-continuations.ts";
import { createRepositoryRulesRoutes } from "./modules/repository-rules/index.ts";
import { createArtifactKindsRoutes } from "./modules/artifact-kinds/index.ts";
import { createMemoryRoutes } from "./modules/knowledge/memory-routes.ts";
import { createPluginPackageRoutes } from "./modules/catalog/plugin-routes.ts";
import { githubIngress } from "./modules/catalog/integration-providers/github-ingress.ts";
import {
  TICKET_CREATE_ACTION,
  TICKET_LABEL_REMOVE_ACTION,
  TICKET_LABELS_ADD_ACTION,
  TICKET_NOTE_ACTION,
  TICKET_NOTE_UPDATE_ACTION,
} from "./modules/catalog/integration-providers/github.ts";
import { createGateRemoteTicketCreator } from "./modules/integrations/ticket-create.ts";
import { createGateSender } from "./modules/integrations/ticket-gate.ts";
import { createGateTicketLabelWriter } from "./modules/integrations/ticket-labels.ts";
import { createGateTicketNoteWriter } from "./modules/integrations/ticket-notes.ts";
import type { RemoteTicketCreator } from "./modules/work/ticket-create.ts";
import type { TicketLabelWriter } from "./modules/work/ticket-labels.ts";
import type { TicketNoteWriter } from "./modules/work/ticket-notes.ts";
import { createPluginInstallRoutes } from "./modules/catalog/plugin-install-routes.ts";
import { createPluginAuthoringRoutes } from "./modules/workflows/plugin-authoring/routes.ts";
import type { PluginAuthoringDependencies } from "./modules/workflows/plugin-authoring/runner.ts";
import { createDeliveryRoutes } from "./modules/delivery/index.ts";
import { createEvaluationRoutes } from "./modules/evaluations/routes.ts";
import {
  createFetchGitHubAppClient,
  createInstallationTokenBroker,
  createIntegrationsRoutes,
  createTicketFactIndex,
  createTicketSourceReader,
  type GitHubAppClient,
  type InstallationTokenBroker,
} from "./modules/integrations/index.ts";
import { createProviderRequestPort } from "./modules/integrations/credential-port.ts";
import { GITHUB_PROVIDER } from "./modules/integrations/registry.ts";
import { selectTicketSourceReader } from "./modules/work/ticket-reader-selection.ts";
import { readAppCredentials } from "./modules/integrations/callbacks.ts";
import { loadSnapshot } from "./modules/catalog/authority-snapshot-postgres.ts";
import { withPgTransaction } from "./platform/database.ts";
import { createDesktopCors } from "./platform/desktop-cors.ts";
import { createWorkflowsRoutes } from "./modules/workflows/index.ts";
import { createAutomationsRoutes } from "./modules/workflows/automations/routes.ts";
import {
  activateDeployedIntegrations,
  createCatalogRoutes,
  deployedIntegrations,
  deployedProviders,
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
import { createHealthApp, readiness } from "@bakery/contracts/health-app";
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
import { createBatchRoutes } from "./modules/work/batch-routes.ts";
import {
  createMcpActionRegistry,
  createMcpManagementRoutes,
} from "./modules/mcp/routes.ts";
import {
  createGroupRoutes,
  createNotificationRoutes,
  createRunRequestRoutes,
  createTicketRoutes,
  createWorkTaskHandlers,
  registerNotificationProjection,
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
  type BrokerOperation,
  createPluginBroker,
} from "./modules/catalog/plugin-broker.ts";
import { createPostgresInstallAuthority } from "./modules/catalog/plugin-broker-postgres.ts";
import { createRunControlRegistry } from "./modules/execution/control.ts";
import { createCatalogActionRegistry } from "./modules/catalog/actions.ts";
import { createCatalogHandlers } from "./modules/catalog/persistence.ts";
import {
  createGlobalSkillAuthority,
  withGlobalSkillInstall,
} from "./modules/catalog/global-skills.ts";
import { createArchiveRevisionAuthority } from "./modules/catalog/archive-revision.ts";
import { createAgentsActionRegistry } from "./modules/agents/actions.ts";
import { createAgentsHandlers } from "./modules/agents/postgres.ts";
import { createSessionToolRegistry } from "./modules/execution/session-registry.ts";
import { sessionOperationScopes } from "./modules/execution/session-tools.ts";
import { createRunRequestActionRegistry } from "./modules/work/run-request-actions.ts";
import {
  createArtifactPreviewHost,
  createPreviewHostDispatch,
} from "./modules/knowledge/previews/index.ts";
import {
  createDraftIsolation,
  draftIsolationOptionsFor,
} from "./modules/knowledge/draft-isolation.ts";
import { createArtifactActions } from "./modules/knowledge/resource-routes.ts";
import { ScopedOrganizationBlobStore } from "./modules/catalog/blob-store.ts";
import { createDraftResourceRoutes } from "./modules/knowledge/draft-resource-routes.ts";
import type { DraftIsolation } from "./modules/knowledge/draft-isolation.ts";
import {
  createConversationRegistry,
  createConversationRoutes,
} from "./modules/conversation/index.ts";
import { createCoordinationRoutes } from "./modules/work/coordination-routes.ts";
import {
  createApprovalRegistry,
  createApprovalRoutes,
} from "./modules/conversation/approval-routes.ts";

/** The auth provider's password hashing, read from its initialized context; undefined for a provider that exposes none. */
function providerPasswordHasher(auth: AuthHttpProvider) {
  const context = auth.$context;
  return context ? async () => (await context).password : undefined;
}

// The inbox is derived from committed domain events, so every process that
// serves requests registers the projection once, before any event is written.
registerNotificationProjection();

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
  /**
   * The typed operations a plugin job may ask the host for (#29). Production
   * registers none yet, so a job's every request is refused as unknown; tests
   * inject operations to drive the broker.
   */
  pluginBrokerOperations?: readonly BrokerOperation[];
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
  /** Writes Bakery's status note on a ticket; the integration gate by default, an in-memory one in tests. */
  ticketNoteWriter?: TicketNoteWriter;
  /** Creates a ticket in the tracker; the integration gate by default, an in-memory one in tests. */
  ticketCreator?: RemoteTicketCreator;
  /** Changes Bakery's progress labels on a ticket; the integration gate by default, an in-memory one in tests. */
  ticketLabelWriter?: TicketLabelWriter;
  draftIsolation?: DraftIsolation;
  skillFileStore?: SkillFileStoreOperations;
  /**
   * The plugin generator and preview runtime for prompt-to-private-plugin
   * authoring (#45). Absent in a deployment that configures none, in which case
   * starting a run is refused as unavailable rather than faked.
   */
  pluginAuthoring?: Omit<PluginAuthoringDependencies, "bundles">;
  /** Verification probe override; tests inject one so none reaches a provider. */
  skillStorageProbe?: typeof probeSkillStorage;
  /** Destination test runner; tests inject one so no suite reaches a real bucket. */
  backupDestinationProbe?: typeof probeBackupDestination;
  /** Destination host resolver; tests inject one so no suite touches real DNS. */
  backupDestinationResolver?: HostResolver;
  /**
   * The telemetry destinations the Monitoring settings manage: the adapters the
   * server knows, the fan-out that delivers to them and how to reach a
   * destination. The server's entry point builds it and shares the fan-out with
   * its telemetry; left out, the routes run on a fan-out nothing feeds.
   */
  telemetryDestinations?: TelemetryDestinationDependencies;
  /** Where alert messages go and how a send is made; tests inject a receiver. */
  alertChannels?: AlertChannelDependencies;
  /** How the test alert is sent; left out, it uses the channels' own fetch and address rules. */
  alertRules?: AlertRuleDependencies;
  /** Replaces the SMTP exchange of the installation email test (tests only). */
  emailSend?: EmailSettingsDependencies["send"];
  /**
   * What sends a remote MCP tool call (tool.call steps and the worker tool
   * gateway). Replaceable so a test answers without a network; HTTPS otherwise.
   */
  mcpToolTransport?: ReturnType<typeof httpsMcpTransport>;
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
  //
  // The result is BOUND, not discarded. Discarding it was a real defect: every
  // integration consumer downstream takes an `ActiveIntegrationRegistry`, so
  // dropping the one this process just validated left the registry correct,
  // reachable by `get`, and wired to nothing - a name lookup would have had to
  // be re-derived locally, which is how two views of "which providers exist"
  // start disagreeing.
  const integrationRegistry = activateDeployedIntegrations(
    deployedIntegrations,
    undefined,
    deployedProviders,
  );
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
  // The provider request port the invoke door sends through. Assembled here, once
  // per process, so the door cannot be wired without a credential source: the
  // store and the sender are created together or not at all.
  const providerRequests = createProviderRequestPort({
    database: options.pgDatabase,
    broker: installationTokenBroker,
    readAppCredentials,
    // The same broker the port mints through, so the counter the broker compares
    // against is the counter the door read.
    generationOf: (connectionId) =>
      installationTokenBroker.generation(connectionId),
    registry: integrationRegistry,
    fetch: globalThis.fetch,
    snapshotPort: {
      load: (key) =>
        withPgTransaction(
          options.pgDatabase,
          (transaction) => loadSnapshot(transaction, integrationRegistry, key),
        ),
    },
  });
  // The composition root names the provider whose comment action writes
  // the note, as it names the webhook ingress below. The ticket routes and the
  // background poll share the one writer.
  const ticketNoteWriter = options.ticketNoteWriter ??
    createGateTicketNoteWriter({
      database: options.pgDatabase,
      registry: integrationRegistry,
      providerRequests,
      noteActions: {
        github: {
          create: TICKET_NOTE_ACTION,
          update: TICKET_NOTE_UPDATE_ACTION,
        },
      },
    });
  const ticketGateSend = createGateSender({
    database: options.pgDatabase,
    registry: integrationRegistry,
    providerRequests,
  });
  const ticketCreator = options.ticketCreator ??
    createGateRemoteTicketCreator({
      send: ticketGateSend,
      createActions: { github: TICKET_CREATE_ACTION },
    });
  const ticketLabelWriter = options.ticketLabelWriter ??
    createGateTicketLabelWriter({
      send: ticketGateSend,
      labelActions: {
        github: {
          add: TICKET_LABELS_ADD_ACTION,
          remove: TICKET_LABEL_REMOVE_ACTION,
        },
      },
    });
  const integrations = {
    github: githubAppClient,
    secretsKey: options.config.secretsKey,
    broker: installationTokenBroker,
    // The activated registry travels with the other integration dependencies, so
    // a consumer that holds a provider NAME can resolve it instead of re-deriving
    // which providers exist from a second source.
    registry: integrationRegistry,
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
  // The desktop web view's origins may call the API with a bearer credential. Mounted before
  // every origin guard, because a preflight carries no credential and the guard would refuse it.
  app.use(
    "*",
    createDesktopCors({ origins: options.config.auth.desktopOrigins }),
  );
  const healthOptions = {
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
  };
  app.route("/", createHealthApp(healthOptions));
  // Shared by the REST routers and the MCP catalog tools, so both transports
  // run the same registry instances.
  // One approvals registry for the routes and for the session tools, so an
  // agent's decision runs the same handler and guard a person's does.
  // Run control for the session tools: the same handlers and guard as the route.
  const runControlRegistry = createRunControlRegistry({
    database: options.pgDatabase,
    secret: options.config.auth.secret,
    agentSpawn: options.config.agentSpawn,
  });
  const approvalRegistry = createApprovalRegistry({
    database: options.pgDatabase,
    cursorSecret: options.config.auth.secret,
  });
  const conversationRegistry = createConversationRegistry({
    database: options.pgDatabase,
    cursorSecret: options.config.auth.secret,
  });
  /**
   * The catalog operations, built here once so the worker tool gateway and the
   * catalog routes share a single registration. Two registrations would be two
   * handlers to keep in step, and the first disagreement would make a session
   * call something different from the route the rest of the product calls.
   */
  const catalogRegistry = createCatalogActionRegistry(
    withGlobalSkillInstall(
      createCatalogHandlers(options.config.auth.secret, {
        normalizeSourceLocator: options.skillSourceLocatorNormalizer,
        // A draft is started from a published version's files, read from here.
        skillFileStore,
      }),
    ),
    {
      // Listing skills installs Bakery's own skills the first time: it needs
      // the file store, so the install runs in stages under this authority.
      // An import of a web-address archive that names no version is pinned by
      // its content digest, fetched between two passes with no connection held.
      authorityRunner: createArchiveRevisionAuthority(
        createGlobalSkillAuthority(
          new PostgresAuthorityRunner(options.pgDatabase),
          skillFileStore,
        ),
        skillSourceAdapter,
      ),
      commandRunner: createPostgresCommandRunner(),
      includeSkillVersionPublication: false,
    },
  );
  /**
   * Agent operations, built here for the same reason as the catalog ones: the
   * worker tool gateway must call the same registration the agent routes serve.
   */
  const agentsRegistry = createAgentsActionRegistry(
    options.pgDatabase,
    createAgentsHandlers(options.config.auth.secret),
  );
  const artifactActions = createArtifactActions({
    database: options.pgDatabase,
    publicBaseUrl: options.config.publicBaseUrl,
    secret: options.config.auth.secret,
    artifactPreviewOrigin: previewOrigin,
    // Absent when no object store is configured; completion then fails closed
    // rather than recording a blob whose bytes exist nowhere.
    ...(skillFileStore
      ? { blobStore: new ScopedOrganizationBlobStore(skillFileStore) }
      : {}),
  });
  const taskRegistry = createTaskActionRegistry(
    options.taskHandlers ??
      createWorkTaskHandlers(options.config.auth.secret, {
        budget: options.config.budget,
        agentSpawn: options.config.agentSpawn,
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
    passwordHasher: providerPasswordHasher(auth),
    release: options.config.version,
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
  // One room registry: REST publications are announced to its editors.
  const collaborationRegistry = options.collaborationSocket?.registry ??
    createCollaborationRegistry();
  // One isolation for REST draft edits and collaboration-socket updates.
  const draftIsolation = options.draftIsolation ??
    createDraftIsolation(draftIsolationOptionsFor(options.config));
  app.route(
    "/",
    createDraftResourceRoutes({
      database: options.pgDatabase,
      // Agents reach drafts with access tokens (O50); every draft action runs
      // through PostgresAuthorityRunner, which enforces token scope.
      browserSession: tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      isolation: draftIsolation,
      collaboration: collaborationRegistry,
      // The same store the upload routes use. Present, a published version
      // names a blob instead of carrying its bytes; absent, it stores them
      // inline, and the read path serves both shapes.
      ...(skillFileStore
        ? { blobStore: new ScopedOrganizationBlobStore(skillFileStore) }
        : {}),
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
    registry: collaborationRegistry,
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
  // One broker per process. Its key and epoch exist only here: the relay calls
  // it with claims the server built, so no token is ever issued or sent.
  const pluginBroker = createPluginBroker({
    key: crypto.getRandomValues(new Uint8Array(32)),
    epoch: crypto.randomUUID(),
    authority: createPostgresInstallAuthority(options.pgDatabase),
    operations: options.pluginBrokerOperations ?? [],
  });
  app.route(
    "/",
    createExecutionRoutes({
      telemetry: options.telemetry,
      database: options.pgDatabase,
      browserSession,
      // Reads of the storage tree and file search accept an access token (the
      // command line); every write stays on the browser session.
      tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      secret: options.config.auth.secret,
      skillFileStore,
      budget: options.config.budget,
      agentSpawn: options.config.agentSpawn,
      inngest: options.config.inngest,
      secretsKey: options.config.secretsKey,
      secretsFetch: options.secretsFetch,
      pluginBroker,
      ...(skillFileStore
        ? { pluginBundles: new ScopedOrganizationBlobStore(skillFileStore) }
        : {}),
      artifactPreviewOrigin: previewOrigin,
      artifactActions,
      integrations,
      ticketNoteWriter,
      ticketLabelWriter,
      // The engine settles a tool call itself, over the integration door; the
      // delivery steps run only where the install configured a target.
      engineSteps: composeEngineStepRunners([
        // A split's plan is made and watched by the engine, as the person who
        // started the run (#422).
        createSplitStepRunner({ database: options.pgDatabase }),
        createToolCallStepRunner({
          database: options.pgDatabase,
          registry: integrationRegistry,
          providerRequests,
          // A remote MCP tool is called by this server's own broker, through the
          // pinned-tool door; the credential never leaves the server.
          mcp: {
            pinnedState: createPostgresMcpPinnedStatePort(options.database),
            transport: createRemoteMcpToolTransport({
              database: options.pgDatabase,
              secretsKey: options.config.secretsKey,
              transport: options.mcpToolTransport ?? httpsMcpTransport(),
            }),
          },
        }),
        ...(options.config.deliveryTarget
          ? [createDeliveryStepRunner({
            database: options.pgDatabase,
            targets: createLocalDeliveryTargets(options.config.deliveryTarget),
          })]
          : []),
      ]),
      // The tool gateway's MCP tools (#436): a session's calls go through the
      // same pinned-tool door and broker as a tool.call step, so the credential
      // stays on the server.
      toolGateway: {
        pinnedState: createPostgresMcpPinnedStatePort(options.database),
        transport: createRemoteMcpToolTransport({
          database: options.pgDatabase,
          secretsKey: options.config.secretsKey,
          transport: options.mcpToolTransport ?? httpsMcpTransport(),
        }),
      },
      // The tool gateway's operations: whatever these registries already
      // implement, narrowed to the operation map a session is defined by.
      // Composed rather than re-registered so a session calls the same handler
      // and the same authority guard as the route the rest of the product uses.
      sessionTools: createSessionToolRegistry({
        registries: [
          taskRegistry,
          catalogRegistry,
          agentsRegistry,
          artifactActions.registry,
          approvalRegistry,
          runControlRegistry,
          // Asking people from a step (#414): the same run request registry
          // the routes mount, so an agent's ask runs the person's handler.
          createRunRequestActionRegistry(options.pgDatabase),
          // Connection drafts (#448 S9b): the same management registry the
          // routes mount, so a draft runs the same handler and guard.
          createMcpActionRegistry(options.pgDatabase, {
            cursorSecret: options.config.auth.secret,
            secretsKey: options.config.secretsKey,
          }),
        ],
        offered: sessionOperationScopes(),
      }),
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
      registry: approvalRegistry,
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
    createProviderReadRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
    }),
  );
  app.route(
    "/",
    createRouteContinuationRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
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
    createArtifactKindsRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
    }),
  );
  app.route(
    "/",
    createMemoryRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
    }),
  );
  app.route(
    "/",
    createPluginInstallRoutes({
      database: options.pgDatabase,
      // Absent when no object store is configured; a page's document read
      // then fails closed.
      ...(skillFileStore
        ? { bundles: new ScopedOrganizationBlobStore(skillFileStore) }
        : {}),
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
    }),
  );
  app.route(
    "/",
    createPluginAuthoringRoutes({
      database: options.pgDatabase,
      ...(options.pluginAuthoring ?? {}),
      ...(skillFileStore
        ? { bundles: new ScopedOrganizationBlobStore(skillFileStore) }
        : {}),
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
    }),
  );
  app.route(
    "/",
    createPluginPackageRoutes({
      database: options.pgDatabase,
      // Absent when no object store is configured; publishing a version then
      // fails closed rather than recording a digest nobody can verify.
      ...(skillFileStore
        ? { bundles: new ScopedOrganizationBlobStore(skillFileStore) }
        : {}),
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
      merge: { github: githubAppClient, broker: installationTokenBroker },
    }),
  );
  app.route(
    "/",
    createBatchRoutes({
      database: options.pgDatabase,
      session: tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      budget: options.config.budget,
    }),
  );
  app.route(
    "/",
    createEvaluationRoutes({
      database: options.pgDatabase,
      session: tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      // The same store the artifact routes read, so a blob-backed recorded
      // output is readable by a local run.
      ...(skillFileStore
        ? { blobStore: new ScopedOrganizationBlobStore(skillFileStore) }
        : {}),
    }),
  );
  app.route(
    "/",
    createMcpManagementRoutes({
      database: options.pgDatabase,
      session: tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      secretsKey: options.config.secretsKey,
    }),
  );
  app.route(
    "/",
    createTicketRoutes({
      database: options.pgDatabase,
      session: tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      // Chosen per source, by the provider its connection names: a build that
      // deploys one provider's reader must not read another provider's sources
      // with it. A provider with no reader here fails closed rather than falling
      // back to whichever reader a map happened to yield first.
      reader: options.ticketReader ?? selectTicketSourceReader(
        new Map([
          [
            GITHUB_PROVIDER,
            createTicketSourceReader({
              ...integrations,
              database: options.pgDatabase,
            }),
          ],
        ]),
      ),
      factIndex: options.ticketFactIndex ?? createTicketFactIndex(),
      budget: options.config.budget,
      noteWriter: ticketNoteWriter,
      ticketCreator,
    }),
  );
  app.route(
    "/",
    createRunRequestRoutes({
      database: options.pgDatabase,
      session: tokenSession,
    }),
  );
  app.route(
    "/",
    createGroupRoutes({ database: options.pgDatabase, session: tokenSession }),
  );
  app.route(
    "/",
    createNotificationRoutes({
      database: options.pgDatabase,
      session: tokenSession,
      cursorSecret: options.config.auth.secret,
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
      // The webhook path is GitHub's, so the composition root - the one place
      // that already names the GitHub App client above - names its ingress too.
      ingress: githubIngress,
      // The one activated registry this process owns, bound above and handed to
      // the invoke door. Every consumer now reads the same set of deployed
      // providers instead of re-deriving one.
      integrationRegistry,
      providerRequests,
    }),
  );
  app.route(
    "/",
    createWorkflowsRoutes({
      database: options.pgDatabase,
      browserSession,
      tokenSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      skillFileStore,
    }),
  );
  app.route(
    "/",
    createAutomationsRoutes({
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
      agentSpawn: options.config.agentSpawn,
      inngest: options.config.inngest,
      secretsKey: options.config.secretsKey,
      secretsFetch: options.secretsFetch,
      pluginBroker,
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
  // Outbound alert and telemetry sends dial only the addresses they checked, so
  // a name that answers differently the second time cannot reach a private
  // network. A test environment may run its receiver on loopback, over http.
  const egressFetch = options.config.environment === "test"
    ? fetch
    : createPinnedFetch();
  const alertChannelDependencies: AlertChannelDependencies =
    options.alertChannels ?? {
      secretsKey: options.config.secretsKey,
      fetch: egressFetch,
      // A test environment may run its receiver on loopback.
      addressPolicy: options.config.environment === "test"
        ? allowAnyAddress
        : createPublicHttpsPolicy(),
    };
  app.route(
    "/",
    createAlertChannelRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      dependencies: alertChannelDependencies,
    }),
  );
  app.route(
    "/",
    createAlertRuleRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      // The test alert goes through the same channels, fetch and address rules
      // as the channel routes; the timed checks run from main.ts.
      dependencies: options.alertRules ?? createAlertEvaluator({
        database: options.pgDatabase,
        ...alertChannelDependencies,
      }),
    }),
  );
  app.route(
    "/",
    createTelemetryDestinationRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      cursorSecret: options.config.auth.secret,
      dependencies: options.telemetryDestinations ?? {
        registry: createProviderRegistry([otlpProvider]),
        fanout: createDestinationFanout({
          registry: createProviderRegistry([otlpProvider]),
          dependencies: { fetch: egressFetch, addressPolicy: allowAnyAddress },
        }),
        providerDependencies: {
          fetch: egressFetch,
          // A test environment may run its receiver on loopback.
          addressPolicy: options.config.environment === "test"
            ? allowAnyAddress
            : createPublicHttpsPolicy(),
        },
        secretsKey: options.config.secretsKey,
      },
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
    createBackupRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      secret: options.config.auth.secret,
      // The Updates page: which release this process is and its own health check.
      running: () => ({
        release: options.config.version,
        healthy: async () => (await readiness(healthOptions)).state === "ok",
      }),
      settings: {
        secretsKey: options.config.secretsKey,
        allowLoopbackEndpoint: options.config.environment === "test",
        probe: options.backupDestinationProbe,
        resolve: options.backupDestinationResolver,
      },
    }),
  );
  app.route(
    "/",
    createClientCredentialsRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      secretsKey: options.config.secretsKey,
    }),
  );
  app.route(
    "/",
    createEmailSettingsRoutes({
      database: options.pgDatabase,
      browserSession,
      publicBaseUrl: options.config.publicBaseUrl,
      dependencies: {
        secretsKey: options.config.secretsKey,
        send: options.emailSend,
        // Only a test environment may reach a loopback fixture over plain SMTP.
        allowPlainLoopback: options.config.environment === "test",
      },
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
      sourceAdapter: skillSourceAdapter,
      normalizeSourceLocator: options.skillSourceLocatorNormalizer,
      registry: catalogRegistry,
    }),
  );
  return app;
}
