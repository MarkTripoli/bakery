import { assertEquals } from "@std/assert";
import {
  DRILL_CHECKS,
  DRILL_FAILURE_CODES,
  drillProblems,
  type DrillReportShape,
  REQUIRED_DRILL_CHECKS,
} from "../../apps/server/src/modules/backups/drill-rules.ts";

/**
 * #64 slice D: the rules a restore drill report must satisfy before the server
 * keeps it. The server cannot see the drill, so these rules are the only thing
 * that stops "passed" from meaning "the runner said so".
 */

const passing = (
  overrides: Partial<DrillReportShape> = {},
): DrillReportShape => ({
  outcome: "passed",
  failureCode: null,
  detail: null,
  cutoffAt: "2026-11-21T03:00:05.000Z",
  rpoSeconds: 3595,
  checksPassed: [...DRILL_CHECKS],
  checksFailed: [],
  ...overrides,
});

const failing = (
  overrides: Partial<DrillReportShape> = {},
): DrillReportShape => ({
  outcome: "failed",
  failureCode: "restore_failed",
  detail: "The database restore stopped; check the host's disk space.",
  cutoffAt: null,
  rpoSeconds: null,
  checksPassed: ["manifest"],
  checksFailed: ["postgres"],
  ...overrides,
});

const reasons = (report: DrillReportShape) =>
  drillProblems(report).map((problem) => problem.reason);

Deno.test("the nine checks and the seven failure codes are fixed, and a pass needs every check", () => {
  assertEquals([...DRILL_CHECKS], [
    "manifest",
    "checksums",
    "key",
    "postgres",
    "redis",
    "files",
    "references",
    "migrations",
    "cutoff",
  ]);
  assertEquals(DRILL_FAILURE_CODES.length, 7);
  assertEquals([...REQUIRED_DRILL_CHECKS], [...DRILL_CHECKS]);
});

Deno.test("a coherent pass and a coherent failure have no problems", () => {
  assertEquals(drillProblems(passing()), []);
  assertEquals(drillProblems(failing()), []);
  // A set with no cutoff has no age, and may still fail.
  assertEquals(
    drillProblems(failing({ cutoffAt: null, rpoSeconds: null })),
    [],
  );
});

Deno.test("a pass that skipped any single required check is refused, naming it", () => {
  for (const skipped of DRILL_CHECKS) {
    assertEquals(
      reasons(
        passing({
          checksPassed: DRILL_CHECKS.filter((name) => name !== skipped),
        }),
      ),
      [`passed_missing_check:${skipped}`],
      skipped,
    );
  }
});

Deno.test("a pass may not carry a failure code, a detail or a failed check", () => {
  assertEquals(reasons(passing({ failureCode: "restore_failed" })), [
    "passed_has_failure_code",
  ]);
  assertEquals(reasons(passing({ detail: "fine" })), ["passed_has_detail"]);
  // Redis moved to the failed list, so the pass is also short of that check:
  // both contradictions are named, and nothing else.
  assertEquals(
    reasons(
      passing({
        checksPassed: DRILL_CHECKS.filter((name) => name !== "redis"),
        checksFailed: ["redis"],
      }),
    ),
    ["passed_has_failed_check", "passed_missing_check:redis"],
  );
  // Listing a passed check as failed too is its own contradiction.
  assertEquals(reasons(passing({ checksFailed: ["redis"] })), [
    "check_in_both_lists",
    "passed_has_failed_check",
  ]);
});

Deno.test("a failure needs a code, a non-blank detail and a failed check", () => {
  assertEquals(reasons(failing({ failureCode: null })), [
    "failed_without_code",
  ]);
  assertEquals(reasons(failing({ detail: null })), ["failed_without_detail"]);
  assertEquals(reasons(failing({ detail: "   " })), ["failed_without_detail"]);
  assertEquals(reasons(failing({ checksFailed: [] })), [
    "failed_without_failed_check",
  ]);
});

Deno.test("a check name must be known, appear once and sit in only one list", () => {
  assertEquals(
    reasons(failing({ checksFailed: ["postgres", "bogus"] })),
    ["unknown_check"],
  );
  assertEquals(
    reasons(failing({ checksFailed: ["postgres", "postgres"] })),
    ["duplicate_check"],
  );
  assertEquals(
    reasons(failing({ checksPassed: ["manifest", "postgres"] })),
    ["check_in_both_lists"],
  );
});

Deno.test("the backup age is present exactly when the cutoff is", () => {
  assertEquals(reasons(passing({ cutoffAt: null })), ["rpo_without_cutoff"]);
  assertEquals(reasons(passing({ rpoSeconds: null })), ["cutoff_without_rpo"]);
  assertEquals(
    reasons(passing({ cutoffAt: undefined, rpoSeconds: undefined })),
    [],
  );
});
