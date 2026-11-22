import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type ActionDispatch,
  CURRENT_INTERPRETER_REVISION,
  INTERPRETER_REVISIONS,
  type JsonValue,
  type NextStep,
  nextStep,
  nextStepWithGroups,
  type StepRecord,
  WorkflowInterpreterError,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import {
  compiled,
  completed,
  type Dispatch,
  drive,
  driveMany,
  noop,
  stateOf,
  type Step,
} from "../helpers/workflow-interpreter.ts";

// #30 E4b: interpreter revision 2 runs bounded parallel groups. It is the pure
// part: the answer is the set of steps that may run now, a lane that started
// keeps its place against maxConcurrency, the join is all-required, and a
// failed lane stops its dependants and nothing else (design 06, stop-dependent:
// independent lanes still run). Revision 1 still
// refuses a group by name and is what a run is pinned to until the engine runs
// sets of steps (E4c).

const outputOf = (step: Dispatch): JsonValue =>
  step.kind === "wait" ? { outcome: "elapsed" } : { n: step.id };

/** A script that completes every step with `{n: <its id>}`, except those named. */
const script =
  (outcomes: Record<string, StepRecord> = {}) => (step: Dispatch): StepRecord =>
    outcomes[step.key] ?? completed(outputOf(step));

const group = (
  lanes: Step[],
  extra: { maxConcurrency?: number; outputs?: object } = {},
): Step => ({
  id: "fan",
  parallel: {
    maxConcurrency: extra.maxConcurrency ?? 2,
    join: "all-required",
    failurePolicy: "stop-dependent",
    branches: lanes,
    ...(extra.outputs === undefined ? {} : { outputs: extra.outputs }),
  },
});

const lane = (id: string, steps: Step[], needs: string[] = []): Step => ({
  id,
  repository: `repo_${id}`,
  ...(needs.length === 0 ? {} : { needs }),
  steps,
});

const keysOf = (next: NextStep): string[] =>
  next.kind === "dispatch"
    ? [next.step.key]
    : next.kind === "dispatch_many"
    ? next.steps.map((step) => step.key)
    : [];

const asRevision2 = { interpreter: nextStepWithGroups };

Deno.test("revision 1 still refuses a group by name; revision 2 is still deployed; new runs are pinned to the current revision", async () => {
  assertEquals(CURRENT_INTERPRETER_REVISION, "3");
  assertEquals(Object.keys(INTERPRETER_REVISIONS), ["1", "2", "3"]);
  assert(INTERPRETER_REVISIONS["1"] === nextStep);
  assert(INTERPRETER_REVISIONS["2"] === nextStepWithGroups);
  const document = await compiled([
    group([lane("lane_a", [noop("a1")]), lane("lane_b", [noop("b1")])]),
  ]);
  const error = assertThrows(
    () => nextStep(document, stateOf()),
    WorkflowInterpreterError,
  );
  assertEquals(error.code, "parallel_unsupported");
});

Deno.test("without a group revision 2 answers exactly as revision 1", async () => {
  const document = await compiled([
    noop("first"),
    { id: "pause", needs: ["first"], wait: { duration: "5m" } },
    {
      id: "loop",
      repeat: {
        max: 3,
        seed: { currentCandidate: { n: 0 } },
        until: "$repeat.currentCandidate.n >= 1",
        steps: [noop("bump", { with: { n: "$repeat.currentCandidate.n" } })],
        outputs: { currentCandidate: { n: "$step.loop.bump.next" } },
      },
    },
    noop("report", { with: { outcome: "$step.loop.outcome" } }),
  ]);
  const play = (interpreter: typeof nextStep) =>
    drive(
      document,
      (step) => {
        if (step.id === "bump") return completed({ next: 1 });
        return completed(outputOf(step));
      },
      {},
      interpreter,
    );
  const one = play(nextStep);
  const two = play(nextStepWithGroups);
  assertEquals(two.dispatched, one.dispatched);
  assertEquals(two.next, one.next);
  assertEquals(two.trace, ["first", "pause", "loop@1.bump", "report"]);
});

