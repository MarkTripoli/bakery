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
  ArtifactKindImplementedAction,
  artifactKindImplementedActions,
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

export type ArtifactKindsActionHandlers = {
  listKinds: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<ArtifactKind>"]>>;
  getKind: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ArtifactKindKeyPath>,
  ) => Promise<z.output<typeof contractSchemas.ArtifactKind>>;
  publishVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ArtifactKindVersionCreate>,
  ) => Promise<z.output<typeof contractSchemas.ArtifactKindVersion>>;
  listVersions: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<
    z.output<typeof contractSchemas["Page<ArtifactKindVersion>"]>
  >;
};

/**
 * The four kind actions, registered the way every organization-path operation
 * is: `organizationIdParam: "id"` makes the authority runner compare the path
 * organization with the caller's, so another tenant's kind is not found rather
 * than forbidden.
 *
 * Reads are Developer and writes are Admin. A kind is an extension point every
 * author and every run depends on, so publishing one is an administrative act;
 * reading one only tells you what a document must contain.
 */
export function createArtifactKindsActionRegistry(
  database: PgDatabase,
  handlers: ArtifactKindsActionHandlers,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const queryPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    organizationIdParam: "id",
  } as const;
  const commandPolicy = {
    ...queryPolicy,
    type: ActionKind.Command,
    access: ActionAccess.Admin,
  } as const;

  registry.register({
    name: ArtifactKindImplementedAction.ArtifactKindsList,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/artifact-kinds",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<ArtifactKind>"],
    policy: queryPolicy,
    handler: handlers.listKinds,
  });
  registry.register({
    name: ArtifactKindImplementedAction.ArtifactKindsGet,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/artifact-kinds/:key",
    input: contractSchemas.ArtifactKindKeyPath,
    output: contractSchemas.ArtifactKind,
    policy: queryPolicy,
    handler: handlers.getKind,
  });
  registry.register({
    name: ArtifactKindImplementedAction.ArtifactKindVersionsCreate,
    method: HttpMethod.Post,
    path: "/v1/organizations/:id/artifact-kinds/:key/versions",
    input: contractSchemas.ArtifactKindVersionCreate,
    output: contractSchemas.ArtifactKindVersion,
    policy: commandPolicy,
    explicitIdempotency: "key",
    handler: handlers.publishVersion,
  });
  registry.register({
    name: ArtifactKindImplementedAction.ArtifactKindVersionsList,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/artifact-kinds/:key/versions",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<ArtifactKindVersion>"],
    policy: queryPolicy,
    // A page and the cursor that follows it must be one snapshot, or a
    // publication landing between them can make a version appear twice or not
    // at all.
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.listVersions,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, artifactKindImplementedActions);
  return registry;
}
