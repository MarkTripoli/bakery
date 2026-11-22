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
    input: z.output<typeof contractSchemas.SkillQuery>,
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
  listSkillUseGrants: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<SkillUseGrant>"]>>;
  openSkillDraft: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.SkillDraft>>;
  getSkillDraft: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.SkillDraft>>;
  updateSkillDraft: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillDraftUpdate>,
  ) => Promise<z.output<typeof contractSchemas.SkillDraft>>;
  discardSkillDraft: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<null>;
  checkSkillDraft: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.SkillDraftCheck>>;
  checkSkillSourceUpdate: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.SkillSourceUpdateCheck>>;
  saveSkillDraftFile: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillDraftFileSave>,
  ) => Promise<z.output<typeof contractSchemas.SkillDraft>>;
  getSkillDraftFile: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillDraftFilePath>,
  ) => Promise<z.output<typeof contractSchemas.SkillDraftFile>>;
  deleteSkillDraftFile: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillDraftFilePath>,
  ) => Promise<z.output<typeof contractSchemas.SkillDraft>>;
  listSkillUsage: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<SkillUsage>"]>>;
  takeSkillSourceUpdate: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillSourceUpdateTake>,
  ) => Promise<z.output<typeof contractSchemas.Run>>;
  getSkillImport: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.SkillImportResult>>;
  renameSkillDraftFile: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillDraftFileRename>,
  ) => Promise<z.output<typeof contractSchemas.SkillDraft>>;
  listSkillVersions: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<SkillVersion>"]>>;
  setSkillActiveVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillActiveVersionSet>,
  ) => Promise<z.output<typeof contractSchemas.Skill>>;
  deleteSkillUseGrant: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<null>;
  copySkill: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.SkillCopy>,
  ) => Promise<z.output<typeof contractSchemas.Skill>>;
  publishSkillDraft: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.SkillVersion>>;
  createSkillVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.LocalSkillVersion>,
  ) => Promise<z.output<typeof contractSchemas.SkillVersion>>;
  searchLibrary: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.LibrarySearchQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<LibrarySearchHit>"]>>;
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
  // Developer for a personal import; the handler raises the bar to Admin for an
  // organization import, which one access value cannot express.
  policy: {
    ...commandPolicy,
    access: ActionAccess.DeveloperForPersonalAdminForOrganization,
  },
  handler: () => {
    throw new Error("SKILL_IMPORT_AUTHORIZATION_ONLY");
  },
};

/**
 * Copying a skill writes object bytes, so, like publishing a version, it runs
 * its handler only behind the staged publication runners in routes.ts.
 */
function skillCopyDefinition(
  handler: CatalogActionHandlers["copySkill"],
) {
  return {
    name: CatalogImplementedAction.SkillsCopy,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/copy",
    input: contractSchemas.SkillCopy,
    output: contractSchemas.Skill,
    // Developer for a personal copy; the handler raises the bar to Admin for an
    // organization copy, which one access value cannot express.
    policy: {
      ...commandPolicy,
      access: ActionAccess.DeveloperForPersonalAdminForOrganization,
    },
    handler,
  } as const;
}

/**
 * Publishing a draft writes object bytes like publishing a version, so it runs
 * its handler only behind the staged publication runners in routes.ts. The
 * caller says which draft version it saw (If-Match), so a draft someone else
 * changed since is not published.
 */
function skillDraftPublishDefinition(
  handler: CatalogActionHandlers["publishSkillDraft"],
) {
  return {
    name: CatalogImplementedAction.SkillDraftsPublish,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/draft/publish",
    input: contractSchemas.IdPath,
    output: contractSchemas.SkillVersion,
    explicitIdempotency: "key-and-if-match",
    policy: {
      ...commandPolicy,
      access: ActionAccess.OwnerForPersonalAdminForOrganization,
    },
    handler,
  } as const;
}

