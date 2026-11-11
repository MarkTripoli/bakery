import type { MouseEvent } from "react";
import * as UI from "@bakery/ui";
import { I18nText, useI18n } from "../i18n/I18nProvider.tsx";
import type { ShellViewport } from "../app/responsive.ts";

/**
 * Production Settings navigation. The `settings-*` ids keep production
 * destinations distinct from the synthetic `__fixtures__` model.
 */
export const productionSettingsRoutes = [
  {
    id: "machines",
    label: <I18nText id="shell.navigation.machines" />,
    href: "/machines",
  },
  {
    id: "settings-profile",
    label: <I18nText id="shell.navigation.profile" />,
    href: "/settings/profile",
  },
  {
    id: "settings-security",
    label: <I18nText id="shell.navigation.security" />,
    href: "/settings/security",
  },
  {
    id: "settings-sessions",
    label: <I18nText id="shell.navigation.sessions" />,
    href: "/settings/sessions",
  },
  {
    id: "settings-clients",
    label: <I18nText id="shell.navigation.clients" />,
    href: "/settings/clients",
  },
  {
    id: "settings-appearance",
    label: <I18nText id="shell.navigation.appearance" />,
    href: "/settings/appearance",
  },
  {
    id: "settings-access",
    label: <I18nText id="shell.navigation.access" />,
    href: "/settings/access",
  },
  {
    id: "settings-organization-access",
    label: <I18nText id="shell.navigation.organizationAccess" />,
    href: "/settings/organization/access",
  },
  {
    id: "settings-organization-roles",
    label: <I18nText id="shell.navigation.customRoles" />,
    href: "/settings/organization/roles",
  },
  {
    id: "settings-organization-repository-rules",
    label: <I18nText id="shell.navigation.repositoryRules" />,
    href: "/settings/organization/repository-rules",
  },
  {
    id: "settings-organization-integrations",
    label: <I18nText id="shell.navigation.organizationIntegrations" />,
    href: "/settings/organization/integrations",
  },
  {
    id: "settings-audit",
    label: <I18nText id="shell.navigation.audit" />,
    href: "/settings/audit",
  },
  {
    id: "settings-scim",
    label: <I18nText id="shell.navigation.scim" />,
    href: "/settings/scim",
  },
] satisfies readonly UI.SectionNavigationItem[];

export function ProductionSettingsNavigation({
  currentPath,
  onNavigate,
  viewport,
}: {
  readonly currentPath: string;
  readonly onNavigate: (
    event: MouseEvent<HTMLAnchorElement>,
    item: UI.SectionNavigationItem,
  ) => void;
  readonly viewport: ShellViewport;
}) {
  const { translate } = useI18n();
  return (
    <UI.SectionNavigation
      currentPath={currentPath}
      items={productionSettingsRoutes}
      label={translate("shell.navigation.settingsSections")}
      narrowMode="menu"
      onNavigate={onNavigate}
      variant={viewport === "desktop" ? "sidebar" : "menu"}
    />
  );
}
