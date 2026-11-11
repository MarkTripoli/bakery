import * as UI from "@bakery/ui";
import {
  SESSIONS_SETTINGS_PATH,
  SIGN_OUT_PATH,
  TWO_FACTOR_SETTINGS_PATH,
} from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export type AccountSettingsScreenProps = {
  readonly displayName: string;
  readonly email: string;
  readonly twoFactorEnabled: boolean;
  /** Unused backup codes; only shown while two-factor is on. */
  readonly backupCodesRemaining: number;
  /**
   * The page was reached straight after the person re-confirmed their
   * identity, so it opens with the "Your identity was confirmed." notice.
   */
  readonly confirmed: boolean;
};

/**
 * `/settings/security` presenter — Paper `security` (auth.js L181, core
 * capabilities): the heading, the optional confirmation notice, the identity
 * row, then the "Account protection" and "Account access" sections whose rows
 * link on to the two-factor and sessions pages, and the sign-out link.
 */
export function AccountSettingsScreen(
  {
    backupCodesRemaining,
    confirmed,
    displayName,
    email,
    twoFactorEnabled,
  }: AccountSettingsScreenProps,
) {
  const { translate } = useI18n();
  return (
    <UI.SettingsContent data-testid="security-settings">
      <UI.AuthHeading
        description={translate("auth.settings.security.description")}
        title={translate("auth.settings.security.title")}
      />
      {confirmed
        ? (
          <UI.InlineNotice tone="success">
            {translate("auth.settings.security.identityConfirmed")}
          </UI.InlineNotice>
        )
        : null}
      <UI.DescriptionItem
        description={email}
        icon={<UI.IconGlyph name="person" size="large" />}
        title={displayName}
      />
      <UI.SettingsSection
        title={translate("auth.settings.security.accountProtectionHeading")}
      >
        <UI.DescriptionItem
          action={
            <RouterLink to={TWO_FACTOR_SETTINGS_PATH}>
              {translate(
                twoFactorEnabled
                  ? "auth.settings.security.manage"
                  : "auth.settings.security.setUp",
              )}
            </RouterLink>
          }
          description={twoFactorEnabled
            ? translate("auth.settings.security.twoFactorDescriptionOn", {
              count: backupCodesRemaining,
            })
            : translate("auth.settings.security.twoFactorDescriptionOff")}
          icon={<UI.IconGlyph name="shield" size="large" />}
          title={translate("auth.settings.security.twoFactorTitle")}
        />
      </UI.SettingsSection>
      <UI.SettingsSection
        title={translate("auth.settings.security.accountAccessHeading")}
      >
        <UI.DescriptionItem
          action={
            <RouterLink to={SESSIONS_SETTINGS_PATH}>
              {translate("auth.settings.security.manage")}
            </RouterLink>
          }
          description={translate(
            "auth.settings.security.activeSessionsDescription",
          )}
          icon={<UI.IconGlyph name="computer" size="large" />}
          title={translate("auth.sessions.title")}
        />
      </UI.SettingsSection>
      <RouterLink to={SIGN_OUT_PATH}>
        {translate("auth.settings.security.signOutOfSession")}
      </RouterLink>
    </UI.SettingsContent>
  );
}
