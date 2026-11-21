import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  organizationQueryOptions,
  pluginInstallsQueryOptions,
  pluginPackagesQueryOptions,
  pluginVersionsQueryOptions,
} from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import {
  type AvailablePlugin,
  availablePlugins,
  installedPlugins,
  mayChangeInstall,
  mayInstall,
  type PluginActor,
  type PluginVersion,
  updateFailureOf,
} from "../app/plugins.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { SETTINGS_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import {
  InstallDialog,
  VersionChangeDialog,
} from "./plugins/PluginDialogs.tsx";
import { OriginDialog } from "./plugins/PluginOrigin.tsx";
import {
  AvailableList,
  InstalledList,
  type InstalledRow,
} from "./plugins/PluginsList.tsx";
import {
  type ChangeFailure,
  changeFailureOf,
  usePluginChanges,
} from "./plugins/use-plugin-changes.ts";

type Dialog =
  | { readonly kind: "install"; readonly plugin: AvailablePlugin }
  | { readonly kind: "update"; readonly row: InstalledRow }
  | null;

/**
 * `/settings/organization/plugins` (design-ux, #76 rev 3). The plugins published
 * to the organization: the ones installed, then the ones that can be. Installing
 * gives a plugin everything its version asks for, at once; the dialog lists it
 * first. Turning on and off, versions and removing are on the plugin's page.
 */
