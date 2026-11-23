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
type PullRequestQuery = z.output<typeof contractSchemas.PullRequestQuery>;
type DeploymentQuery = z.output<typeof contractSchemas.DeploymentQuery>;
type RepairAllowanceCreate = z.output<
  typeof contractSchemas.RepairAllowanceCreate
>;
type MergeEntryCreate = z.output<typeof contractSchemas.MergeEntryCreate>;
type PullRequestMerge = z.output<typeof contractSchemas.PullRequestMerge>;
type MergeAttemptQuery = z.output<typeof contractSchemas.MergeAttemptQuery>;
type MergeEntryQuery = z.output<typeof contractSchemas.MergeEntryQuery>;
type MergeAttemptReconcile = z.output<
  typeof contractSchemas.MergeAttemptReconcile
>;
type DeploymentCreate = z.output<typeof contractSchemas.DeploymentCreate>;
type DeploymentRollback = z.output<typeof contractSchemas.DeploymentRollback>;

type MetricsQuery = z.output<typeof contractSchemas.MetricsQuery>;
type MetricSourcesQuery = z.output<typeof contractSchemas.MetricSourcesQuery>;

export type DeliveryActionHandlers = {
  metricsGet: (
    context: ActionContext,
    input: MetricsQuery,
  ) => Promise<z.output<typeof contractSchemas.MetricSeries>>;
  metricsSources: (
    context: ActionContext,
    input: MetricSourcesQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<MetricSource>"]>>;
  checksList: (
    context: ActionContext,
    input: CursorQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<CheckRun>"]>>;
  runReviewsAccept: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ReviewAccept>,
  ) => Promise<z.output<typeof contractSchemas.ReviewCycle>>;
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
  runRepairTriesList: (
    context: ActionContext,
    input: CursorQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<RepairTry>"]>>;
  runRepairAllowancesCreate: (
    context: ActionContext,
    input: RepairAllowanceCreate,
  ) => Promise<z.output<typeof contractSchemas.DeliveryDecision>>;
  pullRequestsList: (
    context: ActionContext,
    input: PullRequestQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<PullRequest>"]>>;
  mergeEntriesList: (
    context: ActionContext,
    input: MergeEntryQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<MergeEntry>"]>>;
  mergeEntriesCreate: (
    context: ActionContext,
    input: MergeEntryCreate,
  ) => Promise<z.output<typeof contractSchemas.MergeEntry>>;
  pullRequestsMerge: (
    context: ActionContext,
    input: PullRequestMerge,
  ) => Promise<z.output<typeof contractSchemas.MergeAttempt>>;
  mergeAttemptsList: (
    context: ActionContext,
    input: MergeAttemptQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<MergeAttempt>"]>>;
  mergeAttemptsReconcile: (
    context: ActionContext,
    input: MergeAttemptReconcile,
  ) => Promise<z.output<typeof contractSchemas.MergeReconciliation>>;
  deploymentsList: (
    context: ActionContext,
    input: DeploymentQuery,
  ) => Promise<z.output<typeof contractSchemas["Page<Deployment>"]>>;
  deploymentsCreate: (
    context: ActionContext,
    input: DeploymentCreate,
  ) => Promise<z.output<typeof contractSchemas.Deployment>>;
  deploymentsRollback: (
    context: ActionContext,
    input: DeploymentRollback,
  ) => Promise<z.output<typeof contractSchemas.Deployment>>;
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
  const commandPolicy = {
    type: ActionKind.Command,
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
    name: DeliveryImplementedAction.RunReviewsAccept,
    method: HttpMethod.Post,
    path: "/v1/runs/:id/reviews/:reviewId/accept",
    input: contractSchemas.ReviewAccept,
    output: contractSchemas.ReviewCycle,
    policy: { ...commandPolicy, access: ActionAccess.Admin },
    handler: handlers.runReviewsAccept,
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
  registry.register({
    name: DeliveryImplementedAction.RunRepairTriesList,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/repair-tries",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<RepairTry>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.runRepairTriesList,
  });
  registry.register({
    name: DeliveryImplementedAction.RunRepairAllowancesCreate,
    method: HttpMethod.Post,
    path: "/v1/runs/:id/repair-allowances",
    input: contractSchemas.RepairAllowanceCreate,
    output: contractSchemas.DeliveryDecision,
    policy: { ...commandPolicy, access: ActionAccess.Admin },
    handler: handlers.runRepairAllowancesCreate,
  });

  registry.register({
    name: DeliveryImplementedAction.MetricsGet,
    method: HttpMethod.Get,
    path: "/v1/metrics",
    input: contractSchemas.MetricsQuery,
    output: contractSchemas.MetricSeries,
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.metricsGet,
  });

  registry.register({
    name: DeliveryImplementedAction.MetricsSources,
    method: HttpMethod.Get,
    path: "/v1/metrics/sources",
    input: contractSchemas.MetricSourcesQuery,
    output: contractSchemas["Page<MetricSource>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.metricsSources,
  });

  registry.register({
    name: DeliveryImplementedAction.PullRequestsList,
    method: HttpMethod.Get,
    path: "/v1/pull-requests",
    input: contractSchemas.PullRequestQuery,
    output: contractSchemas["Page<PullRequest>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.pullRequestsList,
  });

  registry.register({
    name: DeliveryImplementedAction.MergeEntriesList,
    method: HttpMethod.Get,
    path: "/v1/merge-entries",
    input: contractSchemas.MergeEntryQuery,
    output: contractSchemas["Page<MergeEntry>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.mergeEntriesList,
  });

  registry.register({
    name: DeliveryImplementedAction.MergeAttemptsList,
    method: HttpMethod.Get,
    path: "/v1/merge-attempts",
    input: contractSchemas.MergeAttemptQuery,
    output: contractSchemas["Page<MergeAttempt>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.mergeAttemptsList,
  });

  registry.register({
    name: DeliveryImplementedAction.MergeEntriesCreate,
    method: HttpMethod.Post,
    path: "/v1/merge-entries",
    input: contractSchemas.MergeEntryCreate,
    output: contractSchemas.MergeEntry,
    policy: commandPolicy,
    explicitIdempotency: "key",
    handler: handlers.mergeEntriesCreate,
  });

  registry.register({
    name: DeliveryImplementedAction.PullRequestsMerge,
    method: HttpMethod.Post,
    path: "/v1/pull-requests/:id/merge",
    input: contractSchemas.PullRequestMerge,
    output: contractSchemas.MergeAttempt,
    policy: commandPolicy,
    transactionIsolation: TransactionIsolation.ReadCommitted,
    handler: handlers.pullRequestsMerge,
  });

  registry.register({
    name: DeliveryImplementedAction.MergeAttemptsReconcile,
    method: HttpMethod.Post,
    path: "/v1/merge-attempts/reconcile",
    input: contractSchemas.MergeAttemptReconcile,
    output: contractSchemas.MergeReconciliation,
    policy: commandPolicy,
    transactionIsolation: TransactionIsolation.ReadCommitted,
    handler: handlers.mergeAttemptsReconcile,
  });

  registry.register({
    name: DeliveryImplementedAction.DeploymentsList,
    method: HttpMethod.Get,
    path: "/v1/deployments",
    input: contractSchemas.DeploymentQuery,
    output: contractSchemas["Page<Deployment>"],
    policy: queryPolicy,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: handlers.deploymentsList,
  });

  registry.register({
    name: DeliveryImplementedAction.DeploymentsCreate,
    method: HttpMethod.Post,
    path: "/v1/deployments",
    input: contractSchemas.DeploymentCreate,
    output: contractSchemas.Deployment,
    policy: { ...commandPolicy, access: ActionAccess.DeveloperAndDeployGrant },
    explicitIdempotency: "key",
    handler: handlers.deploymentsCreate,
  });

  registry.register({
    name: DeliveryImplementedAction.DeploymentsRollback,
    method: HttpMethod.Post,
    path: "/v1/deployments/:id/rollbacks",
    input: contractSchemas.DeploymentRollback,
    output: contractSchemas.Deployment,
    policy: { ...commandPolicy, access: ActionAccess.DeveloperAndDeployGrant },
    explicitIdempotency: "key",
    handler: handlers.deploymentsRollback,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, deliveryImplementedActions);
  return registry;
}