Deno.test("two lanes start together in authored order, run their steps in order, join, and export their results", async () => {
  const document = await compiled([
    group(
      [
        lane("lane_a", [
          noop("a1"),
          noop("a2", { with: { from: "$step.fan.lane_a.a1.n" } }),
        ]),
        lane("lane_b", [noop("b1"), noop("b2")]),
      ],
      {
        outputs: {
          lane_a: { result: "$step.fan.lane_a.a2.n" },
          lane_b: { result: "$step.fan.lane_b.b2.n" },
        },
      },
    ),
    noop("after", {
      needs: ["fan"],
      with: { a: "$step.fan.lane_a.result", b: "$step.fan.lane_b.result" },
    }),
  ]);
  const first = nextStepWithGroups(document, stateOf());
  assertEquals(first.kind, "dispatch_many");
  assertEquals(keysOf(first), ["fan.lane_a.a1", "fan.lane_b.b1"]);

  const done = driveMany(document, script(), {}, asRevision2);
  assertEquals(done.next, { kind: "finished" });
  assertEquals(done.maxRunning, 2);
  // Each step ran once, a lane's steps in its own order, and `after` last.
  assertEquals([...done.trace].sort(), [
    "after",
    "fan.lane_a.a1",
    "fan.lane_a.a2",
    "fan.lane_b.b1",
    "fan.lane_b.b2",
  ]);
  assert(
    done.trace.indexOf("fan.lane_a.a1") < done.trace.indexOf("fan.lane_a.a2"),
  );
  assert(
    done.trace.indexOf("fan.lane_b.b1") < done.trace.indexOf("fan.lane_b.b2"),
  );
  assertEquals(done.trace.at(-1), "after");
  const after = done.dispatched.find((step) =>
    step.id === "after"
  ) as ActionDispatch;
  assertEquals(after.input, { a: "a2", b: "b2" });
  const a2 = done.dispatched.find((step) => step.id === "a2") as ActionDispatch;
  assertEquals(a2.input, { from: "a1" });
});

Deno.test("the join is all-required: the step after the group waits for the slowest lane", async () => {
  const document = await compiled([
    group([
      lane("lane_a", [noop("a1")]),
      lane("lane_b", [noop("b1"), noop("b2")]),
    ]),
    noop("after", { needs: ["fan"] }),
  ]);
  const steps = new Map<string, StepRecord>([
    ["fan.lane_a.a1", completed({})],
    ["fan.lane_b.b1", completed({})],
  ]);
  // Lane A is done, lane B is not: the group is still the answer.
  const next = nextStepWithGroups(document, stateOf({ steps }));
  assertEquals(keysOf(next), ["fan.lane_b.b2"]);
  steps.set("fan.lane_b.b2", completed({}));
  assertEquals(keysOf(nextStepWithGroups(document, stateOf({ steps }))), [
    "after",
  ]);
});

Deno.test("maxConcurrency bounds the lanes running at once: one lane at a time runs a lane to its end", async () => {
  const document = await compiled([
    group([
      lane("lane_a", [noop("a1"), noop("a2")]),
      lane("lane_b", [noop("b1"), noop("b2")]),
      lane("lane_c", [noop("c1")]),
    ], { maxConcurrency: 1 }),
  ]);
  const done = driveMany(document, script(), {}, asRevision2);
  assertEquals(done.next, { kind: "finished" });
  assertEquals(done.maxRunning, 1);
  assertEquals(done.trace, [
    "fan.lane_a.a1",
    "fan.lane_a.a2",
    "fan.lane_b.b1",
    "fan.lane_b.b2",
    "fan.lane_c.c1",
  ]);
});

Deno.test("with room for two of three lanes, the third starts when a lane ends", async () => {
  const document = await compiled([
    group([
      lane("lane_a", [noop("a1"), noop("a2")]),
      lane("lane_b", [noop("b1")]),
      lane("lane_c", [noop("c1")]),
    ], { maxConcurrency: 2 }),
  ]);
  const first = nextStepWithGroups(document, stateOf());
  assertEquals(keysOf(first), ["fan.lane_a.a1", "fan.lane_b.b1"]);
  // B finishes while A's first step is still running: C takes B's place, and
  // A, which started, keeps its own.
  const next = nextStepWithGroups(
    document,
    stateOf({
      steps: new Map([["fan.lane_b.b1", completed({})]]),
      inFlight: new Set(["fan.lane_a.a1"]),
    }),
  );
  assertEquals(keysOf(next), ["fan.lane_a.a1", "fan.lane_c.c1"]);
});

