import type { CodePort, TicketsPort } from "./family-ports.ts";
import type { StoragePort } from "./storage-port.ts";
import {
  manifestDefects,
  ProviderManifestSchema,
} from "./provider-manifest.ts";
import type { ProviderManifest } from "./provider-manifest.ts";
import { IntegrationActivationError } from "./errors.ts";
import type {
  DiscoveredResource,
  HealthProbe,
  InstallationLifecycle,
  ProviderRequestPort,
  ResourceDiscovery,
} from "./ports.ts";
import type {
  ApiTokenProbe,
  ConnectStrategy,
  CredentialStrategy,
  OAuth2Profile,
  WebhookIngress,
} from "./strategies.ts";

/**
 * `defineServerProvider` (chapter 09 section 12.2).
 *
 * The conditional types below are the second half of the manifest's job. The
 * manifest says which connect kind and which families a provider claims; these
 * types then require exactly the matching implementation and forbid the others, so
 *
 * - a provider that declares `tickets` cannot omit `tickets`,
 * - a provider that does not declare `tickets` cannot smuggle one in,
 * - an `oauth2` provider must supply an `OAuth2Profile`, not a `ConnectStrategy`,
 * - an `api-token` provider must supply only the probe,
 * - a provider with no ingress must not supply one.
 *
 * Without this, a mismatch would be discovered when the engine called a port that
 * was never written - at the one moment a provider is hardest to test.
 */

/** The connect implementation a manifest's connect kind requires. */
export type ConnectFor<M extends ProviderManifest> =
  M["connect"]["kind"] extends "github-app" ? ConnectStrategy
    : M["connect"]["kind"] extends "oauth2" ? OAuth2Profile
    : ApiTokenProbe;

/**
 * The ingress a manifest requires: the port when the manifest declares webhooks,
 * and exactly `undefined` when it says null.
 *
 * `null extends M["ingress"]` rather than `M["ingress"] extends null`: a manifest
 * annotated as `ProviderManifest` widens the member to `Scope | null`, and the
 * narrower form then resolved to a *required* `WebhookIngress` for a provider that
 * declared no webhooks at all. Asking whether null is a possible value answers the
 * question the manifest actually posed.
 */
export type IngressFor<M extends ProviderManifest> =
  // Absent when the manifest declares no webhooks, and absent *as a value*: the
  // member is still present in the type so a provider cannot omit it, and its only
  // inhabitant is `undefined` so it cannot supply one either.
  null extends M["ingress"] ? undefined : WebhookIngress;

/** The tickets port when the family is claimed, and `never` when it is not. */
export type TicketsFor<M extends ProviderManifest> = "tickets" extends
  M["families"][number] ? TicketsPort : never;

/** The code port when the family is claimed, and `never` when it is not. */
export type CodeFor<M extends ProviderManifest> = "code" extends
  M["families"][number] ? CodePort : never;

/** The storage port when the family is claimed, and `never` when it is not. */
export type StorageFor<M extends ProviderManifest> = "storage" extends
  M["families"][number] ? StoragePort : never;

/**
 * A port member that a family either requires or forbids.
 *
 * `Claimed` decides which, and the two arms are deliberately not "required or
 * optional": an optional member would let an implementation omit the port entirely,
 * because `tickets?: TicketsPort` accepts `undefined` and a manifest that claims the
 * family still compiles without one. That was a real hole: the mismatch then only
 * surfaced when the engine called `.tickets` on an undefined value, which is the
 * moment this type exists to prevent. `never` in the unclaimed arm forbids a value
 * as well as requiring its absence.
 */
/**
 * Whether the manifest's family list *excludes* `F`, which is the only case where a
 * port may be forbidden.
 *
 * This asks the question the other way round from "does the manifest claim F", and
 * the direction is the whole point (QA, round 2). A manifest annotated
 * `ProviderManifest` widens `families` to the full union, and `F extends
 * ("tickets" | "code")` is then true for *every* F. So the claim-first form resolves
 * "claims tickets" and "claims nothing" to the same branch, and a familyless control
 * silently takes the required-port arm - which is exactly the false pass that made
 * my own control prove nothing.
 *
 * Asking whether F is *excluded* distinguishes them: the wide union excludes
 * nothing, so its ports stay required; `never` (a familyless manifest) excludes
 * everything, so its ports are forbidden; and a list of another family excludes this
 * one. Erring toward required is the safe direction - a missing port fails at the
 * build, whereas a port that was never required is called on an undefined value at
 * runtime.
 */
