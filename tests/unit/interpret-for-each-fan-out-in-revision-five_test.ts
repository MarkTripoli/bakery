import { assert, assertEquals } from "@std/assert";
import {
  CURRENT_INTERPRETER_REVISION,
  INTERPRETER_REVISIONS,
  type JsonValue,
  nextStepWithFanOut,
  nextStepWithLoopBounds,
  type StepRecord,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import {
  compiled,
  completed,
  type Dispatch,
  drive,
  driveMany,
  noop,
  type Step,
} from "../helpers/workflow-interpreter.ts";

// #439: interpreter revision 5 is revision 4 plus a forEach's `maxConcurrency`
// (that many iterations in flight at once) and `collect` (the loop's `results`:
// one value read from each completed iteration, in item order). Earlier
// revisions ignore both fields.

const loop = (
  steps: Step[],
  extra: Record<string, unknown> = {},
): Step => ({
  id: "cases",
  forEach: {
    items: "$step.prepare.cases",
    max: 6,
    as: "case",
    steps,
    ...extra,
  },
});

const inputOf = (step: Dispatch): JsonValue =>
  step.kind === "action" ? step.input : null;

const withCases = (
  cases: JsonValue,
  outcomes: Record<string, StepRecord> = {},
) =>
(step: Dispatch): StepRecord =>
  outcomes[step.key] ??
    (step.id === "prepare"
      ? completed({ cases })
      : completed({ echo: inputOf(step) }));

const six = Array.from({ length: 6 }, (_, i) => ({ id: `c${i + 1}` }));
const asRevision5 = { interpreter: nextStepWithFanOut };

Deno.test("revision 5 is current, revision 4 stays deployed beside it", () => {
  assertEquals(CURRENT_INTERPRETER_REVISION, "5");
  assert(INTERPRETER_REVISIONS["4"] === nextStepWithLoopBounds);
  assert(INTERPRETER_REVISIONS["5"] === nextStepWithFanOut);
});

Deno.test("a loop that names neither field gets revision 4's answers", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([
      noop("run_case", { with: { item: "$each.case" } }),
      noop("score", { needs: ["run_case"], with: { n: "$each.case.id" } }),
    ]),
    noop("report", { with: { ran: "$step.cases.iterations" } }),
  ]);
  const four = drive(document, withCases(six), {}, nextStepWithLoopBounds);
  const five = drive(document, withCases(six), {}, nextStepWithFanOut);
  assertEquals(five.trace, four.trace);
  assertEquals(five.dispatched, four.dispatched);
  assertEquals(five.next, four.next);
});

Deno.test("collect gathers one value per completed iteration, in item order", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case", { with: { item: "$each.case" } })], {
      collect: { id: "$each.case.id", echoed: "$step.cases.run_case.echo" },
    }),
    noop("report", {
      with: { all: "$step.cases.results", ran: "$step.cases.iterations" },
    }),
  ]);
  const run = drive(
    document,
    withCases(six.slice(0, 3)),
    {},
    nextStepWithFanOut,
  );
  assertEquals(run.next, { kind: "finished" });
  assertEquals(
    inputOf(run.dispatched.at(-1)!),
    {
      all: [1, 2, 3].map((n) => ({
        id: `c${n}`,
        echoed: { item: { id: `c${n}` } },
      })),
      ran: 3,
    },
  );
});

Deno.test("a sequential loop's collect stops at the failed iteration and keeps what completed", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case", { with: { item: "$each.case" } })], {
      collect: "$each.case.id",
    }),
    noop("report", {
      with: { all: "$step.cases.results", outcome: "$step.cases.outcome" },
    }),
  ]);
  const run = drive(
    document,
    withCases(six.slice(0, 4), { "cases@3.run_case": { status: "failed" } }),
    {},
    nextStepWithFanOut,
  );
  assertEquals(inputOf(run.dispatched.at(-1)!), {
    all: ["c1", "c2"],
    outcome: "failed",
  });
});

Deno.test("maxConcurrency keeps at most that many iterations in flight and fills places in item order", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case", { with: { item: "$each.case" } })], {
      maxConcurrency: 3,
      collect: "$each.case.id",
    }),
    noop("report", { with: { all: "$step.cases.results" } }),
  ]);
  const run = driveMany(document, withCases(six), {}, asRevision5);
  assertEquals(run.next, { kind: "finished" });
  assertEquals(run.maxRunning, 3);
  // The first three start together, in item order, before anything finishes.
  assertEquals(run.trace.slice(0, 4), [
    "prepare",
    "cases@1.run_case",
    "cases@2.run_case",
    "cases@3.run_case",
  ]);
  assertEquals(inputOf(run.dispatched.at(-1)!), {
    all: six.map((item) => item.id),
  });
});