Deno.test("a lane that started keeps its slot only if the host says it is running: the running set is read", async () => {
  // Lanes E and F both need P; Z is running; room for two lanes.
  const document = await compiled([
    group([
      lane("lane_e", [noop("e1")], ["lane_p"]),
      lane("lane_f", [noop("f1")], ["lane_p"]),
      lane("lane_z", [noop("z1"), noop("z2")]),
      lane("lane_p", [noop("p1")]),
    ], { maxConcurrency: 2 }),
  ]);
  const steps = new Map<string, StepRecord>([["fan.lane_p.p1", completed({})]]);
  // Z's first step is running and has no result: with that said, Z holds a
  // slot and only one new lane starts.
  const told = nextStepWithGroups(
    document,
    stateOf({ steps, inFlight: new Set(["fan.lane_z.z1"]) }),
  );
  assertEquals(keysOf(told), ["fan.lane_e.e1", "fan.lane_z.z1"]);
  // Left unsaid, Z looks unstarted and loses its place to F: two new lanes
  // and a running one, which is why the host must pass `inFlight`.
  const unsaid = nextStepWithGroups(document, stateOf({ steps }));
  assertEquals(keysOf(unsaid), ["fan.lane_e.e1", "fan.lane_f.f1"]);
});

Deno.test("at no moment do more lanes run than maxConcurrency, whatever order steps finish in", async () => {
  const document = await compiled([
    group([
      lane("lane_e", [noop("e1"), noop("e2")], ["lane_p"]),
      lane("lane_f", [noop("f1"), noop("f2")], ["lane_p"]),
      lane("lane_z", [noop("z1"), noop("z2"), noop("z3")]),
      lane("lane_p", [noop("p1"), noop("p2")]),
      lane("lane_q", [noop("q1")], ["lane_z"]),
    ], { maxConcurrency: 2 }),
    noop("after", { needs: ["fan"] }),
  ]);
  const laneOf = (key: string) => key.split(".").slice(0, 2).join(".");
  for (let seed = 1; seed <= 300; seed += 1) {
    let state = seed * 2654435761 % 4294967296;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    let mostLanes = 0;
    const done = driveMany(document, script(), {}, {
      interpreter: nextStepWithGroups,
      pick: (running) => {
        mostLanes = Math.max(
          mostLanes,
          new Set(running.filter((key) => key !== "after").map(laneOf)).size,
        );
        return Math.floor(random() * running.length);
      },
    });
    assertEquals(done.next, { kind: "finished" }, `seed ${seed}`);
    assert(mostLanes <= 2, `seed ${seed}: ${mostLanes} lanes at once`);
    assertEquals(new Set(done.trace).size, done.trace.length, `seed ${seed}`);
    assertEquals(done.trace.length, 11, `seed ${seed}`);
    // Prerequisites finish before their lanes start.
    const at = (key: string) => done.trace.indexOf(key);
    assert(at("fan.lane_p.p2") < at("fan.lane_e.e1"), `seed ${seed}`);
    assert(at("fan.lane_p.p2") < at("fan.lane_f.f1"), `seed ${seed}`);
    assert(at("fan.lane_z.z3") < at("fan.lane_q.q1"), `seed ${seed}`);
    assertEquals(done.trace.at(-1), "after", `seed ${seed}`);
  }
});

