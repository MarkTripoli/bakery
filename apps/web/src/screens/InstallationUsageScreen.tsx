import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import type { UsageSummary } from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { addDecimalStrings, usd } from "./usage/usage-money.ts";
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
  readonly periodTooLong: boolean;
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
    periodTooLong,
    onPeriodChange,
    onProviderChange,
    onRetry,
    onShowLast30Days,
  }: InstallationUsageScreenProps,
) {
  const { translate, locale, timeZone } = useI18n();

  if (state === "notFound") {
    return (
      <UI.EmptyState
        description={translate("installation.usage.notFound.body")}
        inset="page"
        layout="centered"
        title={translate("installation.usage.notFound.title")}
        variant="filtered"
      />
    );
  }

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
    ...(summary?.byProvider ?? []).map((row) => ({
      id: row.provider,
      label: row.provider,
      selected: row.provider === provider,
    })),
  ];

  const completeness = summary?.completeness ?? "complete";
  const rows = summary?.byProvider ?? [];
  const budgets = summary?.budgetAccounts ?? [];

  return (
    <div className="bakery-page" data-page="installation-usage">
      <header className="bakery-page__header">
        <div>
          <h1 className="bakery-page__title">
            {translate("installation.usage.title")}
          </h1>
          <p className="bakery-page__subtitle">
            {translate("installation.usage.description")}
          </p>
        </div>
        <div className="bakery-page__actions">
          <UI.Menu
            aria-label={translate("installation.usage.period")}
            items={periodItems}
            onSelect={(id) => {
              if (isUsagePeriod(id)) onPeriodChange(id);
            }}
            variant="selection"
          />
          <UI.Menu
            aria-label={translate("installation.usage.provider")}
            items={providerItems}
            onSelect={(id) => onProviderChange(id === "all" ? null : id)}
            variant="selection"
          />
        </div>
      </header>

      {periodTooLong
        ? (
          <p className="bakery-page__note">
            {translate("installation.usage.period.tooLong")}
          </p>
        )
        : null}

      {
        /* The completeness notice is the screen's honesty statement: a partial
          total says which parts are missing, and an unknowable one says so
          rather than showing a clean figure. */
      }
      {completeness === "partial" && summary
        ? (
          <UI.AlertBanner tone="warning">
            <strong>{translate("installation.usage.partial.title")}</strong>
            {" "}
            {translate("installation.usage.partial.body", {
              unverified: summary.unverifiedCount,
              unknown: summary.unknownCount,
            })}
          </UI.AlertBanner>
        )
        : completeness === "unknown"
        ? (
          <UI.AlertBanner tone="information">
            <strong>{translate("installation.usage.unknown.title")}</strong>
            {" "}
            {translate("installation.usage.unknown.body")}
          </UI.AlertBanner>
        )
        : null}

      {state === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={onRetry}>
                {translate("installation.usage.retry")}
              </UI.Button>
            }
            description={translate("installation.usage.error")}
            title={translate("installation.usage.title")}
          />
        )
        : state === "empty"
        ? (
          <UI.EmptyState
            action={
              <UI.Button onClick={onShowLast30Days}>
                {translate("installation.usage.empty.action")}
              </UI.Button>
            }
            description={translate("installation.usage.empty.body", {
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
            })}
            title={translate("installation.usage.empty.title")}
            variant="filtered"
          />
        )
        : (
          <>
            <div className="bakery-usage-figures" data-testid="usage-figures">
              <UI.StatTile
                detail={translate("installation.usage.confirmed.detail")}
                label={translate("installation.usage.confirmed.label")}
                value={summary ? usd(summary.knownCostUsd) : "—"}
              />
              <UI.StatTile
                detail={translate("installation.usage.unverified.detail", {
                  count: summary?.unverifiedCount ?? 0,
                })}
                label={translate("installation.usage.unverified.label")}
                value={summary ? usd(summary.unverifiedCostUsd) : "—"}
              />
              <UI.StatTile
                detail={translate("installation.usage.unknownCount.detail")}
                label={translate("installation.usage.unknownCount.label")}
                value={summary ? String(summary.unknownCount) : "—"}
              />
            </div>

            <UI.DataTable<UsageProviderRow>
              caption={translate("installation.usage.byProvider.caption")}
              columns={[
                {
                  id: "provider",
                  header: translate("installation.usage.byProvider.provider"),
                  cell: (row) => (
                    <UI.Stack gap="none">
                      <span>{row.provider}</span>
                      <UI.Text variant="muted">
                        {BILLING_MESSAGES[row.billingType] === undefined
                          ? row.billingType
                          : translate(BILLING_MESSAGES[row.billingType])}
                      </UI.Text>
                    </UI.Stack>
                  ),
                },
                {
                  id: "confirmed",
                  header: translate("installation.usage.byProvider.confirmed"),
                  align: "end",
                  cell: (row) =>
                    row.subscription
                      // A subscription is not $0.00 of usage: it is cost that
                      // arrived as a flat fee, and printing zero would say the
                      // work was free.
                      ? translate("installation.usage.subscriptionIncluded")
                      : usd(row.knownCostUsd),
                },
                {
                  id: "unverified",
                  header: translate("installation.usage.byProvider.unverified"),
                  align: "end",
                  cell: (row) =>
                    row.subscription ? "—" : usd(row.unverifiedCostUsd),
                },
                {
                  id: "unknown",
                  header: translate("installation.usage.byProvider.unknown"),
                  align: "end",
                  cell: (row) => String(row.unknownCount),
                },
              ]}
              emptyMessage={translate("installation.usage.empty.title")}
              getRowKey={(row) =>
                `${row.provider}:${row.billingType}:${row.model}`}
              rows={providerRows(rows)}
              state={state === "loading" ? "loading" : "ready"}
            />

            {budgets.length > 0
              ? (
                <UI.DataTable<UsageBudgetRow>
                  caption={translate("installation.usage.budgets.caption")}
                  columns={[
                    {
                      id: "budget",
                      header: translate("installation.usage.budgets.budget"),
                      cell: (row) => row.scopeLabel,
                    },
                    {
                      id: "limit",
                      header: translate("installation.usage.budgets.limit"),
                      align: "end",
                      cell: (row) => usd(row.limitUsd),
                    },
                    {
                      id: "used",
                      header: translate("installation.usage.budgets.used"),
                      align: "end",
                      cell: (row) => usd(row.settledUsd),
                    },
                    {
                      id: "reserved",
                      header: (
                        <UI.Stack gap="none">
                          <span>
                            {translate("installation.usage.budgets.reserved")}
                          </span>
                          <UI.HelpTip
                            label={translate(
                              "installation.usage.budgets.reserved",
                            )}
                          >
                            {translate(
                              "installation.usage.budgets.reservedHelp",
                            )}
                          </UI.HelpTip>
                        </UI.Stack>
                      ),
                      align: "end",
                      cell: (row) => usd(row.reservedUsd),
                    },
                  ]}
                  getRowKey={(row) => row.key}
                  rows={budgetRows(budgets)}
                />
              )
              : null}
          </>
        )}
    </div>
  );
}

