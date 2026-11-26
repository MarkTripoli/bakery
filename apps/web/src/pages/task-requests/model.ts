import type { RunRequestResponse } from "../../api/client.ts";
import { stepName } from "../task-step-approval/model.ts";

export type RequestAction =
  | "approve"
  | "answer"
  | "review"
  | "take_over"
  | "fyi";

export function actionOf(request: RunRequestResponse): RequestAction | null {
  if (request.status !== "open") return null;
  if (request.intent === "approve" || request.intent === "answer") {
    return request.questionId === null ? "fyi" : request.intent;
  }
  if (request.intent === "review") {
    return request.artifactVersionId === null ? "fyi" : "review";
  }
  if (request.intent === "take_over") {
    return request.stepKey === null ? "fyi" : "take_over";
  }
  return "fyi";
}

export function orderedRequests(
  requests: readonly RunRequestResponse[],
): RunRequestResponse[] {
  const rank = (request: RunRequestResponse) => {
    const action = actionOf(request);
    return action === null ? 2 : action === "fyi" ? 1 : 0;
  };
  const when = (request: RunRequestResponse) =>
    request.status === "open"
      ? request.createdAt
      : request.status === "expired"
      ? request.expiresAt
      : request.updatedAt;
  return [...requests].sort((a, b) =>
    rank(a) - rank(b) || when(b).localeCompare(when(a))
  );
}

const CLOSED_SHOWN = 5;

export function visibleRequests(
  requests: readonly RunRequestResponse[],
): RunRequestResponse[] {
  const ordered = orderedRequests(requests);
  const open = ordered.filter((request) => request.status === "open");
  return [...open, ...ordered.slice(open.length, open.length + CLOSED_SHOWN)];
}

export function stepWords(request: RunRequestResponse): string | null {
  return request.stepKey === null ? null : stepName(request.stepKey);
}
