import { type MouseEventHandler, useEffect } from "react";
import * as UI from "@bakery/ui";
import { SIGN_IN_PATH, TWO_FACTOR_PATH } from "../app/auth-paths.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";

export type RecoveryCodeFailure =
  | "invalid"
  | "no-access"
  | "continuation-failed"
  | "unavailable";

export type RecoveryCodeScreenProps = {
  readonly code: string;
  readonly onCodeChange: (code: string) => void;
  readonly onSubmit: () => void;
  /** Page-owned navigation; absent in native-link presentation fixtures. */
  readonly onUseAuthenticator?: MouseEventHandler<HTMLAnchorElement>;
  /** "I don't have a backup code" → the `no-access` dead end. */
  readonly onNoBackupCode: () => void;
  /** Escapes a consumed-code continuation failure without showing the form. */
  readonly onBackToSignIn: () => void;
  readonly pending: boolean;
  readonly failure: RecoveryCodeFailure | null;
  /** Interactive pages own recovery focus; standalone presenters leave it alone. */
  readonly focusRecoveryHeading?: boolean;
};

/** Exported so the container can focus the field after a rejected code. */
export const RECOVERY_CODE_INPUT_ID = "recovery-code";

/**
 * `/sign-in/recovery-code` presenter — Paper `backup-challenge` (auth.js
 * `protectionScreen`): `default`/`invalid`/`loading` share the backup-code
 * form; `no-access` replaces it with a warning notice and a single "Back to
 * sign in" link. `unavailable` is not a Paper artboard: it stays on the form
 * with the same inline notice `/sign-in` uses for its equivalent failure.
 */
export function RecoveryCodeScreen(
  {
    code,
    failure,
    focusRecoveryHeading = false,
    onBackToSignIn,
    onCodeChange,
    onNoBackupCode,
    onSubmit,
    onUseAuthenticator,
    pending,
  }: RecoveryCodeScreenProps,
) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();

  useEffect(() => {
    if (!focusRecoveryHeading) return;
    if (failure !== "continuation-failed" && failure !== "no-access") {
      return;
    }
    document.querySelector<HTMLElement>(
      `[data-testid="recovery-code-${failure}"] h1`,
    )?.focus();
  }, [failure, focusRecoveryHeading, pending]);

  if (failure === "no-access") {
    return (
      <UI.AuthEntry variant="brand" {...brand}>
        <UI.AuthHeading
          data-testid="recovery-code-no-access"
          description={translate("auth.twoFactor.backup.noAccessDescription")}
          title={translate("auth.twoFactor.backup.noAccessTitle")}
        />
        <UI.InlineNotice tone="warning">
          {translate("auth.twoFactor.backup.noAccessNotice")}
        </UI.InlineNotice>
        <UI.Link href={SIGN_IN_PATH}>
          {translate("auth.twoFactor.backup.backToSignIn")}
        </UI.Link>
      </UI.AuthEntry>
    );
  }
  if (failure === "continuation-failed") {
    return (
      <UI.AuthEntry variant="brand" {...brand}>
        <UI.AuthHeading
          data-testid="recovery-code-continuation-failed"
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
          {translate("auth.twoFactor.backup.backToSignIn")}
        </UI.Link>
      </UI.AuthEntry>
    );
  }

  const invalid = failure === "invalid";
  return (
    <UI.AuthEntry variant="brand" {...brand}>
      <UI.AuthHeading
        data-testid="recovery-code"
        description={translate("auth.twoFactor.backup.description")}
        title={translate("auth.twoFactor.backup.title")}
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
            error={invalid
              ? translate("auth.twoFactor.backup.invalidCode")
              : undefined}
            hint={translate("auth.twoFactor.backup.hint")}
            htmlFor={RECOVERY_CODE_INPUT_ID}
            label={translate("auth.twoFactor.backupCode")}
          >
            <UI.OneTimeCodeInput
              id={RECOVERY_CODE_INPUT_ID}
              invalid={invalid}
              kind="backup"
              name="code"
              onChange={onCodeChange}
              placeholder={translate("auth.twoFactor.backup.placeholder")}
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
      <UI.Link href={TWO_FACTOR_PATH} onClick={onUseAuthenticator}>
        {translate("auth.twoFactor.useAuthenticator")}
      </UI.Link>
      <UI.Link
        href="#"
        onClick={(event) => {
          event.preventDefault();
          onNoBackupCode();
        }}
      >
        {translate("auth.twoFactor.backup.noBackupCode")}
      </UI.Link>
    </UI.AuthEntry>
  );
}
