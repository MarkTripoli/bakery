import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  compileWorkflowDocument,
  type WorkflowExpressionNode,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  type ActionDispatch,
  evaluateCondition,
  evaluateExpression,
  evaluateValue,
  type JsonValue,
  type NextStep,
  nextStep,
  readFields,
  type StepRecord,
  WorkflowInterpreterError,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import {
  compiled,
  completed,
  type Dispatch,
  drive,
  noop,
  REPO_ID,
  stateOf,
  type Step,
} from "../helpers/workflow-interpreter.ts";
import { createDesignCatalog } from "../fixtures/workflow-compiler/design-catalog.ts";
import { specimenDefinition } from "../fixtures/workflow-compiler/specimen.ts";

// #30 slice E1: the pure interpreter. It has no clock, database or engine, so
// everything here is a plain function call over a compiled document and the
// results the run has recorded so far.

const refusal = (run: () => unknown) =>
  assertThrows(run, WorkflowInterpreterError).code;

// --- values and expressions

const read =
  (path: Record<string, JsonValue> = {}) => (ref: { path: string[] }) =>
    readFields(path, ref.path);

Deno.test("an optional missing value is null, never false or empty, and a scalar has no fields", () => {
  assertEquals(readFields({ a: { b: 1 } }, ["a", "b"]), 1);
  assertEquals(readFields({ a: {} }, ["a", "missing"]), null);
  assertEquals(readFields({ a: null }, ["a", "b", "c"]), null);
  assertEquals(readFields(null, ["x"]), null);
  assertEquals(
    refusal(() => readFields({ a: 5 }, ["a", "b"])),
    "reference_unresolved",
  );
  assertEquals(
    refusal(() => readFields({ a: [1] }, ["a", "0"])),
    "reference_unresolved",
  );
});

Deno.test("comparisons do not coerce: 1 is not '1', and null equals only null", () => {
  const num = (value: number) => ({ kind: "literal", value }) as const;
  const text = (value: string) => ({ kind: "literal", value }) as const;
  const nil = { kind: "literal", value: null } as const;
  const cmp = (
    op: "eq" | "ne" | "lt" | "le" | "gt" | "ge",
    left: never,
    right: never,
  ) => evaluateExpression({ kind: "compare", op, left, right }, read());
  assertEquals(cmp("eq", num(1) as never, text("1") as never), false);
  assertEquals(cmp("ne", num(1) as never, text("1") as never), true);
  assertEquals(cmp("eq", nil as never, nil as never), true);
  assertEquals(cmp("eq", nil as never, num(0) as never), false);
  assertEquals(cmp("lt", num(1) as never, num(2) as never), true);
  assertEquals(cmp("ge", text("b") as never, text("a") as never), true);
  // Ordering takes two numbers or two strings, nothing else.
  assertEquals(
    refusal(() => cmp("lt", num(1) as never, text("2") as never)),
    "operand_invalid",
  );
  assertEquals(
    refusal(() => cmp("gt", nil as never, num(1) as never)),
    "operand_invalid",
  );
});

Deno.test("'in' takes a scalar and a list, and the connectives take booleans", () => {
  const lit = (value: string | number | boolean | null) =>
    ({ kind: "literal", value }) as const;
  assertEquals(
    evaluateExpression({
      kind: "compare",
      op: "in",
      left: lit("b"),
      right: { kind: "list", items: [lit("a"), lit("b")] },
    }, read()),
    true,
  );
  assertEquals(
    refusal(() =>
      evaluateExpression({
        kind: "compare",
        op: "in",
        left: lit("b"),
        right: lit("b"),
      }, read())
    ),
    "operand_invalid",
  );
  assertEquals(
    refusal(() => evaluateExpression({ kind: "not", operand: lit(1) }, read())),
    "operand_invalid",
  );
  assertEquals(
    refusal(() =>
      evaluateExpression({
        kind: "logical",
        op: "and",
        left: lit(true),
        right: lit("x"),
      }, read())
    ),
    "operand_invalid",
  );
  assertEquals(
    evaluateExpression({ kind: "not", operand: lit(false) }, read()),
    true,
  );
});

