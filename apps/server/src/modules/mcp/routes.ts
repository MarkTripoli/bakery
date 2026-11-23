import { Hono, type MiddlewareHandler } from "hono";
import {
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  CapabilityBindingImplementedAction as BindingAction,
  capabilityBindingImplementedActions,
  McpConnectionImplementedAction as ConnectionAction,
  mcpConnectionImplementedActions,
  McpServerImplementedAction as Action,
  mcpServerImplementedActions,
  ToolGatewayCallImplementedAction as GatewayCallAction,
  toolGatewayCallImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createApiRouter, StandardError } from "@bakery/contracts/http";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import type { SecretsKeyConfig } from "@bakery/config";
import {
  createMcpConnectionCreator,
  createMcpConnectionsListHandler,
  createMcpConnectionUpdater,
  getMcpConnection,
} from "./connection-commands.ts";
import {
  listMcpToolClassifications,
  putMcpToolClassification,
} from "./classification-commands.ts";
import {
  createCapabilityBinding,
  createCapabilityBindingsListHandler,
  deleteCapabilityBinding,
} from "./binding-commands.ts";
import { settleToolGatewayCall } from "./gateway-call-commands.ts";
import {
  createMcpUseGrant,
  listMcpUseGrants,
  revokeMcpUseGrant,
} from "./use-grant-commands.ts";
import {
  createMcpDiscoverer,
  getMcpCapabilities,
} from "./connection-discovery.ts";
import { httpsMcpTransport, type McpTransport } from "./discovery-transport.ts";
import {
  createMcpServer,
  createMcpServersListHandler,
  getMcpServer,
  updateMcpServer,
} from "./server-commands.ts";

/**
 * The role floor for an action whose access depends on the object (organization
 * scope is an Admin's, personal scope is the owner's). The runner only trusts the
 * three base access levels on their own; anything else needs a guard of its own. This
 * is that guard: the caller must be a Developer or an Admin. Which object they may
 * touch is decided by the handler, which reads the row.
 */
