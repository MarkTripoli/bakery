import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  pluginInstallsQueryOptions,
  pluginPackagesQueryOptions,
  pluginPageQueryOptions,
  pluginVersionsQueryOptions,
} from "../api/query.ts";
import { installedPlugins, mayChangeInstall } from "../app/plugins.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { pluginPageDocumentUrl } from "./plugins/page-url.ts";

const PLUGINS_PATH = "/settings/organization/plugins";

/**
 * A plugin's own page, opened inside Bakery (design-ux, #76 revision 5). The
 * strip is Bakery's: the plugin cannot change it. Under it the page runs in a
 * sealed frame. Every way the page cannot be shown says so in place of the
 * frame, and the page is re-checked when the window gains focus.
 */
export function PluginFramePage(
  { installId, pageId }: {
    readonly installId: string;
    readonly pageId: string;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const session = useSession();
  const { direction, locale, translate } = useI18n();
  const { resolvedTheme } = UI.useTheme();
  useRestoreOrganizationScope();
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const packages = useQuery(pluginPackagesQueryOptions(api, scope));
  const installs = useQuery(pluginInstallsQueryOptions(api, scope));
  const install = installs.data?.items.find((item) => item.id === installId);
  const versions = useQuery({
    ...pluginVersionsQueryOptions(api, scope, install?.pluginPackageId ?? ""),
    enabled: install !== undefined && Boolean(scope.organizationId),
  });
  const read = useQuery({
    ...pluginPageQueryOptions(api, scope, installId, pageId),
    refetchOnWindowFocus: true,
  });
  const [reloads, setReloads] = useState(0);
  const [online, setOnline] = useState(globalThis.navigator?.onLine ?? true);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    globalThis.addEventListener("online", on);
    globalThis.addEventListener("offline", off);
    return () => {
      globalThis.removeEventListener("online", on);
      globalThis.removeEventListener("offline", off);
    };
  }, []);

  const row = install === undefined || packages.data === undefined
    ? undefined
    : installedPlugins(
      [install],
      packages.data.items,
      new Map([[install.pluginPackageId, versions.data?.items ?? []]]),
    )[0];
  const mayManage = row === undefined ? false : mayChangeInstall(row, {
    role: access.data?.role ?? null,
    principalId: session.identity?.principalId ?? null,
  });
  const name = row?.name ?? "";
  // A page that is off or gone has no title to show: the plugin's name stands in.
  const title = read.data?.title ?? (name === "" ? pageId : name);

  // The version the page was opened on, to say when it was updated meanwhile.
  const opened = useRef<string | null>(null);
  // Only once the versions are read, so the version is a real name and not a blank.
  if (
    opened.current === null && row !== undefined &&
    versions.data !== undefined && row.versionName !== ""
  ) {
    opened.current = row.versionName;
  }
  const updatedTo = row !== undefined && opened.current !== null &&
      versions.data !== undefined &&
      row.versionName !== opened.current
    ? row.versionName
    : null;

  const loading = read.isPending || installs.isPending || packages.isPending;
  const reason = read.data?.status === "refused" ? read.data.reason : null;
  const manage = mayManage && install !== undefined
    ? (
      <UI.Button
        onClick={() => void navigate({ to: `${PLUGINS_PATH}/${installId}` })}
        variant="secondary"
      >
        {translate("settings.plugins.frame.manage")}
      </UI.Button>
    )
    : null;

  const body = loading
    ? (
      <UI.Stack gap="standard">
        <UI.Text role="status" variant="muted">
          {translate("settings.plugins.frame.loading", { title })}
        </UI.Text>
        <UI.Skeleton shape="row" />
      </UI.Stack>
    )
    : read.isError
    ? (
      <UI.ErrorState
        action={
          <UI.Button
            onClick={() => void read.refetch()}
            variant="primary"
          >
            {translate("settings.plugins.frame.failed.retry")}
          </UI.Button>
        }
        description={
          <>
            <UI.Text>{translate("settings.plugins.frame.failed.body")}</UI.Text>
            <UI.Text variant="muted">
              {translate("settings.plugins.frame.failed.detail", {
                page: pageId,
                version: row?.versionName ?? "",
              })}
            </UI.Text>
          </>
        }
        title={translate("settings.plugins.frame.failed.title")}
      />
    )
    : reason === "off"
    ? (
      <UI.EmptyState
        action={manage ?? (
          <UI.Text variant="muted">
            {translate("settings.plugins.frame.off.ask")}
          </UI.Text>
        )}
        description={translate("settings.plugins.frame.off.body")}
        title={translate("settings.plugins.frame.off.title", { name })}
      />
    )
    : reason === "no_access" || reason === "not_granted"
    ? (
      <UI.ErrorState
        title={translate("settings.plugins.frame.noAccess.title")}
      />
    )
    : reason !== null || read.data === undefined
    ? (
      <UI.EmptyState
        action={
          <UI.Button
            onClick={() => void navigate({ to: "/" })}
            variant="secondary"
          >
            {translate("settings.plugins.frame.gone.back")}
          </UI.Button>
        }
        description={translate("settings.plugins.frame.gone.body")}
        title={translate("settings.plugins.frame.gone.title")}
      />
    )
    : scope.organizationId
    ? (
      <UI.SealedFrame
        key={reloads}
        src={pluginPageDocumentUrl(installId, pageId, scope.organizationId, {
          theme: resolvedTheme === "dark" ? "dark" : "light",
          locale,
          dir: direction,
        })}
        title={translate("settings.plugins.frame.title", { title, name })}
      />
    )
    : null;

  // A state that replaces the frame brings its own button; the strip then has none.
  const framed = !loading && !read.isError && reason === null &&
    read.data !== undefined && scope.organizationId !== null;

  return (
    <>
      <ShellActiveNavigation id={`plugin-${installId}-${pageId}`} />
      <UI.Stack data-testid="plugin-frame-page" gap="standard">
        <UI.Inline data-touch-targets="coarse" variant="between">
          <UI.Stack gap="tight">
            <UI.Inline gap="compact">
              <UI.Heading level="page">{title}</UI.Heading>
              {row?.scope === "personal"
                ? (
                  <UI.Badge>
                    {translate("settings.plugins.frame.private")}
                  </UI.Badge>
                )
                : null}
              {reason === "off"
                ? (
                  <UI.Badge>
                    {translate("settings.plugins.frame.off.badge")}
                  </UI.Badge>
                )
                : null}
            </UI.Inline>
            <UI.Inline gap="compact">
              <UI.Text variant="muted">
                {translate("settings.plugins.frame.provided", {
                  name,
                  version: row?.versionName ?? "",
                })}
              </UI.Text>
              <UI.HelpTip label={translate("settings.plugins.frame.helpLabel")}>
                {translate("settings.plugins.frame.help")}
              </UI.HelpTip>
            </UI.Inline>
          </UI.Stack>
          {framed
            ? (
              <UI.Inline gap="compact">
                <UI.Button
                  disabled={!online}
                  onClick={() => {
                    setReloads((count) => count + 1);
                    void read.refetch();
                  }}
                  variant="secondary"
                >
                  {translate("settings.plugins.frame.reload")}
                </UI.Button>
                {manage}
              </UI.Inline>
            )
            : null}
        </UI.Inline>
        {!online
          ? (
            <UI.Text role="status" variant="muted">
              {translate("settings.plugins.frame.offline")}
            </UI.Text>
          )
          : null}
        {updatedTo !== null && row !== undefined
          ? (
            <UI.InlineNotice
              action={
                <UI.Button
                  onClick={() => {
                    opened.current = row.versionName;
                    setReloads((count) => count + 1);
                  }}
                  variant="secondary"
                >
                  {translate("settings.plugins.frame.reload")}
                </UI.Button>
              }
              role="status"
              tone="information"
            >
              {translate("settings.plugins.frame.updated", {
                name,
                next: updatedTo,
                current: opened.current ?? "",
              })}
            </UI.InlineNotice>
          )
          : null}
        {body}
      </UI.Stack>
    </>
  );
}
