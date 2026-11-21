import type { z } from "zod";
import {
  type ActionContext,
  ActionKind,
  type ActionPolicy,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  PluginInstallImplementedAction,
  pluginInstallImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  authorizeOrganizationAdministrator,
  isOrganizationMember,
} from "../auth/application/authorize.ts";
import type { OrganizationActor } from "../auth/application/authority.ts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";

/**
 * Installs and install-scoped state for private plugins (#15, B14.01, slice 2).
 *
 * Six operations: list/get/create/update an install, and get/put state. The
 * route policy is Developer, because a personal install is a member's own
 * choice; the handler raises the bar to Admin for an organization-scope install,
 * which affects everybody in the organization. A policy cannot express "Admin
 * only for some bodies", and pretending otherwise by registering two paths would
 * put the same action in the catalog twice.
 *
 * There is no route that grants capabilities. Grants are derived from the
 * version's manifest at install time, so a caller cannot ask for a capability
 * the manifest did not declare, and an update re-reads the manifest rather than
 * carrying grants forward.
 */

export type PluginInstallActionHandlers = {
  listInstalls: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.PluginInstallQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<PluginInstall>"]>>;
  getInstall: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.PluginInstall>>;
  createInstall: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.PluginInstallCreate>,
  ) => Promise<z.output<typeof contractSchemas.PluginInstall>>;
  updateInstall: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.PluginInstallUpdate>,
  ) => Promise<z.output<typeof contractSchemas.PluginInstall>>;
  getState: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<PluginState>"]>>;
  getStateItems: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<PluginStateItem>"]>>;
  putState: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.PluginStatePut>,
  ) => Promise<z.output<typeof contractSchemas.PluginState>>;
  listPages: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<PluginPageEntry>"]>>;
  getPage: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.PluginPagePath>,
  ) => Promise<z.output<typeof contractSchemas.PluginPageAccess>>;
};

/**
 * The document read's definition, shared by the registry (for the catalog and
 * the authority) and the raw route that serves it. Its registered handler is
 * never reached: the route mounted ahead of the JSON router answers the path
 * with the page's HTML, under this action's authority.
 */
export const pluginPageDocumentActionDefinition = {
  name: PluginInstallImplementedAction.PluginPageDocumentsGet,
  method: HttpMethod.Get,
  path: "/v1/plugin-installs/:id/pages/:pageId/document",
  input: contractSchemas.PluginPageDocumentQuery,
  output: contractSchemas.PluginPageDocument,
  policy: {
    type: ActionKind.Query,
    access: "Authorized owner/member",
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    // An iframe src cannot send the organization header.
    organizationIdQuery: "organizationId",
  },
  handler: () => {
    throw new StandardError({ code: "INTERNAL" });
  },
} as const;

