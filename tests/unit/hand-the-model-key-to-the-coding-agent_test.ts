import { assertEquals, assertRejects } from "@std/assert";
import {
  meteredModelKey,
  ModelKeySchema,
  ModelKeyUnavailable,
  type ModelKeyVariables,
  type ReadModelKey,
  readOncePerAttempt,
} from "../../apps/worker/src/model-key.ts";
import { createReviewerExecutor } from "../../apps/worker/src/reviewer.ts";
import type { WorkerExecutor } from "../../apps/worker/src/executor.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";

const CODEX: ModelKeyVariables = { openai: "CODEX_API_KEY" };
const PI: ModelKeyVariables = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

function paidBy(billingRoute: "api" | "subscription"): JobAssignment {
  return {
    ...localAssignment(),
    billing: {
      provider: "openai",
      billingAccountId: "fixture",
      model: "gpt-fixture",
      billingRoute,
      maxTokens: 1_000,
      maxUsdReservation: 0.1,
      pricingMetadataSnapshot: "fixture-v1",
    },
  } as JobAssignment;
}

function serving(
  provider: "anthropic" | "openai" | "openrouter",
): ReadModelKey {
  return () => Promise.resolve({ provider, apiKey: `${provider}-fixture-key` });
}

Deno.test("each harness gets the key under the variable its CLI reads", async () => {
  assertEquals(await meteredModelKey(paidBy("api"), serving("openai"), CODEX), {
    environment: { CODEX_API_KEY: "openai-fixture-key" },
    secrets: ["openai-fixture-key"],
  });
  assertEquals(
    (await meteredModelKey(paidBy("api"), serving("openrouter"), PI))
      ?.environment,
    { OPENROUTER_API_KEY: "openrouter-fixture-key" },
  );
});

Deno.test("a subscription job reads no key", async () => {
  let asked = false;
  const read: ReadModelKey = () => {
    asked = true;
    return Promise.resolve({ provider: "openai", apiKey: "unused" });
  };
  assertEquals(
    await meteredModelKey(paidBy("subscription"), read, CODEX),
    null,
  );
  assertEquals(asked, false);
});

Deno.test("a key the harness cannot use, a failed read or no reader fails closed", async () => {
  await assertRejects(
    () => meteredModelKey(paidBy("api"), serving("anthropic"), CODEX),
    ModelKeyUnavailable,
  );
  await assertRejects(
    () =>
      meteredModelKey(
        paidBy("api"),
        () => Promise.reject(new Error("model_key_unbound")),
        CODEX,
      ),
    ModelKeyUnavailable,
  );
  await assertRejects(
    () => meteredModelKey(paidBy("api"), undefined, CODEX),
    ModelKeyUnavailable,
  );
});

Deno.test("one attempt reads its key once, so a rotation cannot split the child from its redaction", async () => {
  let served = 0;
  const keys = readOncePerAttempt(() => {
    served++;
    return Promise.resolve({ provider: "openai", apiKey: `key-${served}` });
  });
  const read = keys.read;
  const assignment = paidBy("api");
  const first = await meteredModelKey(assignment, read, CODEX);
  const second = await meteredModelKey(assignment, read, CODEX);
  assertEquals(served, 1);
  assertEquals(second, first);
  const next = { ...paidBy("api"), attemptId: crypto.randomUUID() };
  assertEquals(
    (await meteredModelKey(next as JobAssignment, read, CODEX))?.secrets,
    ["key-2"],
  );
});

Deno.test("a failed read is not remembered, so the next try asks again", async () => {
  let calls = 0;
  const { read } = readOncePerAttempt(() => {
    calls++;
    return calls === 1
      ? Promise.reject(new Error("model_key_unbound"))
      : Promise.resolve({ provider: "openai", apiKey: "later-key" });
  });
  const assignment = paidBy("api");
  await assertRejects(
    () => meteredModelKey(assignment, read, CODEX),
    ModelKeyUnavailable,
  );
  assertEquals(
    (await meteredModelKey(assignment, read, CODEX))?.secrets,
    ["later-key"],
  );
  assertEquals(calls, 2);
});

Deno.test("an independent review paid by API key redacts that key, not the host login", async () => {
  const inner = {
    supportedActions: [],
    execute: () => Promise.reject(new Error("not delegated")),
  } as unknown as WorkerExecutor;
  const reviewer = createReviewerExecutor(
    {
      inner,
      repository: "/nonexistent-repository",
      stateDir: "/nonexistent-state",
      claude: { authSourceDir: "/nonexistent-login" },
      readModelKey: serving("anthropic"),
    } as Parameters<typeof createReviewerExecutor>[0],
  );
  const review = { ...paidBy("api"), action: "review.independent" };
  assertEquals(
    await reviewer.credentialRedactionSecrets?.(review as JobAssignment),
    ["anthropic-fixture-key"],
  );
});

Deno.test("the worker accepts any key the server's contract allows", () => {
  const apiKey = "k".repeat(5_000);
  assertEquals(ModelKeySchema.parse({ provider: "openrouter", apiKey }), {
    provider: "openrouter",
    apiKey,
  });
});