function skillSourceUpdateDefinition(
  handler: CatalogActionHandlers["checkSkillSourceUpdate"],
) {
  return {
    name: CatalogImplementedAction.SkillsSourceUpdate,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/source-update",
    input: contractSchemas.IdPath,
    output: contractSchemas.SkillSourceUpdateCheck,
    successStatus: 200,
    policy: {
      ...commandPolicy,
      access: ActionAccess.OwnerForPersonalAdminForOrganization,
    },
    handler,
  } as const;
}

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
    name: CatalogImplementedAction.SkillImportsGet,
    method: HttpMethod.Get,
    path: "/v1/skill-imports/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.SkillImportResult,
    policy: queryPolicy,
    handler: handlers.getSkillImport,
  });
  registry.register({
    name: CatalogImplementedAction.SkillsList,
    method: HttpMethod.Get,
    path: "/v1/skills",
    input: contractSchemas.SkillQuery,
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
    // Developer for a personal skill; the handler raises the bar to Admin for
    // an organization skill, which one access value cannot express.
    policy: {
      ...commandPolicy,
      access: ActionAccess.DeveloperForPersonalAdminForOrganization,
    },
    handler: handlers.createSkill,
  });
  registry.register({
    name: CatalogImplementedAction.SkillsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/skills/:id",
    input: contractSchemas.DefinitionUpdate,
    output: contractSchemas.Skill,
    // The owner for a personal skill, an Admin for an organization one; the
    // handler decides which from the skill itself.
    policy: {
      ...commandPolicy,
      access: ActionAccess.OwnerForPersonalAdminForOrganization,
    },
    handler: handlers.updateSkill,
  });
  registry.register({
    name: CatalogImplementedAction.SkillUseGrantsList,
    method: HttpMethod.Get,
    path: "/v1/skills/:id/use-grants",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<SkillUseGrant>"],
    policy: {
      ...queryPolicy,
      access: ActionAccess.OwnerForPersonalAdminForOrganization,
    },
    handler: handlers.listSkillUseGrants,
  });
  registry.register({
    name: CatalogImplementedAction.SkillsUsedBy,
    method: HttpMethod.Get,
    path: "/v1/skills/:id/used-by",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<SkillUsage>"],
    policy: queryPolicy,
    handler: handlers.listSkillUsage,
  });
  // Putting an older published version in use is authoring the skill: the
  // owner of a personal skill, an Admin for an organization one, never Bakery's.
  registry.register({
    name: CatalogImplementedAction.SkillsSetActiveVersion,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/active-version",
    input: contractSchemas.SkillActiveVersionSet,
    output: contractSchemas.Skill,
    successStatus: 200,
    explicitIdempotency: "key-and-if-match",
    policy: {
      ...commandPolicy,
      access: ActionAccess.OwnerForPersonalAdminForOrganization,
    },
    handler: handlers.setSkillActiveVersion,
  });
  // The skill's authoring draft. Its author is the owner of a personal skill or
  // an Admin for an organization one; the handlers decide which from the skill.
  const draftAccess = ActionAccess.OwnerForPersonalAdminForOrganization;
  registry.register({
    name: CatalogImplementedAction.SkillDraftsOpen,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/draft",
    input: contractSchemas.IdPath,
    output: contractSchemas.SkillDraft,
    successStatus: 200,
    policy: { ...commandPolicy, access: draftAccess },
    handler: handlers.openSkillDraft,
  });
  registry.register({
    name: CatalogImplementedAction.SkillDraftsGet,
    method: HttpMethod.Get,
    path: "/v1/skills/:id/draft",
    input: contractSchemas.IdPath,
    output: contractSchemas.SkillDraft,
    policy: { ...queryPolicy, access: draftAccess },
    handler: handlers.getSkillDraft,
  });
  registry.register({
    name: CatalogImplementedAction.SkillDraftsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/skills/:id/draft",
    input: contractSchemas.SkillDraftUpdate,
    output: contractSchemas.SkillDraft,
    policy: { ...commandPolicy, access: draftAccess },
    handler: handlers.updateSkillDraft,
  });
  registry.register({
    name: CatalogImplementedAction.SkillDraftsDiscard,
    method: HttpMethod.Delete,
    path: "/v1/skills/:id/draft",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    explicitIdempotency: "key-and-if-match",
    policy: { ...commandPolicy, access: draftAccess },
    handler: handlers.discardSkillDraft,
  });
  registry.register({
    name: CatalogImplementedAction.SkillDraftsCheck,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/draft/check",
    input: contractSchemas.IdPath,
    output: contractSchemas.SkillDraftCheck,
    successStatus: 200,
    policy: { ...commandPolicy, access: draftAccess },
    handler: handlers.checkSkillDraft,
  });
  registry.register({
    name: CatalogImplementedAction.SkillDraftFilesSave,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/draft/files",
    input: contractSchemas.SkillDraftFileSave,
    output: contractSchemas.SkillDraft,
    successStatus: 200,
    explicitIdempotency: "key-and-if-match",
    policy: { ...commandPolicy, access: draftAccess },
    handler: handlers.saveSkillDraftFile,
  });
  registry.register({
    name: CatalogImplementedAction.SkillDraftFilesRename,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/draft/files/rename",
    input: contractSchemas.SkillDraftFileRename,
    output: contractSchemas.SkillDraft,
    successStatus: 200,
    explicitIdempotency: "key-and-if-match",
    policy: { ...commandPolicy, access: draftAccess },
    handler: handlers.renameSkillDraftFile,
  });
  registry.register({
    name: CatalogImplementedAction.SkillDraftFilesGet,
    method: HttpMethod.Get,
    path: "/v1/skills/:id/draft/files/:fileId",
    input: contractSchemas.SkillDraftFilePath,
    output: contractSchemas.SkillDraftFile,
    policy: { ...queryPolicy, access: draftAccess },
    handler: handlers.getSkillDraftFile,
  });
  registry.register({
    name: CatalogImplementedAction.SkillDraftFilesDelete,
    method: HttpMethod.Delete,
    path: "/v1/skills/:id/draft/files/:fileId",
    input: contractSchemas.SkillDraftFilePath,
    output: contractSchemas.SkillDraft,
    explicitIdempotency: "key-and-if-match",
    policy: { ...commandPolicy, access: draftAccess },
    handler: handlers.deleteSkillDraftFile,
  });
  registry.register({
    name: CatalogImplementedAction.SkillUseGrantsDelete,
    method: HttpMethod.Delete,
    path: "/v1/skills/:id/use-grants/:grantId",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    policy: {
      ...commandPolicy,
      access: ActionAccess.OwnerForPersonalAdminForOrganization,
    },
    // A DELETE only reads If-Match when the action says it needs one.
    explicitIdempotency: "key-and-if-match",
    handler: handlers.deleteSkillUseGrant,
  });
  registry.register({
    name: CatalogImplementedAction.LibrarySearch,
    method: HttpMethod.Get,
    path: "/v1/library/search",
    input: contractSchemas.LibrarySearchQuery,
    output: contractSchemas["Page<LibrarySearchHit>"],
    policy: queryPolicy,
    handler: handlers.searchLibrary,
  });
  if (options.includeSkillVersionPublication !== false) {
    registry.register(skillCopyDefinition(handlers.copySkill));
    registry.register(skillDraftPublishDefinition(handlers.publishSkillDraft));
    registry.register(
      skillSourceUpdateDefinition(handlers.checkSkillSourceUpdate),
    );
    registry.register(
      skillSourceUpdateTakeDefinition(handlers.takeSkillSourceUpdate),
    );
    registry.register({
      name: CatalogImplementedAction.SkillVersionsCreate,
      method: HttpMethod.Post,
      path: "/v1/skills/:id/versions",
      input: contractSchemas.LocalSkillVersion,
      output: contractSchemas.SkillVersion,
      policy: {
        ...commandPolicy,
        access: ActionAccess.OwnerForPersonalAdminForOrganization,
      },
      handler: handlers.createSkillVersion,
    });
    registry.register({
      name: CatalogImplementedAction.SkillVersionsList,
      method: HttpMethod.Get,
      path: "/v1/skills/:id/versions",
      input: contractSchemas.CursorQuery,
      output: contractSchemas["Page<SkillVersion>"],
      policy: queryPolicy,
      handler: handlers.listSkillVersions,
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

export function createSkillCopyActionRegistry(
  handlers: Pick<CatalogActionHandlers, "copySkill">,
  options: {
    authorityRunner?: ActionAuthorityRunner;
    commandRunner?: CommandRunner;
  } = {},
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );
  registry.register(skillCopyDefinition(handlers.copySkill));
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, [
    CatalogImplementedAction.SkillsCopy,
  ]);
  return registry;
}

export function createSkillDraftPublishActionRegistry(
  handlers: Pick<CatalogActionHandlers, "publishSkillDraft">,
  options: {
    authorityRunner?: ActionAuthorityRunner;
    commandRunner?: CommandRunner;
  } = {},
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );
  registry.register(skillDraftPublishDefinition(handlers.publishSkillDraft));
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, [
    CatalogImplementedAction.SkillDraftsPublish,
  ]);
  return registry;
}

