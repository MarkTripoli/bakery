import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { deployedProviderSlugs } from "../../apps/server/src/modules/integrations/registry.ts";

const providerOptions = (schema: unknown): readonly string[] =>
  (schema as { shape: { provider: { options: readonly string[] } } }).shape
    .provider.options;

for (
  const [name, schema] of [
    ["IntegrationConnection", contractSchemas.IntegrationConnection],
    ["IntegrationAuthAttempt", contractSchemas.IntegrationAuthAttempt],
  ] as const
) {
  Deno.test(`${name}.provider names every provider this build registers`, () => {
    const options = providerOptions(schema);
    assertEquals(
      deployedProviderSlugs().filter((slug) => !options.includes(slug)),
      [],
    );
  });
}
