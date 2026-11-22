import { assert, assertEquals } from "@std/assert";
import {
  isUsagePeriod,
  USAGE_MAX_PERIOD_DAYS,
  usageWindow,
  usageWindowTooLong,
} from "../../apps/web/src/screens/usage/usage-window.ts";
import {
  addDecimalStrings,
  compareDecimalStrings,
  subtractDecimalStrings,
  usd,
} from "../../apps/web/src/screens/usage/usage-money.ts";
import {
  billingKey,
  confirmedFigure,
  providerName,
  providerRows,
  recordKey,
} from "../../apps/web/src/screens/usage/usage-display.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-19T12:00:00.000Z");

/** The page's wording for an amount under a cent, from the catalogue. */
const less = (smallest: string) => `Less than ${smallest}`;

Deno.test("a period is only a period when the server could have said it", () => {
  for (const period of ["last7", "last30", "thisMonth", "custom"]) {
    assert(isUsagePeriod(period), period);
  }
  // The address bar is user input: a query string is not a period, and
  // "custom" with no range is not a window either.
  assertEquals(isUsagePeriod("last60"), false);
  assertEquals(isUsagePeriod(""), false);
  assertEquals(isUsagePeriod(undefined), false);
  assertEquals(isUsagePeriod(7), false);
});

Deno.test("each period names a window that ends now", () => {
  for (const period of ["last7", "last30", "thisMonth"] as const) {
    const window = usageWindow(period, now);
    assertEquals(window.to.getTime(), now.getTime(), period);
    assert(window.from.getTime() < window.to.getTime(), period);
  }
  assertEquals(
    usageWindow("last7", now).to.getTime() -
      usageWindow("last7", now).from.getTime(),
    7 * DAY,
  );
  assertEquals(
    usageWindow("last30", now).to.getTime() -
      usageWindow("last30", now).from.getTime(),
    30 * DAY,
  );
});

Deno.test("this month starts on the first day, not thirty days back", () => {
  const window = usageWindow("thisMonth", now);
  assertEquals(window.from.getFullYear(), 2026);
  assertEquals(window.from.getMonth(), 10);
  assertEquals(window.from.getDate(), 1);
  assertEquals(window.from.getHours(), 0);
});

Deno.test("a custom period with no range is last 30 days, never unbounded", () => {
  const window = usageWindow("custom", now);
  assertEquals(window.to.getTime() - window.from.getTime(), 30 * DAY);
  const chosen = { from: new Date(now.getTime() - 3 * DAY), to: now };
  assertEquals(
    usageWindow("custom", now, chosen).from.getTime(),
    chosen.from.getTime(),
  );
});

Deno.test("a window at the limit passes and one day over does not", () => {
  const atLimit = {
    from: new Date(now.getTime() - USAGE_MAX_PERIOD_DAYS * DAY),
    to: now,
  };
  assertEquals(usageWindowTooLong(atLimit), false);
  const overLimit = {
    from: new Date(now.getTime() - (USAGE_MAX_PERIOD_DAYS + 1) * DAY),
    to: now,
  };
  assertEquals(usageWindowTooLong(overLimit), true);
  // A window that starts after it ends is not long; it is wrong, and the
  // server says so. Reporting it as "too long" would send the reader to trim
  // dates that are already short. The reversed range here is over the limit in
  // magnitude, so a comparison that ignored the sign would call it too long.
  assertEquals(
    usageWindowTooLong({ from: now, to: new Date(now.getTime() - DAY) }),
    false,
  );
  assertEquals(
    usageWindowTooLong({ from: now, to: new Date(now.getTime() - 400 * DAY) }),
    false,
  );
});

Deno.test("money adds exactly, not the way floats do", () => {
  // 0.1 + 0.2 is the smallest case that floats get wrong; a total that says
  // 0.30000000000000004 is a total nobody trusts.
  assertEquals(addDecimalStrings("0.1", "0.2"), "0.3");
  assertEquals(addDecimalStrings("1.005", "0.005"), "1.01");
  assertEquals(addDecimalStrings("0.000001", "0.000001"), "0.000002");
  assertEquals(addDecimalStrings("12.4", "0"), "12.4");
  assertEquals(addDecimalStrings("0", "0"), "0");
});

Deno.test("money keeps every digit the server sent", () => {
  assertEquals(
    addDecimalStrings("1234567.123456", "0.000001"),
    "1234567.123457",
  );
  assertEquals(addDecimalStrings("0.1", "0.9"), "1");
  // A sum that cancels keeps its sign rather than printing "-0".
  assertEquals(addDecimalStrings("5", "-5"), "0");
  assertEquals(addDecimalStrings("-1.5", "0.5"), "-1");
});

Deno.test("money is shown with its unit", () => {
  assertEquals(usd("12.40", less), "$12.40");
  // Two places always: "$41.5" beside "$500" makes a reader compare digits
  // that are not in the same column, and "$0" is not a figure anyone quotes.
  assertEquals(usd("0", less), "$0.00");
  assertEquals(usd("41.5", less), "$41.50");
  assertEquals(usd("500", less), "$500.00");
  assertEquals(usd("1000", less), "$1,000.00");
  assertEquals(usd("12.755", less), "$12.76");
  assertEquals(usd("12.754999", less), "$12.75");
  assertEquals(usd("0.999", less), "$1.00");
  assertEquals(usd("1234.5", less), "$1,234.50");
  // A cost that is not zero but is under a cent is not shown as free.
  assertEquals(usd("0.004", less), "Less than $0.01");
  assertEquals(usd("0.000001", less), "Less than $0.01");
  assertEquals(usd("0.005", less), "$0.01");
  assertEquals(usd("0.000000", less), "$0.00");
  // A tiny credit reads the same words as a tiny cost: the phrase states the
  // size, and a minus sign would turn it into its opposite.
  assertEquals(usd("-0.004", less), "Less than $0.01");
  assertEquals(usd("-0.005", less), "-$0.01");
  assertEquals(usd("-3.4", less), "-$3.40");
  assertEquals(usd("-0.000000", less), "$0.00");
});

