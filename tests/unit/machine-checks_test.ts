import { assertEquals } from "@std/assert";
import {
  checkRows,
  groupCheckRows,
  type ReportedCheck,
} from "../../apps/web/src/pages/machine-checks.ts";

const at = "2026-11-27T15:30:00.000Z";
const reported = (
  checkId: string,
  result: ReportedCheck["result"],
  componentKey: string | null = null,
): ReportedCheck => ({
  checkId,
  componentKey,
  result,
  reason: "  ",
  observedAt: at,
});

Deno.test("each reported check is one row, with the agent its component names", () => {
  const rows = checkRows([
    reported("capability:model", "pass", "harness.claude"),
    reported("capability:model", "fail", "harness.codex"),
    reported("disk_threshold", "unknown"),
  ], []);
  assertEquals(rows.map((row) => [row.agent, row.result, row.reason]), [
    ["claude", "pass", null],
    ["codex", "fail", null],
    [null, "unknown", null],
  ]);
  assertEquals(new Set(rows.map((row) => row.key)).size, 3);
});

Deno.test("a failure the machine never reported is still listed, with no time", () => {
  const rows = checkRows([reported("disk_threshold", "pass")], [
    { checkId: "disk_threshold", reason: "stale copy" },
    { checkId: "spool_access", reason: "denied" },
  ]);
  assertEquals(
    rows.map((row) => [row.checkId, row.result, row.observedAt]),
    [["disk_threshold", "pass", at], ["spool_access", "fail", null]],
  );
});

Deno.test("rows are grouped as the page lists them", () => {
  const sections = groupCheckRows(checkRows([
    reported("capability:git", "pass"),
    reported("mystery", "pass"),
    reported("disk_threshold", "pass"),
  ], []));
  assertEquals(
    sections.map((section) => [
      section.group,
      section.rows.map((row) => row.checkId),
    ]),
    [
      ["machine", ["disk_threshold"]],
      ["capability", ["capability:git"]],
      ["other", ["mystery"]],
    ],
  );
});
