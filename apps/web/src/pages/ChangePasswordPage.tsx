import { useCallback, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import { asyncKindForConnectivity } from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import {
  focusFirstInvalidField,
  useSingleFlightSubmit,
} from "../app/auth-form.ts";
import { PASSWORD_SETTINGS_PATH, REAUTH_PATH } from "../app/auth-paths.ts";
import {
  reauthSearch,
  type SecurityFailure,
  securityFailure,
} from "../app/security-failures.ts";
import {
  ChangePasswordScreen,
  PASSWORD_CURRENT_INPUT_ID,
  PASSWORD_NEW_INPUT_ID,
} from "../screens/ChangePasswordScreen.tsx";

/**
 * `/settings/security/password`: changes the password through the auth
 * provider and signs the other sessions out, keeping this one. A refused
 * fresh sign-in sends the person to `/account/reauthenticate` with this page
 * as the return path, so the draft is not lost to a dead end.
 */
export function ChangePasswordPage() {
  const api = useBakeryApi();
  const connectivity = useConnectivity();
  const router = useRouter();
  const [state, setState] = useState<"form" | "success">("form");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [failure, setFailure] = useState<SecurityFailure | null>(null);

  const submit = useCallback(async () => {
    try {
      await api.auth.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      setCurrentPassword("");
      setNewPassword("");
      setFailure(null);
      setState("success");
    } catch (error) {
      const next = securityFailure(error);
      if (next.kind === "reauthRequired") {
        router.history.push(
          `${REAUTH_PATH}?returnTo=${
            encodeURIComponent(reauthSearch(PASSWORD_SETTINGS_PATH).returnTo)
          }`,
        );
        return;
      }
      setFailure(next);
      focusFirstInvalidField([
        {
          id: PASSWORD_CURRENT_INPUT_ID,
          invalid: next.kind === "invalidPassword",
        },
        { id: PASSWORD_NEW_INPUT_ID, invalid: next.kind === "weakPassword" },
      ]);
    }
  }, [api, currentPassword, newPassword, router]);

  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  return (
    <ChangePasswordScreen
      async={failure?.kind === "offline"
        ? "offline"
        : asyncKindForConnectivity(connectivity)}
      currentPassword={currentPassword}
      failure={failure}
      newPassword={newPassword}
      onCurrentChange={setCurrentPassword}
      onNewChange={setNewPassword}
      onRefresh={() => setFailure(null)}
      onReload={() => setFailure(null)}
      onRetry={() => setFailure(null)}
      onSubmit={() => void runSubmit()}
      pending={pending}
      state={state}
    />
  );
}