Deno.test("a lane starts only when the lanes it needs are done, and reads their exports", async () => {
  const document = await compiled([
    group([
      lane("lane_a", [noop("a1")]),
      lane("lane_b", [
        noop("b1", { with: { got: "$step.fan.lane_a.result" } }),
      ], ["lane_a"]),
    ], { outputs: { lane_a: { result: "$step.fan.lane_a.a1.n" } } }),
  ]);
  assertEquals(keysOf(nextStepWithGroups(document, stateOf())), [
    "fan.lane_a.a1",
  ]);
  const done = driveMany(document, script(), {}, asRevision2);
  assertEquals(done.trace, ["fan.lane_a.a1", "fan.lane_b.b1"]);
  assertEquals((done.dispatched[1] as ActionDispatch).input, { got: "a1" });
});

Deno.test("a failed lane stops only its dependants: independent lanes, started or not, still run, then the group halts", async () => {
  const document = await compiled([
    group([
      lane("lane_a", [noop("a1")]),
      lane("lane_b", [noop("b1")], ["lane_a"]),
      lane("lane_c", [noop("c1"), noop("c2")]),
      lane("lane_d", [noop("d1")]),
    ], { maxConcurrency: 2 }),
    noop("after", { needs: ["fan"] }),
  ]);
  // A and C start. A fails while C's first step runs.
  const steps = new Map<string, StepRecord>([
    ["fan.lane_a.a1", { status: "failed" }],
  ]);
  const during = nextStepWithGroups(
    document,
    stateOf({ steps, inFlight: new Set(["fan.lane_c.c1"]) }),
  );
  // C keeps going and D, independent of A and not yet started, takes the free
  // slot; B (needs A) never starts.
  assertEquals(keysOf(during), ["fan.lane_c.c1", "fan.lane_d.d1"]);
  steps.set("fan.lane_c.c1", completed({}));
  assertEquals(
    keysOf(
      nextStepWithGroups(
        document,
        stateOf({ steps, inFlight: new Set(["fan.lane_d.d1"]) }),
      ),
    ),
    ["fan.lane_c.c2", "fan.lane_d.d1"],
  );
  steps.set("fan.lane_c.c2", completed({}));
  steps.set("fan.lane_d.d1", completed({}));
  assertEquals(nextStepWithGroups(document, stateOf({ steps })), {
    kind: "halted",
    outcome: "failed",
    key: "fan.lane_a.a1",
  });
  // The same through the driver, whichever step finishes first.
  for (const pick of [0, 1]) {
    const run = driveMany(
      document,
      script({ "fan.lane_a.a1": { status: "failed" } }),
      {},
      {
        interpreter: nextStepWithGroups,
        pick: (running) => Math.min(pick, running.length - 1),
      },
    );
    assertEquals(run.next, {
      kind: "halted",
      outcome: "failed",
      key: "fan.lane_a.a1",
    });
    assert(!run.trace.includes("fan.lane_b.b1"), "a dependant started");
    assert(!run.trace.includes("after"), "the join was passed");
    for (
      const key of ["fan.lane_c.c1", "fan.lane_c.c2", "fan.lane_d.d1"]
    ) assert(run.trace.includes(key), `${key} did not run`);
  }
});

Deno.test("with room for one lane, a failed lane does not keep an independent lane from running", async () => {
  const document = await compiled([
    group([lane("lane_a", [noop("a1")]), lane("lane_b", [noop("b1")])], {
      maxConcurrency: 1,
    }),
  ]);
  const run = driveMany(
    document,
    script({ "fan.lane_a.a1": { status: "failed" } }),
    {},
    asRevision2,
  );
  assertEquals(run.trace, ["fan.lane_a.a1", "fan.lane_b.b1"]);
  assertEquals(run.next, {
    kind: "halted",
    outcome: "failed",
    key: "fan.lane_a.a1",
  });
});

Deno.test("a lane that needs only a healthy lane runs although an unrelated lane failed, and one that needs the failed lane through another does not", async () => {
  const document = await compiled([
    group([
      lane("lane_a", [noop("a1")]),
      lane("lane_b", [noop("b1")]),
      lane("lane_d", [noop("d1")], ["lane_b"]),
      lane("lane_e", [noop("e1")], ["lane_a"]),
      lane("lane_f", [noop("f1")], ["lane_e"]),
    ], { maxConcurrency: 1 }),
  ]);
  const run = driveMany(
    document,
    script({ "fan.lane_a.a1": { status: "failed" } }),
    {},
    asRevision2,
  );
  // A fails; B and D (needs B) still run; E (needs A) and F (needs E) never do.
  assertEquals(run.trace, [
    "fan.lane_a.a1",
    "fan.lane_b.b1",
    "fan.lane_d.d1",
  ]);
  assertEquals(run.next, {
    kind: "halted",
    outcome: "failed",
    key: "fan.lane_a.a1",
  });
});

