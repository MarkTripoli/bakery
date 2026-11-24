import { useState } from "react";
import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import type { UsageSummary } from "../api/client.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { usd } from "./usage/usage-money.ts";
import {
  billingKey,
  confirmedFigure,
  moneyOrDash,
  providerName,
  type ProviderRow,
  providerRows,
  recordKey,
} from "./usage/usage-display.ts";
import {
  isUsagePeriod,
  USAGE_PERIODS,
  type UsagePeriod,
} from "./usage/usage-window.ts";

/**
 * Installation-wide usage, for installation administrators.
 *
 * The rule the whole screen is built around: an unknown is never a zero, and a
 * figure that is not confirmed is never added to one that is. Three figures sit
 * side by side for that reason - a confirmed total, an amount reported but not
 * yet backed by a receipt, and a count of records whose cost nobody knows.
 * Collapsing them into one number would be a lie about which part is evidence.
 */

export type InstallationUsageScreenProps = {
  readonly summary: UsageSummary | null;
  readonly state: "loading" | "error" | "ready" | "empty" | "notFound";
  readonly period: UsagePeriod;
  readonly provider: string | null;
  readonly providers: readonly string[];
  readonly periodError: "incomplete" | "reversed" | "tooLong" | null;
  readonly customFrom: string;
  readonly customTo: string;
  readonly onCustomChange: (
    range: Readonly<{ from: string; to: string }>,
  ) => void;
  readonly onPeriodChange: (period: UsagePeriod) => void;
  readonly onProviderChange: (provider: string | null) => void;
  readonly onRetry: () => void;
  readonly onShowLast30Days: () => void;
};

