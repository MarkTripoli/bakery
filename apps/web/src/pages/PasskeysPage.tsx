import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { AuthProviderError } from "@bakery/contracts/auth-provider-client";
import { formatDate } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import {
  asyncKindForConnectivity,
  asyncKindForError,
} from "../app/async-state.ts";
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
import {
  type FactorCodeKind,
  passkeyActionFailure,
  removePasskey,
} from "../app/passkey-flows.ts";
import {
  type SecurityFailure,
  securityFailure,
} from "../app/security-failures.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  PASSKEY_REMOVE_CODE_INPUT_ID,
  PASSKEY_REMOVE_PASSWORD_INPUT_ID,
  type PasskeyRow,
  PasskeysScreen,
  type PasskeysView,
} from "../screens/PasskeysScreen.tsx";

/**
 * `/settings/security/passkeys`: lists, renames and removes passkeys through
 * the auth provider. Removal re-proves the password on the current session
 * (`reauthenticate`, never a new sign-in; an account with no password skips
 * that), proves the authenticator in place
 * when the server asks for it, and then deletes the passkey and every session
 * it created; confirmations name the device. A refused fresh sign-in routes to
 * `/account/reauthenticate` with this page as the return path.
 */
export function PasskeysPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { locale, timeZone, translate } = useI18n();
  const queryKey = protectedQueryKey(scope, "auth.passkey.list", {});

  const list = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.auth.passkey.listUserPasskeys(signal),
  });
  const connectivity = useConnectivity({
    refetch: list.refetch,
    refetching: list.isFetching,
    dataUpdatedAt: list.dataUpdatedAt,
  });
  const [view, setView] = useState<PasskeysView>({ kind: "list" });
  const [notice, setNotice] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [passwordDraft, setPasswordDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  // Set once the server asked for the authenticator code; the password has
  // been re-proved on this very session by then, so only the code is owed.
  const [factorRequired, setFactorRequired] = useState(false);
  const [codeKind, setCodeKind] = useState<FactorCodeKind>("totp");
  // Learned from the server (`PASSWORD_NOT_SET`): no password to re-prove.
  const [passwordless, setPasswordless] = useState(false);
  const signOutThenSignIn = useSignOutThenSignIn(PASSKEYS_SETTINGS_PATH);
  const [failure, setFailure] = useState<SecurityFailure | "failed" | null>(
    null,
  );

  const passkeys: readonly PasskeyRow[] = (list.data ?? []).map((passkey) => ({
    id: passkey.id,
    name: passkey.name ?? translate("passkeys.unnamed"),
    description: passkey.createdAt === null
      ? ""
      : translate("passkeys.addedOn", {
        date: formatDate(new Date(passkey.createdAt), locale, {
          dateStyle: "medium",
          timeZone,
        }),
      }),
  }));
  const target = view.kind === "list"
    ? null
    : passkeys.find((passkey) => passkey.id === view.passkeyId) ?? null;

  const close = () => {
    setView({ kind: "list" });
    setFailure(null);
    setPasswordDraft("");
    setCodeDraft("");
    setFactorRequired(false);
    setCodeKind("totp");
  };
  const toReauth = () =>
    router.history.push(
      `${REAUTH_PATH}?returnTo=${encodeURIComponent(PASSKEYS_SETTINGS_PATH)}`,
    );

  const submitRename = async () => {
    const name = nameDraft.trim();
    if (target === null || name === "") return;
    try {
      await api.auth.passkey.updatePasskey({ id: target.id, name });
      await queryClient.invalidateQueries({ queryKey });
      setNotice(translate("passkeys.renamed", { name }));
      close();
    } catch (error) {
      const next = securityFailure(error);
      if (next.kind === "reauthRequired") return toReauth();
      setFailure(next.kind === "offline" ? next : "failed");
    }
  };

  const submitRemove = async () => {
    if (target === null) return;
    // `passwordless` state lags inside this call, so track what was learned.
    let learnedPasswordless = passwordless;
    try {
      await removePasskey(api.auth, {
        passkeyId: target.id,
        password: passwordDraft,
        passwordless,
        factorRequired,
        code: codeDraft,
        codeKind,
        onPasswordless: () => {
          learnedPasswordless = true;
          setPasswordless(true);
        },
      });
      setCodeDraft("");
      await queryClient.invalidateQueries({ queryKey });
      setNotice(translate("passkeys.removed", { name: target.name }));
      close();
    } catch (error) {
      if (
        factorRequired && error instanceof AuthProviderError &&
        error.code === "TWO_FACTOR_INVALID"
      ) {
        setFailure({ kind: "invalidCode" });
        focusFirstInvalidField([
          { id: PASSKEY_REMOVE_CODE_INPUT_ID, invalid: true },
        ]);
        return;
      }
      const next = passkeyActionFailure(error, learnedPasswordless);
      if (next.kind === "reauthRequired") return toReauth();
      if (next.kind === "factorRequired") {
        setFactorRequired(true);
        setFailure(next);
        setTimeout(
          () => document.getElementById(PASSKEY_REMOVE_CODE_INPUT_ID)?.focus(),
          0,
        );
        return;
      }
      setFailure(
        next.kind === "invalidPassword" || next.kind === "lastSignInMethod" ||
          next.kind === "passwordNotSet" || next.kind === "offline"
          ? next
          : "failed",
      );
      focusFirstInvalidField([
        {
          id: PASSKEY_REMOVE_PASSWORD_INPUT_ID,
          invalid: next.kind === "invalidPassword",
        },
      ]);
    }
  };

  const [renaming, runRename] = useSingleFlightSubmit(submitRename);
  const [removing, runRemove] = useSingleFlightSubmit(submitRemove);
  const refetch = () => void list.refetch();

  return (
    <PasskeysScreen
      async={list.isPending
        ? "loading"
        : list.isError
        ? asyncKindForError(list.error)
        : failure !== null && failure !== "failed" &&
            failure.kind === "offline"
        ? "offline"
        : asyncKindForConnectivity(connectivity)}
      failure={failure}
      nameDraft={nameDraft}
      notice={notice}
      addTo={PASSKEY_ADD_PATH}
      codeDraft={codeDraft}
      codeKind={codeKind}
      factorRequired={factorRequired}
      onCodeChange={setCodeDraft}
      onToggleCodeKind={() => {
        setCodeKind(codeKind === "totp" ? "backup" : "totp");
        setCodeDraft("");
        setFailure(factorRequired ? { kind: "factorRequired" } : null);
      }}
      onSignOutThenSignIn={signOutThenSignIn}
      onCancel={close}
      onNameChange={setNameDraft}
      onPasswordChange={setPasswordDraft}
      onRefresh={refetch}
      onReload={refetch}
      onRemove={(passkeyId) => {
        setNotice(null);
        setFailure(null);
        setView({ kind: "remove", passkeyId });
      }}
      onRename={(passkeyId) => {
        setNotice(null);
        setFailure(null);
        setNameDraft(
          passkeys.find((passkey) => passkey.id === passkeyId)?.name ?? "",
        );
        setView({ kind: "rename", passkeyId });
      }}
      onRetry={refetch}
      onSubmitRemove={() => void runRemove()}
      onSubmitRename={() => void runRename()}
      passkeys={passkeys}
      passwordDraft={passwordDraft}
      passwordless={passwordless}
      pending={renaming || removing}
      view={view}
    />
  );
}
