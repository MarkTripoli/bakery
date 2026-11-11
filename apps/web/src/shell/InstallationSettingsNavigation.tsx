import type { MouseEvent } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { ShellViewport } from "../app/responsive.ts";

/** Where the GitHub manifest callback returns the administrator (server contract). */
export const INSTALLATION_INTEGRATIONS_PATH =
  "/settings/installation/integrations";

export function InstallationSettingsNavigation(
  { currentPath, onNavigate, viewport }: {
    readonly currentPath: string;
    readonly onNavigate: (
      event: MouseEvent<HTMLAnchorElement>,
      item: UI.SectionNavigationItem,
    ) => void;
    readonly viewport: ShellViewport;
  },
) {
  const { translate } = useI18n();
  return (
    <UI.SectionNavigation
      heading={viewport === "desktop"
        ? translate("shell.navigation.installation")
        : undefined}
      currentPath={currentPath}
      label={translate("shell.navigation.installation")}
      items={[{
        id: "installation-settings",
        href: "/installation/settings",
        label: translate("settings.installation.title"),
      }, {
        id: "installation-audit",
        href: "/installation/audit",
        label: translate("settings.audit.section"),
      }, {
        id: "installation-integrations",
        href: INSTALLATION_INTEGRATIONS_PATH,
        label: translate("settings.integrations.section"),
      }]}
      narrowMode="menu"
      variant={viewport === "desktop" ? "sidebar" : "menu"}
      onNavigate={onNavigate}
    />
  );
}
