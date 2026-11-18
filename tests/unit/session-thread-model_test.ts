import { assertEquals } from "@std/assert";
import {
  backoffDelay,
  buildSessionThread,
  createFeedWindow,
  formatUsage,
  MAX_STEP_LINES,
  opensByDefault,
  pickSession,
  relativeTime,
  type SessionFeedItem,
  splitPath,
  summarizeNow,
} from "../../apps/web/src/pages/session-thread-model.ts";

// #405: the grouping rules of the agent thread, as plain functions.

function item(
  sequence: number,
  kind: SessionFeedItem["kind"],
  patch: Partial<SessionFeedItem> = {},
): SessionFeedItem {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: "11111111-1111-4111-8111-111111111111",
    sequence: String(sequence),
    kind,
    occurredAt: `2026-11-18T10:${String(sequence).padStart(2, "0")}:00.000Z`,
    redacted: false,
    message: null,
    terminal: null,
    status: null,
    tool: null,
    fileChange: null,
    artifact: null,
    usage: null,
    deliveredInput: null,
    ...patch,
  };
}

const said = (
  sequence: number,
  authorKind: "person" | "agent" | "system",
  body = "hello",
) =>
  item(sequence, "message", {
    message: {
      messageId: `2222222${sequence}-2222-4222-8222-222222222222`,
      authorId: null,
      authorKind,
      messageType: "assistant",
      body,
    },
  });
const tool = (
  sequence: number,
  callId: string,
  phase: "started" | "completed" | "failed",
) =>
  item(sequence, "tool", {
    tool: { callId, name: "run_tests", phase, ok: phase === "completed" },
  });
const out = (sequence: number, stream: "stdout" | "stderr", text: string) =>
  item(sequence, "terminal", { terminal: { stream, text } });
const file = (sequence: number, path: string) =>
  item(sequence, "file_change", { fileChange: { path, change: "modified" } });
const status = (
  sequence: number,
  toStatus:
    | "starting"
    | "active"
    | "waiting"
    | "finished"
    | "failed"
    | "interrupted",
  reason: string | null = null,
) =>
  item(sequence, "status", {
    status: { fromStatus: null, toStatus, reason },
  });

Deno.test("a turn starts at every message and owns the work after it", () => {
  const { turns } = buildSessionThread([
    said(1, "person"),
    said(2, "agent"),
    file(3, "a.ts"),
    tool(4, "c1", "completed"),
    said(5, "agent"),
    file(6, "b.ts"),
  ]);
  assertEquals(turns.length, 3);
  assertEquals(turns.map((turn) => turn.steps.length), [0, 2, 1]);
  assertEquals(turns[1].counts, { steps: 2, files: 1, failed: 0 });
});

Deno.test("work before the first message keeps a turn with no message", () => {
  const { turns } = buildSessionThread([
    tool(1, "c1", "completed"),
    said(2, "agent"),
  ]);
  assertEquals(turns.length, 2);
  assertEquals(turns[0].message, null);
  assertEquals(turns[0].steps.length, 1);
});

Deno.test("a delivery receipt annotates the person message and is not a row", () => {
  const { turns } = buildSessionThread([
    said(1, "person"),
    item(2, "delivered_input", {
      deliveredInput: { messageId: "m", body: "hello" },
    }),
    said(3, "agent"),
  ]);
  assertEquals(turns.length, 2);
  assertEquals(turns[0].receipt, true);
  assertEquals(turns[0].steps.length, 0);
  assertEquals(turns[1].receipt, false);
});

Deno.test("a tool's started and finished events are one line with the latest phase", () => {
  const { turns } = buildSessionThread([
    said(1, "agent"),
    tool(2, "c1", "started"),
    file(3, "a.ts"),
    tool(4, "c1", "failed"),
    tool(5, "c2", "started"),
  ]);
  const steps = turns[0].steps;
  assertEquals(steps.map((step) => step.kind), ["tool", "file", "tool"]);
  assertEquals((steps[0] as { phase: string }).phase, "failed");
  assertEquals((steps[2] as { phase: string }).phase, "started");
  assertEquals(turns[0].counts.failed, 1);
});

