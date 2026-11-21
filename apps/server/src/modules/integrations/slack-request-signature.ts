/**
 * Verifying a request that Slack signed, and naming the one thing that makes a
 * replay refusable (#415).
 *
 * Every POST Slack makes to Bakery - an Approve button press, a message in a
 * thread, an event - carries three headers: a Unix-seconds timestamp, a signature
 * and the app's own id. The signature is `v0=` followed by HMAC-SHA256, under the
 * app's signing secret, of the string `v0:{timestamp}:{raw body}`.
 *
 * Three properties follow from that shape, and each one is enforced here rather
 * than assumed:
 *
 * - **The body is covered.** A signature cannot be moved onto a different body,
 *   because the raw bytes are inside the MAC.
 * - **The request expires.** The timestamp is inside the MAC too, so it cannot be
 *   edited to look fresh; a request outside the window is refused no matter how
 *   well it verifies.
 * - **A replay is recognisable.** For a fixed body the signature is a function of
 *   the timestamp alone, so the same request replayed carries the same signature.
 *   That value is the replay key: a caller inserts it under a unique constraint
 *   and a second copy changes nothing. Verification therefore returns it rather
 *   than a boolean, so "is this real" and "have I done this already" cannot drift
 *   apart.
 *
 * Nothing here reads a secret, fetches anything or touches storage: the signing
 * secret and the current time are arguments. That keeps the whole rule testable
 * without a Slack app, and makes a caller that forgets to store the replay key
 * visible in review rather than in production.
 */

/** Slack's own guidance, and what this implementation enforces, in seconds. */
export const SLACK_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The header carrying `v0=<64 lowercase hex>`. */
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";

/** The header carrying the Unix-seconds timestamp the signature covers. */
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";

/** Exactly `v0=` and 64 lowercase hex digits; uppercase and padding are refused. */
const SIGNATURE_VALUE = /^v0=([0-9a-f]{64})$/;

/** Whole Unix seconds, no sign, no fraction, no whitespace. */
const TIMESTAMP_VALUE = /^[0-9]{1,12}$/;

/**
 * Why a request was refused, as a short code.
 *
 * These are for the log and for tests, never for the response: Slack shows a
 * person what Bakery says, and "signature_mismatch" is not something a person can
 * act on. A refusal is a 401 with no body beyond that.
 */
export type SlackRequestRefusal =
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_signature"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "signature_mismatch";

export type SlackRequestVerdict =
  | Readonly<{
    ok: true;
    /** The timestamp the request claimed and the MAC covered. */
    timestamp: number;
    /**
     * The signature itself, hex, lowercase. Unique per (body, timestamp), which
     * is what makes it the replay key.
     */
    replayKey: string;
    /** SHA-256 of the exact bytes, for a receipt that never stores the body. */
    bodyDigest: string;
  }>
  | Readonly<{ ok: false; reason: SlackRequestRefusal }>;

const HEX_DIGITS = "0123456789abcdef";

function hexOf(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 15]!;
  }
  return hex;
}

/** The exact string Slack signs: version, timestamp, body, colon-separated. */
export function slackSigningMessage(
  timestamp: string,
  rawBody: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const prefix = new TextEncoder().encode(`v0:${timestamp}:`);
  const message = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  message.set(prefix, 0);
  message.set(rawBody, prefix.byteLength);
  return message;
}

/**
 * The `v0=` signature for a body and timestamp.
 *
 * Exported because a receiver's tests and a sender's fixtures need to make one,
 * and because signing and verifying the same string in two places is how the two
 * drift.
 */
export async function signSlackRequest(input: {
  readonly signingSecret: string;
  readonly timestamp: string;
  readonly rawBody: Uint8Array<ArrayBuffer>;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    slackSigningMessage(input.timestamp, input.rawBody),
  );
  return `v0=${hexOf(new Uint8Array(signature))}`;
}

/**
 * Whether this request is Slack's, and fresh.
 *
 * The order is the security property: a missing or malformed header is refused
 * before any key is imported, the timestamp is checked against the window before
 * the MAC is verified, and the MAC is verified before anything in the body is
 * parsed. A caller must not read the body's contents until this returns ok, which
 * is why the verdict carries nothing from the body.
 */
/**
 * Compares two hex digests without returning early on the first difference. The
 * lengths are compared first because the loop's bound is public anyway: a
 * signature of the wrong length is already not Slack's.
 */
function equalInConstantTime(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifySlackRequest(input: {
  readonly signingSecret: string;
  readonly signatureHeader: string | null;
  readonly timestampHeader: string | null;
  readonly rawBody: Uint8Array<ArrayBuffer>;
  /** Unix seconds; a caller passes its clock so the window is testable. */
  readonly now: number;
  readonly toleranceSeconds?: number;
}): Promise<SlackRequestVerdict> {
  if (input.signatureHeader === null) {
    return { ok: false, reason: "missing_signature" };
  }
  if (input.timestampHeader === null) {
    return { ok: false, reason: "missing_timestamp" };
  }
  const match = SIGNATURE_VALUE.exec(input.signatureHeader);
  if (match === null) return { ok: false, reason: "malformed_signature" };
  if (!TIMESTAMP_VALUE.test(input.timestampHeader)) {
    return { ok: false, reason: "malformed_timestamp" };
  }
  const timestamp = Number(input.timestampHeader);
  const tolerance = input.toleranceSeconds ?? SLACK_SIGNATURE_TOLERANCE_SECONDS;
  // Both directions: a timestamp far in the future is as suspicious as an old
  // one, and accepting it would extend the window a captured request can use.
  if (Math.abs(input.now - timestamp) > tolerance) {
    return { ok: false, reason: "stale_timestamp" };
  }
  // An unset secret must never verify. Web Crypto cannot import an empty HMAC
  // key, and a request signed with "" is not Slack's.
  if (input.signingSecret === "") {
    return { ok: false, reason: "signature_mismatch" };
  }
  const expected = await signSlackRequest({
    signingSecret: input.signingSecret,
    timestamp: input.timestampHeader,
    rawBody: input.rawBody,
  });
  // The comparison is over secrets, so it takes the same time whether the first
  // byte differs or the last: an early return hands an attacker a timing oracle
  // to guess the signature one byte at a time.
  if (!equalInConstantTime(expected, input.signatureHeader)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return {
    ok: true,
    timestamp,
    replayKey: match[1]!,
    bodyDigest: hexOf(
      new Uint8Array(await crypto.subtle.digest("SHA-256", input.rawBody)),
    ),
  };
}
