import { AccessScope, isAccessScope } from "./scopes.ts";

/** Visible prefix every Bakery access token starts with. */
export const ACCESS_TOKEN_PREFIX = "bky_";
/** Characters of the secret kept in clear so a token can be recognised in lists. */
const DISPLAY_PREFIX_LENGTH = 12;
/** Longest lifetime a token may be minted with. */
export const MAX_ACCESS_TOKEN_LIFETIME_DAYS = 365;

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 32 random bytes, shown once; only the SHA-256 digest is stored. */
export async function generateAccessTokenSecret(): Promise<
  { secret: string; prefix: string; digest: string }
> {
  const secret = `${ACCESS_TOKEN_PREFIX}${
    base64Url(crypto.getRandomValues(new Uint8Array(32)))
  }`;
  return {
    secret,
    prefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
    digest: await sha256Hex(secret),
  };
}

/** The bearer secret in an Authorization header when it looks like ours, else null. */
export function bearerAccessTokenSecret(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer[ \t]+(bky_[A-Za-z0-9_-]{43})$/.exec(header);
  return match ? match[1] : null;
}

/** Distinct, known scopes in canonical order, or null when any is unknown or none given. */
export function normalizeTokenScopes(
  scopes: readonly string[],
): AccessScope[] | null {
  if (scopes.length === 0 || !scopes.every(isAccessScope)) return null;
  const set = new Set<string>(scopes);
  return [AccessScope.Read, AccessScope.Operate, AccessScope.Admin].filter((
    scope,
  ) => set.has(scope));
}

/** True when `expiresAt` is in the future and within the maximum lifetime. */
export function tokenExpiryAllowed(expiresAt: Date, now: Date): boolean {
  const ms = expiresAt.getTime() - now.getTime();
  return Number.isFinite(ms) && ms > 0 &&
    ms <= MAX_ACCESS_TOKEN_LIFETIME_DAYS * 86_400_000;
}
