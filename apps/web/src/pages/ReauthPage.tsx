import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import { asyncKindForConnectivity } from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import {
  focusFirstInvalidField,
  useSingleFlightSubmit,
} from "../app/auth-form.ts";
import { SECURITY_SETTINGS_PATH } from "../app/auth-paths.ts";
import { useSignOutThenSignIn } from "../app/security-actions.ts";
import {
  safeReturnPath,
  type SecurityFailure,
  securityFailure,
} from "../app/security-failures.ts";
import { useSession, useSessionController } from "../app/session-context.tsx";
import {
  REAUTH_PASSWORD_INPUT_ID,
  ReauthScreen,
} from "../screens/ReauthScreen.tsx";

/** Where a confirmed identity lands when no return path was supplied. */
const DEFAULT_RETURN = `${SECURITY_SETTINGS_PATH}?confirmed=1`;

/**
 * `/account/reauthenticate`: re-proves the password on the current session
 * for an action that was refused for want of a fresh sign-in. `returnTo` is
 * the page that sent the person here; it is validated as a same-origin path
 * and the person goes back to it on success. An authenticator code the action
 * still needs is proved in place on that page. Accounts with no password are
 * offered sign-out-then-sign-in with the same return path.
 */
export function ReauthPage({ returnTo }: { readonly returnTo: string | null }) {
  const api = useBakeryApi();
  const connectivity = useConnectivity();
  const router = useRouter();
  const { identity } = useSession();
  const sessionController = useSessionController();
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<SecurityFailure | null>(null);
  const destination = safeReturnPath(returnTo, DEFAULT_RETURN);
  const signOutThenSignIn = useSignOutThenSignIn(destination);

  const submit = async () => {
    if (identity === null) return;
    try {
      // Stamp the CURRENT session; no new session is created, so there is no
      // superseded session to leave behind and the cookie stays valid.
      await api.auth.reauthenticate({ password });
      await sessionController.refresh();
      setPassword("");
      router.history.push(destination);
    } catch (error) {
      const next = securityFailure(error);
      setFailure(
        next.kind === "reauthRequired" ? { kind: "invalidPassword" } : next,
      );
      focusFirstInvalidField([
        {
          id: REAUTH_PASSWORD_INPUT_ID,
          invalid: next.kind !== "offline" && next.kind !== "passwordNotSet",
        },
      ]);
    }
  };

  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  return (
    <ReauthScreen
      async={failure?.kind === "offline"
        ? "offline"
        : asyncKindForConnectivity(connectivity)}
      cancelTo={safeReturnPath(returnTo, SECURITY_SETTINGS_PATH)}
      displayName={identity?.displayName ?? ""}
      email={identity?.email ?? ""}
      failure={failure}
      onPasswordChange={setPassword}
      onRefresh={() => setFailure(null)}
      onReload={() => setFailure(null)}
      onRetry={() => setFailure(null)}
      onSignOutThenSignIn={signOutThenSignIn}
      onSubmit={() => void runSubmit()}
      password={password}
      pending={pending}
    />
  );
}
