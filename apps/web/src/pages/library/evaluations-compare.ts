import type {
  EvaluationBatch,
  EvaluationBatchResult,
  EvaluationComparison,
  EvaluationResultState,
} from "../../api/client.ts";
import {
  candidatePin,
  pinTitle,
  resultWords,
  type Words,
} from "./evaluations-state.ts";

export type CompareRefusal = NonNullable<EvaluationComparison["reason"]>;

export type GroupId =
  | "nowFailing"
  | "nowPassing"
  | "notMeasured"
  | "stillFailing"
  | "passingBoth";

export const OPEN_GROUPS: readonly GroupId[] = [
  "nowFailing",
  "nowPassing",
  "notMeasured",
];

export const CLOSED_GROUPS: readonly GroupId[] = [
  "stillFailing",
  "passingBoth",
];

export const GROUP_PAGE = 10;

export type ChangeTone = "success" | "danger" | "neutral";

export type SideLine = {
  readonly rate: Words;
  readonly measured: Words | null;
  readonly count: number;
};

export type ScorerLine = {
  readonly scorerId: string;
  readonly name: string;
  readonly left: SideLine;
  readonly right: SideLine;
  readonly change: { readonly words: Words; readonly tone: ChangeTone };
};

export type CaseRow = {
  readonly caseId: string;
  readonly caseName: string;
  readonly scorerId: string;
  readonly scorerName: string;
  readonly left: Words;
  readonly right: Words;
};

export type CompareGroup = {
  readonly id: GroupId;
  readonly rows: readonly CaseRow[];
};

export type UnpairedRow = {
  readonly caseId: string;
  readonly caseName: string;
  readonly scorerName: string;
};

export type NameMaps = {
  readonly cases: ReadonlyMap<string, string>;
  readonly scorers: ReadonlyMap<string, string>;
};

const MEASURED: ReadonlySet<EvaluationResultState> = new Set([
  "passed",
  "failed",
]);

export function caseNamesOf(
  results: readonly Pick<EvaluationBatchResult, "caseId" | "caseName">[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const result of results) {
    if (!names.has(result.caseId)) names.set(result.caseId, result.caseName);
  }
  return names;
}

export function scorerNamesOf(
  ...batches: readonly Pick<EvaluationBatch, "scorers">[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const batch of batches) {
    for (const scorer of batch.scorers) {
      if (!names.has(scorer.scorerId)) names.set(scorer.scorerId, scorer.slug);
    }
  }
  return names;
}

export function percent(rate: number): number {
  return Math.round(rate * 100);
}

export function sideLine(
  side: { readonly passRate: number | null; readonly cases: number },
): SideLine {
  if (side.passRate === null || side.cases === 0) {
    return {
      rate: { key: "library.evaluations.compare.side.nothing" },
      measured: null,
      count: 0,
    };
  }
  return {
    rate: {
      key: "library.evaluations.compare.side.rate",
      values: { rate: percent(side.passRate) },
    },
    measured: {
      key: "library.evaluations.compare.side.measured",
      values: { cases: side.cases },
    },
    count: side.cases,
  };
}

export function changeLine(
  change: number | null,
  left: SideLine,
  right: SideLine,
): ScorerLine["change"] {
  if (change === null || left.count === 0 || right.count === 0) {
    return {
      words: { key: "library.evaluations.compare.change.none" },
      tone: "neutral",
    };
  }
  const points = percent(Math.abs(change));
  if (points === 0) {
    return {
      words: { key: "library.evaluations.compare.change.same" },
      tone: "neutral",
    };
  }
  return change > 0
    ? {
      words: {
        key: "library.evaluations.compare.change.up",
        values: { points },
      },
      tone: "success",
    }
    : {
      words: {
        key: "library.evaluations.compare.change.down",
        values: { points },
      },
      tone: "danger",
    };
}

export function scorerLines(
  comparison: Pick<EvaluationComparison, "measures">,
  names: ReadonlyMap<string, string>,
): ScorerLine[] {
  return comparison.measures.map((measure) => {
    const left = sideLine(measure.left);
    const right = sideLine(measure.right);
    return {
      scorerId: measure.scorerId,
      name: names.get(measure.scorerId) ?? measure.scorerId,
      left,
      right,
      change: changeLine(measure.change, left, right),
    };
  });
}

export function groupOf(
  left: EvaluationResultState,
  right: EvaluationResultState,
): GroupId {
  if (!MEASURED.has(left) || !MEASURED.has(right)) return "notMeasured";
  if (left === "passed" && right === "failed") return "nowFailing";
  if (left === "failed" && right === "passed") return "nowPassing";
  return left === "failed" ? "stillFailing" : "passingBoth";
}

