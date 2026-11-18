/**
 * Bakery's own webhook signature for event export (issue #21).
 *
 * GitHub's inbound signature covers the raw body and nothing else, which is
 * what GitHub sends, so it stays exactly as it is in `intake-signature.ts`.
 * That form has one weakness a receiver cannot close on its own: a captured
 * request stays valid forever, because nothing about it is time-bounded.
 *
 * The catalog's stated policy for native webhooks is therefore wider - the HMAC
 * covers the timestamp, the delivery ID *and* the raw body - and this file
 * implements that half. Covering the timestamp makes an old request expire;
 * covering the delivery ID binds the signature to one delivery, so a signature
 * cannot be lifted onto a different one even if both carry the same body.
 *
 * The value is `sha256=<64 lowercase hex>`, the same shape GitHub uses, so a
 * receiver's existing header handling does not have to be two-headed.
 */

/** Allowance for clocks that disagree, in seconds. Mirrors `slack-identity.ts`. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The header carrying the signature, matching GitHub's spelling. */
export const SIGNATURE_HEADER = "x-bakery-signature-256";

/** The header carrying the Unix-seconds timestamp the signature covers. */
export const TIMESTAMP_HEADER = "x-bakery-timestamp";

/** The header carrying the delivery identity the signature covers. */
export const DELIVERY_HEADER = "x-bakery-delivery";

/** Exactly `sha256=` and 64 lowercase hex digits; uppercase and padding are refused. */
const SIGNATURE_VALUE = /^sha256=([0-9a-f]{64})$/;

/** A timestamp is whole Unix seconds, no sign, no fraction, no whitespace. */
const TIMESTAMP_VALUE = /^[0-9]{1,12}$/;

/**
 * A delivery identity is bounded and restricted to characters that cannot
 * change the meaning of the signing string when concatenated into it. In
 * particular it cannot contain the `.` separator, so `a.b` + `c` and `a` +
 * `b.c` cannot produce one signing string.
 */
const DELIVERY_VALUE = /^[A-Za-z0-9_-]{1,128}$/;

const SHA256_BYTES = 32;

// Standard order, so `hex[byte >> 4]` is the standard digit. A scrambled
// table still round-trips against itself and would have looked correct.
const HEX_DIGITS = "0123456789abcdef";

const text = new TextEncoder();

export type SignatureRefusal =
  /** The timestamp header is missing or not whole Unix seconds. */
  | "missing_timestamp"
  /** The timestamp is outside the tolerance window, in either direction. */
  | "stale_timestamp"
  /** The delivery header is missing or not a bounded, separator-free token. */
  | "missing_delivery"
  /** The signature header is missing or not the exact documented form. */
  | "missing_signature"
  /** The signature did not verify under the key. */
  | "bad_signature";

export type SignatureVerdict =
  | { readonly ok: true; readonly deliveryId: string }
  | { readonly ok: false; readonly reason: SignatureRefusal };

const refused = (reason: SignatureRefusal): SignatureVerdict => ({
  ok: false,
  reason,
});

/** Decodes `sha256=<hex>` to its 32 digest bytes, or null for any other form. */
export function parseSignatureBytes(
  value: string | null,
): Uint8Array<ArrayBuffer> | null {
  if (value === null) return null;
  const match = SIGNATURE_VALUE.exec(value);
  if (match === null) return null;
  const hex = match[1]!;
  const bytes = new Uint8Array(SHA256_BYTES);
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    const high = HEX_DIGITS.indexOf(hex[index * 2]!);
    const low = HEX_DIGITS.indexOf(hex[index * 2 + 1]!);
    if (high < 0 || low < 0) return null;
    bytes[index] = high * 16 + low;
  }
  return bytes;
}

/**
 * The exact bytes the HMAC covers: the timestamp, the delivery ID and the raw
 * body, joined so that no pair of inputs can be rearranged into another valid
 * message. The two separators are outside both value grammars above (a
 * timestamp is digits only, a delivery ID cannot contain `.`), so the split
 * between the three parts is unambiguous.
 */
