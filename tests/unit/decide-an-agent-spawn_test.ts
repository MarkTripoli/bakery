import { assertEquals, assertThrows } from "@std/assert";
import {
  decideSpawn,
  type SpawnFacts,
  SpawnRefusal,
  toMicroUsd,
} from "../../apps/server/src/modules/work/agent-spawn.ts";
import {
  DEFAULT_AGENT_SPAWN,
  readAgentSpawnConfig,
} from "../../packages/config/src/env.ts";

// #413: the spawn decision is pure so every boundary is a unit test. The order
// is part of the contract: permission, then depth, then count, then budget.

const ok: SpawnFacts = {
  holdsPower: true,
  parentDepth: 0,
  liveChildren: 0,
  requestedBudgetMicro: 1_000n,
  parentHeadroomMicro: 1_000n,
  limits: { maxDepth: 3, maxChildren: 5, maxSteers: 20 },
};

Deno.test("a spawn within every bound proceeds", () => {
  assertEquals(decideSpawn(ok), null);
});

Deno.test("permission refuses first, whatever else is breached", () => {
  assertEquals(
    decideSpawn({
      ...ok,
      holdsPower: false,
      parentDepth: 99,
      liveChildren: 99,
      requestedBudgetMicro: null,
    }),
    SpawnRefusal.RequiresGrant,
  );
});

Deno.test("depth: the deepest allowed child is accepted, one more is refused", () => {
  // A child sits one below its parent; the bound is the deepest it may be.
  assertEquals(decideSpawn({ ...ok, parentDepth: 2 }), null);
  assertEquals(
    decideSpawn({ ...ok, parentDepth: 3 }),
    SpawnRefusal.DepthExceeded,
  );
});

Deno.test("depth is checked before count and budget", () => {
  assertEquals(
    decideSpawn({
      ...ok,
      parentDepth: 3,
      liveChildren: 99,
      requestedBudgetMicro: null,
    }),
    SpawnRefusal.DepthExceeded,
  );
});

Deno.test("count: the last slot is accepted, the next is refused", () => {
  assertEquals(decideSpawn({ ...ok, liveChildren: 4 }), null);
  assertEquals(
    decideSpawn({ ...ok, liveChildren: 5 }),
    SpawnRefusal.CountExceeded,
  );
});

Deno.test("count is checked before budget", () => {
  assertEquals(
    decideSpawn({ ...ok, liveChildren: 5, requestedBudgetMicro: null }),
    SpawnRefusal.CountExceeded,
  );
});

Deno.test("budget: it must be named, and exactly the headroom fits", () => {
  assertEquals(
    decideSpawn({ ...ok, requestedBudgetMicro: null }),
    SpawnRefusal.BudgetRequired,
  );
  assertEquals(decideSpawn({ ...ok, requestedBudgetMicro: 1_000n }), null);
  assertEquals(
    decideSpawn({ ...ok, requestedBudgetMicro: 1_001n }),
    SpawnRefusal.BudgetExceeded,
  );
  // A parent with nothing left cannot fund even the smallest child.
  assertEquals(
    decideSpawn({ ...ok, parentHeadroomMicro: 0n, requestedBudgetMicro: 1n }),
    SpawnRefusal.BudgetExceeded,
  );
});

Deno.test("USD decimals convert to micro-USD exactly", () => {
  assertEquals(toMicroUsd("0"), 0n);
  assertEquals(toMicroUsd("1"), 1_000_000n);
  assertEquals(toMicroUsd("0.000001"), 1n);
  assertEquals(toMicroUsd("12.345678"), 12_345_678n);
  // A shorter fraction pads, it does not shift the value.
  assertEquals(toMicroUsd("0.5"), 500_000n);
});

Deno.test("the spawn bounds read from configuration, with defaults", () => {
  assertEquals(readAgentSpawnConfig({}), DEFAULT_AGENT_SPAWN);
  assertEquals(
    readAgentSpawnConfig({
      BAKERY_AGENT_SPAWN_MAX_DEPTH: "2",
      BAKERY_AGENT_SPAWN_MAX_CHILDREN: "7",
    }),
    { maxDepth: 2, maxChildren: 7, maxSteers: 20 },
  );
  for (const bad of ["0", "-1", "1.5", "abc", "101"]) {
    assertThrows(
      () => readAgentSpawnConfig({ BAKERY_AGENT_SPAWN_MAX_DEPTH: bad }),
      Error,
      "AGENT_SPAWN_POLICY_INVALID",
    );
  }
});
