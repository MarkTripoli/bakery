import { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  ActionRegistry,
  type CommandRunner,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  TaskImplementedAction,
  taskImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";

export type TaskActionHandlers = {
  list: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.TaskCursorQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<Task>"]>
    | Promise<z.output<typeof contractSchemas["Page<Task>"]>>;
  get: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) =>
    | z.output<typeof contractSchemas.Task>
    | Promise<z.output<typeof contractSchemas.Task>>;
  create: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.TaskCreate>,
  ) =>
    | z.output<typeof contractSchemas.Task>
    | Promise<z.output<typeof contractSchemas.Task>>;
  update: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.TaskUpdate>,
  ) =>
    | z.output<typeof contractSchemas.Task>
    | Promise<z.output<typeof contractSchemas.Task>>;
  createDependency: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.TaskDependencyCreate>,
  ) =>
    | z.output<typeof contractSchemas.TaskDependency>
    | Promise<z.output<typeof contractSchemas.TaskDependency>>;
  deleteDependency: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.DependencyPath>,
  ) =>
    | z.output<typeof contractSchemas.NoContent>
    | Promise<z.output<typeof contractSchemas.NoContent>>;
  runsCreate: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RunCreate>,
  ) =>
    | z.output<typeof contractSchemas.Run>
    | Promise<z.output<typeof contractSchemas.Run>>;
  runsList: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<Run>"]>
    | Promise<z.output<typeof contractSchemas["Page<Run>"]>>;
  runsGet: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) =>
    | z.output<typeof contractSchemas.Run>
    | Promise<z.output<typeof contractSchemas.Run>>;
  runStepsList: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<RunStep>"]>
    | Promise<z.output<typeof contractSchemas["Page<RunStep>"]>>;
  workflowPresetsList: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.WorkflowPresetsListQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<WorkflowPreset>"]>
    | Promise<z.output<typeof contractSchemas["Page<WorkflowPreset>"]>>;
  sync: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SyncQuery>,
  ) =>
    | z.output<typeof contractSchemas.SyncSnapshot>
    | Promise<z.output<typeof contractSchemas.SyncSnapshot>>;
  usageList: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.UsageQuery>,
  ) =>
    | z.output<typeof contractSchemas.UsageSummary>
    | Promise<z.output<typeof contractSchemas.UsageSummary>>;
};
/** The task routes are deliberately registered individually; there is no generic execute route. */
export function createTaskActionRegistry(
  handlers: TaskActionHandlers,
  options: {
    authorityRunner?: ActionAuthorityRunner;
    commandRunner?: CommandRunner;
  } = {},
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );
  const policy = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  };
  const installationPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.InstallationAdministrator,
    organizationContext:
      OrganizationContextPolicy.InstallationAdministratorScope,
  } as const;
  const commandPolicy = {
    ...policy,
    type: ActionKind.Command,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  registry.register({
    name: TaskImplementedAction.TasksList,
    method: HttpMethod.Get,
    path: "/v1/tasks",
    input: contractSchemas.TaskCursorQuery,
    output: contractSchemas["Page<Task>"],
    policy,
    handler: handlers.list,
  });
  registry.register({
    name: TaskImplementedAction.TasksGet,
    method: HttpMethod.Get,
    path: "/v1/tasks/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Task,
    policy,
    handler: handlers.get,
  });
  registry.register({
    name: TaskImplementedAction.TasksCreate,
    method: HttpMethod.Post,
    path: "/v1/tasks",
    input: contractSchemas.TaskCreate,
    output: contractSchemas.Task,
    policy: commandPolicy,
    handler: handlers.create,
  });
  registry.register({
    name: TaskImplementedAction.TasksUpdate,
    method: HttpMethod.Patch,
    path: "/v1/tasks/:id",
    input: contractSchemas.TaskUpdate,
    output: contractSchemas.Task,
    policy: commandPolicy,
    handler: handlers.update,
  });
  registry.register({
    name: TaskImplementedAction.TaskDependenciesCreate,
    method: HttpMethod.Post,
    path: "/v1/tasks/:id/dependencies",
    input: contractSchemas.TaskDependencyCreate,
    output: contractSchemas.TaskDependency,
    policy: commandPolicy,
    handler: handlers.createDependency,
  });
  registry.register({
    name: TaskImplementedAction.TaskDependenciesDelete,
    method: HttpMethod.Delete,
    path: "/v1/tasks/:id/dependencies/:dependencyId",
    input: contractSchemas.DependencyPath,
    output: contractSchemas.NoContent,
    policy: commandPolicy,
    handler: handlers.deleteDependency,
    naturalIdempotency: true,
  });
  registry.register({
    name: TaskImplementedAction.RunsCreate,
    method: HttpMethod.Post,
    path: "/v1/tasks/:id/runs",
    input: contractSchemas.RunCreate,
    output: contractSchemas.Run,
    policy: commandPolicy,
    handler: handlers.runsCreate,
  });
  registry.register({
    name: TaskImplementedAction.RunsList,
    method: HttpMethod.Get,
    path: "/v1/tasks/:id/runs",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<Run>"],
    policy,
    handler: handlers.runsList,
  });
  registry.register({
    name: TaskImplementedAction.RunsGet,
    method: HttpMethod.Get,
    path: "/v1/runs/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Run,
    policy,
    handler: handlers.runsGet,
  });
  registry.register({
    name: TaskImplementedAction.RunStepsList,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/steps",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<RunStep>"],
    policy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.runStepsList,
  });
  registry.register({
    name: TaskImplementedAction.WorkflowPresetsList,
    method: HttpMethod.Get,
    path: "/v1/workflow-presets",
    input: contractSchemas.WorkflowPresetsListQuery,
    output: contractSchemas["Page<WorkflowPreset>"],
    policy,
    handler: handlers.workflowPresetsList,
  });
  registry.register({
    name: TaskImplementedAction.SyncSnapshot,
    method: HttpMethod.Get,
    path: "/v1/sync",
    input: contractSchemas.SyncQuery,
    output: contractSchemas.SyncSnapshot,
    policy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.sync,
  });
  registry.register({
    name: TaskImplementedAction.UsageList,
    method: HttpMethod.Get,
    path: "/v1/usage",
    input: contractSchemas.UsageQuery,
    output: contractSchemas.UsageSummary,
    policy: installationPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.usageList,
  });
  assertImplementedActionRegistry(registry, taskImplementedActions);
  return registry;
}
