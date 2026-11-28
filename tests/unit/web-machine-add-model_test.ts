import { assert, assertEquals } from "@std/assert";
import {
  addProblems,
  addProgress,
  clockText,
  commandInput,
  initialAddAnswers,
} from "../../apps/web/src/pages/machine-add.ts";

const ready = {
  connectivity: "online",
  desiredMode: "accepting",
  failedCheckIds: [],
  readiness: "ready",
  readinessReason: null,
  status: "online",
} as never;
const needsAttention = {
  ...(ready as object),
  readiness: "needs_attention",
} as never;
const checking = { ...(ready as object), readiness: "checking" } as never;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const open = { state: "pending", expiresAt: "2026-01-01T00:10:00Z" };
const used = { state: "consumed", expiresAt: "2026-01-01T00:10:00Z" };

Deno.test("a coding agent is the only thing the person must choose", () => {
  assertEquals(addProblems(initialAddAnswers), ["agentRequired"]);
  assertEquals(
    addProblems({ ...initialAddAnswers, agent: "claude", slots: "0" }),
    ["slotsInvalid"],
  );
  assertEquals(commandInput(initialAddAnswers), null);
  assertEquals(
    commandInput({ name: "", slots: "1", agent: "claude" })?.capabilities,
    ["git", "shell", "web", "model", "claude", "tool-gateway"],
  );
});

Deno.test("an empty name is left out, so the machine names itself", () => {
  const input = commandInput({ name: "  ", slots: "2", agent: "codex" });
  assertEquals(input, {
    capabilities: ["git", "shell", "web", "model", "codex"],
    slots: 2,
  });
  assertEquals(
    commandInput({ name: " build-box ", slots: "1", agent: "pi" })?.name,
    "build-box",
  );
});

Deno.test("the page waits, then says it is still waiting after two minutes", () => {
  assertEquals(
    addProgress({
      enrollment: open,
      worker: null,
      now: T0 + 60_000,
      waitingSince: T0,
    }),
    { kind: "waiting", stillWaiting: false },
  );
  assertEquals(
    addProgress({
      enrollment: open,
      worker: null,
      now: T0 + 120_000,
      waitingSince: T0,
    }),
    { kind: "waiting", stillWaiting: true },
  );
});

Deno.test("a used command is checking until the machine is ready or needs attention", () => {
  const at = { now: T0 + 1000, waitingSince: T0 };
  assertEquals(addProgress({ enrollment: used, worker: null, ...at }), {
    kind: "checking",
  });
  assertEquals(addProgress({ enrollment: used, worker: checking, ...at }), {
    kind: "checking",
  });
  assertEquals(addProgress({ enrollment: used, worker: ready, ...at }), {
    kind: "ready",
  });
  assertEquals(
    addProgress({ enrollment: used, worker: needsAttention, ...at }),
    { kind: "attention" },
  );
});

Deno.test("an unused command that ran out, or was canceled, says so", () => {
  assertEquals(
    addProgress({
      enrollment: open,
      worker: null,
      now: T0 + 11 * 60_000,
      waitingSince: T0,
    }),
    { kind: "expired" },
  );
  assertEquals(
    addProgress({
      enrollment: { state: "canceled", expiresAt: open.expiresAt },
      worker: null,
      now: T0,
      waitingSince: T0,
    }),
    { kind: "canceled" },
  );
});

Deno.test("the time left reads as minutes and seconds", () => {
  assertEquals(clockText("2026-01-01T00:10:00Z", T0), "10:00");
  assertEquals(clockText("2026-01-01T00:10:00Z", T0 + 545_000), "0:55");
  assertEquals(clockText("2026-01-01T00:10:00Z", T0 + 700_000), "0:00");
});

Deno.test("no add-a-machine string names a processor", async () => {
  const strings = JSON.parse(
    await Deno.readTextFile("packages/i18n/locales/en.json"),
  ) as Record<string, string>;
  const mine = Object.entries(strings).filter(([key]) =>
    key.startsWith("machines.add.")
  );
  assert(mine.length > 20);
  for (const [key, value] of mine) {
    assert(
      !/arm64|aarch64|x86|x64|amd64|intel|apple silicon/i.test(value),
      `${key} names a processor: ${value}`,
    );
  }
});
