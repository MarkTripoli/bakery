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
  McpConnectionImplementedAction as ConnectionAction,
  mcpConnectionImplementedActions,
  McpServerImplementedAction as Action,
  mcpServerImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createApiRouter } from "@bakery/contracts/http";
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
  } as const;
  const ownerOrAdmin = {
    type: ActionKind.Command,
    access: ActionAccess.OwnerForPersonalAdminForOrganization,
    organizationContext,
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
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, [
    ...mcpServerImplementedActions,
    ...mcpConnectionImplementedActions,
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
  for (const path of ["/v1/mcp-servers", "/v1/mcp-connections"]) {
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
