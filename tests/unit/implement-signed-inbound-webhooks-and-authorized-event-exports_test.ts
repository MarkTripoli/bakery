import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  isFresh,
  parseSignatureBytes,
  SIGNATURE_TOLERANCE_SECONDS,
  signingMessage,
  signWebhookDelivery,
  verifyWebhookSignature,
} from "../../apps/server/src/modules/integrations/webhook-signature.ts";

/**
 * Slice 2 of issue #21: the native webhook HMAC covers timestamp, delivery ID
 * and raw body.
 *
 * AC1 is "stale signatures / changed duplicate delivery / forged
 * actor-or-organization fields => no unauthorized task or run admitted". The
 * forged-field half is refused earlier, by never reading authority out of a
 * body; this file covers the other two, which are properties of the signature.
 *
 * GitHub's own inbound form (raw body only, no timestamp) is deliberately not
 * changed here and is still covered by the existing intake tests.
 */

const secret = new TextEncoder().encode("a-shared-secret-of-decent-length");
const raw = new TextEncoder().encode('{"event":"issue.opened"}');
const now = 1_700_000_000;

async function signed(
  overrides: {
    timestamp?: number;
    deliveryId?: string;
    body?: Uint8Array<ArrayBuffer>;
    key?: Uint8Array<ArrayBuffer>;
  } = {},
): Promise<{ timestamp: string; delivery: string; signature: string }> {
  const timestamp = overrides.timestamp ?? now;
  const delivery = overrides.deliveryId ?? "delivery-1";
  const body = overrides.body ?? raw;
  return {
    timestamp: String(timestamp),
    delivery,
    signature: await signWebhookDelivery({
      timestamp,
      deliveryId: delivery,
      raw: body,
      secret: overrides.key ?? secret,
    }),
  };
}

async function verify(
  headers: {
    timestamp: string | null;
    delivery: string | null;
    signature: string | null;
  },
  options: { body?: Uint8Array<ArrayBuffer>; at?: number } = {},
) {
  return await verifyWebhookSignature({
    headers,
    raw: options.body ?? raw,
    secret,
    nowSeconds: options.at ?? now,
  });
}

Deno.test("a correctly signed, fresh delivery is accepted", async () => {
  const verdict = await verify(await signed());
  assertEquals(verdict, { ok: true, deliveryId: "delivery-1" });
});

Deno.test("a stale timestamp is refused even though the signature is genuine", async () => {
  // Signed correctly, delivered after the window has closed. This is the exact
  // case GitHub's body-only form cannot refuse.
  const headers = await signed({
    timestamp: now - SIGNATURE_TOLERANCE_SECONDS - 1,
  });
  const verdict = await verify(headers, { at: now });
  assertEquals(verdict, { ok: false, reason: "stale_timestamp" });
});

Deno.test("a future timestamp is refused, not deferred", async () => {
  // A receiver that accepted this would be holding a signature that becomes
  // valid later, which is a replay window a sender can open on purpose.
  const headers = await signed({
    timestamp: now + SIGNATURE_TOLERANCE_SECONDS + 1,
  });
  const verdict = await verify(headers, { at: now });
  assertEquals(verdict, { ok: false, reason: "stale_timestamp" });
});

Deno.test("a signature lifted onto another delivery ID is refused", async () => {
  // Same body, same timestamp, same secret: only the delivery differs. Covering
  // the delivery in the message is what makes this fail.
  const headers = await signed({ deliveryId: "delivery-1" });
  const verdict = await verify({ ...headers, delivery: "delivery-2" });
  assertEquals(verdict, { ok: false, reason: "bad_signature" });
});

Deno.test("a changed body under a genuine signature is refused", async () => {
  const headers = await signed();
  const verdict = await verify(headers, {
    body: new TextEncoder().encode('{"event":"issue.closed"}'),
  });
  assertEquals(verdict, { ok: false, reason: "bad_signature" });
});

Deno.test("the wrong secret is refused", async () => {
  const headers = await signed({
    key: new TextEncoder().encode("a-different-secret-of-decent-length"),
  });
  assertEquals(await verify(headers), { ok: false, reason: "bad_signature" });
});

Deno.test("an empty secret never verifies", async () => {
  // Web Crypto cannot import a zero-length HMAC key. Treating that failure as a
  // match would let an unconfigured secret authenticate every delivery.
  const empty = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
  const signature = await signWebhookDelivery({
    timestamp: now,
    deliveryId: "delivery-1",
    raw,
    // Signing with an empty key also fails, so the forged value is built by
    // hand: it must still be refused.
    secret: secret,
  });
  const verdict = await verifyWebhookSignature({
    headers: { timestamp: String(now), delivery: "delivery-1", signature },
    raw,
    secret: empty,
    nowSeconds: now,
  });
  assertEquals(verdict, { ok: false, reason: "bad_signature" });
});

Deno.test("malformed headers are refused before the secret is used", async () => {
  const good = await signed();

  assertEquals(
    await verify({ ...good, timestamp: null }),
    { ok: false, reason: "missing_timestamp" },
  );
  assertEquals(
    await verify({ ...good, timestamp: "1.5" }),
    { ok: false, reason: "missing_timestamp" },
  );
  assertEquals(
    await verify({ ...good, timestamp: " 1700000000" }),
    { ok: false, reason: "missing_timestamp" },
  );
  assertEquals(
    await verify({ ...good, delivery: null }),
    { ok: false, reason: "missing_delivery" },
  );
  // The separator cannot appear in a delivery ID, so no two messages can be
  // rearranged into one another's signing string.
  assertEquals(
    await verify({ ...good, delivery: "a.b" }),
    { ok: false, reason: "missing_delivery" },
  );
  assertEquals(
    await verify({ ...good, signature: null }),
    { ok: false, reason: "missing_signature" },
  );
  // Uppercase hex, a missing prefix and a short digest are all refused.
  assertEquals(
    await verify({ ...good, signature: good.signature.toUpperCase() }),
    { ok: false, reason: "missing_signature" },
  );
  assertEquals(
    await verify({ ...good, signature: good.signature.slice(7) }),
    { ok: false, reason: "missing_signature" },
  );
  assertEquals(
    await verify({ ...good, signature: "sha256=abc" }),
    { ok: false, reason: "missing_signature" },
  );
});

