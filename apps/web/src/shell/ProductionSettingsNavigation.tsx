import { useQuery } from "@tanstack/react-query";
import type { MouseEvent } from "react";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import { effectiveAccessQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useSession } from "../app/session-context.tsx";
import { I18nText, useI18n } from "../i18n/I18nProvider.tsx";
import type { ShellViewport } from "../app/responsive.ts";

/**
 * Production Settings navigation. The `settings-*` ids keep production
 * destinations distinct from the synthetic `__fixtures__` model.
 */
/** Settings that belong to the signed-in person. */
export const productionAccountRoutes = [
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
    id: "settings-appearance",
    label: <I18nText id="shell.navigation.appearance" />,
    href: "/settings/appearance",
  },
  {
    id: "settings-access",
    label: <I18nText id="shell.navigation.access" />,
    href: "/settings/access",
  },
] satisfies readonly UI.SectionNavigationItem[];

/** Settings that change the organization for everyone in it. */
export const productionOrganizationRoutes = [
  {
    id: "settings-organization-access",
    label: <I18nText id="shell.navigation.membersAndAccess" />,
    href: "/settings/organization/access",
  },
  {
    id: "settings-organization-service-accounts",
    label: <I18nText id="shell.navigation.serviceAccounts" />,
    href: "/settings/organization/service-accounts",
  },
  {
    id: "settings-organization-roles",
    label: <I18nText id="shell.navigation.customRoles" />,
    href: "/settings/organization/roles",
  },
  {
    id: "settings-organization-plugins",
    label: <I18nText id="shell.navigation.plugins" />,
    href: "/settings/organization/plugins",
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
    id: "settings-organization-sso",
    label: <I18nText id="shell.navigation.sso" />,
    href: "/settings/organization/sso",
  },
  {
    id: "settings-scim",
    label: <I18nText id="shell.navigation.userProvisioning" />,
    href: "/settings/scim",
  },
] satisfies readonly UI.SectionNavigationItem[];

/**
 * The navigation item that owns a settings path: the path itself, or the
 * section a sub-page belongs to (Passkeys under Account & security), so the
 * section stays selected on its sub-pages.
 */
export function owningSettingsHref(pathname: string): string {
  const hrefs = [...productionAccountRoutes, ...productionOrganizationRoutes]
    .map((item) => item.href);
  return hrefs.find((href) =>
    pathname === href || pathname.startsWith(`${href}/`)
  ) ??
    pathname;
}

/** The name each section goes by in the breadcrumb, before its page has claimed one. */
const SECTION_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  "/settings/profile": "shell.navigation.profile",
  "/settings/security": "shell.navigation.security",
  "/settings/sessions": "shell.navigation.sessions",
  "/settings/organization/integrations/clients": "shell.navigation.clients",
  "/settings/appearance": "shell.navigation.appearance",
  "/settings/access": "shell.navigation.access",
  "/settings/organization/access": "shell.navigation.membersAndAccess",
  "/settings/organization/service-accounts": "shell.navigation.serviceAccounts",
  "/settings/organization/roles": "shell.navigation.customRoles",
  "/settings/organization/plugins": "shell.navigation.plugins",
  "/settings/organization/repository-rules": "shell.navigation.repositoryRules",
  "/settings/organization/integrations":
    "shell.navigation.organizationIntegrations",
  "/settings/audit": "shell.navigation.audit",
  "/settings/organization/sso": "shell.navigation.sso",
  "/settings/scim": "shell.navigation.userProvisioning",
};

/** The section a settings path belongs to, as a message key, or `null` outside the sections. */
export function settingsSectionKey(pathname: string): MessageKey | null {
  return SECTION_LABEL_KEYS[owningSettingsHref(pathname)] ?? null;
}

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
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const session = useSession();
  // Organization settings change things for everyone in the organization, so a
  // member without administrator rights sees only the items they may open
  // there: Service accounts & tokens (a member manages the accounts they
  // created, and the phone index lists it for them too). While the role is not
  // known (or cannot be read) the whole group stays, as the design allows.
  const access = useQuery({
    ...effectiveAccessQueryOptions(api, scope),
    enabled: session.status === "authenticated" &&
      scope.organizationId !== null,
  });
  const organizationItems = access.data === undefined ||
      access.data.role === "admin"
    ? productionOrganizationRoutes
    : productionOrganizationRoutes.filter((item) =>
      item.id === "settings-organization-service-accounts"
    );
  return (
    <UI.SectionNavigation
      currentPath={owningSettingsHref(currentPath)}
      groups={[
        {
          id: "account",
          heading: translate("shell.navigation.group.account"),
          items: productionAccountRoutes,
        },
        {
          id: "organization",
          heading: translate("shell.navigation.group.organization"),
          items: organizationItems,
        },
      ]}
      label={translate("shell.navigation.settingsSections")}
      narrowMode="menu"
      onNavigate={onNavigate}
      variant={viewport === "desktop" ? "sidebar" : "menu"}
    />
  );
}
