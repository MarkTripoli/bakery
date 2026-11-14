import { assertEquals } from "@std/assert";
import {
  bannerFix,
  checkInfo,
  controlMode,
  groupChecks,
  MACHINE_MODES,
  modeStatus,
  stopsWholeMachine,
} from "../../apps/web/src/pages/machine-page-state.ts";

// #70 part C1: the machine page's mode control, problem banner and checks.

Deno.test("the mode control writes the status the server calls it, and a retired machine has no mode", () => {
  assertEquals(MACHINE_MODES.map(modeStatus), [
    "online",
    "offline",
    "draining",
  ]);
  assertEquals(controlMode("accepting"), "accepting");
  assertEquals(controlMode("paused"), "paused");
  assertEquals(controlMode("draining"), "draining");
  assertEquals(controlMode("revoked"), null);
});

Deno.test("a problem banner offers the one fix that exists for it", () => {
  assertEquals(bannerFix({ kind: "paused" }), "takeWork");
  assertEquals(bannerFix({ kind: "finishing" }), "takeWork");
  assertEquals(bannerFix({ kind: "checkFailed", count: 2 }), "seeChecks");
  assertEquals(bannerFix({ kind: "retired" }), "setUpAgain");
  // These mend themselves, or have nothing to point at.
  assertEquals(bannerFix({ kind: "offline" }), null);
  assertEquals(bannerFix({ kind: "stale" }), null);
  assertEquals(bannerFix({ kind: "needsAttention" }), null);
});

Deno.test("the five whole-machine checks are named and explained, and stop the whole machine", () => {
  for (
    const id of [
      "protocol_compatible",
      "supervisor_health",
      "spool_access",
      "disk_threshold",
      "credential_isolation",
    ]
  ) {
    assertEquals(checkInfo(id), {
      group: "machine",
      nameKey: `machines.check.name.${id}`,
      fixKey: `machines.check.fix.${id}`,
      agent: null,
    });
    assertEquals(stopsWholeMachine(id), true, id);
  }
});

Deno.test("a capability check is about what the machine can do, and names its agent when the id does", () => {
  assertEquals(checkInfo("capability:model"), {
    group: "capability",
    nameKey: "machines.check.name.capability.model",
    fixKey: "machines.check.fix.capability.model",
    agent: null,
  });
  assertEquals(checkInfo("capability:model:codex").agent, "codex");
  assertEquals(
    checkInfo("capability:git").fixKey,
    "machines.check.fix.capability.git",
  );
  assertEquals(
    checkInfo("capability:reviewer").nameKey,
    "machines.check.name.capability.reviewer",
  );
  assertEquals(checkInfo("capability:model:somethingelse").agent, null);
  assertEquals(stopsWholeMachine("capability:model"), false);
});

Deno.test("an id nobody named is shown as it is with no advice made up for it", () => {
  for (
    const id of [
      "capability:docker",
      "disk_threshold_v2",
      "",
      "capability:",
      "__proto__",
    ]
  ) {
    assertEquals(checkInfo(id), {
      group: "other",
      nameKey: null,
      fixKey: null,
      agent: null,
    }, id);
  }
});

Deno.test("failed checks are grouped This machine, What it can do, then the rest, each in its own order", () => {
  assertEquals(
    groupChecks([
      "capability:model",
      "zzz_unknown",
      "disk_threshold",
      "capability:git",
      "protocol_compatible",
    ]),
    [
      { group: "machine", ids: ["disk_threshold", "protocol_compatible"] },
      { group: "capability", ids: ["capability:model", "capability:git"] },
      { group: "other", ids: ["zzz_unknown"] },
    ],
  );
  assertEquals(groupChecks([]), []);
  assertEquals(groupChecks(["capability:git"]), [
    { group: "capability", ids: ["capability:git"] },
  ]);
});
