import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import { effectiveAccessQueryOptions } from "../api/query.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { CustomRolesPanel } from "./CustomRolesPanel.tsx";

/**
 * `/settings/organization/roles`. The organization's custom roles, apart from
 * the Access page that hands them out. Only an organization admin sees the
 * panel; anyone else gets a notice and no role data, and the server decides
 * who is an admin.
 */
export function OrganizationRolesPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();
  const organizationId = scope.organizationId ??
    (restoring ? organizationSelection.remembered() : null);
  const access = useQuery({
    ...effectiveAccessQueryOptions(api, { ...scope, organizationId }),
    retry: false,
  });
  const isAdmin = access.data?.role === "admin";
  const loading = organizationId === null ? restoring : access.isPending;
  const forbidden = !loading && organizationId !== null &&
    (access.isError || (access.data !== undefined && !isAdmin));

  return (
    <>
      <ShellActiveNavigation id="settings" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            { label: translate("settings.orgAccess.organization") },
            { label: translate("shell.navigation.customRoles") },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="org-roles">
        <UI.Heading level="page">
          {translate("shell.navigation.customRoles")}
        </UI.Heading>
        {loading
          ? (
            <UI.AlertBanner tone="information" data-testid="org-roles-loading">
              {translate("settings.roles.loading")}
            </UI.AlertBanner>
          )
          : null}
        {forbidden
          ? (
            <UI.AlertBanner tone="warning" data-testid="org-roles-forbidden">
              {translate("settings.roles.forbidden")}
            </UI.AlertBanner>
          )
          : null}
        {!loading && !forbidden && organizationId !== null && isAdmin
          ? (
            <CustomRolesPanel
              organizationId={organizationId}
              title={translate("settings.roles.listTitle")}
            />
          )
          : null}
      </UI.SettingsContent>
    </>
  );
}
