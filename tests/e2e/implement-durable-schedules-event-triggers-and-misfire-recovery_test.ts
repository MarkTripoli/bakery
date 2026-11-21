import { assert, assertEquals } from "@std/assert";
import {
  createRealInngestStack,
  type RealInngestStack,
} from "../fixtures/real-inngest-stack.ts";
import {
  automationPlan,
  runsOf,
  SCHEDULE_EVERY_MINUTE,
  startedWithRun,
  waitForFirings,
} from "../helpers/real-inngest-automation.ts";
import { delay } from "../helpers/real-inngest-workflow.ts";

// #36. Automations on the real Inngest stack: the real `automation.tick` cron
// admits one firing for a due schedule, the real promotion pass starts it once,
// the next occurrence while that run is active is skipped, and an event the
// consumer is sent twice makes one firing.

async function withStack(
  body: (stack: RealInngestStack) => Promise<void>,
): Promise<void> {
  const stack = createRealInngestStack({ jobCompletionTimeout: "20s" });
  try {
    await stack.start();
    await body(stack);
  } finally {
    await stack.cleanup();
  }
}

Deno.test("the real clock admits one firing for a due schedule, the promotion pass starts it once, and the next occurrence while its run is active is skipped", () =>
  withStack(async (stack) => {
    const seed = await stack.seedWorkflow(crypto.randomUUID(), {
      run: false,
      plan: automationPlan,
    });
    const automation = await stack.seedAutomation(seed, {
      trigger: SCHEDULE_EVERY_MINUTE,
      overlapPolicy: "skip",
    });
    // The cursor was due at seeding: the next tick admits it, and the next
    // promotion pass starts it.
    const started = await waitForFirings(
      stack,
      automation,
      "the due firing was not started",
      startedWithRun,
    );
    assertEquals(started[0].status, "started");
    assertEquals(started[0].pending, false);
    assertEquals(started[0].triggerEventId, null);
    assertEquals(runsOf(started).length, 1);
    // The next occurrence comes due while that run is active: skipped, no run.
    const next = await waitForFirings(
      stack,
      automation,
      "the next occurrence was not admitted",
      (firings) => firings.length >= 2,
    );
    assertEquals(next[1].status, "skipped");
    assertEquals(next[1].pending, false);
    assertEquals(next[1].skippedCount, 1);
    assertEquals(next[1].runId, null);
    assertEquals(runsOf(next).length, 1);
    // One firing per minute, each on its own instant.
    assertEquals(
      new Set(next.map((firing) => firing.scheduledAt)).size,
      next.length,
    );
  }));

Deno.test("an event sent to the consumer twice makes one firing and one run", () =>
  withStack(async (stack) => {
    const seed = await stack.seedWorkflow(crypto.randomUUID(), {
      run: false,
      plan: automationPlan,
    });
    const automation = await stack.seedAutomation(seed, {
      trigger: {
        type: "event",
        provider: "github",
        kind: "issues",
        action: "opened",
        filter: { number: 7 },
      },
    });
    const route = await stack.seedEventRoute(seed, {
      number: 7,
      action: "opened",
    });
    // The same delivery reaches the consumer twice (the outbox and the recovery
    // both send it).
    await stack.sendIntakeEvent(route);
    await stack.sendIntakeEvent(route);
    const firings = await waitForFirings(
      stack,
      automation,
      "the event did not make a firing",
      (found) => found.length >= 1,
    );
    assertEquals(firings.length, 1);
    assertEquals(firings[0].triggerEventId, route.inboundEventId);
    // The route is settled once; the second event found it done.
    let settled = await stack.readEventRoute(route);
    for (
      let attempt = 0;
      attempt < 120 && settled.status !== "completed";
      attempt++
    ) {
      await delay(500);
      settled = await stack.readEventRoute(route);
    }
    assertEquals(
      [settled.status, settled.outcomeCode, settled.attempts],
      ["completed", "automation_fired", 1],
    );
    // The promotion pass starts it once.
    const started = await waitForFirings(
      stack,
      automation,
      "the event firing was not started",
      startedWithRun,
    );
    assertEquals(started.length, 1);
    assertEquals(runsOf(started).length, 1);
    // A third delivery after the run started changes nothing.
    await stack.sendIntakeEvent(route);
    await delay(10_000);
    const after = await stack.readAutomationFirings(automation);
    assertEquals(after.length, 1);
    assertEquals((await stack.readEventRoute(route)).attempts, 1);
    assert(runsOf(after).length === 1);
  }));
