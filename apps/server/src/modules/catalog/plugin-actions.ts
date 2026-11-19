import type { z } from "zod";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  PluginPackageImplementedAction,
  pluginPackageImplementedActions,
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
 * Package and version publication for private plugins (#15, B14.01, slice 1).
 *
 * Five operations: list/get/create a package, list/create a version. There is
 * deliberately no version update. A published version is immutable, and the
 * absence of a write path is a stronger guarantee than a check inside one.
 *
 * The catalog declares these as `required_authenticated_context`, so the
 * organization comes from the caller's session and never from the URL. A
 * package id therefore numbers only among rows the caller's organization
 * published.
 */

export type PluginPackageActionHandlers = {
  listPackages: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.PluginPackageQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<PluginPackage>"]>>;
  getPackage: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.PluginPackage>>;
  createPackage: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.PluginPackageCreate>,
  ) => Promise<z.output<typeof contractSchemas.PluginPackage>>;
  listVersions: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<PluginVersion>"]>>;
  createVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.PluginVersionCreate>,
  ) => Promise<z.output<typeof contractSchemas.PluginVersion>>;
};

export function createPluginPackageActionRegistry(
  database: PgDatabase,
  handlers: PluginPackageActionHandlers,
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
  // Publishing is Developer, not Admin: the catalog declares a private,
  // unlisted package that grants nothing, so creating one confers no authority.
  // Installing it organization-wide is where Admin is required, and that is
  // slice 2.
  const commandPolicy = {
    ...queryPolicy,
    type: ActionKind.Command,
  } as const;

  registry.register({
    name: PluginPackageImplementedAction.PluginPackagesList,
    method: HttpMethod.Get,
    path: "/v1/plugin-packages",
    input: contractSchemas.PluginPackageQuery,
    output: contractSchemas["Page<PluginPackage>"],
    policy: queryPolicy,
    // A page and its cursor must be one snapshot, or a package created between
    // them appears twice or vanishes.
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.listPackages,
  });
  registry.register({
    name: PluginPackageImplementedAction.PluginPackagesCreate,
    method: HttpMethod.Post,
    path: "/v1/plugin-packages",
    input: contractSchemas.PluginPackageCreate,
    output: contractSchemas.PluginPackage,
    policy: commandPolicy,
    explicitIdempotency: "key",
    handler: handlers.createPackage,
  });
  registry.register({
    name: PluginPackageImplementedAction.PluginPackagesGet,
    method: HttpMethod.Get,
    path: "/v1/plugin-packages/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.PluginPackage,
    policy: queryPolicy,
    handler: handlers.getPackage,
  });
  registry.register({
    name: PluginPackageImplementedAction.PluginVersionsList,
    method: HttpMethod.Get,
    path: "/v1/plugin-packages/:id/versions",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<PluginVersion>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.listVersions,
  });
  registry.register({
    name: PluginPackageImplementedAction.PluginVersionsCreate,
    method: HttpMethod.Post,
    path: "/v1/plugin-packages/:id/versions",
    input: contractSchemas.PluginVersionCreate,
    output: contractSchemas.PluginVersion,
    policy: commandPolicy,
    explicitIdempotency: "key",
    handler: handlers.createVersion,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, pluginPackageImplementedActions);
  return registry;
}
