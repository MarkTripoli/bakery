/**
 * #46 slice C: line-count evidence, on the pure counter and the metric.
 * AC2: binary, truncated or missing line counts stay unknown, never zero;
 * excluded files are never lines. AC3: a count carries its counter version,
 * and the metric's definition is its own revision.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  classify,
  COUNTER_VERSION,
  countLines,
  type DiffFile,
  LineCategory,
  type LineCount,
} from "../../apps/server/src/modules/integrations/line-counter.ts";
import {
  aggregate,
  measurementRevision,
  MetricKey,
  metricWindow,
  placements,
  type PullRequestFact,
} from "../../apps/server/src/modules/delivery/metrics.ts";

const file = (
  filename: string,
  additions: number,
  deletions: number,
  over: Partial<DiffFile> = {},
): DiffFile => ({
  filename,
  status: "modified",
  additions,
  deletions,
  changes: additions + deletions,
  hasPatch: true,
  ...over,
});

Deno.test("classify: lock, vendored, generated and minified files are excluded; tests, docs and config have their own category", () => {
  for (
    const path of [
      "pnpm-lock.yaml",
      "apps/web/package-lock.json",
      "vendor/lib/a.go",
      "packages/contracts/generated/contracts.json",
      "web/dist/app.js",
      "static/app.min.js",
      "static/app.js.map",
      "src/__snapshots__/a.snap",
    ]
  ) assertEquals(classify(path), null, path);
  assertEquals(classify("apps/server/src/main.ts"), LineCategory.Source);
  assertEquals(classify("tests/unit/a_test.ts"), LineCategory.Test);
  assertEquals(classify("src/button.test.tsx"), LineCategory.Test);
  assertEquals(classify("pkg/a_test.go"), LineCategory.Test);
  assertEquals(classify("docs/runbooks/a.md"), LineCategory.Docs);
  assertEquals(classify("README.md"), LineCategory.Docs);
  assertEquals(classify("deno.json"), LineCategory.Config);
  assertEquals(classify(".gitignore"), LineCategory.Config);
  assertEquals(classify("Dockerfile"), LineCategory.Config);
});

Deno.test("countLines: a complete list sums counted files by category and keeps excluded files out of the lines", () => {
  const count = countLines([
    file("src/a.ts", 10, 2),
    file("src/b.ts", 5, 0),
    file("tests/a_test.ts", 20, 1),
    file("pnpm-lock.yaml", 4000, 3000),
    file("src/old.ts", 0, 0, { status: "renamed", hasPatch: false }),
  ], { expectedFiles: 5, listCut: false });
  assertEquals(count, {
    counterVersion: COUNTER_VERSION,
    coverage: "complete",
    added: 35,
    deleted: 3,
    countedFiles: 4,
    excludedFiles: 1,
    binaryFiles: 0,
    categories: [
      { category: "source", added: 15, deleted: 2, files: 3 },
      { category: "test", added: 20, deleted: 1, files: 1 },
    ],
  });
});

Deno.test("countLines: a binary file makes the count binary, and its lines are not counted as zero lines of a complete count", () => {
  const count = countLines([
    file("src/a.ts", 3, 1),
    file("assets/logo.png", 0, 0, { status: "added", hasPatch: false }),
  ], { expectedFiles: 2, listCut: false });
  assertEquals(
    [count.coverage, count.binaryFiles, count.countedFiles, count.added],
    ["binary", 1, 1, 3],
  );
});

Deno.test("countLines: a list shorter than the changed-file total, or cut at the page cap, is truncated whatever it held", () => {
  const files = [file("src/a.ts", 3, 1)];
  assertEquals(
    countLines(files, { expectedFiles: 2, listCut: false }).coverage,
    "truncated",
  );
  assertEquals(
    countLines(files, { expectedFiles: null, listCut: true }).coverage,
    "truncated",
  );
  assertEquals(
    countLines(files, { expectedFiles: null, listCut: false }).coverage,
    "complete",
  );
  // Truncation wins over a binary file: the list itself is partial.
  assertEquals(
    countLines([
      ...files,
      file("a.png", 0, 0, { status: "added", hasPatch: false }),
    ], { expectedFiles: 3, listCut: false }).coverage,
    "truncated",
  );
});

const t = (iso: string) => new Date(iso);
const june = metricWindow({
  from: "2026-06-01T00:00:00Z",
  to: "2026-07-01T00:00:00Z",
  resolution: "day",
}, t("2026-07-02T00:00:00Z"));
const counted = (coverage: LineCount["coverage"]): LineCount => ({
  counterVersion: COUNTER_VERSION,
  coverage,
  added: 30,
  deleted: 10,
  countedFiles: 2,
  excludedFiles: 1,
  binaryFiles: coverage === "binary" ? 1 : 0,
  categories: [{ category: "source", added: 30, deleted: 10, files: 2 }],
});
function merged(id: string, lineCount: LineCount | null): PullRequestFact {
  return {
    id,
    repositoryId: "r",
    taskId: "t",
    providerNumber: 1,
    url: "u",
    status: "merged",
    openedAt: t("2026-06-02T00:00:00Z"),
    mergedAt: t("2026-06-03T10:00:00Z"),
    closedAt: t("2026-06-03T10:00:00Z"),
    // Provider totals that include the lock file: never what loc counts.
    additions: 5000,
    deletions: 4000,
    lineCount,
    transitions: [],
  };
}

Deno.test("loc.changedLines counts only complete counts; no count, a binary file or a truncated list is missing with its reason", () => {
  const facts = [
    merged("a", counted("complete")),
    merged("b", counted("binary")),
    merged("c", counted("truncated")),
    merged("d", null),
  ];
  const placed = placements(MetricKey.CountedLines, facts, june);
  assertEquals(
    placed.map((p) => [p.fact?.id, p.value, p.missingReason]),
    [
      ["a", 40, null],
      ["b", null, "line_count_binary"],
      ["c", null, "line_count_truncated"],
      ["d", null, "no_line_count"],
    ],
  );
  const series = aggregate(MetricKey.CountedLines, placed, june, true);
  const day = series.points.find((p) => p.at === "2026-06-03T00:00:00.000Z")!;
  assertEquals(day.value, 40, "the known count only, not 40 + 0 + 0 + 0");
  assertEquals(series.sampleCount, 1);
  assertEquals(series.missingCount, 3);
  assertEquals(series.completeness, "partial");
  // A day whose only member is unknown is unknown, never zero.
  const onlyUnknown = aggregate(
    MetricKey.CountedLines,
    placements(MetricKey.CountedLines, [merged("d", null)], june),
    june,
    true,
  );
  assertEquals(
    onlyUnknown.points.find((p) => p.at === "2026-06-03T00:00:00.000Z"),
    {
      at: "2026-06-03T00:00:00.000Z",
      value: null,
      unknownReason: "no_known_values",
    },
  );
});

Deno.test("loc.changedLines is its own measurement, never the provider totals of prs.changedLines", () => {
  assertNotEquals(
    measurementRevision(MetricKey.CountedLines),
    measurementRevision(MetricKey.ChangedLines),
  );
  const fact = merged("a", counted("complete"));
  assertEquals(
    placements(MetricKey.ChangedLines, [fact], june)[0].value,
    9000,
  );
  assertEquals(placements(MetricKey.CountedLines, [fact], june)[0].value, 40);
});
