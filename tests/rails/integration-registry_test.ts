import { assert, assertEquals } from "@std/assert";
import type { ProviderIdentity } from "../../apps/server/src/modules/integrations/registry.ts";
import {
  deployedGateIds,
  deployedProviderSlugs,
  GITHUB_PROVIDER_IDENTITY,
  identityForGateId,
  identityForSlug,
  PROVIDER_IDENTITIES,
  providerIdentityDefects,
  providerIdForSlug,
  slugForGateId,
} from "../../apps/server/src/modules/integrations/registry.ts";
import {
  deployedIntegrationEntries,
  deployedIntegrations,
  deployedIntegrationsDefects,
} from "../../apps/server/src/modules/catalog/integration-gate-registry.ts";
import { computeManifestDigest } from "../../apps/server/src/modules/catalog/integration-gate.ts";

/**
 * Slice 3 of the modular integrations program (chapter 09 section 12.4): one
 * registry owns the three provider identities, and `deployedIntegrations` derives
 * from it.
 *
 * The rail exists because the failure it prevents is silent. Three copies of a
 * provider's identity - the gate id in its definition, the slug as a constant, the
 * UUID as a literal - can each be edited alone, and nothing notices until a
 * connection written under one identity is invisible to the gate reading another.
 *
 * Four bases, because the map can be wrong in four independent ways:
 *
 * 1. the registry is internally consistent;
 * 2. every registered identity has a definition or a provider package;
 * 3. every definition has a registered identity;
 * 4. all three ids for one provider resolve to each other.
 */

Deno.test("basis 1: the shipped registry is internally consistent", () => {
  assertEquals(providerIdentityDefects(), []);
  assertEquals(deployedIntegrationsDefects(), []);
});

Deno.test("basis 2: every registered identity has a definition or a provider package", () => {
  // An identity with neither is routed to and then found missing, which reads to a
  // caller as a provider that does not exist.
  //
  // The two tiers are both deployed now: a legacy definition carries actions, and a
  // provider package carries a manifest and its ports. The rail asks the question
  // that still matters - is this identity served by *something* - rather than the
  // one that used to be equivalent to it.
  const served = new Set(
    deployedIntegrationEntries.map((entry) =>
      entry.kind === "definition"
        ? entry.definition.manifest.id
        : entry.provider.integrationId
    ),
  );
  for (const gateId of deployedGateIds()) {
    assert(
      served.has(gateId),
      `the registry deploys ${gateId} but neither a definition nor a provider package matches it`,
    );
  }
});

Deno.test("basis 3: every deployed definition has a registry identity", () => {
  // The other direction: a definition with no identity has no slug and no UUID, so a
  // connection cannot name it.
  //
  // This asserts on `deployedIntegrationsDefects()` rather than on the derived list.
  // The list is *built* by filtering to registered ids, so a definition with no
  // identity never appears in it - a check over the derived output would pass no
  // matter what was declared, which is the silent-pass failure this rail exists to
  // catch. The defects function reports what was declared, before the filter.
  const defects = deployedIntegrationsDefects().filter((defect) =>
    defect.includes("has no identity")
  );
  assertEquals(
    defects,
    [],
    "a definition with no registry identity must be reported, not filtered away",
  );
  // And for the shipped build, every deployed entry names a registered gate id.
  // The legacy list alone no longer equals the registry: a provider package deploys
  // a manifest and no definition, which is the point of the second tier.
  for (const entry of deployedIntegrationEntries) {
    const gateId = entry.kind === "definition"
      ? entry.definition.manifest.id
      : entry.provider.integrationId;
    assert(
      deployedGateIds().includes(gateId),
      `${gateId} is deployed but the registry does not list it`,
    );
  }
});

Deno.test("basis 4: all three ids for one provider resolve to each other", () => {
  for (const identity of PROVIDER_IDENTITIES) {
    assertEquals(identityForSlug(identity.slug), identity);
    assertEquals(identityForGateId(identity.gateId), identity);
    assertEquals(slugForGateId(identity.gateId), identity.slug);
    assertEquals(providerIdForSlug(identity.slug), identity.uuid);
  }
  // And the concrete GitHub identity, which must not drift: the UUID is a primary key.
  assertEquals(GITHUB_PROVIDER_IDENTITY.gateId, "bakery.github");
  assertEquals(GITHUB_PROVIDER_IDENTITY.slug, "github");
  assertEquals(
    GITHUB_PROVIDER_IDENTITY.uuid,
    "a1fbffc0-eeec-541c-b2a1-93179931917e",
  );
});

Deno.test("the connection writer reads the registry rather than repeating it", () => {
  // These were literals in integrations/postgres.ts. Asserting the values agree is
  // the observable half; the import is what makes it a derivation.
  assertEquals(GITHUB_PROVIDER_IDENTITY.slug, "github");
  assertEquals(
    GITHUB_PROVIDER_IDENTITY.uuid,
    "a1fbffc0-eeec-541c-b2a1-93179931917e",
  );
});

