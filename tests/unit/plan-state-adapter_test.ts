import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type ActionDispatch,
  INTERPRETER_REVISIONS,
  type NextStep,
  pinWorkflowRuntime,
  WorkflowInterpreterError,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import { carriesPlanRuntime } from "../../packages/persistence/src/results.ts";
import {
  nextPlanStep,
  planInputsFromSnapshot,
  type PlanRuntime,
  planRuntimeFromSnapshot,
  PlanStateError,
  type PlanStepRow,
  recordsFromRows,
} from "../../apps/server/src/modules/workflow-adapter/plan-state.ts";
import {
  compiled,
  completed,
  type Dispatch,
  drive,
  noop,
  type Script,
} from "../helpers/workflow-interpreter.ts";

// #30 slice E3a: the server side of running a compiled plan, with no database.
// A run snapshot freezes the plan's document and pin; stored step rows become
// the interpreter's records; the run's own interpreter revision answers.

const planError = (run: () => unknown) =>
  assertThrows(run, PlanStateError).code;

const counter = {
  id: "loop",
  repeat: {
    max: 3,
    seed: { currentCandidate: { n: 0 } },
    until: "$repeat.currentCandidate.n >= 2",
    steps: [noop("bump", { with: { n: "$repeat.currentCandidate.n" } })],
    outputs: { currentCandidate: { n: "$step.loop.bump.next" } },
  },
};

const looping = () =>
  compiled([
    counter,
    noop("report", {
      with: {
        outcome: "$step.loop.outcome",
        iterations: "$step.loop.iterations",
        candidate: "$step.loop.currentCandidate",
      },
    }),
  ]);

const growBump: Script = (step) =>
  step.id === "bump"
    ? completed({
      next: ((step as ActionDispatch).input as { n: number }).n + 1,
    })
    : completed();

/** What admission will write: the frozen document and its pin. */
async function snapshotFor(document: Awaited<ReturnType<typeof looping>>) {
  return {
    schemaVersion: 1,
    inputs: {},
    runtime: { pin: await pinWorkflowRuntime(document), document },
  };
}

/** A snapshot as it comes back from a jsonb column. */
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function runtimeOf(document: Awaited<ReturnType<typeof looping>>) {
  const runtime = await planRuntimeFromSnapshot(
    stored(await snapshotFor(document)),
  );
  assert(runtime !== null);
  return runtime;
}

// --- the snapshot

Deno.test("a run admitted before plans has no runtime and stays on the flat loop", async () => {
  assertEquals(
    await planRuntimeFromSnapshot({ schemaVersion: 1, inputs: {} }),
    null,
  );
});

Deno.test("the persistence marker and the adapter agree on which snapshots belong to a plan", async () => {
  // persistence ends a flat run from its rows and leaves a plan run to the
  // engine; the adapter decides how the engine reads that run. They must
  // never disagree about which kind of run a snapshot describes.
  const valid = stored(await snapshotFor(await looping()));
  const flat: unknown[] = [
    { schemaVersion: 1, inputs: {} },
    {},
    // An inherited key is not the run's own section.
    Object.create({ runtime: valid.runtime }),
  ];
  for (const snapshot of flat) {
    assertEquals(carriesPlanRuntime(snapshot), false);
    assertEquals(await planRuntimeFromSnapshot(snapshot), null);
  }
  const plan: [string, unknown][] = [
    ["a valid runtime", valid],
    ["an empty runtime section", { runtime: {} }],
    ["a null runtime section", { runtime: null }],
    ["a runtime with a half-written pin", { runtime: { pin: {} } }],
  ];
  for (const [name, snapshot] of plan) {
    assertEquals(carriesPlanRuntime(snapshot), true, name);
    const outcome = await planRuntimeFromSnapshot(snapshot).then(
      (runtime) => runtime,
      (error) => error,
    );
    // Never read as a flat run: it resolves, or it is refused by name.
    assert(outcome !== null, name);
  }
  // Not an object: persistence calls it flat, the adapter refuses it by name.
  for (const snapshot of [null, [], "runtime", 3]) {
    assertEquals(carriesPlanRuntime(snapshot), false);
    await assertRejects(
      () => planRuntimeFromSnapshot(snapshot),
      PlanStateError,
    );
  }
});

Deno.test("a plan's runtime survives storage and resolves to the pinned revision", async () => {
  const document = await looping();
  const snapshot = await snapshotFor(document);
  const runtime = await planRuntimeFromSnapshot(stored(snapshot));
  assert(runtime !== null);
  assertEquals(runtime.pin, snapshot.runtime.pin);
  assertEquals(runtime.document, document);
  assert(runtime.interpreter === INTERPRETER_REVISIONS["1"]);
});

