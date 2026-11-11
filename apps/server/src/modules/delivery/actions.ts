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
  DeliveryImplementedAction,
  deliveryImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";

type CursorQuery = z.output<typeof contractSchemas.CursorQuery>;

export type DeliveryActionHandlers = {
  checksList: (
    context: ActionContext,
    input: CursorQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<CheckRun>"]>>;
  runReviewsList: (
    context: ActionContext,
    input: CursorQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<ReviewCycle>"]>>;
  reviewFindingsList: (
    context: ActionContext,
    input: CursorQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<ReviewFinding>"]>>;
  runDeliveryDecisionsList: (
    context: ActionContext,
    input: CursorQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<DeliveryDecision>"]>>;
};

export function createDeliveryActionRegistry(
  database: PgDatabase,
  handlers: DeliveryActionHandlers,
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

  registry.register({
    name: DeliveryImplementedAction.ChecksList,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/checks",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<CheckRun>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.checksList,
  });

  registry.register({
    name: DeliveryImplementedAction.RunReviewsList,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/reviews",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<ReviewCycle>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.runReviewsList,
  });
  registry.register({
    name: DeliveryImplementedAction.ReviewFindingsList,
    method: HttpMethod.Get,
    path: "/v1/reviews/:id/findings",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<ReviewFinding>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.reviewFindingsList,
  });
  registry.register({
    name: DeliveryImplementedAction.RunDeliveryDecisionsList,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/delivery-decisions",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<DeliveryDecision>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.runDeliveryDecisionsList,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, deliveryImplementedActions);
  return registry;
}
