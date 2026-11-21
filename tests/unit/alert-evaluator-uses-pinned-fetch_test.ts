import { assert, assertEquals } from "@std/assert";

/**
 * The timed alert check sends signed webhooks. A name can answer a public
 * address to the address check and a private one to the connection (DNS
 * rebinding), so the server must build its evaluator with the pinned fetch that
 * dials only the address it checked. The pinned fetch itself is proven in
 * pin-outbound-alert-connections_test.ts; this proves the server uses it.
 */
const source = await Deno.readTextFile(
  new URL("../../apps/server/src/main.ts", import.meta.url),
);

function callBlock(text: string, opener: string): string {
  const start = text.indexOf(opener);
  assert(start >= 0, `main.ts has no ${opener}`);
  const end = text.indexOf("});", start);
  assert(end > start, "the call is not closed");
  return text.slice(start, end);
}

Deno.test("the server builds the alert evaluator with the pinned fetch, not the global one", () => {
  const evaluator = callBlock(source, "createAlertEvaluator({");
  assert(
    /\bfetch:\s*telemetryDeliveryDependencies\.fetch\b/.test(evaluator),
    "the evaluator must take the shared pinned fetch",
  );
  assert(
    !/^\s*fetch,\s*$/m.test(evaluator),
    "the evaluator must not be handed the global fetch",
  );
  assert(
    /\baddressPolicy:\s*telemetryDeliveryDependencies\.addressPolicy\b/.test(
      evaluator,
    ),
    "the evaluator must use the same address policy as the telemetry sends",
  );
});

Deno.test("the shared delivery dependencies are the pinned fetch", () => {
  const dependencies = callBlock(
    source,
    "const telemetryDeliveryDependencies = {",
  );
  assertEquals(/\bfetch:\s*createPinnedFetch\(\)/.test(dependencies), true);
});