export function requireDeveloperOrAdmin(context: ActionContext): void {
  const role = (context as unknown as { authority?: { role?: string } })
    .authority?.role;
  if (role !== "admin" && role !== "developer") {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

/** The MCP management registry: server definitions (#434), growing as slices land. */
export function createMcpActionRegistry(
  database: PgDatabase,
  dependencies: {
    cursorSecret: string;
    secretsKey: SecretsKeyConfig | undefined;
    /** Replaceable so a test can answer discovery without a network. */
    transport?: McpTransport;
  },
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const organizationContext =
    OrganizationContextPolicy.RequiredAuthenticatedContext;
  const query = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext,
  } as const;
  const admin = {
    type: ActionKind.Command,
    access: ActionAccess.Admin,
    organizationContext,
  } as const;

  registry.register({
    name: Action.McpServersList,
    method: HttpMethod.Get,
    path: "/v1/mcp-servers",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<McpServer>"],
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createMcpServersListHandler(dependencies.cursorSecret),
  }).register({
    name: Action.McpServersGet,
    method: HttpMethod.Get,
    path: "/v1/mcp-servers/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.McpServer,
    policy: query,
    handler: getMcpServer,
  }).register({
    name: Action.McpServersCreate,
    method: HttpMethod.Post,
    path: "/v1/mcp-servers",
    input: contractSchemas.McpServerCreate,
    output: contractSchemas.McpServer,
    policy: admin,
    handler: createMcpServer,
  }).register({
    name: Action.McpServersUpdate,
    method: HttpMethod.Patch,
    path: "/v1/mcp-servers/:id",
    input: contractSchemas.McpServerUpdate,
    output: contractSchemas.McpServer,
    policy: admin,
    handler: updateMcpServer,
  });
  const personalOrAdmin = {
    type: ActionKind.Command,
    access: ActionAccess.DeveloperForPersonalAdminForOrganization,
    organizationContext,
    authorize: requireDeveloperOrAdmin,
  } as const;
  const ownerOrAdmin = {
    type: ActionKind.Command,
    access: ActionAccess.OwnerForPersonalAdminForOrganization,
    organizationContext,
    authorize: requireDeveloperOrAdmin,
  } as const;
  registry.register({
    name: ConnectionAction.McpConnectionsList,
    method: HttpMethod.Get,
    path: "/v1/mcp-connections",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<McpConnection>"],
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createMcpConnectionsListHandler(dependencies.cursorSecret),
  }).register({
    name: ConnectionAction.McpConnectionsGet,
    method: HttpMethod.Get,
    path: "/v1/mcp-connections/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.McpConnection,
    policy: query,
    handler: getMcpConnection,
  }).register({
    name: ConnectionAction.McpConnectionsCreate,
    method: HttpMethod.Post,
    path: "/v1/mcp-connections",
    input: contractSchemas.McpConnectionCreate,
    output: contractSchemas.McpConnection,
    policy: personalOrAdmin,
    handler: createMcpConnectionCreator(dependencies),
  }).register({
    name: ConnectionAction.McpConnectionsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/mcp-connections/:id",
    input: contractSchemas.McpConnectionUpdate,
    output: contractSchemas.McpConnection,
    policy: ownerOrAdmin,
    handler: createMcpConnectionUpdater(dependencies),
  }).register({
    name: ConnectionAction.McpConnectionsDiscover,
    method: HttpMethod.Post,
    path: "/v1/mcp-connections/:id/discoveries",
    input: contractSchemas.Empty,
    output: contractSchemas.McpCapabilitySnapshot,
    policy: ownerOrAdmin,
    handler: createMcpDiscoverer({
      secretsKey: dependencies.secretsKey,
      transport: dependencies.transport ?? httpsMcpTransport(),
    }),
  }).register({
    name: ConnectionAction.McpConnectionsCapabilities,
    method: HttpMethod.Get,
    path: "/v1/mcp-connections/:id/capabilities",
    input: contractSchemas.IdPath,
    output: contractSchemas.McpCapabilitySnapshot,
    policy: query,
    handler: getMcpCapabilities,
  }).register({
    name: ConnectionAction.McpToolClassificationsList,
    method: HttpMethod.Get,
    path: "/v1/mcp-connections/:id/tool-classifications",
    input: contractSchemas.IdPath,
    output: contractSchemas.McpToolClassificationList,
    policy: query,
    handler: listMcpToolClassifications,
  }).register({
    name: ConnectionAction.McpToolClassificationsPut,
    method: HttpMethod.Put,
    path: "/v1/mcp-connections/:id/tool-classifications/:toolName",
    input: contractSchemas.McpToolClassificationPut,
    output: contractSchemas.McpToolClassification,
    policy: ownerOrAdmin,
    handler: putMcpToolClassification,
  }).register({
    name: ConnectionAction.McpUseGrantsList,
    method: HttpMethod.Get,
    path: "/v1/mcp-connections/:id/use-grants",
    input: contractSchemas.IdPath,
    output: contractSchemas.McpUseGrantList,
    policy: query,
    handler: listMcpUseGrants,
  }).register({
    name: ConnectionAction.McpUseGrantsCreate,
    method: HttpMethod.Post,
    path: "/v1/mcp-connections/:id/use-grants",
    input: contractSchemas.McpUseGrantCreate,
    output: contractSchemas.McpUseGrant,
    // Consent binds a person's identity (O51): a signed-in session only.
    policy: { ...ownerOrAdmin, sessionOnly: true },
    handler: createMcpUseGrant,
  }).register({
    name: ConnectionAction.McpUseGrantsRevoke,
    method: HttpMethod.Post,
    path: "/v1/mcp-connections/:id/use-grants/:grantId/revocation",
    input: contractSchemas.Empty,
    output: contractSchemas.McpUseGrant,
    policy: { ...ownerOrAdmin, sessionOnly: true },
    handler: revokeMcpUseGrant,
  });
  // Capability bindings (#436): an Admin grants an agent version exact tools.
  registry.register({
    name: BindingAction.CapabilityBindingsList,
    method: HttpMethod.Get,
    path: "/v1/capability-bindings",
    input: contractSchemas.BindingQuery,
    output: contractSchemas["Page<CapabilityBinding>"],
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createCapabilityBindingsListHandler(dependencies.cursorSecret),
  }).register({
    name: BindingAction.CapabilityBindingsCreate,
    method: HttpMethod.Post,
    path: "/v1/capability-bindings",
    input: contractSchemas.CapabilityBindingCreate,
    output: contractSchemas.CapabilityBinding,
    policy: admin,
    handler: createCapabilityBinding,
  }).register({
    name: BindingAction.CapabilityBindingsDelete,
    method: HttpMethod.Delete,
    path: "/v1/capability-bindings/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    naturalIdempotency: true,
    policy: admin,
    handler: deleteCapabilityBinding,
  });
  // A gateway write whose outcome is unknown stays sent until an Admin who
  // checked the outside system records what happened (#436).
  registry.register({
    name: GatewayCallAction.ToolGatewayCallsSettle,
    method: HttpMethod.Post,
    path: "/v1/tool-gateway-calls/:id/settlement",
    input: contractSchemas.ToolGatewayCallSettle,
    output: contractSchemas.ToolGatewayCall,
    policy: admin,
    handler: settleToolGatewayCall,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, [
    ...mcpServerImplementedActions,
    ...mcpConnectionImplementedActions,
    ...capabilityBindingImplementedActions,
    ...toolGatewayCallImplementedActions,
  ]);
  return registry;
}

/** MCP management routes (not Bakery's own MCP endpoint), behind the token-accepting session like the other resource routes. */
export function createMcpManagementRoutes(options: {
  database: PgDatabase;
  session: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
  secretsKey: SecretsKeyConfig | undefined;
  transport?: McpTransport;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  for (
    const path of [
      "/v1/mcp-servers",
      "/v1/mcp-connections",
      "/v1/capability-bindings",
      "/v1/tool-gateway-calls",
    ]
  ) {
    app.use(path, options.session);
    app.use(`${path}/*`, options.session);
  }
  app.route(
    "/",
    createApiRouter({
      registry: createMcpActionRegistry(options.database, options),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