Deno.test("a runtime section that is there but wrong is refused by name, never read as legacy", async () => {
  const document = await looping();
  const good = await snapshotFor(document);
  const broken: [string, unknown][] = [
    ["a null snapshot", null],
    ["a list", []],
    ["a string", "runtime"],
    ["runtime null", { inputs: {}, runtime: null }],
    ["runtime empty", { inputs: {}, runtime: {} }],
    ["no document", { inputs: {}, runtime: { pin: good.runtime.pin } }],
    ["no pin", { inputs: {}, runtime: { document } }],
    ["an extra field", { inputs: {}, runtime: { ...good.runtime, extra: 1 } }],
    ["a document that is not one", {
      inputs: {},
      runtime: { pin: good.runtime.pin, document: { not: "a document" } },
    }],
  ];
  for (const [name, snapshot] of broken) {
    let said: unknown;
    try {
      await planRuntimeFromSnapshot(snapshot);
    } catch (error) {
      said = error;
    }
    assert(said instanceof PlanStateError, `${name} was not refused: ${said}`);
    assertEquals(said.code, "plan_snapshot_invalid", name);
  }
  // A pin that is not a pin is the interpreter's refusal.
  const badPin = await assertRejects(
    () =>
      planRuntimeFromSnapshot({
        inputs: {},
        runtime: { pin: { revision: 1 }, document },
      }),
    WorkflowInterpreterError,
  );
  assertEquals(badPin.code, "runtime_pin_invalid");
});

Deno.test("an old run resumes on its pinned revision or is refused, never moved", async () => {
  const document = await looping();
  const snapshot = stored(await snapshotFor(document));

  // The frozen document no longer matches its pin: a change the schema accepts,
  // so only the digest can tell.
  const edited = stored(snapshot);
  edited.runtime.document = {
    ...edited.runtime.document,
    registryVersion: edited.runtime.document.registryVersion + 1,
  };
  const mismatch = await assertRejects(
    () => planRuntimeFromSnapshot(edited),
    WorkflowInterpreterError,
  );
  assertEquals(mismatch.code, "pin_mismatch");

  // The pinned revision is no longer deployed.
  const gone = await assertRejects(
    () =>
      planRuntimeFromSnapshot(snapshot, { "2": () => ({ kind: "finished" }) }),
    WorkflowInterpreterError,
  );
  assertEquals(gone.code, "revision_unavailable");

  // A deploy that adds a revision leaves the old run on the old one.
  const later = { ...INTERPRETER_REVISIONS, "2": () => ({ kind: "finished" }) };
  const kept = await planRuntimeFromSnapshot(snapshot, later as never);
  assert(kept !== null && kept.interpreter === INTERPRETER_REVISIONS["1"]);
});

Deno.test("the frozen inputs are read from the snapshot, and a snapshot without them is refused", () => {
  assertEquals(planInputsFromSnapshot({ inputs: { a: 1, b: "x" } }), {
    a: 1,
    b: "x",
  });
  assertEquals(
    planError(() => planInputsFromSnapshot({})),
    "plan_snapshot_invalid",
  );
  assertEquals(
    planError(() => planInputsFromSnapshot({ inputs: [] })),
    "plan_snapshot_invalid",
  );
  assertEquals(
    planError(() => planInputsFromSnapshot(null)),
    "plan_snapshot_invalid",
  );
});

// --- rows

const row = (
  stepKey: string,
  status: string,
  output: unknown = null,
  iteration = 0,
): PlanStepRow => ({ stepKey, iteration, status, output });

Deno.test("a row becomes a record only once it has a result", () => {
  const records = recordsFromRows([
    row("a", "completed", { x: 1 }),
    row("b", "completed", null),
    // A literal row with no output at all, which a default argument would hide.
    { stepKey: "c", iteration: 0, status: "completed", output: undefined },
    row("d", "failed"),
    row("e", "canceled"),
    row("f", "pending"),
    row("g", "running"),
    row("h", "waiting"),
  ]);
  assertEquals([...records.keys()], ["a", "b", "c", "d", "e"]);
  assertEquals(records.get("a"), { status: "completed", output: { x: 1 } });
  // A completed step with no stored output is a step that produced null.
  assertEquals(records.get("b"), { status: "completed", output: null });
  assertEquals(records.get("c"), { status: "completed", output: null });
  assertEquals(records.get("d"), { status: "failed" });
  assertEquals(records.get("e"), { status: "canceled" });
});

