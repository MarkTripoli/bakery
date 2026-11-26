import type {
  RunRequestResponse,
  RunStepListResponse,
} from "../../api/client.ts";

export type WaitingLine =
  & Readonly<{ stepKey: string; expiresAt: string }>
  & (
    | Readonly<{ kind: "waiting"; who: readonly string[] }>
    | Readonly<{
      kind: "next";
      who: readonly string[];
      next: string | null;
      dueAt: string;
    }>
    | Readonly<{
      kind: "passedOn";
      first: readonly string[];
      next: readonly string[];
      askedAt: string;
    }>
    | Readonly<{ kind: "expired" }>
  );

export type FallbackLine = Readonly<{ name: string; owner: string }>;

function namesOf(requests: readonly RunRequestResponse[]): string[] {
  return [
    ...new Set(
      requests.map((request) =>
        request.audience?.name ?? request.recipient.displayName
      ),
    ),
  ];
}

const latest = (requests: readonly RunRequestResponse[]) =>
  requests.map((request) => request.expiresAt).sort().at(-1)!;

function newestRound(requests: readonly RunRequestResponse[]) {
  const asked = requests.map((request) => request.createdAt).sort().at(-1);
  return requests.filter((request) => request.createdAt === asked);
}

function lineOf(
  stepKey: string,
  requests: readonly RunRequestResponse[],
): WaitingLine | null {
  const open = requests.filter((request) => request.status === "open");
  if (open.length === 0) {
    const newest = newestRound(requests);
    return newest.every((request) => request.status === "expired")
      ? { kind: "expired", stepKey, expiresAt: latest(newest) }
      : null;
  }
  const expiresAt = latest(open);
  const newest = newestRound(open);
  if (newest.every((request) => request.passedOn)) {
    const askedAt = newest[0].createdAt;
    const silent = requests.filter((request) =>
      request.nextAsk?.askedAt === askedAt &&
      (request.status === "open" || request.status === "expired")
    );
    if (silent.length > 0) {
      return {
        kind: "passedOn",
        stepKey,
        expiresAt,
        first: namesOf(silent),
        next: namesOf(newest),
        askedAt,
      };
    }
  }
  const pending = open.find((request) =>
    request.nextAsk !== null && request.nextAsk.askedAt === null
  )?.nextAsk;
  return pending
    ? {
      kind: "next",
      stepKey,
      expiresAt,
      who: namesOf(open),
      next: pending.who,
      dueAt: pending.dueAt,
    }
    : { kind: "waiting", stepKey, expiresAt, who: namesOf(open) };
}

export function waitingLines(
  requests: readonly RunRequestResponse[],
): WaitingLine[] {
  const steps = new Map<string, RunRequestResponse[]>();
  for (const request of requests) {
    if (request.stepKey === null || request.intent === "fyi") continue;
    if (request.status === "withdrawn") continue;
    const held = steps.get(request.stepKey) ?? [];
    held.push(request);
    steps.set(request.stepKey, held);
  }
  return [...steps].flatMap(([stepKey, held]) => {
    const line = lineOf(stepKey, held);
    return line === null ? [] : [line];
  });
}

export type StepProgress = Pick<
  RunStepListResponse["items"][number],
  "stepKey" | "iteration" | "status"
>;

export function expiryOutcome(
  steps: readonly StepProgress[],
  stepKey: string,
): "expired" | "expiredContinued" | "expiredStuck" {
  const latestStep = steps
    .filter((step) => step.stepKey === stepKey)
    .sort((a, b) => b.iteration - a.iteration)[0];
  if (latestStep === undefined) return "expired";
  return latestStep.status === "completed"
    ? "expiredContinued"
    : "expiredStuck";
}

export function fallbackLines(
  requests: readonly RunRequestResponse[],
): FallbackLine[] {
  const lines = new Map<string, FallbackLine>();
  for (const request of requests) {
    if (request.status !== "open" || request.fallbackForName === null) continue;
    const line = {
      name: request.fallbackForName,
      owner: request.recipient.displayName,
    };
    lines.set(JSON.stringify(line), line);
  }
  return [...lines.values()];
}
