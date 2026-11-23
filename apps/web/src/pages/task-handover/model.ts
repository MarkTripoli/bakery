import type { HandoffManifestResponse } from "../../api/client.ts";

/**
 * What the "Hand over to a new session" card says (#72, design revision 3).
 * Pure functions over what the server returned, so the rules are tested
 * without a page: how the new session will carry on, what it is given, and
 * what each refusal reads as. The page never decides eligibility itself; it
 * only tells the person what the server said and what the server's own rows
 * make of it when the click arrives.
 */

export type FreshReason = NonNullable<HandoffManifestResponse["freshReason"]>;

export const FRESH_REASONS: readonly FreshReason[] = [
  "exact_resume_not_requested",
  "boundary_unsafe",
  "effects_unresolved",
  "session_changed",
  "no_native_evidence",
  "native_evidence_mismatch",
  "history_revoked",
];

export type CarryOn =
  | Readonly<{ kind: "exact" }>
  | Readonly<{ kind: "fresh"; reason: FreshReason | "unknown" }>;

export type DocumentRef = Readonly<{ artifactId: string; versionId: string }>;

export type CheckResult = "passed" | "failed" | "skipped" | "unknown";

export type ManifestView = Readonly<{
  goal: string;
  nextAction: string;
  decisions: readonly string[];
  documents: readonly DocumentRef[];
  commitShort: string;
  hasPatch: boolean;
  capturePaused: boolean;
  checks: readonly Readonly<{
    command: string;
    result: CheckResult;
    evidenceVersionId: string | null;
  }>[];
  /** Outside actions the server has not seen confirmed or failed. */
  unconfirmedEffects: number;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const RESULTS: readonly string[] = ["passed", "failed", "skipped", "unknown"];

/**
 * The stored manifest as the card shows it, or null when it does not have the
 * shape the server validated on the way in (a row that no longer parses is
 * never guessed at; the card then says there is no saved point to show).
 */
export function viewManifest(manifest: unknown): ManifestView | null {
  if (!isRecord(manifest)) return null;
  const goal = text(manifest.goal);
  const nextAction = text(manifest.nextAction);
  const repository = manifest.repository;
  const context = manifest.context;
  if (
    goal === null || nextAction === null || !isRecord(repository) ||
    !isRecord(context) || !Array.isArray(manifest.decisions) ||
    !Array.isArray(context.artifactRefs) || !Array.isArray(manifest.tests) ||
    !Array.isArray(manifest.pendingEffects)
  ) return null;
  const commit = text(repository.commitSha);
  if (commit === null) return null;
  const documents: DocumentRef[] = [];
  for (const ref of context.artifactRefs) {
    if (!isRecord(ref)) return null;
    const artifactId = text(ref.artifactId);
    const versionId = text(ref.versionId);
    if (artifactId === null || versionId === null) return null;
    documents.push({ artifactId, versionId });
  }
  const checks: ManifestView["checks"][number][] = [];
  for (const entry of manifest.tests) {
    if (!isRecord(entry)) return null;
    const command = text(entry.command);
    if (command === null) return null;
    checks.push({
      command,
      result: typeof entry.result === "string" && RESULTS.includes(entry.result)
        ? entry.result as CheckResult
        : "unknown",
      evidenceVersionId: text(entry.evidenceVersionId),
    });
  }
  let unconfirmed = 0;
  for (const effect of manifest.pendingEffects) {
    if (!isRecord(effect)) return null;
    if (effect.state !== "confirmed" && effect.state !== "failed") {
      unconfirmed += 1;
    }
  }
  return {
    goal,
    nextAction,
    decisions: manifest.decisions.filter((item): item is string =>
      typeof item === "string" && item.length > 0
    ),
    documents,
    commitShort: commit.slice(0, 8),
    hasPatch: repository.uncommittedPatch !== null &&
      repository.uncommittedPatch !== undefined,
    capturePaused: repository.captureStatus === "paused",
    checks,
    unconfirmedEffects: unconfirmed,
  };
}

/**
 * How the new session will carry on, as the page can tell before the click. An
 * exact pick-up is promised only as "will try": the server decides again when
 * the click arrives, and the page says so afterwards if it was not exact.
 */
export function carryOn(
  record: Pick<
    HandoffManifestResponse,
    "decisionMode" | "freshReason" | "safeBoundary"
  >,
  view: ManifestView,
): CarryOn {
  if (
    record.decisionMode === "exact_harness_resume" &&
    record.safeBoundary === true && view.unconfirmedEffects === 0
  ) return { kind: "exact" };
  const reason = record.freshReason;
  return {
    kind: "fresh",
    reason: reason !== null && reason !== undefined &&
        FRESH_REASONS.includes(reason)
      ? reason
      : "unknown",
  };
}

/** The key of the sentence for a reason, for `translate`. */
export function reasonKey(reason: FreshReason | "unknown"): string {
  return `tasks.run.handover.reason.${reason}`;
}

/** What a continuation's answer says happened, for the line on the timeline. */
export function outcomeKey(
  continuation: {
    readonly mode: string;
    readonly freshReason?: string | null;
  },
  unconfirmedEffects: number,
): "waiting" | "exact" | "fresh" {
  if (continuation.mode === "exact_harness_resume") return "exact";
  // An unsettled outside action parks the step until it is settled.
  if (
    continuation.freshReason === "effects_unresolved" ||
    unconfirmedEffects > 0
  ) return "waiting";
  return "fresh";
}

export type Refusal = Readonly<{
  key: string;
  /** `card` keeps the card open and says it there; `page` closes it and says it on the step. */
  where: "card" | "page";
  /** The run or the saved point moved: read them again. */
  reload: boolean;
}>;

const card = (key: string, reload = false): Refusal => ({
  key,
  where: "card",
  reload,
});
const page = (key: string): Refusal => ({ key, where: "page", reload: true });

const OTHER: Refusal = card("tasks.run.handover.refused.other");

const REFUSALS: Readonly<Record<string, Refusal>> = {
  already_continued: page("tasks.run.handover.refused.already"),
  fence_moved: page("tasks.run.handover.refused.already"),
  source_not_live: page("tasks.run.handover.refused.sourceStopped"),
  run_not_active: page("tasks.run.handover.refused.notRunning"),
  job_terminal: page("tasks.run.handover.refused.notRunning"),
  cancel_requested: page("tasks.run.handover.refused.notRunning"),
  manifest_blocked: page("tasks.run.handover.refused.blocked"),
  awaiting_reconciliation: page("tasks.run.handover.refused.reconciling"),
  attempt_budget_exhausted: page("tasks.run.handover.refused.budget"),
  capture_incomplete: card("tasks.run.handover.refused.capture"),
};

/**
 * What a refused hand-over reads as. A changed run redraws the card from the
 * server's current answer; every reason the page does not know reads as the
 * plain "Not handed over. Nothing changed. Try again."
 */
export function refusalOf(
  failure: {
    readonly kind: string;
    readonly problem?: { readonly code: string; readonly reason?: string };
  },
): Refusal {
  if (failure.kind !== "problem" || !failure.problem) return OTHER;
  const { code, reason } = failure.problem;
  if (code === "PRECONDITION_FAILED") {
    return card("tasks.run.handover.refused.changed", true);
  }
  if (code !== "STATE_CONFLICT" || reason === undefined) return OTHER;
  return REFUSALS[reason] ?? OTHER;
}

/**
 * True when the answer never arrived or the server could not say, so the
 * hand-over may have gone through: the same key is sent again on a retry.
 */
export function outcomeUnknown(
  failure: {
    readonly kind: string;
    readonly problem?: { readonly status: number; readonly retryable: boolean };
  },
): boolean {
  if (failure.kind !== "problem" || !failure.problem) return true;
  const { status, retryable } = failure.problem;
  return retryable || status >= 500 || status === 408;
}
