import type { StepFact } from "./step-facts.ts";

export type GivenFactState = "given" | "corrected_since" | "stopped_since";

export type GivenFact = Readonly<{
  memoryId: string;
  wording: string;
  recordedAt: string;
  state: GivenFactState;
}>;

export type FactNow = Readonly<{
  currentRevisionId: string | null;
  status: string;
}>;

export function describeGivenFact(
  recorded: StepFact,
  now: FactNow | undefined,
): GivenFact {
  const state: GivenFactState = now === undefined || now.status === "retired"
    ? "stopped_since"
    : now.currentRevisionId !== null &&
        now.currentRevisionId !== recorded.revisionId
    ? "corrected_since"
    : "given";
  return {
    memoryId: recorded.memoryId,
    wording: recorded.wording,
    recordedAt: recorded.recordedAt,
    state,
  };
}

export function describeGivenFacts(
  recorded: readonly StepFact[],
  now: ReadonlyMap<string, FactNow>,
): readonly GivenFact[] {
  return recorded.map((fact) =>
    describeGivenFact(fact, now.get(fact.memoryId))
  );
}
