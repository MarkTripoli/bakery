import { assertEquals } from "@std/assert";
import {
  advanceUpdateWatch,
  claimUpdatedToast,
  initialUpdateWatch,
  secondsUntilNextCheck,
  type UpdateWatchEvent,
  type UpdateWatchState,
  UPDATING_LONGER_MS,
  updatingTooLong,
} from "../../apps/web/src/shell/update-watch.ts";

// #59 slice 5: the shell's reading of the public installation status. A pause
// seen and then no answer is an update; no answer with no pause is not.

const answered = (
  updatePaused: boolean,
  release: string | null = "r1",
): UpdateWatchEvent => ({ type: "answered", updatePaused, release });
const away = (at: number): UpdateWatchEvent => ({ type: "unreachable", at });

function play(events: readonly UpdateWatchEvent[]) {
  let state: UpdateWatchState = initialUpdateWatch;
  const outcomes = [];
  for (const event of events) {
    const next = advanceUpdateWatch(state, event);
    state = next.state;
    outcomes.push(next.outcome);
  }
  return { state, outcomes };
}

Deno.test("a pause seen while the server answers is only the bar", () => {
  const { state } = play([answered(false), answered(true)]);
  assertEquals(state.phase, "answering");
  assertEquals(state.paused, true);
});

Deno.test("the server going away after a pause is an update, from that moment", () => {
  const { state } = play([answered(true), away(1_000), away(6_000)]);
  assertEquals(state.phase, "updating");
  assertEquals(state.since, 1_000);
});

Deno.test("the server going away with no pause seen is not an update", () => {
  const { state } = play([answered(false), away(1_000)]);
  assertEquals(state.phase, "unreachable");
  assertEquals(state.since, null);
});

Deno.test("a pause that was released before the server went away is not an update", () => {
  const { state } = play([answered(true), answered(false), away(1_000)]);
  assertEquals(state.phase, "unreachable");
});

Deno.test("back on another release: the update went through, said once", () => {
  const { state, outcomes } = play([
    answered(true, "r1"),
    away(1_000),
    answered(false, "r2"),
    answered(false, "r2"),
  ]);
  assertEquals(outcomes, [null, null, "updated", null]);
  assertEquals(state, {
    phase: "answering",
    paused: false,
    release: "r2",
    since: null,
  });
});

Deno.test("back on the same release: the update did not go through", () => {
  const { outcomes } = play([
    answered(true, "r1"),
    away(1_000),
    answered(false, "r1"),
  ]);
  assertEquals(outcomes, [null, null, "notUpdated"]);
});

Deno.test("back after being unreachable without a pause says nothing", () => {
  const { outcomes } = play([
    answered(false, "r1"),
    away(1_000),
    answered(false, "r2"),
  ]);
  assertEquals(outcomes, [null, null, null]);
});

Deno.test("an unknown release cannot tell an update from a return", () => {
  const { outcomes } = play([
    answered(true, null),
    away(1_000),
    answered(false, "r2"),
  ]);
  assertEquals(outcomes, [null, null, null]);
});

Deno.test("after ten minutes the page says it takes longer than usual", () => {
  const { state } = play([answered(true), away(0)]);
  assertEquals(updatingTooLong(state, UPDATING_LONGER_MS - 1), false);
  assertEquals(updatingTooLong(state, UPDATING_LONGER_MS), true);
  assertEquals(updatingTooLong(initialUpdateWatch, UPDATING_LONGER_MS), false);
});

Deno.test("the countdown runs from 5 to 1 between reads", () => {
  assertEquals(secondsUntilNextCheck(0, 0), 5);
  assertEquals(secondsUntilNextCheck(0, 1), 5);
  assertEquals(secondsUntilNextCheck(0, 4_001), 1);
  assertEquals(secondsUntilNextCheck(0, 9_000), 1);
});

function memory(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

Deno.test("Bakery was updated is told once per person for each release", () => {
  const kept = memory();
  assertEquals(claimUpdatedToast(kept, "ada", "r2"), true);
  assertEquals(claimUpdatedToast(kept, "ada", "r2"), false);
  assertEquals(claimUpdatedToast(kept, "sam", "r2"), true);
  assertEquals(claimUpdatedToast(kept, "ada", "r3"), true);
});

Deno.test("a browser that keeps nothing still tells the person", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {},
  };
  assertEquals(claimUpdatedToast(broken, "ada", "r2"), true);
  assertEquals(claimUpdatedToast(null, "ada", "r2"), true);
});