Deno.test("a canceled or timed-out step in a lane halts the group with that outcome", async () => {
  const document = await compiled([
    group([lane("lane_a", [noop("a1")]), lane("lane_b", [noop("b1")])]),
  ]);
  for (const status of ["canceled", "timed_out"] as const) {
    const run = driveMany(
      document,
      script({ "fan.lane_b.b1": { status } }),
      {},
      asRevision2,
    );
    assertEquals(run.next, {
      kind: "halted",
      outcome: status,
      key: "fan.lane_b.b1",
    });
  }
});

Deno.test("a run canceled while a group runs halts at once, naming no step", async () => {
  const document = await compiled([
    group([lane("lane_a", [noop("a1")]), lane("lane_b", [noop("b1")])]),
  ]);
  assertEquals(
    nextStepWithGroups(
      document,
      stateOf({
        cancelRequested: true,
        inFlight: new Set(["fan.lane_a.a1", "fan.lane_b.b1"]),
      }),
    ),
    { kind: "halted", outcome: "canceled", key: null },
  );
});

Deno.test("a failed iteration inside a repeat in a lane is the repeat's outcome, not the lane's failure", async () => {
  const document = await compiled([
    group([
      lane("lane_a", [
        {
          id: "loop",
          repeat: {
            max: 2,
            seed: { currentCandidate: { n: 0 } },
            until: "$repeat.currentCandidate.n >= 1",
            steps: [
              noop("bump", { with: { n: "$repeat.currentCandidate.n" } }),
            ],
            outputs: { currentCandidate: { n: 1 } },
          },
        },
        noop("after_loop", { with: { how: "$step.fan.lane_a.loop.outcome" } }),
      ]),
      lane("lane_b", [noop("b1")]),
    ]),
  ]);
  const run = driveMany(
    document,
    script({ "fan.lane_a.loop@1.bump": { status: "failed" } }),
    {},
    asRevision2,
  );
  assertEquals(run.next, { kind: "finished" });
  const after = run.dispatched.find((step) =>
    step.id === "after_loop"
  ) as ActionDispatch;
  assertEquals(after.input, { how: "failed" });
});

Deno.test("a wait in a lane is part of the set, as a wait", async () => {
  const document = await compiled([
    group([
      lane("lane_a", [{ id: "pause", wait: { duration: "5m" } }, noop("a2")]),
      lane("lane_b", [noop("b1")]),
    ]),
  ]);
  const first = nextStepWithGroups(document, stateOf());
  assert(first.kind === "dispatch_many");
  assertEquals(first.steps.map((step) => [step.kind, step.key]), [
    ["wait", "fan.lane_a.pause"],
    ["action", "fan.lane_b.b1"],
  ]);
  const done = driveMany(document, script(), {}, asRevision2);
  assertEquals(done.next, { kind: "finished" });
  assertEquals(done.trace.length, 3 + 0);
});

Deno.test("a group whose condition is false is skipped, and so is what needs it", async () => {
  const gated: Step = {
    ...group([lane("lane_a", [noop("a1")]), lane("lane_b", [noop("b1")])]),
    if: "$input.on == true",
  };
  const document = await compiled([
    gated,
    noop("dependent", { needs: ["fan"] }),
    noop("independent"),
  ], { on: { type: "boolean", required: true } });
  const off = driveMany(
    document,
    script(),
    { inputs: { on: false } },
    asRevision2,
  );
  assertEquals(off.trace, ["independent"]);
  assertEquals(off.next, { kind: "finished" });
  const on = driveMany(
    document,
    script(),
    { inputs: { on: true } },
    asRevision2,
  );
  assertEquals(on.trace.length, 4);
});

