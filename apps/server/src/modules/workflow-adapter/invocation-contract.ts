export type LogicalInvocationKey = Readonly<{
  runId: string;
  stepKey: string;
  iteration: number;
  actionVersion: string;
}>;
export type InvocationContract = Readonly<{
  logical: LogicalInvocationKey;
}>;

export type ResumeDecision<T = unknown> =
  | { kind: "terminal-result"; result: T }
  | { kind: "already-admitted-action"; admission: AdmissionRecord }
  | { kind: "waiting"; admission: AdmissionRecord }
  | { kind: "newly-admit"; key: LogicalInvocationKey }
  | { kind: "retryable"; nextRetryAt: Date; attempts: number }
  | { kind: "stalled"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "state-conflict"; reason: string };

export type AdmissionRecord = Readonly<{
  key: LogicalInvocationKey;
  terminal: boolean;
  jobId?: string;
}>;

export function logicalKeyEquals(
  left: LogicalInvocationKey,
  right: LogicalInvocationKey,
): boolean {
  return left.runId === right.runId && left.stepKey === right.stepKey &&
    left.iteration === right.iteration &&
    left.actionVersion === right.actionVersion;
}

export function assertLogicalKey(key: LogicalInvocationKey): void {
  if (
    !key.runId || !key.stepKey || !key.actionVersion ||
    !Number.isSafeInteger(key.iteration) || key.iteration < 0
  ) {
    throw new Error("WORKFLOW_LOGICAL_KEY_INVALID");
  }
}
