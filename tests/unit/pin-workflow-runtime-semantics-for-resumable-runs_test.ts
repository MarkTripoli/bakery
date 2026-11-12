import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../packages/contracts/src/workflow-compiler/canonical.ts";
import {
  compileWorkflowDocument,
  WORKFLOW_COMPILER_VERSION,
  workflowSemanticDigest,
  type WorkflowSemanticDocument,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  type ActionDispatch,
  CURRENT_INTERPRETER_REVISION,
  INTERPRETER_REVISIONS,
  type NextStep,
  nextStep,
  pinWorkflowRuntime,
  readWorkflowRuntimePin,
  resolveWorkflowRuntime,
  type RunState,
  WorkflowInterpreterError,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import {
  compiled,
  completed,
  type Dispatch,
  drive,
  noop,
  REPO_ID,
  type Script,
  workflow,
} from "../helpers/workflow-interpreter.ts";

// #30 AC3: "Given a deployed runtime revision change and restart, when an old
// run resumes, then its pinned semantics and confirmed outputs remain
// unchanged." A run records the interpreter revision it was admitted under;
// every later deploy keeps that revision available and resumes the run on it.

const DIGEST = "a".repeat(64);

const sample = () =>
  compiled([
    noop("first", { with: { n: 1 } }),
    noop("second", { needs: ["first"], with: { n: "$step.first.n" } }),
  ]);

const grow = (step: Dispatch) =>
  completed({ next: ((step as ActionDispatch).input as { n: number }).n + 1 });

const counter = (until: string, seed = 0) => ({
  id: "loop",
  repeat: {
    max: 3,
    seed: { currentCandidate: { n: seed } },
    until,
    steps: [noop("bump", { with: { n: "$repeat.currentCandidate.n" } })],
    outputs: { currentCandidate: { n: "$step.loop.bump.next" } },
  },
});

// --- the pin

Deno.test("a pin names the compiler version, the interpreter revision and the document's digest", async () => {
  const document = await sample();
  const pin = await pinWorkflowRuntime(document);
  assertEquals(pin, {
    compilerVersion: WORKFLOW_COMPILER_VERSION,
    interpreterRevision: CURRENT_INTERPRETER_REVISION,
    semanticDigest: await workflowSemanticDigest(document),
  });
  assert(Object.hasOwn(INTERPRETER_REVISIONS, pin.interpreterRevision));
  assert(/^[0-9a-f]{64}$/.test(pin.semanticDigest));
});

Deno.test("a pin that is read back must have exactly its three fields", () => {
  const good = {
    compilerVersion: "2",
    interpreterRevision: "1",
    semanticDigest: DIGEST,
  };
  assertEquals(readWorkflowRuntimePin(good), good);
  const bad: unknown[] = [
    null,
    "1",
    [],
    {},
    { ...good, extra: true },
    { ...good, compilerVersion: 2 },
    { ...good, compilerVersion: "" },
    { ...good, interpreterRevision: "" },
    { ...good, interpreterRevision: 1 },
    { ...good, semanticDigest: "A".repeat(64) },
    { ...good, semanticDigest: "a".repeat(63) },
    { ...good, semanticDigest: null },
    { compilerVersion: "2", interpreterRevision: "1" },
  ];
  for (const value of bad) {
    const error = assertThrows(() => readWorkflowRuntimePin(value));
    assert(error instanceof WorkflowInterpreterError);
    assertEquals(error.code, "runtime_pin_invalid");
  }
});

Deno.test("a rejected pin never echoes what it carried", () => {
  const error = assertThrows(
    () =>
      readWorkflowRuntimePin({
        compilerVersion: "2",
        interpreterRevision: "secret-revision-name",
        semanticDigest: "not a digest",
      }),
    WorkflowInterpreterError,
  );
  assert(!error.message.includes("secret-revision-name"));
  assert(!error.message.includes("not a digest"));
});

// --- AC3: a deploy does not change an old run

Deno.test("AC3: a deployed revision change leaves a run pinned to the old revision on the old semantics", async () => {
  const document = await compiled([
    counter("$repeat.currentCandidate.n >= 2"),
    noop("report", { with: { n: "$step.loop.currentCandidate.n" } }),
  ]);
  const pin = await pinWorkflowRuntime(document);
  assertEquals(pin.interpreterRevision, "1");

  // Before the deploy: revision 1 is the only one.
  const before = await resolveWorkflowRuntime(pin, document);
  const baseline = drive(document, (step) => grow(step), {}, before);

  // After the deploy: a revision 2 exists that behaves differently from 1
  // (here it just says the run is done at once). The old run is still pinned
  // to 1, so it resolves to 1 and runs exactly as before.
  const stopsImmediately = (): NextStep => ({ kind: "finished" });
  const deployed = { ...INTERPRETER_REVISIONS, "2": stopsImmediately };
  const after = await resolveWorkflowRuntime(pin, document, deployed);
  const resumed = drive(document, (step) => grow(step), {}, after);
  assertEquals(resumed.trace, baseline.trace);
  assertEquals(resumed.dispatched, baseline.dispatched);
  assertEquals(resumed.next, baseline.next);
  assertNotEquals(baseline.trace.length, 0);

  // A run admitted after the deploy and pinned to 2 gets 2's behavior.
  const newer = await resolveWorkflowRuntime(
    { ...pin, interpreterRevision: "2" },
    document,
    deployed,
  );
  assertEquals(drive(document, grow, {}, newer).trace, []);
});

Deno.test("AC3: a mid-run resume asks the pinned revision and gets the same next step", async () => {
  const document = await sample();
  const pin = await pinWorkflowRuntime(document);
  const steps = new Map([["first", completed({ n: 1 })]]);
  const state = { inputs: {}, task: {}, steps };
  const asked = nextStep(document, state);
  const resolved = await resolveWorkflowRuntime(pin, document);
  // The confirmed output of `first` is read as recorded; `second` is next.
  assertEquals(resolved(document, state), asked);
  assertEquals(asked.kind, "dispatch");
  assertEquals(
    asked.kind === "dispatch" && (asked.step as ActionDispatch).input,
    { n: 1 },
  );
});

Deno.test("a pin to a revision that is no longer deployed is refused, never run on the current one", async () => {
  const document = await sample();
  const pin = await pinWorkflowRuntime(document);
  const retired = { "2": () => ({ kind: "finished" }) as NextStep };
  const error = await assertRejects(() =>
    resolveWorkflowRuntime(pin, document, retired)
  );
  assert(error instanceof WorkflowInterpreterError);
  assertEquals(error.code, "revision_unavailable");
  assert(!error.message.includes(pin.interpreterRevision + pin.semanticDigest));
});

Deno.test("inherited names are not revisions", async () => {
  const document = await sample();
  const pin = await pinWorkflowRuntime(document);
  for (
    const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]
  ) {
    const error = await assertRejects(() =>
      resolveWorkflowRuntime({ ...pin, interpreterRevision: name }, document)
    );
    assert(error instanceof WorkflowInterpreterError);
    assertEquals(error.code, "revision_unavailable");
  }
});