Deno.test("&& and || stop at the operand that decides, so a guard never reads what it rules out", () => {
  const unreadable: WorkflowExpressionNode = {
    kind: "ref",
    root: "step",
    path: ["never", "recorded"],
  };
  const explode = () => {
    throw new WorkflowInterpreterError("reference_unresolved");
  };
  assertEquals(
    evaluateExpression(
      {
        kind: "logical",
        op: "and",
        left: { kind: "literal", value: false },
        right: unreadable,
      },
      explode,
    ),
    false,
  );
  assertEquals(
    evaluateExpression(
      {
        kind: "logical",
        op: "or",
        left: { kind: "literal", value: true },
        right: unreadable,
      },
      explode,
    ),
    true,
  );
  // When the left side does not decide, the right side is read.
  assertEquals(
    refusal(() =>
      evaluateExpression(
        {
          kind: "logical",
          op: "and",
          left: { kind: "literal", value: true },
          right: unreadable,
        },
        explode,
      )
    ),
    "reference_unresolved",
  );
});

Deno.test("a condition must be a boolean, not merely truthy", () => {
  assertEquals(
    evaluateCondition({ kind: "literal", value: true }, read()),
    true,
  );
  for (const value of [1, "yes", null]) {
    assertEquals(
      refusal(() => evaluateCondition({ kind: "literal", value }, read())),
      "condition_not_boolean",
    );
  }
});

Deno.test("a value copies its literals, so nothing a run produces aliases the document", () => {
  const node = { kind: "literal", value: { list: [1, 2] } } as const;
  const first = evaluateValue(node, read()) as { list: number[] };
  first.list.push(3);
  assertEquals(evaluateValue(node, read()), { list: [1, 2] });
  assertEquals(
    evaluateValue(
      {
        kind: "object",
        fields: {
          a: { kind: "ref", root: "input", path: ["x"] },
          b: { kind: "list", items: [{ kind: "literal", value: 1 }] },
        },
      },
      () => "seen",
    ),
    { a: "seen", b: [1] },
  );
});

// --- a sequence runs in authored order (#157)

Deno.test("steps are dispatched in authored order, each reading what the one before recorded", async () => {
  const document = await compiled([
    noop("first", { with: { seed: "$input.seed" } }),
    noop("second", { with: { from_first: "$step.first.value" } }),
    noop("third", { with: { from_second: "$step.second.value" } }),
  ], { seed: { type: "string", required: true } });
  const { trace, dispatched, next } = drive(
    document,
    (step) => completed({ value: `${step.id}-done` }),
    { inputs: { seed: "s1" } },
  );
  assertEquals(trace, ["first", "second", "third"]);
  assertEquals(next, { kind: "finished" });
  assertEquals((dispatched[0] as ActionDispatch).input, { seed: "s1" });
  assertEquals((dispatched[1] as ActionDispatch).input, {
    from_first: "first-done",
  });
  assertEquals((dispatched[2] as ActionDispatch).input, {
    from_second: "second-done",
  });
});

Deno.test("a read needs no needs edge to be ordered: the reader waits for the step it reads", async () => {
  // doc 06: sequence order is execution order, and `needs` adds a dependency a
  // read does not imply. With no `needs` anywhere the second step still cannot
  // be dispatched before the first has a recorded result.
  const document = await compiled([
    noop("merge", { with: { go: true } }),
    noop("deploy", { with: { commit: "$step.merge.commit" } }),
  ]);
  const start = nextStep(document, stateOf());
  assertEquals(start.kind === "dispatch" && start.step.id, "merge");
  // Dispatching `deploy` first is impossible while `merge` has no record.
  const steps = new Map<string, StepRecord>();
  const afterMerge = nextStep(
    document,
    stateOf({ steps: steps.set("merge", completed({ commit: "abc" })) }),
  );
  assertEquals(afterMerge.kind === "dispatch" && afterMerge.step.id, "deploy");
  assertEquals(
    afterMerge.kind === "dispatch" && (afterMerge.step as ActionDispatch).input,
    { commit: "abc" },
  );
});

Deno.test("a step that fails outside a repeat halts the run and nothing later is dispatched", async () => {
  const document = await compiled([
    noop("step_a"),
    noop("step_b"),
    noop("step_c"),
  ]);
  for (const status of ["failed", "timed_out", "canceled"] as const) {
    const { trace, next } = drive(
      document,
      (step) => step.id === "step_b" ? { status } : completed(),
    );
    assertEquals(trace, ["step_a", "step_b"], status);
    assertEquals(next, { kind: "halted", outcome: status, key: "step_b" });
  }
});

Deno.test("a canceled run dispatches nothing, from the first call on", async () => {
  const document = await compiled([noop("step_a"), noop("step_b")]);
  assertEquals(
    nextStep(document, stateOf({ cancelRequested: true })),
    { kind: "halted", outcome: "canceled", key: null },
  );
  const steps = new Map<string, StepRecord>([["step_a", completed()]]);
  assertEquals(
    nextStep(document, stateOf({ steps, cancelRequested: true })),
    { kind: "halted", outcome: "canceled", key: null },
  );
});

