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
  RepositoryRulesImplementedAction,
  repositoryRulesImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";

export type RepositoryRulesActionHandlers = {
  getRules: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<
    z.output<typeof contractSchemas.OrganizationRepositoryRulesRead>
  >;
  publishVersion: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.RepositoryRuleVersionCreate>,
  ) => Promise<
    z.output<typeof contractSchemas.OrganizationRepositoryRuleVersion>
  >;
  listVersions: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.CursorQuery>,
  ) => Promise<
    z.output<typeof contractSchemas["Page<OrganizationRepositoryRuleVersion>"]>
  >;
  previewOrganization: (
    context: ActionContext,
    input: z.output<
      typeof contractSchemas.RepositoryRulePreviewOrganizationCreate
    >,
  ) => Promise<
    z.output<typeof contractSchemas.RepositoryRulePreviewOrganization>
  >;
};

export function createRepositoryRulesActionRegistry(
  database: PgDatabase,
  handlers: RepositoryRulesActionHandlers,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const queryPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.Admin,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
    organizationIdParam: "id",
  } as const;
  const commandPolicy = { ...queryPolicy, type: ActionKind.Command } as const;

  registry.register({
    name: RepositoryRulesImplementedAction.RepositoryRulesGet,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/repository-rules",
    input: contractSchemas.IdPath,
    output: contractSchemas.OrganizationRepositoryRulesRead,
    policy: queryPolicy,
    handler: handlers.getRules,
  });
  registry.register({
    name: RepositoryRulesImplementedAction.RepositoryRuleVersionsCreate,
    method: HttpMethod.Post,
    path: "/v1/organizations/:id/repository-rule-versions",
    input: contractSchemas.RepositoryRuleVersionCreate,
    output: contractSchemas.OrganizationRepositoryRuleVersion,
    policy: commandPolicy,
    explicitIdempotency: "key",
    handler: handlers.publishVersion,
  });
  registry.register({
    name: RepositoryRulesImplementedAction.RepositoryRuleVersionsList,
    method: HttpMethod.Get,
    path: "/v1/organizations/:id/repository-rule-versions",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<OrganizationRepositoryRuleVersion>"],
    policy: queryPolicy,
    handler: handlers.listVersions,
  });

  // A preview is a query that happens to carry a body: a POST registered as
  // ActionKind.Query, so the command runner (idempotency replay, command
  // metadata, Idempotency-Key) never runs and nothing is written. Repeatable
  // read gives the counting batches one snapshot.
  registry.register({
    name: RepositoryRulesImplementedAction
      .RepositoryRulePreviewsCreateForOrganization,
    method: HttpMethod.Post,
    path: "/v1/organizations/:id/repository-rule-previews",
    input: contractSchemas.RepositoryRulePreviewOrganizationCreate,
    output: contractSchemas.RepositoryRulePreviewOrganization,
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    successStatus: 200,
    handler: handlers.previewOrganization,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, repositoryRulesImplementedActions);
  return registry;
}
