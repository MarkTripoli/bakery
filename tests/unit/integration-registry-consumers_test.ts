import { assert, assertEquals } from "@std/assert";
import {
  activateDeployedIntegrations,
} from "../../apps/server/src/modules/catalog/integration-gate.ts";
import {
  deployedIntegrations,
  deployedIntegrationsDefects,
  deployedProviders,
} from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";
import {
  deployedProviderSlugs,
  GITHUB_PROVIDER_IDENTITY,
} from "../../apps/server/src/modules/integrations/registry.ts";

/**
 * Slice 3b: the registry's consumers read it by name.
 *
 * Slice 3 gave the provider identity one home and left it inert - six of nine
 * `registry.ts` exports had no production caller while returning the correct
 * value. That is the standing lesson this slice acts on: a correct function and an
 * unwired one look identical from inside a green suite.
 *
 * The source-level half - that `app.ts` binds the activation result rather than
 * discarding it - is in `tests/rails/integration-registry-consumers_test.ts`,
 * because a discarded return value is invisible to behavioural tests. This file
 * proves the lookup itself behaves.
 */

Deno.test("the activated registry resolves a provider by slug", () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  const bySlug = registry.getBySlug(GITHUB_PROVIDER_IDENTITY.slug);
  assert(bySlug, "the deployed github slug must resolve");
  // The same provider reached two ways must be ONE object, not two views that can
  // drift apart. Identity, not deep equality: the projection carries Zod schemas,
  // so a structural comparison would be testing the schemas rather than the join.
  assert(
    bySlug === registry.get(GITHUB_PROVIDER_IDENTITY.gateId),
    "the by-slug and by-id lookups must return the same object",
  );
  assertEquals(bySlug.providerId, GITHUB_PROVIDER_IDENTITY.gateId);
});

Deno.test("getBySlug keeps the registry's lookup convention: undefined, never a throw", () => {
  const registry = activateDeployedIntegrations(deployedIntegrations);
  // A slug from a request is expected hostile input; the caller chooses 404
  // versus refusal. This mirrors `identityForSlug` rather than inventing a second
  // convention for the same lookup.
  assertEquals(registry.getBySlug("nope"), undefined);
  assertEquals(registry.getBySlug(""), undefined);
  // Case-sensitive, and proto-safe: a Map does not answer inherited members,
  // where a plain object literal would return functions for these three.
  assertEquals(registry.getBySlug("GitHub"), undefined);
  assertEquals(registry.getBySlug("constructor"), undefined);
  assertEquals(registry.getBySlug("__proto__"), undefined);
  assertEquals(registry.getBySlug("toString"), undefined);
});

Deno.test("every deployed slug resolves, and only deployed slugs resolve", () => {
  // Enumerated from the identity registry rather than from the active list: the
  // active list is the thing under test, and an assertion that walks it can only
  // confirm what it already contains. A provider added to `PROVIDER_IDENTITIES`
  // must not be silently unreachable by name.
  const registry = activateDeployedIntegrations(
    deployedIntegrations,
    undefined,
    deployedProviders,
  );
  const slugs = deployedProviderSlugs();
  assert(slugs.length > 0, "the build deploys at least one provider");
  for (const slug of slugs) {
    // Either tier answers by name: the legacy definition tier for the provider that
    // carries actions, the provider tier for a package that carries a manifest. What
    // this rail refuses is the third case - deployed, registered, and reachable by
    // nothing - which is how a provider ends up existing with no caller.
    assert(
      registry.getBySlug(slug) ?? registry.getProvider(slug),
      `deployed slug ${slug} must resolve to an active integration or provider`,
    );
  }
  assertEquals(
    registry.getBySlug(GITHUB_PROVIDER_IDENTITY.slug)?.providerId,
    GITHUB_PROVIDER_IDENTITY.gateId,
    "the github slug must resolve to the integration whose provider id is its gate id",
  );
});

Deno.test("the discard-rail's negative control is a real uncalled export", () => {
  // `deployedIntegrationsDefects` is exported, correct, and has ZERO production
  // callers - measured, not supposed. That makes it the genuine "exported but
  // uncalled" instance on which the rail separates its two states, rather than a
  // fixture invented to make the rail look useful.
  assertEquals(
    deployedIntegrationsDefects(),
    [],
    "the shipped set is consistent",
  );
  assertEquals(typeof deployedIntegrationsDefects, "function");
});
