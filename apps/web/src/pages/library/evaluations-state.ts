import type { MessageKey } from "@bakery/i18n";
import type {
  EvaluationBatch,
  EvaluationBatchResult,
  EvaluationResultState,
} from "../../api/client.ts";

/** The tones a run's badge and gate can take (design-ux #75, revision 4). */
export type EvaluationTone =
  | "neutral"
  | "information"
  | "success"
  | "warning"
  | "danger";

/** Words for the translator: a key and the values it needs. */
export type Words = {
  readonly key: MessageKey;
  readonly values?: Readonly<Record<string, string | number>>;
};

/** Every state a result can be in. */
export const RESULT_STATES: readonly EvaluationResultState[] = [
  "passed",
  "failed",
  "error",
  "unscored",
  "missing",
  "canceled",
  "skipped",
];

/**
 * What the chips filter by. An error and a result never scored read the same
 * to a person ("Could not be scored. This is not a score of zero."), so they
 * share one chip, `notScored`, whose list is both states (design-ux #75).
 */
export type ResultFilter =
  | "passed"
  | "failed"
  | "notScored"
  | "missing"
  | "canceled"
  | "skipped";

/** The chips in the order they are listed. */
export const RESULT_FILTERS: readonly ResultFilter[] = [
  "passed",
  "failed",
  "notScored",
  "missing",
  "canceled",
  "skipped",
];

/** The server states one filter reads: `notScored` reads errors first, then results never scored. */
export function statesOfFilter(
  filter: ResultFilter,
): readonly EvaluationResultState[] {
  return filter === "notScored" ? ["error", "unscored"] : [filter];
}

/** How many results a filter holds: the two scoring states add up. */
export function filterCount(
  counts: EvaluationBatch["counts"],
  filter: ResultFilter,
): number {
  return statesOfFilter(filter).reduce((sum, state) => sum + counts[state], 0);
}

/** The tab the Library opens for the runs (`?tab=evaluations`). */
export const EVALUATIONS_TAB = "evaluations";

/** Whether the run can still change: it is waiting or running. */
export function isLiveRun(batch: Pick<EvaluationBatch, "state">): boolean {
  return batch.state === "queued" || batch.state === "running";
}

/**
 * The badge words and tone from the run's state (design-ux #75, revision 4).
 * "Finished with gaps" is a warning, never a success: a run with results that
 * were never measured has not passed anything.
 */
export function runBadge(
  batch: Pick<
    EvaluationBatch,
    "state" | "gate" | "counts" | "measuredCount" | "requiredCount"
  >,
): { readonly words: Words; readonly tone: EvaluationTone } {
  const measured = batch.measuredCount;
  const required = batch.requiredCount;
  switch (batch.state) {
    case "queued":
      return {
        words: { key: "library.evaluations.badge.queued" },
        tone: "neutral",
      };
    case "running":
      return {
        words: {
          key: "library.evaluations.badge.running",
          values: { measured, required },
        },
        tone: "information",
      };
    case "completed":
      return {
        words: {
          key: "library.evaluations.badge.completed",
          values: { passed: batch.counts.passed, required },
        },
        tone: batch.gate.decision === "met"
          ? "success"
          : batch.gate.decision === "not_met"
          ? "danger"
          : "warning",
      };
    case "completed_with_errors":
      return {
        words: {
          key: "library.evaluations.badge.gaps",
          values: { measured, required },
        },
        tone: "warning",
      };
    case "canceled":
      return {
        words: {
          key: "library.evaluations.badge.canceled",
          values: { measured, required },
        },
        tone: "neutral",
      };
    case "failed":
      return {
        words: { key: "library.evaluations.badge.failed" },
        tone: "danger",
      };
  }
}

/** The gate in words for a list row: its decision, or that it is judged when the run ends. */
export function gateLine(
  batch: Pick<EvaluationBatch, "state" | "gate">,
): Words {
  if (isLiveRun(batch)) return { key: "library.evaluations.gate.line.pending" };
  switch (batch.gate.decision) {
    case "met":
      return { key: "library.evaluations.gate.line.met" };
    case "not_met":
      return { key: "library.evaluations.gate.line.notMet" };
    case "cannot_be_judged":
      return { key: "library.evaluations.gate.line.cannot" };
  }
}