Deno.test("the signer refuses what the verifier would refuse", async () => {
  // The asymmetry this closes is silent in production: a delivery ID the
  // verifier rejects would sign happily, and the receiver would report a wrong
  // secret rather than a malformed ID.
  for (
    const deliveryId of ["a.b", "", "with space", "a".repeat(129), "semi;colon"]
  ) {
    await assertRejects(
      () => signWebhookDelivery({ timestamp: now, deliveryId, raw, secret }),
      TypeError,
      "invalid_delivery_identity",
    );
  }

  // The boundary the verifier accepts must still sign: 128 characters, and the
  // full alphabet it allows.
  const longest = "A".repeat(96) + "_".repeat(16) + "z1".repeat(8);
  assertEquals(longest.length, 128);
  assert((await signWebhookDelivery({
    timestamp: now,
    deliveryId: longest,
    raw,
    secret,
  })).startsWith("sha256="));
});

Deno.test("the signer refuses a timestamp or secret it cannot honestly sign", async () => {
  await assertRejects(
    () => signWebhookDelivery({ timestamp: -1, deliveryId: "d", raw, secret }),
    TypeError,
    "invalid_timestamp",
  );
  await assertRejects(
    () =>
      signWebhookDelivery({
        timestamp: 1.5,
        deliveryId: "d",
        raw,
        secret,
      }),
    TypeError,
    "invalid_timestamp",
  );
  await assertRejects(
    () =>
      signWebhookDelivery({
        timestamp: now,
        deliveryId: "d",
        raw,
        secret: new Uint8Array(0) as Uint8Array<ArrayBuffer>,
      }),
    TypeError,
    "empty_signing_secret",
  );
});

Deno.test("the signature is stable across calls, so a sender can retry", async () => {
  // Deterministic HMAC: the same delivery signed twice must produce the same
  // value, or a retry would look like a forgery to a receiver that compares.
  const first = await signed();
  const second = await signed();
  assertEquals(first.signature, second.signature);
});

Deno.test("the signing message covers all three parts unambiguously", () => {
  const message = signingMessage("1700000000", "delivery-1", raw);
  const decoded = new TextDecoder().decode(message);
  assertEquals(decoded, '1700000000.delivery-1.{"event":"issue.opened"}');

  // Shifting a character across the timestamp/delivery boundary must produce a
  // different string, which is what the separator guarantees.
  const shifted = signingMessage("170000000", "0delivery-1", raw);
  assert(
    new TextDecoder().decode(shifted) !== decoded,
    "moving a character across the boundary must change the message",
  );
});

Deno.test("the default tolerance is the documented 300 seconds", () => {
  // Pinned literally, and exercised without passing a tolerance, because a
  // mutant that changed the default to 3000 survived every other test here: they
  // all either pass 300 explicitly or sign at `now`, where any tolerance agrees.
  assertEquals(SIGNATURE_TOLERANCE_SECONDS, 300);
});

Deno.test("the default tolerance is what verification actually applies", async () => {
  // Exactly at the boundary in both directions, through `verifyWebhookSignature`
  // with no tolerance argument: a default that had drifted would accept or
  // refuse these.
  const older = await signed({ timestamp: now - 300 });
  assertEquals(await verify(older, { at: now }), {
    ok: true,
    deliveryId: "delivery-1",
  });
  const tooOld = await signed({ timestamp: now - 301 });
  assertEquals(await verify(tooOld, { at: now }), {
    ok: false,
    reason: "stale_timestamp",
  });
  const newer = await signed({ timestamp: now + 300 });
  assertEquals(await verify(newer, { at: now }), {
    ok: true,
    deliveryId: "delivery-1",
  });
  const tooNew = await signed({ timestamp: now + 301 });
  assertEquals(await verify(tooNew, { at: now }), {
    ok: false,
    reason: "stale_timestamp",
  });
});

Deno.test("freshness is symmetric and inclusive at the boundary", () => {
  assert(isFresh(now, now, 300));
  assert(isFresh(now - 300, now, 300));
  assert(isFresh(now + 300, now, 300));
  assert(!isFresh(now - 301, now, 300));
  assert(!isFresh(now + 301, now, 300));
});

Deno.test("parseSignatureBytes accepts only the exact documented form", () => {
  const bytes = parseSignatureBytes(`sha256=${"deadbeef".repeat(8)}`);
  assertEquals(bytes?.byteLength, 32);
  // Hex decoding is checked at the first four bytes, so a lossy or reversed
  // decode cannot pass by producing the right length.
  assertEquals(Array.from(bytes!.slice(0, 4)), [0xde, 0xad, 0xbe, 0xef]);

  assertEquals(parseSignatureBytes(null), null);
  assertEquals(parseSignatureBytes("sha1=" + "a".repeat(64)), null);
  assertEquals(parseSignatureBytes(`sha256=${"g".repeat(64)}`), null);
  assertEquals(parseSignatureBytes(`sha256=${"a".repeat(63)}`), null);
});
