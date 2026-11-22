import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  allocateStepKey,
  buildWorkflowPlan,
  expandStepKeys,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  CURRENT_INTERPRETER_REVISION,
  INTERPRETER_REVISIONS,
  type JsonValue,
  nextStep,
  nextStepWithGroups,
  nextStepWithLoops,
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

// #417: interpreter revision 3 is revision 2 plus a bounded, sequential
// forEach over a list (design 25, item 12; deliver-as-workflow A3). The list is
// read when the loop is reached; each item runs the body once, in order, keyed
// `<loop>@n`; `$each.<as>` reads the item; the loop records iterations and
// outcome like a repeat; a list longer than max halts the run.

const loop = (
  steps: Step[],
  extra: { items?: unknown; max?: number; as?: string; id?: string } = {},
): Step => ({
  id: extra.id ?? "cases",
  forEach: {
    items: extra.items ?? "$step.prepare.cases",
    max: extra.max ?? 4,
    as: extra.as ?? "case",
    steps,
  },
});

const inputOf = (step: Dispatch): JsonValue =>
  step.kind === "action" ? step.input : null;

/** Completes `prepare` with `cases`, every other step with its own input. */
const withCases = (
  cases: JsonValue,
  outcomes: Record<string, StepRecord> = {},
) =>
(step: Dispatch): StepRecord =>
  outcomes[step.key] ??
    (step.id === "prepare"
      ? completed({ cases })
      : completed({ echo: inputOf(step) }));

const asRevision3 = { interpreter: nextStepWithLoops };

Deno.test("new runs are pinned to revision 3; revisions 1 and 2 refuse a forEach by name", async () => {
  assertEquals(CURRENT_INTERPRETER_REVISION, "3");
  assertEquals(Object.keys(INTERPRETER_REVISIONS), ["1", "2", "3"]);
  assert(INTERPRETER_REVISIONS["3"] === nextStepWithLoops);
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case", { with: { item: "$each.case" } })]),
  ]);
  // The loop is refused where it stands, after the step before it ran.
  const state = stateOf({
    steps: new Map([["prepare", completed({ cases: ["a"] })]]),
  });
  for (const older of [nextStep, nextStepWithGroups]) {
    const error = assertThrows(
      () => older(document, state),
      WorkflowInterpreterError,
    );
    assertEquals(error.code, "for_each_unsupported");
  }
});

Deno.test("without a forEach revision 3 answers exactly as revision 2", async () => {
  const document = await compiled([
    noop("first"),
    {
      id: "fix",
      repeat: {
        max: 2,
        seed: { currentCandidate: { done: false } },
        until: "$repeat.currentCandidate.done == true",
        steps: [noop("attempt")],
        outputs: { currentCandidate: { done: "$step.fix.attempt.done" } },
      },
    },
    {
      id: "fan",
      parallel: {
        maxConcurrency: 2,
        join: "all-required",
        failurePolicy: "stop-dependent",
        branches: [
          { id: "lane_a", repository: "main", steps: [noop("a1")] },
          { id: "lane_b", repository: "main", steps: [noop("b1")] },
        ],
      },
    },
    noop("last", { with: { tries: "$step.fix.iterations" } }),
  ]);
  const script = (step: Dispatch): StepRecord =>
    completed(
      step.id === "attempt" ? { done: step.key === "fix@2.attempt" } : {},
    );
  const two = driveMany(document, script, {}, {
    interpreter: nextStepWithGroups,
  });
  const three = driveMany(document, script, {}, asRevision3);
  assertEquals(three.trace, two.trace);
  assertEquals(three.dispatched, two.dispatched);
  assertEquals(three.next, { kind: "finished" });
});