/** What the gate card on a run's page says, and what its button shows. */
export type GateCard = {
  readonly tone: "success" | "warning" | "neutral";
  /** A glyph in place of the tone's own: a clock while the run is still going. */
  readonly icon?: "clock";
  readonly title: Words;
  readonly body: Words;
  /** The results the button shows, and the state it filters to; null when nothing to show. */
  readonly show: {
    readonly count: number;
    readonly state: ResultFilter;
  } | null;
  /**
   * The unmeasured results when they sit in more than one state: there is no
   * button then, because one button cannot show them all, and the sentence
   * says where they are instead.
   */
  readonly spread:
    | readonly { readonly state: ResultFilter; readonly count: number }[]
    | null;
};

/** The groups of results that are not a measured pass or fail, in the order the button prefers them. */
const UNMEASURED: readonly ResultFilter[] = [
  "missing",
  "notScored",
  "canceled",
  "skipped",
];

/**
 * The gate card of a run. A gate that cannot be judged is grey and says it is
 * not a pass; only a met gate is green. While the run is live the gate has no
 * decision yet, so the card says when it will.
 */
export function gateCard(
  batch: Pick<
    EvaluationBatch,
    "state" | "gate" | "counts" | "requiredCount" | "measuredCount"
  >,
): GateCard {
  const rule = batch.gate.rule;
  if (isLiveRun(batch)) {
    return {
      tone: "neutral",
      icon: "clock",
      title: { key: "library.evaluations.gate.pending.title" },
      body: { key: "library.evaluations.gate.pending.body", values: { rule } },
      show: null,
      spread: null,
    };
  }
  if (batch.gate.decision === "met") {
    return {
      tone: "success",
      title: { key: "library.evaluations.gate.met.title" },
      body: { key: "library.evaluations.gate.met.body", values: { rule } },
      show: null,
      spread: null,
    };
  }
  if (batch.gate.decision === "not_met") {
    const failed = batch.gate.blockers.filter((blocker) =>
      blocker.state === "failed"
    ).length;
    const count = failed > 0 ? failed : batch.counts.failed;
    return {
      tone: "warning",
      title: { key: "library.evaluations.gate.notMet.title" },
      body: {
        key: "library.evaluations.gate.notMet.body",
        values: { count },
      },
      show: count > 0 ? { count, state: "failed" } : null,
      spread: null,
    };
  }
  const found = UNMEASURED.flatMap((state) => {
    const count = filterCount(batch.counts, state);
    return count > 0 ? [{ state, count }] : [];
  });
  const unmeasured = found.reduce((sum, entry) => sum + entry.count, 0);
  const several = found.length > 1;
  return {
    tone: "neutral",
    title: { key: "library.evaluations.gate.cannot.title" },
    body: {
      key: several
        ? "library.evaluations.gate.cannot.bodyMany"
        : "library.evaluations.gate.cannot.body",
      values: { count: unmeasured, required: batch.requiredCount, rule },
    },
    // The button shows as many results as it names: one state, it selects it.
    show: found.length === 1
      ? { count: unmeasured, state: found[0].state }
      : null,
    spread: several ? found : null,
  };
}

/** One count line under Results: a state's words and how many results are in it. */
export type CountLine = {
  readonly id:
    | "passed"
    | "failed"
    | "notScored"
    | "notRun"
    | "stopped"
    | "skipped";
  readonly count: number;
};

/**
 * The six counts of a run, always adding up to the required count: a result
 * that could not be scored (an error, or never scored) is one line, because
 * for the reader neither is a score.
 */
export function countLines(counts: EvaluationBatch["counts"]): CountLine[] {
  return [
    { id: "passed", count: counts.passed },
    { id: "failed", count: counts.failed },
    { id: "notScored", count: counts.error + counts.unscored },
    { id: "notRun", count: counts.missing },
    { id: "stopped", count: counts.canceled },
    { id: "skipped", count: counts.skipped },
  ];
}

/** What kind of thing a run measured, read from the pin the server keeps. */
export type CandidatePin = {
  readonly kind: "agent" | "workflow" | "other";
  readonly id: string | null;
  readonly version: number | null;
};