Deno.test("a row that cannot be read as a record is refused, not guessed at", () => {
  assertEquals(
    planError(() => recordsFromRows([row("a", "completed", {}, 1)])),
    "plan_row_invalid",
  );
  assertEquals(
    planError(() =>
      recordsFromRows([row("a", "completed"), row("a", "failed")])
    ),
    "plan_row_invalid",
  );
  // A repeated key is caught even while neither row has a result.
  assertEquals(
    planError(() =>
      recordsFromRows([row("a", "pending"), row("a", "running")])
    ),
    "plan_row_invalid",
  );
  assertEquals(
    planError(() => recordsFromRows([row("a", "skipped")])),
    "plan_row_invalid",
  );
  const error = assertThrows(
    () => recordsFromRows([row("secret-key", "weird-status")]),
    PlanStateError,
  );
  assert(!error.message.includes("secret-key"));
  assert(!error.message.includes("weird-status"));
});

// --- asking the interpreter

/** Plays the engine's part over stored rows, as the engine will: ask, store, ask again. */
function overRows(runtime: PlanRuntime, script: Script) {
  const rows: PlanStepRow[] = [];
  const trace: string[] = [];
  for (let guard = 0; guard < 500; guard += 1) {
    const next = nextPlanStep(runtime, {
      inputs: {},
      task: {},
      rows: stored(rows),
    });
    if (next.kind !== "dispatch") return { next, trace, rows };
    trace.push(next.step.key);
    const result = script(next.step as Dispatch, trace);
    rows.push({
      stepKey: next.step.key,
      iteration: 0,
      status: result.status,
      output: result.status === "completed" ? result.output : null,
    });
  }
  throw new Error("the plan never finished");
}

Deno.test("a plan run through stored rows does exactly what the interpreter does directly", async () => {
  const document = await looping();
  const runtime = await runtimeOf(document);
  for (
    const [name, script] of [
      ["converges", growBump],
      [
        "an iteration times out",
        (step, trace) =>
          step.key === "loop@2.bump"
            ? { status: "timed_out" }
            : growBump(step, trace),
      ],
      [
        "an iteration fails",
        (step, trace) =>
          step.key === "loop@1.bump"
            ? { status: "failed" }
            : growBump(step, trace),
      ],
    ] as [string, Script][]
  ) {
    const direct = drive(document, script);
    const viaRows = overRows(runtime, (step, trace) => {
      const result = script(step, trace);
      // Rows have no timed_out status; a timeout is stored as a failure.
      return result.status === "timed_out" ? { status: "failed" } : result;
    });
    assertEquals(viaRows.trace, direct.trace, name);
    assertEquals(viaRows.next.kind, direct.next.kind, name);
  }
});

Deno.test("a step whose job is still running is asked for again, as the same dispatch", async () => {
  const runtime = await runtimeOf(await looping());
  const first = nextPlanStep(runtime, { inputs: {}, task: {}, rows: [] });
  assert(first.kind === "dispatch");
  const resumed = nextPlanStep(runtime, {
    inputs: {},
    task: {},
    rows: [row(first.step.key, "running")],
  });
  assertEquals(resumed, first);
});

Deno.test("a failure outside a repeat halts, and a requested cancel halts before anything", async () => {
  const document = await compiled([noop("first"), noop("second")]);
  const runtime = await runtimeOf(document);
  const failed: NextStep = nextPlanStep(runtime, {
    inputs: {},
    task: {},
    rows: [row("first", "failed")],
  });
  assertEquals(failed, { kind: "halted", outcome: "failed", key: "first" });
  const canceled = nextPlanStep(runtime, {
    inputs: {},
    task: {},
    rows: [],
    cancelRequested: true,
  });
  assertEquals(canceled, { kind: "halted", outcome: "canceled", key: null });
});

Deno.test("the task and the delivery state the engine supplies are what references read", async () => {
  const document = await compiled([
    noop("read", {
      with: { status: "$task.status", revision: "$delivery.headSha" },
    }),
  ]);
  const runtime = await runtimeOf(document);
  const withBoth = nextPlanStep(runtime, {
    inputs: {},
    task: { status: "running" },
    delivery: { headSha: "abc" },
    rows: [],
  });
  assert(withBoth.kind === "dispatch");
  assertEquals((withBoth.step as ActionDispatch).input, {
    status: "running",
    revision: "abc",
  });
  // Until the engine resolves delivery state, reading it is refused by name.
  const refused = assertThrows(
    () =>
      nextPlanStep(runtime, { inputs: {}, task: { status: "x" }, rows: [] }),
    WorkflowInterpreterError,
  );
  assertEquals(refused.code, "delivery_unresolved");
});
