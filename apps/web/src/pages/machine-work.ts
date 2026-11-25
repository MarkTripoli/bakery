import type { MessageKey } from "@bakery/i18n";
import type { WorkerAttemptResponse } from "../api/client.ts";

export const WORK_STATES = ["now", "needs_attention", "finished"] as const;
export type WorkState = (typeof WORK_STATES)[number];

export function workState(value: unknown): WorkState {
  return value === "needs_attention" || value === "finished" ? value : "now";
}

export type Slots = {
  readonly slots: number;
  readonly occupied: number;
  readonly unoccupied: number;
};

export function slotsOf(slots: number, occupied: number): Slots {
  return {
    slots,
    occupied,
    unoccupied: Math.max(0, slots - occupied),
  };
}

export function statusKey(status: WorkerAttemptResponse["status"]): MessageKey {
  return `machines.work.status.${status}` as MessageKey;
}

export function leaseKey(
  lease: WorkerAttemptResponse["leaseState"],
): MessageKey {
  return `machines.work.lease.${lease}` as MessageKey;
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
  | { readonly kind: "taskless"; readonly action: string };

export function placeOf(attempt: WorkerAttemptResponse): Place {
  if (attempt.taskId !== null) {
    return {
      kind: "task",
      taskId: attempt.taskId,
      title: attempt.taskTitle ?? "",
    };
  }
  return { kind: "taskless", action: attempt.jobAction };
}

export function stepHref(attempt: WorkerAttemptResponse): string | null {
  return attempt.taskId !== null && attempt.runStepId !== null
    ? `/tasks/${attempt.taskId}?at=step:${attempt.runStepId}`
    : null;
}
