import { githubIntegration } from "./integration-providers/github.ts";
import type { ProviderManifest } from "@bakery/integration-sdk/provider";
import {
  PROVIDER_IDENTITIES,
  providerIdentityDefects,
  PROVIDERS,
} from "../integrations/registry.ts";

/**
 * The integration definitions this build deploys (chapter 09 section 12.4).
 *
 * The list is still explicit - a definition is code, and the registry holds
 * identities rather than definitions - but it is no longer the source of truth for
 * *which* providers exist. That is `PROVIDER_IDENTITIES`, and
 * `deployedIntegrations` is checked against it below, so the two cannot drift: an
 * identity with no definition would be routed to and found missing, and a definition
 * with no identity would have no slug and no UUID, so a connection could not name it.
 *
 * Static on purpose: no dynamic import and no discovery from disk, because a
 * provider that failed to load must not look like a provider that was never
 * deployed.
 */
const DEFINITIONS = Object.freeze([githubIntegration] as const);

/**
 * The provider packages the gate deploys, as their activated manifests.
 *
 * Section 12.4 has the gate's deployed list derive from the registry rather than
 * being listed separately, and this is that derivation for the packages that exist:
 * `PROVIDERS` is what `activateProviders` accepted at startup, so a provider that
 * failed activation is not here and cannot be routed to.
 *
 * A provider package and a legacy definition are different tiers for now - a
 * definition carries actions, the invoke door and the gate broker's request
 * templates, none of which the provider tier describes yet - so the deployed set is
 * their union and each entry keeps the tier it came from. Converting GitHub to the
 * provider tier is its own item; until then neither list may claim a gate id the
 * other holds.
 */
const PROVIDER_MANIFESTS = Object.freeze(
  PROVIDERS.providers.map((provider) => provider.manifest),
);

/** Gate ids that the registry deploys, in registry order. */
const REGISTERED_GATE_IDS: readonly string[] = Object.freeze(
  PROVIDER_IDENTITIES.map((identity) => identity.gateId),
);

/**
 * Whether the definitions and the registry describe the same set of providers.
 *
 * Returned as data rather than thrown, so a test can report both directions in one
 * failure and startup can name every problem at once instead of the first.
 */
export function deployedIntegrationsDefects(): string[] {
  const defects: string[] = [...providerIdentityDefects()];
  const defined = new Map<string, "definition" | "provider">([
    ...DEFINITIONS.map(
      (definition) => [definition.manifest.id, "definition"] as const,
    ),
    ...PROVIDER_MANIFESTS.map((manifest) =>
      [
        manifest.integrationId,
        "provider",
      ] as const
    ),
  ]);
  const registered = new Set(REGISTERED_GATE_IDS);

  for (const gateId of REGISTERED_GATE_IDS) {
    if (!defined.has(gateId)) {
      defects.push(
        `The registry deploys ${gateId} but neither a definition nor a provider package matches it; the gate would route to a provider that does not exist.`,
      );
    }
  }
  for (const gateId of defined.keys()) {
    if (!registered.has(gateId)) {
      defects.push(
        `The integration ${gateId} is deployed but the registry has no identity for it; a connection could not name it.`,
      );
    }
  }
  // Both tiers are read by the gate now, so their meeting point has to be checked
  // too: a gate id claimed by a definition and by a provider package would be two
  // providers answering one route, and the first would win silently.
  for (const manifest of PROVIDER_MANIFESTS) {
    if (DEFINITIONS.some((d) => d.manifest.id === manifest.integrationId)) {
      defects.push(
        `Both a definition and the provider package ${manifest.slug} answer ${manifest.integrationId}; the gate would route to only one of them.`,
      );
    }
  }
  return defects;
}

