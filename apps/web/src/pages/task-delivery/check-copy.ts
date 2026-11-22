// The words a check row and a repair try use, as plain data. No React, so one
// unit test proves them. The sentences come from the #57 design's table: a
// result always has its reason, and one that could not run says it counts as
// not passed.

import type { MessageKey } from "@bakery/i18n";
import type { CheckReason, CheckRow } from "./model.ts";

const REASON_KEY: Readonly<
  Record<Exclude<CheckReason, "verified" | "exit_nonzero">, MessageKey>
> = {
  signal: "tasks.delivery.check.reason.signal",
  deadline: "tasks.delivery.check.reason.deadline",
  output_limit: "tasks.delivery.check.reason.output_limit",
  rule_violation: "tasks.delivery.check.reason.rule_violation",
  description_placeholder:
    "tasks.delivery.check.reason.description_placeholder",
  tool_missing: "tasks.delivery.check.reason.tool_missing",
  unsupported_checker: "tasks.delivery.check.reason.not_configured",
  rule_unbound: "tasks.delivery.check.reason.not_configured",
  rule_binding_ambiguous: "tasks.delivery.check.reason.not_configured",
  policy_missing: "tasks.delivery.check.reason.not_configured",
  revision_unavailable: "tasks.delivery.check.reason.revision_unavailable",
  metadata_missing: "tasks.delivery.check.reason.metadata_unreadable",
  metadata_too_large: "tasks.delivery.check.reason.metadata_unreadable",
  skipped: "tasks.delivery.check.reason.skipped",
  awaiting_result: "tasks.delivery.check.reason.awaiting_result",
  canceled: "tasks.delivery.check.reason.canceled",
};

/** One sentence about why a check ended as it did, else null (a pass says nothing). */
export function reasonSentence(
  reason: Exclude<CheckReason, "exit_nonzero"> | null,
): { key: MessageKey } | null {
  if (reason === null || reason === "verified") return null;
  return { key: REASON_KEY[reason] };
}

/** How long a check took as a table cell ("2 s", "2 min 14 s"), else null for a rule or no time. */
export function tookCell(
  row: Pick<CheckRow, "rule" | "durationMs">,
):
  | { key: "tasks.delivery.details.tookInstant" }
  | { key: "tasks.delivery.details.tookSeconds"; values: { seconds: number } }
  | {
    key: "tasks.delivery.details.tookMinutes";
    values: { minutes: number; seconds: number };
  }
  | null {
  if (row.rule || row.durationMs === null || row.durationMs < 0) return null;
  const whole = Math.round(row.durationMs / 1000);
  if (row.durationMs < 1000) {
    return { key: "tasks.delivery.details.tookInstant" };
  }
  if (whole < 60) {
    return {
      key: "tasks.delivery.details.tookSeconds",
      values: { seconds: whole },
    };
  }
  return {
    key: "tasks.delivery.details.tookMinutes",
    values: { minutes: Math.floor(whole / 60), seconds: whole % 60 },
  };
}

const ORDER: Readonly<Record<CheckRow["result"], number>> = {
  failed: 0,
  unavailable: 0,
  canceled: 0,
  pending: 1,
  passed: 2,
};

/** Not passed first, then running, then passed; the server's order within each. */
export function orderChecks(rows: readonly CheckRow[]): CheckRow[] {
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) =>
      ORDER[a.row.result] - ORDER[b.row.result] || a.index - b.index
    )
    .map(({ row }) => row);
}

/** The first three names, and how many more there are. */
export function nameList(
  names: readonly string[],
): { shown: readonly string[]; more: number } {
  return { shown: names.slice(0, 3), more: Math.max(0, names.length - 3) };
}

/** The key for a try's sentence, by what it was asked to fix. */
export function tryKey(
  fixed: Readonly<{ checks: number; blocking: number }>,
):
  | "tasks.delivery.fixing.tried.both"
  | "tasks.delivery.fixing.tried.checks"
  | "tasks.delivery.fixing.tried.findings"
  | "tasks.delivery.fixing.tried.nothing" {
  if (fixed.checks > 0 && fixed.blocking > 0) {
    return "tasks.delivery.fixing.tried.both";
  }
  if (fixed.checks > 0) return "tasks.delivery.fixing.tried.checks";
  if (fixed.blocking > 0) return "tasks.delivery.fixing.tried.findings";
  return "tasks.delivery.fixing.tried.nothing";
}

/** The loop's time bound in whole minutes, else null when the server did not say. */
export const limitMinutes = (durationMs: number | null): number | null =>
  durationMs === null || durationMs <= 0
    ? null
    : Math.max(1, Math.round(durationMs / 60000));
