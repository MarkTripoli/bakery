import { assert, assertEquals } from "@std/assert";
import {
  INLINE_TOKEN,
  startsTable,
  tableCells,
} from "../../packages/ui/src/markdown-lines.ts";

Deno.test("a table starts at a header line followed by a rule", () => {
  assertEquals(startsTable(["a | b", "--- | :--:"], 0), true);
  assertEquals(startsTable(["| a |", "| - |"], 0), true);
  assertEquals(startsTable(["a | b", "c | d"], 0), false);
  assertEquals(startsTable(["a", "---"], 0), false);
  assertEquals(tableCells("| a \\| b | c |"), ["a | b", "c"]);
});

Deno.test("long hostile lines are read in time", () => {
  const started = performance.now();
  assertEquals(startsTable(["a | b", `|${" ".repeat(120_000)}x`], 0), false);
  startsTable(["a | b", `|${"- ".repeat(60_000)}x`], 0);
  startsTable(["a | b", "|".repeat(120_000)], 0);
  "[".repeat(120_000).split(INLINE_TOKEN);
  "[a](".repeat(40_000).split(INLINE_TOKEN);
  "*".repeat(120_001).split(INLINE_TOKEN);
  "`".concat("a".repeat(120_000)).split(INLINE_TOKEN);
  assert(performance.now() - started < 1_000);
});
