import { useEffect } from "react";
import type { MouseEventHandler, ReactNode } from "react";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

/** `focusFirstInvalidField` targets these; the page and the screen agree. */
export const SIGN_IN_EMAIL_FIELD_ID = "sign-in-email";
export const SIGN_IN_PASSWORD_FIELD_ID = "sign-in-password";

/**
 * Which screen is showing. `form` is the password form in every state it has:
 * ready, pending, or with a `failure` message under the fields (wrong
 * credentials, too many tries, a locked account, offline, unreachable). The
 * other two replace the form: `continuation-failed` (the password was
 * accepted but the next step failed) and `expired` (the dead-end session
 * interstitial).
 */
export type SignInScreenState = "form" | "continuation-failed" | "expired";

export type SignInScreenProps = {
  /**
   * `brand` is `/sign-in`; `context` is the `?invitation=` deep link, whose
   * left column is supplied through `context`.
   */
  readonly variant: "brand" | "context";
  /** Context-variant summary column (the invitation card). */
  readonly context?: ReactNode;
  readonly state: SignInScreenState;
  /** Interactive pages own recovery focus; standalone presenters leave it alone. */
  readonly focusRecoveryHeading?: boolean;
  readonly email: string;
  readonly password: string;
  /**
   * The `invite-login` artboard prefills the invited address and locks it:
   * the invitation, not the visitor, decides which account may accept it
   * (`auth.js` L160 `{value:'alex@example.com',readonly:true}`).
   */
  readonly emailReadOnly?: boolean;
  readonly emailInvalid?: boolean;
  readonly passwordInvalid?: boolean;
  /** The message under the fields when a sign-in attempt failed. */
  readonly failure?: MessageKey | null;
  /** Values for the failure message, such as the wait before another try. */
  readonly failureParams?: Readonly<Record<string, string>>;
  /** Tone of the failure message: a mistake is an error, being offline is a warning. */
  readonly failureTone?: "error" | "warning";
  /** Informational notice above the form (a second factor was demanded). */
  readonly notice?: MessageKey | null;
  /** Submit is disabled, `aria-busy`, and reads "Working…". */
  readonly pending?: boolean;
  readonly title?: MessageKey;
  readonly description?: MessageKey;
  readonly submitLabel?: MessageKey;
  /** Replaces the "No account?" line (the invitation variant's own link). */
  readonly footer?: ReactNode;
  readonly registerHref: string;
  /** Page-owned navigation; absent in native-link presentation fixtures. */
  readonly onRegister?: MouseEventHandler<HTMLAnchorElement>;
  readonly onEmailChange: (value: string) => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** Page-owned retry: reconcile identity after a possibly accepted submission. */
  readonly onRetry: () => void;
  /** `Back to sign in` on the continuation-failed screen: drop it. */
  readonly onBackToSignIn: () => void;
  /** Where "Forgot password?" goes; absent in presentation fixtures that use a plain link. */
  readonly forgotPasswordHref?: string;
  readonly onForgotPassword?: MouseEventHandler<HTMLAnchorElement>;
  /** `Sign in again` on the expired artboard. */
  readonly onSignInAgain: () => void;
  readonly onUseDifferentAccount: () => void;
};

const CONTINUATION_COPY = {
  title: "auth.signIn.continuationTitle",
  description: "auth.signIn.continuationDescription",
  notice: "auth.signIn.continuationNotice",
} as const satisfies Record<"title" | "description" | "notice", MessageKey>;

/**
 * `/sign-in` in every shape Paper draws it: the password form, the three
 * recovery dead-ends the provider can force, and the expired-session
 * interstitial. Pure presenter — the page owns submission, navigation and
 * failure classification.
 */
