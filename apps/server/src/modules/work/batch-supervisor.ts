/**
 * The batch supervisor's decisions (#58).
 *
 * A supervisor, not an engine: it holds no plan or step state and runs no work. Each
 * tick it looks at a batch and what the world says about the issue being worked on,
 * and this one pure function says what to do next. Everything IO does (reading the
 * run's outcome, starting an issue through the existing admission, cancelling a run)
 * happens outside it, so each rule can be tested without a database.
 *
 * The limits are checked before a new issue starts, never in the middle of one: the
 * issue then running finishes, so a batch can pass its hours or its dollars by up to
 * one issue. Reaching a limit while one runs moves the batch to Finishing so the
 * page can say so.
 */

export type BatchState =
  | "running"
  | "waiting"
  | "paused"
  | "stopping"
  | "finishing"
  | "finished"
  | "stopped";

export type StepBatch = Readonly<{
  state: BatchState;
  continueMode: "carry_on" | "ask_first";
  maxIssues: number;
  maxHours: number;
  maxSpendMicroUsd: bigint;
  startedAt: Date;
  stopCancelledCurrent: boolean;
  nextApproved: boolean;
  /** Set when the batch started finishing, so it still says why when it ends. */
  finishReason: string | null;
  issues: readonly Readonly<{
    id: string;
    state: "started" | "merged" | "failed" | "cancelled" | "passed_over";
  }>[];
}>;

export type StepWorld = Readonly<{
  now: Date;
  /** Spend so far across the batch's issues, live usage included. */
  spentMicroUsd: bigint;
  /** Whether the starter may still start work here, read fresh this tick. */
  authorityOk: boolean;
  /** What became of the issue in the `started` state, when there is one. */
  current:
    | null
    | Readonly<{
      issueId: string;
      outcome: "running" | "merged" | "failed" | "cancelled";
    }>;
}>;

export type LimitReason =
  | "issues_reached"
  | "time_exhausted"
  | "spend_exhausted";

export type FinishReason =
  | LimitReason
  | "issue_failed"
  | "issue_cancelled"
  | "authority_lost"
  | "nothing_eligible"
  | "stopped_by_person";

export type Decision =
  | Readonly<{ kind: "none" }>
  /** The issue ended: record how, and its cost, before anything else. */
  | Readonly<{
    kind: "record_end";
    issueId: string;
    outcome: "merged" | "failed" | "cancelled";
  }>
  /** A limit was reached while an issue runs: nothing new starts, it finishes. */
  | Readonly<{ kind: "finishing"; reason: LimitReason }>
  | Readonly<{ kind: "finish"; reason: FinishReason }>
  | Readonly<{ kind: "stop" }>
  /** A Stopping batch asked to cancel: the run of the issue still going must be cancelled. */
  | Readonly<{ kind: "cancel_current"; issueId: string }>
  /** Ask me first: wait for a person's yes before the next issue. */
  | Readonly<{ kind: "wait" }>
  | Readonly<{ kind: "start_next" }>;

const MS_PER_HOUR = 3_600_000;

/** The limit the batch has reached, if any: the issues merged, the hours, the dollars. */
export function limitReached(
  batch: Pick<
    StepBatch,
    "maxIssues" | "maxHours" | "maxSpendMicroUsd" | "startedAt" | "issues"
  >,
  world: Pick<StepWorld, "now" | "spentMicroUsd">,
): LimitReason | null {
  const merged =
    batch.issues.filter((issue) => issue.state === "merged").length;
  if (merged >= batch.maxIssues) return "issues_reached";
  if (
    world.now.getTime() - batch.startedAt.getTime() >=
      batch.maxHours * MS_PER_HOUR
  ) return "time_exhausted";
  if (world.spentMicroUsd >= batch.maxSpendMicroUsd) return "spend_exhausted";
  return null;
}

export function decideBatchStep(batch: StepBatch, world: StepWorld): Decision {
  if (batch.state === "finished") return { kind: "none" };
  const current = world.current;

  // What happened to the issue comes first, in every state: its end is recorded
  // before any rule reads the issues, so the counts the rules use are true.
  if (current && current.outcome !== "running") {
    return {
      kind: "record_end",
      issueId: current.issueId,
      outcome: current.outcome,
    };
  }

  if (batch.state === "stopped") return { kind: "none" };

  if (current) {
    // A stop that asked to cancel: the run still going must be cancelled. The batch
    // stays Stopping until the issue has actually ended.
    if (batch.state === "stopping" && batch.stopCancelledCurrent) {
      // The cancel is made as the person who started the batch. If they can no longer act
      // here it can never be made, and asking again each tick would leave the batch
      // Stopping for good: end it and say why. The run is left for a person to cancel.
      if (!world.authorityOk) {
        return { kind: "finish", reason: "authority_lost" };
      }
      return { kind: "cancel_current", issueId: current.issueId };
    }
    // An issue is running. Nothing new starts after a limit; it finishes first.
    if (batch.state === "running" || batch.state === "waiting") {
      const reason = limitReached(batch, world);
      if (reason) return { kind: "finishing", reason };
    }
    return { kind: "none" };
  }

  // No issue is running.
  switch (batch.state) {
    case "stopping":
      return { kind: "stop" };
    case "finishing":
      return {
        kind: "finish",
        reason: (batch.finishReason as FinishReason | null) ??
          "nothing_eligible",
      };
    case "paused":
    case "waiting":
      return { kind: "none" };
  }

  // Running, with nothing running. A batch does not go on past a failure.
  if (batch.issues.some((issue) => issue.state === "failed")) {
    return { kind: "finish", reason: "issue_failed" };
  }
  if (batch.issues.some((issue) => issue.state === "cancelled")) {
    return { kind: "finish", reason: "issue_cancelled" };
  }
  if (!world.authorityOk) return { kind: "finish", reason: "authority_lost" };
  const reason = limitReached(batch, world);
  if (reason) return { kind: "finish", reason };
  const tookOne = batch.issues.some((issue) => issue.state === "merged");
  if (batch.continueMode === "ask_first" && tookOne && !batch.nextApproved) {
    return { kind: "wait" };
  }
  return { kind: "start_next" };
}