export function createPluginInstallActionRegistry(
  database: PgDatabase,
  handlers: PluginInstallActionHandlers,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  /**
   * Access strings come from the catalog verbatim.
   *
   * The catalog states a conditional rule for four of these actions ("Developer
   * for personal; Admin for organization"), and the registry compares the two
   * literally, so a policy that said only "Developer" would be a mismatch and a
   * policy that said only "Admin" would block a member's own install. A policy
   * is a static description for the catalog, not an enforcement point: the
   * handler is where the condition is applied, reading the live role inside the
   * transaction. Declaring the rule the catalog documents keeps the two in step.
   */
  const policy = (
    access: ActionAccess,
    type: ActionKind,
    organizationContext: OrganizationContextPolicy,
  ): ActionPolicy => ({ access, type, organizationContext });
  const memberContext = OrganizationContextPolicy.RequiredAuthenticatedContext;
  /**
   * The actor the authority runner resolved for this request.
   *
   * The runner has already refused a caller with no live membership, so this is
   * a narrowing cast rather than a second authorization.
   */
  const actorOf = (context: ActionContext): OrganizationActor => {
    if (
      !("authority" in context) ||
      typeof context.authority !== "object" ||
      context.authority === null ||
      !("organizationId" in context.authority)
    ) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    return context.authority as OrganizationActor;
  };

  /**
   * What "Developer for personal; Admin for organization" means in code.
   *
   * The framework derives one permission floor per access string, so the floor
   * here is Developer and this guard carries the finer rule: an install that
   * affects everybody needs Admin, and one that affects only its owner needs
   * nothing beyond membership. The guard receives the parsed input, which is why
   * it can look at the requested scope at all; the handler repeats the check
   * because a handler can later be reached by another route, and one indexed
   * read is a cheap second lock on a door that matters.
   */
  const requireInstallAuthority = (
    context: ActionContext,
    input: unknown,
  ): void => {
    const actor = actorOf(context);
    if (!isOrganizationMember(actor)) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
    const scope = (input as { scope?: unknown } | undefined)?.scope;
    if (scope !== "organization") return;
    // An organization install changes what everybody can use, so the scope in
    // the input raises the requirement to Admin; the auth layer owns the role.
    authorizeOrganizationAdministrator(actor);
  };

  /**
   * An update's scope is not in the body: it is the scope of the row the path
   * names. A personal install may be changed only by its owner, a shared one only
   * by an Admin, so the row decides and the handler applies it.
   */
  const requireUpdateAuthority = (context: ActionContext): void => {
    const actor = actorOf(context);
    if (!isOrganizationMember(actor)) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
  };

  /** Any member may read an install or its state; the row decides whose it is. */
  const requireMember = (context: ActionContext): void => {
    const actor = actorOf(context);
    if (!isOrganizationMember(actor)) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
  };

  const queryPolicy = policy(
    ActionAccess.Developer,
    ActionKind.Query,
    memberContext,
  );

  registry.register({
    name: PluginInstallImplementedAction.PluginInstallsList,
    method: HttpMethod.Get,
    path: "/v1/plugin-installs",
    input: contractSchemas.PluginInstallQuery,
    output: contractSchemas["Page<PluginInstall>"],
    policy: queryPolicy,
    // A page and its cursor must be one snapshot, or an install created between
    // them appears twice or vanishes.
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.listInstalls,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginInstallsCreate,
    method: HttpMethod.Post,
    path: "/v1/plugin-installs",
    input: contractSchemas.PluginInstallCreate,
    output: contractSchemas.PluginInstall,
    policy: {
      ...policy(
        "Developer for personal; Admin for organization",
        ActionKind.Command,
        memberContext,
      ),
      authorize: requireInstallAuthority,
    },
    explicitIdempotency: "key",
    handler: handlers.createInstall,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginInstallsGet,
    method: HttpMethod.Get,
    path: "/v1/plugin-installs/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.PluginInstall,
    policy: {
      ...policy("Authorized owner/member", ActionKind.Query, memberContext),
      authorize: requireMember,
    },
    handler: handlers.getInstall,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginInstallsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/plugin-installs/:id",
    input: contractSchemas.PluginInstallUpdate,
    output: contractSchemas.PluginInstall,
    policy: {
      ...policy(
        "Owner for personal; Admin for organization",
        ActionKind.Command,
        memberContext,
      ),
      authorize: requireUpdateAuthority,
    },
    explicitIdempotency: "key",
    handler: handlers.updateInstall,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginStateGet,
    method: HttpMethod.Get,
    path: "/v1/plugin-installs/:id/state",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<PluginState>"],
    policy: {
      ...policy("Authorized owner/member", ActionKind.Query, memberContext),
      authorize: requireMember,
    },
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.getState,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginStateItemsList,
    method: HttpMethod.Get,
    path: "/v1/plugin-installs/:id/state-items",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<PluginStateItem>"],
    // Authorized exactly like the full read: the same member rule, the same
    // owner check inside, the same permission.
    policy: {
      ...policy("Authorized owner/member", ActionKind.Query, memberContext),
      authorize: requireMember,
    },
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.getStateItems,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginStatePut,
    method: HttpMethod.Put,
    // The namespace and key are route segments as well as input fields, and the
    // router refuses an input that disagrees with its path, so a caller cannot
    // write under one name while claiming another.
    path: "/v1/plugin-installs/:id/state/:namespace/:key",
    input: contractSchemas.PluginStatePut,
    output: contractSchemas.PluginState,
    policy: {
      ...policy(
        "Authorized owner/member+install grant",
        ActionKind.Command,
        memberContext,
      ),
      authorize: requireMember,
    },
    explicitIdempotency: "key",
    handler: handlers.putState,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginPagesList,
    method: HttpMethod.Get,
    path: "/v1/plugin-pages",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<PluginPageEntry>"],
    policy: {
      ...policy("Authorized owner/member", ActionKind.Query, memberContext),
      authorize: requireMember,
    },
    // One snapshot per page and cursor, as for the install list.
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.listPages,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginPagesGet,
    method: HttpMethod.Get,
    path: "/v1/plugin-installs/:id/pages/:pageId",
    input: contractSchemas.PluginPagePath,
    output: contractSchemas.PluginPageAccess,
    policy: {
      ...policy("Authorized owner/member", ActionKind.Query, memberContext),
      authorize: requireMember,
    },
    handler: handlers.getPage,
  });
  registry.register({
    ...pluginPageDocumentActionDefinition,
    policy: {
      ...pluginPageDocumentActionDefinition.policy,
      authorize: requireMember,
    },
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, pluginInstallImplementedActions);
  return registry;
}
