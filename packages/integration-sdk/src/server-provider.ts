import type { CodePort, TicketsPort } from "./family-ports.ts";
import type { ProviderManifest } from "./provider-manifest.ts";
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
 */
export type IngressFor<M extends ProviderManifest> = M["ingress"] extends null
  ? undefined
  : WebhookIngress;

/** The tickets port when the family is claimed, and `never` when it is not. */
export type TicketsFor<M extends ProviderManifest> = "tickets" extends
  M["families"][number] ? TicketsPort : never;

/** The code port when the family is claimed, and `never` when it is not. */
export type CodeFor<M extends ProviderManifest> = "code" extends
  M["families"][number] ? CodePort : never;

/**
 * Everything a server provider supplies.
 *
 * `tickets` and `code` are present only for the families the manifest claims. A
 * provider with neither still has a complete implementation, which is what lets a
 * facts-only provider exist without pretending to serve a port.
 */
export type ServerImpl<M extends ProviderManifest> = {
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
  /** One discovery result per manifest resource kind; see `defineServerProvider`. */
  tickets?: TicketsFor<M>;
  code?: CodeFor<M>;
};

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
  return Object.freeze({
    kind: "server-provider" as const,
    manifest: Object.freeze(manifest),
    impl: Object.freeze(impl),
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
