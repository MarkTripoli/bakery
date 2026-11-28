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

Deno.test("rotating a model API key checks the new key with the same provider", async () => {
  const f = await openSecretsFixture();
  try {
    f.setProvider(() => Promise.resolve(Response.json({ data: [] })));
    const created = await f.client.actions["secrets.create"]({
      applicationId: f.applicationId,
      name: "Rotated model key",
      provider: "openai",
      value: `sk-${crypto.randomUUID()}`,
    }, { idempotencyKey: crypto.randomUUID() });
    const calls = f.calls();
    const next = `sk-${crypto.randomUUID()}`;
    const rotated = await f.client.actions["secrets.rotate"]({
      id: created.id,
      applicationId: f.applicationId,
      value: next,
    }, { idempotencyKey: crypto.randomUUID(), ifMatch: '"v1"' });
    assertEquals(rotated.activeVersionRevision, 2);
    assertEquals(
      [
        rotated.provider,
        rotated.verifiedProviderAccountId,
        rotated.verifiedLogin,
      ],
      ["openai", null, null],
    );
    assertEquals(f.calls(), calls + 1);
    assertEquals(f.providerUrls().at(-1), "https://api.openai.com/v1/models");
    assertEquals(f.providerAuthorizations().at(-1), `Bearer ${next}`);

    f.setProvider(() => Promise.resolve(new Response("{}", { status: 401 })));
    const refused = await f.request(
      `/v1/secrets/${created.id}/versions`,
      {
        applicationId: f.applicationId,
        value: "sk-refused",
      },
      crypto.randomUUID(),
      undefined,
      { method: "POST", ifMatch: '"v2"' },
    );
    assertEquals(refused.status, 422, await refused.clone().text());
    const versions = await f.fixture.pgDatabase.query<{ count: number }>(
      "select count(*)::int as count from bakery.secret_versions where secret_id = $1",
      [created.id],
    );
    assertEquals(
      versions.rows[0]!.count,
      2,
      "a refused rotation stores nothing",
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("a model API key longer than the worker can redact is refused on save and rotation", async () => {
  const f = await openSecretsFixture();
  try {
    f.setProvider(() => Promise.resolve(Response.json({ data: [] })));
    const tooLong = "k".repeat(4_097);
    const refusedCreate = await f.request("/v1/secrets", {
      applicationId: f.applicationId,
      name: "Too long model key",
      provider: "openai",
      value: tooLong,
    }, crypto.randomUUID());
    assertEquals(
      refusedCreate.status >= 400 && refusedCreate.status < 500,
      true,
    );
    await refusedCreate.body?.cancel();
    const created = await f.client.actions["secrets.create"]({
      applicationId: f.applicationId,
      name: "Model key to rotate",
      provider: "openai",
      value: "k".repeat(4_096),
    }, { idempotencyKey: crypto.randomUUID() });
    const calls = f.calls();
    const refused = await f.request(
      `/v1/secrets/${created.id}/versions`,
      { applicationId: f.applicationId, value: tooLong },
      crypto.randomUUID(),
      undefined,
      { method: "POST", ifMatch: '"v1"' },
    );
    assertEquals(refused.status, 422, await refused.clone().text());
    const problem = await refused.json() as { issues?: { code: string }[] };
    assertEquals(problem.issues?.map((issue) => issue.code), [
      "model_key_too_long",
    ]);
    assertEquals(f.calls(), calls, "the provider never sees the long key");
  } finally {
    await f.cleanup();
  }
});
