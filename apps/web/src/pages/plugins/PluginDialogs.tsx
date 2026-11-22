import { useState } from "react";
import * as UI from "@bakery/ui";
import {
  type AvailablePlugin,
  capabilitiesOf,
  capabilityDifference,
  type PluginCapability,
  type PluginScope,
  type PluginStateCopy,
  type PluginVersion,
} from "../../app/plugins.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { ChangeFailure } from "./use-plugin-changes.ts";

/** Names a list of capabilities in the page's words, as one sentence part. */
export function useCapabilityWords() {
  const { locale, translate } = useI18n();
  const name = (capability: PluginCapability) =>
    translate(`settings.plugins.permission.${capability}`);
  const list = (capabilities: readonly PluginCapability[]) =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" })
      .format(capabilities.map(name));
  return { name, list };
}

/** The read-only list of what a plugin can do, one row per permission. */
export function CapabilityList(
  { capabilities, label }: {
    readonly capabilities: readonly PluginCapability[];
    readonly label: string;
  },
) {
  const { name } = useCapabilityWords();
  return (
    <UI.Stack gap="tight" role="list" aria-label={label}>
      {capabilities.map((capability) => (
        <div key={capability} role="listitem">
          <UI.Text>{name(capability)}</UI.Text>
        </div>
      ))}
    </UI.Stack>
  );
}

function FailureNotice(
  { failure, what }: { readonly failure: ChangeFailure; readonly what: string },
) {
  const { translate } = useI18n();
  return (
    <UI.InlineNotice tone="error" role="alert">
      {failure === "offline"
        ? translate("settings.plugins.offline")
        : failure === "conflict"
        ? translate("settings.plugins.conflict")
        : translate("settings.plugins.changeFailed", { what })}
    </UI.InlineNotice>
  );
}

/** Install: who it is for, what it will be able to do, and one button that grants all of it. */
export function InstallDialog(
  {
    plugin,
    version,
    organizationName,
    mayOrganization,
    pending,
    failure,
    onCancel,
    onInstall,
  }: {
    readonly plugin: AvailablePlugin;
    /** The version being installed, so its manifest can be read. */
    readonly version: PluginVersion | undefined;
    readonly organizationName: string;
    readonly mayOrganization: boolean;
    readonly pending: boolean;
    readonly failure: ChangeFailure | null;
    readonly onCancel: () => void;
    readonly onInstall: (scope: PluginScope) => void;
  },
) {
  const { locale, timeZone, translate } = useI18n();
  const [scope, setScope] = useState<PluginScope>(
    mayOrganization ? "organization" : "personal",
  );
  const capabilities = version === undefined ? [] : capabilitiesOf(version);
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone,
  }).format(new Date(plugin.publishedAt));
  const digest = version?.bundleDigest ?? "";
  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && !pending && onCancel()}
      state={pending ? "submitting" : "open"}
      title={translate("settings.plugins.install.title", { name: plugin.name })}
      variant="form"
    >
      <UI.Stack gap="standard">
        <UI.Text>
          {translate("settings.plugins.install.version", {
            version: plugin.versionName,
          })}
        </UI.Text>
        <UI.Text variant="caption">
          {translate("settings.plugins.install.published", { when })}
        </UI.Text>
        {digest === "" ? null : (
          <UI.Stack gap="none">
            <UI.Inline gap="compact">
              <UI.Text variant="caption">
                {translate("settings.plugins.install.fingerprint")}
              </UI.Text>
              <UI.HelpTip
                label={translate("settings.plugins.install.fingerprint")}
              >
                {translate("settings.plugins.install.fingerprintHelp")}
              </UI.HelpTip>
            </UI.Inline>
            <UI.DataText>{digest.slice(0, 19)}</UI.DataText>
          </UI.Stack>
        )}
        <UI.Stack
          gap="tight"
          role="radiogroup"
          aria-label={translate("settings.plugins.install.forWho")}
        >
          <UI.Heading level="subsection">
            {translate("settings.plugins.install.forWho")}
          </UI.Heading>
          <UI.Radio
            name="plugin-scope"
            value="organization"
            checked={scope === "organization"}
            disabled={!mayOrganization || pending}
            onChange={() => setScope("organization")}
          >
            {translate("settings.plugins.install.organization")}
          </UI.Radio>
          <UI.Text variant="hint">
            {mayOrganization
              ? translate("settings.plugins.install.organizationHint", {
                organization: organizationName,
              })
              : translate("settings.plugins.install.adminOnly")}
          </UI.Text>
          <UI.Radio
            name="plugin-scope"
            value="personal"
            checked={scope === "personal"}
            disabled={pending}
            onChange={() => setScope("personal")}
          >
            {translate("settings.plugins.install.personal")}
          </UI.Radio>
          <UI.Text variant="hint">
            {translate("settings.plugins.install.personalHint")}
          </UI.Text>
        </UI.Stack>
        <UI.Stack gap="tight">
          <UI.Heading level="subsection">
            {translate("settings.plugins.install.willDo")}
          </UI.Heading>
          {capabilities.length === 0
            ? (
              <UI.Text>
                {translate("settings.plugins.install.asksNothing")}
              </UI.Text>
            )
            : (
              <>
                <CapabilityList
                  capabilities={capabilities}
                  label={translate("settings.plugins.install.willDo")}
                />
                <UI.InlineNotice tone="neutral">
                  {translate("settings.plugins.install.allAtOnce", {
                    count: capabilities.length,
                  })}
                </UI.InlineNotice>
              </>
            )}
        </UI.Stack>
        {failure === null ? null : (
          <FailureNotice
            failure={failure}
            what={translate("settings.plugins.action.install")}
          />
        )}
        <UI.Inline gap="compact">
          <UI.Button variant="secondary" disabled={pending} onClick={onCancel}>
            {translate("core.actions.cancel")}
          </UI.Button>
          <UI.Button
            variant="primary"
            disabled={pending || version === undefined}
            onClick={() => onInstall(scope)}
          >
            {capabilities.length === 0
              ? translate("settings.plugins.install.confirmNothing")
              : translate("settings.plugins.install.confirm")}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    </UI.Dialog>
  );
}

