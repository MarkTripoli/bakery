import { assert, assertEquals } from "@std/assert";
import {
  JUDGE_PROVIDER_NOT_CONFIGURED,
  type JudgeCall,
  type JudgeTransport,
  type JudgeTransportResult,
} from "../../apps/worker/src/bounded-judge.ts";
import type { WorkerContextInput } from "../../apps/worker/src/client.ts";
import { createEvaluationExecutor } from "../../apps/worker/src/evaluation-executor.ts";
import type {
  ExecutionOutcome,
  WorkerExecutor,
} from "../../apps/worker/src/executor.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import { normalizeEvaluationOutcome } from "../../apps/server/src/modules/evaluations/finalize-attempt.ts";
import {
  contractSchemas,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";

// #44: evaluation.score makes one bounded judge call over the pinned output
// bytes, through a transport; these tests use a fake transport.

const VERSION = "00000000-0000-4000-8000-0000000000b1";
const RESULT = "00000000-0000-4000-8000-0000000000c1";
const ATTEMPT = "00000000-0000-4000-8000-0000000000d1";
const RESERVATION = "00000000-0000-4000-8000-0000000000e1";
const SESSION = "00000000-0000-4000-8000-0000000000f1";
const OUTPUT = "The answer is 42.";
const OUTPUT_SCHEMA = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string" } },
};
const scoreInput = {
  evaluationResultId: RESULT,
  outputArtifactVersionId: VERSION,
  rubric: "Is the answer correct?",
  outputSchema: OUTPUT_SCHEMA,
};
const billing = {
  provider: "anthropic",
  billingAccountId: "acct-1",
  model: "claude-sonnet",
  billingRoute: "api" as const,
  maxTokens: 1000,
  maxUsdReservation: 1,
  pricingMetadataSnapshot: "pricing-v1",
};

async function pinned(text: string): Promise<WorkerContextInput> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer),
  );
  return {
    artifactVersionId: VERSION,
    artifactId: VERSION,
    digest: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
    sizeBytes: bytes.length,
    mediaType: "text/plain",
    contentBase64: btoa(text),
  };
}

const inner: WorkerExecutor = {
  supportedActions: [],
  execute: () => Promise.reject(new Error("inner must not run")),
};

function assignment(withBilling = true): JobAssignment {
  return {
    action: "evaluation.score",
    input: scoreInput,
    attemptId: ATTEMPT,
    skillRefs: [],
    billing: withBilling ? billing : null,
    installationReservationId: withBilling ? RESERVATION : null,
  } as unknown as JobAssignment;
}

const usage = {
  providerCallId: SESSION,
  inputTokens: 120,
  outputTokens: 30,
  costUsd: 0.0012345,
};

function fake(
  result: JudgeTransportResult,
): { transport: JudgeTransport; calls: JudgeCall[] } {
  const calls: JudgeCall[] = [];
  return {
    calls,
    transport: (call) => {
      calls.push(call);
      return Promise.resolve(result);
    },
  };
}

async function score(
  transport: JudgeTransport | undefined,
  withBilling = true,
): Promise<ExecutionOutcome> {
  const served = [await pinned(OUTPUT)];
  return await createEvaluationExecutor(inner, {
    readAttemptContext: () => Promise.resolve(served),
    judge: {
      transport,
      timeLimitMs: 5_000,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    },
  }).execute(assignment(withBilling), new AbortController().signal);
}

function resultOf(outcome: ExecutionOutcome): Record<string, unknown> {
  assertEquals(outcome.status, "completed");
  const result = (outcome as { result: Record<string, unknown> }).result;
  // Every report must satisfy the action's output contract.
  assert(
    workerActionOutputSchema("evaluation.score").safeParse(result).success,
  );
  return result;
}

Deno.test("a schema-valid judge answer is a score, and the server records it as measured", async () => {
  const { transport, calls } = fake({
    kind: "answered",
    answer: {
      score: 0.9,
      passed: true,
      reason: null,
      answer: { verdict: "correct" },
    },
    usage,
  });
  const outcome = await score(transport);
  const result = resultOf(outcome);
  assertEquals(result, {
    state: "passed",
    score: 0.9,
    reason: null,
    judgeOutput: { verdict: "correct" },
  });
  assertEquals(
    normalizeEvaluationOutcome("evaluation.score", result, scoreInput),
    { state: "passed", score: 0.9, reason: null },
  );
  assertEquals(calls.length, 1);
  const call = calls[0]!;
  assert(call.prompt.includes(OUTPUT));
  assert(call.prompt.includes("Is the answer correct?"));
  assertEquals(call.timeLimitMs, 5_000);
  // The billing cap lowers the default output-token cap.
  assertEquals(call.maxOutputTokens, 1000);
  assertEquals(
    (call.answerSchema.properties as Record<string, unknown>).answer,
    OUTPUT_SCHEMA,
  );
});

Deno.test("a failing verdict keeps the judge reason", async () => {
  const { transport } = fake({
    kind: "answered",
    answer: {
      score: 0.2,
      passed: false,
      reason: "wrong number",
      answer: { verdict: "incorrect" },
    },
    usage,
  });
  const result = resultOf(await score(transport));
  assertEquals(result.state, "failed");
  assertEquals(result.score, 0.2);
  assertEquals(result.reason, "wrong number");
});