export function PluginsPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const session = useSession();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const organization = useQuery(organizationQueryOptions(api, scope));
  const packages = useQuery(pluginPackagesQueryOptions(api, scope));
  const installs = useQuery(pluginInstallsQueryOptions(api, scope));
  const packageList = packages.data?.items ?? [];
  const versionReads = useQueries({
    queries: packageList.map((item) =>
      pluginVersionsQueryOptions(api, scope, item.id)
    ),
  });
  const connectivity = useConnectivity({
    refetch: installs.refetch,
    refetching: installs.isFetching,
    dataUpdatedAt: installs.dataUpdatedAt,
  });
  const changes = usePluginChanges();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [failure, setFailure] = useState<ChangeFailure | null>(null);
  /** The version whose "Where it came from" is open over the update dialog. */
  const [origin, setOrigin] = useState<PluginVersion | null>(null);
  /** Updates that did not start, by install, with the version that was tried. */
  const [failedUpdates, setFailedUpdates] = useState<
    ReadonlyMap<string, string>
  >(
    new Map(),
  );

  const versionsByPackage = useMemo(() => {
    const map = new Map<string, readonly PluginVersion[]>();
    packageList.forEach((item, index) => {
      map.set(item.id, versionReads[index]?.data?.items ?? []);
    });
    return map;
  }, [packageList, versionReads]);

  const actor: PluginActor = {
    role: access.data?.role ?? null,
    principalId: session.identity?.principalId ?? null,
  };
  const installList = installs.data?.items ?? [];
  const installed: InstalledRow[] = installedPlugins(
    installList,
    packageList,
    versionsByPackage,
  ).map((row) => ({
    ...row,
    failedUpdate: row.updateFailure?.versionName ??
      failedUpdates.get(row.installId) ?? null,
    mayChange: mayChangeInstall(row, actor),
    // The server returns no display name for another person, so a private
    // install reads as just "Private".
    ownerLabel: null,
  }));
  const available = availablePlugins(
    installList,
    packageList,
    versionsByPackage,
  );

  const loadFailure = packages.isError
    ? packages.error
    : installs.isError
    ? installs.error
    : undefined;
  const loading = loadFailure === undefined &&
    (packages.isPending || installs.isPending ||
      versionReads.some((read) => read.isPending));
  const readOnly = access.data !== undefined && !mayInstall("personal", actor);
  const offline = connectivity === "offline";

  const close = () => {
    setDialog(null);
    setFailure(null);
  };
  const openInstall = (plugin: AvailablePlugin) => {
    setFailure(null);
    setDialog({ kind: "install", plugin });
  };
  const goToPlugin = (row: InstalledRow) =>
    void navigate({
      to: "/settings/organization/plugins/$installId",
      params: { installId: row.installId },
    });
  const turnOn = async (row: InstalledRow) => {
    setFailure(null);
    try {
      await changes.update.mutateAsync({
        id: row.installId,
        version: row.installVersion,
        change: { status: "enabled" },
      });
    } catch (error) {
      setFailure(changeFailureOf(error));
    }
  };
  const doInstall = async (
    plugin: AvailablePlugin,
    installScope: "organization" | "personal",
  ) => {
    setFailure(null);
    try {
      const created = await changes.install.mutateAsync({
        packageId: plugin.packageId,
        versionId: plugin.versionId,
        scope: installScope,
      });
      close();
      void navigate({
        to: "/settings/organization/plugins/$installId",
        params: { installId: created.id },
      });
    } catch (error) {
      setFailure(changeFailureOf(error));
    }
  };
  const doUpdate = async (row: InstalledRow) => {
    if (row.update === null) return;
    setFailure(null);
    try {
      const result = await changes.update.mutateAsync({
        id: row.installId,
        version: row.installVersion,
        change: { versionId: row.update.versionId },
      });
      // The server answers a refused update as the install with the failure
      // recorded on it, so a 200 is not yet a success.
      if (updateFailureOf(result)?.versionId === row.update.versionId) {
        setFailure("failed");
        return;
      }
      setFailedUpdates((previous) => {
        const next = new Map(previous);
        next.delete(row.installId);
        return next;
      });
      close();
    } catch (error) {
      const kind = changeFailureOf(error);
      setFailure(kind);
      if (kind === "failed") {
        setFailedUpdates((previous) =>
          new Map(previous).set(row.installId, row.update!.versionName)
        );
      }
    }
  };

  const installDialog = dialog?.kind === "install" ? dialog.plugin : null;
  const updateRow = dialog?.kind === "update" ? dialog.row : null;
  const versionOf = (packageId: string, versionId: string) =>
    versionsByPackage.get(packageId)?.find((item) => item.id === versionId);

  return (
    <>
      <ShellActiveNavigation id="settings" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            {
              href: SETTINGS_HOME,
              label: translate("shell.states.settingsTitle"),
            },
            { label: translate("shell.navigation.plugins") },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="plugins">
        <UI.Stack gap="tight">
          <UI.Heading level="page">
            {translate("settings.plugins.title")}
          </UI.Heading>
          <UI.Text variant="muted">
            {translate("settings.plugins.description", {
              organization: organization.data?.name ?? "",
            })}
          </UI.Text>
        </UI.Stack>
        {readOnly
          ? (
            <UI.InlineNotice tone="neutral">
              {translate("settings.plugins.readOnly")}
            </UI.InlineNotice>
          )
          : null}
        {offline
          ? (
            <UI.InlineNotice tone="warning" role="status">
              {translate("settings.plugins.offline")}
            </UI.InlineNotice>
          )
          : null}
        {failure !== null && dialog === null
          ? (
            <UI.InlineNotice tone="error" role="alert">
              {failure === "conflict"
                ? translate("settings.plugins.conflict")
                : failure === "offline"
                ? translate("settings.plugins.offline")
                : translate("settings.plugins.changeFailed", {
                  what: translate("settings.plugins.action.turnOn"),
                })}
            </UI.InlineNotice>
          )
          : null}
        {loadFailure !== undefined
          ? (
            <UI.ErrorState
              title={translate("settings.plugins.loadFailed.title")}
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => {
                    void packages.refetch();
                    void installs.refetch();
                  }}
                >
                  {translate("settings.plugins.loadFailed.retry")}
                </UI.Button>
              }
              data-forbidden={isForbiddenFailure(loadFailure) || undefined}
            />
          )
          : loading
          ? (
            <UI.Stack
              gap="standard"
              role="list"
              aria-busy="true"
              aria-label={translate("settings.plugins.loading")}
            >
              {[0, 1, 2].map((index) => (
                <div key={index} role="listitem">
                  <UI.Skeleton shape="row" />
                </div>
              ))}
            </UI.Stack>
          )
          : installed.length === 0 && available.length === 0
          ? (
            <UI.EmptyState
              title={translate("settings.plugins.empty.title")}
              description={translate("settings.plugins.empty.description")}
            />
          )
          : (
            <>
              <UI.Stack gap="standard" data-testid="plugins-installed">
                <UI.Heading level="section">
                  {translate("settings.plugins.installed.heading")}
                </UI.Heading>
                {installed.length === 0
                  ? (
                    <UI.Text variant="muted">
                      {translate("settings.plugins.installed.empty")}
                    </UI.Text>
                  )
                  : (
                    <InstalledList
                      rows={installed}
                      phone={phone}
                      onManage={goToPlugin}
                      onTurnOn={(row) => void turnOn(row)}
                      onReviewUpdate={(row) => {
                        setFailure(null);
                        setDialog({ kind: "update", row });
                      }}
                    />
                  )}
              </UI.Stack>
              {available.length === 0
                ? null
                : (
                  <UI.Stack gap="standard" data-testid="plugins-available">
                    <UI.Heading level="section">
                      {translate("settings.plugins.available.heading")}
                    </UI.Heading>
                    <UI.Text variant="muted">
                      {translate("settings.plugins.available.description")}
                    </UI.Text>
                    <AvailableList
                      rows={available}
                      phone={phone}
                      mayInstall={mayInstall("personal", actor)}
                      onInstall={openInstall}
                    />
                  </UI.Stack>
                )}
            </>
          )}
      </UI.SettingsContent>
      {installDialog === null ? null : (
        <InstallDialog
          plugin={installDialog}
          version={versionOf(installDialog.packageId, installDialog.versionId)}
          organizationName={organization.data?.name ?? ""}
          mayOrganization={mayInstall("organization", actor)}
          pending={changes.install.isPending}
          failure={failure}
          onCancel={close}
          onInstall={(installScope) =>
            void doInstall(installDialog, installScope)}
        />
      )}
      {updateRow === null || updateRow.update === null
        ? null
        : (
          <VersionChangeDialog
            kind="update"
            name={updateRow.name}
            from={versionOf(updateRow.packageId, updateRow.versionId)}
            to={versionOf(updateRow.packageId, updateRow.update.versionId)!}
            pending={changes.update.isPending}
            failure={failure}
            onCancel={close}
            onConfirm={() => void doUpdate(updateRow)}
            onShowOrigin={() =>
              setOrigin(
                versionOf(updateRow.packageId, updateRow.update!.versionId) ??
                  null,
              )}
          />
        )}
      {origin === null ? null : (
        <OriginDialog
          version={origin}
          installedOn={false}
          onClose={() => setOrigin(null)}
        />
      )}
    </>
  );
}
