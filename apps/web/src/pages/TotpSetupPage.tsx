import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import {
  focusFirstInvalidField,
  useSingleFlightSubmit,
} from "../app/auth-form.ts";
import { BACKUP_CODES_PATH, SIGN_IN_PATH } from "../app/auth-paths.ts";
import { holdIssuedBackupCodes } from "../app/backup-codes-handoff.ts";
import { useSessionController } from "../app/session-context.tsx";
import { totpSetupKey } from "../app/totp-enrolment.ts";
import {
  rememberFreshSignInReturn,
  type TwoFactorFailure,
  twoFactorFailure,
} from "../app/two-factor-failures.ts";
import {
  TOTP_SETUP_CODE_INPUT_ID,
  TOTP_SETUP_PASSWORD_INPUT_ID,
  TotpSetupScreen,
  type TotpSetupStep,
} from "../screens/TotpSetupScreen.tsx";

/**
 * `/settings/security/two-factor/setup`: confirm the current password, then
 * scan the enrolment and verify a code from the authenticator.
 *
 * The enrolment `enable` returns (`totpUri` and the first backup-code set)
 * lives in page state only — nothing about it is persisted, so a reload
 * legitimately starts over at the password step. A verified code refreshes
 * the session, so the identity reports two-factor on, and hands the new
 * codes to the backup-codes page exactly as the artboards do. A lapsed
 * enrolment window (`TWO_FACTOR_SESSION_EXPIRED`) drops to the artboards'
 * `expired` dead end, whose primary restarts enrolment; a stale session
 * (`FRESH_SIGN_IN_REQUIRED`) detours through sign-in and returns to the
 * account overview.
 */
export function TotpSetupPage() {
  const api = useBakeryApi();
  const navigate = useNavigate();
  const sessionController = useSessionController();

  const [step, setStep] = useState<TotpSetupStep>({
    kind: "password",
    password: "",
  });
  const [issuedCodes, setIssuedCodes] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<TwoFactorFailure | null>(null);

  const submit = useCallback(async () => {
    try {
      if (step.kind === "password") {
        const enrolment = await api.auth.twoFactor.enable({
          password: step.password,
        });
        setIssuedCodes(enrolment.backupCodes);
        setFailure(null);
        setStep({
          kind: "scan",
          totpUri: enrolment.totpUri,
          code: "",
          setupKeyCopied: false,
        });
        return;
      }
      if (step.kind !== "scan") return;
      await api.auth.twoFactor.verifyTotp({ code: step.code });
      await sessionController.refresh();
      holdIssuedBackupCodes(issuedCodes);
      setFailure(null);
      void navigate({ to: BACKUP_CODES_PATH });
    } catch (error) {
      const next = twoFactorFailure(error);
      if (next.kind === "freshSignInRequired") {
        rememberFreshSignInReturn();
        void navigate({ to: SIGN_IN_PATH, search: { reason: "expired" } });
        return;
      }
      if (next.kind === "enrolmentExpired") {
        setFailure(null);
        setStep({ kind: "expired" });
        return;
      }
      setFailure(next);
      focusFirstInvalidField([
        {
          id: TOTP_SETUP_PASSWORD_INPUT_ID,
          invalid: next.kind === "invalidPassword",
        },
        { id: TOTP_SETUP_CODE_INPUT_ID, invalid: next.kind === "invalidCode" },
      ]);
    }
  }, [api, issuedCodes, navigate, sessionController, step]);

  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  return (
    <TotpSetupScreen
      failure={failure}
      onCodeChange={(code) =>
        setStep((current) =>
          current.kind === "scan" ? { ...current, code } : current
        )}
      onCopySetupKey={() => {
        if (step.kind !== "scan") return;
        const key = totpSetupKey(step.totpUri);
        void (async () => {
          let copied = false;
          try {
            await navigator.clipboard.writeText(key);
            copied = true;
          } catch {
            // Clipboard unavailable: the label stays "Copy setup key" and
            // the key remains selectable.
          }
          setStep((current) =>
            current.kind === "scan"
              ? { ...current, setupKeyCopied: copied }
              : current
          );
        })();
      }}
      onPasswordChange={(password) => setStep({ kind: "password", password })}
      onRestart={() => {
        setFailure(null);
        setStep({ kind: "password", password: "" });
      }}
      onSubmit={() => void runSubmit()}
      pending={pending}
      step={step}
    />
  );
}