/**
 * What a version asks for beyond the installed one: a label and one row per
 * permission. The Update and the restore dialog say it the same way, once.
 */
function AddedPermissions(
  { version, added }: {
    readonly version: string;
    readonly added: readonly PluginCapability[];
  },
) {
  const { translate } = useI18n();
  const { name } = useCapabilityWords();
  return (
    <>
      <UI.Text variant="strong">
        {translate("settings.plugins.update.added.label", { version })}
      </UI.Text>
      <UI.Stack gap="tight" role="list">
        {added.map((capability) => (
          <UI.Text key={capability} role="listitem">
            {name(capability)}
          </UI.Text>
        ))}
      </UI.Stack>
    </>
  );
}

/**
 * Update to a newer version, or go back to an older one. If the other version
 * asks for different permissions, the difference is shown before anything
 * changes; nothing here promises more than the server does (the new version is
 * checked first, and a failed one leaves the old one running).
 */
export function VersionChangeDialog(
  { kind, name, from, to, pending, failure, onCancel, onConfirm, onShowOrigin }:
    {
      readonly kind: "update" | "goBack";
      readonly name: string;
      readonly from: PluginVersion | undefined;
      readonly to: PluginVersion;
      readonly pending: boolean;
      readonly failure: ChangeFailure | null;
      readonly onCancel: () => void;
      /** Gets exactly the permissions the dialog showed as new, or nothing when none were added. */
      readonly onConfirm: (
        approval: readonly PluginCapability[] | undefined,
      ) => void;
      /** Opens "Where {version} came from" for the version being moved to. */
      readonly onShowOrigin?: () => void;
    },
) {
  const { locale, timeZone, translate } = useI18n();
  const words = useCapabilityWords();
  const difference = capabilityDifference(
    from === undefined ? [] : capabilitiesOf(from),
    capabilitiesOf(to),
  );
  const changes = difference.added.length > 0 || difference.removed.length > 0;
  const when = to.publishedAt === null ? "" : new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone,
  }).format(new Date(to.publishedAt));
  const fromName = from?.versionName ?? "";
  const title = kind === "update"
    ? translate("settings.plugins.update.title", { name })
    : translate("settings.plugins.goBack.title", { version: to.versionName });
  const confirmLabel = kind === "update"
    ? difference.added.length > 0
      ? translate("settings.plugins.update.added.confirm", {
        count: difference.added.length,
      })
      : translate("settings.plugins.update.confirm", {
        version: to.versionName,
      })
    : difference.added.length > 0
    ? translate("settings.plugins.goBack.allow", {
      count: difference.added.length,
    })
    : translate("settings.plugins.versions.goBack");
  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && !pending && onCancel()}
      state={pending ? "submitting" : "open"}
      title={title}
      variant="form"
    >
      <UI.Stack gap="standard">
        <UI.Text>
          {translate("settings.plugins.update.fromTo", {
            from: fromName,
            to: to.versionName,
          })}
        </UI.Text>
        {when === "" ? null : (
          <UI.Text variant="caption">
            {translate("settings.plugins.update.published", { when })}
          </UI.Text>
        )}
        {onShowOrigin === undefined ? null : (
          <UI.Inline gap="compact">
            <UI.Button variant="outline" onClick={onShowOrigin}>
              {translate("settings.plugins.update.origin", {
                version: to.versionName,
              })}
            </UI.Button>
          </UI.Inline>
        )}
        {changes
          ? (
            <UI.Stack gap="standard">
              {difference.added.length === 0 ? null : (
                <UI.Stack gap="tight">
                  <AddedPermissions
                    version={to.versionName}
                    added={difference.added}
                  />
                  <UI.Text variant="caption">
                    {translate("settings.plugins.update.added.caption", {
                      kept: capabilitiesOf(to).length - difference.added.length,
                      version: to.versionName,
                    })}
                  </UI.Text>
                </UI.Stack>
              )}
              {difference.removed.length === 0 ? null : (
                <UI.Text>
                  {translate("settings.plugins.update.noLonger", {
                    list: words.list(difference.removed),
                  })}
                </UI.Text>
              )}
            </UI.Stack>
          )
          : null}
        {kind === "update" && failure === "failed"
          ? null
          : (
            <UI.Text variant="hint">
              {kind === "update"
                ? translate("settings.plugins.update.check", { from: fromName })
                : translate("settings.plugins.goBack.body", {
                  name,
                  version: to.versionName,
                  current: fromName,
                })}
            </UI.Text>
          )}
        {failure === "changed"
          ? (
            <UI.InlineNotice tone="warning" role="alert">
              {translate("settings.plugins.update.added.changed", {
                version: to.versionName,
              })}
            </UI.InlineNotice>
          )
          : failure === null
          ? null
          : kind === "update" && failure === "failed"
          ? (
            <UI.InlineNotice tone="error" role="alert">
              <UI.Text>
                {translate("settings.plugins.update.failed.title", {
                  next: to.versionName,
                })}
              </UI.Text>
              <UI.Text>
                {translate("settings.plugins.update.failed.body", {
                  version: fromName,
                  next: to.versionName,
                })}
              </UI.Text>
            </UI.InlineNotice>
          )
          : kind === "goBack" && failure === "failed"
          ? (
            <UI.InlineNotice tone="error" role="alert">
              {translate("settings.plugins.goBack.refused", {
                version: to.versionName,
                current: fromName,
              })}
            </UI.InlineNotice>
          )
          : <FailureNotice failure={failure} what={title} />}
        <UI.Inline gap="compact">
          <UI.Button variant="secondary" disabled={pending} onClick={onCancel}>
            {kind === "update"
              ? translate("settings.plugins.update.notNow")
              : translate("core.actions.cancel")}
          </UI.Button>
          <UI.Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              onConfirm(
                difference.added.length > 0 ? difference.added : undefined,
              )}
          >
            {failure === "failed" && kind === "update"
              ? translate("settings.plugins.update.retry")
              : confirmLabel}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    </UI.Dialog>
  );
}

