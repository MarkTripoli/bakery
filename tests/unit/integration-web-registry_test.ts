import { assert, assertEquals } from "@std/assert";
import {
  PROVIDER_IDENTITIES,
} from "../../apps/server/src/modules/integrations/registry.ts";
import {
  WEB_PROVIDER_SLUGS,
  WEB_PROVIDERS,
  webProviderFor,
} from "../../apps/web/src/integrations/registry.ts";
import { webProviderDefects } from "@bakery/integration-sdk/web";
import { catalogs, createTranslator, englishCatalog } from "@bakery/i18n";
import { supportedLocales } from "@bakery/i18n";

/**
 * The web registry is the one web file that may import a provider `/web` entry
 * (rail B1b), and it cannot check its own slugs: importing the server registry
 * from `apps/web` would drag provider server code into the browser bundle. So the
 * parity is asserted here, in the one place allowed to import both - a test, which
 * never ships.
 *
 * What would go wrong without this: a provider deployed on the server but missing
 * from the web registry renders as a connection with no vocabulary, and a slug in
 * the web registry with no server provider is a picker that can never connect.
 */
/**
 * The provider packages this build ships, found rather than listed.
 *
 * Not "every deployed provider": GitHub's driver still lives inside core
 * (`apps/server/src/modules/catalog/integration-providers/github.ts`, on the
 * boundary ledger's pending list) and has no package to take a `/web` entry from.
 * Scanning is what makes this test future-proof in the useful direction: the day
 * GitHub's package lands with a web entry, the registry has to gain a line or this
 * fails. A hardcoded expectation would instead need editing in the same commit,
 * which proves nothing.
 */
async function packagedProviders(): Promise<string[]> {
  const slugs: string[] = [];
  const root = new URL("../../packages/", import.meta.url);
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    const match = /^integration-(.+)$/.exec(entry.name);
    if (match === null) continue;
    for await (
      const candidate of walk(new URL(`${entry.name}/src/web/`, root))
    ) {
      if (candidate === "mod.ts") slugs.push(match[1]);
    }
  }
  return slugs.sort();
}

async function* walk(dir: URL): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) yield entry.name;
      else if (entry.isDirectory) yield* walk(new URL(`${entry.name}/`, dir));
    }
  } catch {
    // A package with no web tier is a package with nothing to render.
  }
}

Deno.test("the web registry names every packaged provider, and nothing else", async () => {
  assertEquals(
    [...WEB_PROVIDER_SLUGS].sort(),
    await packagedProviders(),
    "a packaged provider with a web entry must appear in the web registry",
  );
});

Deno.test("every web module's slug is a provider this build deploys", () => {
  const deployed = new Set<string>(
    PROVIDER_IDENTITIES.map((identity) => identity.slug as string),
  );
  for (const slug of WEB_PROVIDER_SLUGS) {
    assert(
      deployed.has(slug),
      `${slug} has a web module but no deployed provider: the picker could never connect it`,
    );
  }
});

Deno.test("each web module's manifest is the one its provider is deployed with", () => {
  for (const identity of PROVIDER_IDENTITIES) {
    const module = webProviderFor(identity.slug);
    // GitHub has no package yet, so there is no web module to compare; the test
    // above is what makes that absence visible rather than forgotten.
    if (!WEB_PROVIDER_SLUGS.includes(identity.slug)) continue;
    assert(module !== null, `${identity.slug} has a web module`);
    // The manifest travels with the module, so the web tier reads the same slug,
    // uuid and connect arm the server registered; a copy would be a second truth.
    assertEquals(module.manifest.slug, identity.slug);
    assertEquals(module.manifest.providerUuid, identity.uuid);
    assertEquals(module.manifest.integrationId, identity.gateId);
  }
});

Deno.test("every web module is well formed for its connect arm", () => {
  for (const module of WEB_PROVIDERS) {
    assertEquals(
      webProviderDefects(module),
      [],
      `${module.manifest.slug} must satisfy its connect arm`,
    );
  }
});

Deno.test("a slug this build does not deploy is answered as absent, not thrown", () => {
  // A connection row can outlive the provider that wrote it, and the settings page
  // has to render that connection rather than blank out.
  assertEquals(webProviderFor("linear"), WEB_PROVIDERS[0]);
  assertEquals(webProviderFor("github-app-removed"), null);
  assertEquals(webProviderFor(""), null);
});

/**
 * The provider's copy is a message, not a sentence.
 *
 * A provider that returned English would put untranslated text on a translated
 * page, and nothing would fail: the string renders. So every message a module
 * hands the host is checked against the catalog in every locale this build ships,
 * and translated with its own arguments to prove the placeholders fill.
 */
Deno.test("every message a web module returns is a catalog key in every locale", () => {
  for (const module of WEB_PROVIDERS) {
    const messages = [
      module.describeResource?.({
        externalId: "1",
        resourceKindId: "project",
        name: "Payments",
      }),
      module.describeResource?.({
        externalId: "2",
        resourceKindId: "team",
        name: "ENG",
      }),
      module.describePermission?.("read", "read"),
      module.describePermission?.("write", "write"),
      module.describePermission?.("admin", "admin"),
    ].filter((message) => message !== undefined);

    assert(
      messages.length > 0,
      `${module.manifest.slug} describes something, or the hooks are dead code`,
    );
    // Two levels that read the same tell a person nothing about what the wider
    // one grants, which is the whole reason the hook takes a level.
    const read = module.describePermission?.("read", "read");
    const write = module.describePermission?.("write", "write");
    if (read !== undefined && write !== undefined) {
      assert(
        read.key !== write.key,
        `${module.manifest.slug}: read and write must not share a sentence`,
      );
    }
    // A scope the provider does not use is named, not swallowed: the person is
    // being asked to grant it.
    const other = module.describePermission?.("admin", "admin");
    if (other !== undefined) {
      assert(
        createTranslator({ locale: "en" })(other.key, { ...other.arguments })
          .includes("admin"),
        `${module.manifest.slug}: an unused scope must be named in its message`,
      );
    }
    for (const message of messages) {
      assert(
        message.key in englishCatalog,
        `${module.manifest.slug}: ${message.key} is not in the English catalog`,
      );
      for (const locale of supportedLocales) {
        assert(
          catalogs[locale][message.key] !== undefined,
          `${module.manifest.slug}: ${message.key} is missing from ${locale}`,
        );
        const rendered = createTranslator({ locale })(message.key, {
          ...message.arguments,
        });
        assert(
          !rendered.includes("{"),
          `${module.manifest.slug}: ${message.key} left a placeholder in ${locale}: ${rendered}`,
        );
      }
    }
  }
});
