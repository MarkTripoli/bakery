import { assert } from "@std/assert";

/**
 * Slice 3b, the reachability rail.
 *
 * The defect this catches: `activateDeployedIntegrations(deployedIntegrations);`
 * as a bare statement. The registry was built, validated and **dropped**, so a
 * consumer holding a slug had no way in, and nothing in a unit test notices a
 * discarded return value — the failure is invisible to every green suite while
 * remaining a real defect in the shipped server.
 *
 * So this asserts on the source, which is the only place the difference shows.
 * The behavioural half (getBySlug resolves, unknown slug is `undefined`) lives in
 * the unit lane beside the other activation tests, because activation builds
 * manifest digests through `z.toJSONSchema` and that needs the unit lane's
 * environment.
 */

Deno.test("app.ts BINDS the activation result instead of discarding it", async () => {
  const source = await Deno.readTextFile(
    new URL("../../apps/server/src/app.ts", import.meta.url),
  );
  assert(
    !/^\s*activateDeployedIntegrations\(\s*deployedIntegrations,?\s*\);\s*$/m
      .test(source),
    "app.ts must not discard the activation result; assign it so consumers can take it",
  );
  assert(
    /const\s+\w+\s*=\s*activateDeployedIntegrations\(/.test(source),
    "app.ts must hold the activation result in a binding",
  );
});

Deno.test("the bound registry reaches the integration dependency graph", async () => {
  // Binding alone is still a correct-but-unreachable value, which is the defect
  // this slice exists to end. The registry must travel with the other integration
  // dependencies so a consumer holding a provider name actually receives it.
  const source = await Deno.readTextFile(
    new URL("../../apps/server/src/app.ts", import.meta.url),
  );
  assert(
    /registry:\s*integrationRegistry/.test(source),
    "the activated registry must be placed in the integrations dependency bag",
  );
  assert(
    /const\s+integrations\s*=\s*\{/.test(source),
    "the bag the consumers receive must still exist",
  );
});

Deno.test("the startup registry is not silently rebuilt from a second source", async () => {
  // If app.ts re-derived providers locally instead of taking the activated
  // registry, there would be two views of "which providers exist" and they could
  // disagree - the exact failure the identity registry exists to prevent.
  const source = await Deno.readTextFile(
    new URL("../../apps/server/src/app.ts", import.meta.url),
  );
  assert(
    !/deployedIntegrations\s*\.\s*(?:map|filter|find)\(/.test(source),
    "app.ts must not derive providers itself; it takes the activated registry",
  );
});
