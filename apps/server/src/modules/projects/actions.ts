import type { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  type CommandRunner,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  ProjectsImplementedAction,
  projectsImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";

export type ProjectsActionHandlers = {
  listApplications: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<Application>"]>
    | Promise<z.output<typeof contractSchemas["Page<Application>"]>>;
  getApplication: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) =>
    | z.output<typeof contractSchemas.Application>
    | Promise<z.output<typeof contractSchemas.Application>>;
  createApplication: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ApplicationCreate>,
  ) =>
    | z.output<typeof contractSchemas.Application>
    | Promise<z.output<typeof contractSchemas.Application>>;
  updateApplication: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ApplicationUpdate>,
  ) =>
    | z.output<typeof contractSchemas.Application>
    | Promise<z.output<typeof contractSchemas.Application>>;
  listRepositories: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<Repository>"]>
    | Promise<z.output<typeof contractSchemas["Page<Repository>"]>>;
  getRepository: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) =>
    | z.output<typeof contractSchemas.Repository>
    | Promise<z.output<typeof contractSchemas.Repository>>;
  createRepository: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RepositoryCreate>,
  ) =>
    | z.output<typeof contractSchemas.Repository>
    | Promise<z.output<typeof contractSchemas.Repository>>;
  updateRepository: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RepositoryUpdate>,
  ) =>
    | z.output<typeof contractSchemas.Repository>
    | Promise<z.output<typeof contractSchemas.Repository>>;
  listRoles: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RepositoryRoleList>,
  ) =>
    | z.output<typeof contractSchemas["Page<RoleBinding>"]>
    | Promise<z.output<typeof contractSchemas["Page<RoleBinding>"]>>;
  createRole: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RoleBindingCreate>,
  ) =>
    | z.output<typeof contractSchemas.RoleBinding>
    | Promise<z.output<typeof contractSchemas.RoleBinding>>;
  updateRole: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RoleBindingUpdate>,
  ) =>
    | z.output<typeof contractSchemas.RoleBinding>
    | Promise<z.output<typeof contractSchemas.RoleBinding>>;
  resolveRole: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RepositoryBindingSelector>,
  ) =>
    | z.output<typeof contractSchemas.RepositoryBindingResolution>
    | Promise<z.output<typeof contractSchemas.RepositoryBindingResolution>>;
  listProfiles: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) =>
    | z.output<typeof contractSchemas["Page<RepositoryProfile>"]>
    | Promise<z.output<typeof contractSchemas["Page<RepositoryProfile>"]>>;
  getEffectiveRules: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.RepositoryEffectiveRules>>;
  previewRepositoryRules: (
    context: ActionContext,
    input: z.output<
      typeof contractSchemas.RepositoryRulePreviewRepositoryCreate
    >,
  ) => Promise<
    z.output<typeof contractSchemas.RepositoryRulePreviewRepository>
  >;
  createProfile: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RepositoryProfileCreate>,
  ) =>
    | z.output<typeof contractSchemas.RepositoryProfile>
    | Promise<z.output<typeof contractSchemas.RepositoryProfile>>;
  onboardRepository: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RepositoryOnboardingStart>,
  ) => Promise<z.output<typeof contractSchemas.RepositoryOnboarding>>;
  getRepositoryOnboarding: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.RepositoryOnboarding>>;
  getRepositoryObservation: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.RepositoryProfileObservation>>;
};