Deno.test("the same state always gives the same answer, and results recorded for other keys change nothing", async () => {
  const document = await compiled([noop("step_a"), noop("step_b")]);
  const steps = new Map<string, StepRecord>([
    ["step_a", completed({ x: 1 })],
  ]);
  const first = nextStep(document, stateOf({ steps }));
  assertEquals(nextStep(document, stateOf({ steps })), first);
  steps.set("never_reached", completed());
  assertEquals(nextStep(document, stateOf({ steps })), first);
});

Deno.test("an action carries its checks, its effect key, its agent version and its policy", async () => {
  const agent = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const document = await compiled([
    noop("seed", { with: { x: 1 } }),
    {
      id: "build",
      needs: ["seed"],
      uses: "harness.implement",
      agentVersionId: agent,
      with: { repositoryId: "$input.repo", planArtifact: "$step.seed.plan" },
      timeout: "10m",
      retry: { maxAttempts: 1, backoff: "30s", on: ["WORKER_UNAVAILABLE"] },
    },
    {
      id: "ship",
      uses: "delivery.merge",
      with: { repositoryId: "$input.repo", candidate: "$step.seed.candidate" },
      effectKey: ["merge", "$input.repo", "$input.revision"],
    },
    {
      id: "gate",
      uses: "quality.check",
      with: { repositoryId: "$input.repo", revision: "$step.seed.sha" },
      checks: ["test", "lint"],
    },
  ], {
    repo: { type: "uuid", required: true },
    revision: { type: "integer", required: true },
  });
  const { dispatched } = drive(
    document,
    (step) =>
      step.id === "seed"
        ? completed({ plan: "p", sha: "abc", candidate: { s: 1 } })
        : completed(),
    { inputs: { repo: REPO_ID, revision: 7 } },
  );
  const [, build, ship, gate] = dispatched as ActionDispatch[];
  assertEquals(build!.agentVersionId, agent);
  assertEquals(build!.timeoutMs, 600_000);
  assertEquals(build!.retry, {
    maxAttempts: 1,
    backoffMs: 30_000,
    on: ["WORKER_UNAVAILABLE"],
  });
  assertEquals(build!.input, { repositoryId: REPO_ID, planArtifact: "p" });
  // The key is for the host to inject: only it knows whether the action takes one.
  assertEquals(ship!.effectKey, `merge:${REPO_ID}:7`);
  assertEquals(ship!.input, { repositoryId: REPO_ID, candidate: { s: 1 } });
  assertEquals(gate!.input, {
    repositoryId: REPO_ID,
    revision: "abc",
    checks: ["lint", "test"],
  });
});

Deno.test("an effect key part that is not a scalar is refused", async () => {
  const document = await compiled([
    noop("seed"),
    {
      id: "ship",
      uses: "delivery.merge",
      with: { repositoryId: "x", candidate: "y" },
      effectKey: ["merge", "$step.seed.object"],
    },
  ]);
  assertEquals(
    refusal(() =>
      drive(
        document,
        (step) => completed(step.id === "seed" ? { object: { a: 1 } } : {}),
      )
    ),
    "operand_invalid",
  );
});

// --- skips

Deno.test("a false condition skips a step, and skipping reaches only the steps that need it", async () => {
  const document = await compiled([
    noop("gate", { if: '$input.mode == "full"' }),
    noop("needs_gate", { needs: ["gate"] }),
    noop("by_order_only"),
    noop("tail", { needs: ["needs_gate"] }),
  ], { mode: { type: "string", required: true } });
  const full = drive(document, () => completed(), { inputs: { mode: "full" } });
  assertEquals(full.trace, ["gate", "needs_gate", "by_order_only", "tail"]);
  const quick = drive(document, () => completed(), {
    inputs: { mode: "quick" },
  });
  // `needs_gate` is skipped with `gate`, and so is `tail` through it; the step
  // that follows `gate` only in the list still runs.
  assertEquals(quick.trace, ["by_order_only"]);
  assertEquals(quick.next, { kind: "finished" });
});

// --- waits

