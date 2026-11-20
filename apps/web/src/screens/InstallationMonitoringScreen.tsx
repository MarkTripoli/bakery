import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import type { MessageKey } from "@bakery/i18n";
import type { TelemetryDestination } from "../api/client.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  atLimit,
  type DestinationFilters,
  type DestinationKind,
  failingOf,
  filterDestinations,
  isStateFilter,
  orderDestinations,
  STATE_FILTERS,
  type StateFilter,
  stateWords,
} from "./monitoring/monitoring-display.ts";

/** What a refused change says. */
export type SaveNotice =
  | "failed"
  | "conflict"
  | "nameTaken"
  | "limit"
  | "noKey"
  | "offline";

export const NOTICE_KEYS = {
  failed: "installation.monitoring.notice.failed",
  conflict: "installation.monitoring.notice.conflict",
  nameTaken: "installation.monitoring.notice.nameTaken",
  limit: "installation.monitoring.notice.limit",
  noKey: "installation.monitoring.notice.noKey",
  offline: "installation.monitoring.notice.offline",
} as const satisfies Record<SaveNotice, MessageKey>;

export type InstallationMonitoringScreenProps = {
  readonly state: "loading" | "error" | "notFound" | "ready";
  readonly destinations: readonly TelemetryDestination[];
  readonly kinds: readonly DestinationKind[];
  readonly filters: DestinationFilters;
  readonly rowNotice: SaveNotice | null;
  readonly pendingIds: readonly string[];
  readonly onFiltersChange: (filters: DestinationFilters) => void;
  /** Add a destination of this kind: opens its own page. */
  readonly onAdd: (kind: string) => void;
  /** Open one destination's page. */
  readonly onOpen: (destination: TelemetryDestination) => void;
  readonly onToggle: (
    destination: TelemetryDestination,
    enabled: boolean,
  ) => void;
  readonly onRetry: () => void;
};

const STATE_LABEL: Readonly<Record<StateFilter, MessageKey>> = {
  all: "installation.monitoring.filter.allStates",
  working: "installation.monitoring.state.working",
  not_tested_yet: "installation.monitoring.state.notSent",
  failing: "installation.monitoring.state.failing",
  dropping_data: "installation.monitoring.state.dropping",
  off: "installation.monitoring.state.off",
};

/**
 * `/installation/monitoring`: where Bakery sends its measurements, as a table
 * that holds many destinations, with a search and filters kept in the address.
 * A destination has its own page; nothing is edited here except the switch.
 */
