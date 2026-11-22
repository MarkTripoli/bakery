import { assertEquals } from "@std/assert";
import {
  parseFreeformTimeout,
  renderFreeformAnswer,
  statusOfStop,
} from "../../apps/worker/src/harness-freeform.ts";

// #528: the pure parts of a freeform session. A bound that can be read as no
// bound at all is refused, and a stop is always reported under a registered
// status.

Deno.test("a timeout is read from ISO 8601 or the short form and nothing else", () => {
  assertEquals(parseFreeformTimeout("PT90S"), 90_000);
  assertEquals(parseFreeformTimeout("PT1H30M"), 5_400_000);
  assertEquals(parseFreeformTimeout("PT5M"), 300_000);
  assertEquals(parseFreeformTimeout("90s"), 90_000);
  assertEquals(parseFreeformTimeout("30m"), 1_800_000);
  assertEquals(parseFreeformTimeout("2h"), 7_200_000);
});

Deno.test("a timeout that is zero, empty, unbounded or unreadable is refused", () => {
  for (
    const text of [
      "",
      "PT",
      "P1D",
      "0s",
      "PT0S",
      "500ms",
      "3h",
      "PT2H1S",
      "30",
      "-5s",
      "30 minutes",
    ]
  ) assertEquals(parseFreeformTimeout(text), null, text);
  for (const value of [undefined, null, 30, {}]) {
    assertEquals(parseFreeformTimeout(value), null);
  }
});

Deno.test("each stop is reported under one of the registered statuses", () => {
  assertEquals(statusOfStop(undefined), "completed");
  assertEquals(statusOfStop("timeout"), "timed_out");
  assertEquals(statusOfStop("canceled"), "canceled");
  assertEquals(statusOfStop("max_turns"), "failed");
  assertEquals(statusOfStop("max_cost"), "failed");
});

const limits = { maxTurns: 3, maxCostUsd: 2, timeoutMs: 60_000 };

Deno.test("an answer that ended on its own is published as written", () => {
  const bytes = renderFreeformAnswer({
    answer: "The answer.",
    stop: undefined,
    turns: 2,
    limits,
  });
  assertEquals(new TextDecoder().decode(bytes), "The answer.");
});

Deno.test("a stopped session says which limit stopped it before the partial answer", () => {
  const text = new TextDecoder().decode(renderFreeformAnswer({
    answer: "Half an answer.",
    stop: "max_turns",
    turns: 4,
    limits,
  }));
  assertEquals(text.includes("limit of 3 turns after 4 turns"), true);
  assertEquals(text.endsWith("Half an answer."), true);
});

Deno.test("an answer over the size limit is cut and says so", () => {
  const text = new TextDecoder().decode(renderFreeformAnswer({
    answer: "x".repeat(300 * 1024),
    stop: undefined,
    turns: 1,
    limits,
  }));
  assertEquals(text.endsWith("The answer was cut at the size limit."), true);
  assertEquals(text.length < 300 * 1024, true);
});
