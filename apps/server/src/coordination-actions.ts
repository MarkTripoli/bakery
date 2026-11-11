import type { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  type CommandRunner,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  CoordinationImplementedAction as Action,
  coordinationImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";

type Out<K extends keyof typeof contractSchemas> = z.output<
  typeof contractSchemas[K]
>;
type Handler<I, O> = (context: ActionContext, input: I) => O | Promise<O>;

export type CoordinationActionHandlers = {
  plansCreate: Handler<
    Out<"CoordinationPlanCreate">,
    Out<"CoordinationPlan">
  >;
  plansCreateFromWorkflow: Handler<
    Out<"CoordinationPlanCreateFromWorkflow">,
    Out<"CoordinationPlan">
  >;
  plansList: Handler<
    Out<"CoordinationPlanListQuery">,
    Out<"Page<CoordinationPlan>">
  >;
  plansGet: Handler<Out<"IdPath">, Out<"CoordinationPlan">>;
  plansMaterialize: Handler<Out<"IdPath">, Out<"CoordinationPlan">>;
  plansCancel: Handler<Out<"IdPath">, Out<"CoordinationPlan">>;
  taskRepositoriesList: Handler<
    Out<"CursorQuery">,
    Out<"Page<TaskRepository>">
  >;
  taskRepositoriesSet: Handler<
    Out<"TaskRepositorySet">,
    Out<"TaskRepository">
  >;
  rolesList: Handler<
    Out<"CursorQuery">,
    Out<"Page<ApplicationRepositoryRole>">
  >;
  rolesSet: Handler<
    Out<"ApplicationRepositoryRoleSet">,
    Out<"ApplicationRepositoryRole">
  >;
};

/** Coordination plan, task repository link and alias routes, registered one by one. */
export function createCoordinationActionRegistry(
  handlers: CoordinationActionHandlers,
  options: {
    authorityRunner: ActionAuthorityRunner;
    commandRunner: CommandRunner;
  },
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );
  const query = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  const command = { ...query, type: ActionKind.Command } as const;
  registry.register({
    name: Action.CoordinationPlansCreate,
    method: HttpMethod.Post,
    path: "/v1/coordination-plans",
    input: contractSchemas.CoordinationPlanCreate,
    output: contractSchemas.CoordinationPlan,
    policy: command,
    handler: handlers.plansCreate,
  });
  registry.register({
    name: Action.CoordinationPlansCreateFromWorkflow,
    method: HttpMethod.Post,
    path: "/v1/coordination-plans/from-workflow",
    input: contractSchemas.CoordinationPlanCreateFromWorkflow,
    output: contractSchemas.CoordinationPlan,
    policy: command,
    handler: handlers.plansCreateFromWorkflow,
  });
  registry.register({
    name: Action.CoordinationPlansList,
    method: HttpMethod.Get,
    path: "/v1/coordination-plans",
    input: contractSchemas.CoordinationPlanListQuery,
    output: contractSchemas["Page<CoordinationPlan>"],
    policy: query,
    handler: handlers.plansList,
  });
  registry.register({
    name: Action.CoordinationPlansGet,
    method: HttpMethod.Get,
    path: "/v1/coordination-plans/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.CoordinationPlan,
    policy: query,
    handler: handlers.plansGet,
  });
  registry.register({
    name: Action.CoordinationPlansMaterialize,
    method: HttpMethod.Post,
    path: "/v1/coordination-plans/:id/materialize",
    input: contractSchemas.IdPath,
    output: contractSchemas.CoordinationPlan,
    policy: command,
    handler: handlers.plansMaterialize,
  });
  registry.register({
    name: Action.CoordinationPlansCancel,
    method: HttpMethod.Post,
    path: "/v1/coordination-plans/:id/cancel",
    input: contractSchemas.IdPath,
    output: contractSchemas.CoordinationPlan,
    policy: command,
    handler: handlers.plansCancel,
  });
  registry.register({
    name: Action.TaskRepositoriesList,
    method: HttpMethod.Get,
    path: "/v1/tasks/:id/repositories",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<TaskRepository>"],
    policy: query,
    handler: handlers.taskRepositoriesList,
  });
  registry.register({
    name: Action.TaskRepositoriesSet,
    method: HttpMethod.Put,
    path: "/v1/tasks/:id/repositories",
    input: contractSchemas.TaskRepositorySet,
    output: contractSchemas.TaskRepository,
    policy: command,
    handler: handlers.taskRepositoriesSet,
  });
  registry.register({
    name: Action.ApplicationRepositoryRolesList,
    method: HttpMethod.Get,
    path: "/v1/applications/:id/repository-roles",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<ApplicationRepositoryRole>"],
    policy: query,
    handler: handlers.rolesList,
  });
  registry.register({
    name: Action.ApplicationRepositoryRolesSet,
    method: HttpMethod.Put,
    path: "/v1/applications/:id/repository-roles",
    input: contractSchemas.ApplicationRepositoryRoleSet,
    output: contractSchemas.ApplicationRepositoryRole,
    policy: { ...command, access: ActionAccess.Admin },
    handler: handlers.rolesSet,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, coordinationImplementedActions);
  return registry;
}
