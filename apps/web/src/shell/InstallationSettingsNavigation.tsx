import type { MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  installationRestoreQueryOptions,
  installationUpdateStatusQueryOptions,
} from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
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
  const api = useBakeryApi();
  const scope = useProtectedScope();
  // Only an installation administrator can read a restore; for anyone else the
  // read is refused and the item simply is not there. The item shows while a
  // restore exists, and wears a mark only while it still holds Bakery.
  const restore = useQuery(installationRestoreQueryOptions(api, scope)).data ??
    null;
  // Updates is for installation administrators only: for anyone else the read
  // is refused and the item is not in the list.
  const updates = useQuery(installationUpdateStatusQueryOptions(api, scope));
  const updatesRefused = updates.isError &&
    isForbiddenFailure(updates.error as never);
  return (
    <UI.SectionNavigation
      heading={viewport === "desktop"
        ? translate("shell.navigation.installation")
        : undefined}
      currentPath={currentPath}
      label={translate("shell.navigation.installation")}
      items={[
        {
          id: "installation-settings",
          href: "/installation/settings",
          label: translate("settings.installation.title"),
        },
        ...(restore === null ? [] : [{
          id: "installation-restore",
          href: "/installation/restore",
          label: (
            <UI.Inline gap="compact">
              <span>{translate("installation.restore.nav")}</span>
              {restore.releasedAt === null
                ? (
                  <UI.Badge tone="warning">
                    {translate("installation.restore.nav.held")}
                  </UI.Badge>
                )
                : null}
            </UI.Inline>
          ),
        }]),
        ...(updatesRefused ? [] : [{
          id: "installation-updates",
          href: "/installation/updates",
          label: translate("installation.updates.title"),
        }]),
        {
          id: "installation-monitoring",
          href: "/installation/monitoring",
          label: translate("shell.navigation.monitoring"),
        },
        {
          // Below the settings it reports on, above the audit trail: usage is
          // what the installation spent, and an administrator looking for it
          // looks here first.
          id: "installation-usage",
          href: "/installation/usage",
          label: translate("installation.usage.title"),
        },
        {
          id: "installation-audit",
          href: "/installation/audit",
          label: translate("settings.audit.section"),
        },
        {
          id: "installation-integrations",
          href: INSTALLATION_INTEGRATIONS_PATH,
          label: translate("settings.integrations.section"),
        },
      ]}
      narrowMode="menu"
      variant={viewport === "desktop" ? "sidebar" : "menu"}
      onNavigate={onNavigate}
    />
  );
}
