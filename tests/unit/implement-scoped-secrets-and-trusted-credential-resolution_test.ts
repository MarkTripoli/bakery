import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { readRuntimeConfig } from "@bakery/config";
import {
  decryptSecret,
  encryptSecret,
  loadSecretKey,
} from "../../apps/server/src/modules/secrets/crypto.ts";
import { rejectCredentialMetadata } from "../../apps/server/src/modules/secrets/redaction.ts";
import { verifyGitHubCredential } from "../../apps/server/src/modules/secrets/broker.ts";

Deno.test("mounted key availability has no auth-secret fallback and workers receive no key", async () => {
  const env = {
    BAKERY_ENV: "test",
    BETTER_AUTH_SECRET: "fixture-auth-secret".repeat(3),
  };
  assertEquals(readRuntimeConfig(env).secretsKey, undefined);
  for (
    const configured of [
      { BAKERY_SECRETS_KEY_FILE: "", BAKERY_SECRETS_KEY_ID: "" },
      { BAKERY_SECRETS_KEY_FILE: "/fixture/key" },
      { BAKERY_SECRETS_KEY_ID: "fixture-id" },
    ]
  ) {
    const invalid = readRuntimeConfig({ ...env, ...configured }).invalidConfig;
    assert(invalid.includes("BAKERY_SECRETS_KEY_FILE"));
    assert(invalid.includes("BAKERY_SECRETS_KEY_ID"));
  }
  assertEquals(
    readRuntimeConfig({
      ...env,
      BAKERY_SECRETS_KEY_ID: "fixture-id",
      BAKERY_SECRETS_KEY_FILE: "/fixture/key",
    }, "worker").secretsKey,
    undefined,
  );
  await assertRejects(() => loadSecretKey());
});
Deno.test("AES-GCM first version authenticates scope revision key identity and immutable bytes", async () => {
  const directory = await Deno.makeTempDir();
  const file = `${directory}/key`;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    await Deno.writeFile(file, raw);
    const key = await loadSecretKey({ file, keyId: "fixture-v1" });
    const binding = {
      organizationId: crypto.randomUUID(),
      applicationId: crypto.randomUUID(),
      secretId: crypto.randomUUID(),
      revision: 1,
      keyId: "fixture-v1",
    };
    const value = crypto.randomUUID();
    const cipher = await encryptSecret(key, binding, value);
    const plain = await decryptSecret(key, binding, cipher);
    assert(new TextDecoder().decode(plain) === value);
    plain.fill(0);
    const changed = cipher.ciphertext.slice();
    changed[0] ^= 1;
    await assertRejects(() =>
      decryptSecret(key, binding, { ...cipher, ciphertext: changed })
    );
    const nonce = cipher.nonce.slice();
    nonce[0] ^= 1;
    await assertRejects(() =>
      decryptSecret(key, binding, { ...cipher, nonce })
    );
    for (
      const patch of [
        { organizationId: crypto.randomUUID() },
        { applicationId: crypto.randomUUID() },
        { secretId: crypto.randomUUID() },
        { revision: 2 },
        { keyId: "fixture-v2" },
      ]
    ) {
      await assertRejects(() =>
        decryptSecret(key, { ...binding, ...patch }, cipher)
      );
    }
    await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)));
    const wrong = await loadSecretKey({ file, keyId: "fixture-v1" });
    await assertRejects(() => decryptSecret(wrong, binding, cipher));
    for (const size of [0, 31, 33, 100]) {
      await Deno.writeFile(file, new Uint8Array(size));
      await assertRejects(() => loadSecretKey({ file, keyId: "fixture-v1" }));
    }
  } finally {
    raw.fill(0);
    await Deno.remove(directory, { recursive: true });
  }
});
Deno.test("credential echoes and encoded variants never become display metadata", () => {
  const value = `canary-${crypto.randomUUID()}`;
  for (
    const candidate of [
      value,
      encodeURIComponent(value),
      btoa(value),
      Array.from(
        new TextEncoder().encode(value),
        (b) => b.toString(16).padStart(2, "0"),
      ).join(""),
    ]
  ) assertThrows(() => rejectCredentialMetadata(candidate, value));
  for (
    const candidate of [
      "Bearer private",
      "github_pat_private",
      "ghp_private",
      "token=private",
    ]
  ) assertThrows(() => rejectCredentialMetadata(candidate));
  rejectCredentialMetadata("Deployment credential", value);
});
Deno.test("fixed provider discards extras and rejects redirects oversized bodies malformed identity and abort", async () => {
  const credential = `canary-${crypto.randomUUID()}`;
  const signal = new AbortController().signal;
  let calls = 0;
  const identity = await verifyGitHubCredential(
    credential,
    signal,
    (url, options) => {
      calls++;
      assertEquals(String(url), "https://api.github.com/user");
      assertEquals(options?.redirect, "error");
      assertEquals(options?.method, "GET");
      return Promise.resolve(Response.json({
        id: 42,
        login: "fixture-user",
        private: credential,
      }));
    },
  );
  assertEquals(identity, {
    provider: "github",
    action: "identity.read",
    accountId: "42",
    login: "fixture-user",
  });
  assertEquals(calls, 1);
  for (
    const response of [
      new Response(credential, { status: 401 }),
      new Response(null, { status: 302 }),
      new Response("x".repeat(65537)),
      Response.json({ id: 0, login: "fixture" }),
      Response.json({ id: 1, login: credential }),
      Response.json({ id: 1, login: "ghp_private" }),
      Response.json({ id: Number.MAX_SAFE_INTEGER + 1, login: "fixture" }),
    ]
  ) {
    await assertRejects(() =>
      verifyGitHubCredential(
        credential,
        signal,
        () => Promise.resolve(response),
      )
    );
  }
  const controller = new AbortController();
  controller.abort();
  await assertRejects(() =>
    verifyGitHubCredential(
      credential,
      controller.signal,
      () => Promise.resolve(Response.json({ id: 1, login: "fixture" })),
    )
  );
});

