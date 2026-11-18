/**
 * HMAC-SHA256, computed synchronously.
 *
 * The SDK's webhook ingress verifies before it parses and the design has the
 * core hand the provider exact bytes, so `verify` is synchronous: a receiver
 * that awaited a promise here would have to hold the body open across an await
 * between the signature check and the parse, which is exactly the window a
 * hostile payload wants. Web Crypto's `subtle.verify` is async only, so the
 * primitive is computed here instead of awaited.
 *
 * This is the one place in the repository with a hand-written hash. It is
 * written to FIPS 180-4 and checked against Web Crypto's own HMAC on the
 * published test vectors before it is trusted, so a mistake in the arithmetic
 * fails the suite rather than a delivery.
 */

const BLOCK_BYTES = 64;
const DIGEST_BYTES = 32;

/** FIPS 180-4 section 4.2.2. */
const K = new Uint32Array([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
]);

const rotr = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

/**
 * SHA-256 of `bytes`. Whole blocks are consumed as they arrive and the tail is
 * padded once, so the cost is one pass plus one padded block.
 */
function sha256(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const h = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  // Message length in bits, as a 64-bit big-endian tail. JS bit operations are
  // 32-bit, so the high word is computed by division rather than shifting.
  const bitLength = bytes.byteLength * 8;
  const padLength = ((bytes.byteLength + 8) >> 6 << 6) + BLOCK_BYTES;
  const padded = new Uint8Array(padLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const tail = padLength - 8;
  padded[tail] = Math.floor(bitLength / 2 ** 32) >>> 24;
  padded[tail + 1] = Math.floor(bitLength / 2 ** 32) >>> 16;
  padded[tail + 2] = Math.floor(bitLength / 2 ** 32) >>> 8;
  padded[tail + 3] = Math.floor(bitLength / 2 ** 32) & 0xff;
  padded[tail + 4] = (bitLength >>> 24) & 0xff;
  padded[tail + 5] = (bitLength >>> 16) & 0xff;
  padded[tail + 6] = (bitLength >>> 8) & 0xff;
  padded[tail + 7] = bitLength & 0xff;

  for (let offset = 0; offset < padLength; offset += BLOCK_BYTES) {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = (padded[at]! << 24) | (padded[at + 1]! << 16) |
        (padded[at + 2]! << 8) | padded[at + 3]!;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^
        (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (hh! + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d! + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h[0] = (h[0]! + a!) | 0;
    h[1] = (h[1]! + b!) | 0;
    h[2] = (h[2]! + c!) | 0;
    h[3] = (h[3]! + d!) | 0;
    h[4] = (h[4]! + e!) | 0;
    h[5] = (h[5]! + f!) | 0;
    h[6] = (h[6]! + g!) | 0;
    h[7] = (h[7]! + hh!) | 0;
  }

  const digest = new Uint8Array(DIGEST_BYTES);
  for (let i = 0; i < 8; i += 1) {
    digest[i * 4] = (h[i]! >>> 24) & 0xff;
    digest[i * 4 + 1] = (h[i]! >>> 16) & 0xff;
    digest[i * 4 + 2] = (h[i]! >>> 8) & 0xff;
    digest[i * 4 + 3] = h[i]! & 0xff;
  }
  return digest;
}

/**
 * HMAC-SHA256 of `message` under `key` (RFC 2104).
 *
 * A key longer than one block is hashed first, and a short key is padded with
 * zeroes, both as the RFC specifies - a delivery secret of any length verifies.
 */
export function hmacSha256(
  key: Uint8Array,
  message: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(BLOCK_BYTES);
  if (key.byteLength > BLOCK_BYTES) {
    block.set(sha256(key));
  } else {
    block.set(key);
  }
  const inner = new Uint8Array(BLOCK_BYTES);
  const outer = new Uint8Array(BLOCK_BYTES);
  for (let i = 0; i < BLOCK_BYTES; i += 1) {
    inner[i] = block[i]! ^ 0x36;
    outer[i] = block[i]! ^ 0x5c;
  }
  const innerInput = new Uint8Array(BLOCK_BYTES + message.byteLength);
  innerInput.set(inner);
  innerInput.set(message, BLOCK_BYTES);
  const outerInput = new Uint8Array(BLOCK_BYTES + DIGEST_BYTES);
  outerInput.set(outer);
  outerInput.set(sha256(innerInput), BLOCK_BYTES);
  return sha256(outerInput);
}

/**
 * Constant-time equality for two digests of equal length.
 *
 * Compared byte by byte with no early exit, so the time taken does not reveal
 * how many leading bytes matched - a length mismatch is answered first because
 * it is not secret and would otherwise read past the end.
 */
export function equalDigests(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < left.byteLength; i += 1) {
    difference |= left[i]! ^ right[i]!;
  }
  return difference === 0;
}
