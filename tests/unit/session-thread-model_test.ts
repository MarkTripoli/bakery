import { assertEquals } from "@std/assert";
import {
  buildSessionThread,
  formatUsage,
  MAX_STEP_LINES,
  opensByDefault,
  type SessionFeedItem,
  splitPath,
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
