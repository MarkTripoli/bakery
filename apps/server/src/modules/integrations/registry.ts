import {
  type ActivatedProviders,
  activateProviders,
  type ProviderManifest,
  type TicketActionRef,
  type TicketFamilyAction,
  type TicketTrigger,
} from "@bakery/integration-sdk/provider";
import {
  TICKET_NOTE_ACTION,
  TICKET_NOTE_UPDATE_ACTION,
  TICKET_STATUS_ACTION,
} from "../catalog/integration-providers/github.ts";
import { linearServerProvider } from "@bakery/integration-linear/server";
import { slackServerProvider } from "@bakery/integration-slack/server";

/**
 * One manifest owns all three provider identifiers (chapter 09 section 12.4).
 *
 * A provider is named three ways and they must never disagree:
 *
 * - the **gate id** the route and the action namespace use (`bakery.github`),
 * - the **provider slug** stored on connections and in URLs (`github`),
 * - the **provider UUID** on the `integration_providers` row.
 *
 * Before this module each lived somewhere else: the gate id inside the integration
 * definition, the slug as a module constant, the UUID as a literal in
 * `integrations/postgres.ts` with a comment explaining it was fixed so a connection
 * could name GitHub before the registry existed. Three copies is three chances to
 * disagree, and the disagreement is silent: a connection written under one slug is
 * invisible to the gate reading another.
 *
 * The registry is static on purpose. No dynamic import and no discovery from disk,
 * because "which providers does this build have" has to be answerable by reading a
 * file, and a provider that failed to load would otherwise look like one that was
 * never deployed.
 */

/**
 * The identity of one deployed provider.
 *
 * `uuid` is pinned: it is the `integration_providers` primary key, so changing it
 * orphans every connection that references it.
 */
export type ProviderIdentity = {
  /** Gate identifier, always `bakery.<slug>`; the action namespace prefix. */
  readonly gateId: `bakery.${string}`;
  /** Stored provider slug; appears in URLs and on connection rows. */
  readonly slug: string;
  /** Provider row id; UUIDv5 of `urn:bakery:integration-provider:<slug>`. */
  readonly uuid: string;
};

/**
 * The bundled native Linear provider.
 *
 * The package is the source of the manifest; this file is the only importer of its
 * `/server` entry (boundary rule B1b), which is what keeps the GraphQL documents
 * and the signature code out of every other module.
 */
export const LINEAR_PROVIDER_IDENTITY = Object.freeze(
  {
    gateId: "bakery.linear",
    slug: "linear",
    // UUIDv5 in the URL namespace of `urn:bakery:integration-provider:linear`,
    // the same derivation as the GitHub row's id.
    uuid: "7884e080-6d1f-5aa0-80a7-d03a941cef11",
  } as const satisfies ProviderIdentity,
);

/** The bundled native GitHub provider. */
export const GITHUB_PROVIDER_IDENTITY = Object.freeze(
  {
    gateId: "bakery.github",
    slug: "github",
    uuid: "a1fbffc0-eeec-541c-b2a1-93179931917e",
  } as const satisfies ProviderIdentity,
);

export const SLACK_PROVIDER_IDENTITY = Object.freeze(
  {
    gateId: "bakery.slack",
    slug: "slack",
    uuid: "f4c75b1b-c525-586e-a4b7-bfabcd153eef",
  } as const satisfies ProviderIdentity,
);

/**
 * Every provider this build deploys, one entry each.
 *
 * Adding a provider is one line here plus its package. `deployedIntegrations`, the
 * slug lookup and the connection writer all derive from this list rather than
 * repeating it, so a new provider cannot be half-added.
 */
export const PROVIDER_IDENTITIES = Object.freeze(
  [
    GITHUB_PROVIDER_IDENTITY,
    LINEAR_PROVIDER_IDENTITY,
    SLACK_PROVIDER_IDENTITY,
  ] as const satisfies readonly ProviderIdentity[],
);

/**
 * The slug and row id the connection writer stores, named for their callers.
 *
 * These were literals in `integrations/postgres.ts`; they live here so the identity
 * has one home, and `postgres.ts` re-exports them for the call sites that already
 * import from it.
 */
