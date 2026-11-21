/**
 * What a refused batch request means to the person (#58, UX revision 2).
 *
 * The server answers with a status, a code and, for a conflict, a rule slug
 * that is never free text. These functions turn that into the one problem the
 * page shows and where it goes; they hold no sentences.
 */
import type { ApiFailure } from "../../api/client.ts";

function problemOf(error: unknown) {
  const failure = error as Partial<ApiFailure> | null;
  return failure !== null && typeof failure === "object" &&
      failure.kind === "problem"
    ? failure.problem ?? null
    : null;
}

/** Starting a batch: which of the design's problems this is, or `failed` for anything else. */
export type CreateRefusal =
  | "alreadyRunning"
  | "notTaking"
  | "notFound"
  | "spendLow"
  | "notAllowed"
  | "failed";

export function createRefusal(error: unknown): CreateRefusal {
  const problem = problemOf(error);
  if (problem === null) return "failed";
  // A conflict names its rule in `reason`; a 422 names the field's problem in `issueCodes`.
  switch (problem.reason) {
    case "batch_already_running":
      return "alreadyRunning";
    case "repository_not_taking_issues":
      return "notTaking";
  }
  if (problem.issueCodes?.includes("repository_not_found")) return "notFound";
  if (problem.issueCodes?.includes("max_spend_below_smallest")) {
    return "spendLow";
  }
  return problem.status === 403 || problem.code === "AUTH_FORBIDDEN"
    ? "notAllowed"
    : "failed";
}

/** Pausing, resuming, stopping and the rest: a changed batch reads again, anything else is a plain failure. */
export type ControlRefusal = "conflict" | "notAllowed" | "gone" | "failed";

export function controlRefusal(error: unknown): ControlRefusal {
  const problem = problemOf(error);
  if (problem === null) return "failed";
  if (problem.code === "STATE_CONFLICT" || problem.status === 409) {
    return "conflict";
  }
  if (problem.status === 403 || problem.code === "AUTH_FORBIDDEN") {
    return "notAllowed";
  }
  if (problem.status === 404) return "gone";
  return "failed";
}

/** The catalogue key of the sentence for a start problem. */
export const CREATE_REFUSAL_KEY: Record<CreateRefusal, string> = {
  alreadyRunning: "batches.start.error.alreadyRunning",
  notTaking: "batches.start.error.notTaking",
  notFound: "batches.start.error.notFound",
  spendLow: "batches.start.error.maxSpendLowNoAmount",
  notAllowed: "batches.start.error.forbidden",
  failed: "batches.start.error.failed",
};

/** Where a start problem is shown: under the Repository or the Spend field, or in a notice above the buttons. */
export function createRefusalPlace(
  refusal: CreateRefusal,
): "repository" | "spend" | "notice" {
  if (refusal === "spendLow") return "spend";
  return refusal === "notTaking" || refusal === "notFound"
    ? "repository"
    : "notice";
}
