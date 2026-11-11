import * as UI from "@bakery/ui";
import { TWO_FACTOR_SETTINGS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import type { TwoFactorFailure } from "../app/two-factor-failures.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { AccountSettingsBackLink } from "./settings-back.tsx";

/** Exported so the container can focus the field a failure rejected. */
export const BACKUP_CODES_PASSWORD_INPUT_ID = "backup-codes-password";
export const BACKUP_CODES_CODE_INPUT_ID = "backup-codes-code";

export type BackupCodesView =
  /**
   * Paper `default`/`copied`/`regenerated`: a set of codes to save once.
   * `regenerated` swaps the notice for the "new codes are ready" one, and
   * `copied` is the same view after the copy action reported success.
   */
  | {
    readonly kind: "codes";
    readonly codes: readonly string[];
    readonly regenerated: boolean;
    readonly copied: boolean;
  }
  /** Paper `regenerate`/`invalid`: confirm before replacing the set. */
  | {
    readonly kind: "regenerate";
    readonly password: string;
    readonly code: string;
  };

export type BackupCodesScreenProps = {
  readonly view: BackupCodesView;
  readonly pending: boolean;
  readonly failure: TwoFactorFailure | null;
  readonly onPasswordChange: (password: string) => void;
  readonly onCodeChange: (code: string) => void;
  /** Submits the regeneration form. */
  readonly onSubmit: () => void;
  readonly onCopy: () => void;
  readonly onDownload: () => void;
  /** "I've saved these codes" — leaves for the protection overview. */
  readonly onAcknowledge: () => void;
};

/**
 * `/settings/security/two-factor/backup-codes` presenter — Paper
 * `backup-codes` (auth.js `protectionScreen`): the saved-once code plate
 * with its copy/download actions and live copy confirmation, and the
 * password + authenticator confirmation that replaces the whole set.
 */
export function BackupCodesScreen(
  {
    failure,
    onAcknowledge,
    onCodeChange,
    onCopy,
    onDownload,
    onPasswordChange,
    onSubmit,
    pending,
    view,
  }: BackupCodesScreenProps,
) {
  const { translate } = useI18n();
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

  if (view.kind === "regenerate") {
    return (
      <UI.SettingsContent
        back={<AccountSettingsBackLink />}
        data-testid="backup-codes"
      >
        <UI.FormContent>
          <UI.AuthHeading
            description={translate(
              "auth.settings.backupCodes.regenerateDescription",
            )}
            title={translate("auth.settings.backupCodes.regenerateTitle")}
          />
          <UI.InlineNotice tone="warning">
            {translate("auth.settings.backupCodes.regenerateWarning")}
          </UI.InlineNotice>
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
                  ? translate("auth.settings.backupCodes.passwordError")
                  : undefined}
                htmlFor={BACKUP_CODES_PASSWORD_INPUT_ID}
                label={translate("auth.twoFactor.confirmPassword")}
              >
                <UI.PasswordInput
                  autoComplete="current-password"
                  id={BACKUP_CODES_PASSWORD_INPUT_ID}
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
                  value={view.password}
                />
              </UI.Field>
              <UI.Field
                error={failure?.kind === "invalidCode" ||
                    failure?.kind === "factorProofRequired"
                  ? translate("auth.twoFactor.invalid")
                  : undefined}
                hint={translate("auth.twoFactor.codeHint")}
                htmlFor={BACKUP_CODES_CODE_INPUT_ID}
                label={translate("auth.twoFactor.code")}
              >
                <UI.OneTimeCodeInput
                  id={BACKUP_CODES_CODE_INPUT_ID}
                  invalid={failure?.kind === "invalidCode" ||
                    failure?.kind === "factorProofRequired"}
                  kind="totp"
                  name="code"
                  onChange={onCodeChange}
                  placeholder={translate(
                    "auth.twoFactor.challenge.codePlaceholder",
                  )}
                  value={view.code}
                />
              </UI.Field>
              <UI.Button loading={pending} type="submit">
                {translate(
                  pending
                    ? "auth.common.pendingAction"
                    : "auth.settings.backupCodes.generateNewCodes",
                )}
              </UI.Button>
            </UI.Stack>
          </form>
          <RouterLink to={TWO_FACTOR_SETTINGS_PATH}>
            {translate("auth.settings.backupCodes.cancel")}
          </RouterLink>
        </UI.FormContent>
      </UI.SettingsContent>
    );
  }

  return (
    <UI.SettingsContent
      back={<AccountSettingsBackLink />}
      data-testid="backup-codes"
    >
      <UI.FormContent>
        <UI.AuthHeading
          description={translate("auth.twoFactor.backupDescription")}
          title={translate("auth.twoFactor.backupTitle")}
        />
        <UI.InlineNotice tone="success">
          {translate(
            view.regenerated
              ? "auth.settings.backupCodes.regeneratedNotice"
              : "auth.settings.backupCodes.saveNotice",
          )}
        </UI.InlineNotice>
        {notice}
        <UI.BackupCodeList codes={view.codes} />
        <UI.Text variant="muted">
          {translate("auth.settings.backupCodes.keepSafeNotice")}
        </UI.Text>
        <UI.Inline variant="actions">
          <UI.Button onClick={onCopy} variant="secondary">
            {translate(
              view.copied ? "auth.twoFactor.copied" : "auth.twoFactor.copy",
            )}
          </UI.Button>
          <UI.Button onClick={onDownload} variant="secondary">
            {translate("auth.twoFactor.download")}
          </UI.Button>
        </UI.Inline>
        <UI.Text role="status" variant="hint">
          {view.copied
            ? translate("auth.settings.backupCodes.copiedStatus")
            : ""}
        </UI.Text>
        <UI.Button onClick={onAcknowledge}>
          {translate("auth.twoFactor.acknowledge")}
        </UI.Button>
      </UI.FormContent>
    </UI.SettingsContent>
  );
}
