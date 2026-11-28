import { assertEquals, assertRejects } from "@std/assert";
import {
  meteredModelKey,
  ModelKeyUnavailable,
  type ModelKeyVariables,
  type ReadModelKey,
} from "../../apps/worker/src/model-key.ts";
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
