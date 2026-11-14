import type { z } from "zod";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  AutomationImplementedAction,
  automationImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { PostgresAuthorityRunner } from "../../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../../platform/command-replay.ts";
import type { PgDatabase } from "../../../platform/database.ts";
import {
  createAutomation,
  createAutomationFiringsListHandler,
  createAutomationsListHandler,
  createAutomationVersion,
  createAutomationVersionsListHandler,
  getAutomation,
  updateAutomation,
} from "./postgres.ts";

export type AutomationsActionHandlers = {
  list: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<Automation>"]>>;
  get: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.Automation>>;
  create: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.NamedDefinitionCreate>,
  ) => Promise<z.output<typeof contractSchemas.Automation>>;
  update: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.AutomationUpdate>,
  ) => Promise<z.output<typeof contractSchemas.Automation>>;
  listVersions: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<AutomationVersion>"]>>;
  createVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.AutomationVersionCreate>,
  ) => Promise<z.output<typeof contractSchemas.AutomationVersion>>;
  listFirings: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<AutomationFiring>"]>>;
};

export function createAutomationsHandlers(
  secret: string,
): AutomationsActionHandlers {
  return {
    list: createAutomationsListHandler(secret),
    get: getAutomation,
    create: createAutomation,
    update: updateAutomation,
    listVersions: createAutomationVersionsListHandler(secret),
    createVersion: createAutomationVersion,
    listFirings: createAutomationFiringsListHandler(secret),
  };
}

export function createAutomationsActionRegistry(
  database: PgDatabase,
  handlers: AutomationsActionHandlers,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  // Reading is for Developers, changing is for Admins, as for workflows.
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
    name: AutomationImplementedAction.AutomationsList,
    method: HttpMethod.Get,
    path: "/v1/automations",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<Automation>"],
    policy: queryPolicy,
    handler: handlers.list,
  });
  registry.register({
    name: AutomationImplementedAction.AutomationsGet,
    method: HttpMethod.Get,
    path: "/v1/automations/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Automation,
    policy: queryPolicy,
    handler: handlers.get,
  });
  registry.register({
    name: AutomationImplementedAction.AutomationsCreate,
    method: HttpMethod.Post,
    path: "/v1/automations",
    input: contractSchemas.NamedDefinitionCreate,
    output: contractSchemas.Automation,
    policy: commandPolicy,
    handler: handlers.create,
  });
  registry.register({
    name: AutomationImplementedAction.AutomationsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/automations/:id",
    input: contractSchemas.AutomationUpdate,
    output: contractSchemas.Automation,
    policy: commandPolicy,
    handler: handlers.update,
  });
  registry.register({
    name: AutomationImplementedAction.AutomationVersionsList,
    method: HttpMethod.Get,
    path: "/v1/automations/:id/versions",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<AutomationVersion>"],
    policy: queryPolicy,
    handler: handlers.listVersions,
  });
  registry.register({
    name: AutomationImplementedAction.AutomationVersionsCreate,
    method: HttpMethod.Post,
    path: "/v1/automations/:id/versions",
    input: contractSchemas.AutomationVersionCreate,
    output: contractSchemas.AutomationVersion,
    policy: commandPolicy,
    handler: handlers.createVersion,
  });
  registry.register({
    name: AutomationImplementedAction.AutomationFiringsList,
    method: HttpMethod.Get,
    path: "/v1/automations/:id/firings",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<AutomationFiring>"],
    policy: queryPolicy,
    handler: handlers.listFirings,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, automationImplementedActions);
  return registry;
}