Deno.test("a wait is dispatched as a wait, and its recorded outcome feeds the steps after it", async () => {
  const document = await compiled([
    { id: "pause", wait: { duration: "5m" } },
    { id: "answer", wait: { event: "question.answered", timeout: "1h" } },
    noop("after", {
      with: { elapsed: "$step.pause.outcome", got: "$step.answer.outcome" },
    }),
  ]);
  const { dispatched, next } = drive(document, (step) => {
    if (step.id === "pause") return completed({ outcome: "elapsed" });
    // A missing event is a typed timeout, a completed step, not a failure.
    if (step.id === "answer") {
      return completed({ outcome: "timed_out", event: null });
    }
    return completed();
  });
  assertEquals(next, { kind: "finished" });
  const [pause, answer, after] = dispatched;
  assertEquals(pause!.kind === "wait" && pause.wait, {
    kind: "duration",
    durationMs: 300_000,
  });
  assertEquals(
    answer!.kind === "wait" && answer.wait,
    { kind: "event", event: "question.answered", timeoutMs: 3_600_000 },
  );
  assertEquals((after as ActionDispatch).input, {
    elapsed: "elapsed",
    got: "timed_out",
  });
});

// --- branches

Deno.test("a branch runs the selected arm under the branch's own key and exports per arm", async () => {
  const branchDoc = await compiled([
    {
      id: "choose",
      branch: {
        when: '$input.mode == "a"',
        then: [noop("left")],
        else: [noop("right")],
        outputs: {
          picked: { then: "$step.choose.left.v", else: "$step.choose.right.v" },
          onlyThen: { then: "from-then" },
        },
      },
    },
    noop("use", {
      with: { p: "$step.choose.picked", o: "$step.choose.onlyThen" },
    }),
  ], { mode: { type: "string", required: true } });
  const left = drive(branchDoc, (step) => completed({ v: step.id }), {
    inputs: { mode: "a" },
  });
  assertEquals(left.trace, ["choose.left", "use"]);
  assertEquals((left.dispatched[1] as ActionDispatch).input, {
    p: "left",
    o: "from-then",
  });
  const right = drive(branchDoc, (step) => completed({ v: step.id }), {
    inputs: { mode: "b" },
  });
  assertEquals(right.trace, ["choose.right", "use"]);
  // An arm with no value for an output name yields null for it.
  assertEquals((right.dispatched[1] as ActionDispatch).input, {
    p: "right",
    o: null,
  });
});

Deno.test("a sequence groups steps under its own key", async () => {
  const document = await compiled([
    {
      id: "group",
      steps: [
        noop("inner_a"),
        noop("inner_b", { with: { x: "$step.group.inner_a.v" } }),
      ],
    },
    noop("after", { with: { y: "$step.group.inner_b.v" } }),
  ]);
  const { trace, dispatched } = drive(
    document,
    (step) => completed({ v: step.id }),
  );
  assertEquals(trace, ["group.inner_a", "group.inner_b", "after"]);
  assertEquals((dispatched[2] as ActionDispatch).input, { y: "inner_b" });
});

// --- repeats (AC1)

const counter = (extra: Step = {}): Step => ({
  id: "loop",
  repeat: {
    max: 3,
    seed: { currentCandidate: { n: 0 } },
    until: "$repeat.currentCandidate.n >= 2",
    steps: [noop("bump", { with: { n: "$repeat.currentCandidate.n" } })],
    outputs: { currentCandidate: { n: "$step.loop.bump.next" } },
    ...extra,
  },
});

const bump = (step: Dispatch): StepRecord =>
  completed({ next: ((step as ActionDispatch).input as { n: number }).n + 1 });

Deno.test("a seed that already satisfies until runs zero iterations and is returned unchanged", async () => {
  const document = await compiled([
    counter({ seed: { currentCandidate: { n: 5 } } }),
    noop("after", {
      with: {
        i: "$step.loop.iterations",
        c: "$step.loop.currentCandidate",
        o: "$step.loop.outcome",
      },
    }),
  ]);
  const { trace, dispatched } = drive(document, bump);
  assertEquals(trace, ["after"]);
  assertEquals((dispatched[0] as ActionDispatch).input, {
    i: 0,
    c: { n: 5 },
    o: "completed",
  });
});

Deno.test("each iteration has its own key, and the accumulator moves only when a whole iteration completed", async () => {
  const document = await compiled([
    counter(),
    noop("after", {
      with: {
        i: "$step.loop.iterations",
        c: "$step.loop.currentCandidate",
        o: "$step.loop.outcome",
      },
    }),
  ]);
  const { trace, dispatched, next } = drive(document, bump);
  assertEquals(trace, ["loop@1.bump", "loop@2.bump", "after"]);
  assertEquals(next, { kind: "finished" });
  assertEquals((dispatched[0] as ActionDispatch).input, { n: 0 });
  assertEquals((dispatched[1] as ActionDispatch).input, { n: 1 });
  assertEquals((dispatched[0] as ActionDispatch).iterationPath, [1]);
  assertEquals((dispatched[1] as ActionDispatch).iterationPath, [2]);
  assertEquals((dispatched[2] as ActionDispatch).input, {
    i: 2,
    c: { n: 2 },
    o: "completed",
  });
});

