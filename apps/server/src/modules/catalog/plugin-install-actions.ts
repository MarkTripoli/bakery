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
  putState: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.PluginStatePut>,
  ) => Promise<z.output<typeof contractSchemas.PluginState>>;
};

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
    policy: policy(
      "Developer for personal; Admin for organization",
      ActionKind.Command,
      memberContext,
    ),
    explicitIdempotency: "key",
    handler: handlers.createInstall,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginInstallsGet,
    method: HttpMethod.Get,
    path: "/v1/plugin-installs/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.PluginInstall,
    policy: policy("Authorized owner/member", ActionKind.Query, memberContext),
    handler: handlers.getInstall,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginInstallsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/plugin-installs/:id",
    input: contractSchemas.PluginInstallUpdate,
    output: contractSchemas.PluginInstall,
    policy: policy(
      "Owner for personal; Admin for organization",
      ActionKind.Command,
      memberContext,
    ),
    explicitIdempotency: "key",
    handler: handlers.updateInstall,
  });
  registry.register({
    name: PluginInstallImplementedAction.PluginStateGet,
    method: HttpMethod.Get,
    path: "/v1/plugin-installs/:id/state",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<PluginState>"],
    policy: policy("Authorized owner/member", ActionKind.Query, memberContext),
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.getState,
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
    policy: policy(
      "Authorized owner/member+install grant",
      ActionKind.Command,
      memberContext,
    ),
    explicitIdempotency: "key",
    handler: handlers.putState,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, pluginInstallImplementedActions);
  return registry;
}
