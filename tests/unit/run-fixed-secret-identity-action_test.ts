import { assert, assertEquals, assertRejects } from "@std/assert";
import { readRuntimeConfig } from "@bakery/config";
import { createSecretIdentityProviderFixtureFetch } from "../../apps/server/src/main.ts";
import { registerSecretIdentityContractTests } from "../helpers/secret-identity-contract.ts";

registerSecretIdentityContractTests("unit fixed secret identity");

Deno.test("controlled provider fixture is local-only and preserves the fixed request", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-provider-fixture-",
  });
  const file = `${directory}/identity.json`;
  await Deno.writeTextFile(
    file,
    JSON.stringify({ id: 12345, login: "fixture-user" }),
  );
  try {
    const env = {
      BAKERY_ENV: "development",
      BAKERY_APP_DATABASE_URL: "postgres://bakery_app@127.0.0.1/bakery",
      BETTER_AUTH_SECRET: "fixture-auth-secret".repeat(3),
      BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE: file,
    };
    const config = readRuntimeConfig(env);
    assertEquals(config.secretIdentityProviderFixture, { file });
    const fetcher = createSecretIdentityProviderFixtureFetch(config);
    assert(fetcher);
    const response = await fetcher("https://api.github.com/user", {
      method: "GET",
      redirect: "error",
      headers: { Authorization: "Bearer controlled" },
    });
    assertEquals(await response.json(), { id: 12345, login: "fixture-user" });
    await assertRejects(() =>
      fetcher("https://example.test/user", {
        method: "GET",
        redirect: "error",
        headers: { Authorization: "Bearer controlled" },
      })
    );
    const production = readRuntimeConfig({
      ...env,
      BAKERY_ENV: "production",
      BAKERY_PUBLIC_BASE_URL: "https://bakery.example.test",
      INNGEST_URL: "https://inngest.example.test",
      INNGEST_SIGNING_KEY: "s".repeat(32),
      INNGEST_EVENT_KEY: "fixture-event",
    });
    assert(
      production.invalidConfig.includes(
        "BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE",
      ),
    );
    assertEquals(production.secretIdentityProviderFixture, undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
