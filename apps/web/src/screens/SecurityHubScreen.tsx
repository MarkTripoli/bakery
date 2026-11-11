import * as UI from "@bakery/ui";
import {
  CONNECTED_CLIENTS_PATH,
  PASSKEYS_SETTINGS_PATH,
  PASSWORD_SETTINGS_PATH,
  SESSIONS_SETTINGS_PATH,
  SIGN_OUT_PATH,
  TWO_FACTOR_SETTINGS_PATH,
} from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

export type SecurityHubScreenProps = {
  readonly displayName: string;
  readonly email: string;
  readonly passkeyCount: number;
  readonly twoFactorEnabled: boolean;
  /** Unused backup codes; only shown while two-factor is on. */
  readonly backupCodesRemaining: number;
  /** Opens with "Your identity was confirmed." after re-authentication. */
  readonly confirmed: boolean;
  /** Shared async state; `null` renders the settled screen. */
  readonly async: SecurityAsyncKind | null;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * The full account-and-security hub — Paper V-0 `security` (auth.js
 * `security`, full capabilities): identity, sign-in methods (password and
 * passkeys), account protection (two-factor), and account access (active
 * sessions; the email address lives in the identity header), then the sign-out link. There is no
 * connected-clients row until that feature ships.
 */
export function SecurityHubScreen(
  {
    async,
    backupCodesRemaining,
    confirmed,
    displayName,
    email,
    onRefresh,
    onReload,
    onRetry,
    passkeyCount,
    twoFactorEnabled,
  }: SecurityHubScreenProps,
) {
  const { translate } = useI18n();
  return (
    <UI.SettingsContent data-testid="security-hub">
      <UI.AuthHeading
        description={translate("auth.settings.security.description")}
        title={translate("auth.settings.security.title")}
      />
      <SecurityAsyncBoundary
        emptyDescription={translate("settings.security.emptyDescription")}
        emptyTitle={translate("settings.security.emptyTitle")}
        kind={async}
        onRefresh={onRefresh}
        onReload={onReload}
        onRetry={onRetry}
      >
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
        {
          /* auth.js `security`: this group is `<section class="stack">`, a
              20px column, so the first row sits 64px below the heading. */
        }
        <UI.SettingsSection
          title={translate("settings.security.signInMethodsHeading")}
          variant="stack"
        >
          <div>
            <UI.DescriptionItem
              action={
                <RouterLink
                  aria-label={translate("settings.security.changePasswordAria")}
                  to={PASSWORD_SETTINGS_PATH}
                >
                  {translate("settings.security.change")}
                </RouterLink>
              }
              description={translate("settings.security.passwordDescription")}
              icon={<UI.IconGlyph name="lock" size="large" />}
              title={translate("settings.security.passwordTitle")}
            />
            <UI.DescriptionItem
              action={
                <RouterLink
                  aria-label={translate("settings.security.managePasskeysAria")}
                  to={PASSKEYS_SETTINGS_PATH}
                >
                  {translate("auth.settings.security.manage")}
                </RouterLink>
              }
              description={passkeyCount === 0
                ? translate("settings.security.passkeysNone")
                : translate("settings.security.passkeysCount", {
                  count: passkeyCount,
                })}
              icon={<UI.IconGlyph name="key" size="large" />}
              title={translate("settings.security.passkeysTitle")}
            />
          </div>
        </UI.SettingsSection>
        <UI.SettingsSection
          title={translate("auth.settings.security.accountProtectionHeading")}
        >
          <UI.DescriptionItem
            action={
              <RouterLink
                aria-label={translate(
                  twoFactorEnabled
                    ? "settings.security.manageTwoFactorAria"
                    : "settings.security.setUpTwoFactorAria",
                )}
                to={TWO_FACTOR_SETTINGS_PATH}
              >
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
              <RouterLink
                aria-label={translate("settings.security.manageSessionsAria")}
                to={SESSIONS_SETTINGS_PATH}
              >
                {translate("auth.settings.security.manage")}
              </RouterLink>
            }
            description={translate(
              "auth.settings.security.activeSessionsDescription",
            )}
            icon={<UI.IconGlyph name="computer" size="large" />}
            title={translate("auth.sessions.title")}
          />
          <UI.DescriptionItem
            action={
              <RouterLink
                aria-label={translate("settings.security.manageClientsAria")}
                to={CONNECTED_CLIENTS_PATH}
              >
                {translate("auth.settings.security.manage")}
              </RouterLink>
            }
            description={translate("settings.security.clientsDescription")}
            icon={<UI.IconGlyph name="plug" size="large" />}
            title={translate("auth.settings.clients.title")}
          />
        </UI.SettingsSection>
        <RouterLink to={SIGN_OUT_PATH}>
          {translate("auth.settings.security.signOutOfSession")}
        </RouterLink>
      </SecurityAsyncBoundary>
    </UI.SettingsContent>
  );
}
