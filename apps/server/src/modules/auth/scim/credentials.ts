/** Prefix every SCIM bearer secret carries; lets a scanner recognise a leaked one. */
export const SCIM_SECRET_PREFIX = "bsc_";

/** Characters of the secret shown back to administrators to tell credentials apart. */
const PREFIX_DISPLAY_LENGTH = 8;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** A new secret of 32 random bytes with its display prefix and storage digest. */
export async function mintScimSecret(): Promise<
  { secret: string; prefix: string; sha256: string }
> {
  const secret = `${SCIM_SECRET_PREFIX}${
    base64Url(crypto.getRandomValues(new Uint8Array(32)))
  }`;
  return {
    secret,
    prefix: secret.slice(0, PREFIX_DISPLAY_LENGTH),
    sha256: await sha256Hex(secret),
  };
}
