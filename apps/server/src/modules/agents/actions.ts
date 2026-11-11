import type { z } from "zod";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  AgentImplementedAction,
  agentImplementedActions,
  assertImplementedActionRegistry,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";

export type AgentsActionHandlers = {
  listAgents: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<AgentDefinition>"]>>;
  getAgent: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.AgentDefinition>>;
  createAgent: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.NamedDefinitionCreate>,
  ) => Promise<z.output<typeof contractSchemas.AgentDefinition>>;
  updateAgent: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.DefinitionUpdate>,
  ) => Promise<z.output<typeof contractSchemas.AgentDefinition>>;
  activateVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.AgentVersionActivate>,
  ) => Promise<z.output<typeof contractSchemas.AgentDefinition>>;
  createVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.AgentVersionCreate>,
  ) => Promise<z.output<typeof contractSchemas.AgentVersion>>;
  listVersions: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<AgentVersion>"]>>;
};

export function createAgentsActionRegistry(
  database: PgDatabase,
  handlers: AgentsActionHandlers,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const queryPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  const commandPolicy = {
    ...queryPolicy,
    type: ActionKind.Command,
    access: ActionAccess.Admin,
  } as const;

  registry.register({
    name: AgentImplementedAction.AgentsList,
    method: HttpMethod.Get,
    path: "/v1/agents",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<AgentDefinition>"],
    policy: queryPolicy,
    handler: handlers.listAgents,
  });
  registry.register({
    name: AgentImplementedAction.AgentsGet,
    method: HttpMethod.Get,
    path: "/v1/agents/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.AgentDefinition,
    policy: queryPolicy,
    handler: handlers.getAgent,
  });
  registry.register({
    name: AgentImplementedAction.AgentsCreate,
    method: HttpMethod.Post,
    path: "/v1/agents",
    input: contractSchemas.NamedDefinitionCreate,
    output: contractSchemas.AgentDefinition,
    policy: commandPolicy,
    handler: handlers.createAgent,
  });
  registry.register({
    name: AgentImplementedAction.AgentsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/agents/:id",
    input: contractSchemas.DefinitionUpdate,
    output: contractSchemas.AgentDefinition,
    policy: commandPolicy,
    handler: handlers.updateAgent,
  });
  registry.register({
    name: AgentImplementedAction.AgentsActivateVersion,
    method: HttpMethod.Post,
    path: "/v1/agents/:id/activations",
    input: contractSchemas.AgentVersionActivate,
    output: contractSchemas.AgentDefinition,
    policy: commandPolicy,
    explicitIdempotency: "key-and-if-match",
    successStatus: 200,
    handler: handlers.activateVersion,
  });
  registry.register({
    name: AgentImplementedAction.AgentVersionsCreate,
    method: HttpMethod.Post,
    path: "/v1/agents/:id/versions",
    input: contractSchemas.AgentVersionCreate,
    output: contractSchemas.AgentVersion,
    policy: commandPolicy,
    handler: handlers.createVersion,
  });
  registry.register({
    name: AgentImplementedAction.AgentVersionsList,
    method: HttpMethod.Get,
    path: "/v1/agents/:id/versions",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<AgentVersion>"],
    policy: queryPolicy,
    handler: handlers.listVersions,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, agentImplementedActions);
  return registry;
}
