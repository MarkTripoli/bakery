import type { HandoffManifestResponse } from "../../api/client.ts";

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
  unconfirmedEffects: number;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const RESULTS: readonly string[] = ["passed", "failed", "skipped", "unknown"];

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

export function reasonKey(reason: FreshReason | "unknown"): string {
  return `tasks.run.handover.reason.${reason}`;
}

export function outcomeKey(
  continuation: {
    readonly mode: string;
    readonly freshReason?: string | null;
    readonly waiting?: boolean | null;
  },
  unconfirmedEffects: number,
): "waiting" | "exact" | "fresh" | "freshChosen" {
  if (continuation.mode === "exact_harness_resume") return "exact";
  if (continuation.freshReason === "fresh_requested") {
    return (continuation.waiting ?? unconfirmedEffects > 0)
      ? "waiting"
      : "freshChosen";
  }
  if (
    continuation.freshReason === "effects_unresolved" ||
    unconfirmedEffects > 0
  ) return "waiting";
  return "fresh";
}

export type Refusal = Readonly<{
  key: string;
  where: "card" | "page";
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

export function recordedHandover(
  record: Pick<
    HandoffManifestResponse,
    | "status"
    | "manifest"
    | "continuedMode"
    | "continuedFreshReason"
    | "continuedByName"
    | "continuedAt"
    | "continuedWaiting"
  >,
):
  | Readonly<{
    at: string;
    byName: string | null;
    outcome: "exact" | "fresh" | "freshChosen" | "waiting";
    reason: FreshReason | "unknown";
    unconfirmedEffects: number;
  }>
  | null {
  if (
    record.status !== "continued" || !record.continuedMode ||
    !record.continuedAt
  ) return null;
  const unconfirmed = viewManifest(record.manifest)?.unconfirmedEffects ?? 0;
  const reason = record.continuedFreshReason;
  return {
    at: record.continuedAt,
    byName: record.continuedByName ?? null,
    outcome: outcomeKey(
      {
        mode: record.continuedMode,
        freshReason: reason,
        waiting: record.continuedWaiting,
      },
      unconfirmed,
    ),
    reason: reason !== null && reason !== undefined &&
        FRESH_REASONS.includes(reason)
      ? reason
      : "unknown",
    unconfirmedEffects: unconfirmed,
  };
}