Deno.test("a repeat that reaches max without satisfying until is exhausted, and a guard on 'completed' skips delivery", async () => {
  const document = await compiled([
    counter({ until: "$repeat.currentCandidate.n >= 99", max: 3 }),
    noop("deliver", {
      needs: ["loop"],
      if: '$step.loop.outcome == "completed"',
    }),
    noop("report", {
      with: {
        o: "$step.loop.outcome",
        i: "$step.loop.iterations",
        c: "$step.loop.currentCandidate",
      },
    }),
  ]);
  const { trace, dispatched } = drive(document, bump);
  assertEquals(trace, ["loop@1.bump", "loop@2.bump", "loop@3.bump", "report"]);
  // `exhausted` cannot satisfy a delivery gate: the step never ran.
  assert(!trace.includes("deliver"));
  assertEquals((dispatched[3] as ActionDispatch).input, {
    o: "exhausted",
    i: 3,
    c: { n: 3 },
  });
});

Deno.test("a failed, canceled or timed-out iteration leaves the prior accumulator and becomes the repeat's outcome", async () => {
  for (const status of ["failed", "canceled", "timed_out"] as const) {
    const document = await compiled([
      counter({ until: "$repeat.currentCandidate.n >= 99" }),
      noop("deliver", {
        needs: ["loop"],
        if: '$step.loop.outcome == "completed"',
      }),
      noop("report", {
        with: {
          o: "$step.loop.outcome",
          i: "$step.loop.iterations",
          c: "$step.loop.currentCandidate",
        },
      }),
    ]);
    const { trace, dispatched, next } = drive(
      document,
      (step) => step.key === "loop@3.bump" ? { status } : bump(step),
    );
    assertEquals(
      trace,
      ["loop@1.bump", "loop@2.bump", "loop@3.bump", "report"],
      status,
    );
    assertEquals(next, { kind: "finished" }, status);
    // Two iterations completed; the third left the accumulator at iteration 2's.
    assertEquals((dispatched[3] as ActionDispatch).input, {
      o: status,
      i: 2,
      c: { n: 2 },
    }, status);
  }
});

Deno.test("a failure in the first iteration returns the seed itself", async () => {
  const document = await compiled([
    counter({
      seed: { currentCandidate: { n: 0 } },
      until: "$repeat.currentCandidate.n >= 9",
    }),
    noop("report", {
      with: {
        o: "$step.loop.outcome",
        i: "$step.loop.iterations",
        c: "$step.loop.currentCandidate",
      },
    }),
  ]);
  const { dispatched } = drive(
    document,
    (step) => step.key === "loop@1.bump" ? { status: "failed" } : completed(),
  );
  assertEquals((dispatched[1] as ActionDispatch).input, {
    o: "failed",
    i: 0,
    c: { n: 0 },
  });
});

Deno.test("failed-check evidence sends a clean review into repair, with the failed checks it names", async () => {
  // The default condition needs BOTH zero blocking findings and passing
  // checks, so a clean review with failed checks still repairs.
  const document = await compiled([
    noop("test", { with: { run: true } }),
    noop("review", { needs: ["test"], with: { run: true } }),
    {
      id: "repair",
      needs: ["review"],
      repeat: {
        max: 2,
        seed: {
          currentCandidate: {
            blockingFindings: "$step.review.blockingFindings",
            checksPassed: "$step.test.allRequired",
            failedCheckIds: "$step.test.failedCheckIds",
          },
        },
        until:
          "$repeat.currentCandidate.blockingFindings == 0 && $repeat.currentCandidate.checksPassed == true",
        steps: [
          noop("fix", {
            with: {
              failedCheckIds: "$repeat.currentCandidate.failedCheckIds",
              findings: "$repeat.currentCandidate.blockingFindings",
            },
          }),
        ],
        outputs: {
          currentCandidate: {
            blockingFindings: 0,
            checksPassed: true,
            failedCheckIds: "$step.repair.fix.remaining",
          },
        },
      },
    },
  ]);
  const { trace, dispatched } = drive(document, (step) => {
    if (step.id === "test") {
      return completed({ allRequired: false, failedCheckIds: ["chk-1"] });
    }
    if (step.id === "review") return completed({ blockingFindings: 0 });
    return completed({ remaining: [] });
  });
  assertEquals(trace, ["test", "review", "repair@1.fix"]);
  assertEquals((dispatched[2] as ActionDispatch).input, {
    failedCheckIds: ["chk-1"],
    findings: 0,
  });
});

