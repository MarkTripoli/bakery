import { assertEquals } from "@std/assert";
import type {
  InstallationUpdateEvent,
  InstallationUpdateStatus,
} from "../../apps/web/src/api/client.ts";
import {
  failureNotice,
  joinPunctuation,
  policyLock,
  previousFact,
  runningFact,
  shortRelease,
  slot,
  splitSlots,
  updateRows,
} from "../../apps/web/src/screens/updates/update-history.ts";

const A = "aaaaaaaa11111111";
const B = "bbbbbbbb22222222";

function event(
  kind: InstallationUpdateEvent["kind"],
  fields: Partial<InstallationUpdateEvent> = {},
): InstallationUpdateEvent {
  return {
    id: crypto.randomUUID(),
    kind,
    at: "2026-11-21T02:14:00.000Z",
    by: null,
    fromRelease: null,
    toRelease: null,
    detail: null,
    dismissedAt: null,
    ...fields,
  };
}

const status = (
  fields: Partial<InstallationUpdateStatus> = {},
): InstallationUpdateStatus => ({
  runningRelease: A,
  runningSince: "2026-11-20T10:00:00.000Z",
  healthy: true,
  previousRelease: B,
  previousRanFrom: "2026-11-01T10:00:00.000Z",
  previousRanUntil: "2026-11-20T10:00:00.000Z",
  lastFailure: null,
  ...fields,
});

Deno.test("a release reads as its first 8 characters", () => {
  assertEquals(shortRelease(A), "aaaaaaaa");
});

Deno.test("each kind has its badge, tone, sentence and new version", () => {
  const rows = updateRows([
    event("installed", { toRelease: A }),
    event("updated", { fromRelease: B, toRelease: A }),
    event("rolled_back", { by: "ana", fromRelease: A, toRelease: B }),
    event("went_back", { fromRelease: A, toRelease: B }),
    event("refused", { toRelease: A, detail: "migration is one-way" }),
    event("decided_go_back", { by: "ana", fromRelease: A, toRelease: B }),
    event("decided_stay", { by: "ana", fromRelease: A, toRelease: B }),
    event("decided_stay", { fromRelease: A, toRelease: B }),
    event("interrupted", { fromRelease: A, toRelease: B }),
  ]);
  assertEquals(
    rows.map((row) => [row.result, row.tone, row.what, row.newRelease, row.by]),
    [
      [
        "installation.updates.result.installed",
        "neutral",
        "installation.updates.what.installed",
        A,
        "installation.updates.by.bakery",
      ],
      [
        "installation.updates.result.updated",
        "success",
        "installation.updates.what.updated",
        A,
        "installation.updates.by.bakery",
      ],
      [
        "installation.updates.result.rolledBack",
        "neutral",
        "installation.updates.what.rolledBack",
        null,
        "installation.updates.by.person",
      ],
      [
        "installation.updates.result.wentBack",
        "warning",
        "installation.updates.what.wentBack",
        A,
        "installation.updates.by.bakery",
      ],
      [
        "installation.updates.result.refused",
        "neutral",
        "installation.updates.what.refused",
        A,
        "installation.updates.by.bakery",
      ],
      [
        "installation.updates.result.decision",
        "information",
        "installation.updates.what.decidedGoBack",
        A,
        "installation.updates.by.person",
      ],
      [
        "installation.updates.result.decision",
        "information",
        "installation.updates.what.decidedStay",
        A,
        "installation.updates.by.person",
      ],
      [
        "installation.updates.result.decision",
        "information",
        "installation.updates.what.decidedStayNobody",
        A,
        "installation.updates.by.bakery",
      ],
      [
        "installation.updates.result.interrupted",
        "danger",
        "installation.updates.what.interrupted",
        A,
        "installation.updates.by.bakery",
      ],
    ],
  );
});

Deno.test("an update that a later choice stayed on reads as Not ready", () => {
  const rows = updateRows([
    event("decided_stay", { by: "ana", fromRelease: A, toRelease: B }),
    event("updated", { fromRelease: B, toRelease: A }),
  ]);
  assertEquals(rows[1]?.result, "installation.updates.result.notReady");
  assertEquals(rows[1]?.tone, "warning");
  // A stay on another release leaves the update as Updated.
  const other = updateRows([
    event("decided_stay", { by: "ana", fromRelease: B, toRelease: A }),
    event("updated", { fromRelease: B, toRelease: A }),
  ]);
  assertEquals(other[1]?.result, "installation.updates.result.updated");
});

Deno.test("each last failure has its notice; staying is the danger tone", () => {
  assertEquals(failureNotice(null), null);
  assertEquals(failureNotice(event("went_back")), {
    title: "installation.updates.notice.didNotGoThrough",
    body: "installation.updates.notice.wentBack",
    tone: "warning",
  });
  assertEquals(
    failureNotice(event("decided_go_back", { by: "ana" }))?.body,
    "installation.updates.notice.decidedGoBack",
  );
  assertEquals(failureNotice(event("decided_stay", { by: "ana" })), {
    title: "installation.updates.notice.stayed",
    body: "installation.updates.notice.decidedStay",
    tone: "error",
  });
  assertEquals(
    failureNotice(event("decided_stay"))?.body,
    "installation.updates.notice.decidedStayNobody",
  );
  assertEquals(failureNotice(event("interrupted")), {
    title: "installation.updates.notice.interrupted",
    body: "installation.updates.notice.interruptedBody",
    tone: "warning",
  });
  assertEquals(failureNotice(event("updated")), null);
});

Deno.test("facts leave out the dates the history does not have", () => {
  assertEquals(
    runningFact(status()).key,
    "installation.updates.facts.runningValue",
  );
  assertEquals(
    runningFact(status({ runningSince: null })).key,
    "installation.updates.facts.runningValueUndated",
  );
  assertEquals(
    previousFact(status()).key,
    "installation.updates.facts.previousValue",
  );
  assertEquals(
    previousFact(status({ previousRanFrom: null })).key,
    "installation.updates.facts.previousUntil",
  );
  assertEquals(
    previousFact(status({ previousRelease: null, previousRanUntil: null })).key,
    "installation.updates.facts.previousNone",
  );
});

Deno.test("the policy is locked while a restore holds Bakery or an update runs", () => {
  assertEquals(policyLock({}), null);
  assertEquals(policyLock({ restoreHeld: true, updatePaused: true }), "held");
  assertEquals(policyLock({ updatePaused: true }), "paused");
});

Deno.test("a sentence splits around its slots, in order", () => {
  assertEquals(
    splitSlots(`Updated from ${slot("from")} to ${slot("to")}.`),
    [
      { text: "Updated from " },
      { slot: "from" },
      { text: " to " },
      { slot: "to" },
      { text: "." },
    ],
  );
  assertEquals(splitSlots(slot("release")), [{ slot: "release" }]);
});

Deno.test("punctuation after a slot joins the slot; the text read is the same", () => {
  assertEquals(
    joinPunctuation(
      splitSlots(`went back to ${slot("to")}. Paused ${slot("by")}`),
    ),
    [
      { text: "went back to " },
      { slot: "to", after: "." },
      { text: " Paused " },
      { slot: "by", after: "" },
    ],
  );
  assertEquals(
    joinPunctuation(splitSlots(`(${slot("a")}),`)),
    [{ text: "(" }, { slot: "a", after: ")," }],
  );
});
