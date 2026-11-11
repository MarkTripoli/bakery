import type { MessageKey } from "@bakery/i18n";
import { AuthProviderError } from "@bakery/contracts/auth-provider-client";
import { REAUTH_PATH } from "./auth-paths.ts";
import { twoFactorFailure } from "./two-factor-failures.ts";

/**
 * What a password, passkey or re-authentication request can fail with, as
 * the security pages react to it. The kinds that name a field become that
 * field's error and take focus; `reauthRequired` is a navigation to
 * `/account/reauthenticate` with the page the person was on as the return
 * path; `offline` keeps the draft and never reports success; `notice` is a
 * form-level message.
 */
export type SecurityFailure =
  /** A fresh sign-in is needed first: go to re-authentication. */
  | { readonly kind: "reauthRequired" }
  /** The authenticator code must be proved first, in place on this page. */
  | { readonly kind: "factorRequired" }
  | { readonly kind: "invalidCode" }
  | { readonly kind: "invalidPassword" }
  /** The account has no password to re-prove: sign out, then sign in again. */
  | { readonly kind: "passwordNotSet" }
  /** The new password is outside the configured length policy. */
  | { readonly kind: "weakPassword" }
  /** Removing the passkey would leave no usable sign-in method. */
  | { readonly kind: "lastSignInMethod" }
  | { readonly kind: "offline" }
  | {
    readonly kind: "notice";
    readonly messageKey: MessageKey;
    /** Only set for a rate limit that told us when to retry. */
    readonly retryAfterSeconds: number | null;
  };

/** Classifies a provider failure for the security pages. */
export function securityFailure(error: unknown): SecurityFailure {
  if (error instanceof AuthProviderError) {
    switch (error.code) {
      case "FRESH_SIGN_IN_REQUIRED":
        return { kind: "reauthRequired" };
      case "FACTOR_PROOF_REQUIRED":
        return { kind: "factorRequired" };
      case "PASSWORD_NOT_SET":
        return { kind: "passwordNotSet" };
      case "INVALID_PASSWORD":
      case "INVALID_CREDENTIALS":
        return { kind: "invalidPassword" };
      case "PASSWORD_TOO_SHORT":
      case "PASSWORD_TOO_LONG":
      case "WEAK_PASSWORD":
        return { kind: "weakPassword" };
      case "LAST_SIGN_IN_METHOD":
        return { kind: "lastSignInMethod" };
      case "NETWORK":
        return { kind: "offline" };
    }
  }
  const classified = twoFactorFailure(error);
  return classified.kind === "notice" ? classified : {
    kind: "notice",
    messageKey: "auth.signIn.unavailable",
    retryAfterSeconds: null,
  };
}

/** C0 controls and DEL, which URL parsers silently strip or reinterpret. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Same-origin path a re-authentication may return to. Anything else falls
 * back to `fallback`: absolute or protocol-relative URLs, control characters
 * (a tab or newline inside `/\t/evil.example` is stripped by URL parsers and
 * leaves a protocol-relative target), backslashes anywhere, and any path that
 * does not resolve to the same origin and keep its own spelling.
 */
export function safeReturnPath(
  candidate: string | null | undefined,
  fallback: string,
): string {
  if (
    typeof candidate !== "string" || !candidate.startsWith("/") ||
    candidate.startsWith("//") || candidate.includes("\\") ||
    hasControlCharacter(candidate) ||
    candidate.startsWith(REAUTH_PATH)
  ) {
    return fallback;
  }
  try {
    const base = "https://return-path.invalid";
    const resolved = new URL(candidate, base);
    if (
      resolved.origin !== base ||
      resolved.pathname.startsWith("//")
    ) {
      return fallback;
    }
  } catch {
    return fallback;
  }
  return candidate;
}

/** Router `search` for a re-authentication that returns to `returnTo`. */
export function reauthSearch(returnTo: string): { readonly returnTo: string } {
  return { returnTo: safeReturnPath(returnTo, "/") };
}
