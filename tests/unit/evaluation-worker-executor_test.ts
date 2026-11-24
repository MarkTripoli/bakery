import { assertEquals } from "@std/assert";
import { createEvaluationExecutor } from "../../apps/worker/src/evaluation-executor.ts";
import { JUDGE_PROVIDER_NOT_CONFIGURED } from "../../apps/worker/src/bounded-judge.ts";
import type { ReadAttemptContext } from "../../apps/worker/src/harness-context.ts";
import type { WorkerContextInput } from "../../apps/worker/src/client.ts";
import type { WorkerExecutor } from "../../apps/worker/src/executor.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";

// #44 slice 2: the worker scores the pinned output bytes it is served through
// the attempt-context route, and nothing else.

const VERSION = "00000000-0000-4000-8000-0000000000b1";
const RESULT = "00000000-0000-4000-8000-0000000000c1";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pinned(
  text: string,
  digest?: string,
): Promise<WorkerContextInput> {
  const bytes = new TextEncoder().encode(text);
  return {
    artifactVersionId: VERSION,
    artifactId: VERSION,
    digest: digest ?? await sha256Hex(bytes),
    sizeBytes: bytes.length,
    mediaType: "application/json",
    contentBase64: btoa(text),
  };
}

const inner: WorkerExecutor = {
  supportedActions: ["task.brief"],
  execute: () => Promise.reject(new Error("inner must not run")),
};

function assignment(action: string, input: unknown): JobAssignment {
  return {
    action,
    input,
    attemptId: "00000000-0000-4000-8000-0000000000d1",
    leaseToken: "x".repeat(43),
    fence: "1",
    workerSessionId: "00000000-0000-4000-8000-0000000000d2",
    workerSessionGeneration: "1",
    skillRefs: [],
  } as unknown as JobAssignment;
}

const checkInput = {
  evaluationResultId: RESULT,
  outputArtifactVersionId: VERSION,
  check: { kind: "contains", config: { substring: "done" } },
};

Deno.test("the executor advertises both evaluation actions beside the inner ones", () => {
  const executor = createEvaluationExecutor(inner, {});
  assertEquals(executor.supportedActions, [
    "task.brief",
    "evaluation.check",
    "evaluation.score",
  ]);
});

Deno.test("evaluation.check scores the pinned output bytes", async () => {
  const served = [await pinned("all done")];
  const executor = createEvaluationExecutor(inner, {
    readAttemptContext: () => Promise.resolve({ inputs: served, facts: null }),
  });
  const outcome = await executor.execute(
    assignment("evaluation.check", checkInput),
    new AbortController().signal,
  );
  assertEquals(outcome, {
    status: "completed",
    result: { state: "passed", score: 1, reason: null },
  });
});

Deno.test("an unpinned version, a digest mismatch or a reader crash is an error, not a verdict", async () => {
  const cases: Array<() => ReturnType<ReadAttemptContext>> = [
    () => Promise.resolve({ inputs: [], facts: null }),
    async () => ({
      inputs: [await pinned("all done", "0".repeat(64))],
      facts: null,
    }),
    () => Promise.reject(new Error("route down")),
  ];
  for (const read of cases) {
    const outcome = await createEvaluationExecutor(inner, {
      readAttemptContext: read,
    }).execute(
      assignment("evaluation.check", checkInput),
      new AbortController().signal,
    );
    assertEquals(outcome.status, "completed");
    const result = (outcome as { result: Record<string, unknown> }).result;
    assertEquals(result.state, "error");
    assertEquals(result.score, null);
  }
});

Deno.test("evaluation.score answers unscored when no judge provider is configured", async () => {
  const served = [await pinned("all done")];
  const outcome = await createEvaluationExecutor(inner, {
    readAttemptContext: () => Promise.resolve({ inputs: served, facts: null }),
  }).execute(
    assignment("evaluation.score", {
      evaluationResultId: RESULT,
      outputArtifactVersionId: VERSION,
      rubric: "Is it correct?",
      outputSchema: { type: "object" },
    }),
    new AbortController().signal,
  );
  assertEquals(outcome, {
    status: "completed",
    result: {
      state: "unscored",
      score: null,
      reason: JUDGE_PROVIDER_NOT_CONFIGURED,
      judgeOutput: null,
    },
  });
});