export function InstallationMonitoringScreen(
  props: InstallationMonitoringScreenProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  const { state, destinations, kinds, filters } = props;
  const when = (iso: string) =>
    formatDate(new Date(iso), locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
  const kindLabel = (id: string) =>
    kinds.find((entry) => entry.kind === id)?.label ?? id;

  if (state === "notFound") {
    return (
      <UI.EmptyState
        description={translate("installation.monitoring.notFound.body")}
        inset="page"
        layout="centered"
        title={translate("installation.monitoring.notFound.title")}
        variant="filtered"
      />
    );
  }

  const limit = atLimit(destinations);
  const failing = failingOf(destinations);
  const shown = orderDestinations(
    filterDestinations(destinations, filters, kindLabel),
  );
  const filtered = filters.q.trim() !== "" || filters.state !== "all" ||
    filters.kind !== null;

  const addControl = kinds.length === 1
    ? (
      <UI.Button
        disabled={limit}
        onClick={() => props.onAdd(kinds[0].kind)}
        type="button"
        variant="primary"
      >
        {translate("installation.monitoring.add")}
      </UI.Button>
    )
    : (
      <UI.Popover
        align="end"
        label={translate("installation.monitoring.add")}
        trigger={translate("installation.monitoring.add")}
        triggerAppearance="toolbar"
        variant="interactive"
      >
        <UI.Menu
          aria-label={translate("installation.monitoring.add")}
          items={kinds.map((entry) => ({
            id: entry.kind,
            label: entry.label,
            disabled: limit,
          }))}
          onSelect={props.onAdd}
        />
      </UI.Popover>
    );

  const stateWord = translate("installation.monitoring.filter.state");
  const stateLabel = `${stateWord}: ${translate(STATE_LABEL[filters.state])}`;
  const kindWord = translate("installation.monitoring.filter.kind");
  const kindText = `${kindWord}: ${
    filters.kind === null
      ? translate("installation.monitoring.filter.allKinds")
      : kindLabel(filters.kind)
  }`;

  const sendingSwitch = (row: TelemetryDestination) => (
    <UI.Switch
      checked={row.enabled}
      disabled={props.pendingIds.includes(row.id)}
      onChange={(event) => props.onToggle(row, event.currentTarget.checked)}
      pending={props.pendingIds.includes(row.id)}
    >
      <UI.VisuallyHidden>
        {translate("installation.monitoring.row.switchName", {
          name: row.name,
        })}
      </UI.VisuallyHidden>
    </UI.Switch>
  );
  /** A phone row's one detail line: what it is, when it last sent, what it lost. */
  const rowLine = (row: TelemetryDestination) => {
    const line = row.lastAcceptedAt === null
      ? translate("installation.monitoring.row.lineNever", {
        kind: kindLabel(row.kind),
      })
      : translate("installation.monitoring.row.line", {
        kind: kindLabel(row.kind),
        time: when(row.lastAcceptedAt),
      });
    return row.dropped > 0
      ? translate("installation.monitoring.row.lineDropped", {
        line,
        count: row.dropped.toLocaleString(locale),
      })
      : line;
  };

  const columns: UI.DataTableColumn<TelemetryDestination>[] = [
    {
      id: "name",
      header: translate("installation.monitoring.column.name"),
      cell: (row) => (
        <RouterLink
          data-name="true"
          params={{ destinationId: row.id }}
          to="/installation/monitoring/$destinationId"
          variant="quiet"
        >
          {row.name}
        </RouterLink>
      ),
    },
    {
      id: "kind",
      header: translate("installation.monitoring.column.kind"),
      width: "140px",
      cell: (row) => kindLabel(row.kind),
    },
    {
      id: "state",
      header: translate("installation.monitoring.column.state"),
      width: "140px",
      cell: (row) => {
        const words = stateWords(row.state);
        return <UI.Badge tone={words.tone}>{translate(words.key)}</UI.Badge>;
      },
    },
    {
      id: "lastSent",
      header: translate("installation.monitoring.column.lastSent"),
      width: "180px",
      cell: (row) =>
        row.lastAcceptedAt === null
          ? <UI.Text variant="muted">—</UI.Text>
          : when(row.lastAcceptedAt),
    },
    {
      id: "dropped",
      header: translate("installation.monitoring.column.dropped"),
      width: "90px",
      align: "end",
      cell: (row) =>
        row.dropped > 0
          ? row.dropped.toLocaleString(locale)
          : <UI.Text variant="muted">0</UI.Text>,
    },
    {
      id: "sending",
      header: translate("installation.monitoring.column.sending"),
      width: "80px",
      cell: sendingSwitch,
    },
    {
      id: "action",
      header: (
        <UI.VisuallyHidden>
          {translate("installation.monitoring.column.action")}
        </UI.VisuallyHidden>
      ),
      width: "104px",
      cell: (row) => (
        <UI.Button
          onClick={() => props.onOpen(row)}
          type="button"
          variant={row.state === "failing" ? "primary" : "secondary"}
        >
          {translate(
            row.state === "failing"
              ? "installation.monitoring.row.fix"
              : "installation.monitoring.row.open",
          )}
        </UI.Button>
      ),
    },
  ];

  return (
    <UI.SettingsContent data-page="installation-monitoring" variant="wide">
      {state === "ready" && destinations.length > 0 && !phone
        ? <ShellSlot name="actions">{addControl}</ShellSlot>
        : null}
      <UI.PageHeader
        actions={state === "ready" && destinations.length > 0 && phone
          ? addControl
          : undefined}
        description={translate("installation.monitoring.description")}
        flush
        title={translate("installation.monitoring.title")}
        variant="list"
      />
      {state === "loading"
        ? (
          <UI.Stack aria-busy="true" gap="compact">
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )
        : null}
      {state === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={props.onRetry} type="button">
                {translate("installation.monitoring.retry")}
              </UI.Button>
            }
            title={translate("installation.monitoring.error")}
          />
        )
        : null}
      {state === "ready"
        ? (
          <>
            {failing.length === 1
              ? (
                <UI.AlertBanner
                  action={
                    <UI.Button
                      onClick={() => props.onOpen(failing[0])}
                      type="button"
                    >
                      {translate("installation.monitoring.row.fix")}
                    </UI.Button>
                  }
                  tone="error"
                >
                  <strong>
                    {translate("installation.monitoring.failing.title", {
                      name: failing[0].name,
                    })}
                  </strong>{" "}
                  {failing[0].lastAnswerReason ?? ""}{" "}
                  {failing[0].lastAcceptedAt === null ? "" : translate(
                    "installation.monitoring.failing.lastAccepted",
                    {
                      time: when(failing[0].lastAcceptedAt),
                    },
                  )} {failing[0].dropped > 0 && failing[0].droppedSince !== null
                    ? translate("installation.monitoring.failing.dropped", {
                      count: failing[0].dropped,
                      since: when(failing[0].droppedSince),
                    })
                    : ""}{" "}
                  {translate("installation.monitoring.failing.notAffected")}
                </UI.AlertBanner>
              )
              : failing.length > 1
              ? (
                <UI.AlertBanner
                  action={
                    <UI.Button
                      onClick={() =>
                        props.onFiltersChange({
                          ...filters,
                          state: "failing",
                        })}
                      type="button"
                    >
                      {translate("installation.monitoring.failing.show")}
                    </UI.Button>
                  }
                  tone="error"
                >
                  {translate("installation.monitoring.failing.several", {
                    count: failing.length,
                  })}
                </UI.AlertBanner>
              )
              : null}
            {props.rowNotice !== null
              ? (
                <UI.InlineNotice tone="error">
                  {translate(NOTICE_KEYS[props.rowNotice])}
                </UI.InlineNotice>
              )
              : null}
            {destinations.length === 0
              ? (
                <UI.EmptyState
                  action={
                    <UI.Inline gap="standard">
                      {kinds.map((entry) => (
                        <UI.Button
                          key={entry.kind}
                          onClick={() => props.onAdd(entry.kind)}
                          type="button"
                        >
                          {translate("installation.monitoring.addKind", {
                            kind: entry.label,
                          })}
                        </UI.Button>
                      ))}
                    </UI.Inline>
                  }
                  description={translate("installation.monitoring.empty.body")}
                  title={translate("installation.monitoring.empty.title")}
                  variant="firstUse"
                />
              )
              : (
                <>
                  <UI.Inline gap="compact">
                    <UI.SearchField
                      aria-label={translate(
                        "installation.monitoring.search.label",
                      )}
                      name="q"
                      onChange={(event) =>
                        props.onFiltersChange({
                          ...filters,
                          q: event.currentTarget.value,
                        })}
                      placeholder={translate(
                        "installation.monitoring.search.label",
                      )}
                      value={filters.q}
                    />
                    <UI.Popover
                      align="start"
                      label={stateWord}
                      trigger={
                        <>
                          {stateLabel}
                          <UI.IconGlyph name="chevron-down" size="small" />
                        </>
                      }
                      triggerAppearance="toolbar"
                      triggerLabel={stateLabel}
                      variant="interactive"
                    >
                      <UI.Menu
                        aria-label={stateWord}
                        items={STATE_FILTERS.map((choice) => ({
                          id: choice,
                          label: translate(STATE_LABEL[choice]),
                          selected: choice === filters.state,
                        }))}
                        onSelect={(id) => {
                          if (isStateFilter(id)) {
                            props.onFiltersChange({ ...filters, state: id });
                          }
                        }}
                        variant="selection"
                      />
                    </UI.Popover>
                    {kinds.length >= 2
                      ? (
                        <UI.Popover
                          align="start"
                          label={kindWord}
                          trigger={
                            <>
                              {kindText}
                              <UI.IconGlyph name="chevron-down" size="small" />
                            </>
                          }
                          triggerAppearance="toolbar"
                          triggerLabel={kindText}
                          variant="interactive"
                        >
                          <UI.Menu
                            aria-label={kindWord}
                            items={[
                              {
                                id: "all",
                                label: translate(
                                  "installation.monitoring.filter.allKinds",
                                ),
                                selected: filters.kind === null,
                              },
                              ...kinds.map((entry) => ({
                                id: entry.kind,
                                label: entry.label,
                                selected: entry.kind === filters.kind,
                              })),
                            ]}
                            onSelect={(id) =>
                              props.onFiltersChange({
                                ...filters,
                                kind: id === "all" ? null : id,
                              })}
                            variant="selection"
                          />
                        </UI.Popover>
                      )
                      : null}
                    <UI.Text variant="muted">
                      {translate("installation.monitoring.count", {
                        count: shown.length,
                      })}
                    </UI.Text>
                  </UI.Inline>
                  {shown.length === 0
                    ? (
                      <UI.EmptyState
                        action={filtered
                          ? (
                            <UI.Button
                              onClick={() =>
                                props.onFiltersChange({
                                  q: "",
                                  state: "all",
                                  kind: null,
                                })}
                              type="button"
                              variant="secondary"
                            >
                              {translate(
                                "installation.monitoring.filter.clear",
                              )}
                            </UI.Button>
                          )
                          : undefined}
                        description=""
                        title={translate(
                          "installation.monitoring.filter.none",
                        )}
                        variant="filtered"
                      />
                    )
                    : phone
                    ? (
                      <UI.Stack
                        aria-label={translate("installation.monitoring.title")}
                        gap="none"
                        role="list"
                      >
                        {shown.map((row) => {
                          const words = stateWords(row.state);
                          return (
                            <div
                              data-destination={row.id}
                              key={row.id}
                              role="listitem"
                            >
                              <UI.StackedRow
                                status={
                                  <UI.Badge tone={words.tone}>
                                    {translate(words.key)}
                                  </UI.Badge>
                                }
                                title={
                                  <RouterLink
                                    data-name="true"
                                    params={{ destinationId: row.id }}
                                    to="/installation/monitoring/$destinationId"
                                    variant="quiet"
                                  >
                                    {row.name}
                                  </RouterLink>
                                }
                              >
                                <UI.Inline gap="standard">
                                  <UI.Text variant="caption">
                                    {rowLine(row)}
                                  </UI.Text>
                                  {sendingSwitch(row)}
                                </UI.Inline>
                              </UI.StackedRow>
                            </div>
                          );
                        })}
                      </UI.Stack>
                    )
                    : (
                      <UI.DataTable
                        caption={translate("installation.monitoring.title")}
                        captionHidden
                        columns={columns}
                        getRowAttributes={(row) => ({
                          "data-destination": row.id,
                        })}
                        getRowKey={(row) => row.id}
                        rows={shown}
                        variant="ruled"
                      />
                    )}
                  {limit
                    ? (
                      <UI.Text variant="muted">
                        {translate("installation.monitoring.limit")}
                      </UI.Text>
                    )
                    : null}
                </>
              )}
          </>
        )
        : null}
    </UI.SettingsContent>
  );
}
