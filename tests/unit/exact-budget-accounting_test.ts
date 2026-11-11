import { assertEquals, assertThrows } from "@std/assert";
import {
  formatMicroUsd,
  parseMicroUsd,
} from "../../apps/server/src/modules/work/budget.ts";
import { readBudgetRuntimeConfig } from "../../packages/config/src/env.ts";

Deno.test("budget arithmetic preserves six-decimal microUSD values", () => {
  assertEquals(parseMicroUsd("1.000001"), 1_000_001n);
  assertEquals(parseMicroUsd(0.000001), 1n);
  assertEquals(formatMicroUsd(99_999_999_999_999n), "99999999.999999");
  assertEquals(formatMicroUsd(1_000_001n), "1.000001");
});

Deno.test("budget arithmetic rejects non-canonical or over-precise amounts", () => {
  for (const value of ["-1", "1e-6", "01", "1.0000001"]) {
    assertThrows(() => parseMicroUsd(value));
  }
});

Deno.test("budget policy parsing fails closed on partial configuration", () => {
  assertEquals(readBudgetRuntimeConfig({}), undefined);
  assertEquals(
    readBudgetRuntimeConfig({
      BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD: "12.345678",
      BAKERY_BUDGET_RESERVATION_TTL_SECONDS: "60",
      BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS: "3600",
    }),
    {
      installationMonthlyLimitUsd: "12.345678",
      reservationTtlSeconds: 60,
      maxRunDurationSeconds: 3600,
    },
  );
  assertThrows(() =>
    readBudgetRuntimeConfig({
      BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD: "12",
    })
  );
  assertThrows(() =>
    readBudgetRuntimeConfig({
      BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD: "12.1234567",
      BAKERY_BUDGET_RESERVATION_TTL_SECONDS: "60",
      BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS: "3600",
    })
  );
});
