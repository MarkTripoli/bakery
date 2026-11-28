import { useEffect } from "react";
import * as UI from "@bakery/ui";
import type { MessageArguments, MessageKey, Translator } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { MachineLoading } from "./MachineLoading.tsx";
import { MachineCheckTable } from "./MachineCheckTable.tsx";
import { checkRows, type ReportedCheck } from "./machine-checks.ts";
import { type SoftwareRow, softwareRows } from "./machine-software.ts";

function message(
  translate: Translator,
  key: string,
  arguments_?: MessageArguments,
): string {
  return translate(key as MessageKey, arguments_);
}

type Refetchable = {
  readonly isPending?: boolean;
  readonly isError: boolean;
  readonly refetch: () => unknown;
};

export type MachineChecksProps = {
  readonly blockers: Refetchable & {
    readonly data?: {
      readonly failedChecks: readonly Readonly<{
        checkId: string;
        reason?: string | null;
      }>[];
    };
  };
  readonly components: Refetchable & { readonly isSuccess: boolean };
  readonly reported: readonly ReportedCheck[];
  readonly reachable: boolean;
  readonly formatDate: (value: string) => string;
  readonly componentItems: Parameters<typeof softwareRows>[0];
  readonly nextComponentCursor: string | null | undefined;
  readonly componentContinuation: Refetchable & {
    readonly isFetching: boolean;
  };
  readonly onLoadMore: (cursor: string) => void;
  readonly isRetired: boolean;
  readonly focusChecks: boolean;
};

export function MachineChecks(
  {
    blockers,
    reported,
    reachable,
    formatDate,
    components,
    componentItems,
    nextComponentCursor,
    componentContinuation,
    onLoadMore,
    isRetired,
    focusChecks,
  }: MachineChecksProps,
) {
  const { translate } = useI18n();
  useEffect(() => {
    if (!focusChecks) return;
    const heading = document.querySelector<HTMLElement>(
      '[data-testid="machine-checks"] h2',
    );
    if (heading === null) return;
    heading.setAttribute("tabindex", "-1");
    heading.setAttribute("data-landing-focus", "true");
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }, [focusChecks, isRetired]);
  const rows = softwareRows(componentItems);
  return (
    <UI.Stack gap="spacious">
      {!isRetired
        ? (
          <UI.SettingsSection
            title={message(
              translate,
              "machines.checks.title",
            )}
            variant="stack"
            data-testid="machine-checks"
          >
            {blockers.isPending
              ? (
                <MachineLoading
                  label={message(translate, "machines.loading")}
                />
              )
              : blockers.isError
              ? (
                <UI.ErrorState
                  title={message(
                    translate,
                    "machines.error.title",
                  )}
                  description={message(
                    translate,
                    "machines.error.description",
                  )}
                  action={
                    <UI.Button
                      variant="secondary"
                      onClick={() => void blockers.refetch()}
                    >
                      {message(translate, "machines.retry")}
                    </UI.Button>
                  }
                />
              )
              : (
                <MachineCheckTable
                  rows={checkRows(reported, blockers.data?.failedChecks ?? [])}
                  reachable={reachable}
                  formatDate={formatDate}
                />
              )}
          </UI.SettingsSection>
        )
        : null}
      <SoftwareSection
        components={components}
        componentContinuation={componentContinuation}
        nextComponentCursor={nextComponentCursor}
        onLoadMore={onLoadMore}
        rows={rows}
      />
    </UI.Stack>
  );
}

