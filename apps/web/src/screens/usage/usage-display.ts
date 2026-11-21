/**
 * How the usage page names things.
 *
 * Every function here is pure and takes the words it needs, so the rules can
 * be tested without a browser: a provider id is not a name, a billing route is
 * not a sentence, and a count of records is not the count of some other
 * population.
 */
import type { UsageSummary } from "../../api/client.ts";
import { addDecimalStrings } from "./usage-money.ts";

/** Providers whose name a reader recognises. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
  xai: "xAI",
};

/**
 * A provider as a person reads it.
 *
 * An unlisted provider keeps its own id rather than a guessed name: a wrong
 * company name in a cost table is worse than a lowercase one.
 */
export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
}

/** The catalogue keys for the billing routes the summaries carry. */
export type BillingKey =
  | "installation.usage.billing.payPerUse"
  | "installation.usage.billing.subscription"
  | "installation.usage.billing.compute"
  | "installation.usage.billing.storage";

/**
 * The billing routes, each with the catalogue key for it.
 *
 * `api` is the server's word for a metered call, which a reader knows as
 * "Pay per use"; printing the wire value would put a code in a sentence.
 */
const BILLING_KEYS: Readonly<Record<string, BillingKey>> = {
  api: "installation.usage.billing.payPerUse",
  "pay-per-use": "installation.usage.billing.payPerUse",
  subscription: "installation.usage.billing.subscription",
  compute: "installation.usage.billing.compute",
  storage: "installation.usage.billing.storage",
};

/**
 * The catalogue key for a billing route, or null when the route is one this
 * page has no word for - the caller prints the route itself rather than a
 * guess at which of the five it might be.
 */
export function billingKey(route: string): BillingKey | null {
  return BILLING_KEYS[route] ?? null;
}

/**
 * The catalogue key for a count of records.
 *
 * The words come from the catalogue, formatted with the count as an ICU
 * argument, so a language that inflects for one or many says so itself rather
 * than being handed an English plural rule.
 */
export function recordKey(
  count: number,
): "installation.usage.records.one" | "installation.usage.records.other" {
  return count === 1
    ? "installation.usage.records.one"
    : "installation.usage.records.other";
}

/**
 * A figure, or a dash when there is nothing to state.
 *
 * A confirmed cost of zero is not a cost that happened: it is an absence, and
 * "$0.00" in that cell reads as work done for free. The dash says the figure
 * is missing, which is the truth, and the row's other columns say why.
 */
export function moneyOrDash(value: string): string | null {
  return value.trim().replace(/[0.]/g, "") === "" ? null : value;
}

/**
 * The confirmed figure, or a dash and the reason there is none.
 *
 * A subscription-only installation, or one whose providers never sent a
 * receipt, has no confirmed cost - and "$0.00" would say the work was free.
 * The dash says the figure is absent, which is what it is.
 */
export function confirmedFigure(
  summary: UsageSummary | null,
): { readonly value: string; readonly noReceipts: boolean } {
  if (summary === null) return { value: "\u2014", noReceipts: false };
  const nothing = summary.knownCostUsd.trim().replace(/[0.]/g, "") === "";
  return nothing
    ? { value: "\u2014", noReceipts: true }
    : { value: summary.knownCostUsd, noReceipts: false };
}

/** One row's worth of provider figures, with the subscription route marked. */
export type ProviderRow = {
  readonly key: string;
  readonly provider: string;
  readonly billingType: string;
  readonly knownCostUsd: string;
  readonly unverifiedCostUsd: string;
  readonly unknownCount: number;
  readonly subscription: boolean;
};

/**
 * The table's rows with the total last.
 *
 * The total is a row rather than a footer so it scrolls and reads like the
 * figures it adds up; it is marked, so a reader can see which line is the sum
 * and so it can be styled without the table knowing about totals.
 */
export function providerRows(
  rows: UsageSummary["byProvider"],
): ProviderRow[] {
  const grouped = new Map<string, ProviderRow>();
  let known = "0";
  let unverified = "0";
  let unknown = 0;
  for (const row of rows) {
    const key = `${row.provider}:${row.billingType}`;
    const current = grouped.get(key);
    known = addDecimalStrings(known, row.knownCostUsd);
    unverified = addDecimalStrings(unverified, row.unverifiedCostUsd);
    unknown += row.unknownCount;
    const subscription = row.billingType === "subscription";
    if (current === undefined) {
      grouped.set(key, {
        key,
        provider: row.provider,
        billingType: row.billingType,
        knownCostUsd: row.knownCostUsd,
        unverifiedCostUsd: row.unverifiedCostUsd,
        unknownCount: row.unknownCount,
        subscription,
      });
      continue;
    }
    grouped.set(key, {
      ...current,
      // Sums are decimal strings; adding them as floats would turn a total
      // into a number no receipt ever stated.
      knownCostUsd: addDecimalStrings(current.knownCostUsd, row.knownCostUsd),
      unverifiedCostUsd: addDecimalStrings(
        current.unverifiedCostUsd,
        row.unverifiedCostUsd,
      ),
      unknownCount: current.unknownCount + row.unknownCount,
    });
  }
  // A total of no rows is not a total: with nothing to add up, the table
  // would draw a line of zeros and call it a sum.
  if (grouped.size === 0) return [];
  return [...grouped.values(), {
    key: "total",
    provider: "total",
    billingType: "",
    knownCostUsd: known,
    unverifiedCostUsd: unverified,
    unknownCount: unknown,
    subscription: false,
  }];
}
