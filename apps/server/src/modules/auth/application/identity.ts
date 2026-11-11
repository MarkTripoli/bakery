import {
  catalogVersion,
  directionForLocale,
  type SupportedLocale,
} from "@bakery/i18n";
import {
  isPrincipalType,
  isUuid,
  type PrincipalId,
  principalId,
  type PrincipalType,
} from "@bakery/contracts/contracts";
import { BakeryException } from "@bakery/contracts/exceptions";
import { AuthErrorCode } from "../domain/errors.ts";

export type AuthenticatedSubject = {
  principalId: PrincipalId;
  principalType: PrincipalType;
  displayName: string;
  preferredLocale?: string;
  /**
   * Whether the person has completed authenticator enrollment. Only set by
   * the browser session middleware from live session state; absent (treated
   * as `false`) for principals resolved through other paths. Carries no
   * authorization meaning.
   */
  twoFactorEnabled?: boolean;
  /**
   * The person's sign-in email as the identity provider holds it. Only set by
   * the browser session middleware from the live session user; absent for
   * principals resolved through other paths. Shown for account context only.
   */
  email?: string;
  /**
   * Better Auth's provider user id (`bakery.principals.provider_user_id`),
   * populated by the browser session middleware from the live session user
   * and by the authority runner when it reloads the principal live
   * (`authority-postgres.ts:reloadSubject`); absent for principals resolved
   * through other paths.
   */
  providerUserId?: string;
};

/** Raw persisted principal before identifier validation. */
export type PrincipalRecord = {
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  preferredLocale?: string | null;
};

export type IdentityStore = {
  loadEnabledPrincipal(
    providerUserId: string,
  ): Promise<PrincipalRecord | null>;
};

export class IdentityResolutionError extends BakeryException {
  constructor() {
    super(AuthErrorCode.IdentityUnavailable);
    this.name = "IdentityResolutionError";
  }
}

export async function resolvePrincipal(
  store: IdentityStore,
  providerUserId: string,
): Promise<AuthenticatedSubject> {
  const principal = await store.loadEnabledPrincipal(providerUserId);
  const displayName = principal?.displayName.trim() ?? "";
  if (
    !principal || !isUuid(principal.principalId) || !displayName ||
    !isPrincipalType(principal.principalType)
  ) {
    throw new IdentityResolutionError();
  }
  const preferredLocale = principal.preferredLocale;
  return {
    principalId: principalId(principal.principalId),
    principalType: principal.principalType,
    displayName,
    ...(typeof preferredLocale === "string" && preferredLocale.length > 0
      ? { preferredLocale }
      : {}),
  };
}

/**
 * Number of unused two-factor backup codes in Better Auth's decrypted,
 * serialized set (a JSON array of code strings). Anything that is not such
 * an array counts as zero: the person has no usable codes.
 */
export function countBackupCodes(serialized: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return 0;
  }
  return Array.isArray(parsed)
    ? parsed.filter((code) => typeof code === "string").length
    : 0;
}

export function getIdentity(
  principal: AuthenticatedSubject & { email: string },
  locale: SupportedLocale,
  backupCodesRemaining: number | null,
  timeZone: string | null = null,
) {
  return {
    principalId: principal.principalId,
    principalType: principal.principalType,
    displayName: principal.displayName,
    locale,
    direction: directionForLocale(locale),
    catalogVersion,
    twoFactorEnabled: principal.twoFactorEnabled ?? false,
    email: principal.email,
    backupCodesRemaining,
    timeZone,
  };
}