/** One table row per provider and billing route, with the sum of its models. */
function providerRows(
  rows: UsageSummary["byProvider"],
): UsageProviderRow[] {
  const grouped = new Map<string, UsageProviderRow>();
  for (const row of rows) {
    const key = `${row.provider}:${row.billingType}`;
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, {
        provider: row.provider,
        billingType: row.billingType,
        model: row.model,
        knownCostUsd: row.knownCostUsd,
        unverifiedCostUsd: row.unverifiedCostUsd,
        unknownCount: row.unknownCount,
        subscription: row.billingType === "subscription",
      });
      continue;
    }
    grouped.set(key, {
      ...current,
      // Sums are decimal strings in micro-units of a dollar; adding them as
      // floats would turn a total into a number no receipt ever stated.
      knownCostUsd: addDecimalStrings(current.knownCostUsd, row.knownCostUsd),
      unverifiedCostUsd: addDecimalStrings(
        current.unverifiedCostUsd,
        row.unverifiedCostUsd,
      ),
      unknownCount: current.unknownCount + row.unknownCount,
    });
  }
  return [...grouped.values()];
}

/** Budget rows, with the scope the account covers spelled out. */
function budgetRows(
  accounts: UsageSummary["budgetAccounts"],
): UsageBudgetRow[] {
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

type UsageProviderRow = {
  readonly provider: string;
  readonly billingType: string;
  readonly model: string | null;
  readonly knownCostUsd: string;
  readonly unverifiedCostUsd: string;
  readonly unknownCount: number;
  readonly subscription: boolean;
};

type UsageBudgetRow = {
  readonly key: string;
  readonly scopeLabel: string;
  readonly limitUsd: string;
  readonly settledUsd: string;
  readonly reservedUsd: string;
};

/**
 * The four billing routes the summaries carry, each with the words for it.
 *
 * A record whose route is not one of these shows the route itself rather than
 * a guess at which of the four it might be: an unknown word in a table is
 * better than the wrong one.
 */
const BILLING_MESSAGES: Readonly<
  Record<
    string,
    | "installation.usage.billing.payPerUse"
    | "installation.usage.billing.subscription"
    | "installation.usage.billing.compute"
    | "installation.usage.billing.storage"
  >
> = {
  "pay-per-use": "installation.usage.billing.payPerUse",
  subscription: "installation.usage.billing.subscription",
  compute: "installation.usage.billing.compute",
  storage: "installation.usage.billing.storage",
};

const PERIOD_MESSAGES = {
  last7: "installation.usage.period.last7",
  last30: "installation.usage.period.last30",
  thisMonth: "installation.usage.period.thisMonth",
  custom: "installation.usage.period.custom",
} as const;
