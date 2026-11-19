import { assertEquals } from "@std/assert";
import {
  currentRequest,
  noteView,
  pausedBanner,
  progressNext,
  progressReason,
  startedBy,
} from "../../apps/web/src/pages/issues/work-model.ts";

/**
 * #69 web: how the issue page reads the server's start request and the link's
 * note health. Each table row of the UX design is one case here.
 */

const ME = "0195f000-0000-7000-8000-00000000000a";
const OTHER = "0195f000-0000-7000-8000-00000000000b";

Deno.test("every progress value has the design's one next step", () => {
  assertEquals(progressNext("pending"), "none");
  assertEquals(progressNext("waiting"), "none");
  assertEquals(progressNext("suspended"), "none");
  assertEquals(progressNext("admitted"), "openTask");
  assertEquals(progressNext("active"), "openTask");
  assertEquals(progressNext("completed"), "openTask");
  assertEquals(progressNext("failed"), "openTask");
  assertEquals(progressNext("canceled"), "startWork");
  assertEquals(progressNext("rejected"), "startWork");
});

Deno.test("only waiting, paused and not-started lines quote the reason", () => {
  const code = "predecessor_open";
  for (const progress of ["waiting", "suspended", "rejected"] as const) {
    assertEquals(
      progressReason({ progress, dispositionReasonCode: code }),
      code,
    );
  }
  for (
    const progress of [
      "pending",
      "admitted",
      "active",
      "completed",
      "failed",
      "canceled",
    ] as const
  ) {
    assertEquals(
      progressReason({ progress, dispositionReasonCode: "run_failed" }),
      null,
    );
  }
});

Deno.test("who started the work: the viewer, a teammate, or a label", () => {
  const manual = {
    origin: "manual",
    requestedByPrincipalId: ME,
    triggerLabelName: null,
  } as const;
  assertEquals(startedBy(manual, ME), { kind: "you" });
  assertEquals(startedBy(manual, OTHER), { kind: "member" });
  assertEquals(startedBy(manual, null), { kind: "member" });
  assertEquals(startedBy({ ...manual, origin: "adoption" }, ME), {
    kind: "youAdopted",
  });
  assertEquals(startedBy({ ...manual, origin: "adoption" }, OTHER), {
    kind: "memberAdopted",
  });
  for (const origin of ["webhook", "poll"] as const) {
    assertEquals(
      startedBy({
        origin,
        requestedByPrincipalId: null,
        triggerLabelName: "bakery",
      }, ME),
      { kind: "label", label: "bakery" },
    );
  }
});

Deno.test("the note's state and the reason a failed one gives", () => {
  assertEquals(
    noteView({ syncHealth: "unknown", lastProblemCode: null }),
    { state: "unknown" },
  );
  assertEquals(
    noteView({ syncHealth: "pending", lastProblemCode: null }),
    { state: "pending" },
  );
  assertEquals(
    noteView({ syncHealth: "healthy", lastProblemCode: null }),
    { state: "healthy" },
  );
  assertEquals(
    noteView({ syncHealth: "healthy", lastProblemCode: "note_recreated" }),
    { state: "recreated" },
  );
  assertEquals(
    noteView({ syncHealth: "failed", lastProblemCode: "auth_forbidden" }),
    { state: "failed", reason: "permission" },
  );
  assertEquals(
    noteView({
      syncHealth: "failed",
      lastProblemCode: "dependency_unavailable",
    }),
    { state: "failed", reason: "unavailable" },
  );
  assertEquals(
    noteView({ syncHealth: "failed", lastProblemCode: "note_post_failed" }),
    { state: "failed", reason: "refused" },
  );
  assertEquals(
    noteView({ syncHealth: "failed", lastProblemCode: null }),
    { state: "failed", reason: "refused" },
  );
});

Deno.test("a paused request earns its banner, an unpaused one none", () => {
  const suspended = { progress: "suspended" } as const;
  assertEquals(
    pausedBanner({ ...suspended, pausedReason: "edited_after_setup" }),
    "editedAfterSetup",
  );
  assertEquals(
    pausedBanner({ ...suspended, pausedReason: "label_removed" }),
    "labelRemoved",
  );
  assertEquals(
    pausedBanner({ ...suspended, pausedReason: "hold_label_added" }),
    "onHold",
  );
  assertEquals(
    pausedBanner({ ...suspended, pausedReason: "dependency_unreadable" }),
    "dependencyUnreadable",
  );
  assertEquals(pausedBanner({ ...suspended, pausedReason: null }), null);
  // A request that resumed keeps its pause cause on record but is not paused.
  assertEquals(
    pausedBanner({ progress: "active", pausedReason: "label_removed" }),
    null,
  );
});

Deno.test("the page speaks about the newest request", () => {
  assertEquals(currentRequest([]), null);
  const newest = { id: "a" } as never;
  assertEquals(currentRequest([newest, { id: "b" } as never]), newest);
});
