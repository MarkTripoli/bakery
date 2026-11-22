// What needs the person's attention in the Delivery section, as plain data. No
// React, so one unit test proves the order and the filter. The design (#57,
// redesign revision 2) lists blocking findings first, then failed checks, then
// checks that could not run or were canceled. Only results for the current
// commit are listed, and a passed check, a note, a running check or an accepted
// finding is never listed here: each is counted on the settled line instead.

import type { MessageKey } from "@bakery/i18n";
import { reasonSentence } from "./check-copy.ts";
import type { CheckRow, DeliveryModel } from "./model.ts";

/** The first line of a finding, whole, for the `why` column. */
export function findingLine(body: string): string {
  return body.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

export type AttentionItem =
  | Readonly<{
    kind: "finding";
    id: string;
    path: string;
    line: number | null;
    text: string;
  }>
  | Readonly<{
    kind: "check";
    id: string;
    name: string;
    /** A repository rule: its link opens the rules, not an output. */
    rule: boolean;
    result: "failed" | "unavailable" | "canceled";
    why: Readonly<{ key: MessageKey; values?: { code: number } }>;
    evidenceVersionId: string | null;
  }>;

const NOT_PASSED: ReadonlySet<CheckRow["result"]> = new Set([
  "failed",
  "unavailable",
  "canceled",
]);

/**
 * The sentence for a check that did not pass. A failed command always says
 * "Ended with an error." (its exit code lives in Details); one that could not
 * run falls back to a plain "Could not run." when the server gave no reason.
 */
export function whyNotPassed(
  row: Pick<CheckRow, "reason" | "exitCode" | "result">,
): { key: MessageKey; values?: { code: number } } {
  if (row.reason === "exit_nonzero") {
    return { key: "tasks.delivery.check.reason.exit_nonzero_bare" };
  }
  return reasonSentence(row) ?? { key: "tasks.delivery.check.couldNotRun" };
}

/** Every item that needs attention, in the order the list shows them. */
export function attentionItems(
  model: Pick<DeliveryModel, "checks" | "review">,
): readonly AttentionItem[] {
  const review = model.review;
  // A stale review's findings belong to an older commit; an accepted review's
  // blocking findings are accepted, so neither is a thing to attend to.
  const findings = review === null || review.olderSha !== null ||
      review.accepted !== null
    ? []
    : review.findings.filter((finding) => finding.blocking);
  const checks = model.checks.rows.filter((row) =>
    row.olderSha === null && NOT_PASSED.has(row.result)
  );
  const failed = checks.filter((row) => row.result === "failed");
  const others = checks.filter((row) => row.result !== "failed");
  return [
    ...findings.map((finding): AttentionItem => ({
      kind: "finding",
      id: finding.id,
      path: finding.path,
      line: finding.line,
      text: findingLine(finding.body),
    })),
    ...[...failed, ...others].map((row): AttentionItem => ({
      kind: "check",
      id: row.id,
      name: row.name,
      rule: row.rule,
      result: row.result as "failed" | "unavailable" | "canceled",
      why: whyNotPassed(row),
      evidenceVersionId: row.evidenceVersionId,
    })),
  ];
}
