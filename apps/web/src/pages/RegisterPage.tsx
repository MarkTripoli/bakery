import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import {
  AuthProviderError,
  type AuthProviderFailureCode,
} from "@bakery/contracts/auth-provider-client";
import { useBakeryApi } from "../api/context.tsx";
import {
  installationCapabilitiesQueryOptions,
  invitationPreviewQueryOptions,
} from "../api/query.ts";
import {
  focusFirstInvalidField,
  providerFailureMessageKey,
  useSingleFlightSubmit,
} from "../app/auth-form.ts";
import { rememberReturnTo, safeSessionStorage } from "../app/auth-return.ts";
import { SIGN_IN_PATH } from "../app/auth-required.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { InvitationContextCard } from "../screens/InvitationContextCard.tsx";
import { InvitationScreen } from "../screens/InvitationScreen.tsx";
import {
  REGISTER_NAME_FIELD_ID,
  REGISTER_PASSWORD_FIELD_ID,
  RegisterScreen,
} from "../screens/RegisterScreen.tsx";

/* Paper's `register` has one notice slot and no throttled artboard, so
   every provider failure resolves to a single param-free sentence — the
   same copy `/sign-in`'s throttled and offline recovery screens use. */
const FAILURE_MESSAGE_KEYS: Readonly<
  Partial<Record<AuthProviderFailureCode, MessageKey>>
> = {
  LOCKED: "auth.signIn.locked",
  NETWORK: "auth.signIn.offline",
  RATE_LIMITED: "auth.signIn.throttledNotice",
};

/**
 * `/register?invitation=<uuid>` (Paper `register`, `contextShell`).
 * `RegisterRoute`'s component renders this only once `invitation` is a valid
 * UUID; otherwise it renders `JoinPage` instead — no redirect either way.
 *
 * `organizationInvitations.preview` is anonymous, so the invitation fills
 * both the summary column and the locked invited address: the account being
 * created is the invitation's recipient, never an address the visitor types.
 * A preview that does not resolve means the invitation is not pending and
 * unexpired, which is Paper's `invite/revoked` dead end (the same one
 * `/invitations/:id` shows) — there is nothing to register against.
 *
 * `signUpEmail` always resolves `{kind:"submitted"}` whether or not the
 * address matches a live invitation — the copy never claims the account was
 * created — except a genuine `ACCOUNT_EXISTS` conflict, which the provider
 * does report and Paper draws as `register/existing`.
 */
export function RegisterPage(
  { invitationId }: { readonly invitationId: string },
) {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const navigate = useNavigate();

  const preview = useQuery(invitationPreviewQueryOptions(api, invitationId));
  const invitation = preview.data ?? null;
  const availability = useQuery(installationCapabilitiesQueryOptions(api));
  const registrationPaused = availability.data?.registration === "closed";

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [nameInvalid, setNameInvalid] = useState(false);
  const [passwordInvalid, setPasswordInvalid] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [failureCode, setFailureCode] = useState<
    AuthProviderFailureCode | null
  >(null);

  const signInWithReturnTo = () => {
    rememberReturnTo(
      { pathname: `/invitations/${invitationId}`, search: "", hash: "" },
      safeSessionStorage(),
    );
    void navigate({ to: SIGN_IN_PATH, search: { invitation: invitationId } });
  };

  const [submitting, run] = useSingleFlightSubmit(async () => {
    if (invitation === null) return;
    const trimmedName = name.trim();
    const nameBad = trimmedName.length === 0;
    const passwordBad = password.length === 0;
    setNameInvalid(nameBad);
    setPasswordInvalid(passwordBad);
    setConflict(false);
    setFailureCode(null);
    if (nameBad || passwordBad) {
      focusFirstInvalidField([
        { id: REGISTER_NAME_FIELD_ID, invalid: nameBad },
        { id: REGISTER_PASSWORD_FIELD_ID, invalid: passwordBad },
      ]);
      return;
    }
    try {
      await api.auth.signUpEmail({
        name: trimmedName,
        email: invitation.email,
        password,
      });
      setPassword("");
      setSubmitted(true);
    } catch (error) {
      setPassword("");
      if (error instanceof AuthProviderError) {
        if (error.code === "ACCOUNT_EXISTS") setConflict(true);
        else setFailureCode(error.code);
      } else {
        setFailureCode("UNAVAILABLE");
      }
    }
  });

  const previewFailure = preview.isError ? preview.error : null;
  if (
    previewFailure !== null && previewFailure.kind === "problem" &&
    (previewFailure.problem.code === "RESOURCE_NOT_FOUND" ||
      previewFailure.problem.code === "MALFORMED_REQUEST")
  ) {
    return (
      <InvitationScreen
        onAccept={() => {}}
        onBackToSignIn={() => void navigate({ to: SIGN_IN_PATH })}
        onCreateAccount={() => {}}
        onDecline={() => {}}
        onOpenOrganization={() => {}}
        onSignIn={signInWithReturnTo}
        signInHref={`${SIGN_IN_PATH}?invitation=${
          encodeURIComponent(invitationId)
        }`}
        onSwitchAccount={() => {}}
        state="revoked"
      />
    );
  }

  if (preview.isPending) {
    return (
      <UI.AuthEntry variant="context">
        <UI.Stack data-testid="register-loading" gap="spacious">
          <UI.Heading level="page" tabIndex={-1}>
            {translate("shell.states.loadingTitle")}
          </UI.Heading>
          <UI.Skeleton shape="text" />
        </UI.Stack>
      </UI.AuthEntry>
    );
  }

  if (invitation === null) {
    return (
      <UI.AuthEntry variant="context">
        <UI.ErrorState
          action={
            <UI.Button onClick={() => void preview.refetch()}>
              {translate("core.actions.retry")}
            </UI.Button>
          }
          data-testid="register-error"
          description={translate("problems.UNKNOWN.description")}
          title={translate("problems.UNKNOWN.title")}
          variant="page"
        />
      </UI.AuthEntry>
    );
  }

  // A rejected password is Paper's `register/invalid`: the generic notice
  // plus the policy message on the password field. Every other provider
  // failure is a single notice sentence.
  const weakPassword = failureCode === "WEAK_PASSWORD";
  const failure: MessageKey | null =
    nameInvalid || passwordInvalid || weakPassword
      ? "auth.register.invalidNotice"
      : failureCode === null
      ? null
      : providerFailureMessageKey<AuthProviderFailureCode, MessageKey>(
        failureCode,
        FAILURE_MESSAGE_KEYS,
        "auth.signIn.unavailable",
      );

  return (
    <RegisterScreen
      context={
        <InvitationContextCard
          inviterDisplayName={invitation.inviterDisplayName}
          organizationName={invitation.organizationName}
          role={invitation.role}
        />
      }
      email={invitation.email}
      failure={conflict ? null : failure}
      name={name}
      nameInvalid={nameInvalid}
      notice={conflict ? "auth.signUp.accountExists" : null}
      onNameChange={setName}
      onPasswordChange={setPassword}
      onSignIn={signInWithReturnTo}
      onSubmit={() => void run()}
      password={password}
      passwordError={weakPassword ? "auth.register.passwordPolicyError" : null}
      passwordInvalid={passwordInvalid || weakPassword}
      pending={submitting}
      registrationPaused={registrationPaused}
      signInHref={SIGN_IN_PATH}
      state={submitted ? "submitted" : "form"}
    />
  );
}
