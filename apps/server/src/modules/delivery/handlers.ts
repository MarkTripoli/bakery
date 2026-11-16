import type { DeliveryActionHandlers } from "./actions.ts";
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
  createRunReviewsListHandler,
} from "./postgres.ts";

export function createDeliveryHandlers(
  secret: string,
  merge: MergeDispatchDependencies,
): DeliveryActionHandlers {
  return {
    checksList: createChecksListHandler(secret),
    runReviewsList: createRunReviewsListHandler(secret),
    reviewFindingsList: createReviewFindingsListHandler(secret),
    runDeliveryDecisionsList: createRunDeliveryDecisionsListHandler(secret),
    pullRequestsList: createPullRequestsListHandler(secret),
    pullRequestsMerge: (context, input) =>
      mergePullRequest(merge, context, input),
    mergeAttemptsReconcile: (context, input) =>
      reconcileMergeAttempts(merge, context, input),
  };
}