Deno.test("provider body stall is bounded by request abort without another attempt", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assertRejects(() =>
      verifyGitHubCredential(crypto.randomUUID(), controller.signal, () => {
        calls++;
        return Promise.resolve(new Response(body));
      })
    );
    assertEquals(calls, 1);
    assert(cancelled);
  } finally {
    clearTimeout(timer);
  }
});

Deno.test("revoke normalized natural replay binds canonical scope and quoted metadata version", async () => {
  const { createSecretsActionRegistry } = await import(
    "../../apps/server/src/modules/secrets/actions.ts"
  );
  const { createNormalizedCommandMetadata } = await import(
    "../../packages/contracts/src/http.ts"
  );
  const { contractSchemas } = await import(
    "../../packages/contracts/src/contracts.ts"
  );
  const { commandFingerprint } = await import(
    "../../apps/server/src/platform/command-replay.ts"
  );
  const action = createSecretsActionRegistry({
    run: (_a, c, _i, next) => next(c),
  }, "fixture-key").list().find((a) => a.name === "secrets.revoke")!;
  const id = crypto.randomUUID(), applicationId = crypto.randomUUID();
  const input = contractSchemas.SecretRevoke.parse({
    id,
    applicationId,
  });
  const normalize = (ifMatch?: string) =>
    createNormalizedCommandMetadata(
      action,
      new Request(`http://fixture.test/v1/secrets/${id}`, {
        method: "DELETE",
        headers: ifMatch ? { "If-Match": ifMatch } : {},
      }),
      { id: id.toUpperCase() },
      input,
    );
  const metadata = normalize('"v2"');
  assertEquals(input, { id, applicationId });
  assertEquals(metadata.expectedVersion, 2);
  assertEquals(
    metadata.idempotencyKey,
    `natural:secrets.revoke:/v1/secrets/${id}`,
  );
  assertEquals(normalize().expectedVersion, undefined); // Revoke authority guard enforces omission before replay.
  for (const header of ["2", 'W/"v2"', "*", '"v0"', '"v2147483648"']) {
    assertThrows(() => normalize(header));
  }
  const original = await commandFingerprint({ metadata, input });
  assert(
    original !==
      await commandFingerprint({ metadata: normalize('"v1"'), input }),
  );
  assert(
    original !==
      await commandFingerprint({
        metadata,
        input: { ...input, applicationId: crypto.randomUUID() },
      }),
  );
});