export function signingMessage(
  timestamp: string,
  deliveryId: string,
  raw: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const prefix = text.encode(`${timestamp}.${deliveryId}.`);
  const message = new Uint8Array(prefix.byteLength + raw.byteLength);
  message.set(prefix, 0);
  message.set(raw, prefix.byteLength);
  return message;
}

/** True when `timestamp` is within `tolerance` seconds of `nowSeconds`. */
export function isFresh(
  timestamp: number,
  nowSeconds: number,
  tolerance: number = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  const difference = nowSeconds - timestamp;
  // A future timestamp is refused too: a receiver that accepted it would be
  // holding a signature that becomes valid later, which is a replay window a
  // sender can open deliberately.
  return Math.abs(difference) <= tolerance;
}

/**
 * Verifies one native webhook delivery.
 *
 * Every check that can be answered from the headers is answered before the
 * secret is used, and every refusal names the check that failed so an operator
 * can tell a stale clock from a wrong secret - but the reason is *not* returned
 * to the caller, who must answer every refusal identically.
 */
export async function verifyWebhookSignature(input: {
  readonly headers: {
    readonly timestamp: string | null;
    readonly delivery: string | null;
    readonly signature: string | null;
  };
  readonly raw: Uint8Array<ArrayBuffer>;
  readonly secret: Uint8Array<ArrayBuffer>;
  readonly nowSeconds: number;
  readonly tolerance?: number;
}): Promise<SignatureVerdict> {
  const { timestamp, delivery, signature } = input.headers;

  if (timestamp === null || !TIMESTAMP_VALUE.test(timestamp)) {
    return refused("missing_timestamp");
  }
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    !isFresh(seconds, input.nowSeconds, input.tolerance)
  ) return refused("stale_timestamp");

  if (delivery === null || !DELIVERY_VALUE.test(delivery)) {
    return refused("missing_delivery");
  }

  const provided = parseSignatureBytes(signature);
  if (provided === null) return refused("missing_signature");

  // An empty secret must never verify: Web Crypto cannot import a zero-length
  // HMAC key, and treating that failure as a match would make an unconfigured
  // secret authenticate everything.
  if (input.secret.byteLength === 0) return refused("bad_signature");

  const key = await crypto.subtle.importKey(
    "raw",
    input.secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    provided,
    signingMessage(timestamp, delivery, input.raw),
  );
  return valid ? { ok: true, deliveryId: delivery } : refused("bad_signature");
}

/**
 * Signs one delivery. Present so the sender and the receiver cannot disagree
 * about what the signature covers: both call this shape of message.
 */
export async function signWebhookDelivery(input: {
  readonly timestamp: number;
  readonly deliveryId: string;
  readonly raw: Uint8Array<ArrayBuffer>;
  readonly secret: Uint8Array<ArrayBuffer>;
}): Promise<string> {
  // The signer refuses exactly what the verifier refuses, so a sender cannot
  // produce a signature that no correct receiver will accept. Without this the
  // asymmetry is silent: a delivery ID containing a separator would sign
  // happily and then fail to verify, and the failure would look like a wrong
  // secret at the far end rather than a malformed ID here.
  if (!DELIVERY_VALUE.test(input.deliveryId)) {
    throw new TypeError("invalid_delivery_identity");
  }
  // Bounded exactly as the verifier bounds it: 1 to 12 digits. A 13-digit
  // timestamp is a safe integer, so without this bound the signer would accept
  // a value the verifier can never match - the same silent asymmetry the
  // delivery-ID check above closes.
  if (
    !Number.isSafeInteger(input.timestamp) || input.timestamp < 0 ||
    String(input.timestamp).length > 12
  ) {
    throw new TypeError("invalid_timestamp");
  }
  if (input.secret.byteLength === 0) {
    // Signing under an empty key would produce a value that cannot verify, so
    // it is refused here rather than discovered at the receiver.
    throw new TypeError("empty_signing_secret");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    input.secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      signingMessage(String(input.timestamp), input.deliveryId, input.raw),
    ),
  );
  let hex = "";
  for (const byte of signature) {
    hex += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 15]!;
  }
  return `sha256=${hex}`;
}
