import { type CodingAgent, machineBadge } from "./machine-state.ts";
import {
  enrollmentCapabilities,
  installState,
  parsedSlots,
} from "./machine-wizard.ts";

export const STILL_WAITING_AFTER_MS = 120_000;

export type AddAnswers = Readonly<{
  name: string;
  slots: string;
  agent: CodingAgent | null;
}>;

export const initialAddAnswers: AddAnswers = {
  name: "",
  slots: "1",
  agent: null,
};

export const ADD_NAME_MAX = 200;

export type AddProblem = "nameTooLong" | "slotsInvalid" | "agentRequired";

export function addProblems(answers: AddAnswers): AddProblem[] {
  const problems: AddProblem[] = [];
  if (answers.name.trim().length > ADD_NAME_MAX) problems.push("nameTooLong");
  if (parsedSlots(answers.slots) === null) problems.push("slotsInvalid");
  if (answers.agent === null) problems.push("agentRequired");
  return problems;
}

export type CommandInput = Readonly<{
  name?: string;
  capabilities: string[];
  slots: number;
}>;

export function commandInput(answers: AddAnswers): CommandInput | null {
  const slots = parsedSlots(answers.slots);
  if (addProblems(answers).length > 0 || slots === null) return null;
  const name = answers.name.trim();
  return {
    ...(name.length > 0 ? { name } : {}),
    capabilities: enrollmentCapabilities(answers.agent as CodingAgent),
    slots,
  };
}

export type AddProgress =
  | Readonly<{ kind: "waiting"; stillWaiting: boolean }>
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "attention" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "canceled" }>;

type WorkerFacts = Parameters<typeof machineBadge>[0];

export function addProgress(options: {
  enrollment: { state: string; expiresAt: string };
  worker: WorkerFacts | null;
  now: number;
  waitingSince: number;
}): AddProgress {
  const { enrollment, worker, now, waitingSince } = options;
  const state = installState(enrollment, now);
  if (state === "expired" || state === "canceled") return { kind: state };
  if (state === "waiting") {
    return {
      kind: "waiting",
      stillWaiting: now - waitingSince >= STILL_WAITING_AFTER_MS,
    };
  }
  if (worker === null) return { kind: "checking" };
  const badge = machineBadge(worker);
  if (badge === "ready") return { kind: "ready" };
  if (badge === "needsAttention") return { kind: "attention" };
  return { kind: "checking" };
}

export function clockText(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
