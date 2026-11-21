import { assertEquals } from "@std/assert";
import {
  decideSteer,
  type SteerFacts,
  steerRecordDetail,
  SteerRefusal,
} from "../../apps/server/src/modules/work/agent-steer.ts";

// #413: the steer decision is pure so every rule is a unit test. The order is part
// of the contract: permission, then the target (own run, outside the tree,
// reviewer), then count.

const ok: SteerFacts = {
  holdsPower: true,
  targetIsOwnRun: false,
  targetIsDescendant: true,
  targetIsReviewer: false,
  holdsReviewerPower: false,
  steersSent: 0,
  limits: { maxDepth: 3, maxChildren: 5, maxSteers: 20 },
};

Deno.test("a steer of a spawned run within the bound proceeds", () => {
  assertEquals(decideSteer(ok), null);
});

Deno.test("permission refuses first, whatever else is true", () => {
  assertEquals(
    decideSteer({
      ...ok,
      holdsPower: false,
      targetIsOwnRun: true,
      targetIsDescendant: false,
      targetIsReviewer: true,
      steersSent: 99,
    }),
    SteerRefusal.RequiresGrant,
  );
});

Deno.test("an agent never steers its own run, even though it holds the power", () => {
  assertEquals(
    decideSteer({ ...ok, targetIsOwnRun: true, targetIsDescendant: false }),
    SteerRefusal.OwnRun,
  );
});

Deno.test("a run outside the agent's tree answers like one that does not exist", () => {
  assertEquals(
    decideSteer({ ...ok, targetIsDescendant: false }),
    "not_found",
  );
  // And it is checked before the reviewer rule, so nothing leaks about a run
  // the agent has no business knowing.
  assertEquals(
    decideSteer({ ...ok, targetIsDescendant: false, targetIsReviewer: true }),
    "not_found",
  );
});

Deno.test("a reviewer is steered by an agent only with the steer_reviewer power", () => {
  assertEquals(
    decideSteer({ ...ok, targetIsReviewer: true }),
    SteerRefusal.ReviewerUnavailable,
  );
  assertEquals(
    decideSteer({
      ...ok,
      targetIsReviewer: true,
      holdsReviewerPower: true,
    }),
    null,
  );
  // The reviewer power opens the reviewer, nothing else: the rest still applies.
  assertEquals(
    decideSteer({
      ...ok,
      targetIsReviewer: true,
      holdsReviewerPower: true,
      steersSent: 20,
    }),
    SteerRefusal.CountExceeded,
  );
});

Deno.test("count: the last steer is accepted, the next is refused", () => {
  assertEquals(decideSteer({ ...ok, steersSent: 19 }), null);
  assertEquals(
    decideSteer({ ...ok, steersSent: 20 }),
    SteerRefusal.CountExceeded,
  );
});

Deno.test("a reviewer without the power is refused before count is consulted", () => {
  assertEquals(
    decideSteer({ ...ok, targetIsReviewer: true, steersSent: 99 }),
    SteerRefusal.ReviewerUnavailable,
  );
});

Deno.test("a steer's record has one shape; an agent's only adds who it acted for", () => {
  const person = steerRecordDetail("p1", null);
  const agent = steerRecordDetail("p1", { fromRunId: "r1", sessionId: "s1" });
  assertEquals(person, { actorKind: "person" });
  assertEquals(agent, {
    actorKind: "agent",
    onBehalfOf: "p1",
    fromRunId: "r1",
    sessionId: "s1",
  });
  // The label is the only key both carry; everything else is the agent's extra.
  assertEquals(Object.keys(person).every((key) => key in agent), true);
  assertEquals(
    steerRecordDetail("p1", { fromRunId: "r1", sessionId: null }).sessionId,
    undefined,
  );
});

Deno.test("a steer that reaches a reviewer is labelled, whoever sent it", () => {
  assertEquals(steerRecordDetail("p1", null, true), {
    actorKind: "person",
    steersReviewer: true,
  });
  assertEquals(
    steerRecordDetail("p1", { fromRunId: "r1", sessionId: null }, true)
      .steersReviewer,
    true,
  );
  // No label when it did not: the key is absent, not false.
  assertEquals("steersReviewer" in steerRecordDetail("p1", null), false);
});
