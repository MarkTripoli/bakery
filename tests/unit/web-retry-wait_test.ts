import { assertEquals } from "@std/assert";
import { formatWait } from "../../apps/web/src/app/retry-wait.ts";

// #241. A rate-limited sign-in says when to try again: seconds under a
// minute, whole minutes (rounded up) from a minute on, in the person's locale.

Deno.test("a wait under a minute is said in seconds", () => {
  assertEquals(formatWait(45, "en"), "45 seconds");
  assertEquals(formatWait(1, "en"), "1 second");
});

Deno.test("a wait of a minute or more is said in whole minutes, rounded up", () => {
  assertEquals(formatWait(60, "en"), "1 minute");
  assertEquals(formatWait(61, "en"), "2 minutes");
  assertEquals(formatWait(180, "en"), "3 minutes");
});

Deno.test("a wait that is zero or fractional never reads as no wait", () => {
  assertEquals(formatWait(0, "en"), "1 second");
  assertEquals(formatWait(0.2, "en"), "1 second");
  assertEquals(formatWait(59.2, "en"), "1 minute");
});
