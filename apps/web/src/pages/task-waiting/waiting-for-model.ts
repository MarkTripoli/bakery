import type { RunRequestListItem } from "../../api/client.ts";

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

function namesOf(requests: readonly RunRequestListItem[]): string[] {
  return [
    ...new Set(
      requests.map((request) =>
        request.audience?.name ?? request.recipient.displayName
      ),
    ),
  ];
}

const latest = (requests: readonly RunRequestListItem[]) =>
  requests.map((request) => request.expiresAt).sort().at(-1)!;

function lineOf(
  stepKey: string,
  requests: readonly RunRequestListItem[],
): WaitingLine | null {
  const open = requests.filter((request) => request.status === "open");
  if (open.length === 0) {
    return requests.every((request) => request.status === "expired")
      ? { kind: "expired", stepKey, expiresAt: latest(requests) }
      : null;
  }
  const expiresAt = latest(open);
  const passed = requests.filter((request) => request.passedOn);
  if (passed.length > 0) {
    const first = requests.filter((request) => !request.passedOn);
    return {
      kind: "passedOn",
      stepKey,
      expiresAt,
      first: namesOf(first),
      next: namesOf(passed),
      askedAt: first.find((request) => request.nextAsk?.askedAt)?.nextAsk
        ?.askedAt ?? passed[0].createdAt,
    };
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
  requests: readonly RunRequestListItem[],
): WaitingLine[] {
  const steps = new Map<string, RunRequestListItem[]>();
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

export function fallbackLines(
  requests: readonly RunRequestListItem[],
): FallbackLine[] {
  return requests.flatMap((request) =>
    request.status === "open" && request.fallbackForName !== null
      ? [{
        name: request.fallbackForName,
        owner: request.recipient.displayName,
      }]
      : []
  );
}
