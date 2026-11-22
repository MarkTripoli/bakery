import { assertEquals } from "@std/assert";
import { runTimelineEvents } from "../../apps/web/src/pages/task-timeline.ts";

const run = {
  id: "00000000-0000-4000-8000-000000000020",
  status: "running" as const,
  createdAt: "2026-11-20T09:00:00.000Z",
  updatedAt: "2026-11-20T09:05:00.000Z",
  finishedAt: null,
};
// deno-lint-ignore no-explicit-any
const t = ((key: string) => key) as any;

Deno.test("a timeline row keeps the record's time and shows a person's reading of it", () => {
  const [queued] = runTimelineEvents(
    run,
    [],
    t,
    { first: true, last: false },
    new Map(),
    (iso) => `read:${iso}`,
  );
  assertEquals(queued.time, "2026-11-20T09:00:00.000Z");
  assertEquals(queued.timeLabel, "read:2026-11-20T09:00:00.000Z");
});

Deno.test("without a formatter a row shows the record's own time", () => {
  const [queued] = runTimelineEvents(run, [], t, { first: true, last: false });
  assertEquals(queued.timeLabel, queued.time);
});