export function InstallationUsageScreen(
  {
    summary,
    state,
    period,
    provider,
    providers,
    periodError,
    customFrom,
    customTo,
    onCustomChange,
    onPeriodChange,
    onProviderChange,
    onRetry,
    onShowLast30Days,
  }: InstallationUsageScreenProps,
) {
  const { translate, locale, timeZone } = useI18n();
  const money = useMoney();
  const [periodOpen, setPeriodOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  // Formatted here, so the count is an argument the catalogue can inflect on.
  const records = (count: number) =>
    translate(recordKey(count), { count: String(count) });

  if (state === "notFound") {
    return (
      <UI.SettingsContent data-page="installation-usage">
        <UI.EmptyState
          align="start"
          description={translate("installation.usage.notFound.body")}
          layout="centered"
          title={translate("installation.usage.notFound.title")}
          titleStyle="heading"
          variant="filtered"
        />
      </UI.SettingsContent>
    );
  }

  const completeness = summary?.completeness ?? "complete";
  const rows = summary?.byProvider ?? [];
  const budgets = summary?.budgetAccounts ?? [];
  const confirmed = confirmedFigure(summary);

  // Two filter buttons beside the title, each a compact trigger whose panel is
  // the menu of choices: the period and the provider are settings on the
  // figures below, not part of reading them. Each button says its own word and
  // its current value ("Period: Last 30 days"), so the page never needs a
  // caption above a pair of open lists.
  const periodWord = translate("installation.usage.period");
  const providerWord = translate("installation.usage.provider");
  const periodLabel = `${periodWord}: ${translate(PERIOD_MESSAGES[period])}`;
  const providerLabel = `${providerWord}: ${
    provider === null
      ? translate("installation.usage.provider.all")
      : providerName(provider)
  }`;
  const periodItems: UI.MenuItem[] = USAGE_PERIODS.map((choice) => ({
    id: choice,
    label: translate(PERIOD_MESSAGES[choice]),
    selected: choice === period,
  }));
  const providerItems: UI.MenuItem[] = [
    {
      id: "all",
      label: translate("installation.usage.provider.all"),
      selected: provider === null,
    },
    ...(provider === null || providers.includes(provider)
      ? providers
      : [provider, ...providers]).map((name) => ({
        id: name,
        label: providerName(name),
        selected: name === provider,
      })),
  ];
  const customRow = period === "custom"
    ? (
      <UI.Stack gap="compact">
        <UI.Inline gap="compact">
          <UI.Field
            htmlFor="usage-from"
            label={translate("installation.usage.period.from")}
          >
            <UI.TextInput
              autoComplete="off"
              id="usage-from"
              name="from"
              onChange={(from) => onCustomChange({ from, to: customTo })}
              type="date"
              value={customFrom}
            />
          </UI.Field>
          <UI.Field
            htmlFor="usage-to"
            label={translate("installation.usage.period.to")}
          >
            <UI.TextInput
              autoComplete="off"
              id="usage-to"
              name="to"
              onChange={(to) => onCustomChange({ from: customFrom, to })}
              type="date"
              value={customTo}
            />
          </UI.Field>
        </UI.Inline>
        {periodError === "tooLong" || periodError === "reversed"
          ? (
            <UI.Text role="alert" variant="error">
              {translate(
                periodError === "tooLong"
                  ? "installation.usage.period.tooLong"
                  : "installation.usage.period.reversed",
              )}
            </UI.Text>
          )
          : null}
      </UI.Stack>
    )
    : null;
  const filters = (
    <UI.Stack gap="compact">
      <UI.Inline gap="compact">
        <UI.Popover
          align="end"
          label={periodWord}
          onOpenChange={setPeriodOpen}
          open={periodOpen}
          trigger={
            <>
              {periodLabel}
              <UI.IconGlyph name="chevron-down" size="small" />
            </>
          }
          triggerAppearance="toolbar"
          triggerLabel={periodLabel}
          variant="interactive"
        >
          <UI.Menu
            aria-label={periodWord}
            items={periodItems}
            onSelect={(id) => {
              if (isUsagePeriod(id)) {
                onPeriodChange(id);
                setPeriodOpen(false);
              }
            }}
            variant="selection"
          />
        </UI.Popover>
        <UI.Popover
          align="end"
          label={providerWord}
          onOpenChange={setProviderOpen}
          open={providerOpen}
          trigger={
            <>
              {providerLabel}
              <UI.IconGlyph name="chevron-down" size="small" />
            </>
          }
          triggerAppearance="toolbar"
          triggerLabel={providerLabel}
          variant="interactive"
        >
          <UI.Menu
            aria-label={providerWord}
            items={providerItems}
            onSelect={(id) => {
              onProviderChange(id === "all" ? null : id);
              setProviderOpen(false);
            }}
            variant="selection"
          />
        </UI.Popover>
      </UI.Inline>
      {customRow}
    </UI.Stack>
  );

  // Loading is its own state, not an empty table: a table of zeros while the
  // first answer is in flight says the period had nothing in it, which is a
  // claim the page has not earned yet.
  const pageState = state === "ready"
    ? "default"
    : state === "error"
    ? "error"
    : state === "empty"
    ? "empty"
    : "loading";

  return (
    <UI.SettingsContent data-page="installation-usage">
      <UI.AccessSettings
        actions={filters}
        description={translate("installation.usage.description")}
        notice={completeness === "partial" && summary
          ? (
            <UI.AlertBanner tone="warning">
              {
                /* The title stands on its own line: run together with the
                    sentence it reads as one long heading. */
              }
              <UI.Stack gap="tight">
                <strong>{translate("installation.usage.partial.title")}</strong>
                <span>
                  {translate("installation.usage.partial.body", {
                    unverified: summary.unverifiedCount,
                    unknown: summary.unknownCount,
                  })}
                </span>
              </UI.Stack>
            </UI.AlertBanner>
          )
          : completeness === "unknown"
          ? (
            <UI.AlertBanner tone="information">
              <UI.Stack gap="tight">
                <strong>{translate("installation.usage.unknown.title")}</strong>
                <span>{translate("installation.usage.unknown.body")}</span>
              </UI.Stack>
            </UI.AlertBanner>
          )
          : undefined}
        state={pageState}
        status={{
          title: state === "error"
            ? translate("installation.usage.title")
            : translate("installation.usage.empty.title"),
          description: state === "error"
            ? translate("installation.usage.error")
            : translate("installation.usage.empty.body", {
              from: summary
                ? formatDate(new Date(summary.from), locale, {
                  dateStyle: "medium",
                  timeZone,
                })
                : "",
              to: summary
                ? formatDate(new Date(summary.to), locale, {
                  dateStyle: "medium",
                  timeZone,
                })
                : "",
            }),
          // The way back to 30 days is offered only when the period is not already 30 days.
          action: state !== "error" && period === "last30"
            ? undefined
            : (
              <UI.Button
                onClick={state === "error" ? onRetry : onShowLast30Days}
              >
                {state === "error"
                  ? translate("installation.usage.retry")
                  : translate("installation.usage.empty.action")}
              </UI.Button>
            ),
          label: translate("installation.usage.loading"),
        }}
        title={translate("installation.usage.title")}
      >
        {state === "ready"
          ? (
            <>
              <UI.Inline gap="standard" variant="thirds">
                <UI.StatTile
                  detail={confirmed.noReceipts
                    ? translate("installation.usage.confirmed.noReceipts")
                    : translate("installation.usage.confirmed.detail")}
                  help={{
                    label: translate("installation.usage.confirmed.label"),
                    text: translate("installation.usage.confirmed.help"),
                  }}
                  label={translate("installation.usage.confirmed.label")}
                  value={confirmed.noReceipts || summary === null
                    ? "\u2014"
                    : money(confirmed.value)}
                />
                <UI.StatTile
                  detail={translate("installation.usage.unverified.detail", {
                    records: records(summary?.unverifiedCount ?? 0),
                  })}
                  help={{
                    label: translate("installation.usage.unverified.label"),
                    text: translate("installation.usage.unverified.help"),
                  }}
                  label={translate("installation.usage.unverified.label")}
                  value={summary ? money(summary.unverifiedCostUsd) : "\u2014"}
                />
                <UI.StatTile
                  detail={translate("installation.usage.unknownCount.detail")}
                  help={{
                    label: translate("installation.usage.unknownCount.label"),
                    text: translate("installation.usage.unknownCount.help"),
                  }}
                  label={translate("installation.usage.unknownCount.label")}
                  value={summary ? records(summary.unknownCount) : "\u2014"}
                />
              </UI.Inline>

              <UI.SettingsSection
                title={translate(
                  "installation.usage.byProvider.heading",
                )}
              >
                <UsageProviderTable rows={providerRows(rows)} />
              </UI.SettingsSection>

              {budgets.length > 0
                ? (
                  <UI.SettingsSection
                    title={translate(
                      "installation.usage.budgets.heading",
                    )}
                  >
                    <UsageBudgetTable accounts={budgets} />
                  </UI.SettingsSection>
                )
                : null}
            </>
          )
          : null}
      </UI.AccessSettings>
    </UI.SettingsContent>
  );
}

/** Money in the page's words: an amount under a cent reads "Less than $0.01", never "$0.00". */
function useMoney(): (amount: string) => string {
  const { translate } = useI18n();
  return (amount) =>
    usd(
      amount,
      (smallest) =>
        translate("installation.usage.lessThanCent", { amount: smallest }),
    );
}

/** Provider figures, with the total as the last row. */
function UsageProviderTable({ rows }: { readonly rows: ProviderRow[] }) {
  const { translate } = useI18n();
  const money = useMoney();
  // The wire value is a fallback, never a guess: a route this page has no
  // word for prints itself rather than being called one of the five.
  const routeWord = (route: string) => {
    const key = billingKey(route);
    return key === null ? route : translate(key);
  };
  // Formatted here, so the count is an argument the catalogue can inflect on.
  const records = (count: number) =>
    translate(recordKey(count), { count: String(count) });
  const phone = useShellViewport() === "phone";
  const columns: UI.DataTableColumn<ProviderRow>[] = [
    {
      id: "provider",
      header: translate("installation.usage.byProvider.provider"),
      cell: (row) => (
        <UI.Stack gap="none">
          <span>
            {row.key === "total"
              ? translate("installation.usage.byProvider.total")
              : providerName(row.provider)}
          </span>
          {row.key === "total" || row.billingType === ""
            ? null
            : (
              <UI.Text variant="muted">
                {routeWord(row.billingType)}
              </UI.Text>
            )}
        </UI.Stack>
      ),
    },
    {
      id: "confirmed",
      header: translate("installation.usage.byProvider.confirmed"),
      align: "end",
      cell: (row) => {
        // A subscription is not $0.00 of usage: it is cost that arrived
        // as a flat fee, and printing zero would say the work was free.
        if (row.subscription) {
          return translate("installation.usage.subscriptionIncluded");
        }
        // A total that is zero has nothing to add up, and a provider whose
        // confirmed cost is zero has no receipt: both are a dash.
        const figure = moneyOrDash(row.knownCostUsd);
        return figure === null ? "\u2014" : money(figure);
      },
    },
    {
      id: "unverified",
      header: translate("installation.usage.byProvider.unverified"),
      align: "end",
      cell: (row) => row.subscription ? "\u2014" : money(row.unverifiedCostUsd),
    },
    {
      id: "unknown",
      header: translate("installation.usage.byProvider.unknown"),
      align: "end",
      // Nothing unknown is "None": a bare 0 beside "1 record" reads as a count of something else.
      cell: (row) =>
        row.unknownCount === 0
          ? translate("installation.usage.none")
          : records(row.unknownCount),
    },
  ];
  if (phone) {
    return (
      <StackedRecords
        caption={translate("installation.usage.byProvider.caption")}
        columns={columns}
        getRowKey={(row) => row.key}
        rows={rows}
      />
    );
  }
  return (
    <UI.DataTable<ProviderRow>
      caption={translate("installation.usage.byProvider.caption")}
      captionHidden
      columns={columns}
      getRowAttributes={(row) =>
        row.key === "total"
          ? { "data-total": "true" }
          : ({} as Record<`data-${string}`, string>)}
      getRowKey={(row) => row.key}
      rows={rows}
    />
  );
}

/** Budgets, with the scope the account covers spelled out. */
function UsageBudgetTable(
  { accounts }: { readonly accounts: UsageSummary["budgetAccounts"] },
) {
  const { translate } = useI18n();
  const money = useMoney();
  const phone = useShellViewport() === "phone";
  const columns: UI.DataTableColumn<BudgetRow>[] = [
    {
      id: "budget",
      header: translate("installation.usage.budgets.budget"),
      cell: (row) =>
        translate(
          row.scopeLabel === "run"
            ? "installation.usage.budgets.scope.run"
            : "installation.usage.budgets.scope.installation",
        ),
    },
    {
      id: "limit",
      header: translate("installation.usage.budgets.limit"),
      align: "end",
      cell: (row) => money(row.limitUsd),
    },
    {
      id: "used",
      header: translate("installation.usage.budgets.used"),
      align: "end",
      cell: (row) => money(row.settledUsd),
    },
    {
      id: "reserved",
      header: (
        <UI.Inline gap="compact">
          <span>{translate("installation.usage.budgets.reserved")}</span>
          <UI.HelpTip
            label={translate("installation.usage.budgets.reserved")}
          >
            {translate("installation.usage.budgets.reservedHelp")}
          </UI.HelpTip>
        </UI.Inline>
      ),
      align: "end",
      cell: (row) => money(row.reservedUsd),
    },
  ];
  const rows = budgetRows(accounts);
  if (phone) {
    return (
      <StackedRecords
        caption={translate("installation.usage.budgets.caption")}
        columns={columns}
        getRowKey={(row) => row.key}
        labels={{ reserved: translate("installation.usage.budgets.reserved") }}
        rows={rows}
      />
    );
  }
  return (
    <UI.DataTable<BudgetRow>
      caption={translate("installation.usage.budgets.caption")}
      captionHidden
      columns={columns}
      getRowKey={(row) => row.key}
      rows={rows}
    />
  );
}

/**
 * Rows as a phone shows them: no table to split words, each record a stacked
 * row with its first column as the title and every other value labelled.
 */
function StackedRecords<Row>(
  { caption, columns, getRowKey, labels = {}, rows }: {
    readonly caption: string;
    readonly columns: readonly UI.DataTableColumn<Row>[];
    readonly getRowKey: (row: Row) => string;
    /** Plain-text names for columns whose header is more than text. */
    readonly labels?: Readonly<Record<string, string>>;
    readonly rows: readonly Row[];
  },
) {
  return (
    <UI.Stack aria-label={caption} gap="none" role="list">
      {rows.map((row) => (
        <div key={getRowKey(row)} role="listitem">
          <UI.StackedRow title={columns[0].cell(row)}>
            {columns.slice(1).map((column) => (
              <UI.Text key={column.id} variant="caption">
                {labels[column.id] ??
                  (typeof column.header === "string"
                    ? column.header
                    : column.id)}: {column.cell(row)}
              </UI.Text>
            ))}
          </UI.StackedRow>
        </div>
      ))}
    </UI.Stack>
  );
}

/** Budget rows, with the scope the account covers spelled out. */
export function budgetRows(
  accounts: UsageSummary["budgetAccounts"],
): BudgetRow[] {
  return accounts.map((account) => ({
    key: `${account.scope}:${account.runId ?? ""}:${account.periodStart}`,
    // The server names a scope; a person reads which budget it is. A run
    // account is about one run, and saying "run" alone would leave them
    // guessing which.
    scopeLabel: account.runId === null ? account.scope : "run",
    limitUsd: account.limitUsd,
    settledUsd: account.settledUsd,
    reservedUsd: account.reservedUsd,
  }));
}

export type BudgetRow = {
  readonly key: string;
  readonly scopeLabel: string;
  readonly limitUsd: string;
  readonly settledUsd: string;
  readonly reservedUsd: string;
};

/** Each period choice and the words for it. */
const PERIOD_MESSAGES = {
  last7: "installation.usage.period.last7",
  last30: "installation.usage.period.last30",
  thisMonth: "installation.usage.period.thisMonth",
  custom: "installation.usage.period.custom",
} as const;
