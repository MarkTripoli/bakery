import type {
  AdmissionRecord,
  InvocationContract,
  LogicalInvocationKey,
  ResumeDecision,
} from "./invocation-contract.ts";
import { type AuthoritativeState, decideResume } from "./resume-decision.ts";

type Awaitable<T> = T | PromiseLike<T>;

export type WorkflowStore<T> = Readonly<{
  read(key: LogicalInvocationKey): Awaitable<AuthoritativeState<T> | undefined>;
  /** Atomically persists the logical action admission. */
  admit(key: LogicalInvocationKey): Awaitable<AdmissionRecord>;
}>;

export type FixedWorkflowOptions<T> = Readonly<{
  store: WorkflowStore<T>;
  wait: (admission: AdmissionRecord, checkpoint: number) => Awaitable<void>;
  checkpoint?: number;
  now?: () => Date;
}>;

export type FixedWorkflowOutcome<T> = Readonly<{
  decision: ResumeDecision<T>;
}>;

/**
 * Runs one fixed logical action. Bakery state is read before admission, before
 * every durable reconciliation wait, and after it; engine acknowledgements are
 * never state.
 */
export async function runFixedWorkflow<T>(
  invocation: InvocationContract,
  options: FixedWorkflowOptions<T>,
): Promise<FixedWorkflowOutcome<T>> {
  const now = options.now ?? (() => new Date());
  const before = await options.store.read(invocation.logical);
  let decision = decideResume(invocation.logical, before, now());

  if (
    decision.kind === "terminal-result" || decision.kind === "failed" ||
    decision.kind === "stalled" || decision.kind === "retryable" ||
    decision.kind === "state-conflict"
  ) {
    return { decision };
  }

  const admission = decision.kind === "newly-admit"
    ? await options.store.admit(decision.key)
    : decision.admission;
  if (admission.terminal) {
    const terminal = await options.store.read(invocation.logical);
    return { decision: decideResume(invocation.logical, terminal, now()) };
  }

  // Admission and completion can race; never register a wait until an
  // authoritative reread still shows the job as pending.
  const preWait = await options.store.read(invocation.logical);
  decision = decideResume(invocation.logical, preWait, now());
  if (
    decision.kind === "terminal-result" || decision.kind === "failed" ||
    decision.kind === "stalled" || decision.kind === "retryable" ||
    decision.kind === "state-conflict"
  ) {
    return { decision };
  }
  await options.wait(admission, options.checkpoint ?? 0);

  // A wakeup is only a hint. The database remains the sole completion
  // authority, including when the wait times out.
  const afterWait = await options.store.read(invocation.logical);
  decision = decideResume(invocation.logical, afterWait, now());
  if (
    decision.kind === "terminal-result" || decision.kind === "failed" ||
    decision.kind === "stalled" || decision.kind === "retryable" ||
    decision.kind === "state-conflict"
  ) {
    return { decision };
  }
  return {
    decision: {
      kind: "waiting",
      admission,
    },
  };
}
