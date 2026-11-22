import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  organizationQueryOptions,
  pluginInstallsQueryOptions,
  pluginPackagesQueryOptions,
  pluginPagesQueryOptions,
  pluginVersionsQueryOptions,
} from "../api/query.ts";
import {
  capabilitiesOf,
  capabilityDifference,
  installedPlugins,
  isApprovalRefusal,
  mayChangeInstall,
  type PluginActor,
  type PluginCapability,
  type PluginVersion,
  publishedVersions,
  shortFingerprint,
  updateFailureOf,
} from "../app/plugins.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { SETTINGS_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";
import { CopyValueButton } from "./CopyValueButton.tsx";
import { OriginDialog } from "./plugins/PluginOrigin.tsx";
import { PagesItAdds } from "./plugins/PagesItAdds.tsx";
import { SavedData } from "./plugins/SavedData.tsx";
import {
  CapabilityList,
  RemoveDialog,
  RestoreDialog,
  TurnOffDialog,
  VersionChangeDialog,
} from "./plugins/PluginDialogs.tsx";
import {
  APPROVAL_CHANGED,
  type ChangeFailure,
  changeFailureOf,
  NO_STATE_COPY,
  usePluginChanges,
} from "./plugins/use-plugin-changes.ts";

const PLUGINS_PATH = "/settings/organization/plugins";

type Dialog =
  | { readonly kind: "off" }
  | { readonly kind: "remove" }
  | { readonly kind: "restore"; readonly version: PluginVersion }
  | {
    readonly kind: "version";
    readonly version: PluginVersion;
    readonly direction: "update" | "goBack";
  }
  | null;

/**
 * One plugin of the organization (design-ux, #76 rev 3). What it can do is a
 * read-only list taken from the version it runs: installing gave it all of it,
 * turning it off takes it away, turning it on gives it back. Updating or going
 * back shows what changes first. Removing cannot be undone.
 */
