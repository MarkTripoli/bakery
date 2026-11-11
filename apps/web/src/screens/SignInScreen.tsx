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
 * Which Paper artboard the screen is showing.
 *
 * `form` covers `login/github-disabled`, `login/invalid` (a `failure` notice
 * plus `aria-invalid` fields) and `login/loading` (`pending`) — one form, not
 * three screens. The rest replace the form outright: `offline`/`unavailable`
 * are the generic recovery artboards (`auth.js` L147), `throttled` is L148
 * and `expired` is the dead-end session interstitial (L179).
 */
export type SignInScreenState =
  | "form"
  | "offline"
  | "unavailable"
  | "continuation-failed"
  | "throttled"
  | "expired";

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
  /** Error notice above the form (`login/invalid`). */
  readonly failure?: MessageKey | null;
  /** Informational notice above the form (a second factor was demanded). */
  readonly notice?: MessageKey | null;
  /** Submit is disabled, `aria-busy`, and reads "Working…". */
  readonly pending?: boolean;
  readonly title?: MessageKey;
  readonly description?: MessageKey;
  readonly submitLabel?: MessageKey;
  /** Replaces the "New to Bakery?" line (the invitation variant's own link). */
  readonly footer?: ReactNode;
  readonly registerHref: string;
  /** Page-owned navigation; absent in native-link presentation fixtures. */
  readonly onRegister?: MouseEventHandler<HTMLAnchorElement>;
  readonly onEmailChange: (value: string) => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** Page-owned retry: reconcile identity after a possibly accepted submission. */
  readonly onRetry: () => void;
  /** `Back to sign in` on the offline/unavailable artboards: drop the recovery screen. */
  readonly onBackToSignIn: () => void;
  /** `Return to sign in` on the throttled artboard: drop the pause, keep the typed credentials. */
  readonly onReturnToSignIn: () => void;
  /** `Sign in again` on the expired artboard. */
  readonly onSignInAgain: () => void;
  readonly onUseDifferentAccount: () => void;
};

const RECOVERY_COPY = {
  offline: {
    title: "auth.signIn.offlineTitle",
    description: "auth.signIn.offlineDescription",
    notice: "auth.signIn.unavailable",
  },
  unavailable: {
    title: "auth.signIn.unavailableTitle",
    description: "auth.signIn.unavailableDescription",
    notice: "auth.signIn.unavailable",
  },
  "continuation-failed": {
    title: "auth.signIn.continuationTitle",
    description: "auth.signIn.continuationDescription",
    notice: "auth.signIn.continuationNotice",
  },
  throttled: {
    title: "auth.signIn.throttledTitle",
    description: "auth.signIn.throttledDescription",
    notice: "auth.signIn.throttledNotice",
  },
} as const satisfies Record<
  "offline" | "unavailable" | "continuation-failed" | "throttled",
  { title: MessageKey; description: MessageKey; notice: MessageKey }
>;

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
    focusRecoveryHeading = false,
    footer,
    notice = null,
    onBackToSignIn,
    onEmailChange,
    onPasswordChange,
    onRegister,
    onRetry,
    onReturnToSignIn,
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
    const copy = RECOVERY_COPY[state];
    return (
      <UI.AuthEntry {...brand} variant="brand">
        <UI.AuthHeading
          data-testid={`sign-in-${state}`}
          description={translate(copy.description)}
          title={translate(copy.title)}
        />
        <UI.InlineNotice tone="warning">
          {translate(copy.notice)}
        </UI.InlineNotice>
        {state === "throttled"
          ? (
            <UI.Button
              onClick={onReturnToSignIn}
              variant="secondary"
            >
              {translate("auth.signIn.returnToSignIn")}
            </UI.Button>
          )
          : (
            <>
              <UI.Button
                loading={pending}
                onClick={onRetry}
              >
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
            </>
          )}
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
      {failure
        ? (
          <UI.InlineNotice tone="error">
            {translate(failure)}
          </UI.InlineNotice>
        )
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
          {translate("auth.signIn.newToBakery")}{" "}
          <UI.Link href={registerHref} onClick={onRegister}>
            {translate("auth.signIn.joinThroughInvitation")}
          </UI.Link>
        </UI.Text>
      )}
    </UI.AuthEntry>
  );
}