type ExcludesFamilies<M extends ProviderManifest, F> = F extends
  M["families"][number] ? false : true;

/**
 * Everything a server provider supplies.
 *
 * `tickets` and `code` are required exactly when the manifest claims the family, and
 * forbidden otherwise. A provider with neither still has a
 * complete implementation, which is what lets a facts-only provider exist without
 * pretending to serve a port.
 *
 * The intersection is what makes both arms work: distributing over the union of
 * claimed and unclaimed would widen to a member that is sometimes optional.
 */
export type ServerImpl<M extends ProviderManifest> =
  & {
    connect: ConnectFor<M>;
    credentials: CredentialStrategy;
    ingress: IngressFor<M>;
    lifecycle: InstallationLifecycle;
    /** Its own paged port, not a step of connect, so a scan can resume after a restart. */
    discovery: ResourceDiscovery;
    health: HealthProbe;
    /**
     * The host authentication profile the gate brokers through. A name, never a
     * credential: the host owns secrets.
     */
    hostProfile: string;
  }
  & (ExcludesFamilies<M, "tickets"> extends true ? {
      /** Forbidden: the manifest excludes the ticket family. */ tickets?:
        never;
    }
    : {
      /** Serves the ticket family; required because the manifest may claim it. */ tickets:
        TicketsPort;
    })
  & (ExcludesFamilies<M, "code"> extends true ? {
      /** Forbidden: the manifest excludes the code family. */ code?: never;
    }
    : {
      /** Serves the code family; required because the manifest may claim it. */ code:
        CodePort;
    })
  & (ExcludesFamilies<M, "storage"> extends true ? {
      /** Forbidden: the manifest excludes the storage family. */ storage?:
        never;
    }
    : {
      /** Serves the storage family; required because the manifest may claim it. */ storage:
        StoragePort;
    });

/**
 * A provider as the host sees it: the manifest plus the implementation.
 *
 * `manifest` is carried so the host never has to import a provider to know what it
 * serves, and `kind` marks the value as a provider rather than any object with the
 * same members.
 */
export type ServerProvider<M extends ProviderManifest> = {
  readonly kind: "server-provider";
  readonly manifest: M;
  readonly impl: ServerImpl<M>;
};

/**
 * A defect a person can act on, found without running the provider.
 *
 * Shared by startup validation and the rails, so a provider that fails one fails
 * the other with the same words.
 */
export type ProviderDefect = {
  /** Where the problem is: a manifest field, an implementation member or a port. */
  path: string;
  message: string;
};

/**
 * Checks a provider can fail before any request is made.
 *
 * These are the structural checks that do not need a network or a database: a
 * strategy asking for a secret slot the manifest never collects would fail at the
 * first mint, and a resource kind the discovery port cannot name would fail at the
 * first scan.
 */
