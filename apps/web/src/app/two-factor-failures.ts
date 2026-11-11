import type { MessageKey } from "@bakery/i18n";
import { AuthProviderError } from "@bakery/contracts/auth-provider-client";
import { SECURITY_SETTINGS_PATH } from "./auth-paths.ts";
import { rememberReturnTo, safeSessionStorage } from "./auth-return.ts";

/**
 * Search flag the account overview reads to confirm a fresh sign-in landed
 * (`AccountSettingsPage`'s `saved` state, "Your identity was confirmed.").
 */
const CONFIRMED_SEARCH = "?confirmed=1";

/**
 * Stores where a `FRESH_SIGN_IN_REQUIRED` detour returns to before the
 * caller redirects to sign-in: the account overview, flagged so it opens
 * with the confirmation notice ("Your identity was confirmed."). Every
 * protection page that mutates a factor takes this path, which is what the
 * retired dialog flow did with its "sign in again to make security changes"
 * dead end — except the principal now lands back on the account overview
 * with the confirmation and one link to the change they were making.
 */
export function rememberFreshSignInReturn(): void {
  rememberReturnTo(
    {
      pathname: SECURITY_SETTINGS_PATH,
      search: CONFIRMED_SEARCH,
      hash: "",
    },
    safeSessionStorage(),
  );
}

/**
 * What an authenticator, backup-code or disable request can fail with, as
 * the four account-protection pages need to react to it. The kinds that name
 * a field (`invalidPassword`, `invalidCode`) become that field's error and
 * take focus; `notice` is a form-level message; the two navigation kinds are
 * handled by the container, not shown.
 */
export type TwoFactorFailure =
  /** The session is no longer fresh enough to change a security setting. */
  | { readonly kind: "freshSignInRequired" }
  /** The server wants the authenticator code proved before the change. */
  | { readonly kind: "factorProofRequired" }
  /** The enrolment or verification window lapsed; setup must restart. */
  | { readonly kind: "enrolmentExpired" }
  | { readonly kind: "invalidCode" }
  | { readonly kind: "invalidPassword" }
  | {
    readonly kind: "notice";
    readonly messageKey: MessageKey;
    /** Only set for a rate limit that told us when to retry. */
    readonly retryAfterSeconds: number | null;
  };

/**
 * Classifies a two-factor mutation failure. Extracted verbatim from the
 * retired `SecuritySettingsPage` dialog flow so the four pages that replaced
 * it keep the same server contract: a rate limit with no retry hint is as
 * opaque as an unavailable provider, `INVALID_CREDENTIALS` is always the
 * password field (these calls carry no other credential), and anything the
 * client cannot name falls back to the unavailable notice.
 */
export function twoFactorFailure(error: unknown): TwoFactorFailure {
  if (!(error instanceof AuthProviderError)) {
    return {
      kind: "notice",
      messageKey: "auth.signIn.unavailable",
      retryAfterSeconds: null,
    };
  }
  switch (error.code) {
    case "FRESH_SIGN_IN_REQUIRED":
      return { kind: "freshSignInRequired" };
    case "FACTOR_PROOF_REQUIRED":
      return { kind: "factorProofRequired" };
    case "TWO_FACTOR_SESSION_EXPIRED":
      return { kind: "enrolmentExpired" };
    case "TWO_FACTOR_INVALID":
      return { kind: "invalidCode" };
    case "INVALID_CREDENTIALS":
      return { kind: "invalidPassword" };
    case "LOCKED":
      return {
        kind: "notice",
        messageKey: "auth.twoFactor.locked",
        retryAfterSeconds: null,
      };
    case "NETWORK":
      return {
        kind: "notice",
        messageKey: "auth.signIn.offline",
        retryAfterSeconds: null,
      };
    case "RATE_LIMITED":
      return error.retryAfterSeconds === null
        ? {
          kind: "notice",
          messageKey: "auth.signIn.unavailable",
          retryAfterSeconds: null,
        }
        : {
          kind: "notice",
          messageKey: "auth.signIn.rateLimited",
          retryAfterSeconds: error.retryAfterSeconds,
        };
    default:
      return {
        kind: "notice",
        messageKey: "auth.signIn.unavailable",
        retryAfterSeconds: null,
      };
  }
}
