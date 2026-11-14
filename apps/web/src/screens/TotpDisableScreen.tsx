import * as UI from "@bakery/ui";
import { TWO_FACTOR_SETTINGS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import type { TwoFactorFailure } from "../app/two-factor-failures.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** Exported so the container can focus the field a failure rejected. */
export const TOTP_DISABLE_PASSWORD_INPUT_ID = "totp-disable-password";
export const TOTP_DISABLE_CODE_INPUT_ID = "totp-disable-code";

export type TotpDisableScreenProps = {
  /** `confirm` is Paper `default`/`invalid`; `disabled` the done state. */
  readonly state: "confirm" | "disabled";
  readonly password: string;
  readonly code: string;
  readonly pending: boolean;
  readonly failure: TwoFactorFailure | null;
  readonly onPasswordChange: (password: string) => void;
  readonly onCodeChange: (code: string) => void;
  readonly onSubmit: () => void;
  /** `disabled`'s "Back to security" secondary (Paper renders a button). */
  readonly onBackToSecurity: () => void;
};

/**
 * `/settings/security/two-factor/disable` presenter — Paper `totp-disable`
 * (auth.js `protectionScreen`): the warning about the backup codes going
 * with it, the password + authenticator confirmation, and the state that
 * reports protection is off with the way back to the account overview.
 */
export function TotpDisableScreen(
  {
    code,
    failure,
    onBackToSecurity,
    onCodeChange,
    onPasswordChange,
    onSubmit,
    password,
    pending,
    state,
  }: TotpDisableScreenProps,
) {
  const { translate } = useI18n();

  if (state === "disabled") {
    return (
      <UI.SettingsContent data-testid="totp-disable">
        <UI.FormContent>
          <UI.AuthHeading
            description={translate(
              "auth.settings.twoFactor.disable.disabledDescription",
            )}
            title={translate(
              "auth.settings.twoFactor.disable.disabledTitle",
            )}
          />
          <UI.InlineNotice tone="information">
            {translate(
              "auth.settings.twoFactor.disable.stillConnectedNotice",
            )}
          </UI.InlineNotice>
          <UI.Button onClick={onBackToSecurity} variant="secondary">
            {translate("auth.settings.twoFactor.disable.backToSecurity")}
          </UI.Button>
        </UI.FormContent>
      </UI.SettingsContent>
    );
  }

  const invalidCode = failure?.kind === "invalidCode" ||
    failure?.kind === "factorProofRequired";
  return (
    <UI.SettingsContent data-testid="totp-disable">
      <UI.FormContent>
        <UI.AuthHeading
          description={translate(
            "auth.settings.twoFactor.disable.confirmDescription",
          )}
          title={translate("auth.settings.twoFactor.disable.confirmTitle")}
        />
        <UI.InlineNotice tone="warning">
          {translate("auth.settings.twoFactor.disable.backupCodesWarning")}
        </UI.InlineNotice>
        {failure?.kind === "notice"
          ? (
            <UI.InlineNotice tone="error">
              {failure.retryAfterSeconds === null
                ? translate(failure.messageKey)
                : translate(failure.messageKey, {
                  retryAfterSeconds: failure.retryAfterSeconds,
                })}
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
              error={failure?.kind === "invalidPassword"
                ? translate("auth.settings.twoFactor.disable.passwordError")
                : undefined}
              htmlFor={TOTP_DISABLE_PASSWORD_INPUT_ID}
              label={translate("auth.twoFactor.confirmPassword")}
            >
              <UI.PasswordInput
                autoComplete="current-password"
                id={TOTP_DISABLE_PASSWORD_INPUT_ID}
                invalid={failure?.kind === "invalidPassword"}
                name="password"
                onChange={onPasswordChange}
                placeholder={translate(
                  "auth.twoFactor.currentPasswordPlaceholder",
                )}
                revealLabels={{
                  hide: translate("auth.signIn.hidePassword"),
                  show: translate("auth.signIn.showPassword"),
                }}
                value={password}
              />
            </UI.Field>
            <UI.Field
              error={invalidCode
                ? translate("auth.settings.twoFactor.disable.invalidCode")
                : undefined}
              hint={translate("auth.twoFactor.codeHint")}
              htmlFor={TOTP_DISABLE_CODE_INPUT_ID}
              label={translate("auth.twoFactor.code")}
            >
              <UI.OneTimeCodeInput
                id={TOTP_DISABLE_CODE_INPUT_ID}
                invalid={invalidCode}
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
                pending
                  ? "auth.common.pendingAction"
                  : "auth.twoFactor.disableTitle",
              )}
            </UI.Button>
          </UI.Stack>
        </form>
        <RouterLink to={TWO_FACTOR_SETTINGS_PATH}>
          {translate("auth.settings.twoFactor.disable.cancel")}
        </RouterLink>
      </UI.FormContent>
    </UI.SettingsContent>
  );
}
