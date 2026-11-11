/** GitHub sends `X-Hub-Signature-256: sha256=` plus 64 lowercase hex digits. */
const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/;

const SHA256_BYTES = 32;

const HEX_DIGITS = "0123456789abcdef";

/**
 * Decodes an `X-Hub-Signature-256` value to its 32 digest bytes. Only the
 * exact documented form passes: the `sha256=` prefix and 64 lowercase hex
 * digits. A missing header, the legacy `sha1=` form, uppercase hex, a short
 * or long digest and any surrounding whitespace all give null.
 */
export function parseSignatureHeader(
  value: string | null,
): Uint8Array<ArrayBuffer> | null {
  if (value === null) return null;
  const match = SIGNATURE_HEADER.exec(value);
  if (match === null) return null;
  const hex = match[1]!;
  const bytes = new Uint8Array(SHA256_BYTES);
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * True when `signature` is the HMAC-SHA256 of `raw` under `secret`. The
 * comparison runs inside the platform's `crypto.subtle.verify`, which is
 * constant time. Every failure answers false: no signature, a signature of
 * the wrong length, and an empty secret (Web Crypto cannot import a
 * zero-length HMAC key, and an unset secret must never verify).
 */
export async function verifyGitHubSignature(
  secret: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer> | null,
  raw: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  if (
    signature === null || signature.byteLength !== SHA256_BYTES ||
    secret.byteLength === 0
  ) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, raw);
}

/** Lowercase hex SHA-256 of `raw`, the receipt digest compared on a repeated delivery. */
export async function sha256Hex(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  let hex = "";
  for (const byte of digest) {
    hex += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 15]!;
  }
  return hex;
}
