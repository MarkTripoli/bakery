import * as UI from "@bakery/ui";
import { SECURITY_SETTINGS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

/**
 * The "back to Account and security" link every child settings page opens
 * with — Paper renders it as the first child of `.settings-content` whenever
 * the active page is not the account root (auth.js `settingsShell`). Pass it
 * to `UI.SettingsContent`'s `back` slot.
 */
export function AccountSettingsBackLink() {
  const { translate } = useI18n();
  return (
    <RouterLink to={SECURITY_SETTINGS_PATH}>
      <UI.IconGlyph name="back" size="large" />
      {translate("auth.settings.security.title")}
    </RouterLink>
  );
}
