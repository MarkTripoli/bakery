import type { DeliveryActionHandlers } from "./actions.ts";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { z } from "zod";
import { contractSchemas } from "@bakery/contracts/contracts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  createMergeEntry,
  listMergeEntries,
  type MergeEntryCreateInput,
} from "./merge-entries.ts";
import { listMergeAttempts } from "./merge-attempts.ts";
import {
  createDeployment,
  listDeployments,
  rollbackDeployment,
} from "./deployments.ts";
import {
  type MergeDispatchDependencies,
  mergePullRequest,
  reconcileMergeAttempts,
} from "./merge-dispatch.ts";
import {
  createChecksListHandler,
  createPullRequestsListHandler,
  createReviewFindingsListHandler,
  createRunDeliveryDecisionsListHandler,
  createRunRepairTriesListHandler,
  createRunReviewsListHandler,
} from "./postgres.ts";
import { acceptReview } from "./review-accept.ts";
import { createRepairAllowance } from "./repair-allowance-action.ts";
import { createMetricSourcesLister, getMetricSeries } from "./metrics.ts";

export function createDeliveryHandlers(
  secret: string,
  merge: MergeDispatchDependencies,
): DeliveryActionHandlers {
  const metricSources = createMetricSourcesLister(secret);
  return {
    checksList: createChecksListHandler(secret),
    runReviewsList: createRunReviewsListHandler(secret),
    runReviewsAccept: async (context, input) =>
      contractSchemas.ReviewCycle.parse(await acceptReview(context, input)),
    reviewFindingsList: createReviewFindingsListHandler(secret),
    runDeliveryDecisionsList: createRunDeliveryDecisionsListHandler(secret),
    runRepairTriesList: createRunRepairTriesListHandler(secret),
    runRepairAllowancesCreate: async (context, input) =>
      contractSchemas.TriesAllowance.parse(
        await createRepairAllowance(context, input),
      ),
    pullRequestsList: createPullRequestsListHandler(secret),
    metricsGet: async (context, input) =>
      contractSchemas.MetricSeries.parse(await getMetricSeries(context, input)),
    metricsSources: async (context, input) =>
      contractSchemas["Page<MetricSource>"].parse(
        await metricSources(context, input),
      ),
    mergeEntriesList: async (context, input) => {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      return contractSchemas["Page<MergeEntry>"].parse(
        await listMergeEntries(
          transaction,
          organizationId,
          principalId,
          secret,
          input,
        ),
      );
    },
    mergeAttemptsList: async (context, input) => {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      return contractSchemas["Page<MergeAttempt>"].parse(
        await listMergeAttempts(
          transaction,
          organizationId,
          principalId,
          secret,
          input,
        ),
      );
    },
    mergeEntriesCreate: async (
      context: ActionContext,
      input: z.output<typeof contractSchemas.MergeEntryCreate>,
    ) => {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      return contractSchemas.MergeEntry.parse(
        await createMergeEntry(transaction, organizationId, principalId, {
          requestId: context.requestId,
          traceId: context.traceId,
          create: input as MergeEntryCreateInput,
        }),
      );
    },
    pullRequestsMerge: (context, input) =>
      mergePullRequest(merge, context, input),
    mergeAttemptsReconcile: (context, input) =>
      reconcileMergeAttempts(merge, context, input),
    deploymentsList: async (context, input) => {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      return contractSchemas["Page<Deployment>"].parse(
        await listDeployments(
          transaction,
          organizationId,
          principalId,
          secret,
          input,
        ),
      );
    },
    deploymentsCreate: async (context, input) => {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      return contractSchemas.Deployment.parse(
        await createDeployment(transaction, organizationId, principalId, {
          requestId: context.requestId,
          traceId: context.traceId,
          create: input,
        }),
      );
    },
    deploymentsRollback: async (context, input) => {
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      return contractSchemas.Deployment.parse(
        await rollbackDeployment(
          transaction,
          organizationId,
          principalId,
          context.params.id,
          {
            requestId: context.requestId,
            traceId: context.traceId,
            reason: input.reason,
          },
        ),
      );
    },
  };
}