Deno.test("consecutive terminal items are one block, and stderr marks it", () => {
  const { turns } = buildSessionThread([
    said(1, "agent"),
    out(2, "stdout", "one\ntwo"),
    out(3, "stderr", "three"),
    file(4, "a.ts"),
    out(5, "stdout", "four"),
  ]);
  const steps = turns[0].steps;
  assertEquals(steps.map((step) => step.kind), ["output", "file", "output"]);
  const first = steps[0] as { lines: number; errors: boolean; text: string };
  assertEquals(first.lines, 3);
  assertEquals(first.errors, true);
  assertEquals(first.text, "one\ntwo\nthree");
  assertEquals((steps[2] as { errors: boolean }).errors, false);
});

Deno.test("usage is a total for the turn, not a step", () => {
  const { turns } = buildSessionThread([
    said(1, "agent"),
    item(2, "usage", {
      usage: { inputTokens: "1000", outputTokens: "500", costUsd: "0.002" },
    }),
    item(3, "usage", {
      usage: { inputTokens: "240", outputTokens: "360", costUsd: "0.0022" },
    }),
  ]);
  assertEquals(turns[0].steps.length, 0);
  assertEquals(turns[0].usage?.inputTokens, 1240);
  assertEquals(turns[0].usage?.outputTokens, 860);
  assertEquals(Math.round((turns[0].usage?.costUsd ?? 0) * 10000), 42);
});

Deno.test("finished, failed and interrupted end the session; others are lines", () => {
  const running = buildSessionThread([said(1, "agent"), status(2, "active")]);
  assertEquals(running.end, null);
  assertEquals(running.turns[0].steps.map((step) => step.kind), ["status"]);
  for (
    const [to, outcome] of [
      ["finished", "completed"],
      ["failed", "failed"],
      ["interrupted", "cancelled"],
    ] as const
  ) {
    const done = buildSessionThread([said(1, "agent"), status(2, to, "why")]);
    assertEquals(done.end?.outcome, outcome);
    assertEquals(done.end?.reason, "why");
    assertEquals(done.turns[0].steps.length, 0);
  }
});

Deno.test("a redacted item is a redacted line whatever it was", () => {
  const { turns } = buildSessionThread([
    said(1, "agent"),
    { ...file(2, "secret.ts"), redacted: true },
  ]);
  assertEquals(turns[0].steps.map((step) => step.kind), ["redacted"]);
});

Deno.test("work opens by default for the live turn and for any failure", () => {
  const { turns } = buildSessionThread([
    said(1, "agent"),
    file(2, "a.ts"),
    said(3, "agent"),
    tool(4, "c1", "failed"),
    said(5, "agent"),
    file(6, "b.ts"),
  ]);
  assertEquals(
    turns.map((turn, index) => opensByDefault(turn, index === 2, true)),
    [false, true, true],
  );
  assertEquals(opensByDefault(turns[2], true, false), false);
});

Deno.test("a path splits into a folder that may truncate and a name that never does", () => {
  assertEquals(splitPath("apps/server/retry.ts"), {
    folder: "apps/server/",
    name: "retry.ts",
  });
  assertEquals(splitPath("README.md"), { folder: "", name: "README.md" });
});

Deno.test("usage is formatted with the reader's number and currency rules", () => {
  const usage = { inputTokens: 1240, outputTokens: 860, costUsd: 0.0042 };
  assertEquals(formatUsage("en-US", usage), {
    inputTokens: "1,240",
    outputTokens: "860",
    cost: "$0.0042",
  });
  assertEquals(formatUsage("de-DE", usage).inputTokens, "1.240");
  assertEquals(MAX_STEP_LINES, 30);
});

