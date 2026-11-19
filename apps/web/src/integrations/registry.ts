/**
 * The web registry: the one web file allowed to import a provider's `/web` entry.
 *
 * Rail B1b keeps provider presentation out of the generic web code, which leaves
 * exactly one place that may name a provider module - this file. Everything else
 * asks for a module by slug.
 *
 * The slugs here must be the slugs the server deploys, and nothing in this file
 * can check that: importing the server registry would drag provider server code
 * into the browser bundle, which is the rule this file exists to satisfy. So the
 * parity is asserted by `tests/unit/integration-web-registry_test.ts`, which is
 * allowed to import both.
 */
import type { ProviderWebModule } from "@bakery/integration-sdk/web";
import type { ProviderManifest } from "@bakery/integration-sdk/provider";
import { linearWebProvider } from "@bakery/integration-linear/web";

/** Every provider the web tier can render, one entry each. */
export const WEB_PROVIDERS = Object.freeze(
  [
    linearWebProvider,
  ] as const satisfies readonly ProviderWebModule<ProviderManifest>[],
);

const BY_SLUG: ReadonlyMap<string, ProviderWebModule<ProviderManifest>> =
  new Map(
    WEB_PROVIDERS.map(
      (module: ProviderWebModule<ProviderManifest>) =>
        [module.manifest.slug, module] as const,
    ),
  );

/**
 * The module for a slug, or `null`.
 *
 * `null` rather than a throw: a connection can name a provider this build does not
 * deploy - a row written before a provider was removed - and the settings page
 * has to survive that rather than blank out.
 */
export function webProviderFor(
  slug: string,
): ProviderWebModule<ProviderManifest> | null {
  return BY_SLUG.get(slug) ?? null;
}

/** The slugs this build renders, in registry order. */
export const WEB_PROVIDER_SLUGS: readonly string[] = Object.freeze(
  WEB_PROVIDERS.map(
    (module: ProviderWebModule<ProviderManifest>) => module.manifest.slug,
  ),
);
