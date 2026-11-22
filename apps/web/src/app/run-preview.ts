import type { RunPreviewResponse } from "../api/client.ts";

/** What the Preview card says about a run's newest preview, decided from the server's own reading. */
export type PreviewCardState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "starting" }
  | { readonly kind: "running"; readonly expiresAt: string }
  | {
    readonly kind: "stopped";
    readonly reason: "person" | "run_cancelled" | "replaced";
    readonly at: string | null;
    readonly by: string | null;
    readonly byName: string | null;
  }
  | {
    readonly kind: "ended";
    readonly reason: "time_limit" | "run_ended";
    readonly at: string | null;
  }
  | { readonly kind: "lost"; readonly at: string | null };

/**
 * The card is absent when the run has no preview. With one, it is "not set up"
 * when the deployment has no preview address, and otherwise exactly what the
 * server read: a stopped, ended or lost preview never looks like a live one.
 */
export function previewCardState(
  preview: RunPreviewResponse | null | undefined,
  available: boolean | undefined,
): PreviewCardState | null {
  if (preview === null || preview === undefined) return null;
  if (available === false) return { kind: "unavailable" };
  if (preview.status === "starting") return { kind: "starting" };
  if (preview.status === "ready") {
    return { kind: "running", expiresAt: preview.expiresAt };
  }
  const at = preview.stoppedAt ?? null;
  switch (preview.stopReason) {
    case "machine_lost":
      return { kind: "lost", at };
    case "time_limit":
      return { kind: "ended", reason: "time_limit", at };
    case "run_ended":
      return { kind: "ended", reason: "run_ended", at };
    case "run_cancelled":
      return {
        kind: "stopped",
        reason: "run_cancelled",
        at,
        by: null,
        byName: null,
      };
    case "replaced":
      return {
        kind: "stopped",
        reason: "replaced",
        at,
        by: null,
        byName: null,
      };
    case "person":
    default:
      // An expired preview with no recorded reason is its time limit.
      return preview.status === "expired"
        ? { kind: "ended", reason: "time_limit", at }
        : {
          kind: "stopped",
          reason: "person",
          at,
          by: preview.stoppedBy ?? null,
          byName: preview.stoppedByName ?? null,
        };
  }
}

/**
 * The head of the change's open pull request when it is not the commit a live
 * preview was built from, and null when there is nothing to say: the preview is
 * not live, the change has no open pull request, or both name the same commit.
 * Both values come from the server; the page only checks that they are equal.
 */
export function newerHeadSha(
  state: PreviewCardState | null,
  previewHeadSha: string,
  pullRequest:
    | { readonly status: string; readonly headSha: string }
    | undefined,
): string | null {
  if (state?.kind !== "running" || pullRequest?.status !== "open") return null;
  return pullRequest.headSha.toLowerCase() === previewHeadSha.toLowerCase()
    ? null
    : pullRequest.headSha;
}

/** Whole minutes until `expiresAt`, never below zero. */
export function minutesLeft(expiresAt: string, now: Date): number {
  const left = new Date(expiresAt).getTime() - now.getTime();
  return Number.isNaN(left) ? 0 : Math.max(0, Math.ceil(left / 60_000));
}

/** The first seven characters of a commit, as the card names it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** "1 hour", "30 minutes": how long a session lasts, for the opened notice. */
export function sessionLength(
  seconds: number,
): { readonly unit: "hour" | "minute"; readonly count: number } {
  return seconds % 3600 === 0 && seconds >= 3600
    ? { unit: "hour", count: seconds / 3600 }
    : { unit: "minute", count: Math.max(1, Math.round(seconds / 60)) };
}

/** True once a live preview has passed its own time limit (the page re-reads then). */
export function runningPreviewDue(
  state: PreviewCardState | null,
  now: Date,
): boolean {
  return state?.kind === "running" &&
    new Date(state.expiresAt).getTime() <= now.getTime();
}
