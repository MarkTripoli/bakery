import type { ApiFailure } from "../../api/client.ts";
import { asyncKindForError } from "../../app/async-state.ts";

export type TakeRefusal =
  | "moved"
  | "changed"
  | "installed"
  | "unavailable"
  | "forbidden"
  | "offline"
  | "failed";

export function takeRefusal(error: ApiFailure): TakeRefusal {
  if (asyncKindForError(error) === "offline") return "offline";
  if (error.kind !== "problem") return "failed";
  const { status, reason } = error.problem;
  if (reason === "skill_update_revision_not_latest") return "moved";
  if (reason === "skill_changed_during_source_check" || status === 412) {
    return "changed";
  }
  if (reason === "skill_update_already_installed") return "installed";
  if (status === 403) return "forbidden";
  if (status === 503) return "unavailable";
  return "failed";
}

const COMMIT_OR_DIGEST = /^(sha256:)?[0-9a-f]{32,}$/i;

export function shortRevision(revision: string): string {
  return COMMIT_OR_DIGEST.test(revision)
    ? revision.replace(/^sha256:/, "").slice(0, 7)
    : revision;
}

export function nextRevision(
  versions: readonly { readonly revision: number }[],
): number | null {
  return versions.length === 0
    ? null
    : Math.max(...versions.map((version) => version.revision)) + 1;
}
