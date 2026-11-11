import { assertEquals, assertMatch } from "@std/assert";
import {
  evaluateArtifacts,
  type LanePolicy,
} from "../../scripts/ci/evaluate.ts";
import {
  digestArtifacts,
  evidenceInputFrom,
} from "../../scripts/ci/write-evidence.ts";

const candidateSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const workflowSha = "c".repeat(40);
const runId = "123456789";
const runAttempt = "2";

Deno.test("evidence CLI mapping requires and preserves run identity", () => {
  const environment = {
    JOB_STATUS: "success",
    CANDIDATE_SHA: candidateSha,
    BASE_SHA: baseSha,
    WORKFLOW_SHA: workflowSha,
    RUN_ID: runId,
    RUN_ATTEMPT: runAttempt,
  };

  assertEquals(
    evidenceInputFrom(["native", "deno test", "native tests"], environment),
    {
      lane: "native",
      command: "deno test",
      testCases: "native tests",
      status: "success",
      candidate: candidateSha,
      base: baseSha,
      workflow: workflowSha,
      runId,
      runAttempt,
      artifacts: "none",
    },
  );
  assertEquals(
    evidenceInputFrom(
      ["native", "deno test", "native tests"],
      { ...environment, RUN_ATTEMPT: undefined },
    ),
    null,
  );
});

Deno.test("evidenceInputFrom keeps the declared artifact paths", () => {
  const environment = {
    JOB_STATUS: "success",
    CANDIDATE_SHA: candidateSha,
    BASE_SHA: baseSha,
    WORKFLOW_SHA: workflowSha,
    RUN_ID: runId,
    RUN_ATTEMPT: runAttempt,
  };
  const paths = "artifacts/a.json,artifacts/b.json";
  const input = evidenceInputFrom(
    ["ui_paper", "pnpm compare:paper", "paper parity", paths],
    environment,
  );
  assertEquals(input?.artifacts, paths);
});

Deno.test("digestArtifacts hashes a real file and flags an absent one", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const filePath = `${directory}/artifact.json`;
    await Deno.writeTextFile(filePath, '{"ok":true}');
    const declaration = await digestArtifacts([
      filePath,
      `${directory}/missing.json`,
    ]);
    const [present, absent] = declaration.split(",");
    assertMatch(present, new RegExp(`^${filePath}:[0-9a-f]{64}$`));
    assertEquals(absent, `${directory}/missing.json:missing`);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("digestArtifacts hands off each present artifact under the handoff directory", async () => {
  const handoff = await Deno.makeTempDir();
  try {
    const path = "scripts/ci/required-checks.json";
    const declaration = await digestArtifacts(
      [path, "scripts/ci/absent.json"],
      handoff,
    );
    const copy = await Deno.readFile(`${handoff}/${path}`);
    assertEquals(copy, await Deno.readFile(path));
    const digest = await crypto.subtle.digest("SHA-256", copy);
    const hex = Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    assertEquals(
      declaration,
      `${path}:${hex},scripts/ci/absent.json:missing`,
    );
    assertEquals(
      await Deno.stat(`${handoff}/scripts/ci/absent.json`).catch(() => null),
      null,
    );
  } finally {
    await Deno.remove(handoff, { recursive: true });
  }
});

// The writer's declaration for the auth plus enterprise artifact set must be
// exactly what the trusted evaluator accepts when the policy lists all four.
Deno.test("digestArtifacts declaration for the auth and enterprise set round-trips through evaluateArtifacts", async () => {
  const work = await Deno.makeTempDir();
  const previous = Deno.cwd();
  try {
    const documents: Record<string, unknown> = {
      "artifacts/ui-baseline/runtime/manifest.json": {
        schemaVersion: 2,
        cases: [{ status: "passed" }],
        coverage: { failed: 0, blocked: 0, missing: [] },
      },
      "artifacts/ui-baseline/paper/comparison.json": {
        schemaVersion: 2,
        threshold: 0.95,
        status: "passed",
        results: [{ baselineId: "a", status: "passed" }],
        coverage: { expected: 1, failed: 0, blocked: 0, missing: [] },
      },
      "artifacts/ui-baseline/enterprise/runtime/manifest.json": {
        schemaVersion: 2,
        cases: [],
        coverage: { failed: 0, blocked: 0, missing: [] },
      },
      "artifacts/ui-baseline/enterprise/paper/comparison.json": {
        schemaVersion: 2,
        threshold: 0.95,
        status: "passed",
        results: [{ baselineId: "q", status: "planned" }],
        coverage: { expected: 1, failed: 0, blocked: 0, missing: [] },
      },
    };
    Deno.chdir(work);
    for (const [path, document] of Object.entries(documents)) {
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(path, JSON.stringify(document));
    }
    const declaration = await digestArtifacts(
      Object.keys(documents),
      `${work}/handoff`,
    );
    await Deno.mkdir(`${work}/evidence`);
    await Deno.writeTextFile(
      `${work}/evidence/ui_paper.txt`,
      `artifacts=${declaration}\n`,
    );
    const lane: LanePolicy = {
      lane: "ui_paper",
      job: "ui / paper parity",
      artifacts: [
        {
          path: "artifacts/ui-baseline/runtime/manifest.json",
          verify: "runtime-manifest",
        },
        {
          path: "artifacts/ui-baseline/paper/comparison.json",
          verify: "paper-comparison",
        },
        {
          path: "artifacts/ui-baseline/enterprise/runtime/manifest.json",
          verify: "enterprise-runtime-manifest",
        },
        {
          path: "artifacts/ui-baseline/enterprise/paper/comparison.json",
          verify: "enterprise-paper-comparison",
        },
      ],
    };
    const ledger = {
      entries: [{ status: "planned", manifest: "enterprise", cases: ["q"] }],
    };
    assertEquals(
      await evaluateArtifacts(
        `${work}/evidence`,
        `${work}/handoff`,
        [lane],
        () => Promise.resolve(ledger),
      ),
      [],
    );
  } finally {
    Deno.chdir(previous);
    await Deno.remove(work, { recursive: true });
  }
});
