import { assertEquals } from "@std/assert";
import {
  attentionItems,
  findingLine,
  whyNotPassed,
} from "../../apps/web/src/pages/task-delivery/attention.ts";
import type {
  CheckRow,
  DeliveryModel,
  FindingRow,
} from "../../apps/web/src/pages/task-delivery/model.ts";

const check = (over: Partial<CheckRow>): CheckRow => ({
  id: "c",
  name: "lint",
  result: "passed",
  reason: "verified",
  rule: false,
  evidenceVersionId: null,
  exitCode: 0,
  durationMs: 1000,
  olderSha: null,
  ...over,
});
const finding = (over: Partial<FindingRow>): FindingRow => ({
  id: "f",
  severity: "blocker",
  blocking: true,
  path: "src/a.ts",
  line: 3,
  body: "First line.\nMore detail.",
  ...over,
});
const model = (
  rows: CheckRow[],
  findings: FindingRow[],
  review: Partial<NonNullable<DeliveryModel["review"]>> = {},
): Pick<DeliveryModel, "checks" | "review"> => ({
  checks: {
    rows,
    total: rows.length,
    passed: 0,
    failed: 0,
    running: 0,
    unavailable: 0,
    canceled: 0,
  },
  review: {
    status: "changesRequested",
    olderSha: null,
    blocking: findings.length,
    others: 0,
    findings,
    accepted: null,
    ...review,
  },
});

Deno.test("findings come first, then failed checks, then checks that could not run or were canceled", () => {
  const items = attentionItems(model(
    [
      check({
        id: "u",
        name: "tool",
        result: "unavailable",
        reason: "tool_missing",
      }),
      check({ id: "p", name: "ok", result: "passed" }),
      check({
        id: "x",
        name: "tests",
        result: "failed",
        reason: "exit_nonzero",
        exitCode: 2,
      }),
      check({ id: "k", name: "build", result: "canceled", reason: "canceled" }),
      check({ id: "r", name: "running", result: "pending", reason: null }),
    ],
    [
      finding({ id: "f1" }),
      finding({ id: "n", blocking: false, severity: "note" }),
    ],
  ));
  assertEquals(items.map((item) => [item.kind, item.id]), [
    ["finding", "f1"],
    ["check", "x"],
    ["check", "u"],
    ["check", "k"],
  ]);
});

Deno.test("passed, running, older-commit results and non-blocking notes are never listed", () => {
  const items = attentionItems(model(
    [
      check({ id: "a", result: "passed" }),
      check({ id: "b", result: "pending", reason: null }),
      check({
        id: "c",
        result: "failed",
        reason: "exit_nonzero",
        olderSha: "abc1234",
      }),
    ],
    [finding({ id: "n", blocking: false, severity: "minor" })],
  ));
  assertEquals(items, []);
});

Deno.test("a stale or accepted review lists none of its findings", () => {
  const stale = attentionItems(
    model([], [finding({})], { olderSha: "abc1234" }),
  );
  assertEquals(stale, []);
  const accepted = attentionItems(model([], [finding({})], {
    accepted: { at: "2026-01-01T00:00:00.000Z", reason: "ok", by: "Ana" },
  }));
  assertEquals(accepted, []);
});

Deno.test("a failed command says it ended with an error, never its exit code; could-not-run falls back", () => {
  assertEquals(
    whyNotPassed({ reason: "exit_nonzero", exitCode: 7, result: "failed" }).key,
    "tasks.delivery.check.reason.exit_nonzero_bare",
  );
  assertEquals(
    whyNotPassed({ reason: null, exitCode: null, result: "unavailable" }).key,
    "tasks.delivery.check.couldNotRun",
  );
  assertEquals(
    whyNotPassed({
      reason: "tool_missing",
      exitCode: null,
      result: "unavailable",
    }).key,
    "tasks.delivery.check.reason.tool_missing",
  );
});

Deno.test("a finding's line is its first non-empty line, whole", () => {
  assertEquals(
    findingLine("\n  Refund amount is not validated.\nMore."),
    "Refund amount is not validated.",
  );
  assertEquals(findingLine(""), "");
});
