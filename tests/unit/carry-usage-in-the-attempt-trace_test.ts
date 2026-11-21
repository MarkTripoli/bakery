import { assert, assertEquals } from "@std/assert";
import { usageAttributes } from "../../apps/server/src/modules/execution/telemetry.ts";
import { createServerTelemetry } from "../../apps/server/src/platform/telemetry.ts";
import { measurementsOf } from "../../apps/server/src/platform/telemetry-destinations/index.ts";

/**
 * AC2 of #739: the usage span carries token counts, so a trace shows where the
 * tokens went, and nothing in money or any text a worker wrote.
 */

const ATTEMPT = "22222222-2222-4222-8222-222222222222";

Deno.test("a settled receipt becomes token counts, how they were measured and the route", () => {
  assertEquals(
    usageAttributes({
      inputTokens: "1500000",
      outputTokens: "2",
      measurement: "reported",
      billingRoute: "api",
    }),
    {
      "bakery.usage.input_tokens": 1_500_000,
      "bakery.usage.output_tokens": 2,
      "bakery.usage.measurement": "reported",
      "bakery.usage.route": "api",
    },
  );
});

Deno.test("a token count that is missing or not a safe whole number is left out, never guessed", () => {
  const attributes = usageAttributes({
    inputTokens: null,
    outputTokens: "99999999999999999999",
    measurement: "unknown",
    billingRoute: "subscription",
  });
  assertEquals(Object.keys(attributes).sort(), [
    "bakery.usage.measurement",
    "bakery.usage.route",
  ]);
  assertEquals(
    Object.keys(usageAttributes({
      inputTokens: "-4",
      outputTokens: "1.5",
      measurement: "estimated",
      billingRoute: "api",
    })).sort(),
    ["bakery.usage.measurement", "bakery.usage.route"],
  );
});

Deno.test("the telemetry keeps the usage fields and drops what is not a count or a listed word", async () => {
  const sent: { attributes: Record<string, unknown> }[] = [];
  const telemetry = createServerTelemetry({
    send: (batch) => {
      for (const record of batch) {
        if (record.kind === "event") sent.push(record);
      }
    },
  });
  telemetry.event("usage.settled", {
    "bakery.attempt.id": ATTEMPT,
    ...usageAttributes({
      inputTokens: "1500000",
      outputTokens: "2",
      measurement: "reported",
      billingRoute: "api",
    }),
  });
  telemetry.event("usage.settled", {
    "bakery.attempt.id": ATTEMPT,
    "bakery.usage.input_tokens": -1,
    "bakery.usage.output_tokens": "12",
    "bakery.usage.measurement": "sk-live-canary",
    "bakery.usage.route": "whatever the worker said",
    "bakery.usage.cost_usd": 0.04,
    "bakery.usage.model": "gpt-9",
  });
  await telemetry.close(1_000);
  assertEquals(sent[0].attributes, {
    "bakery.attempt.id": ATTEMPT,
    "bakery.usage.input_tokens": 1_500_000,
    "bakery.usage.output_tokens": 2,
    "bakery.usage.measurement": "reported",
    "bakery.usage.route": "api",
  });
  assertEquals(sent[1].attributes, { "bakery.attempt.id": ATTEMPT });
  assert(!JSON.stringify(sent).includes("sk-live-canary"));
});

Deno.test("a destination that takes results gets the usage span; cost is still not a kind it can take", () => {
  assertEquals(
    measurementsOf({
      kind: "event",
      name: "usage.settled",
      time: 1,
      attributes: {},
    }),
    ["results"],
  );
});
