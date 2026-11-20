import { assertEquals } from "@std/assert";
import {
  formatDay,
  parseDay,
} from "../../apps/web/src/screens/delivery/delivery-window.ts";

Deno.test("a date that exists is read as the start of that day", () => {
  const parsed = parseDay("2026-02-28");
  assertEquals(parsed === null ? null : formatDay(parsed), "2026-02-28");
  const leap = parseDay("2028-02-29");
  assertEquals(leap === null ? null : formatDay(leap), "2028-02-29");
});

Deno.test("a date that does not exist is refused, not rolled into the next month", () => {
  assertEquals(parseDay("2026-02-31"), null);
  assertEquals(parseDay("2026-02-29"), null);
  assertEquals(parseDay("2026-13-01"), null);
  assertEquals(parseDay("2026-04-31"), null);
  assertEquals(parseDay("not a date"), null);
  assertEquals(parseDay(undefined), null);
});
