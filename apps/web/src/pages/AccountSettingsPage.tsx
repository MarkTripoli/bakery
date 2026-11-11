import { useSession } from "../app/session-context.tsx";
import { AccountSettingsScreen } from "../screens/AccountSettingsScreen.tsx";

/**
 * `/settings/security`: the account overview. Every fact comes from the
 * session's `PrincipalIdentity`; the actions are links to the two-factor and
 * sessions pages, so nothing here mutates. `confirmed` is the route's
 * `?confirmed=1` search flag: the flows that require a fresh sign-in (the
 * two-factor pages) return here with it set once the person has signed in
 * again, and the page opens with the "Your identity was confirmed." notice.
 */
export function AccountSettingsPage(
  { confirmed }: { readonly confirmed: boolean },
) {
  const { identity } = useSession();
  // `requireSession` only lets an authenticated session reach this route, and
  // an authenticated snapshot always carries its identity.
  if (identity === null) return null;
  return (
    <AccountSettingsScreen
      backupCodesRemaining={identity.backupCodesRemaining ?? 0}
      confirmed={confirmed}
      displayName={identity.displayName}
      email={identity.email}
      twoFactorEnabled={identity.twoFactorEnabled}
    />
  );
}