export const GITHUB_PROVIDER = GITHUB_PROVIDER_IDENTITY.slug;
/** Provider row id; the UUID is a primary key, so it is pinned above. */
export const GITHUB_PROVIDER_ID = GITHUB_PROVIDER_IDENTITY.uuid;

/** A deployed slug, as a union, so a lookup by slug can be exhaustive. */
export type DeployedProviderSlug = typeof PROVIDER_IDENTITIES[number]["slug"];

/** A deployed gate id, as a union, for the same reason. */
export type DeployedGateId = typeof PROVIDER_IDENTITIES[number]["gateId"];

/**
 * The slug→gate-id and slug→UUID maps, built once at module load.
 *
 * Derived from `PROVIDER_IDENTITIES` rather than written out, so there is no second
 * list to keep in step. A `Map` rather than an object literal because a slug is
 * caller-supplied in places: an object would answer `toString` and `constructor`
 * with inherited members, which is a lookup returning a function where a provider
 * was expected.
 */
const BY_SLUG: ReadonlyMap<string, ProviderIdentity> = new Map(
  PROVIDER_IDENTITIES.map((identity) => [identity.slug, identity]),
);
const BY_GATE_ID: ReadonlyMap<string, ProviderIdentity> = new Map(
  PROVIDER_IDENTITIES.map((identity) => [identity.gateId, identity]),
);

/** The gate ids this build deploys, in registry order. */
export function deployedGateIds(): readonly string[] {
  return PROVIDER_IDENTITIES.map((identity) => identity.gateId);
}

/** The slugs this build deploys, in registry order. */
export function deployedProviderSlugs(): readonly string[] {
  return PROVIDER_IDENTITIES.map((identity) => identity.slug);
}

/**
 * The identity for a slug, or `undefined` when the slug is not deployed.
 *
 * Returns `undefined` rather than throwing because a slug arriving from a request is
 * expected hostile input: the caller decides whether that is a 404 or a refusal, and
 * an exception here would turn a routine "no such provider" into a 500.
 */
export function identityForSlug(slug: string): ProviderIdentity | undefined {
  return BY_SLUG.get(slug);
}

/** The identity for a gate id, or `undefined` when it is not deployed. */
export function identityForGateId(
  gateId: string,
): ProviderIdentity | undefined {
  return BY_GATE_ID.get(gateId);
}

/** The slug a gate id belongs to, or `undefined` when the id is not deployed. */
export function slugForGateId(gateId: string): string | undefined {
  return BY_GATE_ID.get(gateId)?.slug;
}

/** The provider UUID for a slug, or `undefined` when the slug is not deployed. */
export function providerIdForSlug(slug: string): string | undefined {
  return BY_SLUG.get(slug)?.uuid;
}

/**
 * What the registry cannot check for itself, reported so startup and the rails can
 * refuse a provider that was added inconsistently.
 *
 * These are the mistakes one extra line can make: two providers sharing a slug, a
 * gate id or a UUID (one would shadow the other), or a gate id whose slug half does
 * not match its slug field (the route and the stored value would disagree). A
 * duplicate is worse than a missing entry, because the lookup silently answers with
 * whichever was defined later.
 */
export function providerIdentityDefects(
  identities: readonly ProviderIdentity[] = PROVIDER_IDENTITIES,
): string[] {
  const defects: string[] = [];
  const seen = {
    slug: new Map<string, number>(),
    gateId: new Map<string, number>(),
    uuid: new Map<string, number>(),
  } as const;

  for (const identity of identities) {
    for (const key of ["slug", "gateId", "uuid"] as const) {
      const value = identity[key];
      const count = (seen[key].get(value) ?? 0) + 1;
      seen[key].set(value, count);
      if (count === 2) {
        defects.push(
          `Two deployed providers share the ${key} ${value}; the second would shadow the first.`,
        );
      }
    }
    // The gate id and the slug are two spellings of one provider, and the route
    // table trusts the id while connections trust the slug.
    if (identity.gateId !== `bakery.${identity.slug}`) {
      defects.push(
        `Provider ${identity.slug} has gate id ${identity.gateId}; it must be bakery.<slug> so the route and the stored slug agree.`,
      );
    }
    if (!/^[a-z][a-z0-9-]*$/.test(identity.slug)) {
      defects.push(
        `Provider slug ${identity.slug} is not a lowercase identifier; it appears in URLs and i18n keys.`,
      );
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        .test(identity.uuid)
    ) {
      defects.push(
        `Provider ${identity.slug} has a UUID that is not a lowercase UUID; it is a primary key.`,
      );
    }
  }
  return defects;
}

