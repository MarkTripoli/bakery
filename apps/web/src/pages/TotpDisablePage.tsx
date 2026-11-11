import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import {
  focusFirstInvalidField,
  useSingleFlightSubmit,
} from "../app/auth-form.ts";
import { SECURITY_SETTINGS_PATH, SIGN_IN_PATH } from "../app/auth-paths.ts";
import { clearIssuedBackupCodes } from "../app/backup-codes-handoff.ts";
import { useSessionController } from "../app/session-context.tsx";
import {
  rememberFreshSignInReturn,
  type TwoFactorFailure,
  twoFactorFailure,
} from "../app/two-factor-failures.ts";
import {
  TOTP_DISABLE_CODE_INPUT_ID,
  TOTP_DISABLE_PASSWORD_INPUT_ID,
  TotpDisableScreen,
} from "../screens/TotpDisableScreen.tsx";

/**
 * `/settings/security/two-factor/disable`: proves the authenticator
 * (`verifyTotp`) and then the password (`disable`) before turning protection
 * off, refreshes the session so the identity stops reporting two-factor, and
 * stays on the confirmation the artboards call `disabled`. Any codes still
 * held for the backup-codes page are dropped — they no longer verify
 * anything.
 */
export function TotpDisablePage() {
  const api = useBakeryApi();
  const navigate = useNavigate();
  const sessionController = useSessionController();

  const [state, setState] = useState<"confirm" | "disabled">("confirm");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<TwoFactorFailure | null>(null);
  // A verified code is consumed by the server's replay guard, so the proof
  // it stamps (valid for five minutes) is kept here and the code field is
  // cleared: a wrong password afterwards retries the disable alone instead
  // of re-sending a spent code and counting a failed verification.
  const [factorProved, setFactorProved] = useState(false);

  const submit = useCallback(async () => {
    try {
      if (!factorProved) {
        await api.auth.twoFactor.verifyTotp({ code });
        setFactorProved(true);
        setCode("");
      }
      await api.auth.twoFactor.disable({ password });
      await sessionController.refresh();
      clearIssuedBackupCodes();
      setPassword("");
      setFactorProved(false);
      setFailure(null);
      setState("disabled");
    } catch (error) {
      const next = twoFactorFailure(error);
      if (next.kind === "freshSignInRequired") {
        rememberFreshSignInReturn();
        void navigate({ to: SIGN_IN_PATH, search: { reason: "expired" } });
        return;
      }
      if (next.kind === "factorProofRequired") setFactorProved(false);
      // No enrolment is pending here, so a lapsed challenge cookie can only
      // mean the code no longer verifies: report it on the code field.
      setFailure(
        next.kind === "enrolmentExpired" ? { kind: "invalidCode" } : next,
      );
      focusFirstInvalidField([
        {
          id: TOTP_DISABLE_CODE_INPUT_ID,
          invalid: next.kind === "invalidCode" ||
            next.kind === "factorProofRequired",
        },
        {
          id: TOTP_DISABLE_PASSWORD_INPUT_ID,
          invalid: next.kind === "invalidPassword",
        },
      ]);
    }
  }, [api, code, factorProved, navigate, password, sessionController]);

  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  return (
    <TotpDisableScreen
      code={code}
      failure={failure}
      onBackToSecurity={() => void navigate({ to: SECURITY_SETTINGS_PATH })}
      onCodeChange={setCode}
      onPasswordChange={setPassword}
      onSubmit={() => void runSubmit()}
      password={password}
      pending={pending}
      state={state}
    />
  );
}
