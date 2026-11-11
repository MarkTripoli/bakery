import type { JobAttemptRead } from "../api/client.ts";

export type RunOutcomeState =
  | "running"
  | "completed"
  | "failed"
  | "canceling"
  | "canceled"
  | "exit"
  | "timeout"
  | "lost-lease"
  | "quota"
  | "unknown";

/** Execution evidence is separate from capture completeness and review status. */
export function runOutcomeState(
  attempt: JobAttemptRead | undefined,
): RunOutcomeState {
  if (!attempt) return "unknown";
  const outcome = attempt.outcome;
  if (outcome.reasonCode === "quota_exceeded") return "quota";
  if (
    outcome.reasonCode === "timeout" || outcome.resultStatus === "timed_out"
  ) {
    return "timeout";
  }
  if (
    outcome.reasonCode === "lease_lost" ||
    outcome.reasonCode === "lease_expired" || attempt.leaseState === "lost" ||
    attempt.leaseState === "expired"
  ) return "lost-lease";
  if (
    outcome.resultStatus === "canceled" || attempt.status === "canceled" ||
    attempt.status === "canceling"
  ) {
    return outcome.processExited === true &&
        outcome.terminationStatus === "confirmed" && outcome.exitedAt !== null
      ? "canceled"
      : "canceling";
  }
  if (outcome.processExited === true || outcome.exitCode !== null) {
    return "exit";
  }
  if (outcome.resultStatus === "completed") return "completed";
  if (outcome.resultStatus === "failed" || attempt.status === "failed") {
    return "failed";
  }
  if (attempt.status === "running" || attempt.status === "leased") {
    return "running";
  }
  return "unknown";
}
