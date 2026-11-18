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
  MemoryImplementedAction,
  memoryImplementedActions,
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
 * The six memory operations (#22).
 *
 * Read access is Developer and write is Admin, matching the catalog's own
 * declared permissions (`memory:read`, `memory:write`, `memoryRevision:*`). The
 * invariant worth stating: nothing here is reachable from a run's dispatch
 * path, and no operation accepts or returns a grant, a policy or a
 * configuration value. Memory is data a reader cites.
 */

export type MemoryActionHandlers = {
  listMemories: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<MemoryEntry>"]>>;
  getMemory: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.MemoryEntry>>;
  createMemory: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.MemoryCreate>,
  ) => Promise<z.output<typeof contractSchemas.MemoryEntry>>;
  updateMemory: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.MemoryUpdate>,
  ) => Promise<z.output<typeof contractSchemas.MemoryEntry>>;
  createRevision: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.MemoryRevisionCreate>,
  ) => Promise<z.output<typeof contractSchemas.MemoryRevision>>;
  listRevisions: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<MemoryRevision>"]>>;
};

export function createMemoryActionRegistry(
  database: PgDatabase,
  handlers: MemoryActionHandlers,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const queryPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    // No organizationIdParam: these paths carry no organization segment, so the
    // organization comes from the caller's authenticated context. That is the
    // catalog's `organizationContext: "none"`, not an omission.
  } as const;
  // Memory is a developer surface end to end: the catalog declares Developer on
  // every one of these actions, so writing memory is not more privileged than
  // reading it. Memory text is data, and the routes carry no grant of authority.
  const commandPolicy = {
    ...queryPolicy,
    type: ActionKind.Command,
    access: ActionAccess.Developer,
  } as const;

  registry.register({
    name: MemoryImplementedAction.MemoriesList,
    method: HttpMethod.Get,
    path: "/v1/memories",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<MemoryEntry>"],
    policy: queryPolicy,
    // A page and its cursor must be one snapshot, or an entry created between
    // them can appear twice or vanish.
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.listMemories,
  });
  registry.register({
    name: MemoryImplementedAction.MemoriesGet,
    method: HttpMethod.Get,
    path: "/v1/memories/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.MemoryEntry,
    policy: queryPolicy,
    handler: handlers.getMemory,
  });
  registry.register({
    name: MemoryImplementedAction.MemoriesCreate,
    method: HttpMethod.Post,
    path: "/v1/memories",
    input: contractSchemas.MemoryCreate,
    output: contractSchemas.MemoryEntry,
    policy: commandPolicy,
    explicitIdempotency: "key",
    handler: handlers.createMemory,
  });
  registry.register({
    name: MemoryImplementedAction.MemoriesUpdate,
    method: HttpMethod.Patch,
    path: "/v1/memories/:id",
    input: contractSchemas.MemoryUpdate,
    output: contractSchemas.MemoryEntry,
    policy: commandPolicy,
    handler: handlers.updateMemory,
  });
  registry.register({
    name: MemoryImplementedAction.MemoryRevisionsCreate,
    method: HttpMethod.Post,
    path: "/v1/memories/:id/revisions",
    input: contractSchemas.MemoryRevisionCreate,
    output: contractSchemas.MemoryRevision,
    policy: commandPolicy,
    explicitIdempotency: "key",
    handler: handlers.createRevision,
  });
  registry.register({
    name: MemoryImplementedAction.MemoryRevisionsList,
    method: HttpMethod.Get,
    path: "/v1/memories/:id/revisions",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<MemoryRevision>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.listRevisions,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, memoryImplementedActions);
  return registry;
}