/**
 * The provider packages this build deploys, and their activated set.
 *
 * Section 12.4's one registry: this is the only importer of a provider `/server`
 * entry, and `activateProviders` fails startup on any defect (B8). The gate's
 * deployed list derives from `PROVIDERS` rather than being listed separately, so
 * "which providers exist" has one answer.
 */
/**
 * Declared `as const` rather than `satisfies readonly ServerProvider<ProviderManifest>[]`.
 *
 * The design's `satisfies` cannot be written for a concrete provider: a manifest
 * annotated `ProviderManifest` widens `ingress`, and `IngressFor` then resolves to
 * `undefined` (null is one of the possible manifest values), while this provider
 * supplies a real `WebhookIngress`. The wide type is therefore not a supertype of
 * the narrow one, and asserting it would be a lie the compiler is right to refuse.
 * `activateProviders` takes `unknown[]` and narrows, so conformance is checked at
 * runtime, once, by the one function that is allowed to throw.
 */
export const SERVER_PROVIDERS = Object.freeze(
  [
    linearServerProvider,
    slackServerProvider,
  ] as const,
);

export const PROVIDERS: ActivatedProviders = activateProviders(
  SERVER_PROVIDERS,
);

/** The deployed identity a provider row id names, or `undefined`. */
export function identityForProviderId(
  providerId: string,
): ProviderIdentity | undefined {
  return PROVIDER_IDENTITIES.find((identity) => identity.uuid === providerId);
}

/**
 * The provider package a provider row id names, or `undefined`.
 *
 * The connection writer is handed a UUID, not a slug: the column is a foreign key to
 * `integration_providers`. Resolving it here rather than in the writer keeps the
 * provider packages behind the one importer, so a writer can read a manifest's
 * connect kind without reaching a provider's server code.
 */
export function providerManifestForId(
  providerId: string,
): ProviderManifest | undefined {
  return PROVIDERS.providers.find((provider) =>
    provider.manifest.providerUuid === providerId
  )?.manifest;
}

const TICKET_TRIGGERS: Readonly<Record<string, readonly TicketTrigger[]>> = {
  [GITHUB_PROVIDER_IDENTITY.slug]: ["label", "status"],
  [LINEAR_PROVIDER_IDENTITY.slug]: linearServerProvider.manifest
    .ticketTriggers ?? ["label"],
};

export function ticketTriggersOf(provider: string): readonly TicketTrigger[] {
  return Object.hasOwn(TICKET_TRIGGERS, provider)
    ? TICKET_TRIGGERS[provider]!
    : ["label"];
}

export type TicketFamilyActions = Readonly<
  Partial<Record<TicketFamilyAction, TicketActionRef>>
>;

const GITHUB_TICKET_FAMILY_ACTIONS: TicketFamilyActions = {
  "comment.create": TICKET_NOTE_ACTION,
  "comment.update": TICKET_NOTE_UPDATE_ACTION,
  "status.set": TICKET_STATUS_ACTION,
};

export function ticketFamilyActionsFrom(
  manifests: readonly Pick<ProviderManifest, "slug" | "ticketActions">[],
  core: Readonly<Record<string, TicketFamilyActions>>,
): Readonly<Record<string, TicketFamilyActions>> {
  const declared: Record<string, TicketFamilyActions> = { ...core };
  for (const manifest of manifests) {
    if (manifest.ticketActions !== undefined) {
      declared[manifest.slug] = manifest.ticketActions;
    }
  }
  return declared;
}

const TICKET_FAMILY_ACTIONS = ticketFamilyActionsFrom(
  SERVER_PROVIDERS.map((provider) => provider.manifest),
  { [GITHUB_PROVIDER_IDENTITY.slug]: GITHUB_TICKET_FAMILY_ACTIONS },
);

export function ticketFamilyActionsOf(provider: string): TicketFamilyActions {
  return Object.hasOwn(TICKET_FAMILY_ACTIONS, provider)
    ? TICKET_FAMILY_ACTIONS[provider]!
    : {};
}
