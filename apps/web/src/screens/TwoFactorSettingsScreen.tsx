import * as UI from "@bakery/ui";
import {
  BACKUP_CODES_PATH,
  TWO_FACTOR_DISABLE_PATH,
} from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { AccountSettingsBackLink } from "./settings-back.tsx";

export type TwoFactorSettingsScreenProps = {
  readonly enabled: boolean;
  /**
   * Unused backup codes; `null` while two-factor is off. Zero is the
   * artboard's `no-codes` state: the row says so and a warning asks for a
   * new set.
   */
  readonly backupCodesRemaining: number | null;
  /** Opens authenticator setup (Paper's `.btn.primary` on the off state). */
  readonly onSetUp: () => void;
};

/**
 * `/settings/security/two-factor` presenter — Paper `two-factor`
 * (auth.js `protectionScreen`): the authenticator row with its On/Off badge,
 * and below it either the recovery block (backup-code count, a link to a new
 * set, the warning when none are left, and the link that turns protection
 * off) or, while protection is off, the "keep your codes available" notice
 * and the setup button.
 */
export function TwoFactorSettingsScreen(
  { backupCodesRemaining, enabled, onSetUp }: TwoFactorSettingsScreenProps,
) {
  const { translate } = useI18n();
  const remaining = backupCodesRemaining ?? 0;
  return (
    <UI.SettingsContent
      back={<AccountSettingsBackLink />}
      data-testid="two-factor-settings"
    >
      <UI.AuthHeading
        description={translate("auth.settings.twoFactor.description")}
        title={translate("auth.twoFactor.sectionTitle")}
      />
      <UI.DescriptionItem
        action={
          <UI.Badge tone={enabled ? "success" : "neutral"}>
            {translate(
              enabled ? "auth.twoFactor.enabled" : "auth.twoFactor.disabled",
            )}
          </UI.Badge>
        }
        description={translate(
          enabled
            ? "auth.settings.twoFactor.authenticatorAppOn"
            : "auth.settings.twoFactor.authenticatorAppOff",
        )}
        icon={<UI.IconGlyph name="shield" size="large" />}
        title={translate("auth.settings.twoFactor.authenticatorAppTitle")}
      />
      {enabled
        ? (
          <>
            <UI.SettingsSection
              title={translate("auth.settings.twoFactor.recoveryHeading")}
              variant="stack"
            >
              <UI.DescriptionItem
                action={
                  <RouterLink
                    search={{ regenerate: true }}
                    to={BACKUP_CODES_PATH}
                  >
                    {translate("auth.settings.twoFactor.generateNewCodes")}
                  </RouterLink>
                }
                description={remaining === 0
                  ? translate("auth.settings.twoFactor.noCodesRemaining")
                  : translate("auth.settings.twoFactor.codesRemaining", {
                    count: remaining,
                  })}
                icon={<UI.IconGlyph name="key" size="large" />}
                title={translate("auth.settings.twoFactor.backupCodesTitle")}
              />
              {remaining === 0
                ? (
                  <UI.InlineNotice tone="warning">
                    {translate("auth.settings.twoFactor.noCodesWarning")}
                  </UI.InlineNotice>
                )
                : null}
            </UI.SettingsSection>
            <RouterLink to={TWO_FACTOR_DISABLE_PATH}>
              {translate("auth.twoFactor.disableTitle")}
            </RouterLink>
          </>
        )
        : (
          <>
            <UI.InlineNotice tone="information">
              {translate("auth.settings.twoFactor.keepAvailableNotice")}
            </UI.InlineNotice>
            <UI.FormContent>
              <UI.Button onClick={onSetUp}>
                {translate("auth.settings.twoFactor.setUpAuthenticator")}
              </UI.Button>
            </UI.FormContent>
          </>
        )}
    </UI.SettingsContent>
  );
}
