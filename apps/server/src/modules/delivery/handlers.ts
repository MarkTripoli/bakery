import type { DeliveryActionHandlers } from "./actions.ts";
import {
  createChecksListHandler,
  createReviewFindingsListHandler,
  createRunDeliveryDecisionsListHandler,
  createRunReviewsListHandler,
} from "./postgres.ts";

export function createDeliveryHandlers(secret: string): DeliveryActionHandlers {
  return {
    checksList: createChecksListHandler(secret),
    runReviewsList: createRunReviewsListHandler(secret),
    reviewFindingsList: createReviewFindingsListHandler(secret),
    runDeliveryDecisionsList: createRunDeliveryDecisionsListHandler(secret),
  };
}