Deno.test("an answer that breaks the output schema or the envelope is unscored", async () => {
  for (
    const answer of [
      { score: 0.9, passed: true, reason: null, answer: { verdict: 3 } },
      { score: 0.9, passed: true, reason: null, answer: {} },
      { score: 1.5, passed: true, reason: null, answer: { verdict: "x" } },
      { score: 0.9, passed: true, reason: null },
      {
        score: 0.9,
        passed: true,
        reason: null,
        answer: { verdict: "x" },
        x: 1,
      },
      "0.9",
      undefined,
    ]
  ) {
    const outcome = await score(
      fake({ kind: "answered", answer, usage }).transport,
    );
    const result = resultOf(outcome);
    assertEquals(result.state, "unscored", JSON.stringify(answer));
    assertEquals(result.score, null);
    assertEquals(result.judgeOutput, null);
    assert(typeof result.reason === "string" && result.reason.length > 0);
    // The call was made, so its usage is still reported.
    assert(outcome.usage, JSON.stringify(answer));
  }
});

Deno.test("no transport or an unavailable provider is unscored with an explicit reason", async () => {
  const missing = resultOf(await score(undefined));
  assertEquals(missing.state, "unscored");
  assertEquals(missing.reason, JUDGE_PROVIDER_NOT_CONFIGURED);
  const unavailable = await score(
    fake({ kind: "unavailable", reason: "credentials are unavailable" })
      .transport,
  );
  assertEquals(resultOf(unavailable).state, "unscored");
  assertEquals(resultOf(unavailable).reason, "credentials are unavailable");
  assertEquals(unavailable.usage, undefined);
});

Deno.test("a judge timeout is unscored; a transport failure is an error", async () => {
  const timedOut = resultOf(await score(fake({ kind: "timeout" }).transport));
  assertEquals(timedOut.state, "unscored");
  assertEquals(timedOut.reason, "the judge did not answer within 5000 ms");
  const failed = await score(
    fake({ kind: "failed", reason: "claude exited with code 1", usage })
      .transport,
  );
  assertEquals(resultOf(failed).state, "error");
  assertEquals(resultOf(failed).reason, "claude exited with code 1");
  assert(failed.usage);
});

Deno.test("a timed-out call is recorded as unknown usage, never free", async () => {
  const outcome = await score(fake({ kind: "timeout" }).transport);
  assertEquals(resultOf(outcome).state, "unscored");
  assertEquals(outcome.usage, {
    usageFactId: `evaluation.score:${ATTEMPT}`,
    providerCallId: `evaluation.score.timeout:${ATTEMPT}`,
    provider: "anthropic",
    billingAccountId: "acct-1",
    model: "claude-sonnet",
    billingRoute: "api",
    pricingMetadataSnapshot: "pricing-v1",
    measurement: "unknown",
    occurredAt: "2026-11-20T00:00:00.000Z",
  });
  assert(contractSchemas.UsageReceipt.safeParse(outcome.usage).success);
});

Deno.test("a canceled call returns the canceled outcome", async () => {
  const outcome = await score(fake({ kind: "canceled" }).transport);
  assertEquals(outcome.status, "canceled");
});

Deno.test("a judged call carries a usage receipt against the pinned billing policy", async () => {
  const { transport } = fake({
    kind: "answered",
    answer: { score: 1, passed: true, reason: null, answer: { verdict: "y" } },
    usage,
  });
  const outcome = await score(transport);
  assertEquals(outcome.usage, {
    usageFactId: `evaluation.score:${ATTEMPT}`,
    providerCallId: SESSION,
    provider: "anthropic",
    billingAccountId: "acct-1",
    model: "claude-sonnet",
    billingRoute: "api",
    pricingMetadataSnapshot: "pricing-v1",
    inputTokens: "120",
    outputTokens: "30",
    costUsd: "0.001234",
    measurement: "reported",
    occurredAt: "2026-11-20T00:00:00.000Z",
  });
  assert(contractSchemas.UsageReceipt.safeParse(outcome.usage).success);
  // No billing policy or reservation means nothing to settle, so no receipt.
  const unbilled = await score(transport, false);
  assertEquals(resultOf(unbilled).state, "passed");
  assertEquals(unbilled.usage, undefined);
});

Deno.test("an invalid output schema is an error and makes no call", async () => {
  const { transport, calls } = fake({ kind: "timeout" });
  const served = [await pinned(OUTPUT)];
  const outcome = await createEvaluationExecutor(inner, {
    readAttemptContext: () => Promise.resolve(served),
    judge: { transport },
  }).execute(
    {
      ...assignment(),
      input: { ...scoreInput, outputSchema: { type: "thing" } },
    } as JobAssignment,
    new AbortController().signal,
  );
  assertEquals(calls.length, 0);
  const result = (outcome as { result: Record<string, unknown> }).result;
  assertEquals(result.state, "error");
});
