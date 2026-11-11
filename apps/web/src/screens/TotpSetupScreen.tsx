import { useMemo } from "react";
import * as UI from "@bakery/ui";
import {
  SECURITY_SETTINGS_PATH,
  TWO_FACTOR_SETTINGS_PATH,
} from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { totpQrModules, totpSetupKey } from "../app/totp-enrolment.ts";
import type { TwoFactorFailure } from "../app/two-factor-failures.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { AccountSettingsBackLink } from "./settings-back.tsx";

/** Exported so the container can focus the field a failure rejected. */
export const TOTP_SETUP_PASSWORD_INPUT_ID = "totp-setup-password";
export const TOTP_SETUP_CODE_INPUT_ID = "totp-setup-code";

export type TotpSetupStep =
  /** Paper `default`: confirm the current password before enrolling. */
  | { readonly kind: "password"; readonly password: string }
  /** Paper `scan`/`invalid`/`loading`: the enrolment to scan and verify. */
  | {
    readonly kind: "scan";
    readonly totpUri: string;
    readonly code: string;
    /** The setup key reached the clipboard (Paper swaps the label to "Copied"). */
    readonly setupKeyCopied: boolean;
  }
  /** Paper `expired`: the enrolment lapsed before it was verified. */
  | { readonly kind: "expired" };

export type TotpSetupScreenProps = {
  readonly step: TotpSetupStep;
  readonly pending: boolean;
  readonly failure: TwoFactorFailure | null;
  readonly onPasswordChange: (password: string) => void;
  readonly onCodeChange: (code: string) => void;
  readonly onSubmit: () => void;
  readonly onCopySetupKey: () => void;
  /** `expired`'s "Restart setup" primary. */
  readonly onRestart: () => void;
};

/**
 * `/settings/security/two-factor/setup` presenter — Paper `totp-setup`
 * (auth.js `protectionScreen`): the password confirmation, then the QR code
 * and setup key beside the six-digit verification (the same layout carries
 * the rejected code and the working submit), and the dead end the artboards
 * call `expired`, which restarts enrolment.
 */
export function TotpSetupScreen(
  {
    failure,
    onCodeChange,
    onCopySetupKey,
    onPasswordChange,
    onRestart,
    onSubmit,
    pending,
    step,
  }: TotpSetupScreenProps,
) {
  const { translate } = useI18n();
  // The enrolment URI is fixed for the whole scan step; encode it once, not
  // on every keystroke in the code field.
  const totpUri = step.kind === "scan" ? step.totpUri : null;
  const modules = useMemo(
    () => (totpUri === null ? null : totpQrModules(totpUri)),
    [totpUri],
  );
  const notice = failure?.kind === "notice"
    ? (
      <UI.InlineNotice tone="error">
        {failure.retryAfterSeconds === null
          ? translate(failure.messageKey)
          : translate(failure.messageKey, {
            retryAfterSeconds: failure.retryAfterSeconds,
          })}
      </UI.InlineNotice>
    )
    : null;

  if (step.kind === "expired") {
    return (
      <UI.SettingsContent
        back={<AccountSettingsBackLink />}
        data-testid="totp-setup"
      >
        <UI.FormContent>
          <UI.AuthHeading
            description={translate(
              "auth.settings.twoFactor.setup.expiredDescription",
            )}
            title={translate("auth.settings.twoFactor.setup.expiredTitle")}
          />
          <UI.InlineNotice tone="warning">
            {translate("auth.settings.twoFactor.setup.notTurnedOnNotice")}
          </UI.InlineNotice>
          <UI.Button onClick={onRestart}>
            {translate("auth.settings.twoFactor.setup.restartSetup")}
          </UI.Button>
          <RouterLink to={SECURITY_SETTINGS_PATH}>
            {translate("auth.settings.twoFactor.setup.backToSecurity")}
          </RouterLink>
        </UI.FormContent>
      </UI.SettingsContent>
    );
  }

  if (step.kind === "password") {
    return (
      <UI.SettingsContent
        back={<AccountSettingsBackLink />}
        data-testid="totp-setup"
      >
        <UI.FormContent>
          <UI.AuthHeading
            description={translate(
              "auth.settings.twoFactor.setup.confirmDescription",
            )}
            title={translate("auth.settings.twoFactor.setup.confirmTitle")}
          />
          {notice}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <UI.Stack gap="standard">
              <UI.Field
                error={failure?.kind === "invalidPassword"
                  ? translate("auth.settings.twoFactor.setup.passwordError")
                  : undefined}
                htmlFor={TOTP_SETUP_PASSWORD_INPUT_ID}
                label={translate("auth.twoFactor.confirmPassword")}
              >
                <UI.PasswordInput
                  autoComplete="current-password"
                  id={TOTP_SETUP_PASSWORD_INPUT_ID}
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
                  value={step.password}
                />
              </UI.Field>
              <UI.Button loading={pending} type="submit">
                {translate(
                  pending
                    ? "auth.common.pendingAction"
                    : "auth.settings.twoFactor.setup.continue",
                )}
              </UI.Button>
            </UI.Stack>
          </form>
          <RouterLink to={TWO_FACTOR_SETTINGS_PATH}>
            {translate("auth.settings.twoFactor.setup.cancel")}
          </RouterLink>
        </UI.FormContent>
      </UI.SettingsContent>
    );
  }

  const invalid = failure?.kind === "invalidCode";
  return (
    <UI.SettingsContent
      back={<AccountSettingsBackLink />}
      data-testid="totp-setup"
    >
      <UI.FormContent>
        <UI.AuthHeading
          description={translate(
            "auth.settings.twoFactor.setup.scanDescription",
          )}
          title={translate("auth.settings.twoFactor.setup.scanTitle")}
        />
        {notice}
        <UI.QrSetup
          code={
            <UI.QrCode
              label={translate("auth.settings.twoFactor.setup.scanTitle")}
              modules={modules ?? []}
            />
          }
        >
          <UI.Heading level="subsection" rank={2}>
            {translate("auth.settings.twoFactor.setup.cantScanTitle")}
          </UI.Heading>
          <UI.Text variant="hint">
            {translate("auth.settings.twoFactor.setup.setupKeyHint")}
          </UI.Text>
          <UI.SetupKey>{totpSetupKey(step.totpUri)}</UI.SetupKey>
          <UI.Button onClick={onCopySetupKey} variant="secondary">
            {translate(
              step.setupKeyCopied
                ? "auth.twoFactor.copied"
                : "auth.settings.twoFactor.setup.copySetupKey",
            )}
          </UI.Button>
        </UI.QrSetup>
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
              htmlFor={TOTP_SETUP_CODE_INPUT_ID}
              label={translate("auth.twoFactor.code")}
            >
              <UI.OneTimeCodeInput
                id={TOTP_SETUP_CODE_INPUT_ID}
                invalid={invalid}
                kind="totp"
                name="code"
                onChange={onCodeChange}
                placeholder={translate(
                  "auth.twoFactor.challenge.codePlaceholder",
                )}
                value={step.code}
              />
            </UI.Field>
            <UI.Button loading={pending} type="submit">
              {translate(
                pending
                  ? "auth.common.pendingAction"
                  : "auth.settings.twoFactor.setup.verifyAndTurnOn",
              )}
            </UI.Button>
          </UI.Stack>
        </form>
        <RouterLink to={TWO_FACTOR_SETTINGS_PATH}>
          {translate("auth.settings.twoFactor.setup.cancelSetup")}
        </RouterLink>
      </UI.FormContent>
    </UI.SettingsContent>
  );
}
