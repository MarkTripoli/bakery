import type { MouseEvent } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { ShellViewport } from "../app/responsive.ts";

/**
 * The organization section's navigation (Paper E16 mocks): Access, Custom
 * roles, Audit log, Single sign-on and SCIM.
 */
export function OrganizationSettingsNavigation(
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
        ? translate("shell.navigation.organization")
        : undefined}
      currentPath={currentPath}
      label={translate("shell.navigation.organization")}
      items={[{
        id: "organization-access",
        href: currentPath === "/__fixtures__/organization/access"
          ? currentPath
          : "/settings/organization/access",
        label: translate("shell.navigation.accessShort"),
      }, {
        id: "organization-roles",
        href: "/settings/organization/roles",
        label: translate("shell.navigation.customRoles"),
      }, {
        id: "organization-audit",
        href: "/settings/audit",
        label: translate("shell.navigation.audit"),
      }, {
        id: "organization-sso",
        href: currentPath === "/__fixtures__/organization/sso"
          ? currentPath
          : "/settings/organization/sso",
        label: translate("shell.navigation.sso"),
      }, {
        id: "organization-scim",
        href: "/settings/scim",
        label: translate("shell.navigation.scimShort"),
      }]}
      narrowMode="menu"
      variant={viewport === "desktop" ? "sidebar" : "menu"}
      onNavigate={onNavigate}
    />
  );
}