export function PluginPage({ installId }: { readonly installId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const session = useSession();
  const { locale, timeZone, translate } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const organization = useQuery(organizationQueryOptions(api, scope));
  const packages = useQuery(pluginPackagesQueryOptions(api, scope));
  const installs = useQuery(pluginInstallsQueryOptions(api, scope));
  const pageList = useQuery(pluginPagesQueryOptions(api, scope));
  const install = installs.data?.items.find((item) => item.id === installId);
  const versionRead = useQuery({
    ...pluginVersionsQueryOptions(api, scope, install?.pluginPackageId ?? ""),
    enabled: install !== undefined && Boolean(scope.organizationId),
  });
  const versions = versionRead.data?.items ?? [];
  const changes = usePluginChanges();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [failure, setFailure] = useState<ChangeFailure | null>(null);
  const [notice, setNotice] = useState<
    "on" | { readonly restored: string; readonly when: string } | null
  >(null);
  /** The version whose "Where it came from" is open. */
  const [origin, setOrigin] = useState<PluginVersion | null>(null);
  /** Versions this page tried to move to and that did not start. */
  const [didNotStart, setDidNotStart] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const actor: PluginActor = {
    role: access.data?.role ?? null,
    principalId: session.identity?.principalId ?? null,
  };
  const row = install === undefined || packages.data === undefined
    ? undefined
    : installedPlugins(
      [install],
      packages.data.items,
      new Map([[install.pluginPackageId, versions]]),
    )[0];
  const current = versions.find((item) => item.id === install?.pluginVersionId);
  const capabilities = current === undefined ? [] : capabilitiesOf(current);
  const mayChange = row === undefined ? false : mayChangeInstall(row, actor);
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(value),
    );

  const dateTime = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));

  const loading = installs.isPending || packages.isPending ||
    (install !== undefined && versionRead.isPending);
  const notFound = !loading && row === undefined;
  const name = row?.name ?? "";

  const close = () => {
    setDialog(null);
    setFailure(null);
  };
  const change = async (
    work: () => Promise<unknown>,
    done: () => void,
  ) => {
    setFailure(null);
    try {
      await work();
      done();
    } catch (error) {
      setFailure(changeFailureOf(error));
      throw error;
    }
  };
  const setStatus = (status: "enabled" | "disabled" | "uninstalled") =>
    changes.update.mutateAsync({
      id: installId,
      version: row!.installVersion,
      change: { status },
    });

  const turnOn = () =>
    void change(() => setStatus("enabled"), () => setNotice("on")).catch(
      () => undefined,
    );
  const turnOff = () =>
    void change(() => setStatus("disabled"), () => {
      setNotice(null);
      close();
    }).catch(() => undefined);
  const remove = () =>
    void change(() => setStatus("uninstalled"), () => {
      close();
      void navigate({ to: PLUGINS_PATH });
    }).catch(() => undefined);
  const moveTo = (
    version: PluginVersion,
    approval?: readonly PluginCapability[],
    restore = false,
  ) =>
    void change(
      () =>
        changes.update.mutateAsync({
          id: installId,
          version: row!.installVersion,
          change: {
            versionId: version.id,
            ...(approval === undefined
              ? {}
              : { approveCapabilities: [...approval] }),
            ...(restore ? { restoreState: true } : {}),
          },
        }).then((result) => {
          // A refused version comes back as the install with the failure on it.
          const refused = updateFailureOf(result);
          if (refused?.versionId === version.id) {
            // A changed list of new permissions, or a missing copy of the data,
            // keeps the dialog open with one line; the rest is the page notice.
            throw new Error(
              isApprovalRefusal(refused.reason)
                ? APPROVAL_CHANGED
                : refused.reason === NO_STATE_COPY
                ? NO_STATE_COPY
                : "plugin_update_refused",
            );
          }
          return result;
        }),
      () => {
        setDidNotStart((previous) => {
          const next = new Set(previous);
          next.delete(version.id);
          return next;
        });
        if (restore && row?.stateCopy != null) {
          setNotice({
            restored: version.versionName,
            when: dateTime(row.stateCopy.takenAt),
          });
        }
        close();
      },
    ).catch((error) => {
      if (changeFailureOf(error) === "failed") {
        setDidNotStart((previous) => new Set(previous).add(version.id));
      }
    });

  const published = publishedVersions(versions);
  const who = row?.scope === "organization"
    ? translate("settings.plugins.remove.whoOrganization", {
      organization: organization.data?.name ?? "",
    })
    : translate("settings.plugins.remove.whoYou");
  // The failure the server remembers, or one this page just saw.
  const recorded = row?.updateFailure ?? null;
  // The permission refusals never raise a page notice (the dialog says it), and a
  // version that cannot read the saved data has its own notice below.
  const incompatible = recorded?.reason === "plugin_state_incompatible"
    ? recorded
    : null;
  const quiet = recorded !== null &&
    (isApprovalRefusal(recorded.reason) || incompatible !== null);
  const failedNext = quiet ? null : row?.updateFailure?.versionName ??
    (row?.update === undefined || row?.update === null
      ? null
      : didNotStart.has(row.update.versionId)
      ? row.update.versionName
      : null);
  const copyVersion = row?.stateCopy == null
    ? undefined
    : versions.find((item) => item.id === row.stateCopy?.versionId);
  // The version the last update tried, offered again from the notice.
  const retryVersion = row?.updateFailure === null || row === undefined
    ? undefined
    : versions.find((item) => item.id === row.updateFailure?.versionId);
  const dismissFailure = () =>
    void change(
      () =>
        changes.update.mutateAsync({
          id: installId,
          version: row!.installVersion,
          change: { dismissUpdateFailure: true },
        }),
      () => setDidNotStart(new Set()),
    ).catch(() => undefined);

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
            ...(name === ""
              ? [{ label: translate("shell.navigation.plugins") }]
              : [
                {
                  href: PLUGINS_PATH,
                  label: translate("shell.navigation.plugins"),
                },
                { label: name },
              ]),
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="plugin">
        {loading
          ? <UI.Skeleton shape="row" />
          : notFound
          ? (
            <UI.Stack gap="standard">
              <UI.Heading level="page">
                {translate("shell.navigation.plugins")}
              </UI.Heading>
              <UI.ErrorState
                title={translate("settings.plugins.page.notFound")}
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() => void navigate({ to: PLUGINS_PATH })}
                  >
                    {translate("settings.plugins.page.back")}
                  </UI.Button>
                }
              />
            </UI.Stack>
          )
          : row === undefined
          ? null
          : (
            <>
              <UI.Stack gap="tight">
                <UI.Inline gap="compact">
                  <UI.Heading level="page">{row.name}</UI.Heading>
                  <UI.Badge
                    tone={row.state === "on"
                      ? "success"
                      : row.state === "notWorking"
                      ? "danger"
                      : "neutral"}
                  >
                    {translate(
                      `settings.plugins.state.${
                        row.state === "ready" ? "off" : row.state
                      }`,
                    )}
                  </UI.Badge>
                </UI.Inline>
                <UI.Text variant="muted">
                  {translate("settings.plugins.line.version", {
                    version: row.versionName,
                  })}
                  {" · "}
                  {row.scope === "organization"
                    ? translate("settings.plugins.scope.organization")
                    : translate("settings.plugins.scope.personal")}
                </UI.Text>
              </UI.Stack>

              {failedNext !== null
                ? (
                  <UI.InlineNotice tone="error" role="alert">
                    <UI.Text>
                      {translate("settings.plugins.update.failed.title", {
                        next: failedNext,
                      })}
                    </UI.Text>
                    <UI.Text>
                      {translate("settings.plugins.update.failed.body", {
                        version: row.versionName,
                        next: failedNext,
                      })}
                    </UI.Text>
                    {mayChange
                      ? (
                        <UI.Inline gap="compact">
                          {retryVersion === undefined ? null : (
                            <UI.Button
                              variant="primary"
                              disabled={changes.pending}
                              onClick={() => {
                                setFailure(null);
                                setDialog({
                                  kind: "version",
                                  version: retryVersion,
                                  direction: "update",
                                });
                              }}
                            >
                              {translate("settings.plugins.update.retry")}
                            </UI.Button>
                          )}
                          <UI.Button
                            variant="secondary"
                            disabled={changes.pending}
                            onClick={dismissFailure}
                          >
                            {translate("settings.plugins.update.dismiss")}
                          </UI.Button>
                        </UI.Inline>
                      )
                      : null}
                  </UI.InlineNotice>
                )
                : null}
              {incompatible === null || row === undefined
                ? null
                : (
                  <UI.InlineNotice tone="warning" role="alert">
                    <UI.Text>
                      {translate("settings.plugins.update.cannotRead.title", {
                        next: incompatible.versionName,
                      })}
                    </UI.Text>
                    <UI.Text>
                      {translate("settings.plugins.update.cannotRead.body", {
                        name,
                        current: row.versionName,
                      })}
                    </UI.Text>
                    {mayChange
                      ? (
                        <UI.Inline gap="compact">
                          {copyVersion === undefined ||
                              row.stateCopy?.versionId !==
                                incompatible.versionId
                            ? null
                            : (
                              <UI.Button
                                variant="primary"
                                disabled={changes.pending}
                                onClick={() => {
                                  setFailure(null);
                                  setDialog({
                                    kind: "restore",
                                    version: copyVersion,
                                  });
                                }}
                              >
                                {translate(
                                  "settings.plugins.update.cannotRead.restore",
                                )}
                              </UI.Button>
                            )}
                          <UI.Button
                            variant="secondary"
                            disabled={changes.pending}
                            onClick={dismissFailure}
                          >
                            {translate("settings.plugins.update.dismiss")}
                          </UI.Button>
                        </UI.Inline>
                      )
                      : null}
                  </UI.InlineNotice>
                )}
              {typeof notice === "object" && notice !== null
                ? (
                  <UI.InlineNotice tone="success" role="status">
                    {translate("settings.plugins.restore.done", {
                      name,
                      version: notice.restored,
                      date: notice.when,
                    })}
                  </UI.InlineNotice>
                )
                : null}
              {notice === "on"
                ? (
                  <UI.InlineNotice tone="success" role="status">
                    {translate("settings.plugins.turnOn.done", { name })}
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

              {mayChange
                ? (
                  <UI.Inline gap="compact">
                    {row.state === "on"
                      ? (
                        <UI.Button
                          variant="secondary"
                          onClick={() => {
                            setFailure(null);
                            setDialog({ kind: "off" });
                          }}
                        >
                          {translate("settings.plugins.turnOff.action")}
                        </UI.Button>
                      )
                      : row.state === "notWorking"
                      ? null
                      : (
                        <UI.Button
                          variant="primary"
                          disabled={changes.pending}
                          onClick={turnOn}
                        >
                          {translate("settings.plugins.action.turnOn")}
                        </UI.Button>
                      )}
                  </UI.Inline>
                )
                : null}

              <UI.Stack gap="standard" data-testid="plugin-can-do">
                <UI.Inline gap="compact">
                  <UI.Heading level="section">
                    {translate("settings.plugins.page.whatItCanDo")}
                  </UI.Heading>
                  <UI.HelpTip
                    label={translate("settings.plugins.page.whatItCanDo")}
                  >
                    {translate("settings.plugins.page.whatItCanDoHelp")}
                  </UI.HelpTip>
                </UI.Inline>
                {capabilities.length === 0
                  ? (
                    <UI.Text>
                      {translate("settings.plugins.page.noneAsked")}
                    </UI.Text>
                  )
                  : (
                    <>
                      <CapabilityList
                        capabilities={capabilities}
                        label={translate("settings.plugins.page.whatItCanDo")}
                      />
                      <UI.Text variant="hint">
                        {row.state === "on"
                          ? translate("settings.plugins.page.whenOn")
                          : translate("settings.plugins.page.whenOff")}
                      </UI.Text>
                    </>
                  )}
              </UI.Stack>

              <PagesItAdds
                installId={installId}
                on={row.state === "on"}
                pages={(pageList.data?.items ?? []).filter((page) =>
                  page.installId === installId
                )}
                phone={phone}
              />

              <SavedData installId={installId} name={name} phone={phone} />

              {current === undefined
                ? null
                : (
                  <UI.Stack gap="tight" data-testid="plugin-about">
                    <UI.Heading level="section">
                      {translate("settings.plugins.page.about")}
                    </UI.Heading>
                    <UI.Stack gap="none">
                      <UI.Text variant="caption">
                        {translate("settings.plugins.about.version")}
                      </UI.Text>
                      <UI.Text>{current.versionName}</UI.Text>
                    </UI.Stack>
                    {current.publishedAt === null ? null : (
                      <UI.Stack gap="none">
                        <UI.Text variant="caption">
                          {translate("settings.plugins.about.published")}
                        </UI.Text>
                        <UI.Text>{date(current.publishedAt)}</UI.Text>
                      </UI.Stack>
                    )}
                    <UI.Stack gap="none">
                      <UI.Inline gap="compact">
                        <UI.Text variant="caption">
                          {translate("settings.plugins.about.fingerprint")}
                        </UI.Text>
                        <UI.HelpTip
                          label={translate(
                            "settings.plugins.about.fingerprint",
                          )}
                        >
                          {translate("settings.plugins.about.fingerprintHelp")}
                        </UI.HelpTip>
                      </UI.Inline>
                      <UI.Inline gap="compact">
                        <UI.DataText fit>
                          {shortFingerprint(current.bundleDigest)}
                        </UI.DataText>
                        <CopyValueButton
                          label={translate("settings.plugins.about.copy")}
                          value={current.bundleDigest}
                        />
                      </UI.Inline>
                    </UI.Stack>
                    <UI.Text variant="hint">
                      {translate("settings.plugins.about.checked")}
                    </UI.Text>
                    <UI.Link
                      href="#where-it-came-from"
                      variant="sentence"
                      onClick={(event) => {
                        event.preventDefault();
                        setOrigin(current);
                      }}
                    >
                      {translate("settings.plugins.about.link")}
                    </UI.Link>
                  </UI.Stack>
                )}

              <UI.Stack gap="standard" data-testid="plugin-versions">
                <UI.Heading level="section">
                  {translate("settings.plugins.versions.heading")}
                </UI.Heading>
                {(() => {
                  // A version that cannot read the data the install holds now: said on its
                  // row, with the one thing to do, and no button drawn. The version Bakery
                  // holds a copy for keeps its Go back.
                  const cannotRead = (version: PluginVersion) =>
                    version.id !== row.versionId &&
                    row.cannotReadVersionIds.includes(version.id) &&
                    row.stateCopy?.versionId !== version.id;
                  // The chip follows the unreadable list alone, so the version Bakery
                  // keeps a copy for says the same thing as the notice above it
                  // and not "Did not start"; its Go back stays (see cannotRead).
                  const failedBadge = (version: PluginVersion) =>
                    version.id !== row.versionId &&
                      row.cannotReadVersionIds.includes(version.id)
                      ? (
                        <UI.Badge tone="warning">
                          {translate("settings.plugins.versions.cannotRead")}
                        </UI.Badge>
                      )
                      : version.id !== row.versionId &&
                          (didNotStart.has(version.id) ||
                            row.updateFailure?.versionId === version.id)
                      ? (
                        <UI.Badge tone="danger">
                          {translate("settings.plugins.versions.didNotStart")}
                        </UI.Badge>
                      )
                      : null;
                  const installedBadge = (version: PluginVersion) =>
                    version.id === row.versionId
                      ? (
                        <UI.Badge tone="information">
                          {translate("settings.plugins.versions.current")}
                        </UI.Badge>
                      )
                      : null;
                  const action = (version: PluginVersion) => {
                    if (version.id === row.versionId || !mayChange) return null;
                    if (cannotRead(version)) return null;
                    const newer = current?.publishedAt != null &&
                      version.publishedAt! > current.publishedAt;
                    // The version Bakery holds a copy for opens the restore dialog,
                    // so the button says that, in the notice's words.
                    const restoring = keptCopy(version) &&
                      row.cannotReadVersionIds.includes(version.id);
                    return (
                      <UI.Button
                        variant="secondary"
                        aria-label={restoring
                          ? translate(
                            "settings.plugins.versions.restoreNamed",
                            {
                              version: version.versionName,
                            },
                          )
                          : newer
                          ? translate("settings.plugins.versions.updateNamed", {
                            version: version.versionName,
                          })
                          : translate("settings.plugins.versions.goBackNamed", {
                            version: version.versionName,
                          })}
                        onClick={() => {
                          setFailure(null);
                          // The version Bakery holds a copy for opens the restore
                          // dialog when it cannot read today's data.
                          setDialog(
                            restoring ? { kind: "restore", version } : {
                              kind: "version",
                              version,
                              direction: newer ? "update" : "goBack",
                            },
                          );
                        }}
                      >
                        {restoring
                          ? translate(
                            "settings.plugins.update.cannotRead.restore",
                          )
                          : newer
                          ? translate("settings.plugins.versions.update")
                          : translate("settings.plugins.versions.goBack")}
                      </UI.Button>
                    );
                  };
                  const keptCopy = (version: PluginVersion) =>
                    row.stateCopy?.versionId === version.id &&
                    version.id !== row.versionId;
                  const publishedLine = (version: PluginVersion) =>
                    keptCopy(version)
                      ? `${
                        translate("settings.plugins.update.published", {
                          when: date(version.publishedAt!),
                        })
                      } · ${
                        translate("settings.plugins.versions.dataKept", {
                          date: date(row.stateCopy!.takenAt),
                        })
                      }`
                      : cannotRead(version)
                      ? translate("settings.plugins.versions.cannotRead.hint")
                      : translate("settings.plugins.update.published", {
                        when: date(version.publishedAt!),
                      });
                  return phone
                    ? (
                      <UI.Stack
                        gap="none"
                        role="list"
                        aria-label={translate(
                          "settings.plugins.versions.heading",
                        )}
                      >
                        {published.map((version) => (
                          <div
                            key={version.id}
                            role="listitem"
                            data-plugin-version={version.id}
                          >
                            <UI.StackedRow
                              title={
                                <UI.Inline gap="compact">
                                  <span>{version.versionName}</span>
                                  {failedBadge(version)}
                                </UI.Inline>
                              }
                              status={installedBadge(version) ?? undefined}
                            >
                              <UI.Text variant="caption">
                                {publishedLine(version)}
                              </UI.Text>
                              {action(version)}
                            </UI.StackedRow>
                          </div>
                        ))}
                      </UI.Stack>
                    )
                    : (
                      <UI.DataTable<PluginVersion>
                        caption={translate("settings.plugins.versions.heading")}
                        captionHidden
                        headingsHidden
                        variant="ruled"
                        inset="edge"
                        rowSize="double"
                        rows={published}
                        state="ready"
                        getRowKey={(version) => version.id}
                        getRowAttributes={(version) => ({
                          "data-plugin-version": version.id,
                        })}
                        columns={[
                          {
                            id: "version",
                            width: "70%",
                            header: translate("settings.plugins.page.version"),
                            cell: (version) => (
                              <UI.Stack gap="none">
                                <UI.Inline gap="compact">
                                  <UI.Text>{version.versionName}</UI.Text>
                                  {failedBadge(version)}
                                </UI.Inline>
                                <UI.Text variant="caption">
                                  {publishedLine(version)}
                                </UI.Text>
                              </UI.Stack>
                            ),
                          },
                          {
                            id: "action",
                            align: "end",
                            header: translate("settings.plugins.column.action"),
                            // The installed version has no button, so its badge
                            // sits where the other rows' buttons are.
                            cell: (version) =>
                              installedBadge(version) ?? action(version),
                          },
                        ]}
                      />
                    );
                })()}
              </UI.Stack>
              {mayChange
                ? (
                  <UI.Stack gap="standard" data-testid="plugin-more">
                    <UI.Heading level="section">
                      {translate("settings.plugins.page.more")}
                    </UI.Heading>
                    <UI.Inline gap="compact">
                      <UI.Button
                        variant="secondary"
                        onClick={() => {
                          setFailure(null);
                          setDialog({ kind: "remove" });
                        }}
                      >
                        {translate("settings.plugins.remove.action")}
                      </UI.Button>
                    </UI.Inline>
                  </UI.Stack>
                )
                : null}
            </>
          )}
      </UI.SettingsContent>
      {row === undefined || dialog?.kind !== "off" ? null : (
        <TurnOffDialog
          name={row.name}
          count={capabilities.length}
          pending={changes.update.isPending}
          failure={failure}
          onCancel={close}
          onConfirm={turnOff}
        />
      )}
      {row === undefined || dialog?.kind !== "remove" ? null : (
        <RemoveDialog
          name={row.name}
          who={who}
          pending={changes.update.isPending}
          failure={failure}
          onCancel={close}
          onConfirm={remove}
        />
      )}
      {row === undefined || dialog?.kind !== "version"
        ? null
        : (
          <VersionChangeDialog
            kind={dialog.direction}
            name={row.name}
            from={current}
            to={dialog.version}
            pending={changes.update.isPending}
            failure={failure}
            onCancel={close}
            onConfirm={(approval) => moveTo(dialog.version, approval)}
            onShowOrigin={() => setOrigin(dialog.version)}
          />
        )}
      {row === undefined || dialog?.kind !== "restore" ||
          row.stateCopy === null
        ? null
        : (
          <RestoreDialog
            name={row.name}
            to={dialog.version}
            from={current}
            copy={row.stateCopy}
            added={capabilityDifference(
              current === undefined ? [] : capabilitiesOf(current),
              capabilitiesOf(dialog.version),
            ).added}
            pending={changes.update.isPending}
            failure={failure}
            onCancel={close}
            onConfirm={(approval) => moveTo(dialog.version, approval, true)}
          />
        )}
      {origin === null || row === undefined ? null : (
        <OriginDialog
          version={origin}
          installedOn={origin.id === row.versionId}
          onClose={() => setOrigin(null)}
        />
      )}
    </>
  );
}
