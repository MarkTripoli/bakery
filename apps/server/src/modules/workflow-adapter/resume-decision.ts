import {
  type AdmissionRecord,
  assertLogicalKey,
  type LogicalInvocationKey,
  logicalKeyEquals,
  type ResumeDecision,
} from "./invocation-contract.ts";

export type AuthoritativeState<T = unknown> = Readonly<{
  key: LogicalInvocationKey;
  result?: T;
  admission?: AdmissionRecord;
  nextRetryAt?: Date;
  /** Terminal attempts consume the persisted retry budget. */
  attempts: number;
  /** Live leases are observable but do not consume retry budget. */
  liveAttempts: number;
  maxAttempts: number;
  terminalFailure?: string;
}>;

export function decideResume<T>(
  expected: LogicalInvocationKey,
  state: AuthoritativeState<T> | undefined,
  now = new Date(),
): ResumeDecision<T> {
  assertLogicalKey(expected);
  if (!state) return { kind: "newly-admit", key: expected };
  if (!logicalKeyEquals(expected, state.key)) {
    return { kind: "state-conflict", reason: "logical_identity_mismatch" };
  }
  if (state.result !== undefined) {
    return { kind: "terminal-result", result: state.result };
  }
  if (state.terminalFailure) {
    return { kind: "failed", reason: state.terminalFailure };
  }
  if (state.admission) {
    if (!logicalKeyEquals(expected, state.admission.key)) {
      return { kind: "state-conflict", reason: "admission_identity_mismatch" };
    }
    if (state.nextRetryAt && state.nextRetryAt > now) {
      return {
        kind: "retryable",
        nextRetryAt: state.nextRetryAt,
        attempts: state.attempts,
      };
    }
    if (state.attempts >= state.maxAttempts) {
      return { kind: "stalled", reason: "attempt_budget_exhausted" };
    }
    return { kind: "already-admitted-action", admission: state.admission };
  }
  return { kind: "newly-admit", key: expected };
}