Deno.test("a lookup by an unknown slug or gate id is undefined, not a throw", () => {
  // A slug arriving from a request is expected hostile input: the caller decides
  // whether that is a 404 or a refusal, and an exception would make it a 500.
  assertEquals(identityForSlug("nope"), undefined);
  assertEquals(identityForGateId("bakery.nope"), undefined);
  assertEquals(slugForGateId("bakery.nope"), undefined);
  assertEquals(providerIdForSlug("nope"), undefined);
  // Inherited object members must not answer as providers. A plain object literal
  // would return a function for "constructor" or "toString"; the map does not.
  assertEquals(identityForSlug("constructor"), undefined);
  assertEquals(identityForSlug("toString"), undefined);
  assertEquals(identityForSlug("__proto__"), undefined);
});

Deno.test("a duplicated slug, gate id or UUID is a defect", () => {
  const one = {
    gateId: "bakery.one" as const,
    slug: "one",
    uuid: "11111111-1111-4111-8111-111111111111",
  };
  const cases: ReadonlyArray<readonly [string, ProviderIdentity]> = [
    ["slug", { ...one, gateId: "bakery.two" as const }],
    ["gateId", { ...one, slug: "two" }],
    [
      "uuid",
      { ...one, gateId: "bakery.two" as const, slug: "two" },
    ],
  ];
  for (const [key, duplicate] of cases) {
    assert(
      providerIdentityDefects([one, duplicate]).some((defect) =>
        defect.includes(`share the ${key}`)
      ),
      `a shared ${key} must be reported`,
    );
  }
});

Deno.test("a gate id that disagrees with its slug is a defect", () => {
  // The route table trusts the id; connections trust the slug. A mismatch means a
  // delivery is routed to one provider and looked up under another name.
  assert(
    providerIdentityDefects([{
      gateId: "bakery.github",
      slug: "gitlab",
      uuid: "11111111-1111-4111-8111-111111111111",
    }]).some((defect) => defect.includes("bakery.<slug>")),
  );
});

Deno.test("a malformed slug or UUID is a defect", () => {
  assert(
    providerIdentityDefects([{
      gateId: "bakery.Bad",
      slug: "Bad",
      uuid: "11111111-1111-4111-8111-111111111111",
    }]).some((defect) => defect.includes("lowercase identifier")),
  );
  assert(
    providerIdentityDefects([{
      gateId: "bakery.ok",
      slug: "ok",
      uuid: "not-a-uuid",
    }]).some((defect) => defect.includes("lowercase UUID")),
  );
});

Deno.test("the deployed list is ordered by the registry, not by the literal", () => {
  // Both tiers, in registry order: the deployed set has one ordering rule and it is
  // the one the registry states, not the order either list happens to be written in.
  assertEquals(
    deployedIntegrationEntries.map((entry) =>
      entry.kind === "definition"
        ? entry.definition.manifest.id
        : entry.provider.integrationId
    ),
    [...deployedGateIds()],
  );
  assertEquals(deployedProviderSlugs(), ["github", "linear"]);
});

Deno.test("a deployed manifest refuses mutation all the way down", () => {
  // `Object.freeze` is shallow, so freezing the list alone left `manifest.id`
  // writable at runtime while the type said `readonly`. A provider's manifest
  // decides what the provider is; nothing downstream may rewrite it.
  assertEquals(Object.isFrozen(deployedIntegrations), true);
  for (const definition of deployedIntegrations) {
    assertEquals(Object.isFrozen(definition), true, "definition is frozen");
    assertEquals(
      Object.isFrozen(definition.manifest),
      true,
      "a nested manifest is frozen too, not only the list holding it",
    );
    // The assertion that would have gone red before the fix: a write must throw.
    let threw = false;
    try {
      (definition.manifest as unknown as Record<string, unknown>)["id"] =
        "hacked";
    } catch {
      threw = true;
    }
    assertEquals(
      threw,
      true,
      "writing a manifest id must throw, not silently take",
    );
    assertEquals(
      definition.manifest.id,
      "bakery.github",
      "the manifest id is unchanged after the attempted write",
    );
  }
});

Deno.test("the registry and the deployed list are frozen", () => {
  // A caller must not be able to add a provider at runtime: "which providers does
  // this build have" has to be answerable by reading a file.
  assert(Object.isFrozen(PROVIDER_IDENTITIES));
  assert(Object.isFrozen(GITHUB_PROVIDER_IDENTITY));
  assert(Object.isFrozen(deployedIntegrations));
});

Deno.test("basis 5: every deployed definition still converts to JSON Schema", () => {
  // `computeManifestDigest` converts each handler's input and output, and
  // `activateDeployedIntegrations` runs it while `createApp` starts. Freezing a
  // zod schema before its first conversion makes `z.toJSONSchema` throw the opaque
  // "Error converting schema to JSON", which took down startup for every
  // integration test. This asserts the digest computes, so a freeze that reaches a
  // schema fails here instead of at app boot.
  for (const definition of deployedIntegrations) {
    assert(computeManifestDigest(definition).length === 64);
  }
});