Deno.test("a single lane answers as a set of one, and a group needs no inFlight to be correct when nothing runs", async () => {
  const document = await compiled([
    group([lane("lane_a", [noop("a1")])], { maxConcurrency: 1 }),
  ]);
  const next = nextStepWithGroups(document, stateOf());
  assert(next.kind === "dispatch_many");
  assertEquals(next.steps.length, 1);
  // The answer is a copy: editing it changes nothing the run recorded.
  (next.steps[0] as { input: Record<string, unknown> }).input["x"] = 1;
  const again = nextStepWithGroups(document, stateOf());
  assert(again.kind === "dispatch_many");
  assertEquals(again.steps[0]!.kind === "action" && again.steps[0]!.input, {});
});

Deno.test("when several lanes failed, the halt names the first in authored order", async () => {
  const document = await compiled([
    group([lane("lane_a", [noop("a1")]), lane("lane_b", [noop("b1")])]),
  ]);
  for (const pick of [0, 1]) {
    const run = driveMany(
      document,
      script({
        "fan.lane_a.a1": { status: "failed" },
        "fan.lane_b.b1": { status: "timed_out" },
      }),
      {},
      {
        interpreter: nextStepWithGroups,
        pick: (running) => Math.min(pick, running.length - 1),
      },
    );
    assertEquals(run.next, {
      kind: "halted",
      outcome: "failed",
      key: "fan.lane_a.a1",
    });
  }
});

Deno.test("a group inside a repeat's body is dispatched as a set under the iteration's keys", async () => {
  const document = await compiled([
    {
      id: "loop",
      repeat: {
        max: 2,
        seed: { currentCandidate: { n: 0 } },
        until: "$repeat.currentCandidate.n >= 1",
        steps: [
          group([lane("lane_a", [noop("a1")]), lane("lane_b", [noop("b1")])]),
        ],
        outputs: { currentCandidate: { n: 1 } },
      },
    },
    noop("report", { with: { outcome: "$step.loop.outcome" } }),
  ]);
  const first = nextStepWithGroups(document, stateOf());
  assertEquals(keysOf(first), [
    "loop@1.fan.lane_a.a1",
    "loop@1.fan.lane_b.b1",
  ]);
  const run = driveMany(document, script(), {}, asRevision2);
  assertEquals(run.next, { kind: "finished" });
  assertEquals(run.trace.at(-1), "report");
  assertEquals(run.maxRunning, 2);
});

Deno.test("a lane that reads a failed lane's export is never evaluated: the group halts cleanly", async () => {
  const document = await compiled([
    group([
      lane("lane_a", [noop("a1")]),
      lane("lane_b", [
        noop("b1", { with: { got: "$step.fan.lane_a.result" } }),
      ], ["lane_a"]),
    ], { outputs: { lane_a: { result: "$step.fan.lane_a.a1.n" } } }),
  ]);
  const run = driveMany(
    document,
    script({ "fan.lane_a.a1": { status: "failed" } }),
    {},
    asRevision2,
  );
  assertEquals(run.next, {
    kind: "halted",
    outcome: "failed",
    key: "fan.lane_a.a1",
  });
  assertEquals(run.trace, ["fan.lane_a.a1"]);
});

Deno.test("a lane between two of its steps still holds its slot: new lanes do not take it", async () => {
  // N and Y both became ready when P finished; G started earlier and has its
  // next step not yet dispatched (nothing of G is running at this moment).
  const document = await compiled([
    group([
      lane("lane_n", [noop("n1")], ["lane_p"]),
      lane("lane_y", [noop("y1")], ["lane_p"]),
      lane("lane_g", [noop("g1"), noop("g2")]),
      lane("lane_p", [noop("p1")]),
    ], { maxConcurrency: 2 }),
  ]);
  const steps = new Map<string, StepRecord>([
    ["fan.lane_p.p1", completed({})],
    ["fan.lane_g.g1", completed({})],
  ]);
  assertEquals(keysOf(nextStepWithGroups(document, stateOf({ steps }))), [
    "fan.lane_n.n1",
    "fan.lane_g.g2",
  ]);
});
