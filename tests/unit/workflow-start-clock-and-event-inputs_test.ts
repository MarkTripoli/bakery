import { assertEquals, assertFalse } from "@std/assert";
import { WorkflowStartsSchema } from "@bakery/contracts/workflow-starts";
import {
  latestDueTick,
  START_CLOCK_WINDOW_MS,
} from "../../apps/server/src/modules/workflows/start-clock.ts";
import { startRunInputs } from "../../apps/server/src/modules/workflows/start-firing.ts";

const hourly = {
  kind: "schedule" as const,
  cron: "0 * * * *",
  timezone: "UTC",
};

Deno.test("a schedule start is due at its latest tick inside the window", () => {
  assertEquals(
    latestDueTick(hourly, new Date("2026-11-25T10:02:30Z")),
    new Date("2026-11-25T10:00:00Z"),
  );
  assertEquals(
    latestDueTick(hourly, new Date("2026-11-25T10:00:00Z")),
    new Date("2026-11-25T10:00:00Z"),
  );
});

Deno.test("a tick older than the window is not due, so an outage never fires a backlog", () => {
  const late = new Date(
    new Date("2026-11-25T10:00:00Z").getTime() + START_CLOCK_WINDOW_MS + 1,
  );
  assertEquals(latestDueTick(hourly, late), null);
});

Deno.test("a schedule is read in its own zone", () => {
  const nineInBerlin = {
    kind: "schedule" as const,
    cron: "0 9 * * *",
    timezone: "Europe/Berlin",
  };
  assertEquals(
    latestDueTick(nineInBerlin, new Date("2026-11-25T08:01:00Z")),
    new Date("2026-11-25T08:00:00Z"),
  );
  assertEquals(
    latestDueTick(nineInBerlin, new Date("2026-11-25T09:01:00Z")),
    null,
  );
});

Deno.test("an event start takes the inputs it names from the event, over its static ones", () => {
  const [start] = WorkflowStartsSchema.parse([{
    id: "on-pr",
    inputs: { repositoryId: "static", instructions: "Fix it." },
    on: {
      kind: "event",
      eventKind: "change_request.opened",
      filter: {},
      inputsFromEvent: { repositoryId: "repositoryId" },
    },
  }]);
  assertEquals(startRunInputs(start, "repo-of-the-event"), {
    repositoryId: "repo-of-the-event",
    instructions: "Fix it.",
  });
});

Deno.test("a start without event inputs keeps its static inputs", () => {
  const [start] = WorkflowStartsSchema.parse([{
    id: "clock",
    inputs: { repositoryId: "static" },
    on: hourly,
  }]);
  assertEquals(startRunInputs(start, "ignored"), { repositoryId: "static" });
});

Deno.test("an event input names only a value the event supplies, and a schedule has none", () => {
  assertFalse(
    WorkflowStartsSchema.safeParse([{
      id: "on-pr",
      on: {
        kind: "event",
        eventKind: "change_request.opened",
        filter: {},
        inputsFromEvent: { repositoryId: "payload.anything" },
      },
    }]).success,
  );
  assertFalse(
    WorkflowStartsSchema.safeParse([{
      id: "clock",
      on: { ...hourly, inputsFromEvent: { repositoryId: "repositoryId" } },
    }]).success,
  );
});
