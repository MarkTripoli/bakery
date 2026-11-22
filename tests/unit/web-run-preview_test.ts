import { assertEquals } from "@std/assert";
import {
  minutesLeft,
  newerHeadSha,
  previewCardState,
  sessionLength,
  shortSha,
} from "../../apps/web/src/app/run-preview.ts";
import type { RunPreviewResponse } from "../../apps/web/src/api/client.ts";

const base: RunPreviewResponse = {
  id: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  headSha: "a".repeat(40),
  status: "ready",
  stopReason: null,
  stoppedBy: null,
  stoppedByName: null,
  stoppedAt: null,
  expiresAt: "2026-11-20T12:00:00.000Z",
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  version: 1,
};
const at = "2026-11-20T11:00:00.000Z";

Deno.test("the card is absent without a preview and otherwise says exactly what the server read", () => {
  assertEquals(previewCardState(null, true), null);
  assertEquals(previewCardState(undefined, true), null);
  assertEquals(previewCardState(base, true), {
    kind: "running",
    expiresAt: base.expiresAt,
  });
  assertEquals(previewCardState({ ...base, status: "starting" }, true), {
    kind: "starting",
  });
  const stopped = (
    status: RunPreviewResponse["status"],
    stopReason: RunPreviewResponse["stopReason"],
    stoppedBy: string | null = null,
    stoppedByName: string | null = null,
  ) =>
    previewCardState({
      ...base,
      status,
      stopReason,
      stoppedBy,
      stoppedByName,
      stoppedAt: at,
    }, true);
  assertEquals(stopped("stopped", "person", "someone", "Dana Rivera"), {
    kind: "stopped",
    reason: "person",
    at,
    by: "someone",
    byName: "Dana Rivera",
  });
  // A person who can no longer be named is still a person's stop.
  assertEquals(stopped("stopped", "person", "gone"), {
    kind: "stopped",
    reason: "person",
    at,
    by: "gone",
    byName: null,
  });
  assertEquals(stopped("stopped", "run_cancelled"), {
    kind: "stopped",
    reason: "run_cancelled",
    at,
    by: null,
    byName: null,
  });
  assertEquals(stopped("stopped", "replaced"), {
    kind: "stopped",
    reason: "replaced",
    at,
    by: null,
    byName: null,
  });
  assertEquals(stopped("stopped", "machine_lost"), { kind: "lost", at });
  assertEquals(stopped("expired", "time_limit"), {
    kind: "ended",
    reason: "time_limit",
    at,
  });
  assertEquals(stopped("stopped", "run_ended"), {
    kind: "ended",
    reason: "run_ended",
    at,
  });
  // An expired preview with no reason is its time limit, never a person's stop.
  assertEquals(stopped("expired", null), {
    kind: "ended",
    reason: "time_limit",
    at,
  });
});

Deno.test("a deployment with no preview address shows Not set up, whatever the preview was", () => {
  assertEquals(previewCardState(base, false), { kind: "unavailable" });
  assertEquals(
    previewCardState(
      { ...base, status: "stopped", stopReason: "person" },
      false,
    ),
    { kind: "unavailable" },
  );
  // Unknown availability (still loading) does not hide a running preview.
  assertEquals(previewCardState(base, undefined)?.kind, "running");
});

Deno.test("time left, commit and session length are plain", () => {
  const now = new Date("2026-11-20T11:30:00.000Z");
  assertEquals(minutesLeft(base.expiresAt, now), 30);
  assertEquals(minutesLeft("2026-11-20T11:30:01.000Z", now), 1);
  assertEquals(minutesLeft("2026-11-20T11:00:00.000Z", now), 0);
  assertEquals(minutesLeft("not a time", now), 0);
  assertEquals(shortSha(base.headSha), "aaaaaaa");
  assertEquals(sessionLength(3600), { unit: "hour", count: 1 });
  assertEquals(sessionLength(7200), { unit: "hour", count: 2 });
  assertEquals(sessionLength(86_400), { unit: "hour", count: 24 });
  assertEquals(sessionLength(90), { unit: "minute", count: 2 });
  assertEquals(sessionLength(60), { unit: "minute", count: 1 });
});

Deno.test("an older commit is said only for a live preview and the change's open pull request at another commit", () => {
  const running = previewCardState(base, true);
  const head = "b".repeat(40);
  // The change moved on: the notice names the new head.
  assertEquals(
    newerHeadSha(running, base.headSha, { status: "open", headSha: head }),
    head,
  );
  // Same commit, whatever the letter case: nothing to say.
  assertEquals(
    newerHeadSha(running, base.headSha, {
      status: "open",
      headSha: base.headSha.toUpperCase(),
    }),
    null,
  );
  // No open pull request (none, merged or closed): no comparison, no notice.
  assertEquals(newerHeadSha(running, base.headSha, undefined), null);
  for (const status of ["merged", "closed"]) {
    assertEquals(
      newerHeadSha(running, base.headSha, { status, headSha: head }),
      null,
      status,
    );
  }
  // A preview that is not live never gets the notice: it already says why.
  for (
    const preview of [
      { ...base, status: "starting" as const },
      { ...base, status: "stopped" as const, stopReason: "person" as const },
      {
        ...base,
        status: "expired" as const,
        stopReason: "time_limit" as const,
      },
    ]
  ) {
    assertEquals(
      newerHeadSha(previewCardState(preview, true), base.headSha, {
        status: "open",
        headSha: head,
      }),
      null,
      preview.status,
    );
  }
  assertEquals(
    newerHeadSha(null, base.headSha, { status: "open", headSha: head }),
    null,
  );
  assertEquals(
    newerHeadSha(previewCardState(base, false), base.headSha, {
      status: "open",
      headSha: head,
    }),
    null,
  );
});
