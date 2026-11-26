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
  const open = (request: RunRequestResponse) =>
    request.status === "open" ? 0 : 1;
  return [...requests].sort((a, b) =>
    open(a) - open(b) || b.createdAt.localeCompare(a.createdAt)
  );
}

export function stepWords(request: RunRequestResponse): string | null {
  return request.stepKey === null ? null : stepName(request.stepKey);
}