export function SignInScreen(
  {
    context,
    description = "auth.signIn.description",
    email,
    emailInvalid = false,
    emailReadOnly = false,
    failure = null,
    failureParams,
    failureTone = "error",
    focusRecoveryHeading = false,
    forgotPasswordHref = "/sign-in/forgot-password",
    footer,
    notice = null,
    onBackToSignIn,
    onEmailChange,
    onForgotPassword,
    onPasswordChange,
    onRegister,
    onRetry,
    onSignInAgain,
    onSubmit,
    onUseDifferentAccount,
    password,
    passwordInvalid = false,
    pending = false,
    registerHref,
    state,
    submitLabel = "auth.signIn.submit",
    title = "auth.signIn.title",
    variant,
  }: SignInScreenProps,
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();

  useEffect(() => {
    if (!focusRecoveryHeading || state === "form") return;
    document.querySelector<HTMLElement>(
      `[data-testid="sign-in-${state}"] h1`,
    )?.focus();
  }, [focusRecoveryHeading, pending, state]);

  if (state === "expired") {
    return (
      <UI.AuthEntry {...brand} variant="brand">
        <UI.AuthHeading
          data-testid="sign-in-expired"
          description={translate("auth.sessionExpired.description")}
          title={translate("auth.sessionExpired.title")}
        />
        <UI.InlineNotice tone="information">
          {translate("auth.expired.notice")}
        </UI.InlineNotice>
        <UI.Button onClick={onSignInAgain}>
          {translate("auth.expired.signInAgain")}
        </UI.Button>
        <UI.Link
          href="#"
          onClick={(event) => {
            event.preventDefault();
            onUseDifferentAccount();
          }}
        >
          {translate("auth.expired.useDifferentAccount")}
        </UI.Link>
      </UI.AuthEntry>
    );
  }

  if (state !== "form") {
    return (
      <UI.AuthEntry {...brand} variant="brand">
        <UI.AuthHeading
          data-testid={`sign-in-${state}`}
          description={translate(CONTINUATION_COPY.description)}
          title={translate(CONTINUATION_COPY.title)}
        />
        <UI.InlineNotice tone="warning">
          {translate(CONTINUATION_COPY.notice)}
        </UI.InlineNotice>
        <UI.Button loading={pending} onClick={onRetry}>
          {translate("auth.signIn.tryAgain")}
        </UI.Button>
        <UI.Link
          href="#"
          onClick={(event) => {
            event.preventDefault();
            onBackToSignIn();
          }}
        >
          {translate("auth.signIn.backToSignIn")}
        </UI.Link>
      </UI.AuthEntry>
    );
  }

  return (
    <UI.AuthEntry
      {...brand}
      context={variant === "context" ? context : undefined}
      variant={variant}
    >
      <UI.AuthHeading
        data-testid={variant === "context" ? "sign-in-invite" : "sign-in"}
        description={translate(description)}
        title={translate(title)}
      />
      {notice
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
            error={emailInvalid
              ? translate("problems.VALIDATION_FAILED.title")
              : undefined}
            htmlFor={SIGN_IN_EMAIL_FIELD_ID}
            label={translate("auth.signIn.email")}
            state={emailReadOnly ? "readonly" : "default"}
          >
            <UI.TextInput
              autoComplete="email"
              id={SIGN_IN_EMAIL_FIELD_ID}
              invalid={emailInvalid}
              name="email"
              onChange={onEmailChange}
              placeholder={emailReadOnly
                ? undefined
                : translate("auth.signIn.emailPlaceholder")}
              readOnly={emailReadOnly}
              required={!emailReadOnly}
              type="email"
              value={email}
            />
          </UI.Field>
          <UI.Field
            error={passwordInvalid
              ? translate("problems.VALIDATION_FAILED.title")
              : undefined}
            htmlFor={SIGN_IN_PASSWORD_FIELD_ID}
            label={translate("auth.signIn.password")}
            labelEnd={
              <UI.Link
                data-testid="sign-in-forgot-password"
                href={forgotPasswordHref}
                onClick={onForgotPassword}
                variant="sentence"
              >
                {translate("auth.signIn.forgotPassword")}
              </UI.Link>
            }
          >
            <UI.PasswordInput
              autoComplete="current-password"
              id={SIGN_IN_PASSWORD_FIELD_ID}
              invalid={passwordInvalid}
              name="password"
              onChange={onPasswordChange}
              placeholder={translate("auth.signIn.passwordPlaceholder")}
              required
              revealLabels={{
                hide: translate("auth.signIn.hidePassword"),
                show: translate("auth.signIn.showPassword"),
              }}
              value={password}
            />
          </UI.Field>
          {failure
            ? (
              <UI.InlineNotice data-testid="sign-in-failure" tone={failureTone}>
                {translate(failure, failureParams)}
              </UI.InlineNotice>
            )
            : null}
          <UI.Button
            data-testid="sign-in-submit"
            loading={pending}
            type="submit"
          >
            {translate(pending ? "auth.common.pendingAction" : submitLabel)}
          </UI.Button>
        </UI.Stack>
      </form>
      {footer ?? (
        <UI.Text variant="hint">
          {translate("auth.signIn.noAccount")}{" "}
          <UI.Link href={registerHref} onClick={onRegister}>
            {translate("auth.signIn.howToGetOne")}
          </UI.Link>
        </UI.Text>
      )}
    </UI.AuthEntry>
  );
}