Deno.test("the body runs once per item, in order, and $each reads that item", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([
      noop("run_case", { with: { item: "$each.case" } }),
      noop("score", {
        needs: ["run_case"],
        with: {
          name: "$each.case.name",
          result: "$step.cases.run_case.echo",
        },
      }),
    ]),
    noop("report", {
      with: {
        ran: "$step.cases.iterations",
        outcome: "$step.cases.outcome",
      },
    }),
  ]);
  const cases = [{ name: "one" }, { name: "two" }, { name: "three" }];
  const run = drive(document, withCases(cases), {}, nextStepWithLoops);
  assertEquals(run.next, { kind: "finished" });
  assertEquals(run.trace, [
    "prepare",
    "cases@1.run_case",
    "cases@1.score",
    "cases@2.run_case",
    "cases@2.score",
    "cases@3.run_case",
    "cases@3.score",
    "report",
  ]);
  const byKey = new Map(run.dispatched.map((step) => [step.key, step]));
  for (const [index, item] of cases.entries()) {
    const n = index + 1;
    const runCase = byKey.get(`cases@${n}.run_case`)!;
    assertEquals(inputOf(runCase), { item });
    assertEquals(runCase.iterationPath, [n]);
    // A step of the loop reads the step before it in the same iteration.
    assertEquals(inputOf(byKey.get(`cases@${n}.score`)!), {
      name: item.name,
      result: { item },
    });
  }
  assertEquals(inputOf(byKey.get("report")!), {
    ran: 3,
    outcome: "completed",
  });
});

