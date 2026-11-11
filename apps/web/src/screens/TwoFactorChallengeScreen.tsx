import { useEffect } from "react";
import * as UI from "@bakery/ui";
import { RECOVERY_CODE_PATH, SIGN_IN_PATH } from "../app/auth-paths.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

export type TwoFactorChallengeFailure =
  | "invalid"
  | "expired"
  | "rate-limited"
  | "continuation-failed"
  | "unavailable";

export type TwoFactorChallengeScreenProps = {
  readonly code: string;
  readonly onCodeChange: (code: string) => void;
  readonly onSubmit: () => void;
  /** `expired`'s single "Back to sign in" button. */
  readonly onBackToSignIn: () => void;
  readonly pending: boolean;
  readonly failure: TwoFactorChallengeFailure | null;
  /** Interactive pages own recovery focus; standalone presenters leave it alone. */
  readonly focusRecoveryHeading?: boolean;
};

/** Exported so the container can focus the field after a rejected code. */
export const TWO_FACTOR_CODE_INPUT_ID = "two-factor-code";

/**
 * `/sign-in/two-factor` presenter — Paper `totp-challenge` (auth.js
 * `protectionScreen`): `default`/`invalid`/`loading` share the code form;
 * `rate-limited` replaces it with a warning notice and a disabled primary;
 * `expired` is a dead end with a single "Back to sign in" button.
 * `unavailable` is not a Paper artboard: it stays on the form with the same
 * inline notice `/sign-in` uses for its equivalent failure.
 */
export function TwoFactorChallengeScreen(
  {
    code,
    failure,
    focusRecoveryHeading = false,
    onBackToSignIn,
    onCodeChange,
    onSubmit,
    pending,
  }: TwoFactorChallengeScreenProps,
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();

  useEffect(() => {
    if (!focusRecoveryHeading) return;
    if (
      failure !== "continuation-failed" &&
      failure !== "expired" &&
      failure !== "rate-limited"
    ) {
      return;
    }
    document.querySelector<HTMLElement>(
      `[data-testid="two-factor-${failure}"] h1`,
    )?.focus();
  }, [failure, focusRecoveryHeading, pending]);

  if (failure === "expired") {
    return (
      <UI.AuthEntry variant="brand" {...brand}>
        <UI.AuthHeading
          data-testid="two-factor-expired"
          description={translate("auth.twoFactor.expiredSignIn")}
          title={translate("auth.twoFactor.challenge.expiredTitle")}
        />
        <UI.Button onClick={onBackToSignIn}>
          {translate("auth.twoFactor.challenge.backToSignIn")}
        </UI.Button>
      </UI.AuthEntry>
    );
  }

  if (failure === "rate-limited") {
    return (
      <UI.AuthEntry variant="brand" {...brand}>
        <UI.AuthHeading
          data-testid="two-factor-rate-limited"
          description={translate("auth.twoFactor.locked")}
          title={translate("auth.twoFactor.challenge.rateLimitedTitle")}
        />
        <UI.InlineNotice tone="warning">
          {translate("auth.twoFactor.challenge.rateLimitedNotice")}
        </UI.InlineNotice>
        <UI.Button disabled>
          {translate("auth.twoFactor.challenge.verificationPaused")}
        </UI.Button>
        <UI.Link href={SIGN_IN_PATH}>
          {translate("auth.twoFactor.challenge.backToSignIn")}
        </UI.Link>
      </UI.AuthEntry>
    );
  }

  if (failure === "continuation-failed") {
    return (
      <UI.AuthEntry variant="brand" {...brand}>
        <UI.AuthHeading
          data-testid="two-factor-continuation-failed"
          description={translate("auth.signIn.continuationDescription")}
          title={translate("auth.signIn.continuationTitle")}
        />
        <UI.InlineNotice tone="error">
          {translate("auth.signIn.continuationNotice")}
        </UI.InlineNotice>
        <UI.Button loading={pending} onClick={onSubmit}>
          {translate(
            pending ? "auth.common.pendingAction" : "auth.signIn.tryAgain",
          )}
        </UI.Button>
        <UI.Link
          href={SIGN_IN_PATH}
          onClick={(event) => {
            event.preventDefault();
            onBackToSignIn();
          }}
        >
          {translate("auth.twoFactor.challenge.backToSignIn")}
        </UI.Link>
      </UI.AuthEntry>
    );
  }

  const invalid = failure === "invalid";
  return (
    <UI.AuthEntry variant="brand" {...brand}>
      <UI.AuthHeading
        data-testid="two-factor"
        description={translate("auth.twoFactor.challenge.description")}
        title={translate("auth.twoFactor.challengeTitle")}
      />
      {failure === "unavailable"
        ? (
          <UI.InlineNotice tone="error">
            {translate("auth.signIn.unavailable")}
          </UI.InlineNotice>
        )
        : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            error={invalid ? translate("auth.twoFactor.invalid") : undefined}
            hint={translate("auth.twoFactor.codeHint")}
            htmlFor={TWO_FACTOR_CODE_INPUT_ID}
            label={translate("auth.twoFactor.code")}
          >
            <UI.OneTimeCodeInput
              id={TWO_FACTOR_CODE_INPUT_ID}
              invalid={invalid}
              kind="totp"
              name="code"
              onChange={onCodeChange}
              placeholder={translate(
                "auth.twoFactor.challenge.codePlaceholder",
              )}
              value={code}
            />
          </UI.Field>
          <UI.Button loading={pending} type="submit">
            {translate(
              pending ? "auth.common.pendingAction" : "auth.twoFactor.verify",
            )}
          </UI.Button>
        </UI.Stack>
      </form>
      <UI.Link href={RECOVERY_CODE_PATH}>
        {translate("auth.twoFactor.useBackupCode")}
      </UI.Link>
      <UI.Link
        href={SIGN_IN_PATH}
        onClick={(event) => {
          event.preventDefault();
          onBackToSignIn();
        }}
      >
        {translate("auth.twoFactor.challenge.backToSignIn")}
      </UI.Link>
    </UI.AuthEntry>
  );
}
