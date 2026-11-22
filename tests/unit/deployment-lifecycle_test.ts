import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  canMove,
  DEPLOYMENT_STATUSES,
  type DeploymentStatus,
  IN_FLIGHT_STATUSES,
  isDeploymentStatus,
  ROLLBACK_SOURCE_STATUSES,
  SERVING_STATUSES,
} from "../../apps/server/src/modules/delivery/deployment-states.ts";

Deno.test("a deployment moves along the adapter lifecycle and nowhere else (#43)", () => {
  const allowed: Record<string, string[]> = {
    queued: ["deploying", "failed", "unknown"],
    deploying: ["verifying", "failed", "unknown"],
    verifying: ["healthy", "degraded", "failed", "unknown"],
    healthy: ["rolling_back"],
    degraded: ["rolling_back"],
    failed: ["rolling_back"],
    rolling_back: ["rolled_back", "failed", "unknown"],
    rolled_back: [],
  };
  for (const [from, moves] of Object.entries(allowed)) {
    for (const to of DEPLOYMENT_STATUSES) {
      assertEquals(
        canMove(from as DeploymentStatus, to),
        moves.includes(to),
        `${from} -> ${to}`,
      );
    }
  }
  // Nothing skips a stage, and nothing leaves the end of the road.
  assertFalse(canMove("queued", "healthy"));
  assertFalse(canMove("deploying", "healthy"));
  assertFalse(canMove("healthy", "deploying"));
  assertFalse(canMove("rolled_back", "queued"));
  assertFalse(canMove("rolled_back", "rolling_back"));
});

Deno.test("an unknown outcome is settled by what a read says, and a person cannot move it (#43)", () => {
  // Every real outcome is reachable from unknown; another unknown is not.
  for (const settled of DEPLOYMENT_STATUSES) {
    assertEquals(
      canMove("unknown", settled),
      !["queued", "unknown"].includes(settled),
      settled,
    );
  }
  assert(
    IN_FLIGHT_STATUSES.includes("unknown"),
    "uncertainty blocks further writes",
  );
  assertFalse(ROLLBACK_SOURCE_STATUSES.includes("unknown"));
});

Deno.test("what is in flight, what serves and what can be rolled back are distinct (#43)", () => {
  assertEquals(
    [...IN_FLIGHT_STATUSES].sort(),
    ["deploying", "queued", "rolling_back", "unknown", "verifying"],
  );
  assertEquals([...SERVING_STATUSES], ["healthy", "degraded"]);
  assertEquals([...ROLLBACK_SOURCE_STATUSES], [
    "healthy",
    "degraded",
    "failed",
  ]);
  for (
    const status of [...SERVING_STATUSES, "failed", "rolled_back"] as const
  ) {
    assertFalse(IN_FLIGHT_STATUSES.includes(status), status);
  }
  assertEquals(DEPLOYMENT_STATUSES.length, 9);
  assert(isDeploymentStatus("degraded"));
  assertFalse(isDeploymentStatus("deployed-ok"));
});