/**
 * skills.sourceUpdate looks at a source over the network, so it runs in stages
 * (see routes.ts) and has a registry of its own, like a skill copy: the shared
 * catalog registry does not carry it.
 */
/**
 * Taking a reviewed update reads the source over the network, like the check,
 * so it runs behind the same staged runners in routes.ts.
 */
function skillSourceUpdateTakeDefinition(
  handler: CatalogActionHandlers["takeSkillSourceUpdate"],
) {
  return {
    name: CatalogImplementedAction.SkillsTakeSourceUpdate,
    method: HttpMethod.Post,
    path: "/v1/skills/:id/source-update/take",
    input: contractSchemas.SkillSourceUpdateTake,
    output: contractSchemas.Run,
    explicitIdempotency: "key-and-if-match",
    policy: {
      ...commandPolicy,
      access: ActionAccess.OwnerForPersonalAdminForOrganization,
    },
    handler,
  } as const;
}

export function createSkillSourceUpdateActionRegistry(
  handlers: Pick<
    CatalogActionHandlers,
    "checkSkillSourceUpdate" | "takeSkillSourceUpdate"
  >,
  options: {
    authorityRunner?: ActionAuthorityRunner;
    commandRunner?: CommandRunner;
  } = {},
): ActionRegistry {
  const registry = new ActionRegistry(
    options.authorityRunner,
    options.commandRunner,
  );
  registry.register(
    skillSourceUpdateDefinition(handlers.checkSkillSourceUpdate),
  );
  registry.register(
    skillSourceUpdateTakeDefinition(handlers.takeSkillSourceUpdate),
  );
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, [
    CatalogImplementedAction.SkillsSourceUpdate,
    CatalogImplementedAction.SkillsTakeSourceUpdate,
  ]);
  return registry;
}

export function createSkillVersionActionRegistry(
  handlers: Pick<
    CatalogActionHandlers,
    "createSkillVersion" | "listSkillVersions"
  >,
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
      access: ActionAccess.OwnerForPersonalAdminForOrganization,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: handlers.createSkillVersion,
  });
  // The list shares its path with publication, so it is served by this same
  // router: two routers on one path answer each other's method with a 405.
  registry.register({
    name: CatalogImplementedAction.SkillVersionsList,
    method: HttpMethod.Get,
    path: "/v1/skills/:id/versions",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<SkillVersion>"],
    policy: queryPolicy,
    handler: handlers.listSkillVersions,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, [
    CatalogImplementedAction.SkillVersionsCreate,
    CatalogImplementedAction.SkillVersionsList,
  ]);
  return registry;
}
