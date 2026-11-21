import { assert, assertEquals } from "@std/assert";
import { createRealInngestStack } from "../fixtures/real-inngest-stack.ts";
import {
  automationPlan,
  runsOf,
  SCHEDULE_EVERY_MINUTE,
  startedWithRun,
  waitForFirings,
} from "../helpers/real-inngest-automation.ts";

// #36. After downtime the real clock admits one bounded firing for what was
// missed, and counts the rest exactly: the engine is stopped, the schedule's
// cursor is five minutes behind, and the restarted engine's first tick makes one
// coalesced firing, never a backlog, which the promotion pass starts once.

Deno.test("after a stopped engine the next tick admits one coalesced firing with an exact count of what was missed", async () => {
  const stack = createRealInngestStack({ jobCompletionTimeout: "20s" });
  try {
    await stack.start();
    const seed = await stack.seedWorkflow(crypto.randomUUID(), {
      run: false,
      plan: automationPlan,
    });
    // Five whole minutes behind, on a minute boundary.
    const cursor = new Date(
      Math.floor((Date.now() - 5 * 60_000) / 60_000) * 60_000,
    );
    await stack.stopEngine();
    const automation = await stack.seedAutomation(seed, {
      trigger: SCHEDULE_EVERY_MINUTE,
      overlapPolicy: "skip",
      misfirePolicy: "coalesce",
      nextFireAt: cursor,
    });
    await stack.restartEngine();
    const admitted = await waitForFirings(
      stack,
      automation,
      "the missed occurrences were not admitted",
      (firings) => firings.length >= 1,
    );
    // One firing for the whole window, on the latest due occurrence: the others
    // are counted, exactly.
    const first = admitted[0];
    const due = (Date.parse(first.scheduledAt) - cursor.getTime()) / 60_000;
    assert(Number.isInteger(due) && due >= 4, `due=${due}`);
    assertEquals(first.skippedCount, due);
    assert(["queued", "started"].includes(first.status), first.status);
    // The promotion pass starts it once.
    const started = await waitForFirings(
      stack,
      automation,
      "the coalesced firing was not started",
      startedWithRun,
    );
    assertEquals(started[0].status, "started");
    assertEquals(started[0].skippedCount, due);
    assertEquals(runsOf(started).length, 1);
  } finally {
    await stack.cleanup();
  }
});
