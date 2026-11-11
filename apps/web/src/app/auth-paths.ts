/**
 * Public route path literals and the `isPublicAuthPath`/`isAuthEntryPath`
 * predicates they back. Deliberately dependency-free (no React, no router,
 * no `@bakery/ui`): every other auth module — `auth-return.ts` most
 * notably, whose Deno unit tests import it directly — can depend on this
 * file without dragging in the app shell's React tree. `auth-required.tsx`
 * re-exports these for the many route guards and pages that already import
 * them from there.
 */
export const SETUP_PATH: string = "/setup";
export const SIGN_IN_PATH: string = "/sign-in";
export const TWO_FACTOR_PATH: string = "/sign-in/two-factor";
export const RECOVERY_CODE_PATH: string = "/sign-in/recovery-code";
export const SIGN_OUT_PATH: string = "/sign-out";
export const REGISTER_PATH: string = "/register";
/**
 * Both routes fold into `REGISTER_PATH` (join shows at `/register` with no
 * invitation search, register shows at `/register?invitation=<id>`).
 * `InvitationRequiredPage`/`SignUpPage` and their fixtures still import
 * these directly; PagesInvite removes both alongside that migration.
 */
export const INVITATION_PATH: string = "/invitations/$invitationId";
export const ORGANIZATIONS_PATH: string = "/organizations";
/**
 * Organization administration lives outside the personal Settings tree
 * (`isSettingsPath` does not match it): defaults and availability for the
 * selected organization.
 */
export const ORGANIZATION_SETTINGS_PATH: string = "/organization/settings";
export const SECURITY_SETTINGS_PATH: string = "/settings/security";
export const TWO_FACTOR_SETTINGS_PATH: string = "/settings/security/two-factor";
export const TWO_FACTOR_SETUP_PATH: string =
  "/settings/security/two-factor/setup";
export const TWO_FACTOR_DISABLE_PATH: string =
  "/settings/security/two-factor/disable";
export const BACKUP_CODES_PATH: string =
  "/settings/security/two-factor/backup-codes";
/** Connected OAuth clients: the grants a person can review and revoke. */
export const CONNECTED_CLIENTS_PATH: string = "/settings/clients";
export const REVOKE_CLIENT_PATH: string = "/settings/clients/revoke";
/** The OAuth provider sends people here to approve or deny a client. */
export const OAUTH_CONSENT_PATH: string = "/oauth/consent";
export const SESSIONS_SETTINGS_PATH: string = "/settings/sessions";
export const SESSION_REVOKE_PATH: string = "/settings/sessions/revoke";
export const PASSWORD_SETTINGS_PATH: string = "/settings/security/password";
export const PASSKEYS_SETTINGS_PATH: string = "/settings/security/passkeys";
export const PASSKEY_ADD_PATH: string = "/settings/security/passkeys/new";
/** Fresh-authentication step; refusals route here with a return path. */
export const REAUTH_PATH: string = "/account/reauthenticate";
/** Where "back to personal settings" lands when a page is forbidden. */
export const PERSONAL_SETTINGS_PATH: string = "/settings/profile";

/**
 * Fixture-only specimens that render inside `AuthEntry` rather than the
 * normal shell chrome, fanning out from `/__fixtures__/auth/$state`.
 * `security`/`two-factor` (settings) and `sessions` are protected screens
 * whose specimens live inside the normal shell instead, exactly like
 * `/__fixtures__/settings/*`; `organizations` is protected but renders
 * through `AuthEntry` like the entry screens (see `isAuthEntryPath`).
 */
const AUTH_ENTRY_FIXTURE_PREFIXES = [
  "setup-",
  "login-",
  "expired-",
  "invite-login-",
  "totp-challenge-",
  "backup-challenge-",
  "signout-",
  "join-",
  "register-",
  "invite-",
  "organizations-",
  "reauth-",
  "consent-",
] as const;

/**
 * True for every route a signed-out visitor may load directly: the public
 * auth screens above, any `/invitations/:id` deep link (an invitation is
 * readable before sign-in, register, or acceptance), and their
 * `AuthEntry`-rendering fixture specimens. Shared by `AppLayout` (skips the
 * app shell chrome for these) and `postSignInDestination` (lets a stored
 * deep link into one of these routes win over the organization chooser).
 */
export function isPublicAuthPath(pathname: string): boolean {
  const publicAuthPaths = [
    SETUP_PATH,
    SIGN_IN_PATH,
    TWO_FACTOR_PATH,
    RECOVERY_CODE_PATH,
    SIGN_OUT_PATH,
    REGISTER_PATH,
  ] as const;
  if (
    publicAuthPaths.includes(pathname as (typeof publicAuthPaths)[number]) ||
    pathname.startsWith("/invitations/")
  ) {
    return true;
  }
  const fixtureAuthPrefix = "/__fixtures__/auth/";
  if (!pathname.startsWith(fixtureAuthPrefix)) return false;
  const state = pathname.slice(fixtureAuthPrefix.length);
  return AUTH_ENTRY_FIXTURE_PREFIXES.some((prefix) => state.startsWith(prefix));
}

/**
 * The account-settings screens (Paper `settingsShell`): their fixtures must
 * render inside the same shell as `/settings/*` — application rail, header
 * AND the settings section navigation — because the parity gate compares
 * the design's content column against the app's real `<main>` box.
 */
const SETTINGS_FIXTURE_PREFIXES = [
  "profile-",
  "appearance-",
  "your-access-",
  "section-index-",
  "security-",
  "sessions-",
  "revoke-",
  "two-factor-",
  "totp-setup-",
  "backup-codes-",
  "totp-disable-",
  "password-",
  "passkeys-",
  "passkey-add-",
  "clients-",
] as const;

export function isSettingsPath(pathname: string): boolean {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return true;
  }
  const fixtureAuthPrefix = "/__fixtures__/auth/";
  if (!pathname.startsWith(fixtureAuthPrefix)) return false;
  const state = pathname.slice(fixtureAuthPrefix.length);
  return SETTINGS_FIXTURE_PREFIXES.some((prefix) => state.startsWith(prefix));
}

/**
 * `isPublicAuthPath` plus `/organizations` — the one *protected* screen that
 * also renders through `AuthEntry` instead of the normal shell chrome (a
 * signed-in principal with no usable organization still needs the
 * `AuthEntry` presentation, same as every other entry screen). `AppLayout`
 * uses this instead of `isPublicAuthPath` to decide when to skip its shell.
 */
export function isAuthEntryPath(pathname: string): boolean {
  return isPublicAuthPath(pathname) || pathname === ORGANIZATIONS_PATH ||
    pathname === REAUTH_PATH || pathname === OAUTH_CONSENT_PATH;
}
