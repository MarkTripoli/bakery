import { assert, assertEquals } from "@std/assert";
import { openSecretsFixture } from "../helpers/secrets.ts";

Deno.test("a coding agent's model API key is checked once against its provider and stored without an identity", async () => {
  const f = await openSecretsFixture();
  try {
    f.setProvider(() => Promise.resolve(Response.json({ data: [] })));
    const cases = [
      {
        provider: "anthropic",
        url: "https://api.anthropic.com/v1/models",
        sent: (value: string) => value,
      },
      {
        provider: "openai",
        url: "https://api.openai.com/v1/models",
        sent: (value: string) => `Bearer ${value}`,
      },
      {
        provider: "openrouter",
        url: "https://openrouter.ai/api/v1/key",
        sent: (value: string) => `Bearer ${value}`,
      },
    ] as const;
    for (const [index, check] of cases.entries()) {
      const value = `sk-${crypto.randomUUID()}`;
      const created = await f.request("/v1/secrets", {
        applicationId: f.applicationId,
        name: `Model key ${check.provider}`,
        provider: check.provider,
        value,
      }, crypto.randomUUID());
      const body = await created.text();
      assertEquals(created.status, 201, body);
      assert(!body.includes(value), "the key is never answered back");
      const metadata = JSON.parse(body);
      assertEquals(
        [
          metadata.provider,
          metadata.verifiedProviderAccountId,
          metadata.verifiedLogin,
        ],
        [check.provider, null, null],
      );
      assertEquals(f.providerUrls().at(-1), check.url);
      assertEquals(f.providerAuthorizations().at(-1), check.sent(value));
      assertEquals(f.calls(), index + 1);
      const read = await f.client.actions["secrets.get"]({
        applicationId: f.applicationId,
        id: metadata.id,
      });
      assertEquals(read, metadata);
    }
  } finally {
    await f.cleanup();
  }
});

Deno.test("a model API key its provider refuses is not stored", async () => {
  const f = await openSecretsFixture();
  try {
    f.setProvider(() => Promise.resolve(new Response("{}", { status: 401 })));
    const refused = await f.request("/v1/secrets", {
      applicationId: f.applicationId,
      name: "Bad model key",
      provider: "anthropic",
      value: "sk-wrong",
    }, crypto.randomUUID());
    assertEquals(refused.status, 422, await refused.clone().text());
    const stored = await f.fixture.pgDatabase.query<{ count: number }>(
      "select count(*)::int as count from bakery.secrets where name = 'Bad model key'",
    );
    assertEquals(stored.rows[0]!.count, 0);
  } finally {
    await f.cleanup();
  }
});

Deno.test("an unknown provider is refused before anything is sent", async () => {
  const f = await openSecretsFixture();
  try {
    const refused = await f.request("/v1/secrets", {
      applicationId: f.applicationId,
      name: "Elsewhere",
      provider: "example",
      value: "sk-anything",
    }, crypto.randomUUID());
    assert(refused.status >= 400 && refused.status < 500);
    await refused.body?.cancel();
    assertEquals(f.calls(), 0);
  } finally {
    await f.cleanup();
  }
});