export function serverProviderDefects<M extends ProviderManifest>(
  provider: ServerProvider<M>,
): ProviderDefect[] {
  const defects: ProviderDefect[] = [];
  const { manifest, impl } = provider;

  if (impl.hostProfile.trim().length === 0) {
    defects.push({
      path: "impl.hostProfile",
      message:
        "A provider must name the host authentication profile the gate brokers through.",
    });
  }

  // A declared resource kind that discovery cannot produce would leave the engine
  // waiting for a kind no scan ever returns.
  const declared = new Set(manifest.resourceKinds.map((kind) => kind.id));
  if (declared.size === 0 && manifest.families.length > 0) {
    defects.push({
      path: "manifest.resourceKinds",
      message:
        "A provider that serves a family must declare at least one resource kind to serve it on.",
    });
  }

  // The ingress ceiling is the provider's; the host enforces the smaller of it and
  // its own, so an absurd value here is a declaration mistake worth catching.
  if (manifest.ingress !== null && impl.ingress !== undefined) {
    if (impl.ingress.maxBodyBytes <= 0) {
      defects.push({
        path: "impl.ingress.maxBodyBytes",
        message: "A webhook ingress must declare a positive body ceiling.",
      });
    }
  }

  // A credential strategy that mints from a slot the manifest never collects would
  // ask the host for a secret that cannot exist.
  const collected = new Set<string>();
  for (
    const connect of [manifest.connect, manifest.appRegistration]
  ) {
    if (connect !== null && "fields" in connect) {
      for (const field of connect.fields) collected.add(field.id);
    }
    // An OAuth2 flow has no form, so its slots are what the exchange stores rather
    // than what a person types. Without this the check would refuse every OAuth2
    // provider that mints from the token it was just granted.
    if (connect !== null && "secretSlots" in connect) {
      for (const slot of connect.secretSlots) collected.add(slot);
    }
  }
  for (const slot of impl.credentials.secretSlots) {
    if (!collected.has(slot)) {
      defects.push({
        path: "impl.credentials.secretSlots",
        message:
          `The credential strategy mints from the secret slot ${slot}, but no connect or app-registration field collects it.`,
      });
    }
  }

  // The two family arms, restated at runtime (QA, round 2).
  //
  // A manifest annotated `ProviderManifest` widens `families` to the full union, and
  // TypeScript cannot tell `[]` from `["tickets"]` at that type: two such manifests
  // produce type-identical `ServerImpl`s, so NO conditional type can accept the
  // familyless one while rejecting the claim-without-port one. The type therefore
  // requires every possible port for a wide manifest - the safe direction, because a
  // missing port fails the build - and the exact rule lives here, where the values
  // are known.
  const claims = new Set(manifest.families);
  for (
    const [family, port] of [
      ["tickets", impl.tickets],
      ["code", impl.code],
      ["storage", impl.storage],
    ] as const
  ) {
    const supplied = port !== undefined && port !== null;
    if (claims.has(family) && !supplied) {
      defects.push({
        path: `impl.${family}`,
        message:
          `The manifest claims the ${family} family but supplies no ${family} port; the engine would call it and find nothing.`,
      });
    }
    if (!claims.has(family) && supplied) {
      defects.push({
        path: `impl.${family}`,
        message:
          `The manifest does not claim the ${family} family, so it must not supply a ${family} port.`,
      });
    }
  }

  return defects;
}

/**
 * Defines a server provider, checking the manifest at the point of definition.
 *
 * The type parameters do the work the doc calls out as rail B7: `const M` keeps the
 * literal slug, families and resource kinds, so `ServerImpl<M>` can require exactly
 * the matching ports. Passing an implementation whose `tickets` is missing, or
 * whose `connect` is the wrong arm for its connect kind, is a type error here
 * rather than a runtime surprise in the engine.
 */
export function defineServerProvider<const M extends ProviderManifest>(
  manifest: M,
  impl: ServerImpl<M>,
): ServerProvider<M> {
  // `Object.freeze` returns `Readonly<T>`, and a readonly view of an object with a
  // required port member is not assignable to the member's mutable type - so the
  // frozen value is asserted back to the declared shape rather than returned through
  // `Readonly`. The freeze is a runtime guarantee; the type should not leak it.
  return Object.freeze({
    kind: "server-provider" as const,
    manifest: Object.freeze(manifest) as M,
    impl: Object.freeze(impl) as ServerImpl<M>,
  });
}

/** Whether a value is a provider, for the registry to reject anything else. */
export function isServerProvider(
  value: unknown,
): value is ServerProvider<ProviderManifest> {
  return typeof value === "object" && value !== null &&
    (value as { kind?: unknown }).kind === "server-provider";
}

/** A resource a provider reported, re-exported for a signature that reads on its own. */
export type { DiscoveredResource, ProviderRequestPort };

/**
 * The activated provider set: what this build deploys, or nothing.
 *
 * `activateProviders` (rail B8, section 12.4). Startup calls it once with the
 * registry's own list, so a provider defect stops the process instead of surfacing
 * at the first delivery — the same shape as the integration tier's
 * `activateDeployedIntegrations`, and for the same reason: a name lookup re-derived
 * locally is how two views of "which providers exist" start disagreeing.
 *
 * Every defect is collected before it throws, so one run names every problem rather
 * than the first. That matters because the common failure is not one broken
 * provider: it is a package added to one registry line and not the other.
 */