Deno.test("a provider id is not a name, and an unknown id stays itself", () => {
  assertEquals(providerName("anthropic"), "Anthropic");
  assertEquals(providerName("openai"), "OpenAI");
  // A provider this page has no name for keeps its own id. A guessed company
  // name beside a real cost is worse than a lowercase one.
  assertEquals(providerName("acme-inference"), "acme-inference");
});

Deno.test("a billing route reads as words, and an unknown one as itself", () => {
  assertEquals(billingKey("api"), "installation.usage.billing.payPerUse");
  assertEquals(
    billingKey("subscription"),
    "installation.usage.billing.subscription",
  );
  // The page prints the route rather than calling it one of the five.
  assertEquals(billingKey("credits"), null);
});

Deno.test("a count of records is a phrase, not a number", () => {
  // The words come from the catalogue; this only picks which row of it, so a
  // language that inflects for one or many is not handed an English rule.
  assertEquals(recordKey(0), "installation.usage.records.other");
  assertEquals(recordKey(1), "installation.usage.records.one");
  assertEquals(recordKey(14), "installation.usage.records.other");
});

Deno.test("no receipt is a dash and a reason, never a zero", () => {
  const summary = (knownCostUsd: string) =>
    ({ knownCostUsd }) as Parameters<typeof confirmedFigure>[0];
  assertEquals(confirmedFigure(summary("0")), {
    value: "—",
    noReceipts: true,
  });
  assertEquals(confirmedFigure(summary("0.000000")), {
    value: "—",
    noReceipts: true,
  });
  assertEquals(confirmedFigure(summary("12.75")), {
    value: "12.75",
    noReceipts: false,
  });
  // Nothing has loaded: a dash, and no claim about receipts either way.
  assertEquals(confirmedFigure(null), { value: "—", noReceipts: false });
});

Deno.test("the provider table sums in the table, and the total is a row", () => {
  const rows = providerRows([
    {
      provider: "anthropic",
      billingType: "api",
      model: "a",
      knownCostUsd: "0.1",
      unverifiedCostUsd: "12.75",
      unknownCount: 0,
      unverifiedCount: 1,
    } as never,
    {
      provider: "anthropic",
      billingType: "api",
      model: "b",
      knownCostUsd: "0.2",
      unverifiedCostUsd: "0.005",
      unknownCount: 2,
      unverifiedCount: 2,
    } as never,
    {
      provider: "openai",
      billingType: "subscription",
      model: "c",
      knownCostUsd: "0",
      unverifiedCostUsd: "0",
      unknownCount: 1,
      unverifiedCount: 0,
    } as never,
  ]);
  // One row per provider and route, then the total.
  assertEquals(rows.length, 3);
  assertEquals(rows[0], {
    key: "anthropic:api",
    provider: "anthropic",
    billingType: "api",
    // 0.1 + 0.2 through floats would be 0.30000000000000004.
    knownCostUsd: "0.3",
    unverifiedCostUsd: "12.755",
    unknownCount: 2,
    subscription: false,
  });
  assertEquals(rows[1]?.subscription, true);
  const total = rows[2]!;
  assertEquals(total.key, "total");
  assertEquals(total.knownCostUsd, "0.3");
  assertEquals(total.unverifiedCostUsd, "12.755");
  assertEquals(total.unknownCount, 3);
  // The total adds the subscription route's zero in, rather than dropping it:
  // a route that reported nothing is still a route in the table.
  assertEquals(total.subscription, false);
});

Deno.test("subtracting money is exact: what is left of a limit, to the micro-dollar", () => {
  assertEquals(subtractDecimalStrings("20.00", "12.40"), "7.6");
  assertEquals(subtractDecimalStrings("1", "0.000001"), "0.999999");
  assertEquals(subtractDecimalStrings("0.004", "0.001"), "0.003");
  assertEquals(subtractDecimalStrings("0.5", "0.5"), "0");
  // Past the limit, what is left is negative, never a wrapped or absolute value.
  assertEquals(subtractDecimalStrings("1", "2"), "-1");
  assertEquals(subtractDecimalStrings("-1", "1"), "-2");
  assertEquals(subtractDecimalStrings("-1", "-2"), "1");
});

Deno.test("a negative zero and padding around a figure do not change the arithmetic", () => {
  assertEquals(subtractDecimalStrings("5", "-0"), "5");
  assertEquals(subtractDecimalStrings("-0", "0"), "0");
  assertEquals(subtractDecimalStrings("0", "-0"), "0");
  assertEquals(subtractDecimalStrings(" 5 ", " 2 "), "3");
  assertEquals(subtractDecimalStrings("5.10", "-2.40"), "7.5");
});

Deno.test("comparing money says less, equal or more without rounding", () => {
  assertEquals(compareDecimalStrings("12.40", "20.00"), -1);
  assertEquals(compareDecimalStrings("20", "12.4"), 1);
  assertEquals(compareDecimalStrings("1", "1.000000"), 0);
  assertEquals(compareDecimalStrings("0", "-0"), 0);
  // A sub-cent amount is still more than nothing: it is never rounded to zero.
  assertEquals(compareDecimalStrings("0.000001", "0"), 1);
  assertEquals(compareDecimalStrings("-0.000001", "0"), -1);
  assertEquals(compareDecimalStrings("-2", "-1"), -1);
});