/**
 * Going back to a version with the data it left (#76, case C). The move
 * replaces what the plugin has saved since, so it is asked once, in words that
 * say what goes and what comes back.
 */
export function RestoreDialog(
  { name, to, from, copy, added, pending, failure, onCancel, onConfirm }: {
    readonly name: string;
    readonly to: PluginVersion;
    readonly from: PluginVersion | undefined;
    readonly copy: PluginStateCopy;
    /** Permissions the version being restored asks for beyond the installed one. */
    readonly added: readonly PluginCapability[];
    readonly pending: boolean;
    readonly failure: ChangeFailure | null;
    readonly onCancel: () => void;
    readonly onConfirm: (
      approval: readonly PluginCapability[] | undefined,
    ) => void;
  },
) {
  const { locale, timeZone, translate } = useI18n();
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(copy.takenAt));
  const current = from?.versionName ?? "";
  return (
    <UI.AlertDialog
      open
      onOpenChange={(next) => !next && !pending && onCancel()}
      state={pending ? "confirming" : "open"}
      title={translate("settings.plugins.restore.title", {
        version: to.versionName,
      })}
      cancelAction={
        <UI.Button variant="secondary" disabled={pending} onClick={onCancel}>
          {translate("core.actions.cancel")}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          variant="destructive"
          disabled={pending || failure === "noCopy"}
          onClick={() => onConfirm(added.length > 0 ? added : undefined)}
        >
          {added.length > 0
            ? translate("settings.plugins.restore.confirmAllow", {
              count: added.length,
            })
            : translate("settings.plugins.restore.confirm")}
        </UI.Button>
      }
    >
      <UI.Stack gap="tight">
        <UI.Text>
          {translate("settings.plugins.restore.body", {
            version: to.versionName,
            name,
            current,
          })}
        </UI.Text>
        <UI.Text>
          {translate("settings.plugins.restore.data", {
            when,
            count: copy.itemCount,
          })}
        </UI.Text>
        <UI.Text>
          {translate("settings.plugins.restore.removed", { current })}
        </UI.Text>
        {added.length === 0
          ? null
          : <AddedPermissions version={to.versionName} added={added} />}
        <UI.Text variant="caption">
          {translate("settings.plugins.restore.caption", { current })}
        </UI.Text>
        {failure === "noCopy"
          ? (
            <UI.InlineNotice tone="warning" role="alert">
              {translate("settings.plugins.restore.noCopy", {
                version: to.versionName,
                name,
              })}
            </UI.InlineNotice>
          )
          : failure === null
          ? null
          : (
            <FailureNotice
              failure={failure}
              what={translate("settings.plugins.restore.confirm")}
            />
          )}
      </UI.Stack>
    </UI.AlertDialog>
  );
}

