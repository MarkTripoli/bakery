const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decodes RFC 4648 base32 (no padding required) into raw bytes. */
function base32Decode(value: string) {
  const clean = value.toUpperCase().replace(/=+$/, "");
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error("TOTP_SECRET_INVALID_BASE32");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Extracts the base32 `secret` query parameter from an `otpauth://totp/...` URI. */
export function parseTotpSecret(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get("secret");
  if (!secret) throw new Error("TOTP_SECRET_MISSING");
  return secret;
}

/**
 * RFC 6238 TOTP over HMAC-SHA1, 6 digits, 30-second period by default.
 * WebCrypto only (`crypto.subtle`), so it runs unmodified under Deno, Node
 * and Playwright's browser-adjacent test runner.
 */
export async function totpCode(
  secretBase32: string,
  options: {
    readonly at?: number;
    readonly stepOffset?: number;
    readonly period?: number;
    readonly digits?: number;
  } = {},
): Promise<string> {
  const period = options.period ?? 30;
  const digits = options.digits ?? 6;
  const at = options.at ?? Date.now();
  const step = Math.floor(at / 1000 / period) + (options.stepOffset ?? 0);
  const counter = new Uint8Array(8);
  let remaining = BigInt(step);
  for (let index = 7; index >= 0; index -= 1) {
    counter[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secretBase32),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, counter),
  );
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);
  const modulo = 10 ** digits;
  return (binary % modulo).toString().padStart(digits, "0");
}

/**
 * Hands out a TOTP step offset that has not been sent to `verify-totp`
 * before, within one test. Better Auth's replay guard rejects every code
 * accepted within the last 90 seconds (not just the immediately previous
 * one), so `enrollTotp`'s own verify (offset 0) burns that step for the
 * whole test: a second proof needs offset `+1` instead of resending
 * offset 0. `-1` is deliberately not offered: a code computed at the
 * current step with `stepOffset: -1` is only inside the verifier's ±1
 * window while the server is still in that same step, so it goes stale
 * (and fails as `INVALID_CODE`) if a step boundary is crossed between
 * computing it and the server verifying it — a real, observed flake. A
 * test that needs more than one further proof must use
 * `verify-backup-code` instead of pulling a wider, invalid offset.
 */
export function createTotpOffsets(): () => number {
  const order = [1];
  let index = 0;
  return () => {
    if (index >= order.length) {
      throw new Error("TOTP_OFFSETS_EXHAUSTED_USE_BACKUP_CODE");
    }
    return order[index++];
  };
}
