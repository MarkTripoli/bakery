import type { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  type CommandRunner,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  catalogIdentityImplementedActions,
  CatalogImplementedAction,
  catalogImplementedActions,
} from "@bakery/contracts/implemented-actions";

export type CatalogActionHandlers = {
  listSources: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<SkillSource>"]>>;
  getSource: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.SkillSource>>;
  createSource: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillSourceCreate>,
  ) => Promise<z.output<typeof contractSchemas.SkillSource>>;
  updateSource: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillSourceUpdate>,
  ) => Promise<z.output<typeof contractSchemas.SkillSource>>;
  listSkills: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<Skill>"]>>;
  getSkill: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.Skill>>;
  createSkill: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillCreate>,
  ) => Promise<z.output<typeof contractSchemas.Skill>>;
  importSkill: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillImport>,
  ) => Promise<z.output<typeof contractSchemas.Run>>;
  updateSkill: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.DefinitionUpdate>,
  ) => Promise<z.output<typeof contractSchemas.Skill>>;
  createSkillVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.LocalSkillVersion>,
  ) => Promise<z.output<typeof contractSchemas.SkillVersion>>;
};

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

export const skillImportAuthorizationAction: ActionDefinition<
  typeof contractSchemas.SkillImport,
  typeof contractSchemas.Run
> = {
  name: CatalogImplementedAction.SkillsImport,
  method: HttpMethod.Post,
  path: "/v1/skill-imports",
  input: contractSchemas.SkillImport,
  output: contractSchemas.Run,
  policy: commandPolicy,
  handler: () => {
    throw new Error("SKILL_IMPORT_AUTHORIZATION_ONLY");
  },
};

export function createCatalogActionRegistry(
  handlers: CatalogActionHandlers,
  options: {
    authorityRunner?: ActionAuthorityRunner;
    commandRunner?: CommandRunner;
    includeSkillVersionPublication?: boolean;
  } = {},
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );

  registry.register({
    name: CatalogImplementedAction.SkillSourcesList,
    method: HttpMethod.Get,
    path: "/v1/skill-sources",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<SkillSource>"],
    policy: queryPolicy,
    handler: handlers.listSources,
  });
  registry.register({
    name: CatalogImplementedAction.SkillSourcesGet,
    method: HttpMethod.Get,
    path: "/v1/skill-sources/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.SkillSource,
    policy: queryPolicy,
    handler: handlers.getSource,
  });
  registry.register({
    name: CatalogImplementedAction.SkillSourcesCreate,
    method: HttpMethod.Post,
    path: "/v1/skill-sources",
    input: contractSchemas.SkillSourceCreate,
    output: contractSchemas.SkillSource,
    policy: commandPolicy,
    handler: handlers.createSource,
  });
  registry.register({
    name: CatalogImplementedAction.SkillSourcesUpdate,
    method: HttpMethod.Patch,
    path: "/v1/skill-sources/:id",
    input: contractSchemas.SkillSourceUpdate,
    output: contractSchemas.SkillSource,
    policy: commandPolicy,
    handler: handlers.updateSource,
  });
  registry.register({
    ...skillImportAuthorizationAction,
    handler: handlers.importSkill,
  });
  registry.register({
    name: CatalogImplementedAction.SkillsList,
    method: HttpMethod.Get,
    path: "/v1/skills",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<Skill>"],
    policy: queryPolicy,
    handler: handlers.listSkills,
  });
  registry.register({
    name: CatalogImplementedAction.SkillsGet,
    method: HttpMethod.Get,
    path: "/v1/skills/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Skill,
    policy: queryPolicy,
    handler: handlers.getSkill,
  });
  registry.register({
    name: CatalogImplementedAction.SkillsCreate,
    method: HttpMethod.Post,
    path: "/v1/skills",
    input: contractSchemas.SkillCreate,
    output: contractSchemas.Skill,
    policy: commandPolicy,
    handler: handlers.createSkill,
  });
  registry.register({
    name: CatalogImplementedAction.SkillsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/skills/:id",
    input: contractSchemas.DefinitionUpdate,
    output: contractSchemas.Skill,
    policy: commandPolicy,
    handler: handlers.updateSkill,
  });
  if (options.includeSkillVersionPublication !== false) {
    registry.register({
      name: CatalogImplementedAction.SkillVersionsCreate,
      method: HttpMethod.Post,
      path: "/v1/skills/:id/versions",
      input: contractSchemas.LocalSkillVersion,
      output: contractSchemas.SkillVersion,
      policy: commandPolicy,
      handler: handlers.createSkillVersion,
    });
  }
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(
    registry,
    options.includeSkillVersionPublication === false
      ? catalogIdentityImplementedActions
      : catalogImplementedActions,
  );
  return registry;
}

export function createSkillVersionActionRegistry(
  handlers: Pick<CatalogActionHandlers, "createSkillVersion">,
  options: {
    authorityRunner?: ActionAuthorityRunner;
    commandRunner?: CommandRunner;
  } = {},
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );
  registry.register({
    name: CatalogImplementedAction.SkillVersionsCreate,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/versions",
    input: contractSchemas.LocalSkillVersion,
    output: contractSchemas.SkillVersion,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Admin,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: handlers.createSkillVersion,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, [
    CatalogImplementedAction.SkillVersionsCreate,
  ]);
  return registry;
}
