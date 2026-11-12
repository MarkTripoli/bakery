import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  decryptAuthAttemptVerifier,
  decryptSlackIdentityNonce,
  encryptAuthAttemptVerifier,
  encryptSlackIdentityNonce,
  loadSecretKey,
} from "../../apps/server/src/modules/secrets/crypto.ts";

// #12 slice 3: the nonce of a Slack identity attempt is stored as AES-GCM
// ciphertext under its own associated data, the way a GitHub attempt's PKCE
// verifier is. The two must never decrypt as each other.

const KEY_ID = "fixture-v1";

async function withKey(run: (key: CryptoKey) => Promise<void>) {
  const directory = await Deno.makeTempDir();
  try {
    const file = `${directory}/key`;
    await Deno.writeFile(file, crypto.getRandomValues(new Uint8Array(32)));
    await run(await loadSecretKey({ file, keyId: KEY_ID }));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

const binding = () => ({
  organizationId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
  stateHash: "a".repeat(64),
  keyId: KEY_ID,
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

Deno.test("a Slack identity nonce round-trips under its own binding and under nothing else", async () => {
  await withKey(async (key) => {
    const bound = binding();
    const nonce = crypto.randomUUID();
    const cipher = await encryptSlackIdentityNonce(key, bound, nonce);
    assertEquals(
      text(await decryptSlackIdentityNonce(key, bound, cipher)),
      nonce,
    );
    assert(
      !text(cipher.ciphertext).includes(nonce),
      "the nonce is not stored in the clear",
    );
    // Every field of the binding is part of what authenticates it.
    for (
      const patch of [
        { organizationId: crypto.randomUUID() },
        { attemptId: crypto.randomUUID() },
        { stateHash: "b".repeat(64) },
        { keyId: "fixture-v2" },
      ]
    ) {
      await assertRejects(
        () => decryptSlackIdentityNonce(key, { ...bound, ...patch }, cipher),
        Error,
        undefined,
        JSON.stringify(patch),
      );
    }
    // And so is every byte of the ciphertext and of its own nonce.
    const changed = cipher.ciphertext.slice();
    changed[0] ^= 1;
    await assertRejects(() =>
      decryptSlackIdentityNonce(key, bound, { ...cipher, ciphertext: changed })
    );
    const iv = cipher.nonce.slice();
    iv[0] ^= 1;
    await assertRejects(() =>
      decryptSlackIdentityNonce(key, bound, { ...cipher, nonce: iv })
    );
  });
});

Deno.test("a Slack nonce and a GitHub PKCE verifier cannot be swapped, even for the same organization, attempt, state and key", async () => {
  await withKey(async (key) => {
    const bound = binding();
    const slack = await encryptSlackIdentityNonce(key, bound, "slack-nonce");
    const github = await encryptAuthAttemptVerifier(
      key,
      bound,
      "github-verifier",
    );
    await assertRejects(() => decryptAuthAttemptVerifier(key, bound, slack));
    await assertRejects(() => decryptSlackIdentityNonce(key, bound, github));
    assertEquals(
      text(await decryptAuthAttemptVerifier(key, bound, github)),
      "github-verifier",
    );
  });
});

Deno.test("each encryption uses a fresh 96-bit nonce, and a binding that is not well formed is refused", async () => {
  await withKey(async (key) => {
    const bound = binding();
    const first = await encryptSlackIdentityNonce(key, bound, "same");
    const second = await encryptSlackIdentityNonce(key, bound, "same");
    assertEquals(first.nonce.length, 12);
    assertNotEquals(first.nonce, second.nonce);
    assertNotEquals(first.ciphertext, second.ciphertext);
    for (
      const bad of [
        { ...bound, organizationId: "not-a-uuid" },
        { ...bound, attemptId: "" },
        { ...bound, stateHash: "A".repeat(64) },
        { ...bound, stateHash: "a".repeat(63) },
        { ...bound, keyId: "" },
        { ...bound, extra: "field" },
      ]
    ) {
      await assertRejects(() =>
        encryptSlackIdentityNonce(key, bad as never, "x")
      );
    }
  });
});