Deno.test("a document that no longer matches its pin is refused", async () => {
  const document = await sample();
  const pin = await pinWorkflowRuntime(document);
  const edited = await compiled([
    noop("first", { with: { n: 2 } }),
    noop("second", { needs: ["first"], with: { n: "$step.first.n" } }),
  ]);
  const wrongDigest = await assertRejects(() =>
    resolveWorkflowRuntime(pin, edited)
  );
  assert(wrongDigest instanceof WorkflowInterpreterError);
  assertEquals(wrongDigest.code, "pin_mismatch");

  const wrongCompiler = await assertRejects(() =>
    resolveWorkflowRuntime({ ...pin, compilerVersion: "1" }, document)
  );
  assert(wrongCompiler instanceof WorkflowInterpreterError);
  assertEquals(wrongCompiler.code, "pin_mismatch");
});

// --- a released revision is frozen

// Revision 1 is released once a run can be pinned to it. Changing how it
// behaves would change the semantics of every run already admitted under it, so
// a behavior change must add revision 2 and leave 1 as it is. This corpus runs a
// spread of workflows through revision 1 and pins what it dispatches.
async function corpusDigest(): Promise<string> {
  const results: unknown[] = [];
  const revision = INTERPRETER_REVISIONS["1"]!;
  // Records everything revision 1 dispatches for one run, or the refusal it
  // makes instead; a different answer to either changes the digest.
  const play = (
    document: WorkflowSemanticDocument,
    script: Script,
    over: Partial<RunState> = {},
  ) => {
    try {
      const run = drive(document, script, over, revision);
      results.push({
        trace: run.trace,
        dispatched: run.dispatched,
        next: run.next,
      });
    } catch (error) {
      if (!(error instanceof WorkflowInterpreterError)) throw error;
      results.push({ refused: error.code });
    }
  };
  const bumpOnly: Script = (step) =>
    step.id === "bump" ? grow(step) : completed();

  // Repeats: converging, a clean seed (zero iterations), exhausted, and each
  // way an iteration can end without completing.
  const report = noop("report", {
    with: {
      outcome: "$step.loop.outcome",
      iterations: "$step.loop.iterations",
      candidate: "$step.loop.currentCandidate",
    },
  });
  play(
    await compiled([counter("$repeat.currentCandidate.n >= 2"), report]),
    bumpOnly,
  );
  play(
    await compiled([counter("$repeat.currentCandidate.n >= 2", 5), report]),
    bumpOnly,
  );
  play(
    await compiled([
      counter("$repeat.currentCandidate.n >= 99"),
      noop("deliver", {
        needs: ["loop"],
        if: '$step.loop.outcome == "completed"',
      }),
      report,
    ]),
    bumpOnly,
  );
  const unmet = await compiled([
    counter("$repeat.currentCandidate.n >= 99"),
    report,
  ]);
  for (const status of ["failed", "canceled", "timed_out"] as const) {
    play(
      unmet,
      (step) => step.key === "loop@2.bump" ? { status } : bumpOnly(step, []),
    );
  }

  // A step outside a repeat that does not complete, and a canceled run.
  const plain = await compiled([
    noop("first", { with: { n: 1 } }),
    noop("second", { needs: ["first"], with: { n: "$step.first.n" } }),
  ]);
  play(plain, () => ({ status: "failed" }));
  play(plain, () => completed({ n: 1 }), { cancelRequested: true });

  // Seeds written as steps: keyed @0, a clean seed, and a seed step that fails.
  const sequenceSeed = (extra: Record<string, unknown> = {}) => ({
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
      ...extra,
    },
  });
  const afterSeed = noop("after", {
    with: { c: "$step.loop.currentCandidate", i: "$step.loop.iterations" },
  });
  const seeded = await compiled([sequenceSeed(), afterSeed]);
  play(
    seeded,
    (step) => step.id === "prepare" ? completed({ value: 7 }) : completed(),
  );
  play(seeded, () => ({ status: "failed" }));
  play(
    await compiled([
      sequenceSeed({ until: "$repeat.currentCandidate.n >= 9" }),
      afterSeed,
    ]),
    (step) => step.id === "prepare" ? completed({ value: 7 }) : completed(),
  );

  // Nested repeats: every level keyed, `$repeat` is the innermost accumulator,
  // and in a seed it is the repeat around it.
  const nested = await compiled([{
    id: "outer",
    repeat: {
      max: 2,
      seed: { currentCandidate: { total: 0 } },
      until: "$repeat.currentCandidate.total >= 4",
      steps: [{
        id: "inner",
        repeat: {
          max: 2,
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
  play(nested, (step) =>
    completed({
      next: ((step as ActionDispatch).input as { t: number }).t + 1,
    }));
  const outerInSeed = await compiled([{
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
            steps: [noop("probe", {
              with: { outer_total: "$repeat.currentCandidate.total" },
            })],
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
  play(
    outerInSeed,
    (step) => step.id === "probe" ? completed({ seen: 42 }) : completed(),
  );

  // Branches, conditions, skips, waits.
  const branched = await compiled([
    {
      id: "choose",
      branch: {
        when: '$input.mode == "a"',
        then: [noop("left")],
        else: [noop("right")],
        outputs: {
          picked: { then: "$step.choose.left.v", else: "$step.choose.right.v" },
        },
      },
    },
    noop("use", { with: { p: "$step.choose.picked" } }),
  ], { mode: { type: "string", required: true } });
  for (const mode of ["a", "b"]) {
    play(branched, (step) => completed({ v: step.id }), { inputs: { mode } });
  }
  const skipped = await compiled([
    noop("gate", { if: '$input.mode == "full"' }),
    noop("needs_gate", { needs: ["gate"] }),
    noop("independent"),
    { id: "pause", wait: { duration: "5m" } },
    { id: "answer", wait: { event: "question.answered", timeout: "1h" } },
    noop("tail", { needs: ["needs_gate"] }),
  ], { mode: { type: "string", required: true } });
  for (const mode of ["full", "quick"]) {
    play(skipped, () => completed(), { inputs: { mode } });
  }

  // Expressions over what a step recorded: no coercion, a missing field is
  // null, the connectives stop at the operand that decides, and a type the
  // operator does not take is refused rather than guessed at.
  const recorded = completed({
    ok: false,
    yes: true,
    n: 1,
    s: "1",
    list: [1, 2],
  });
  for (
    const condition of [
      "$step.probe.n == $step.probe.s",
      "$step.probe.n != $step.probe.s",
      "$step.probe.n < $step.probe.s",
      "$step.probe.n < 3",
      "$step.probe.absent == null",
      "$step.probe.absent.deeper == null",
      "$step.probe.ok && $step.probe.n > $step.probe.s",
      "$step.probe.yes && $step.probe.n > $step.probe.s",
      "$step.probe.yes || $step.probe.n > $step.probe.s",
      "$step.probe.ok || $step.probe.n > $step.probe.s",
      "!$step.probe.ok",
      "!$step.probe.n",
      "$step.probe.n in $step.probe.list",
      "$step.probe.n in $step.probe.s",
      "$step.probe.n",
    ]
  ) {
    const result = await compileWorkflowDocument(workflow([
      noop("probe"),
      noop("guarded", { needs: ["probe"], if: condition }),
    ]));
    assert(result.ok, `corpus condition must compile: ${condition}`);
    play(
      result.document,
      (step) => step.id === "probe" ? recorded : completed(),
    );
  }

  // What an action carries: checks, an effect key, an agent version, policy;
  // and an effect key part that is not a scalar.
  const agent = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const extras = await compiled([
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
  play(
    extras,
    (step) =>
      step.id === "seed"
        ? completed({ plan: "p", sha: "abc", candidate: { s: 1 } })
        : completed(),
    { inputs: { repo: REPO_ID, revision: 7 } },
  );
  const objectKey = await compiled([
    noop("seed"),
    {
      id: "ship",
      uses: "delivery.merge",
      with: { repositoryId: "x", candidate: "y" },
      effectKey: ["merge", "$step.seed.object"],
    },
  ]);
  play(
    objectKey,
    (step) => completed(step.id === "seed" ? { object: { a: 1 } } : {}),
  );

  // Delivery state, resolved by the host or not yet.
  const delivery = await compiled([
    noop("check", { with: { revision: "$delivery.headSha" } }),
  ]);
  play(delivery, () => completed());
  play(delivery, () => completed(), { delivery: { headSha: "abc" } });

  return await sha256Hex(canonicalJson(results));
}

const REVISION_1_CORPUS_DIGEST =
  "e55184326cec05e77125ac300decdb70c97379c1128bd552b8e379c83595fb2e";

Deno.test("interpreter revision 1 is frozen: its behavior on the corpus is unchanged", async () => {
  assertEquals(
    await corpusDigest(),
    REVISION_1_CORPUS_DIGEST,
    "Interpreter revision 1 changed behavior. A run already admitted under " +
      "revision 1 would resume on different semantics. Add revision 2 to " +
      "INTERPRETER_REVISIONS with the new behavior and keep revision 1 as it was.",
  );
});