/** The projects routes are registered individually; there is no generic execute route. */
export function createProjectsActionRegistry(
  handlers: ProjectsActionHandlers,
  options: {
    authorityRunner?: ActionAuthorityRunner;
    commandRunner?: CommandRunner;
  } = {},
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );
  const queryPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  };
  const commandPolicy = {
    ...queryPolicy,
    type: ActionKind.Command,
    access: ActionAccess.Admin,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  registry.register({
    name: ProjectsImplementedAction.ApplicationsList,
    method: HttpMethod.Get,
    path: "/v1/applications",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<Application>"],
    policy: queryPolicy,
    handler: handlers.listApplications,
  });
  registry.register({
    name: ProjectsImplementedAction.ApplicationsGet,
    method: HttpMethod.Get,
    path: "/v1/applications/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Application,
    policy: queryPolicy,
    handler: handlers.getApplication,
  });
  registry.register({
    name: ProjectsImplementedAction.ApplicationsCreate,
    method: HttpMethod.Post,
    path: "/v1/applications",
    input: contractSchemas.ApplicationCreate,
    output: contractSchemas.Application,
    policy: commandPolicy,
    handler: handlers.createApplication,
  });
  registry.register({
    name: ProjectsImplementedAction.ApplicationsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/applications/:id",
    input: contractSchemas.ApplicationUpdate,
    output: contractSchemas.Application,
    policy: commandPolicy,
    handler: handlers.updateApplication,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoriesList,
    method: HttpMethod.Get,
    path: "/v1/repositories",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<Repository>"],
    policy: queryPolicy,
    handler: handlers.listRepositories,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoriesGet,
    method: HttpMethod.Get,
    path: "/v1/repositories/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Repository,
    policy: queryPolicy,
    handler: handlers.getRepository,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoriesCreate,
    method: HttpMethod.Post,
    path: "/v1/repositories",
    input: contractSchemas.RepositoryCreate,
    output: contractSchemas.Repository,
    policy: commandPolicy,
    handler: handlers.createRepository,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoriesUpdate,
    method: HttpMethod.Patch,
    path: "/v1/repositories/:id",
    input: contractSchemas.RepositoryUpdate,
    output: contractSchemas.Repository,
    policy: commandPolicy,
    handler: handlers.updateRepository,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoryProfilesList,
    method: HttpMethod.Get,
    path: "/v1/repositories/:id/profiles",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<RepositoryProfile>"],
    policy: queryPolicy,
    handler: handlers.listProfiles,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoryProfilesCreate,
    method: HttpMethod.Post,
    path: "/v1/repositories/:id/profiles",
    input: contractSchemas.RepositoryProfileCreate,
    output: contractSchemas.RepositoryProfile,
    policy: commandPolicy,
    handler: handlers.createProfile,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoryRulesGetEffective,
    method: HttpMethod.Get,
    path: "/v1/repositories/:id/rules",
    input: contractSchemas.IdPath,
    output: contractSchemas.RepositoryEffectiveRules,
    policy: queryPolicy,
    handler: handlers.getEffectiveRules,
  });
  // A query carried by POST: no command runner, no replay row, no writes.
  registry.register({
    name: ProjectsImplementedAction.RepositoryRulePreviewsCreateForRepository,
    method: HttpMethod.Post,
    path: "/v1/repositories/:id/rule-previews",
    input: contractSchemas.RepositoryRulePreviewRepositoryCreate,
    output: contractSchemas.RepositoryRulePreviewRepository,
    policy: { ...queryPolicy, access: ActionAccess.Admin },
    transactionIsolation: TransactionIsolation.RepeatableRead,
    successStatus: 200,
    handler: handlers.previewRepositoryRules,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoriesOnboard,
    method: HttpMethod.Post,
    path: "/v1/repositories/:id/onboarding-runs",
    input: contractSchemas.RepositoryOnboardingStart,
    output: contractSchemas.RepositoryOnboarding,
    policy: commandPolicy,
    handler: handlers.onboardRepository,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoryOnboardingsGet,
    method: HttpMethod.Get,
    path: "/v1/repository-onboardings/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.RepositoryOnboarding,
    policy: queryPolicy,
    handler: handlers.getRepositoryOnboarding,
  });
  registry.register({
    name: ProjectsImplementedAction.RepositoryObservationsGet,
    method: HttpMethod.Get,
    path: "/v1/repository-profile-observations/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.RepositoryProfileObservation,
    policy: queryPolicy,
    handler: handlers.getRepositoryObservation,
  });
  registry.register({
    name: ProjectsImplementedAction.RolesList,
    method: HttpMethod.Get,
    path: "/v1/applications/:applicationId/roles",
    input: contractSchemas.RepositoryRoleList,
    output: contractSchemas["Page<RoleBinding>"],
    policy: queryPolicy,
    handler: handlers.listRoles,
  });
  registry.register({
    name: ProjectsImplementedAction.RolesCreate,
    method: HttpMethod.Post,
    path: "/v1/applications/:applicationId/roles",
    input: contractSchemas.RoleBindingCreate,
    output: contractSchemas.RoleBinding,
    policy: commandPolicy,
    handler: handlers.createRole,
  });
  registry.register({
    name: ProjectsImplementedAction.RolesUpdate,
    method: HttpMethod.Patch,
    path: "/v1/applications/:applicationId/roles/:roleId",
    input: contractSchemas.RoleBindingUpdate,
    output: contractSchemas.RoleBinding,
    policy: commandPolicy,
    handler: handlers.updateRole,
  });
  registry.register({
    name: ProjectsImplementedAction.RolesResolve,
    method: HttpMethod.Post,
    path: "/v1/applications/:applicationId/roles/resolve",
    input: contractSchemas.RepositoryBindingSelector,
    output: contractSchemas.RepositoryBindingResolution,
    policy: queryPolicy,
    handler: handlers.resolveRole,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, projectsImplementedActions);
  return registry;
}