Deno.test("a sequence seed runs its steps once under @0 and a clean seed then runs zero iterations", async () => {
  const document = await compiled([
    {
      id: "loop",
      repeat: {
        max: 2,
        seed: {
          steps: [noop("prepare", { with: { start: 7 } })],
          outputs: { currentCandidate: { n: "$step.loop.prepare.value" } },
        },
        until: "$repeat.currentCandidate.n >= 5",
        steps: [noop("never")],
        outputs: { currentCandidate: { n: 0 } },
      },
    },
    noop("after", {
      with: { c: "$step.loop.currentCandidate", i: "$step.loop.iterations" },
    }),
  ]);
  const { trace, dispatched } = drive(
    document,
    (step) => step.id === "prepare" ? completed({ value: 7 }) : completed(),
  );
  assertEquals(trace, ["loop@0.prepare", "after"]);
  assertEquals((dispatched[0] as ActionDispatch).iterationPath, [0]);
  assertEquals((dispatched[1] as ActionDispatch).input, { c: { n: 7 }, i: 0 });
});

Deno.test("a seed step that fails stops the run: there is no accumulator to return", async () => {
  const document = await compiled([{
    id: "loop",
    repeat: {
      max: 2,
      seed: {
        steps: [noop("prepare")],
        outputs: { currentCandidate: { n: "$step.loop.prepare.value" } },
      },
      until: "$repeat.currentCandidate.n >= 5",
      steps: [noop("body")],
      outputs: { currentCandidate: { n: 9 } },
    },
  }]);
  const { next, trace } = drive(document, () => ({ status: "failed" }));
  assertEquals(trace, ["loop@0.prepare"]);
  assertEquals(next, {
    kind: "halted",
    outcome: "failed",
    key: "loop@0.prepare",
  });
});

Deno.test("nested repeats key every level, and $repeat means the innermost accumulator", async () => {
  const document = await compiled([{
    id: "outer",
    repeat: {
      max: 2,
      seed: { currentCandidate: { total: 0 } },
      until: "$repeat.currentCandidate.total >= 4",
      steps: [{
        id: "inner",
        repeat: {
          max: 2,
          // In a seed, $repeat is the enclosing outer repeat.
          seed: {
            currentCandidate: { total: "$repeat.currentCandidate.total" },
          },
          until: "$repeat.currentCandidate.total >= 99",
          steps: [
            noop("step", { with: { t: "$repeat.currentCandidate.total" } }),
          ],
          outputs: {
            currentCandidate: { total: "$step.outer.inner.step.next" },
          },
        },
      }],
      outputs: {
        currentCandidate: { total: "$step.outer.inner.currentCandidate.total" },
      },
    },
  }]);
  const { trace, dispatched } = drive(
    document,
    (step) =>
      completed({
        next: ((step as ActionDispatch).input as { t: number }).t + 1,
      }),
  );
  assertEquals(trace, [
    "outer@1.inner@1.step",
    "outer@1.inner@2.step",
    "outer@2.inner@1.step",
    "outer@2.inner@2.step",
  ]);
  assertEquals((dispatched[1] as ActionDispatch).iterationPath, [1, 2]);
  assertEquals((dispatched[2] as ActionDispatch).iterationPath, [2, 1]);
  // The inner seed read the outer accumulator, so the second outer iteration
  // started from the first one's result (2), not from 0.
  assertEquals((dispatched[2] as ActionDispatch).input, { t: 2 });
});

Deno.test("a sequence seed in a nested repeat reads the OUTER accumulator through $repeat", async () => {
  // While a repeat builds its own seed it has no accumulator, so `$repeat`
  // means the repeat around it, in seed steps as well as in a mapping seed.
  const document = await compiled([{
    id: "outer",
    repeat: {
      max: 1,
      seed: { currentCandidate: { total: 10 } },
      until: "$repeat.currentCandidate.total >= 99",
      steps: [{
        id: "inner",
        repeat: {
          max: 1,
          seed: {
            steps: [
              noop("probe", {
                with: { outer_total: "$repeat.currentCandidate.total" },
              }),
            ],
            outputs: {
              currentCandidate: { total: "$step.outer.inner.probe.seen" },
            },
          },
          until: "$repeat.currentCandidate.total >= 99",
          steps: [noop("work")],
          outputs: { currentCandidate: { total: 0 } },
        },
      }],
      outputs: { currentCandidate: { total: 11 } },
    },
  }]);
  const { trace, dispatched } = drive(
    document,
    (step) => step.id === "probe" ? completed({ seen: 42 }) : completed(),
  );
  assertEquals(trace[0], "outer@1.inner@0.probe");
  assertEquals((dispatched[0] as ActionDispatch).input, { outer_total: 10 });
});