export function activateProviders(
  list: readonly unknown[],
): ActivatedProviders {
  const defects: ProviderDefect[] = [];
  const providers: ServerProvider<ProviderManifest>[] = [];
  // Three keys, because all three are how a caller can reach a provider and two
  // providers sharing one of them means one silently shadows the other.
  const bySlug = new Map<string, string>();
  const byIntegrationId = new Map<string, string>();
  const byUuid = new Map<string, string>();

  for (const [index, candidate] of list.entries()) {
    const at = `providers[${index}]`;
    if (!isServerProvider(candidate)) {
      defects.push({
        path: at,
        message: "Not created by defineServerProvider.",
      });
      continue;
    }
    const parsed = ProviderManifestSchema.safeParse(candidate.manifest);
    if (!parsed.success) {
      // The manifest crosses a boundary at runtime, so it is re-validated rather
      // than trusted: `defineServerProvider` is a type-level guarantee only.
      for (const issue of parsed.error.issues) {
        defects.push({
          path: `${at}.manifest.${issue.path.join(".")}`,
          message: issue.message,
        });
      }
      continue;
    }
    for (const message of manifestDefects(parsed.data)) {
      defects.push({ path: `${at}.manifest`, message });
    }
    for (const defect of serverProviderDefects(candidate)) {
      defects.push({ path: `${at}.${defect.path}`, message: defect.message });
    }

    const claim = (map: Map<string, string>, key: string, field: string) => {
      const owner = map.get(key);
      if (owner !== undefined) {
        defects.push({
          path: `${at}.manifest.${field}`,
          message:
            `${key} is already claimed by ${owner}; a duplicate means one provider shadows the other at lookup time.`,
        });
        return;
      }
      map.set(key, candidate.manifest.integrationId);
    };
    claim(bySlug, candidate.manifest.slug, "slug");
    claim(byIntegrationId, candidate.manifest.integrationId, "integrationId");
    claim(byUuid, candidate.manifest.providerUuid, "providerUuid");
    providers.push(candidate);
  }

  if (defects.length > 0) {
    // The integration tier's error carries a stable code per defect and this tier's
    // does not, so every provider defect is reported under one code: what a person
    // acts on is the path and the message, and inventing per-defect codes here
    // would be a second vocabulary for the same faults.
    throw new IntegrationActivationError(
      defects.map((defect) => ({
        code: "provider-defect",
        path: defect.path,
        message: defect.message,
      })),
    );
  }
  return activatedProviders(providers);
}

/**
 * The activated list and its lookups.
 *
 * Frozen, because a caller that mutated this list would change what the gate routes
 * to at runtime with nothing to show a reviewer. A `Map` rather than an object
 * literal for the same reason the integration registry uses one: a slug arriving
 * from a request is hostile input, and an object would answer `constructor`.
 */
export function activatedProviders(
  providers: readonly ServerProvider<ProviderManifest>[],
): ActivatedProviders {
  const frozen = Object.freeze([...providers]);
  const slugIndex = new Map(frozen.map((p) => [p.manifest.slug, p]));
  const idIndex = new Map(frozen.map((p) => [p.manifest.integrationId, p]));
  return Object.freeze({
    providers: frozen,
    get(slug: string) {
      return slugIndex.get(slug);
    },
    getByIntegrationId(integrationId: string) {
      return idIndex.get(integrationId);
    },
  });
}

/** The activated provider set, as the registry hands it to the server. */
export type ActivatedProviders = Readonly<{
  providers: readonly ServerProvider<ProviderManifest>[];
  /** The provider naming a slug, or `undefined` when the slug is not deployed. */
  get(slug: string): ServerProvider<ProviderManifest> | undefined;
  /** The provider naming a gate id, or `undefined` when it is not deployed. */
  getByIntegrationId(
    integrationId: string,
  ): ServerProvider<ProviderManifest> | undefined;
}>;
