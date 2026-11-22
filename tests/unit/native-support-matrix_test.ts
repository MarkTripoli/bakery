import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import {
  KNOWN_TARGETS,
  SUPPORTED_TARGETS,
} from "../../packages/worker-bootstrap/src/index.ts";

// #52 (B15.06) AC1: a worker target is advertised only when the support
// matrix records it as verified on a real host of that OS and architecture.

const Status = z.enum(["verified", "unverified", "deferred"]).describe(
  "verified: a named test ran green on real hardware of this row; unverified: built but not yet run there; deferred: needs hardware or work outside this slice, with the reason in proof.",
);
const Row = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).describe(
    "Stable kebab-case row identifier, unique in the matrix.",
  ),
  kind: z.enum(["worker-target", "capability"]).describe(
    "worker-target rows gate SUPPORTED_TARGETS; capability rows record other native or browser proof.",
  ),
  target: z.enum(KNOWN_TARGETS).optional().describe(
    "The release target this row covers; required on worker-target rows and absent on capability rows.",
  ),
  status: Status,
  evidence: z.array(
    z.string().min(1).describe("One repository-relative test file path."),
  ).describe(
    "Repository-relative test files that prove the row; a verified row names at least one.",
  ),
  proof: z.string().min(1).describe(
    "One plain sentence: what ran where, or why the proof is deferred.",
  ),
}).describe("One platform or capability and how far it is proven.");
const Matrix = z.object({
  schema: z.literal(1).describe("Format version of this file."),
  issue: z.number().int().describe("The GitHub issue that owns the matrix."),
  rule: z.string().min(1).describe("The advertising rule, in words."),
  rows: z.array(Row).min(1).describe("Every target and capability row."),
}).describe("docs/backend-delivery/native-support-matrix.json");

const matrix = Matrix.parse(
  JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../docs/backend-delivery/native-support-matrix.json",
        import.meta.url,
      ),
    ),
  ),
);

Deno.test("SUPPORTED_TARGETS is exactly the verified worker-target rows", () => {
  const verified = matrix.rows.filter((row) =>
    row.kind === "worker-target" && row.status === "verified"
  ).map((row) => row.target).sort();
  assertEquals([...SUPPORTED_TARGETS].sort(), verified);
});

Deno.test("every known target has exactly one worker-target row", () => {
  const targets = matrix.rows.filter((row) => row.kind === "worker-target")
    .map((row) => row.target);
  assertEquals([...targets].sort(), [...KNOWN_TARGETS].sort());
  for (const row of matrix.rows) {
    assertEquals(
      row.kind === "worker-target",
      row.target !== undefined,
      row.id,
    );
  }
  assertEquals(
    new Set(matrix.rows.map((row) => row.id)).size,
    matrix.rows.length,
  );
});

Deno.test("a verified row names test files that exist", async () => {
  for (const row of matrix.rows.filter((row) => row.status === "verified")) {
    assert(row.evidence.length > 0, `${row.id} has no evidence`);
    for (const path of row.evidence) {
      assert(/^tests\/[A-Za-z0-9._/-]+$/.test(path), path);
      const info = await Deno.stat(new URL(`../../${path}`, import.meta.url));
      assert(info.isFile, `${row.id}: ${path}`);
    }
  }
});