Deno.test("a repeat never dispatches more than seed + max x body, however the run goes", async () => {
  for (const max of [1, 2, 4, 8]) {
    const document = await compiled([
      counter({ max, until: "$repeat.currentCandidate.n >= 1000" }),
    ]);
    const { trace, next } = drive(document, bump);
    assertEquals(trace.length, max, `max ${max}`);
    assertEquals(next, { kind: "finished" });
  }
});

// --- the doc 06 specimen, end to end

type Scenario = Readonly<{
  /** Blocking findings reported by the first review, then by each repair review. */
  blocking: readonly number[];
  /** Whether the required checks pass on the first test run. */
  checksPass?: boolean;
}>;

async function runSpecimen(scenario: Scenario) {
  const definition = JSON.parse(JSON.stringify(await specimenDefinition()));
  const result = await compileWorkflowDocument(definition, {
    catalog: createDesignCatalog(),
  });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  let cycle = 0;
  const outcome = drive(result.document, (step) => {
    const input = (step as ActionDispatch).input as Record<string, JsonValue>;
    switch (step.id) {
      case "research":
      case "design":
      case "plan":
        return completed({ artifact: { artifactId: step.id } });
      case "implement":
        return completed({ headSha: "head-0" });
      case "test":
        return completed({
          allRequired: scenario.checksPass ?? true,
          checkRunIds: ["run-0"],
          failedCheckIds: scenario.checksPass === false ? ["chk-1"] : [],
          baseSha: "base",
          policyDigest: "policy",
        });
      case "review":
        return completed({
          blockingFindings: scenario.blocking[0] ?? 0,
          reviewId: "review-0",
          findings: [],
        });
      case "repair_implement":
        return completed({ headSha: `head-${step.iterationPath[0]}` });
      case "repair_test":
        return completed({
          allRequired: true,
          checkRunIds: [`run-${step.iterationPath[0]}`],
          failedCheckIds: [],
          baseSha: "base",
          policyDigest: "policy",
        });
      case "repair_review": {
        cycle = step.iterationPath[0]!;
        return completed({
          blockingFindings: scenario.blocking[cycle] ?? 0,
          reviewId: `review-${cycle}`,
          findings: [],
        });
      }
      case "candidate_evidence":
        return completed(input);
      case "merge":
        return completed({
          commitSha: `merged-${input["candidate"] ? "ok" : "?"}`,
        });
      case "prepare":
        return completed({ releaseId: "rel-1" });
      case "deploy_release":
        return completed({ deploymentId: "dep-1" });
      default:
        return completed({ status: "healthy" });
    }
  }, {
    inputs: {
      taskId: "task-1",
      repositoryId: "repo-1",
      profileRevision: 3,
      target: "production",
    },
    task: { status: "running" },
  });
  return outcome;
}

const DELIVERY_TAIL = ["merge", "prepare", "deploy_release", "health"];

Deno.test("specimen: a clean first review repairs nothing and the delivery chain runs in order", async () => {
  const { trace, next, dispatched } = await runSpecimen({ blocking: [0] });
  assertEquals(trace, [
    "research",
    "design",
    "plan",
    "implement",
    "test",
    "review",
    ...DELIVERY_TAIL,
  ]);
  assertEquals(next, { kind: "finished" });
  const merge = dispatched.find((step) =>
    step.id === "merge"
  ) as ActionDispatch;
  // The merge consumes the final accumulator, which is the seed unchanged.
  assertEquals(
    (merge.input as { candidate: { headSha: string } }).candidate.headSha,
    "head-0",
  );
  assertEquals(merge.effectKey, "merge:repo-1:head-0");
  const prepare = dispatched.find((step) =>
    step.id === "prepare"
  ) as ActionDispatch;
  assertEquals((prepare.input as { headSha: string }).headSha, "merged-ok");
});

