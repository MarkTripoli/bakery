import { assertEquals } from "@std/assert";
import {
  laneBudgetMs,
  MINUTE,
  SLOW_HOST_FACTOR,
} from "../../apps/web/tests/helpers/lane-budget.ts";

// #559: a browser test's whole-test budget is written for a fast host and
// scaled for the slow CI hosts in one place, so no spec holds a bare number.

Deno.test("a budget is unchanged outside CI", () => {
  assertEquals(laneBudgetMs(90_000, {}), 90_000);
  assertEquals(laneBudgetMs(3 * MINUTE, {}), 180_000);
});

Deno.test("a budget is scaled by the slowest measured host in CI", () => {
  assertEquals(SLOW_HOST_FACTOR, 2.1);
  assertEquals(laneBudgetMs(100_000, { CI: "true" }), 210_000);
  // Rounded up, never down to a budget shorter than the scaled one.
  assertEquals(laneBudgetMs(45_001, { CI: "true" }), 94_503);
});

Deno.test("BAKERY_TEST_TIME_SCALE overrides the scale, and a bad value is ignored", () => {
  assertEquals(
    laneBudgetMs(60_000, { CI: "true", BAKERY_TEST_TIME_SCALE: "3" }),
    180_000,
  );
  assertEquals(laneBudgetMs(60_000, { BAKERY_TEST_TIME_SCALE: "0.5" }), 30_000);
  for (const bad of ["", "abc", "0", "-2", "NaN"]) {
    assertEquals(
      laneBudgetMs(60_000, { CI: "true", BAKERY_TEST_TIME_SCALE: bad }),
      126_000,
      `BAKERY_TEST_TIME_SCALE=${JSON.stringify(bad)}`,
    );
  }
});
