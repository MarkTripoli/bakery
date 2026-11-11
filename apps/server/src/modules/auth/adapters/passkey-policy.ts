import { passkey } from "@better-auth/passkey";
import { APIError } from "better-auth/api";
import type { AuthContext } from "better-auth";
import type { ServerAuthConfig } from "@bakery/config";

/** Relying-party label shown by the authenticator; never client-overridable. */
const PASSKEY_RP_NAME = "Bakery";

/** Bakery refusals around the passkey plugin; spread into the Bakery plugin's `$ERROR_CODES`. */
export const PASSKEY_POLICY_ERROR_CODES = {
  USER_VERIFICATION_REQUIRED: {
    code: "USER_VERIFICATION_REQUIRED",
    message: "Verify yourself on the authenticator to continue",
  },
  LAST_SIGN_IN_METHOD: {
    code: "LAST_SIGN_IN_METHOD",
    message: "Add another usable sign-in method before removing your last one",
  },
} as const;

type OriginConfig = Pick<ServerAuthConfig, "publicOrigin" | "trustedOrigins">;

/** RP ID is the public origin's hostname; `localhost` is its own realm. */
export function passkeyRpId(
  config: Pick<ServerAuthConfig, "publicOrigin">,
): string {
  return new URL(config.publicOrigin).hostname;
}

/**
 * Origins SimpleWebAuthn accepts verbatim: the public origin, plus every
 * trusted origin whose host is the RP ID or a subdomain of it. Wildcards
 * and foreign hosts drop out (an exact-string comparison would never
 * match them, silently).
 *
 * The public origin is always present: an empty array is truthy in the
 * plugin's `options.origin || header` fallback and would refuse every
 * ceremony.
 */
export function passkeyOrigins(config: OriginConfig): string[] {
  const rpId = passkeyRpId(config);
  const origins = new Set([new URL(config.publicOrigin).origin]);
  for (const candidate of config.trustedOrigins) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.hostname.includes("*")) continue;
    if (url.hostname === rpId || url.hostname.endsWith(`.${rpId}`)) {
      origins.add(url.origin);
    }
  }
  return [...origins];
}

/**
 * The registered passkey plugin. The upstream factory's return shape has no
 * exported name, so the contract lane reads `options` off this one.
 */
export type PasskeyPlugin = ReturnType<typeof passkey>;

/**
 * The plugin passes `requireUserVerification: false` to SimpleWebAuthn and
 * hardcodes `userVerification: "preferred"` on sign-in, so the UV flag is
 * enforced in `afterVerification`: it runs after signature verification and
 * before the `passkey` insert, the counter update and any session, and an
 * `APIError` thrown from it is rethrown unchanged.
 */
export function createPasskeyPlugin(config: ServerAuthConfig): PasskeyPlugin {
  return passkey({
    rpID: passkeyRpId(config),
    rpName: PASSKEY_RP_NAME,
    origin: passkeyOrigins(config),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    registration: {
      requireSession: true,
      afterVerification: ({ verification }) => {
        if (verification.registrationInfo?.userVerified !== true) {
          throw new APIError(
            "UNAUTHORIZED",
            PASSKEY_POLICY_ERROR_CODES.USER_VERIFICATION_REQUIRED,
          );
        }
      },
    },
    authentication: {
      afterVerification: ({ verification }) => {
        if (verification.authenticationInfo.userVerified !== true) {
          throw new APIError(
            "UNAUTHORIZED",
            PASSKEY_POLICY_ERROR_CODES.USER_VERIFICATION_REQUIRED,
          );
        }
      },
    },
  });
}

type PasskeyRow = { id: string; userId: string };

/**
 * Refuses deleting the caller's last passkey when no other sign-in method
 * remains: a credential account with a password, or any social account
 * (GitHub is the only one configured). A foreign or missing id returns
 * without throwing so the plugin's own `requireResourceOwnership` answers
 * (404 / 401) and this guard leaks nothing about other people's rows.
 *
 * Count-based: two concurrent deletes of the two remaining passkeys can both
 * pass. Accepted (design question "Last-method guard"): the actor is the
 * owner acting against themselves and recovery is an admin invitation.
 */
export async function assertNotLastSignInMethod(
  context: Pick<AuthContext, "adapter" | "internalAdapter">,
  userId: string,
  passkeyId: unknown,
): Promise<void> {
  if (typeof passkeyId !== "string") return;
  const target = await context.adapter.findOne<PasskeyRow>({
    model: "passkey",
    where: [{ field: "id", value: passkeyId }],
  });
  if (!target || target.userId !== userId) return;
  const remaining = await context.adapter.count({
    model: "passkey",
    where: [{ field: "userId", value: userId }],
  });
  if (remaining > 1) return;
  const accounts = await context.internalAdapter.findAccounts(userId);
  const otherMethod = accounts.some((account) =>
    account.providerId === "credential" ? !!account.password : true
  );
  if (otherMethod) return;
  throw new APIError(
    "FORBIDDEN",
    PASSKEY_POLICY_ERROR_CODES.LAST_SIGN_IN_METHOD,
  );
}

/**
 * The passkey a sign-in ceremony just verified, for the session it is about
 * to create. Called only from the session-create hook on
 * `/passkey/verify-authentication`, which runs after the plugin verified the
 * assertion, so `response.id` is the credential id of a passkey that exists.
 * Returns undefined for any other path or malformed body.
 */
export async function authenticatingPasskeyId(
  context: Pick<AuthContext, "adapter">,
  path: string | undefined,
  body: unknown,
): Promise<string | undefined> {
  if (path !== "/passkey/verify-authentication") return undefined;
  if (typeof body !== "object" || body === null || !("response" in body)) {
    return undefined;
  }
  const { response } = body;
  if (typeof response !== "object" || response === null) return undefined;
  const credentialId = "id" in response ? response.id : undefined;
  if (typeof credentialId !== "string") return undefined;
  const row = await context.adapter.findOne<PasskeyRow>({
    model: "passkey",
    where: [{ field: "credentialID", value: credentialId }],
  });
  return row?.id;
}