Deno.test("specimen: one repair cycle clears the findings and merge takes the repaired candidate", async () => {
  const { trace, dispatched, next } = await runSpecimen({ blocking: [2, 0] });
  assertEquals(trace, [
    "research",
    "design",
    "plan",
    "implement",
    "test",
    "review",
    "repair@1.repair_implement",
    "repair@1.repair_test",
    "repair@1.repair_review",
    "repair@1.candidate_evidence",
    ...DELIVERY_TAIL,
  ]);
  assertEquals(next, { kind: "finished" });
  const merge = dispatched.find((step) =>
    step.id === "merge"
  ) as ActionDispatch;
  assertEquals(
    (merge.input as { candidate: { headSha: string } }).candidate.headSha,
    "head-1",
  );
  assertEquals(merge.effectKey, "merge:repo-1:head-1");
});

Deno.test("specimen: findings that never clear exhaust the repeat, and nothing after it is delivered", async () => {
  const { trace, next } = await runSpecimen({ blocking: [3, 2, 1] });
  assertEquals(trace, [
    "research",
    "design",
    "plan",
    "implement",
    "test",
    "review",
    "repair@1.repair_implement",
    "repair@1.repair_test",
    "repair@1.repair_review",
    "repair@1.candidate_evidence",
    "repair@2.repair_implement",
    "repair@2.repair_test",
    "repair@2.repair_review",
    "repair@2.candidate_evidence",
  ]);
  // merge is skipped by its guard, and prepare, deploy and health follow it
  // through `needs`: an exhausted repeat can never reach a deployment.
  for (const step of DELIVERY_TAIL) assert(!trace.includes(step), step);
  assertEquals(next, { kind: "finished" });
});

Deno.test("specimen: a clean review with failed checks still repairs, using the failed-check evidence", async () => {
  const { trace, dispatched } = await runSpecimen({
    blocking: [0, 0],
    checksPass: false,
  });
  assertEquals(trace.slice(6, 10), [
    "repair@1.repair_implement",
    "repair@1.repair_test",
    "repair@1.repair_review",
    "repair@1.candidate_evidence",
  ]);
  const repair = dispatched.find((step) =>
    step.id === "repair_implement"
  ) as ActionDispatch;
  assertEquals((repair.input as { failedCheckIds: string[] }).failedCheckIds, [
    "chk-1",
  ]);
});

// --- what this revision does not run

Deno.test("a parallel group is refused by name, not run wrongly", async () => {
  const document = await compiled([{
    id: "fan",
    parallel: {
      maxConcurrency: 2,
      join: "all-required",
      failurePolicy: "stop-dependent",
      branches: [
        { id: "lane_a", repository: "repo_a", steps: [noop("work_a")] },
        { id: "lane_b", repository: "repo_b", steps: [noop("work_b")] },
      ],
    },
  }]);
  assertEquals(
    refusal(() => nextStep(document, stateOf())),
    "parallel_unsupported",
  );
});

Deno.test("delivery state that the host has not resolved is refused when read", async () => {
  const document = await compiled([
    noop("check", { with: { revision: "$delivery.headSha" } }),
  ]);
  assertEquals(
    refusal(() => nextStep(document, stateOf())),
    "delivery_unresolved",
  );
  const next: NextStep = nextStep(
    document,
    stateOf({ delivery: { headSha: "abc" } }),
  );
  assertEquals(
    next.kind === "dispatch" && (next.step as ActionDispatch).input,
    { revision: "abc" },
  );
});

Deno.test("an error never echoes what the workflow or the run carried", () => {
  const sentinel = "SENTINEL-VALUE";
  const literal = (value: string | number): WorkflowExpressionNode => ({
    kind: "literal",
    value,
  });
  const attempts: Array<() => unknown> = [
    // A condition whose value is the sentinel, which is not a boolean.
    () =>
      evaluateCondition(
        { kind: "ref", root: "input", path: ["note"] },
        () => sentinel,
      ),
    // A field read through a scalar that sits under a sentinel-named key.
    () => readFields({ [sentinel]: 5 }, [sentinel, "x"]),
    // An ordering comparison of the sentinel with a number.
    () =>
      evaluateExpression(
        {
          kind: "compare",
          op: "lt",
          left: literal(sentinel),
          right: literal(1),
        },
        read(),
      ),
  ];
  for (const attempt of attempts) {
    const error = assertThrows(attempt, WorkflowInterpreterError);
    assert(!error.message.includes(sentinel));
    assert(!JSON.stringify(error).includes(sentinel));
    assert(!(error.stack ?? "").includes(sentinel));
  }
});
