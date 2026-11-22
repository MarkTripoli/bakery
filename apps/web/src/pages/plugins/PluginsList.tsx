import * as UI from "@bakery/ui";
import type { AvailablePlugin, InstalledPlugin } from "../../app/plugins.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

type Tone = "success" | "neutral" | "danger" | "information";
const BADGE_TONE = {
  on: "success",
  off: "neutral",
  notWorking: "danger",
  updateFailed: "danger",
} as const satisfies Record<string, Tone>;

/** What one installed row shows. `failedUpdate` is set after an update did not start. */
export type InstalledRow = InstalledPlugin & {
  readonly failedUpdate: string | null;
  readonly mayChange: boolean;
  readonly ownerLabel: string | null;
};

function badgeKey(row: InstalledRow) {
  return row.failedUpdate !== null && row.state !== "notWorking"
    ? "updateFailed" as const
    : row.state === "ready"
    // A new install is simply on; a staged one reads as off until it is turned on.
    ? "off" as const
    : row.state;
}

/** The row's one control, in the order the design gives. */
function InstalledAction(
  { row, onManage, onTurnOn, onReviewUpdate }: {
    readonly row: InstalledRow;
    readonly onManage: (row: InstalledRow) => void;
    readonly onTurnOn: (row: InstalledRow) => void;
    readonly onReviewUpdate: (row: InstalledRow) => void;
  },
) {
  const { translate } = useI18n();
  const name = row.name;
  if (row.failedUpdate !== null || row.state === "notWorking") {
    return (
      <UI.Button
        variant="secondary"
        aria-label={translate("settings.plugins.action.seeProblemNamed", {
          name,
        })}
        onClick={() => onManage(row)}
      >
        {translate("settings.plugins.action.seeProblem")}
      </UI.Button>
    );
  }
  if (row.update !== null && row.mayChange && row.state === "on") {
    return (
      <UI.Button
        variant="primary"
        aria-label={translate("settings.plugins.action.reviewUpdateNamed", {
          name,
        })}
        onClick={() => onReviewUpdate(row)}
      >
        {translate("settings.plugins.action.reviewUpdate")}
      </UI.Button>
    );
  }
  if ((row.state === "ready" || row.state === "off") && row.mayChange) {
    return (
      <UI.Button
        variant={row.state === "ready" ? "primary" : "secondary"}
        aria-label={translate("settings.plugins.action.turnOnNamed", { name })}
        onClick={() => row.state === "ready" ? onTurnOn(row) : onManage(row)}
      >
        {row.state === "ready"
          ? translate("settings.plugins.action.turnOn")
          : translate("settings.plugins.action.manage")}
      </UI.Button>
    );
  }
  return (
    <UI.Button
      variant="secondary"
      aria-label={translate("settings.plugins.action.manageNamed", { name })}
      onClick={() => onManage(row)}
    >
      {translate("settings.plugins.action.manage")}
    </UI.Button>
  );
}

function installedLine(
  row: InstalledRow,
  translate: ReturnType<typeof useI18n>["translate"],
): string {
  // The installed version is not in the loaded list: no sentence names it.
  const unknown = row.versionName === "";
  if (row.failedUpdate !== null) {
    return unknown
      ? translate("settings.plugins.line.updateFailedUnknown", {
        next: row.failedUpdate,
      })
      : translate("settings.plugins.line.updateFailed", {
        version: row.versionName,
        next: row.failedUpdate,
      });
  }
  if (row.state === "notWorking") {
    return unknown
      ? translate("settings.plugins.line.notWorkingUnknown")
      : translate("settings.plugins.line.notWorking", {
        version: row.versionName,
      });
  }
  if (row.update !== null && row.state === "on") {
    return unknown
      ? translate("settings.plugins.line.updateAvailableUnknown", {
        next: row.update.versionName,
      })
      : translate("settings.plugins.line.updateAvailable", {
        version: row.versionName,
        next: row.update.versionName,
      });
  }
  // Nothing to say about a version that has no name: the line is left out.
  return unknown ? "" : translate("settings.plugins.line.version", {
    version: row.versionName,
  });
}

function scopeLabel(
  row: InstalledRow,
  translate: ReturnType<typeof useI18n>["translate"],
): string {
  return row.scope === "organization"
    ? translate("settings.plugins.scope.organization")
    : row.ownerLabel === null
    ? translate("settings.plugins.scope.personal")
    : translate("settings.plugins.scope.personalOf", { name: row.ownerLabel });
}