/** Turn off: it stops for everyone and loses its permissions; saved data is kept. */
export function TurnOffDialog(
  { name, count, pending, failure, onCancel, onConfirm }: {
    readonly name: string;
    readonly count: number;
    readonly pending: boolean;
    readonly failure: ChangeFailure | null;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
  },
) {
  const { translate } = useI18n();
  return (
    <UI.AlertDialog
      open
      onOpenChange={(next) => !next && !pending && onCancel()}
      state={pending ? "confirming" : "open"}
      title={translate("settings.plugins.turnOff.title", { name })}
      cancelAction={
        <UI.Button variant="secondary" disabled={pending} onClick={onCancel}>
          {translate("core.actions.cancel")}
        </UI.Button>
      }
      confirmAction={
        <UI.Button variant="primary" disabled={pending} onClick={onConfirm}>
          {translate("settings.plugins.turnOff.action")}
        </UI.Button>
      }
    >
      <UI.Stack gap="tight">
        <UI.Text>
          {translate("settings.plugins.turnOff.body", { count })}
        </UI.Text>
        {failure === null ? null : (
          <FailureNotice
            failure={failure}
            what={translate("settings.plugins.turnOff.action")}
          />
        )}
      </UI.Stack>
    </UI.AlertDialog>
  );
}

/** Remove: it stops working at once and cannot be brought back. */
export function RemoveDialog(
  { name, who, pending, failure, onCancel, onConfirm }: {
    readonly name: string;
    /** Who loses it, already worded: "everyone in Acme" or "you". */
    readonly who: string;
    readonly pending: boolean;
    readonly failure: ChangeFailure | null;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
  },
) {
  const { translate } = useI18n();
  return (
    <UI.AlertDialog
      open
      variant="destructive"
      onOpenChange={(next) => !next && !pending && onCancel()}
      state={pending ? "confirming" : "open"}
      title={translate("settings.plugins.remove.title", { name })}
      cancelAction={
        <UI.Button variant="secondary" disabled={pending} onClick={onCancel}>
          {translate("core.actions.cancel")}
        </UI.Button>
      }
      confirmAction={
        <UI.Button variant="destructive" disabled={pending} onClick={onConfirm}>
          {translate("settings.plugins.remove.action")}
        </UI.Button>
      }
    >
      <UI.Stack gap="tight">
        <UI.Text>{translate("settings.plugins.remove.body", { who })}</UI.Text>
        {failure === null ? null : (
          <FailureNotice
            failure={failure}
            what={translate("settings.plugins.remove.action")}
          />
        )}
      </UI.Stack>
    </UI.AlertDialog>
  );
}
