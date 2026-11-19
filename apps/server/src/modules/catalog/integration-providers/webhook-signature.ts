import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 and digest comparison, built on `node:crypto`.
 *
 * The SDK's webhook ingress verifies before it parses and the design has the core
 * hand the provider exact bytes, so `verify` is synchronous: a receiver that
 * awaited a promise here would have to hold the body open across an await
 * between the signature check and the parse, which is exactly the window a
 * hostile payload wants. `node:crypto` computes the digest synchronously, so
 * the port keeps its shape and the arithmetic stays in a maintained library
 * rather than in this repository.
 *
 * `node:crypto` is also the portable choice: Deno implements it, and #139 moves
 * the runtime to Node, where it needs no change at all.
 */

/**
 * HMAC-SHA256 of `message` under `key` (RFC 2104).
 *
 * A key longer than the block is hashed first and a short key is zero-padded,
 * both as the RFC specifies, so a delivery secret of any length verifies.
 */
export function hmacSha256(
  key: Uint8Array,
  message: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const digest = createHmac("sha256", key).update(message).digest();
  return new Uint8Array(digest);
}

/**
 * Constant-time equality for two digests.
 *
 * `timingSafeEqual` requires equal lengths, so a length mismatch is answered
 * first; that comparison is not secret, and the alternative is a throw on
 * attacker-controlled input.
 */
export function equalDigests(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}