Deno.test("#427 shape: one step prepares the batch, then a forEach runs each case", async () => {
  // One offline run per evaluation batch: `prepare` lists the cases, and the
  // loop runs and grades each case as its own steps, keyed per case.
  const document = await compiled([
    noop("prepare"),
    loop([
      noop("run_case", { with: { case: "$each.case" } }),
      noop("grade", {
        needs: ["run_case"],
        with: { case: "$each.case.id", output: "$step.cases.run_case.echo" },
      }),
    ], { max: 12 }),
    noop("summarize", { with: { graded: "$step.cases.iterations" } }),
  ]);
  const cases = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}` }));
  const run = drive(document, withCases(cases), {}, nextStepWithLoops);
  assertEquals(run.next, { kind: "finished" });
  assertEquals(run.trace.length, 1 + 12 * 2 + 1);
  assertEquals(run.trace.at(-2), "cases@12.grade");
  assertEquals(inputOf(run.dispatched.at(-1)!), { graded: 12 });
});

Deno.test("null items run no iteration and an empty list runs none either", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case", { with: { item: "$each.case" } })]),
    noop("report", {
      with: {
        ran: "$step.cases.iterations",
        outcome: "$step.cases.outcome",
      },
    }),
  ]);
  for (const cases of [null, []]) {
    const run = drive(document, withCases(cases), {}, nextStepWithLoops);
    assertEquals(run.next, { kind: "finished" });
    assertEquals(run.trace, ["prepare", "report"]);
    assertEquals(inputOf(run.dispatched[1]!), { ran: 0, outcome: "completed" });
  }
});

Deno.test("a list longer than max halts the run at the loop before any iteration", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case")], { max: 2 }),
    noop("report"),
  ]);
  const run = drive(
    document,
    withCases(["a", "b", "c"]),
    {},
    nextStepWithLoops,
  );
  assertEquals(run.next, { kind: "halted", outcome: "failed", key: "cases" });
  assertEquals(run.trace, ["prepare"]);
  // Exactly max items run.
  const fits = drive(document, withCases(["a", "b"]), {}, nextStepWithLoops);
  assertEquals(fits.next, { kind: "finished" });
  assertEquals(fits.trace, [
    "prepare",
    "cases@1.run_case",
    "cases@2.run_case",
    "report",
  ]);
});

Deno.test("items that are not a list are refused, never iterated", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case")]),
  ]);
  for (const cases of ["abc", { a: 1 }, 3]) {
    const state = stateOf({
      steps: new Map([["prepare", completed({ cases })]]),
    });
    const error = assertThrows(
      () => nextStepWithLoops(document, state),
      WorkflowInterpreterError,
    );
    assertEquals(error.code, "operand_invalid");
  }
});

Deno.test("a failed iteration stops the loop and becomes its outcome, not the run's", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case"), noop("grade", { needs: ["run_case"] })]),
    noop("report", {
      with: {
        ran: "$step.cases.iterations",
        outcome: "$step.cases.outcome",
      },
    }),
  ]);
  for (const status of ["failed", "canceled", "timed_out"] as const) {
    const run = drive(
      document,
      withCases(["a", "b", "c"], { "cases@2.run_case": { status } }),
      {},
      nextStepWithLoops,
    );
    assertEquals(run.next, { kind: "finished" });
    assertEquals(run.trace, [
      "prepare",
      "cases@1.run_case",
      "cases@1.grade",
      "cases@2.run_case",
      "report",
    ]);
    assertEquals(inputOf(run.dispatched.at(-1)!), {
      ran: 1,
      outcome: status,
    });
  }
});

Deno.test("nested loops key both iterations and read both items", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([
      {
        id: "inner",
        forEach: {
          items: "$each.case.parts",
          max: 3,
          as: "part",
          steps: [
            noop("work", {
              with: { case: "$each.case.name", part: "$each.part" },
            }),
          ],
        },
      },
      noop("after", { with: { parts: "$step.cases.inner.iterations" } }),
    ], { max: 2 }),
  ]);
  const cases = [
    { name: "x", parts: [1, 2] },
    { name: "y", parts: [3] },
  ];
  const run = drive(document, withCases(cases), {}, nextStepWithLoops);
  assertEquals(run.next, { kind: "finished" });
  assertEquals(run.trace, [
    "prepare",
    "cases@1.inner@1.work",
    "cases@1.inner@2.work",
    "cases@1.after",
    "cases@2.inner@1.work",
    "cases@2.after",
  ]);
  const byKey = new Map(run.dispatched.map((step) => [step.key, step]));
  assertEquals(inputOf(byKey.get("cases@1.inner@2.work")!), {
    case: "x",
    part: 2,
  });
  assertEquals(byKey.get("cases@1.inner@2.work")!.iterationPath, [1, 2]);
  assertEquals(inputOf(byKey.get("cases@2.inner@1.work")!), {
    case: "y",
    part: 3,
  });
  assertEquals(inputOf(byKey.get("cases@1.after")!), { parts: 2 });
  assertEquals(inputOf(byKey.get("cases@2.after")!), { parts: 1 });
});

Deno.test("a repeat inside a loop reads the loop's item and keys under it", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([
      {
        id: "fix",
        repeat: {
          max: 2,
          seed: { currentCandidate: { done: false } },
          until: "$repeat.currentCandidate.done == true",
          steps: [noop("attempt", { with: { item: "$each.case" } })],
          outputs: { currentCandidate: { done: true } },
        },
      },
    ], { max: 2 }),
  ]);
  const run = drive(document, withCases(["a", "b"]), {}, nextStepWithLoops);
  assertEquals(run.next, { kind: "finished" });
  assertEquals(run.trace, [
    "prepare",
    "cases@1.fix@1.attempt",
    "cases@2.fix@1.attempt",
  ]);
  assertEquals(inputOf(run.dispatched[2]!), { item: "b" });
  assertEquals(run.dispatched[2]!.iterationPath, [2, 1]);
});

Deno.test("a canceled run dispatches nothing more inside a loop", async () => {
  const document = await compiled([noop("prepare"), loop([noop("run_case")])]);
  const state = stateOf({
    steps: new Map([["prepare", completed({ cases: ["a", "b"] })]]),
    cancelRequested: true,
  });
  assertEquals(nextStepWithLoops(document, state), {
    kind: "halted",
    outcome: "canceled",
    key: null,
  });
});

Deno.test("the plan allocates every key the loop can dispatch, max per step", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case"), noop("grade")], { max: 3 }),
  ]);
  const plan = buildWorkflowPlan(document);
  const runCase = plan.steps.find((step) =>
    step.qualifiedId === "cases.run_case"
  )!;
  assertEquals(runCase.keyTemplate, "cases@n.run_case");
  assertEquals(runCase.loops, [{ repeat: "cases", max: 3, seed: false }]);
  assertEquals(allocateStepKey(runCase, [2]), "cases@2.run_case");
  assertEquals(expandStepKeys(plan), [
    "prepare",
    "cases@1.run_case",
    "cases@2.run_case",
    "cases@3.run_case",
    "cases@1.grade",
    "cases@2.grade",
    "cases@3.grade",
  ]);
  assertEquals(plan.worstCase.steps, 1 + 3 * 2);
  // Every key the interpreter dispatches is one the plan allocates.
  const run = drive(
    document,
    withCases(["a", "b", "c"]),
    {},
    nextStepWithLoops,
  );
  const allowed = new Set(expandStepKeys(plan));
  for (const key of run.trace) assert(allowed.has(key), key);
});
