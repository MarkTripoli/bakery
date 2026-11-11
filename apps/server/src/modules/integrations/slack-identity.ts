/**
 * Verifying the "Sign in with Slack" identity token that links a Slack user to
 * a Bakery member.
 *
 * Linking is an authentication decision, so this takes nothing on trust. A
 * token is accepted only when it is a well-formed RS256 JWT, signed by a key
 * Slack published for its `kid`, issued for this app and this attempt (the
 * nonce), in the workspace the installation belongs to, and inside its time
 * window. A signature proves the token came from Slack; it does not prove which
 * Bakery member is asking, which is the bound auth attempt's job, and it is
 * never used to match a person by email, handle or display name.
 *
 * Everything is a function of its arguments. Nothing here fetches keys, reads
 * a secret or touches storage, so a caller supplies the key set it fetched and
 * the expectation it bound when the attempt began. It never throws, and a
 * refusal is a short reason code that carries nothing from the token.
 */
import { timingSafeEqual } from "node:crypto";

/** The `iss` Slack puts in its identity tokens. */
export const SLACK_OIDC_ISSUER = "https://slack.com";

/** What the caller bound when the linking attempt began. */
export type SlackIdentityExpectation = {
  /** Exact issuer; Slack's is {@link SLACK_OIDC_ISSUER}. */
  readonly issuer: string;
  /** The app's client id: the only audience a token may name. */
  readonly audience: string;
  /** The nonce generated for this attempt and sent to Slack. */
  readonly nonce: string;
  /** The Slack workspace (`T...`) the installation belongs to. */
  readonly teamId: string;
  /**
   * The Enterprise Grid organization (`E...`) the installation recorded, if
   * any. It must match exactly in both directions: a token that names one the
   * installation does not have is refused, and so is the reverse.
   */
  readonly enterpriseId?: string;
};

/** A public RSA signing key from Slack's published key set. */
export type SlackIdentityKey = {
  readonly kty: "RSA";
  readonly kid: string;
  readonly n: string;
  readonly e: string;
  readonly alg?: string;
  readonly use?: string;
};

/** Why a token was refused. A code only: nothing from the token is echoed. */
export type SlackIdentityRejection =
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "too_old"
  | "wrong_nonce"
  | "wrong_workspace"
  | "wrong_user"
  | "malformed_identity";

/** Who the token says the user is. */
export type VerifiedSlackIdentity = {
  /** Workspace id (`T...`). */
  readonly teamId: string;
  /** Immutable Slack user id (`U...` or `W...`). */
  readonly userId: string;
  readonly enterpriseId?: string;
  /** Seconds since the epoch. */
  readonly issuedAt: number;
  readonly expiresAt: number;
};

export type SlackIdentityResult =
  | { readonly ok: true; readonly identity: VerifiedSlackIdentity }
  | { readonly ok: false; readonly reason: SlackIdentityRejection };

/** Longest token read at all; a real one is under 2 KiB. */
const MAX_TOKEN_LENGTH = 16 * 1024;

/** Allowance for clocks that disagree, in seconds. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Oldest a token may be, whatever its `exp` says. The flow takes seconds; a
 * token minutes old was not made for this one.
 */
const MAX_TOKEN_AGE_SECONDS = 600;

/** Smallest RSA modulus accepted, in bytes (2048 bits). */
const MIN_MODULUS_BYTES = 256;

/**
 * Whether `exponent` (big-endian, no leading zero byte) is an odd public
 * exponent of at least 65537. An exponent of 0 or 1 makes a signature trivial
 * to forge, and WebCrypto imports such a key without complaint.
 */
function isSoundExponent(exponent: Uint8Array): boolean {
  return exponent.length >= 3 && exponent[0] !== 0 &&
    (exponent[exponent.length - 1] & 1) === 1;
}

/** Header members that make a verifier fetch, embed or reinterpret a key. */
const FORBIDDEN_HEADER_MEMBERS = ["jku", "jwk", "x5u", "x5c", "crit", "b64"];

const TEAM_ID = /^T[A-Z0-9]{2,31}$/;
const USER_ID = /^[UW][A-Z0-9]{2,31}$/;
const ENTERPRISE_ID = /^E[A-Z0-9]{2,31}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

const TEAM_CLAIM = "https://slack.com/team_id";
const USER_CLAIM = "https://slack.com/user_id";
const ENTERPRISE_CLAIM = "https://slack.com/enterprise_id";

const reject = (reason: SlackIdentityRejection): SlackIdentityResult => ({
  ok: false,
  reason,
});

function encodeBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/**
 * Decodes one base64url segment, and only its canonical spelling: no padding,
 * no standard-alphabet characters, no stray bits in the last character. Two
 * spellings of the same bytes would be two different tokens to anything that
 * keys on the text, so only one is accepted.
 */
function decodeBase64url(
  segment: string,
): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(segment) || segment.length % 4 === 1) return undefined;
  let binary: string;
  try {
    binary = atob(
      segment.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - (segment.length % 4)) % 4),
    );
  } catch {
    return undefined;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return encodeBase64url(bytes) === segment ? bytes : undefined;
}