/** Reads a run's `candidate` or `baseline` pin ({ kind, id, version }); anything else is "other". */
export function candidatePin(value: unknown): CandidatePin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "other", id: null, version: null };
  }
  const pin = value as Record<string, unknown>;
  const kind = typeof pin.kind === "string" ? pin.kind.toLowerCase() : "";
  return {
    kind: kind.includes("agent")
      ? "agent"
      : kind.includes("workflow")
      ? "workflow"
      : "other",
    id: typeof pin.id === "string" ? pin.id : null,
    version: typeof pin.version === "number" && Number.isInteger(pin.version)
      ? pin.version
      : null,
  };
}

/**
 * "{name}, version {n}" for what a run measured. The pin gives the version and
 * the server gives the definition's name beside it; when the pin names nothing
 * the server can resolve, the name is null and the words say the kind and the
 * version.
 */
export function pinTitle(
  value: unknown,
  definition: { readonly name: string | null } | null,
): Words {
  const pin = candidatePin(value);
  const version = pin.version;
  if (version === null) return { key: "library.evaluations.title.unknown" };
  const name = definition?.name ?? undefined;
  if (name !== undefined) {
    return {
      key: "library.evaluations.title.named",
      values: { name, version },
    };
  }
  return {
    key: pin.kind === "agent"
      ? "library.evaluations.title.agent"
      : pin.kind === "workflow"
      ? "library.evaluations.title.workflow"
      : "library.evaluations.title.version",
    values: { version },
  };
}

/** The result words and tone for one scorer's line under a test case. */
export function resultWords(
  // An attempt can also be "interrupted": it ended before it measured anything,
  // so it reads as not scored, with its reason.
  result: Pick<EvaluationBatchResult, "reason"> & {
    readonly state: EvaluationBatchResult["state"] | "interrupted";
  },
  live: boolean,
): Words {
  const reason = result.reason?.trim() ?? "";
  switch (result.state) {
    case "passed":
      return { key: "library.evaluations.result.passed" };
    case "failed":
      return { key: "library.evaluations.result.failed" };
    case "error":
    case "interrupted":
    case "unscored":
      return reason === ""
        ? { key: "library.evaluations.result.notScoredBare" }
        : { key: "library.evaluations.result.notScored", values: { reason } };
    case "missing":
      return reason !== ""
        ? { key: "library.evaluations.result.notRun", values: { reason } }
        : live
        ? { key: "library.evaluations.result.notRunYet" }
        : { key: "library.evaluations.result.notRunBare" };
    case "canceled":
      return { key: "library.evaluations.result.stopped" };
    case "skipped":
      return reason === ""
        ? { key: "library.evaluations.result.skippedBare" }
        : { key: "library.evaluations.result.skipped", values: { reason } };
  }
}

/** One test case of a run with a line for each scorer that measured it. */
export type CaseGroup = {
  readonly caseId: string;
  /** The test case's name, as the server gives it on each of its results. */
  readonly caseName: string;
  readonly results: readonly EvaluationBatchResult[];
};

/**
 * The candidate side's results grouped by test case, in the order the server
 * listed them. The baseline side is the comparison's (a later slice), so it
 * is left out here.
 */
export function groupByCase(
  results: readonly EvaluationBatchResult[],
): CaseGroup[] {
  const groups = new Map<string, EvaluationBatchResult[]>();
  for (const result of results) {
    if (result.role !== "candidate") continue;
    const list = groups.get(result.caseId);
    if (list === undefined) groups.set(result.caseId, [result]);
    else list.push(result);
  }
  return [...groups].map(([caseId, rows]) => ({
    caseId,
    caseName: rows[0].caseName,
    results: rows,
  }));
}

/** The chips under the gate: All, then one per kind of result that has any. */
export function stateChips(
  counts: EvaluationBatch["counts"],
): { readonly state: ResultFilter; readonly count: number }[] {
  return RESULT_FILTERS.flatMap((state) => {
    const count = filterCount(counts, state);
    return count > 0 ? [{ state, count }] : [];
  });
}

/** The filter a `?state=` value names, or null for all results. */
export function resultStateFilter(value: unknown): ResultFilter | null {
  return RESULT_FILTERS.find((filter) => filter === value) ?? null;
}
