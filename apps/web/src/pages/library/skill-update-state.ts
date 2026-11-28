import type { ApiFailure } from "../../api/client.ts";
import { asyncKindForError } from "../../app/async-state.ts";

export type TakeRefusal =
  | "moved"
  | "changed"
  | "installed"
  | "held"
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
  if (reason === "skill_update_revision_already_imported") return "held";
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

export type FileChange = Readonly<{
  path: string;
  change: "added" | "removed" | "changed";
  installedSizeBytes: number | null;
  latestSizeBytes: number | null;
  diff: string | null;
  diffOmitted: "binary" | "too_large" | "mode_only" | null;
}>;

const KINDS: readonly unknown[] = ["added", "removed", "changed"];
const OMISSIONS: readonly unknown[] = [
  "binary",
  "too_large",
  "mode_only",
  null,
];

function isFileChange(value: unknown): value is FileChange {
  if (typeof value !== "object" || value === null) return false;
  const field = (name: keyof FileChange): unknown => Reflect.get(value, name);
  const sizeOrNone = (size: unknown) =>
    size === null || typeof size === "number";
  return typeof field("path") === "string" && KINDS.includes(field("change")) &&
    sizeOrNone(field("installedSizeBytes")) &&
    sizeOrNone(field("latestSizeBytes")) &&
    (field("diff") === null || typeof field("diff") === "string") &&
    OMISSIONS.includes(field("diffOmitted"));
}

export function fileChanges(values: Iterable<unknown>): readonly FileChange[] {
  return Array.from(values).filter(isFileChange);
}

export function versionHolding<
  Version extends {
    readonly id: string;
    readonly status: string;
    readonly sourceRevision: string;
  },
>(
  versions: readonly Version[],
  revision: string,
  activeVersionId: string | null,
): Version | null {
  return versions.find((version) =>
    version.sourceRevision === revision && version.status === "published" &&
    version.id !== activeVersionId
  ) ?? null;
}

export function nextRevision(
  versions: readonly { readonly revision: number }[],
): number | null {
  return versions.length === 0
    ? null
    : Math.max(...versions.map((version) => version.revision)) + 1;
}
