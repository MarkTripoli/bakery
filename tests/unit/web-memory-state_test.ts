import { assertEquals } from "@std/assert";
import {
  confidenceBand,
  correctionCount,
  correctionMissing,
  memoryActions,
  memoryBadge,
  memoryRefusal,
  orderMemories,
  sourceLine,
} from "../../apps/web/src/pages/library/memory-state.ts";

// #72. The Memory tab's rules: one badge per fact, words for confidence, and
// a source line that never names a document the server did not name.

Deno.test("a suggested fact is Suggested and a retired one is No longer used", () => {
  assertEquals(
    memoryBadge({ status: "proposed", sourceState: "available" }),
    "suggested",
  );
  assertEquals(
    memoryBadge({ status: "retired", sourceState: "deleted" }),
    "noLongerUsed",
  );
});

Deno.test("a fact in use whose source was deleted is Source missing; no access or unknown is not", () => {
  assertEquals(
    memoryBadge({ status: "active", sourceState: "available" }),
    "inUse",
  );
  assertEquals(
    memoryBadge({ status: "active", sourceState: "deleted" }),
    "sourceMissing",
  );
  assertEquals(
    memoryBadge({ status: "active", sourceState: "no_access" }),
    "inUse",
  );
  assertEquals(
    memoryBadge({ status: "active", sourceState: "unknown" }),
    "inUse",
  );
});

Deno.test("facts no longer used sort last and everything else keeps the server's order", () => {
  const rows = [
    { id: "a", status: "retired" },
    { id: "b", status: "active" },
    { id: "c", status: "proposed" },
    { id: "d", status: "retired" },
    { id: "e", status: "active" },
  ] as const;
  assertEquals(orderMemories(rows).map((row) => row.id), [
    "b",
    "c",
    "e",
    "a",
    "d",
  ]);
});

Deno.test("confidence is High from 0.8, Medium from 0.5, Low below, from the exact decimal string", () => {
  assertEquals(confidenceBand("0.800000"), "high");
  assertEquals(confidenceBand("0.9"), "high");
  assertEquals(confidenceBand("0.799999"), "medium");
  assertEquals(confidenceBand("0.5"), "medium");
  assertEquals(confidenceBand("0.499999"), "low");
  assertEquals(confidenceBand("0"), "low");
});

const revision = (
  sourceName: string | null,
  sourceRevision: number | null,
  number = 1,
) => ({ revision: number, sourceName, sourceRevision }) as never;

Deno.test("an available source is named only when the server named it", () => {
  assertEquals(
    sourceLine({
      sourceState: "available",
      currentRevision: revision("Runbook", 3),
    }),
    { kind: "available", name: "Runbook", revision: 3 },
  );
  assertEquals(
    sourceLine({
      sourceState: "available",
      currentRevision: revision(null, null),
    }),
    { kind: "unknown" },
  );
  assertEquals(
    sourceLine({ sourceState: "available", currentRevision: null }),
    { kind: "unknown" },
  );
});

Deno.test("deleted, no access and unknown sources say so, never a name", () => {
  // The server may still name a deleted document; the line says it is gone.
  assertEquals(
    sourceLine({
      sourceState: "deleted",
      currentRevision: revision("Runbook", 3),
    }),
    { kind: "deleted" },
  );
  assertEquals(
    sourceLine({
      sourceState: "no_access",
      currentRevision: revision(null, null),
    }),
    { kind: "noAccess" },
  );
  assertEquals(
    sourceLine({ sourceState: "unknown", currentRevision: null }),
    { kind: "unknown" },
  );
});

Deno.test("corrections are every revision after the first", () => {
  assertEquals(correctionCount({ currentRevision: revision("x", 1, 1) }), 0);
  assertEquals(correctionCount({ currentRevision: revision("x", 1, 3) }), 2);
  assertEquals(correctionCount({ currentRevision: null }), 0);
});

Deno.test("each status offers its own changes, and a retired fact cannot be corrected", () => {
  assertEquals(memoryActions({ status: "proposed" }), {
    approve: true,
    correctThenApprove: true,
    correct: false,
    dontUse: true,
    stopUsing: false,
    useAgain: false,
  });
  assertEquals(memoryActions({ status: "active" }), {
    approve: false,
    correctThenApprove: false,
    correct: true,
    dontUse: false,
    stopUsing: true,
    useAgain: false,
  });
  assertEquals(memoryActions({ status: "retired" }), {
    approve: false,
    correctThenApprove: false,
    correct: false,
    dontUse: false,
    stopUsing: false,
    useAgain: true,
  });
});

const problem = (status: number, reason?: string) => ({
  kind: "problem" as const,
  problem: {
    status,
    code: status === 412 ? "PRECONDITION_FAILED" : "STATE_CONFLICT",
    ...(reason === undefined ? {} : { reason }),
  },
});

Deno.test("a refusal is read by its rule slug, not its text", () => {
  const cases: [string, string][] = [
    ["memory_version_stale", "stale"],
    ["memory_not_found", "notFound"],
    ["memory_retired", "retired"],
    ["conflict_detected", "conflict"],
    ["conflict_unscanned", "unscanned"],
    ["evidence_weak", "weak"],
    ["repository_out_of_scope", "scope"],
    ["source_artifact_unknown", "source"],
  ];
  for (const [reason, expected] of cases) {
    assertEquals(memoryRefusal(problem(409, reason)), expected);
  }
});

Deno.test("an unknown 409 or 412 still means someone else changed the fact; anything else is other", () => {
  assertEquals(memoryRefusal(problem(409, "something_new")), "stale");
  assertEquals(memoryRefusal(problem(412)), "stale");
  assertEquals(memoryRefusal(problem(500)), "other");
  assertEquals(memoryRefusal(problem(403)), "forbidden");
  assertEquals(memoryRefusal({ kind: "network" }), "offline");
  assertEquals(
    memoryRefusal({ kind: "invalid-response", status: 200 }),
    "other",
  );
  assertEquals(memoryRefusal(null), "other");
});

Deno.test("a correction needs a wording, a reason and a source, and blanks do not count", () => {
  assertEquals(
    correctionMissing({
      content: "  ",
      reason: "",
      sourceArtifactVersionId: "",
    }),
    { content: true, reason: true, source: true },
  );
  assertEquals(
    correctionMissing({
      content: "Use pnpm.",
      reason: "The runbook changed.",
      sourceArtifactVersionId: "00000000-0000-4000-8000-000000000001",
    }),
    { content: false, reason: false, source: false },
  );
});
