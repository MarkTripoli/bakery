/**
 * The rules of a restore drill report (issue #64 slice D, also #49), as pure
 * functions so they can be tested without a database.
 *
 * A drill restores a backup set into an isolated, throwaway database and checks
 * it there. The runner reports what it found. The server cannot see the drill,
 * so the one thing it can do is refuse a report that contradicts itself: a pass
 * that skipped a check, a failure with no cause, a backup age with no cutoff.
 * Without that, "passed" would only mean "the runner said so".
 */

/** Every check a drill runs, in the order it runs them. */
export const DRILL_CHECKS = [
  "manifest",
  "checksums",
  "key",
  "postgres",
  "redis",
  "files",
  "references",
  "migrations",
  "cutoff",
] as const;

export type DrillCheck = (typeof DRILL_CHECKS)[number];

/** A drill can only pass when every one of these passed. */
export const REQUIRED_DRILL_CHECKS: readonly DrillCheck[] = DRILL_CHECKS;

export const DRILL_FAILURE_CODES = [
  "set_incomplete",
  "key_mismatch",
  "migration_unsupported",
  "cutoff_mismatch",
  "restore_failed",
  "references_missing",
  "drill_error",
] as const;

export type DrillFailureCode = (typeof DRILL_FAILURE_CODES)[number];

/** What a report says, as far as these rules care. */
export type DrillReportShape = {
  readonly outcome: "passed" | "failed";
  readonly failureCode?: string | null;
  readonly detail?: string | null;
  readonly cutoffAt?: string | null;
  readonly rpoSeconds?: number | null;
  readonly checksPassed: readonly string[];
  readonly checksFailed: readonly string[];
};

/** One way a report contradicts itself: the field it is about and a stable reason. */
export type DrillProblem = { readonly field: string; readonly reason: string };

const KNOWN = new Set<string>(DRILL_CHECKS);

/** Every contradiction in a report, in a stable order; empty when it is coherent. */
export function drillProblems(report: DrillReportShape): DrillProblem[] {
  const problems: DrillProblem[] = [];
  const seen = new Set<string>();
  const passed = new Set(report.checksPassed);
  for (
    const [field, names] of [
      ["checksPassed", report.checksPassed],
      ["checksFailed", report.checksFailed],
    ] as const
  ) {
    for (const name of names) {
      if (!KNOWN.has(name)) {
        problems.push({ field, reason: "unknown_check" });
      } else if (seen.has(name)) {
        problems.push({
          field,
          reason: passed.has(name) && field === "checksFailed"
            ? "check_in_both_lists"
            : "duplicate_check",
        });
      }
      seen.add(name);
    }
  }
  if (report.outcome === "passed") {
    if (report.failureCode != null) {
      problems.push({
        field: "failureCode",
        reason: "passed_has_failure_code",
      });
    }
    if (report.detail != null) {
      problems.push({ field: "detail", reason: "passed_has_detail" });
    }
    if (report.checksFailed.length > 0) {
      problems.push({
        field: "checksFailed",
        reason: "passed_has_failed_check",
      });
    }
    for (const required of REQUIRED_DRILL_CHECKS) {
      if (!passed.has(required)) {
        problems.push({
          field: "checksPassed",
          reason: `passed_missing_check:${required}`,
        });
      }
    }
  } else {
    if (report.failureCode == null) {
      problems.push({ field: "failureCode", reason: "failed_without_code" });
    }
    if (report.detail == null || report.detail.trim() === "") {
      problems.push({ field: "detail", reason: "failed_without_detail" });
    }
    if (report.checksFailed.length === 0) {
      problems.push({
        field: "checksFailed",
        reason: "failed_without_failed_check",
      });
    }
  }
  if (report.cutoffAt == null && report.rpoSeconds != null) {
    problems.push({ field: "rpoSeconds", reason: "rpo_without_cutoff" });
  }
  if (report.cutoffAt != null && report.rpoSeconds == null) {
    problems.push({ field: "rpoSeconds", reason: "cutoff_without_rpo" });
  }
  return problems;
}
