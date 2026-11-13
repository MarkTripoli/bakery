import { assertEquals } from "@std/assert";
import {
  codingAgents,
  machineBadge,
  machineBadgeTone,
  machineMatchesFilter,
  machineReason,
  machineRowAction,
} from "../../apps/web/src/pages/machine-state.ts";

// #70 slice 1: a machine's row shows one badge, one sentence and one button,
// chosen from what the server reports in the design's order.

type Facts = Parameters<typeof machineBadge>[0];

const ready: Facts = {
  connectivity: "online",
  desiredMode: "accepting",
  failedCheckIds: [],
  readiness: "ready",
  readinessReason: null,
  status: "online",
};
const machine = (over: Partial<Facts> = {}): Facts => ({ ...ready, ...over });

Deno.test("each state of a machine has exactly one badge, in the design's order", () => {
  const cases: [string, Facts, string][] = [
    ["ready", machine(), "ready"],
    ["still checking", machine({ readiness: "checking" }), "checking"],
    ["no readiness reported", machine({ readiness: undefined }), "checking"],
    [
      "needs attention",
      machine({ readiness: "needs_attention" }),
      "needsAttention",
    ],
    ["paused", machine({ desiredMode: "paused", status: "offline" }), "paused"],
    [
      "draining",
      machine({ desiredMode: "draining", status: "draining" }),
      "finishing",
    ],
    ["stopped answering", machine({ connectivity: "stale" }), "notResponding"],
    ["unreachable", machine({ connectivity: "offline" }), "offline"],
    [
      "retired",
      machine({ desiredMode: "revoked", status: "revoked" }),
      "retired",
    ],
  ];
  for (const [name, facts, badge] of cases) {
    assertEquals(machineBadge(facts), badge, name);
  }
  // Each outranks the one after it, whatever else is true.
  const everything = machine({
    connectivity: "offline",
    desiredMode: "revoked",
    status: "revoked",
    readiness: "needs_attention",
  });
  assertEquals(machineBadge(everything), "retired");
  assertEquals(
    machineBadge({ ...everything, desiredMode: "paused", status: "offline" }),
    "offline",
  );
  assertEquals(
    machineBadge(machine({
      connectivity: "stale",
      desiredMode: "paused",
      readiness: "needs_attention",
    })),
    "notResponding",
  );
  assertEquals(
    machineBadge(machine({
      desiredMode: "paused",
      readiness: "needs_attention",
    })),
    "needsAttention",
  );
  assertEquals(
    machineBadge(machine({ desiredMode: "paused", readiness: "checking" })),
    "paused",
  );
  assertEquals(
    machineBadge(machine({ desiredMode: "draining", readiness: "checking" })),
    "finishing",
  );
});

Deno.test("a paused machine that is connected is Paused, not Offline", () => {
  assertEquals(
    machineBadge(machine({ desiredMode: "paused", status: "offline" })),
    "paused",
  );
  // A response without desiredMode is read from the status an update writes.
  assertEquals(
    machineBadge(machine({ desiredMode: undefined, status: "offline" })),
    "paused",
  );
  assertEquals(
    machineBadge(machine({ desiredMode: undefined, status: "draining" })),
    "finishing",
  );
  assertEquals(
    machineBadge(machine({ desiredMode: undefined, status: "revoked" })),
    "retired",
  );
  assertEquals(
    machineBadge(machine({ desiredMode: undefined, status: "online" })),
    "ready",
  );
});

Deno.test("only a ready machine is green, and a machine that cannot take work is never neutral about it", () => {
  assertEquals(machineBadgeTone("ready"), "success");
  assertEquals(machineBadgeTone("needsAttention"), "danger");
  assertEquals(machineBadgeTone("offline"), "danger");
  assertEquals(machineBadgeTone("notResponding"), "warning");
  for (const badge of ["retired", "paused", "finishing", "checking"] as const) {
    assertEquals(machineBadgeTone(badge), "neutral", badge);
  }
});

Deno.test("a machine that cannot take work says why in one sentence's worth of data", () => {
  assertEquals(machineReason(machine()), null);
  assertEquals(machineReason(machine({ readiness: "checking" })), null);
  assertEquals(
    machineReason(machine({ connectivity: "offline" })),
    { kind: "offline" },
  );
  assertEquals(
    machineReason(machine({ connectivity: "stale" })),
    { kind: "stale" },
  );
  assertEquals(
    machineReason(machine({ desiredMode: "paused" })),
    { kind: "paused" },
  );
  assertEquals(
    machineReason(machine({ desiredMode: "draining" })),
    { kind: "finishing" },
  );
  assertEquals(
    machineReason(machine({ desiredMode: "revoked", status: "revoked" })),
    { kind: "retired" },
  );
  assertEquals(
    machineReason(machine({
      readiness: "needs_attention",
      readinessReason: "check_failed",
      failedCheckIds: ["disk_threshold", "capability:git"],
    })),
    { kind: "checkFailed", count: 2 },
  );
  assertEquals(
    machineReason(
      machine({ readiness: "needs_attention", failedCheckIds: [] }),
    ),
    { kind: "needsAttention" },
  );
  assertEquals(
    machineReason(machine({
      readiness: "needs_attention",
      failedCheckIds: undefined,
    })),
    { kind: "needsAttention" },
  );
});

Deno.test("the row's button is Fix where the machine page has something to do, Open where it does not", () => {
  const fix = [
    machine({ readiness: "needs_attention" }),
    machine({ desiredMode: "paused" }),
    machine({ desiredMode: "draining" }),
  ];
  for (const facts of fix) assertEquals(machineRowAction(facts), "fix");
  const open = [
    machine(),
    machine({ readiness: "checking" }),
    machine({ connectivity: "stale" }),
    machine({ connectivity: "offline" }),
    machine({ desiredMode: "revoked", status: "revoked" }),
  ];
  for (const facts of open) assertEquals(machineRowAction(facts), "open");
});

Deno.test("only the coding agents a machine advertises are named, each once, in its order", () => {
  assertEquals(codingAgents(["claude", "codex"]), ["claude", "codex"]);
  assertEquals(codingAgents(["Codex", "model", "git", "PI", "codex"]), [
    "codex",
    "pi",
  ]);
  assertEquals(codingAgents(["claude-code", "claude"]), ["claude"]);
  assertEquals(codingAgents(["model", "git", "shell"]), []);
  for (
    const bad of [null, undefined, "claude", 3, { claude: true }, [1, null]]
  ) {
    assertEquals(codingAgents(bad as never), []);
  }
  assertEquals(codingAgents(["constructor", "__proto__", "toString"]), []);
});

Deno.test("the filter keeps what it names, and Needs attention also keeps a machine that has stopped answering", () => {
  const rows = {
    ready: machine(),
    attention: machine({ readiness: "needs_attention" }),
    stale: machine({ connectivity: "stale" }),
    offline: machine({ connectivity: "offline" }),
    paused: machine({ desiredMode: "paused" }),
  };
  const names = (filter: "all" | "needsAttention" | "offline") =>
    Object.entries(rows).filter(([, facts]) =>
      machineMatchesFilter(facts, filter)
    ).map(([name]) => name);
  assertEquals(names("all"), [
    "ready",
    "attention",
    "stale",
    "offline",
    "paused",
  ]);
  assertEquals(names("needsAttention"), ["attention", "stale"]);
  assertEquals(names("offline"), ["offline"]);
});
