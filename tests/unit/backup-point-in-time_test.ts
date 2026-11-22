import { assertEquals } from "@std/assert";
import {
  pointInTimeProjection,
  type StoredPointInTime,
} from "../../apps/server/src/modules/backups/point-in-time.ts";

const stored = (over: Partial<StoredPointInTime> = {}): StoredPointInTime => ({
  enabled: true,
  version: 2,
  updatedAt: "2026-11-21T10:00:00.000Z",
  earliestRestorableAt: "2026-11-20T03:00:00.000Z",
  latestRestorableAt: "2026-11-21T09:59:00.000Z",
  latestSegment: "000000010000000000000042",
  reportedAt: "2026-11-21T10:00:00.000Z",
  ...over,
});

Deno.test("before any save the switch reads off with no window", () => {
  assertEquals(pointInTimeProjection(null), {
    enabled: false,
    earliestRestorableAt: null,
    latestRestorableAt: null,
    reportedAt: null,
    updatedAt: null,
    version: 0,
  });
});

Deno.test("on, with both bounds reported, the window is shown", () => {
  const view = pointInTimeProjection(stored());
  assertEquals(view.earliestRestorableAt, "2026-11-20T03:00:00.000Z");
  assertEquals(view.latestRestorableAt, "2026-11-21T09:59:00.000Z");
});

Deno.test("off, or with a bound unknown, or inverted, there is no window: never a guess", () => {
  for (
    const over of [
      { enabled: false },
      { earliestRestorableAt: null },
      { latestRestorableAt: null },
      { latestRestorableAt: "2026-11-19T00:00:00.000Z" },
    ]
  ) {
    const view = pointInTimeProjection(stored(over));
    assertEquals(
      [view.earliestRestorableAt, view.latestRestorableAt],
      [null, null],
      JSON.stringify(over),
    );
  }
});