/** Installed plugins: a table on a wide screen, stacked rows on a phone. */
export function InstalledList(
  { rows, phone, onManage, onTurnOn, onReviewUpdate }: {
    readonly rows: readonly InstalledRow[];
    readonly phone: boolean;
    readonly onManage: (row: InstalledRow) => void;
    readonly onTurnOn: (row: InstalledRow) => void;
    readonly onReviewUpdate: (row: InstalledRow) => void;
  },
) {
  const { translate } = useI18n();
  const badge = (row: InstalledRow) => {
    const key = badgeKey(row);
    return (
      <UI.Badge tone={BADGE_TONE[key]}>
        {translate(`settings.plugins.state.${key}`)}
      </UI.Badge>
    );
  };
  const action = (row: InstalledRow) => (
    <InstalledAction
      row={row}
      onManage={onManage}
      onTurnOn={onTurnOn}
      onReviewUpdate={onReviewUpdate}
    />
  );
  if (phone) {
    return (
      <UI.Stack
        gap="none"
        role="list"
        aria-label={translate("settings.plugins.installed.caption")}
      >
        {rows.map((row) => (
          <div
            key={row.installId}
            role="listitem"
            data-plugin-install={row.installId}
          >
            <UI.StackedRow title={row.name} status={badge(row)}>
              {installedLine(row, translate) === ""
                ? null
                : (
                  <UI.Text variant="caption">
                    {installedLine(row, translate)}
                  </UI.Text>
                )}
              <UI.Text variant="caption">{scopeLabel(row, translate)}</UI.Text>
              {action(row)}
            </UI.StackedRow>
          </div>
        ))}
      </UI.Stack>
    );
  }
  return (
    <UI.DataTable<InstalledRow>
      caption={translate("settings.plugins.installed.caption")}
      captionHidden
      variant="ruled"
      inset="edge"
      rowSize="double"
      rows={[...rows]}
      state="ready"
      getRowKey={(row) => row.installId}
      getRowAttributes={(row) => ({ "data-plugin-install": row.installId })}
      columns={[
        {
          id: "plugin",
          width: "38%",
          header: translate("settings.plugins.column.plugin"),
          cell: (row) => (
            <UI.Stack gap="none">
              <UI.Text>{row.name}</UI.Text>
              {installedLine(row, translate) === ""
                ? null
                : (
                  <UI.Text variant="caption">
                    {installedLine(row, translate)}
                  </UI.Text>
                )}
            </UI.Stack>
          ),
        },
        {
          id: "status",
          width: "14%",
          header: translate("settings.plugins.column.status"),
          cell: badge,
        },
        {
          id: "for",
          width: "16%",
          header: translate("settings.plugins.column.for"),
          cell: (row) => <UI.Text>{scopeLabel(row, translate)}</UI.Text>,
        },
        {
          id: "action",
          align: "end",
          header: translate("settings.plugins.column.action"),
          cell: action,
        },
      ]}
    />
  );
}

/** Plugins published here and not installed for the organization yet. */
export function AvailableList(
  { rows, phone, mayInstall, onInstall }: {
    readonly rows: readonly AvailablePlugin[];
    readonly phone: boolean;
    readonly mayInstall: boolean;
    readonly onInstall: (row: AvailablePlugin) => void;
  },
) {
  const { locale, timeZone, translate } = useI18n();
  const when = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(value),
    );
  const line = (row: AvailablePlugin) =>
    translate("settings.plugins.line.available", {
      version: row.versionName,
      when: when(row.publishedAt),
    });
  const action = (row: AvailablePlugin) =>
    mayInstall
      ? (
        <UI.Button
          variant="secondary"
          aria-label={translate("settings.plugins.action.installNamed", {
            name: row.name,
          })}
          onClick={() => onInstall(row)}
        >
          {translate("settings.plugins.action.install")}
        </UI.Button>
      )
      : null;
  const detail = (row: AvailablePlugin) => (
    <UI.Stack gap="none">
      <UI.Text variant="caption">{line(row)}</UI.Text>
      {row.havePrivately
        ? (
          <UI.Text variant="caption">
            {translate("settings.plugins.line.havePrivately")}
          </UI.Text>
        )
        : null}
    </UI.Stack>
  );
  if (phone) {
    return (
      <UI.Stack
        gap="none"
        role="list"
        aria-label={translate("settings.plugins.available.caption")}
      >
        {rows.map((row) => (
          <div
            key={row.packageId}
            role="listitem"
            data-plugin-package={row.packageId}
          >
            <UI.StackedRow title={row.name}>
              {detail(row)}
              {action(row)}
            </UI.StackedRow>
          </div>
        ))}
      </UI.Stack>
    );
  }
  return (
    <UI.DataTable<AvailablePlugin>
      caption={translate("settings.plugins.available.caption")}
      captionHidden
      variant="ruled"
      inset="edge"
      rowSize="double"
      rows={[...rows]}
      state="ready"
      getRowKey={(row) => row.packageId}
      getRowAttributes={(row) => ({ "data-plugin-package": row.packageId })}
      columns={[
        {
          id: "plugin",
          width: "70%",
          header: translate("settings.plugins.column.plugin"),
          cell: (row) => (
            <UI.Stack gap="none">
              <UI.Text>{row.name}</UI.Text>
              {detail(row)}
            </UI.Stack>
          ),
        },
        {
          id: "action",
          align: "end",
          header: translate("settings.plugins.column.action"),
          cell: action,
        },
      ]}
    />
  );
}
