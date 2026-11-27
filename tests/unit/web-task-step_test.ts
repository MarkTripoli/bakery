import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  definitionOf,
  editorReducer,
  editorStateOf,
} from "../../apps/web/src/pages/library/editor-state.ts";
import { compileWorkflowDocumentDetailed } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";
import { parseFreeformTimeout } from "../../apps/worker/src/harness-freeform.ts";
import { CLAUDE_FREEFORM_TOOLS } from "../../apps/worker/src/claude-harness.ts";
import {
  NEW_TASK,
  TASK_MINUTES,
  TASK_TOOLS,
  taskInput,
  taskOfNode,
  taskProblems,
} from "../../apps/web/src/pages/library/task-step.ts";

const filled = { ...NEW_TASK, prompt: "Summarise the plan for $5." };

Deno.test("what the panel writes reads back, compiles and is bounded for a worker", async () => {
  for (const minutes of TASK_MINUTES) {
    const fields = { ...filled, minutes };
    const input = taskInput(fields);
    assertEquals(taskOfNode({ with: input }), fields);
    assertEquals(parseFreeformTimeout(input.timeout), minutes * 60_000);
    const compiled = await compileWorkflowDocumentDetailed({
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "task",
      steps: [{ id: "task", uses: "agent.freeform", with: input }],
    }, { catalog: defaultWorkflowCompilerCatalog() });
    assertEquals(compiled.result.ok, true, String(minutes));
  }
});

Deno.test("the tools offered are the ones a worker offers", () => {
  assertEquals([...TASK_TOOLS], [...CLAUDE_FREEFORM_TOOLS]);
});

Deno.test("missing instructions and out of range limits are problems", () => {
  assertEquals(taskProblems(filled), []);
  assertEquals(
    taskProblems({ ...NEW_TASK, turns: "51", cost: "1.234" }).map((one) =>
      one.field
    ),
    ["prompt", "turns", "cost"],
  );
});

Deno.test("a task nobody edited keeps its authored node, and an edit saves what the field shows", () => {
  const authored = {
    id: "task",
    uses: "agent.freeform",
    with: { ...taskInput(filled), timeout: "30m" },
  };
  const held = taskOfNode(authored)!;
  const step = {
    id: "task",
    uses: "agent.freeform",
    agentVersionId: null,
    skills: [],
    task: held,
  };
  const spec = { steps: [authored] };
  assertStrictEquals(
    (definitionOf(spec, [step]).steps as unknown[])[0],
    authored,
  );
  const edited = editorReducer(editorStateOf([step]), {
    kind: "task",
    id: "task",
    task: { ...held, turns: "200" },
  });
  const [saved] = definitionOf(spec, edited.steps).steps as {
    with: Record<string, unknown>;
  }[];
  assertEquals(saved.with.maxTurns, 200);
  assertEquals(saved.with.timeout, "PT30M");
});

Deno.test("input the panel cannot show is left to code", () => {
  for (
    const extra of [
      { allowedTools: ["Bash"] },
      { timeout: "soon" },
      { maxTurns: "$input.turns" },
    ]
  ) {
    assertEquals(
      taskOfNode({ with: { ...taskInput(filled), ...extra } }),
      null,
    );
  }
});