/**
 * Freeze a value and everything reachable from it.
 *
 * `Object.freeze` is shallow, and a definition's `manifest` is a nested object, so
 * freezing the list alone leaves `manifest.id` writable at runtime while the type
 * says `readonly`. A provider's manifest deciding what the provider is, that is a
 * value nothing downstream may change.
 *
 * Deliberately NOT `deepFreeze` from `packages/integration-sdk/src/context.ts`:
 * that helper skips objects that are already frozen (`!Object.isFrozen(value)`),
 * so called on a frozen array it returns at once and never reaches the manifest -
 * it would look like a fix and change nothing. Descent here is unconditional.
 *
 * Zod schemas are the one thing it must not touch. A handler carries its input and
 * output schemas as Zod instances, and Zod 4 fills in `.shape` lazily by defining a
 * property on the instance itself; freezing the instance makes that define throw, so
 * the schema can no longer be converted to JSON Schema. Startup converts every
 * handler schema to hash the manifest digest, so freezing them does not harden the
 * deployment, it prevents it: the server exited before it listened.
 *
 * A schema is code, not data. The manifest is what this freeze exists to protect,
 * and the surrounding handler object is still frozen, so `input` and `output` cannot
 * be swapped out at runtime; only the instance's internal cache stays writable.
 *
 * A zod schema is skipped: it is a library object, not definition data. It carries
 * internal caches that `z.toJSONSchema` fills on first use, so a schema frozen
 * before that use cannot be converted at all - `toJSONSchema` then reports the
 * opaque "Error converting schema to JSON". `computeManifestDigest` converts every
 * handler input and output, so freezing them here made `createApp` throw on
 * startup for every integration test. Frozen manifest data still stops a provider
 * from redefining itself, which is what this helper is for.
 */
/**
 * Whether a value is a zod schema, recognised by its own shape rather than by
 * importing zod: this module holds the definitions' data and must not pull the
 * schema library in to describe it.
 */
function isZodSchema(value: unknown): boolean {
  return typeof (value as { _zod?: { def?: unknown } } | null)?._zod?.def ===
    "object";
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !isZodSchema(value)) {
    if (!Object.isFrozen(value)) Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
  }
  return value;
}

/**
 * The definitions, in registry order.
 *
 * Ordered by the registry rather than by the literal's own order, so the deployed
 * list has one ordering rule and it is the one the registry states.
 */
/**
 * The deployed set, in registry order: legacy definitions plus provider packages.
 *
 * Ordered by the registry rather than by either list's own order, so the deployed
 * list has one ordering rule and it is the one the registry states. A provider
 * package contributes its manifest and no definition, because it has no actions to
 * contribute yet - which is why the two are kept apart here rather than merged into
 * a shape that would have to pretend one of them is the other.
 */
export type DeployedIntegrationEntry =
  | {
    readonly kind: "definition";
    readonly definition: (typeof DEFINITIONS)[number];
  }
  | { readonly kind: "provider"; readonly provider: ProviderManifest };

export const deployedIntegrationEntries: readonly DeployedIntegrationEntry[] =
  freezeDeep(
    REGISTERED_GATE_IDS.map((gateId): DeployedIntegrationEntry | null => {
      const definition = DEFINITIONS.find((d) => d.manifest.id === gateId);
      if (definition !== undefined) return { kind: "definition", definition };
      const provider = PROVIDER_MANIFESTS.find((m) =>
        m.integrationId === gateId
      );
      return provider === undefined ? null : { kind: "provider", provider };
    }).filter((entry): entry is DeployedIntegrationEntry => entry !== null),
  );

/** The legacy definitions, in the same registry order. */
export const deployedIntegrations = freezeDeep(
  deployedIntegrationEntries.flatMap((entry) =>
    entry.kind === "definition" ? [entry.definition] : []
  ),
);

/**
 * The provider packages the gate deploys, by slug and by gate id.
 *
 * Separate from `deployedIntegrations` because the two tiers carry different
 * things: a definition brings actions, and a provider package brings a manifest and
 * its ports. Merging them would mean inventing a shape in which a manifest has
 * actions or a definition has ports, and either would be a field one tier has to
 * pretend to have.
 *
 * This is what makes a registered provider reachable: the connection writer resolves
 * a provider row id through it, and the intake path resolves a webhook path by slug,
 * so a package that is deployed but absent here would be "exists, nothing calls it".
 */
export const deployedProviders = freezeDeep(
  deployedIntegrationEntries.flatMap((entry) =>
    entry.kind === "provider" ? [entry.provider] : []
  ),
);

/** The deployed provider manifest for a slug, or `undefined`. */
export function deployedProviderBySlug(
  slug: string,
): ProviderManifest | undefined {
  return deployedProviders.find((manifest) => manifest.slug === slug);
}

/** The deployed provider manifest for a gate id, or `undefined`. */
export function deployedProviderByIntegrationId(
  integrationId: string,
): ProviderManifest | undefined {
  return deployedProviders.find((manifest) =>
    manifest.integrationId === integrationId
  );
}
