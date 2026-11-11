import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import {
  focusFirstInvalidField,
  useSingleFlightSubmit,
} from "../app/auth-form.ts";
import { SIGN_IN_PATH, TWO_FACTOR_SETTINGS_PATH } from "../app/auth-paths.ts";
import {
  clearIssuedBackupCodes,
  readIssuedBackupCodes,
} from "../app/backup-codes-handoff.ts";
import {
  rememberFreshSignInReturn,
  type TwoFactorFailure,
  twoFactorFailure,
} from "../app/two-factor-failures.ts";
import {
  BACKUP_CODES_CODE_INPUT_ID,
  BACKUP_CODES_PASSWORD_INPUT_ID,
  BackupCodesScreen,
  type BackupCodesView,
} from "../screens/BackupCodesScreen.tsx";

const BACKUP_CODES_FILE_NAME = "bakery-backup-codes.txt";

/**
 * `/settings/security/two-factor/backup-codes`: shows a set of codes once, or
 * confirms replacing the current set.
 *
 * Codes are only ever readable at the moment the server issues them, so the
 * set shown here is the one authenticator setup (or the confirmation below)
 * just handed over in memory. `?regenerate=1` — the link the protection
 * overview offers — and any arrival without an issued set both open the
 * confirmation instead, which proves the authenticator
 * (`verifyTotp`, `FACTOR_PROOF_REQUIRED`'s requirement) before
 * `generateBackupCodes` replaces the set with the password.
 */
export function BackupCodesPage(
  { regenerate }: { readonly regenerate: boolean },
) {
  const api = useBakeryApi();
  const navigate = useNavigate();

  const issued = readIssuedBackupCodes();
  const [codes, setCodes] = useState<readonly string[]>(
    regenerate || issued === null ? [] : issued,
  );
  const [regenerated, setRegenerated] = useState(false);
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<TwoFactorFailure | null>(null);
  // A verified code is consumed by the server's replay guard, so the proof
  // it stamps (valid for five minutes) is kept here and the code field is
  // cleared: a wrong password afterwards retries the regeneration alone
  // instead of re-sending a spent code and counting a failed verification.
  const [factorProved, setFactorProved] = useState(false);

  // The issued set is shown once: it leaves memory with this page, however
  // the page is left.
  useEffect(() => clearIssuedBackupCodes, []);

  const submit = useCallback(async () => {
    try {
      if (!factorProved) {
        await api.auth.twoFactor.verifyTotp({ code });
        setFactorProved(true);
        setCode("");
      }
      const replacement = await api.auth.twoFactor.generateBackupCodes({
        password,
      });
      setCodes(replacement.backupCodes);
      setRegenerated(true);
      setCopied(false);
      setPassword("");
      setFactorProved(false);
      setFailure(null);
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
          id: BACKUP_CODES_PASSWORD_INPUT_ID,
          invalid: next.kind === "invalidPassword",
        },
        {
          id: BACKUP_CODES_CODE_INPUT_ID,
          invalid: next.kind === "invalidCode" ||
            next.kind === "factorProofRequired",
        },
      ]);
    }
  }, [api, code, factorProved, navigate, password]);

  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  const view: BackupCodesView = codes.length === 0
    ? { kind: "regenerate", code, password }
    : { codes, copied, kind: "codes", regenerated };

  return (
    <BackupCodesScreen
      failure={failure}
      onAcknowledge={() => {
        clearIssuedBackupCodes();
        void navigate({ to: TWO_FACTOR_SETTINGS_PATH });
      }}
      onCodeChange={setCode}
      onCopy={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(codes.join("\n"));
            setCopied(true);
          } catch {
            // Clipboard unavailable: the label stays "Copy codes" and the
            // codes remain selectable and downloadable.
            setCopied(false);
          }
        })();
      }}
      onDownload={() => {
        const file = new Blob([`${codes.join("\n")}\n`], {
          type: "text/plain",
        });
        const href = URL.createObjectURL(file);
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = BACKUP_CODES_FILE_NAME;
        anchor.click();
        URL.revokeObjectURL(href);
      }}
      onPasswordChange={setPassword}
      onSubmit={() => void runSubmit()}
      pending={pending}
      view={view}
    />
  );
}
