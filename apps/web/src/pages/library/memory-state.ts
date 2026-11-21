import type { ApiFailure, MemoryEntryResponse } from "../../api/client.ts";

/** The one badge a remembered fact wears in the list (design-ux, #72). */
export type MemoryBadge =
  | "suggested"
  | "inUse"
  | "noLongerUsed"
  | "sourceMissing";

/**
 * A suggested fact waits for a person; a retired one is no longer used. A fact
 * in use whose source was deleted shows "source missing", because that is the
 * thing to act on. A source the reader may not see, or that could not be
 * checked, does not change the badge: nothing is known to be missing.
 */
export function memoryBadge(
  entry: Pick<MemoryEntryResponse, "status" | "sourceState">,
): MemoryBadge {
  if (entry.status === "proposed") return "suggested";
  if (entry.status === "retired") return "noLongerUsed";
  return entry.sourceState === "deleted" ? "sourceMissing" : "inUse";
}

/**
 * The list order: facts in use and waiting for review first, in the order the
 * server gives them (newest first), facts no longer used last.
 */
export function orderMemories<Row extends Pick<MemoryEntryResponse, "status">>(
  rows: readonly Row[],
): Row[] {
  const used = rows.filter((row) => row.status !== "retired");
  const retired = rows.filter((row) => row.status === "retired");
  return [...used, ...retired];
}

/** How sure Bakery was, in words: never the number. */
export type ConfidenceBand = "high" | "medium" | "low";

/** High from 0.8, Medium from 0.5, Low below; the server's decimal string is read exactly once. */
export function confidenceBand(confidence: string): ConfidenceBand {
  const value = Number(confidence);
  if (value >= 0.8) return "high";
  if (value >= 0.5) return "medium";
  return "low";
}

/** What the second line of a row (and the Source box) says about where a fact came from. */
export type SourceLine =
  | {
    readonly kind: "available";
    readonly name: string;
    readonly revision: number;
  }
  | { readonly kind: "deleted" }
  | { readonly kind: "noAccess" }
  | { readonly kind: "unknown" };

/**
 * From the revision the entry carries. A source is named only when the server
 * named it (available, or deleted for a reader who may see the document); a
 * deleted source is always said to be deleted, whatever else is known.
 */
export function sourceLine(
  entry: Pick<MemoryEntryResponse, "currentRevision" | "sourceState">,
): SourceLine {
  switch (entry.sourceState) {
    case "deleted":
      return { kind: "deleted" };
    case "no_access":
      return { kind: "noAccess" };
    case "unknown":
      return { kind: "unknown" };
    case "available": {
      const revision = entry.currentRevision;
      return revision !== null && revision.sourceName !== null &&
          revision.sourceRevision !== null
        ? {
          kind: "available",
          name: revision.sourceName,
          revision: revision.sourceRevision,
        }
        : { kind: "unknown" };
    }
  }
}

/** How many times a fact has been corrected: every revision after the first. */
export function correctionCount(
  entry: Pick<MemoryEntryResponse, "currentRevision">,
): number {
  const revision = entry.currentRevision?.revision ?? 1;
  return Math.max(0, revision - 1);
}

/** The changes a person may make to a fact, from where it stands. */
export type MemoryActions = Readonly<{
  /** A suggested fact: put it in use as it is worded. */
  approve: boolean;
  /** A suggested fact: change the wording first; saving it puts it in use. */
  correctThenApprove: boolean;
  /** A fact in use: a new wording with a reason and a source. */
  correct: boolean;
  /** A suggested fact: do not use it (nothing was using it, so nothing to confirm). */
  dontUse: boolean;
  /** A fact in use: stop using it, after a confirmation. */
  stopUsing: boolean;
  /** A fact no longer used: put it back in use. */
  useAgain: boolean;
}>;

/** A retired fact cannot be corrected (the server refuses), so it offers only Use again. */
export function memoryActions(
  entry: Pick<MemoryEntryResponse, "status">,
): MemoryActions {
  const proposed = entry.status === "proposed";
  const active = entry.status === "active";
  return {
    approve: proposed,
    correctThenApprove: proposed,
    correct: active,
    dontUse: proposed,
    stopUsing: active,
    useAgain: entry.status === "retired",
  };
}

/** Why a change did not go through, in the few ways the page has words for. */
export type MemoryRefusal =
  | "offline"
  | "forbidden"
  | "stale"
  | "notFound"
  | "retired"
  | "conflict"
  | "unscanned"
  | "weak"
  | "scope"
  | "source"
  | "other";

const REFUSAL_BY_REASON: Readonly<Record<string, MemoryRefusal>> = {
  memory_version_stale: "stale",
  memory_not_found: "notFound",
  memory_retired: "retired",
  conflict_detected: "conflict",
  conflict_unscanned: "unscanned",
  evidence_weak: "weak",
  repository_out_of_scope: "scope",
  source_artifact_unknown: "source",
};

/**
 * Reads a failed change by the rule slug the server sent, never by its text.
 * A 409 or 412 with no known slug still means someone else got there first.
 */
export function memoryRefusal(error: unknown): MemoryRefusal {
  const failure = error as Partial<ApiFailure> | null;
  if (failure === null || typeof failure !== "object") return "other";
  if (failure.kind === "network") return "offline";
  if (failure.kind !== "problem" || failure.problem === undefined) {
    return "other";
  }
  const { reason, status } = failure.problem;
  const known = reason === undefined ? undefined : REFUSAL_BY_REASON[reason];
  if (known !== undefined) return known;
  if (status === 403) return "forbidden";
  return status === 409 || status === 412 ? "stale" : "other";
}

/** What a correction is made of. */
export type CorrectionDraft = Readonly<{
  content: string;
  reason: string;
  /** The document version chosen as the source; empty until one is chosen. */
  sourceArtifactVersionId: string;
}>;

/** Which fields of a correction are missing (a blank wording or reason counts as missing). */
export function correctionMissing(
  draft: CorrectionDraft,
): { content: boolean; reason: boolean; source: boolean } {
  return {
    content: draft.content.trim() === "",
    reason: draft.reason.trim() === "",
    source: draft.sourceArtifactVersionId === "",
  };
}
