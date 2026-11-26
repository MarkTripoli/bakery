import { assertEquals } from "@std/assert";
import {
  cronOf,
  nextRunDays,
  SCHEDULE_REPEATS,
  SCHEDULE_TIMES,
  simpleSchedule,
  timeZones,
} from "../../apps/web/src/pages/library/start-schedule.ts";
import { parseCron } from "../../apps/server/src/modules/workflows/automations/schedule.ts";

Deno.test("every repeat and time reads back and is a cron the server parses", () => {
  for (const repeat of SCHEDULE_REPEATS) {
    for (const time of SCHEDULE_TIMES) {
      const cron = cronOf({ repeat, time });
      parseCron(cron);
      assertEquals(simpleSchedule(cron), { repeat, time }, cron);
    }
  }
});

Deno.test("a cron that is not one of the repeats is left as written", () => {
  for (const cron of ["*/5 * * * *", "0 2 1 * *", "0 2 * 3 *", "61 2 * * *"]) {
    assertEquals(simpleSchedule(cron), null, cron);
  }
});

Deno.test("the next starts follow the zone's clock and skip today once passed", () => {
  const now = new Date("2026-11-27T10:30:00.000Z");
  const dates = (time: string, timezone: string) =>
    nextRunDays({ repeat: "weekdays", time }, timezone, now, 3).map((day) =>
      day.toISOString().slice(0, 10)
    );
  assertEquals(dates("09:00", "Europe/London"), [
    "2026-11-30",
    "2026-12-01",
    "2026-12-02",
  ]);
  assertEquals(dates("11:00", "Europe/London")[0], "2026-11-27");
  assertEquals(dates("09:00", "America/Los_Angeles")[0], "2026-11-27");
});

Deno.test("the zone already chosen stays in the list", () => {
  assertEquals(timeZones("Asia/Calcutta").includes("Asia/Calcutta"), true);
  assertEquals(timeZones("Europe/Berlin")[0], "UTC");
});