Deno.test("a step's thread shows the newest live session, else the newest", () => {
  const old = {
    id: "a",
    status: "finished",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const newer = {
    id: "b",
    status: "finished",
    createdAt: "2026-01-02T00:00:00.000Z",
  };
  const live = {
    id: "c",
    status: "active",
    createdAt: "2026-01-01T12:00:00.000Z",
  };
  assertEquals(pickSession([old, newer])?.id, "b");
  assertEquals(pickSession([old, live, newer])?.id, "c");
  assertEquals(pickSession([]), null);
});

Deno.test("the now line follows the status, naming the running tool and the reason", () => {
  const running = buildSessionThread([
    said(1, "agent"),
    tool(2, "c1", "completed"),
    tool(3, "c2", "started"),
  ]);
  assertEquals(summarizeNow("starting", running), { kind: "waiting" });
  assertEquals(summarizeNow("active", running), {
    kind: "working",
    toolName: "run_tests",
    since: "2026-11-18T10:03:00.000Z",
  });
  assertEquals(summarizeNow("active", buildSessionThread([said(1, "agent")])), {
    kind: "working",
  });
  const failed = buildSessionThread([
    said(1, "agent"),
    status(2, "failed", "key expired"),
  ]);
  assertEquals(summarizeNow("failed", failed), {
    kind: "failed",
    reason: "key expired",
  });
  // Finished, interrupted and a status the client does not know say nothing.
  for (const unknown of ["finished", "interrupted", "waiting", "invented"]) {
    assertEquals(summarizeNow(unknown, running), { kind: "idle" });
  }
});

Deno.test("times are short, relative and carry the exact instant", () => {
  const now = new Date("2026-11-18T12:00:00.000Z");
  const fifteen = relativeTime("2026-11-18T11:45:00.000Z", "en-US", now);
  assertEquals(fifteen.exact, "2026-11-18T11:45:00.000Z");
  assertEquals(fifteen.label.includes("15"), true);
  assertEquals(relativeTime("not a time", "en-US", now).label, "not a time");
});

Deno.test("the feed window keeps order, replaces a repeat and says when it cut", () => {
  const at = (sequence: number, text = "a") =>
    ({
      ...said(sequence, "agent"),
      id: `item-${sequence}-${text}`,
    }) as SessionFeedItem;
  const window = createFeedWindow(3);
  for (const sequence of [1, 2, 3]) window.take(at(sequence));
  assertEquals(window.items().map((item) => item.sequence), ["1", "2", "3"]);
  assertEquals(window.truncated(), false);
  // A repeat replaces; it is not added a second time.
  window.take(at(3, "again"));
  assertEquals(window.items().length, 3);
  assertEquals(window.items().at(-1)?.id, "item-3-again");
  // Past the bound the oldest fall off and the window says so.
  window.take(at(4));
  assertEquals(window.items().map((item) => item.sequence), ["2", "3", "4"]);
  assertEquals(window.truncated(), true);
  assertEquals(window.newest(), "4");
  // A late item is sorted into place, and a number past 2^53 still orders.
  const late = createFeedWindow(10);
  for (const sequence of ["9007199254740993", "9007199254740992"]) {
    late.take(
      { ...said(1, "agent"), sequence, id: sequence } as SessionFeedItem,
    );
  }
  assertEquals(late.items().map((item) => item.sequence), [
    "9007199254740992",
    "9007199254740993",
  ]);
  assertEquals(late.newest(), "9007199254740993");
  assertEquals(createFeedWindow(3).newest(), undefined);
  // An event the window already dropped does not come back and push out a newer one.
  const replay = createFeedWindow(2);
  for (const sequence of [1, 2, 3]) replay.take(at(sequence));
  replay.take(at(1));
  assertEquals(replay.items().map((item) => item.sequence), ["2", "3"]);
  // A history cut short by the pages read marks the window partial by itself.
  const cut = createFeedWindow(5);
  cut.take(at(1));
  assertEquals(cut.truncated(), false);
  cut.markTruncated();
  assertEquals(cut.truncated(), true);
});

Deno.test("the reconnect wait doubles from one second and stops at fifteen", () => {
  assertEquals([0, 1, 2, 3, 4, 5, 6].map(backoffDelay), [
    1_000,
    2_000,
    4_000,
    8_000,
    15_000,
    15_000,
    15_000,
  ]);
});