Deno.test("results stay in item order however the iterations finish", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case", { with: { item: "$each.case" } })], {
      maxConcurrency: 6,
      collect: "$each.case.id",
    }),
    noop("report", { with: { all: "$step.cases.results" } }),
  ]);
  // The last started iteration always finishes first.
  const run = driveMany(document, withCases(six), {}, {
    interpreter: nextStepWithFanOut,
    pick: (running) => running.length - 1,
  });
  assertEquals(run.next, { kind: "finished" });
  assertEquals(run.maxRunning, 6);
  assertEquals(inputOf(run.dispatched.at(-1)!), {
    all: six.map((item) => item.id),
  });
});

Deno.test("iterations with several steps each run their own steps in order while others run beside them", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([
      noop("run_case", { with: { item: "$each.case" } }),
      noop("score", { needs: ["run_case"], with: { n: "$each.case.id" } }),
    ], {
      maxConcurrency: 2,
      collect: { id: "$each.case.id", scored: "$step.cases.score.echo" },
    }),
    noop("report", { with: { all: "$step.cases.results" } }),
  ]);
  const run = driveMany(document, withCases(six.slice(0, 4)), {}, asRevision5);
  assertEquals(run.next, { kind: "finished" });
  assertEquals(run.maxRunning, 2);
  for (let n = 1; n <= 4; n += 1) {
    assert(
      run.trace.indexOf(`cases@${n}.run_case`) <
        run.trace.indexOf(`cases@${n}.score`),
      `iteration ${n} ran its steps out of order`,
    );
  }
  const results = (inputOf(run.dispatched.at(-1)!) as { all: JsonValue[] }).all;
  assertEquals(results.length, 4);
  assertEquals(
    results.map((entry) => (entry as { id: string }).id),
    ["c1", "c2", "c3", "c4"],
  );
});

Deno.test("a failed iteration starts nothing new, lets the running ones finish, and becomes the loop's outcome", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case", { with: { item: "$each.case" } })], {
      maxConcurrency: 2,
      collect: "$each.case.id",
    }),
    noop("report", {
      with: {
        all: "$step.cases.results",
        ran: "$step.cases.iterations",
        outcome: "$step.cases.outcome",
      },
    }),
  ]);
  const run = driveMany(
    document,
    withCases(six, { "cases@2.run_case": { status: "failed" } }),
    {},
    asRevision5,
  );
  assertEquals(run.next, { kind: "finished" });
  // Iterations 1 and 2 started together; 2 failed; 3 started in the place 1
  // left only if nothing had failed yet. 1 finished first, so 3 may have
  // started, but nothing after the failure did.
  const started = run.trace.filter((key) => key.startsWith("cases@"));
  assert(!started.includes("cases@5.run_case"), "started after the failure");
  assert(!started.includes("cases@6.run_case"), "started after the failure");
  const report = inputOf(run.dispatched.at(-1)!) as {
    all: string[];
    ran: number;
    outcome: string;
  };
  assertEquals(report.outcome, "failed");
  assertEquals(report.ran, report.all.length);
  assert(report.all.includes("c1"));
  assert(!report.all.includes("c2"));
});

Deno.test("a list longer than max halts the run before any iteration starts", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case")], { max: 2, maxConcurrency: 2 }),
  ]);
  const run = driveMany(document, withCases(six), {}, asRevision5);
  assertEquals(run.trace, ["prepare"]);
  assertEquals(run.next, { kind: "halted", outcome: "failed", key: "cases" });
});

Deno.test("revision 4 ignores both fields: it runs one iteration at a time and collects nothing", async () => {
  const document = await compiled([
    noop("prepare"),
    loop([noop("run_case", { with: { item: "$each.case" } })], {
      maxConcurrency: 3,
    }),
  ]);
  const run = driveMany(document, withCases(six), {}, {
    interpreter: nextStepWithLoopBounds,
  });
  assertEquals(run.next, { kind: "finished" });
  assertEquals(run.maxRunning, 1);
});
