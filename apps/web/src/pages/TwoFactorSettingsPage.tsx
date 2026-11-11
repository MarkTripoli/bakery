import { useNavigate } from "@tanstack/react-router";
import { TWO_FACTOR_SETUP_PATH } from "../app/auth-paths.ts";
import { useSession } from "../app/session-context.tsx";
import { TwoFactorSettingsScreen } from "../screens/TwoFactorSettingsScreen.tsx";

/**
 * `/settings/security/two-factor`: the protection overview. Everything it
 * shows already lives on the session identity (`twoFactorEnabled`,
 * `backupCodesRemaining`), so there is no query here — the child pages
 * refresh the session after enabling or disabling and this page re-renders
 * with the new counts.
 */
export function TwoFactorSettingsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const identity = session.identity;

  return (
    <TwoFactorSettingsScreen
      backupCodesRemaining={identity?.backupCodesRemaining ?? null}
      enabled={identity?.twoFactorEnabled ?? false}
      onSetUp={() => void navigate({ to: TWO_FACTOR_SETUP_PATH })}
    />
  );
}
