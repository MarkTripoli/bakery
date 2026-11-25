import type { MessageKey } from "@bakery/i18n";
import type { WorkerAttemptResponse } from "../api/client.ts";

export const WORK_STATES = ["now", "needs_attention", "finished"] as const;
export type WorkState = (typeof WORK_STATES)[number];

export function workState(value: unknown): WorkState {
  return value === "needs_attention" || value === "finished" ? value : "now";
}

export type Slots = {
  readonly slots: number;
  readonly running: number;
  readonly free: number;
};

export function slotsOf(slots: number, running: number): Slots {
  return { slots, running, free: Math.max(0, slots - running) };
}

export type RowState =
  | "running"
  | "stopping"
  | "lost"
  | "unknown"
  | "completed"
  | "failed"
  | "canceled";

export function rowState(
  attempt: Pick<WorkerAttemptResponse, "status" | "leaseState">,
): RowState {
  const { status, leaseState } = attempt;
  if (
    status === "completed" || status === "failed" || status === "canceled" ||
    status === "lost"
  ) {
    return status;
  }
  if (status === "quarantined" || leaseState === "unknown") return "unknown";
  if (leaseState === "expired" || leaseState === "lost") return "lost";
  return status === "canceling" ? "stopping" : "running";
}

export const ROW_TONE: Readonly<
  Record<RowState, "neutral" | "success" | "warning" | "danger">
> = {
  running: "success",
  stopping: "neutral",
  lost: "danger",
  unknown: "warning",
  completed: "success",
  failed: "danger",
  canceled: "neutral",
};

export function stateKey(state: RowState): MessageKey {
  return `machines.work.status.${state}` as MessageKey;
}

export function stateLineKey(
  state: RowState,
  options: { readonly hasTask: boolean; readonly silentSince: boolean },
): MessageKey | null {
  if (state === "unknown") return "machines.work.line.unknown" as MessageKey;
  if (state === "stopping") {
    return (options.hasTask
      ? "machines.work.line.stopping"
      : "machines.work.line.stoppingNoTask") as MessageKey;
  }
  if (state !== "lost") return null;
  const since = options.silentSince ? "Since" : "";
  const task = options.hasTask ? "Task" : "";
  return `machines.work.line.lost${since}${task}` as MessageKey;
}

const AGENT_KEYS: Readonly<Record<string, MessageKey>> = {
  claude_code: "machines.agent.claude" as MessageKey,
  codex: "machines.agent.codex" as MessageKey,
  pi: "machines.agent.pi" as MessageKey,
  mastra: "machines.work.agent.mastra" as MessageKey,
};

export function agentKey(
  codingAgent: WorkerAttemptResponse["codingAgent"],
): MessageKey | null {
  return codingAgent === null ? null : AGENT_KEYS[codingAgent] ?? null;
}

export type Place =
  | { readonly kind: "task"; readonly taskId: string; readonly title: string }
  | { readonly kind: "taskless"; readonly nameKey: MessageKey };

export function placeOf(attempt: WorkerAttemptResponse): Place {
  if (attempt.taskId !== null) {
    return {
      kind: "task",
      taskId: attempt.taskId,
      title: attempt.taskTitle ?? "",
    };
  }
  return {
    kind: "taskless",
    nameKey:
      (attempt.jobAction === "repository.inspect"
        ? "machines.work.taskless.repository"
        : "machines.work.taskless.other") as MessageKey,
  };
}

export function stepHref(attempt: WorkerAttemptResponse): string | null {
  return attempt.taskId !== null && attempt.runStepId !== null
    ? `/tasks/${attempt.taskId}?at=step:${attempt.runStepId}`
    : null;
}