function SoftwareSection(
  { components, componentContinuation, nextComponentCursor, onLoadMore, rows }:
    {
      readonly components: MachineChecksProps["components"];
      readonly componentContinuation:
        MachineChecksProps["componentContinuation"];
      readonly nextComponentCursor: string | null | undefined;
      readonly onLoadMore: (cursor: string) => void;
      readonly rows: readonly SoftwareRow[];
    },
) {
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const updateText = (row: SoftwareRow) =>
    row.update.kind === "available"
      ? message(translate, "machines.software.update.available", {
        version: row.update.version,
      })
      : message(
        translate,
        row.update.kind === "upToDate"
          ? "machines.software.update.upToDate"
          : "machines.software.update.notReported",
      );
  return (
    <UI.SettingsSection
      title={message(translate, "machines.software.title")}
      variant="stack"
      data-testid="machine-software"
    >
      <UI.Text variant="muted">
        {message(translate, "machines.software.intro")}
      </UI.Text>
      {nextComponentCursor
        ? (
          <UI.AlertBanner tone="information">
            {message(translate, "machines.pagination.truncated.components", {
              count: rows.length,
            })}
          </UI.AlertBanner>
        )
        : null}
      {components.isError
        ? (
          <UI.ErrorState
            title={message(translate, "machines.error.title")}
            description={message(translate, "machines.error.description")}
            action={
              <UI.Button
                variant="secondary"
                onClick={() => void components.refetch()}
              >
                {message(translate, "machines.retry")}
              </UI.Button>
            }
          />
        )
        : rows.length > 0 && phone
        ? (
          <UI.Stack
            gap="none"
            role="list"
            aria-label={message(translate, "machines.software.title")}
          >
            {rows.map((row) => (
              <div key={row.key} role="listitem">
                <UI.StackedRow
                  title={row.agent
                    ? message(translate, `machines.agent.${row.agent}`)
                    : row.name}
                  status={
                    <UI.Badge
                      tone={row.update.kind === "available"
                        ? "warning"
                        : "neutral"}
                    >
                      {updateText(row)}
                    </UI.Badge>
                  }
                >
                  <UI.Text variant="caption">
                    {message(translate, "machines.software.line", {
                      kind: message(
                        translate,
                        `machines.software.kind.${row.kind}`,
                      ),
                      version: row.version,
                      owner: message(
                        translate,
                        `machines.software.owner.${row.installedBy}`,
                      ),
                    })}
                  </UI.Text>
                </UI.StackedRow>
              </div>
            ))}
          </UI.Stack>
        )
        : rows.length > 0
        ? (
          <UI.DataTable
            caption={message(translate, "machines.software.title")}
            captionHidden
            columns={[
              {
                id: "name",
                header: message(translate, "machines.software.col.name"),
                cell: (row: SoftwareRow) =>
                  row.agent
                    ? message(translate, `machines.agent.${row.agent}`)
                    : row.name,
              },
              {
                id: "kind",
                header: message(translate, "machines.software.col.kind"),
                cell: (row: SoftwareRow) =>
                  message(translate, `machines.software.kind.${row.kind}`),
              },
              {
                id: "version",
                header: message(translate, "machines.software.col.version"),
                cell: (row: SoftwareRow) => row.version,
              },
              {
                id: "installedBy",
                header: message(translate, "machines.software.col.installedBy"),
                cell: (row: SoftwareRow) =>
                  message(
                    translate,
                    `machines.software.owner.${row.installedBy}`,
                  ),
              },
              {
                id: "update",
                header: message(translate, "machines.software.col.update"),
                cell: updateText,
              },
            ]}
            emptyMessage={message(translate, "machines.software.empty")}
            getRowKey={(row) => row.key}
            rows={[...rows]}
          />
        )
        : components.isSuccess
        ? <UI.Text>{message(translate, "machines.software.empty")}</UI.Text>
        : <MachineLoading label={message(translate, "machines.loading")} />}
      {componentContinuation.isError
        ? (
          <UI.AlertBanner tone="error">
            {message(translate, "machines.pagination.error.components")}
          </UI.AlertBanner>
        )
        : null}
      {nextComponentCursor
        ? (
          <UI.Button
            variant="secondary"
            disabled={componentContinuation.isFetching}
            onClick={() =>
              componentContinuation.isError
                ? void componentContinuation.refetch()
                : onLoadMore(nextComponentCursor)}
          >
            {componentContinuation.isFetching
              ? message(translate, "machines.pagination.loadingMore")
              : message(translate, "machines.pagination.loadMore")}
          </UI.Button>
        )
        : null}
    </UI.SettingsSection>
  );
}
