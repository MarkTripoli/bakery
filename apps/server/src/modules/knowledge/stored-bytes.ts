import { StandardError } from "@bakery/contracts/http";

/**
 * Checks that bytes are the bytes a row says they are.
 *
 * Both sides of storage use this: a reader before it serves a version, and a
 * writer before it records one. Two implementations would be two chances to
 * disagree about what "the same bytes" means, and the disagreement would show
 * up as a version that reads back differently from how it was written.
 */
export async function assertStoredBytes(
  row: Readonly<{ size_bytes: number | bigint; sha256: string }>,
  bytes: Uint8Array,
): Promise<void> {
  const size = Number(row.size_bytes);
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    bytes.byteLength !== size ||
    !/^[0-9a-f]{64}$/.test(row.sha256)
  ) {
    throw new StandardError({ code: "INTERNAL" });
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  const actualSha256 = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actualSha256 !== row.sha256) {
    throw new StandardError({ code: "INTERNAL" });
  }
}