function decodeJsonObject(
  segment: string,
): Record<string, unknown> | undefined {
  const bytes = decodeBase64url(segment);
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** Equality that takes the same time wherever the strings differ. */
function sameText(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  // Lengths are not secret here; only the bytes of an equal-length pair are.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Imports the key for `kid` if it is a strong RSA signing key, else nothing. */
async function importKey(
  keys: readonly SlackIdentityKey[],
  kid: string,
): Promise<CryptoKey | undefined> {
  for (const key of keys) {
    try {
      if (
        typeof key !== "object" || key === null || key.kid !== kid ||
        key.kty !== "RSA" || typeof key.n !== "string" ||
        typeof key.e !== "string" ||
        (key.alg !== undefined && key.alg !== "RS256") ||
        (key.use !== undefined && key.use !== "sig")
      ) continue;
      const modulus = decodeBase64url(key.n);
      const exponent = decodeBase64url(key.e);
      if (!modulus || !exponent) continue;
      if (modulus.length < MIN_MODULUS_BYTES || !isSoundExponent(exponent)) {
        continue;
      }
      return await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      // This key is unusable; a later one with the same kid may not be.
    }
  }
  return undefined;
}

function expectationIsUsable(
  expected: unknown,
): expected is SlackIdentityExpectation {
  if (typeof expected !== "object" || expected === null) return false;
  const e = expected as Record<string, unknown>;
  return typeof e.issuer === "string" && e.issuer.length > 0 &&
    typeof e.audience === "string" && e.audience.length > 0 &&
    typeof e.nonce === "string" && e.nonce.length > 0 &&
    typeof e.teamId === "string" && TEAM_ID.test(e.teamId) &&
    (e.enterpriseId === undefined ||
      (typeof e.enterpriseId === "string" &&
        ENTERPRISE_ID.test(e.enterpriseId)));
}

/**
 * Checks a Sign in with Slack identity token against what the attempt bound.
 * `nowMs` is the current time in milliseconds. Never throws.
 */
export async function verifySlackIdentityToken(
  token: string,
  expected: SlackIdentityExpectation,
  keys: readonly SlackIdentityKey[],
  nowMs: number,
): Promise<SlackIdentityResult> {
  try {
    if (!expectationIsUsable(expected)) return reject("malformed");
    if (!Number.isFinite(nowMs) || nowMs < 0) return reject("malformed");
    if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
      return reject("malformed");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      return reject("malformed");
    }
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = decodeJsonObject(headerPart);
    if (!header) return reject("malformed");
    if (FORBIDDEN_HEADER_MEMBERS.some((member) => member in header)) {
      return reject("malformed");
    }
    // Only RS256, compared exactly: never `none`, never an HMAC (which a public
    // key would turn into a shared secret), never another case of the name.
    if (header.alg !== "RS256") return reject("unsupported_algorithm");
    if (typeof header.kid !== "string" || header.kid.length === 0) {
      return reject("unknown_key");
    }
    if (!Array.isArray(keys)) return reject("unknown_key");
    const key = await importKey(keys, header.kid);
    if (!key) return reject("unknown_key");

    const signature = decodeBase64url(signaturePart);
    if (!signature) return reject("malformed");
    let valid = false;
    try {
      valid = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        signature,
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
      );
    } catch {
      valid = false;
    }
    if (!valid) return reject("bad_signature");

    // Only now are the claims read: they are Slack's words.
    const claims = decodeJsonObject(payloadPart);
    if (!claims) return reject("malformed");

    if (claims.iss !== expected.issuer) return reject("wrong_issuer");
    const audience = claims.aud;
    if (
      !(audience === expected.audience ||
        (Array.isArray(audience) && audience.length === 1 &&
          audience[0] === expected.audience))
    ) return reject("wrong_audience");

    const { exp, iat } = claims;
    if (
      typeof exp !== "number" || !Number.isFinite(exp) ||
      typeof iat !== "number" || !Number.isFinite(iat)
    ) return reject("malformed");
    const now = nowMs / 1000;
    if (exp < now - CLOCK_SKEW_SECONDS) return reject("expired");
    if (iat > now + CLOCK_SKEW_SECONDS) return reject("not_yet_valid");
    if (iat < now - MAX_TOKEN_AGE_SECONDS) return reject("too_old");

    if (
      typeof claims.nonce !== "string" ||
      !sameText(claims.nonce, expected.nonce)
    ) {
      return reject("wrong_nonce");
    }

    const team = claims[TEAM_CLAIM];
    if (typeof team !== "string" || team !== expected.teamId) {
      return reject("wrong_workspace");
    }
    const enterprise = claims[ENTERPRISE_CLAIM];
    if (enterprise !== undefined) {
      if (typeof enterprise !== "string" || !ENTERPRISE_ID.test(enterprise)) {
        return reject("malformed_identity");
      }
    }
    if (enterprise !== expected.enterpriseId) return reject("wrong_workspace");

    const subject = claims.sub;
    if (typeof subject !== "string" || !USER_ID.test(subject)) {
      return reject("malformed_identity");
    }
    const userClaim = claims[USER_CLAIM];
    if (userClaim !== undefined) {
      if (typeof userClaim !== "string" || !USER_ID.test(userClaim)) {
        return reject("malformed_identity");
      }
      if (userClaim !== subject) return reject("wrong_user");
    }

    return {
      ok: true,
      identity: {
        teamId: team,
        userId: subject,
        ...(enterprise === undefined ? {} : { enterpriseId: enterprise }),
        issuedAt: iat,
        expiresAt: exp,
      },
    };
  } catch {
    return reject("malformed");
  }
}
