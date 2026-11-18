import { githubIntegration } from "./integration-providers/github.ts";
import {
  PROVIDER_IDENTITIES,
  providerIdentityDefects,
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
  const defined = new Set(
    DEFINITIONS.map((definition) => definition.manifest.id),
  );
  const registered = new Set(REGISTERED_GATE_IDS);

  for (const gateId of REGISTERED_GATE_IDS) {
    if (!defined.has(gateId)) {
      defects.push(
        `The registry deploys ${gateId} but no integration definition matches it; the gate would route to a provider that does not exist.`,
      );
    }
  }
  for (const gateId of defined) {
    if (!registered.has(gateId)) {
      defects.push(
        `The definition ${gateId} is deployed but the registry has no identity for it; a connection could not name it.`,
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
 */
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
  }
  if (value && typeof value === "object") {
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
export const deployedIntegrations = freezeDeep(
  REGISTERED_GATE_IDS.map((gateId) =>
    DEFINITIONS.find((definition) => definition.manifest.id === gateId)
  ).filter((definition) => definition !== undefined),
);
