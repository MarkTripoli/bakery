import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useBakeryApi } from "../api/context.tsx";
import { asyncKindForConnectivity } from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import {
  focusFirstInvalidField,
  useSingleFlightSubmit,
} from "../app/auth-form.ts";
import {
  PASSKEY_ADD_PATH,
  PASSKEYS_SETTINGS_PATH,
  REAUTH_PATH,
} from "../app/auth-paths.ts";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useSignOutThenSignIn } from "../app/security-actions.ts";
import type { SecurityFailure } from "../app/security-failures.ts";
import { useSession } from "../app/session-context.tsx";
import { passkeyActionFailure, registerPasskey } from "../app/passkey-flows.ts";
import { browserCredentials, WebAuthnCeremonyError } from "../app/webauthn.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  AddPasskeyScreen,
  type AddPasskeyStep,
  PASSKEY_ADD_PASSWORD_INPUT_ID,
} from "../screens/AddPasskeyScreen.tsx";

/**
 * `/settings/security/passkeys/new`: re-proves the password on the current
 * session (`reauthenticate`, never a new sign-in; an account with no password
 * skips this and goes straight to the passkey action), asks the provider
 * for creation options, runs the native WebAuthn ceremony and hands the
 * credential back for verification. A dismissed prompt is `canceled`, a
 * browser without WebAuthn is `unsupported` (checked before anything is
 * asked of the person), and a refused fresh sign-in routes to
 * `/account/reauthenticate` with this page as the return path.
 */
export function AddPasskeyPage() {
  const api = useBakeryApi();
  const connectivity = useConnectivity();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { identity } = useSession();
  const { translate } = useI18n();
  const [step, setStep] = useState<AddPasskeyStep>(() =>
    browserCredentials() === null ? "unsupported" : "form"
  );
  const [nameDraft, setNameDraft] = useState(() =>
    translate("passkeys.unnamed")
  );
  const [passwordDraft, setPasswordDraft] = useState("");
  // Learned from the server (`PASSWORD_NOT_SET`): the account has no password,
  // so the field is hidden and the action runs without a password proof.
  const [passwordless, setPasswordless] = useState(false);
  const [savedName, setSavedName] = useState("");
  const [failure, setFailure] = useState<SecurityFailure | null>(null);
  const ceremony = useRef<AbortController | null>(null);
  const signOutThenSignIn = useSignOutThenSignIn(PASSKEY_ADD_PATH);

  const submit = async () => {
    const name = nameDraft.trim() || translate("passkeys.unnamed");
    const abort = new AbortController();
    // `passwordless` state lags inside this call, so track what was learned.
    let learnedPasswordless = passwordless;
    try {
      const outcome = await registerPasskey({ auth: api.auth }, {
        name,
        password: passwordDraft,
        passwordless,
        signal: abort.signal,
        onPasswordless: () => {
          learnedPasswordless = true;
          setPasswordless(true);
        },
        onPrompt: () => {
          setFailure(null);
          ceremony.current = abort;
          setStep("prompt");
        },
      });
      ceremony.current = null;
      // Cancel won the race with the credential: nothing was registered.
      if (outcome === "aborted") return;
      await queryClient.invalidateQueries({
        queryKey: protectedQueryKey(scope, "auth.passkey.list", {}),
      });
      setSavedName(name);
      setPasswordDraft("");
      setStep("success");
    } catch (error) {
      ceremony.current = null;
      if (error instanceof WebAuthnCeremonyError) {
        setStep(error.kind);
        return;
      }
      const next = passkeyActionFailure(error, learnedPasswordless);
      if (next.kind === "reauthRequired") {
        router.history.push(
          `${REAUTH_PATH}?returnTo=${encodeURIComponent(PASSKEY_ADD_PATH)}`,
        );
        return;
      }
      setStep("form");
      setFailure(next);
      focusFirstInvalidField([
        {
          id: PASSKEY_ADD_PASSWORD_INPUT_ID,
          invalid: next.kind === "invalidPassword",
        },
      ]);
    }
  };

  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  return (
    <AddPasskeyScreen
      async={failure?.kind === "offline"
        ? "offline"
        : asyncKindForConnectivity(connectivity)}
      email={identity?.email ?? ""}
      failure={failure}
      nameDraft={nameDraft}
      onCancel={() => {
        if (step === "prompt") {
          // Abort the browser prompt so a late approval cannot register a
          // passkey after the page said none was added.
          ceremony.current?.abort();
          ceremony.current = null;
          setStep("canceled");
        } else void router.history.push(PASSKEYS_SETTINGS_PATH);
      }}
      manageTo={PASSKEYS_SETTINGS_PATH}
      onSignOutThenSignIn={signOutThenSignIn}
      onNameChange={setNameDraft}
      onPasswordChange={setPasswordDraft}
      onRefresh={() => setFailure(null)}
      onReload={() => setFailure(null)}
      onRetry={() => setFailure(null)}
      onSubmit={() => void runSubmit()}
      onTryAgain={() => {
        setFailure(null);
        setStep("form");
      }}
      passwordDraft={passwordDraft}
      passwordless={passwordless}
      pending={pending && step === "form"}
      savedName={savedName}
      step={step}
    />
  );
}
