import type { ReactNode } from "react";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

/** `focusFirstInvalidField` targets these; the page and the screen agree. */
export const REGISTER_NAME_FIELD_ID = "register-name";
export const REGISTER_EMAIL_FIELD_ID = "register-email";
export const REGISTER_PASSWORD_FIELD_ID = "register-password";

export type RegisterScreenProps = {
  /** `contextShell` summary column — the invitation card. */
  readonly context?: ReactNode;
  /**
   * `form` is Paper's `register` artboard in all four of its states
   * (`default`, `invalid`, `existing`, `loading` differ only by the notice,
   * the password message and the pending submit). `submitted` is the
   * anti-enumeration dead end `signUpEmail` always resolves to: it never
   * claims an account was created, so Paper has no artboard for it.
   */
  readonly state?: "form" | "submitted";
  readonly name: string;
  /**
   * The invited address. Fixed by the invitation, so Paper draws it
   * read-only with the "set by your invitation" hint (`auth.js` L161).
   */
  readonly email: string;
  readonly password: string;
  readonly nameInvalid?: boolean;
  readonly passwordInvalid?: boolean;
  /** Field message under the password input (`register/invalid`'s policy copy). */
  readonly passwordError?: MessageKey | null;
  /** Error notice above the form (`register/invalid`). */
  readonly failure?: MessageKey | null;
  /** Informational notice above the form (`register/existing`). */
  readonly notice?: MessageKey | null;
  /** Submit is disabled, `aria-busy`, and reads "Working…". */
  readonly pending?: boolean;
  /** Signups are switched off for this installation: say so, block submit. */
  readonly registrationPaused?: boolean;
  readonly signInHref: string;
  readonly onNameChange: (value: string) => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** `Already have an account? Sign in`, keeping the invitation return. */
  readonly onSignIn: () => void;
};

/**
 * `/register?invitation=<uuid>` (Paper `register`, `contextShell`). Pure
 * presenter — the page owns the invitation preview, `signUpEmail` and every
 * navigation.
 */
export function RegisterScreen(
  {
    context,
    email,
    failure = null,
    name,
    nameInvalid = false,
    notice = null,
    onNameChange,
    onPasswordChange,
    onSignIn,
    onSubmit,
    password,
    passwordError = null,
    passwordInvalid = false,
    pending = false,
    registrationPaused = false,
    signInHref,
    state = "form",
  }: RegisterScreenProps,
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();
  if (state === "submitted") {
    return (
      <UI.AuthEntry {...brand} context={context} variant="context">
        <UI.AuthHeading
          data-testid="register-submitted"
          description={translate("auth.signUp.submittedDescription")}
          title={translate("auth.signUp.submitted")}
        />
        <UI.Button onClick={onSignIn}>
          {translate("core.actions.signIn")}
        </UI.Button>
      </UI.AuthEntry>
    );
  }

  return (
    <UI.AuthEntry {...brand} context={context} variant="context">
      <UI.AuthHeading
        data-testid="register"
        description={translate("auth.register.description")}
        title={translate("auth.signUp.title")}
      />
      {registrationPaused
        ? (
          <UI.InlineNotice data-testid="registration-paused" tone="warning">
            {translate("features.registrationPaused.notice")}
          </UI.InlineNotice>
        )
        : null}
      {failure
        ? <UI.InlineNotice tone="error">{translate(failure)}</UI.InlineNotice>
        : notice
        ? (
          <UI.InlineNotice tone="information">
            {translate(notice)}
          </UI.InlineNotice>
        )
        : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            error={nameInvalid
              ? translate("problems.VALIDATION_FAILED.title")
              : undefined}
            htmlFor={REGISTER_NAME_FIELD_ID}
            label={translate("auth.signUp.name")}
          >
            <UI.TextInput
              autoComplete="name"
              id={REGISTER_NAME_FIELD_ID}
              invalid={nameInvalid}
              name="name"
              onChange={onNameChange}
              placeholder={translate("auth.register.namePlaceholder")}
              required
              type="text"
              value={name}
            />
          </UI.Field>
          <UI.Field
            hint={translate("auth.signUp.emailHint")}
            htmlFor={REGISTER_EMAIL_FIELD_ID}
            label={translate("auth.signUp.email")}
            state="readonly"
          >
            <UI.TextInput
              autoComplete="email"
              id={REGISTER_EMAIL_FIELD_ID}
              name="email"
              onChange={() => {}}
              readOnly
              type="email"
              value={email}
            />
          </UI.Field>
          <UI.Field
            error={passwordError
              ? translate(passwordError)
              : passwordInvalid
              ? translate("problems.VALIDATION_FAILED.title")
              : undefined}
            hint={translate("auth.register.passwordHint")}
            htmlFor={REGISTER_PASSWORD_FIELD_ID}
            label={translate("auth.signUp.password")}
          >
            <UI.PasswordInput
              autoComplete="new-password"
              id={REGISTER_PASSWORD_FIELD_ID}
              invalid={passwordError !== null || passwordInvalid}
              name="password"
              onChange={onPasswordChange}
              placeholder={translate("auth.register.passwordPlaceholder")}
              required
              revealLabels={{
                hide: translate("auth.signIn.hidePassword"),
                show: translate("auth.signIn.showPassword"),
              }}
              value={password}
            />
          </UI.Field>
          <UI.Button
            data-testid="register-submit"
            disabled={registrationPaused}
            loading={pending}
            type="submit"
          >
            {translate(
              pending ? "auth.common.pendingAction" : "auth.signUp.submit",
            )}
          </UI.Button>
        </UI.Stack>
      </form>
      <UI.Link
        href={signInHref}
        onClick={(event) => {
          event.preventDefault();
          onSignIn();
        }}
      >
        {translate("auth.register.alreadyHaveAccount")}
      </UI.Link>
    </UI.AuthEntry>
  );
}
