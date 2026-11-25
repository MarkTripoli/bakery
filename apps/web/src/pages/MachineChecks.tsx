import { useEffect } from "react";
import * as UI from "@bakery/ui";
import type { MessageArguments, MessageKey, Translator } from "@bakery/i18n";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { boundedReason } from "./MachinesPage.tsx";
import { checkInfo, groupChecks } from "./machine-page-state.ts";
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
                <UI.AlertBanner tone="information">
                  {message(translate, "machines.loading")}
                </UI.AlertBanner>
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
              : blockers.data?.failedChecks.length
              ? (
                <UI.Stack gap="standard">
                  {groupChecks(
                    blockers.data.failedChecks.map((
                      check,
                    ) => check.checkId),
                  ).map(({ group, ids }) => (
                    <UI.Stack key={group} gap="compact">
                      <UI.Heading
                        level="subsection-compact"
                        rank={3}
                      >
                        {message(
                          translate,
                          `machines.checks.group.${group}`,
                        )}
                      </UI.Heading>
                      <UI.DescriptionList>
                        {ids.map((id) => {
                          const info = checkInfo(id);
                          const failed = blockers.data!
                            .failedChecks
                            .find((
                              check,
                            ) => check.checkId === id)!;
                          const agentName = info.agent
                            ? message(
                              translate,
                              `machines.agent.${info.agent}`,
                            )
                            : null;
                          return (
                            <UI.DescriptionItem
                              key={id}
                              action={
                                <UI.Badge tone="danger">
                                  {message(
                                    translate,
                                    "machines.checks.failed",
                                  )}
                                </UI.Badge>
                              }
                              title={info.nameKey
                                ? message(
                                  translate,
                                  info.agent
                                    ? "machines.check.name.capability.modelAgent"
                                    : info.nameKey,
                                  {
                                    agent: agentName ?? "",
                                  },
                                )
                                : id}
                              description={
                                <UI.Stack gap="compact">
                                  {info.fixKey
                                    ? (
                                      <UI.Text>
                                        {message(
                                          translate,
                                          info.fixKey,
                                        )}
                                      </UI.Text>
                                    )
                                    : null}
                                  <UI.DataText
                                    variant="code"
                                    state="wrapped"
                                  >
                                    {boundedReason(
                                      failed.reason,
                                    ) ||
                                      message(
                                        translate,
                                        "machines.checks.noReason",
                                      )}
                                  </UI.DataText>
                                </UI.Stack>
                              }
                            />
                          );
                        })}
                      </UI.DescriptionList>
                    </UI.Stack>
                  ))}
                </UI.Stack>
              )
              : (
                <UI.Text>
                  {message(
                    translate,
                    "machines.checks.none",
                  )}
                </UI.Text>
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
        : (
          <UI.AlertBanner tone="information">
            {message(translate, "machines.loading")}
          </UI.AlertBanner>
        )}
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
