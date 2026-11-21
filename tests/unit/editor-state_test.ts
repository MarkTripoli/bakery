import { assert, assertEquals } from "@std/assert";
import {
  canRedo,
  canUndo,
  definitionOf,
  editorReducer,
  type EditorState,
  editorStateOf,
  type EditorStep,
  freeStepId,
  isDirty,
} from "../../apps/web/src/pages/library/editor-state.ts";

const step = (id: string, uses = "task.brief"): EditorStep => ({
  id,
  uses,
  agentVersionId: null,
});

const START = [step("brief"), step("implement", "harness.implement")];

const apply = (
  state: EditorState,
  ...actions: Parameters<typeof editorReducer>[1][]
) => actions.reduce(editorReducer, state);

const ids = (state: EditorState) => state.steps.map((one) => one.id);

Deno.test("a fresh editor has the version's steps and nothing to undo", () => {
  const state = editorStateOf(START);
  assertEquals(ids(state), ["brief", "implement"]);
  assert(!isDirty(state));
  assert(!canUndo(state));
  assert(!canRedo(state));
});

Deno.test("adding a step appends it and makes the editor dirty", () => {
  const state = apply(editorStateOf(START), {
    kind: "add",
    step: step("review", "agent.review"),
  });
  assertEquals(ids(state), ["brief", "implement", "review"]);
  assert(isDirty(state));
  assert(canUndo(state));
});

Deno.test("removing a step takes it out wherever it sits", () => {
  const state = apply(editorStateOf(START), {
    kind: "remove",
    id: "brief",
  });
  assertEquals(ids(state), ["implement"]);
});

Deno.test("removing a step that is not there records no history", () => {
  const start = editorStateOf(START);
  assertEquals(apply(start, { kind: "remove", id: "nope" }), start);
});

Deno.test("moving a step puts it at the index it ends up in, clamped, never lost", () => {
  const three = editorStateOf([step("a"), step("b"), step("c")]);
  assertEquals(ids(apply(three, { kind: "move", id: "c", index: 0 })), [
    "c",
    "a",
    "b",
  ]);
  assertEquals(ids(apply(three, { kind: "move", id: "a", index: 2 })), [
    "b",
    "c",
    "a",
  ]);
  assertEquals(ids(apply(three, { kind: "move", id: "a", index: 99 })), [
    "b",
    "c",
    "a",
  ]);
  assertEquals(ids(apply(three, { kind: "move", id: "a", index: -5 })), [
    "a",
    "b",
    "c",
  ]);
});

Deno.test("moving a step where it already is records no history", () => {
  const three = editorStateOf([step("a"), step("b"), step("c")]);
  const same = apply(three, { kind: "move", id: "b", index: 1 });
  assertEquals(same, three);
  assert(!isDirty(same));
});

Deno.test("undo returns the last change and redo puts it back", () => {
  const edited = apply(editorStateOf(START), {
    kind: "add",
    step: step("review", "agent.review"),
  });
  const undone = editorReducer(edited, { kind: "undo" });
  assertEquals(ids(undone), ["brief", "implement"]);
  assert(!isDirty(undone));
  assert(canRedo(undone));
  const redone = editorReducer(undone, { kind: "redo" });
  assertEquals(ids(redone), ["brief", "implement", "review"]);
  assert(isDirty(redone));
  assert(!canRedo(redone));
});

Deno.test("undo walks the history back one change at a time", () => {
  const state = apply(
    editorStateOf(START),
    { kind: "add", step: step("review", "agent.review") },
    { kind: "remove", id: "brief" },
    { kind: "move", id: "review", index: 0 },
  );
  assertEquals(ids(state), ["review", "implement"]);
  const one = editorReducer(state, { kind: "undo" });
  assertEquals(ids(one), ["implement", "review"]);
  const two = editorReducer(one, { kind: "undo" });
  assertEquals(ids(two), ["brief", "implement", "review"]);
  const three = editorReducer(two, { kind: "undo" });
  assertEquals(ids(three), ["brief", "implement"]);
  assert(!isDirty(three));
  // At the start, undo changes nothing.
  assertEquals(editorReducer(three, { kind: "undo" }), three);
});