export function stateWords(state: EvaluationResultState, live: boolean): Words {
  return resultWords({ state, reason: null }, live);
}

export function caseGroups(
  comparison: Pick<EvaluationComparison, "cases">,
  names: NameMaps,
  live: { readonly left: boolean; readonly right: boolean },
): CompareGroup[] {
  const rows = new Map<GroupId, CaseRow[]>();
  for (const entry of comparison.cases) {
    const id = groupOf(entry.left, entry.right);
    const row: CaseRow = {
      caseId: entry.caseId,
      caseName: names.cases.get(entry.caseId) ?? entry.caseId,
      scorerId: entry.scorerId,
      scorerName: names.scorers.get(entry.scorerId) ?? entry.scorerId,
      left: stateWords(entry.left, live.left),
      right: stateWords(entry.right, live.right),
    };
    rows.set(id, [...(rows.get(id) ?? []), row]);
  }
  const byName = (a: CaseRow, b: CaseRow) =>
    a.caseName.localeCompare(b.caseName) ||
    a.scorerName.localeCompare(b.scorerName);
  return [...OPEN_GROUPS, ...CLOSED_GROUPS].map((id) => ({
    id,
    rows: [...(rows.get(id) ?? [])].sort(byName),
  }));
}

export function unpairedRows(
  entries: readonly { readonly caseId: string; readonly scorerId: string }[],
  names: NameMaps,
): UnpairedRow[] {
  return entries.map((entry) => ({
    caseId: entry.caseId,
    caseName: names.cases.get(entry.caseId) ?? entry.caseId,
    scorerName: names.scorers.get(entry.scorerId) ?? entry.scorerId,
  })).sort((a, b) =>
    a.caseName.localeCompare(b.caseName) ||
    a.scorerName.localeCompare(b.scorerName)
  );
}

export function sameThing(
  left: Pick<EvaluationBatch, "candidate" | "candidateDefinition">,
  right: Pick<EvaluationBatch, "candidate" | "candidateDefinition">,
): boolean {
  const a = left.candidateDefinition;
  const b = right.candidateDefinition;
  if (a !== null && b !== null) {
    return a.definitionId === b.definitionId && a.name !== null;
  }
  const x = candidatePin(left.candidate);
  const y = candidatePin(right.candidate);
  return x.id !== null && x.id === y.id && x.kind !== "other";
}

export type CompareTitle =
  | { readonly same: true; readonly words: Words }
  | { readonly same: false; readonly left: Words; readonly right: Words };

export function compareTitle(
  left: Pick<EvaluationBatch, "candidate" | "candidateDefinition">,
  right: Pick<EvaluationBatch, "candidate" | "candidateDefinition">,
): CompareTitle {
  const a = candidatePin(left.candidate).version;
  const b = candidatePin(right.candidate).version;
  const name = left.candidateDefinition?.name ?? null;
  if (sameThing(left, right) && name !== null && a !== null && b !== null) {
    return {
      same: true,
      words: {
        key: "library.evaluations.compare.title.same",
        values: { name, a, b },
      },
    };
  }
  return {
    same: false,
    left: pinTitle(left.candidate, left.candidateDefinition),
    right: pinTitle(right.candidate, right.candidateDefinition),
  };
}

export function sublineWords(
  batch: Pick<EvaluationBatch, "datasetName">,
  comparison: Pick<EvaluationComparison, "measures" | "cases">,
): Words {
  const cases = new Set(comparison.cases.map((entry) => entry.caseId)).size;
  return {
    key: "library.evaluations.compare.subline",
    values: {
      set: batch.datasetName,
      cases,
      scorers: comparison.measures.length,
    },
  };
}

export function refusalWords(
  reason: CompareRefusal,
  sets: { readonly left: string; readonly right: string },
): Words {
  switch (reason) {
    case "different_dataset":
      return {
        key: "library.evaluations.compare.refused.dataset",
        values: { a: sets.left, b: sets.right },
      };
    case "different_case_revision":
      return { key: "library.evaluations.compare.refused.caseRevision" };
    case "different_scorer_version":
      return { key: "library.evaluations.compare.refused.scorer" };
  }
}

export function stillRunning(
  left: Pick<EvaluationBatch, "state">,
  right: Pick<EvaluationBatch, "state">,
): "left" | "right" | null {
  const live = (batch: Pick<EvaluationBatch, "state">) =>
    batch.state === "queued" || batch.state === "running";
  if (live(right)) return "right";
  if (live(left)) return "left";
  return null;
}

export function olderFirst<T extends Pick<EvaluationBatch, "createdAt">>(
  a: T,
  b: T,
): readonly [T, T] {
  return Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? [a, b] : [b, a];
}
