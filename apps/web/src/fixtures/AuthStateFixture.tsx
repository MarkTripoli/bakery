import type { JSX } from "react";
import { useParams } from "@tanstack/react-router";
import { expiredSpecimens } from "./auth/expired.tsx";
import { inviteSpecimens } from "./auth/invite.tsx";
import { inviteLoginSpecimens } from "./auth/invite-login.tsx";
import { joinSpecimens } from "./auth/join.tsx";
import { loginSpecimens } from "./auth/login.tsx";
import { sectionIndexSpecimens } from "./auth/section-index.tsx";
import { accessSpecimens } from "./auth/access.tsx";
import { appearanceSpecimens } from "./auth/appearance.tsx";
import { profileSpecimens } from "./auth/profile.tsx";
import { organizationsSpecimens } from "./auth/organizations.tsx";
import { securitySpecimens } from "./auth/security.tsx";
import { sessionsSpecimens } from "./auth/sessions.tsx";
import { revokeSpecimens } from "./auth/revoke.tsx";
import { clientsSpecimens } from "./auth/clients.tsx";
import { consentSpecimens } from "./auth/consent.tsx";
import { revokeClientSpecimens } from "./auth/revoke-client.tsx";
import { setupSpecimens } from "./auth/setup.tsx";
import { registerSpecimens } from "./auth/register.tsx";
import { totpChallengeSpecimens } from "./auth/totp-challenge.tsx";
import { backupChallengeSpecimens } from "./auth/backup-challenge.tsx";
import { backupCodesSpecimens } from "./auth/backup-codes.tsx";
import { totpDisableSpecimens } from "./auth/totp-disable.tsx";
import { totpSetupSpecimens } from "./auth/totp-setup.tsx";
import { twoFactorSpecimens } from "./auth/two-factor.tsx";
import { signoutSpecimens } from "./auth/signout.tsx";
import { securityHubSpecimens } from "./auth/security-hub.tsx";
import { passwordSpecimens } from "./auth/password.tsx";
import { passkeysSpecimens } from "./auth/passkeys.tsx";
import { passkeyAddSpecimens } from "./auth/passkey-add.tsx";
import { reauthSpecimens } from "./auth/reauth.tsx";

type Specimens = Readonly<Record<string, () => JSX.Element>>;

function prefixed(screen: string, specimens: Specimens): Specimens {
  return Object.fromEntries(
    Object.entries(specimens).map((
      [state, render],
    ) => [`${screen}-${state}`, render]),
  );
}

/**
 * Every `<screen>-<state>` specimen across every auth screen, keyed exactly
 * as `/__fixtures__/auth/$state` resolves them. `routeCoverage`'s
 * `fixture-auth` entry lists only the bare (deduplicated) state tokens —
 * `check-ui-architecture.mjs` validates literal state names, not this
 * per-screen fan-out — so `apps/web/tests/shell.spec.ts` reads
 * `authFixtureStates` directly to enumerate every real URL.
 */
const registry: Specimens = {
  ...prefixed("setup", setupSpecimens),
  ...prefixed("login", loginSpecimens),
  ...prefixed("expired", expiredSpecimens),
  ...prefixed("join", joinSpecimens),
  ...prefixed("register", registerSpecimens),
  ...prefixed("invite", inviteSpecimens),
  ...prefixed("invite-login", inviteLoginSpecimens),
  ...prefixed("organizations", organizationsSpecimens),
  ...prefixed("profile", profileSpecimens),
  ...prefixed("appearance", appearanceSpecimens),
  ...prefixed("your-access", accessSpecimens),
  ...prefixed("section-index", sectionIndexSpecimens),
  ...prefixed("security", securitySpecimens),
  ...prefixed("sessions", sessionsSpecimens),
  ...prefixed("revoke", revokeSpecimens),
  ...prefixed("revoke-client", revokeClientSpecimens),
  ...prefixed("clients", clientsSpecimens),
  ...prefixed("consent", consentSpecimens),
  ...prefixed("totp-challenge", totpChallengeSpecimens),
  ...prefixed("two-factor", twoFactorSpecimens),
  ...prefixed("totp-setup", totpSetupSpecimens),
  ...prefixed("backup-codes", backupCodesSpecimens),
  ...prefixed("totp-disable", totpDisableSpecimens),
  ...prefixed("backup-challenge", backupChallengeSpecimens),
  ...prefixed("signout", signoutSpecimens),
  ...prefixed("security-hub", securityHubSpecimens),
  ...prefixed("password", passwordSpecimens),
  ...prefixed("passkeys", passkeysSpecimens),
  ...prefixed("passkey-add", passkeyAddSpecimens),
  ...prefixed("reauth", reauthSpecimens),
};

export const authFixtureStates: readonly string[] = Object.keys(registry);

export function AuthStateFixture() {
  const { state } = useParams({ strict: false }) as { state?: string };
  const render = (state && registry[state]) || null;
  if (!render) {
    throw new Error(`No auth fixture specimen registered for state ${state}`);
  }
  return render();
}