Deno.test("a new change after an undo drops what could have been redone", () => {
  const undone = editorReducer(
    apply(editorStateOf(START), {
      kind: "add",
      step: step("review", "agent.review"),
    }),
    { kind: "undo" },
  );
  const withOther = apply(undone, { kind: "remove", id: "implement" });
  assertEquals(ids(withOther), ["brief"]);
  assert(!canRedo(withOther));
});

Deno.test("a step added to a list that already uses its id gets a free one", () => {
  const state = editorStateOf([step("step"), step("step-2")]);
  assertEquals(freeStepId(state, "step"), "step-3");
  assertEquals(freeStepId(state, "review"), "review");
});

const SEALED = {
  kind: "action",
  id: "implement",
  uses: "harness.implement",
  sealed: true,
  files: { read: ["src/**"], write: ["src/app.ts"] },
};
const FILES_ONLY = {
  id: "review",
  uses: "agent.review",
  files: { read: ["docs/**"] },
};
const SPEC = {
  name: "ship",
  steps: [{ id: "brief", uses: "task.brief" }, SEALED, FILES_ONLY],
};
const savedStep = (saved: Record<string, unknown>, id: string) =>
  (saved.steps as Record<string, unknown>[]).find((one) => one.id === id);
const editorStepsOf = (spec: typeof SPEC) =>
  spec.steps.map((node) => step(node.id, node.uses));

Deno.test("editing a neighbouring step keeps its unknown keys exactly", () => {
  const start = editorStateOf(editorStepsOf(SPEC));
  const edits: Parameters<typeof editorReducer>[1][] = [
    { kind: "move", id: "brief", index: 2 },
    { kind: "add", step: step("notify", "chat.notify") },
    { kind: "remove", id: "brief" },
  ];
  for (const action of edits) {
    const saved = definitionOf(SPEC, apply(start, action).steps);
    assertEquals(savedStep(saved, "implement"), SEALED);
    assertEquals(savedStep(saved, "review"), FILES_ONLY);
    assertEquals(saved.name, "ship");
  }
});

Deno.test("a changed step keeps the keys the editor does not hold", () => {
  const saved = definitionOf(SPEC, [
    step("implement", "harness.other"),
  ]);
  assertEquals(savedStep(saved, "implement"), {
    ...SEALED,
    uses: "harness.other",
  });
});

Deno.test("a new step carries only what the editor knows", () => {
  const saved = definitionOf(null, [step("brief")]);
  assertEquals(saved, { steps: [{ id: "brief", uses: "task.brief" }] });
});

Deno.test("editing step A saves step B and the top-level keys byte-for-byte", () => {
  const b = {
    id: "b",
    uses: "agent.review",
    agentVersionId: "agent-v1",
    if: "${{ steps.a.outcome == 'success' }}",
    retry: { attempts: 3, backoff: "exponential" },
    needs: ["a"],
    limits: { timeoutSeconds: 600, maxTokens: 2000 },
    checks: [{ kind: "exit", equals: 0 }],
    effectKey: "review-${{ run.id }}",
    files: { read: ["src/**"], write: ["out/report.md"] },
    sealed: true,
  };
  const spec = {
    name: "ship",
    version: 2,
    inputs: { branch: { type: "string" } },
    steps: [{ id: "a", uses: "task.brief", agentVersionId: "agent-v1" }, b],
    outputs: { report: "${{ steps.b.output }}" },
  };
  const { steps: _steps, ...top } = spec;
  const start = editorStateOf([
    { ...step("a", "task.brief"), agentVersionId: "agent-v1" },
    { ...step("b", "agent.review"), agentVersionId: "agent-v1" },
  ]);
  const edits: EditorStep[][] = [
    [
      { ...step("a", "task.brief"), agentVersionId: "agent-v2" },
      start.steps[1],
    ],
    [
      { ...step("a2", "task.brief"), agentVersionId: "agent-v1" },
      start.steps[1],
    ],
    [start.steps[1], start.steps[0]],
  ];
  for (const steps of edits) {
    const saved = definitionOf(spec, steps);
    assertEquals(JSON.stringify(savedStep(saved, "b")), JSON.stringify(b));
    const { steps: _saved, ...savedTop } = saved;
    assertEquals(JSON.stringify(savedTop), JSON.stringify(top));
  }
});
