import { assert, assertEquals } from "@std/assert";
import {
  HEADING,
  INLINE_LINK,
  INLINE_TOKEN,
  MOST_TABLE_CELLS,
  readTable,
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
  "[a](".concat("]".repeat(120_000)).split(INLINE_TOKEN);
  HEADING.exec(`#${" ".repeat(120_000)}\u2028`);
  assert(performance.now() - started < 1_000);
});

const bomb = (columns: number, rows: number) => [
  "a|".repeat(columns),
  "-|".repeat(columns),
  ...Array.from({ length: rows }, () => "|"),
];

Deno.test("a table never renders more cells than the limit", () => {
  const wide = readTable(bomb(800, 800), 0, MOST_TABLE_CELLS);
  assertEquals(wide.cells, 0);
  assertEquals(wide.overflow.length, 802);
  const tall = readTable(bomb(40, 40_000), 0, MOST_TABLE_CELLS);
  assert(tall.cells <= MOST_TABLE_CELLS);
  assertEquals(tall.rows.length, MOST_TABLE_CELLS / 40 - 1);
  assertEquals(tall.rows.length + tall.overflow.length, 40_000);
  assertEquals(tall.end, 40_002);
  const spent = readTable(bomb(40, 3), 0, 30);
  assertEquals([spent.cells, spent.overflow.length], [0, 5]);
});

Deno.test("an address with square brackets still links", () => {
  for (
    const address of [
      "https://api.test/items?page[size]=2",
      "https://example.com/?q[0]=a&r=[b]",
      "https://[::1]/path",
    ]
  ) {
    const [, token] = `see [docs](${address}) now`.split(INLINE_TOKEN);
    assertEquals(INLINE_LINK.exec(token!)?.[2], address);
  }
});
