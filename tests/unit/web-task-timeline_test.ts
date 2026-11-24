import { assertEquals } from "@std/assert";
import {
  stepTimelineEvents,
  stepTitle,
} from "../../apps/web/src/pages/task-timeline.ts";

// deno-lint-ignore no-explicit-any
const t = ((key: string) => key) as any;

const step = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    stepKey: "implement",
    status: "completed",
    createdAt: "2026-11-20T09:00:00.000Z",
    startedAt: "2026-11-20T09:01:00.000Z",
    finishedAt: "2026-11-20T09:02:00.000Z",
    error: null,
    ...over,
    // deno-lint-ignore no-explicit-any
  }) as any;

Deno.test("a step row keeps the record's time and shows a person's reading of it", () => {
  const [row] = stepTimelineEvents(
    [step("s1")],
    t,
    new Map(),
    (iso) => `read:${iso}`,
  );
  assertEquals(row.time, "2026-11-20T09:02:00.000Z");
  assertEquals(row.timeLabel, "read:2026-11-20T09:02:00.000Z");
});

Deno.test("without a formatter a row shows the record's own time", () => {
  const [row] = stepTimelineEvents([step("s1")], t);
  assertEquals(row.timeLabel, row.time);
});

Deno.test("the list holds the steps and nothing about the run itself", () => {
  // The run line says queued, completed, failed or blocked once; no step list
  // row repeats it, so a run with no steps has no rows at all.
  assertEquals(stepTimelineEvents([], t), []);
  assertEquals(
    stepTimelineEvents([step("s1"), step("s2", { status: "failed" })], t)
      .map((row) => [row.id, row.status]),
    [["s1", "complete"], ["s2", "failed"]],
  );
});

Deno.test("a step reads as its title, or as its key in words", () => {
  assertEquals(stepTitle(t, "implement"), "tasks.timeline.step.implement");
  assertEquals(stepTitle(t, "flow.hold"), "Flow hold");
  assertEquals(stepTitle(t, "design_signoff"), "Design signoff");
});
