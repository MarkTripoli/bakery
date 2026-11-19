import { assert, assertEquals } from "@std/assert";
import {
  isUsagePeriod,
  USAGE_MAX_PERIOD_DAYS,
  usageWindow,
  usageWindowTooLong,
} from "../../apps/web/src/screens/usage/usage-window.ts";
import {
  addDecimalStrings,
  usd,
} from "../../apps/web/src/screens/usage/usage-money.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-19T12:00:00.000Z");

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
  assertEquals(usd("12.40"), "$12.40");
  assertEquals(usd("0"), "$0");
});
