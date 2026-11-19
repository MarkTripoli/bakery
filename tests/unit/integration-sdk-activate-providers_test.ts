import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  activatedProviders,
  activateProviders,
  defineServerProvider,
  IntegrationActivationError,
} from "../../packages/integration-sdk/provider.ts";
import type {
  ProviderManifest,
  ServerImpl,
  ServerProvider,
} from "../../packages/integration-sdk/provider.ts";
import {
  linearProviderManifest,
  linearServerProvider,
} from "../../packages/integration-linear/src/server/mod.ts";

/**
 * The Linear implementation, retyped for the tests that widen the manifest to
 * `ProviderManifest`. A widened manifest no longer names its connect kind, so the
 * conditional `ConnectFor` falls to its last arm; the value is still Linear's own.
 */
const widenedImpl = linearServerProvider.impl as unknown as ServerImpl<
  ProviderManifest
>;

/** Linear as the activated list holds it, with the manifest widened. */
const widenedLinear = linearServerProvider as unknown as ServerProvider<
  ProviderManifest
>;

/**
 * `activateProviders` (rail B8, chapter 09 section 12.4).
 *
 * Startup calls this once with the registry's own list, so what these tests pin is
 * the difference between a provider that is deployed and one that is merely present:
 * a defect has to stop the process, and it has to stop it with every problem named
 * at once rather than the first.
 */

/** A second provider, so the duplicate checks have something to collide with. */
const otherProvider = defineServerProvider(
  {
    ...linearProviderManifest,
    slug: "gitlab",
    integrationId: "bakery.gitlab",
    providerUuid: "00000000-0000-5000-8000-000000000001",
  } as ProviderManifest,
  widenedImpl,
);

Deno.test("the real registry activates and answers by slug and gate id", () => {
  const activated = activateProviders([linearServerProvider]);
  assertEquals(activated.providers.length, 1);
  // The gate routes by integration id and the connection rows store the slug, so
  // both lookups have to answer for the same provider.
  assertEquals(activated.get("linear")?.manifest.slug, "linear");
  assertEquals(
    activated.getByIntegrationId("bakery.linear")?.manifest.slug,
    "linear",
  );
  // A slug that is not deployed is `undefined`, not a throw: it arrives from a
  // request, and the caller decides whether that is a 404.
  assertEquals(activated.get("github"), undefined);
  assertEquals(activated.getByIntegrationId("bakery.nope"), undefined);
});

Deno.test("an empty registry activates to an empty set rather than failing", () => {
  // A build with no provider packages is legal; it routes nothing. Failing here
  // would make the first provider a bootstrapping problem.
  const activated = activateProviders([]);
  assertEquals(activated.providers, []);
});

Deno.test("a value that is not a provider shape is refused by its position", () => {
  const error = assertThrows(
    () => activateProviders([{ kind: "integration", manifest: {} }]),
    IntegrationActivationError,
  );
  assertEquals(error.defects[0]?.path, "providers[0]");
  assert(error.defects[0]?.message.includes("defineServerProvider"));
});

Deno.test("a forged provider is judged by its manifest, not waved through", () => {
  // `isServerProvider` is structural - it reads `kind` - so anything claiming to be
  // one reaches schema validation. That is the honest behaviour: the alternative is
  // trusting a manifest because a string said so.
  const error = assertThrows(
    () => activateProviders([{ kind: "server-provider", manifest: {} }]),
    IntegrationActivationError,
  );
  assert(
    error.defects.some((defect) => defect.path.includes("manifest.slug")),
    JSON.stringify(error.defects),
  );
});

Deno.test("a duplicate slug, gate id or uuid is refused, naming the first owner", () => {
  // One at a time, because the three keys are separate lookups and a test that
  // collided all three at once would pass even if only one check existed.
  for (
    const [field, second] of [
      [
        "slug",
        defineServerProvider(
          {
            ...linearProviderManifest,
            integrationId: "bakery.other",
            providerUuid: "00000000-0000-5000-8000-000000000002",
          } as ProviderManifest,
          widenedImpl,
        ),
      ],
      [
        "integrationId",
        defineServerProvider(
          {
            ...linearProviderManifest,
            slug: "other",
            providerUuid: "00000000-0000-5000-8000-000000000003",
          } as ProviderManifest,
          widenedImpl,
        ),
      ],
      [
        "providerUuid",
        defineServerProvider(
          {
            ...linearProviderManifest,
            slug: "other",
            integrationId: "bakery.other",
          } as ProviderManifest,
          widenedImpl,
        ),
      ],
    ] as const
  ) {
    const error = assertThrows(
      () => activateProviders([linearServerProvider, second]),
      IntegrationActivationError,
    );
    assert(
      error.defects.some((defect) =>
        defect.path.endsWith(`manifest.${field}`) &&
        defect.message.includes("already claimed by bakery.linear")
      ),
      `expected a duplicate ${field} defect, got ${
        JSON.stringify(error.defects)
      }`,
    );
  }
});

Deno.test("every defect is collected, so one run names them all", () => {
  // The common failure is a package added to one registry line and not the other,
  // which shows up as several faults at once. Reporting only the first would cost a
  // second startup per fault.
  const broken = defineServerProvider(
    {
      ...linearProviderManifest,
      providerUuid: "00000000-0000-5000-8000-000000000004",
    } as ProviderManifest,
    { ...widenedImpl, hostProfile: "  " },
  );
  const error = assertThrows(
    () => activateProviders([broken, linearServerProvider]),
    IntegrationActivationError,
  );
  // The empty host profile and the duplicated slug are independent faults.
  assert(error.defects.length >= 2, JSON.stringify(error.defects));
});

Deno.test("a manifest that fails the schema is refused before its ports are judged", () => {
  // `defineServerProvider` is a type-level guarantee only; the manifest crosses a
  // boundary at runtime, so it is re-validated rather than trusted.
  const wrong = defineServerProvider(
    { ...linearProviderManifest, slug: "Not A Slug" } as ProviderManifest,
    widenedImpl,
  );
  const error = assertThrows(
    () => activateProviders([wrong]),
    IntegrationActivationError,
  );
  assert(
    error.defects.some((defect) => defect.path.includes("manifest.slug")),
    JSON.stringify(error.defects),
  );
});

Deno.test("the activated set is frozen in both directions", () => {
  const activated = activatedProviders([widenedLinear, otherProvider]);
  assertEquals(activated.providers.length, 2);
  assertEquals(activated.get("gitlab")?.manifest.slug, "gitlab");
  // The list decides what the gate routes to, so a caller that appended to it would
  // change routing at runtime with nothing for a reviewer to see.
  assertThrows(() => {
    (activated.providers as unknown as unknown[]).push("nope");
  });
});
