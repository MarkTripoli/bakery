import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  defineAction,
  defineWorkflow,
  integerInput,
  type StepsBuilder,
  stringInput,
  uuidInput,
} from "../../packages/workflow-sdk/mod.ts";
import {
  compileWorkflowDocument,
  decodeWorkflowYaml,
  encodeWorkflowYaml,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import type { WorkflowJsonValue } from "../../packages/contracts/src/workflow-compiler/json-value.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

// #35 slice 4: the typed SDK builds data. What it emits is the document the
// compiler, the YAML importer and the REST API already read, so the checks here
// are about equality with those, not about a second validator.
const taskBrief = defineAction<
  { brief: unknown; repositoryId: string },
  { artifact: { versionId: string } }
>("task.brief");
const implement = defineAction<
  { repositoryId: string; planArtifact: string; instructions: string },
  { candidate: { headSha: string } }
>("harness.implement");

function fixedCoding() {
  const w = defineWorkflow({
    name: "sdk-fixed-coding",
    description: "Freeze the task brief, then implement it.",
    inputs: {
      repositoryId: uuidInput(),
      brief: { type: "TaskBrief", required: true },
      instructions: stringInput(),
    },
  });
  const brief = w.action("brief", taskBrief, {
    brief: w.input("brief"),
    repositoryId: w.input("repositoryId"),
  });
  w.action("implement", implement, {
    repositoryId: w.input("repositoryId"),
    planArtifact: brief.output("artifact.versionId"),
    instructions: w.input("instructions"),
  });
  return w;
}

const HAND_WRITTEN_YAML = [
  "apiVersion: bakery.dev/v1",
  "kind: workflow",
  "name: sdk-fixed-coding",
  "description: Freeze the task brief, then implement it.",
  "inputs:",
  "  repositoryId: { type: uuid, required: true }",
  "  brief: { type: TaskBrief, required: true }",
  "  instructions: { type: string, required: true }",
  "steps:",
  "  - id: brief",
  "    uses: task.brief",
  "    with:",
  "      brief: $input.brief",
  "      repositoryId: $input.repositoryId",
  "  - id: implement",
  "    needs: [brief]",
  "    uses: harness.implement",
  "    with:",
  "      repositoryId: $input.repositoryId",
  "      planArtifact: $step.brief.artifact.versionId",
  "      instructions: $input.instructions",
  "",
].join("\n");

Deno.test("the builder's output equals the decoded YAML of the same workflow", () => {
  const built = fixedCoding().toJSON();
  const decoded = decodeWorkflowYaml(HAND_WRITTEN_YAML);
  assert(decoded.ok);
  assertEquals(built as unknown, decoded.value as unknown);
});

Deno.test("the builder's output survives export to YAML and import back unchanged", () => {
  const built = fixedCoding().toJSON();
  const exported = encodeWorkflowYaml(built as unknown as WorkflowJsonValue);
  assert(exported.ok);
  const imported = decodeWorkflowYaml(exported.text);
  assert(imported.ok);
  assertEquals(imported.value as unknown, built as unknown);
});

Deno.test("the builder's output compiles against the real catalog", async () => {
  const result = await compileWorkflowDocument(
    fixedCoding().toJSON() as unknown,
    {
      catalog: defaultWorkflowCompilerCatalog(),
    },
  );
  assert(
    result.ok,
    result.ok ? "" : JSON.stringify(result.diagnostics),
  );
});

Deno.test("the output is inert plain JSON: it serializes to itself and cannot be mutated", () => {
  const built = fixedCoding().toJSON();
  assertEquals(JSON.parse(JSON.stringify(built)), built);
  assert(Object.isFrozen(built) && Object.isFrozen(built.steps));
  assertThrows(() => {
    (built.steps as unknown as unknown[]).push({});
  }, TypeError);
});

Deno.test("dependencies come from the references, in declaration order", () => {
  const built = fixedCoding().toJSON();
  assertEquals(built.steps[0]!.needs, undefined);
  assertEquals(built.steps[1]!.needs, ["brief"]);
  // An explicit `needs` adds an ordering with no data between the steps.
  const w = defineWorkflow({ name: "ordered", inputs: {} });
  const first = w.action("first", "task.brief", {});
  w.action("second", "task.brief", {}, { needs: [first] });
  assertEquals(w.toJSON().steps[1]!.needs, ["first"]);
});

Deno.test("a duplicate id, an undeclared read and a foreign step are refused at build time", () => {
  const w = defineWorkflow({ name: "guards", inputs: { x: uuidInput() } });
  w.action("a", "task.brief", {});
  assertThrows(() => w.action("a", "task.brief", {}), Error, "already used");
  assertThrows(
    () => w.action("b", "task.brief", { v: "$step.missing.artifact" }),
    Error,
    "not declared before it",
  );
  const other = defineWorkflow({ name: "other", inputs: {} });
  const foreign = other.action("z", "task.brief", {});
  assertThrows(
    () => w.action("c", "task.brief", {}, { needs: [foreign] }),
    Error,
    "another workflow",
  );
  assertThrows(
    // @ts-expect-error "nope" is not a declared input
    () => w.input("nope"),
    Error,
    "not declared",
  );
});

Deno.test("only a whole string that begins with $step. is a reference; mid-text mentions stay text", () => {
  const w = defineWorkflow({ name: "text", inputs: {} });
  w.action("a", "task.brief", { note: "see $step.ghost for details" });
  assertEquals(w.toJSON().steps[0]!.with, {
    note: "see $step.ghost for details",
  });
  assertEquals(w.toJSON().steps[0]!.needs, undefined);
  assertThrows(
    () => w.action("b", "task.brief", { note: "$step.ghost.output" }),
    Error,
    "not declared before it",
  );
});

Deno.test("a function or symbol binding is refused, not dropped", () => {
  const w = defineWorkflow({ name: "data", inputs: {} });
  assertThrows(
    () => w.action("a", "task.brief", { run: () => 1 }),
    Error,
    "holds no callback",
  );
  assertThrows(
    () => w.action("b", "task.brief", { nested: { list: [Symbol("x")] } }),
    Error,
    "/nested/list/0",
  );
  assertEquals(w.toJSON().steps.length, 0);
});

Deno.test("types: a reference of the wrong type is a compile-time error", () => {
  const w = defineWorkflow({
    name: "types",
    inputs: { repositoryId: uuidInput() },
  });
  const brief = w.action("brief", taskBrief, {
    brief: "x",
    repositoryId: w.input("repositoryId"),
  });
  // Fine: a string output into a string input.
  w.action("ok", implement, {
    repositoryId: w.input("repositoryId"),
    planArtifact: brief.output("artifact.versionId"),
    instructions: "do it",
  });
  // @ts-expect-error the brief step has no output at this path
  brief.output("artifact.nope");
  const impl = w.action("impl", implement, {
    repositoryId: w.input("repositoryId"),
    planArtifact: "p",
    instructions: "i",
  });
  const count = defineWorkflow({
    name: "count",
    inputs: { n: integerInput() },
  }).input("n");
  // @ts-expect-error a reference to a number is not a string
  w.action("wrong-type", taskBrief, {
    brief: "x",
    repositoryId: count,
  });
  assertEquals(impl.id, "impl");
});

// #417: a forEach is data too. The body callback runs once, at build time, and
// what it declares is the loop's steps; `item` reads `$each.<as>`.
const prepareBatch = defineAction<
  { repositoryId: string },
  { cases: { id: string; prompt: string }[] }
>("harness.implement");
const runCase = defineAction<
  { repositoryId: string; planArtifact: string; instructions: string },
  { candidate: { headSha: string } }
>("harness.implement");

function evaluationBatch() {
  const w = defineWorkflow({
    name: "sdk-evaluation-batch",
    description: "Prepare a batch, then run each case.",
    inputs: { repositoryId: uuidInput() },
  });
  const prepare = w.action("prepare", prepareBatch, {
    repositoryId: w.input("repositoryId"),
  });
  const cases = w.forEach(
    "cases",
    prepare.output("cases"),
    { max: 12, as: "case" },
    (steps, item) => {
      const run = steps.action("run_case", runCase, {
        repositoryId: w.input("repositoryId"),
        planArtifact: item.field("id"),
        instructions: item.field("prompt"),
      });
      steps.action("grade", "workflow.noop", {
        head: run.output("candidate.headSha"),
        prepared: prepare.output("cases"),
      });
    },
  );
  w.action("report", "workflow.noop", {
    ran: cases.iterations(),
    outcome: cases.outcome(),
  });
  return w;
}

Deno.test("a forEach builds the document the compiler reads, with needs from the data", () => {
  assertEquals(evaluationBatch().toJSON().steps as unknown, [
    {
      id: "prepare",
      uses: "harness.implement",
      with: { repositoryId: "$input.repositoryId" },
    },
    {
      id: "cases",
      needs: ["prepare"],
      forEach: {
        items: "$step.prepare.cases",
        max: 12,
        as: "case",
        steps: [
          {
            id: "run_case",
            uses: "harness.implement",
            with: {
              repositoryId: "$input.repositoryId",
              planArtifact: "$each.case.id",
              instructions: "$each.case.prompt",
            },
          },
          {
            id: "grade",
            needs: ["run_case"],
            uses: "workflow.noop",
            with: {
              head: "$step.cases.run_case.candidate.headSha",
              prepared: "$step.prepare.cases",
            },
          },
        ],
      },
    },
    {
      id: "report",
      needs: ["cases"],
      uses: "workflow.noop",
      with: {
        ran: "$step.cases.iterations",
        outcome: "$step.cases.outcome",
      },
    },
  ]);
});

Deno.test("a forEach built by the SDK compiles and survives YAML", async () => {
  const built = evaluationBatch().toJSON();
  const result = await compileWorkflowDocument(built as unknown);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  assertEquals(result.document.steps[1]?.kind, "forEach");
  const exported = encodeWorkflowYaml(built as unknown as WorkflowJsonValue);
  assert(exported.ok);
  const imported = decodeWorkflowYaml(exported.text);
  assert(imported.ok);
  assertEquals(imported.value as unknown, built as unknown);
});

// #439: a forEach may run iterations together and collect one value from each.
Deno.test("a forEach with maxConcurrency and collect builds, compiles and reads its results", async () => {
  const w = defineWorkflow({
    name: "sdk-fan-out",
    description: "Run each case two at a time and gather what each says.",
    inputs: { repositoryId: uuidInput() },
  });
  const prepare = w.action("prepare", prepareBatch, {
    repositoryId: w.input("repositoryId"),
  });
  const cases = w.forEach(
    "cases",
    prepare.output("cases"),
    { max: 6, as: "case", maxConcurrency: 2 },
    (steps, item) => {
      steps.action("check_case", "workflow.noop", { id: item.field("id") });
      return { collect: { id: item.field("id") } };
    },
  );
  w.action("report", "workflow.noop", { all: cases.results() });
  const built = w.toJSON();
  assertEquals(
    (built.steps[1] as { forEach: Record<string, unknown> }).forEach[
      "maxConcurrency"
    ],
    2,
  );
  assertEquals(
    (built.steps[1] as { forEach: Record<string, unknown> }).forEach[
      "collect"
    ],
    { id: "$each.case.id" },
  );
  assertEquals((built.steps[2] as { with: unknown }).with, {
    all: "$step.cases.results",
  });
  const result = await compileWorkflowDocument(built as unknown);
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
});

Deno.test("results are refused at build time for a loop that collects nothing", () => {
  const w = defineWorkflow({
    name: "sdk-no-collect",
    description: "A loop with nothing collected.",
    inputs: {},
  });
  const loop = w.forEach("cases", ["a"], { max: 2, as: "case" }, (steps) => {
    steps.action("one", "workflow.noop", {});
  });
  assertThrows(() => loop.results(), Error, "collects nothing");
});

Deno.test("a forEach is refused at build time when its body is empty, misplaced or misnamed", () => {
  const w = defineWorkflow({ name: "loops", inputs: {} });
  w.action("prepare", "task.brief", {});
  assertThrows(
    () => w.forEach("empty", ["a"], { max: 2, as: "item" }, () => {}),
    Error,
    "has no steps",
  );
  assertThrows(
    () =>
      w.forEach("bad", ["a"], { max: 2, as: "Item" }, (steps) => {
        steps.action("x", "task.brief", {});
      }),
    Error,
    "not an item name",
  );
  assertThrows(
    () =>
      w.forEach("outer", ["a"], { max: 2, as: "item" }, (steps) => {
        steps.forEach("inner", ["b"], { max: 2, as: "item" }, (inner) => {
          inner.action("x", "task.brief", {});
        });
      }),
    Error,
    "reuses the item name",
  );
  // A step of the workflow cannot be added from inside a body, nor a body step
  // after the body returned.
  let escaped: StepsBuilder | null = null;
  assertThrows(
    () =>
      w.forEach("mixed", ["a"], { max: 2, as: "item" }, (steps) => {
        escaped = steps;
        w.action("outside", "task.brief", {});
      }),
    Error,
    "only inside its body",
  );
  assertThrows(
    () => escaped!.action("late", "task.brief", {}),
    Error,
    "only inside its body",
  );
  // A body step reads only steps declared before it, in the body or outside.
  const loop = w.forEach("ok", ["a", "b"], {
    max: 2,
    as: "item",
  }, (steps) => {
    steps.action("inside", "task.brief", {});
  });
  assertThrows(
    () =>
      w.forEach("reads", ["a"], { max: 2, as: "item" }, (steps) => {
        steps.action("first", "task.brief", { v: "$step.reads.second.x" });
        steps.action("second", "task.brief", {});
      }),
    Error,
    "not declared before it",
  );
  assertEquals(loop.id, "ok");
});

Deno.test("types: a forEach item is typed by the list it walks", () => {
  const w = defineWorkflow({
    name: "loop-types",
    inputs: { repositoryId: uuidInput() },
  });
  const prepare = w.action("prepare", prepareBatch, {
    repositoryId: w.input("repositoryId"),
  });
  w.forEach("cases", prepare.output("cases"), { max: 4, as: "case" }, (
    steps,
    item,
  ) => {
    steps.action("ok", runCase, {
      repositoryId: w.input("repositoryId"),
      planArtifact: item.field("id"),
      instructions: item.field("prompt"),
    });
    // @ts-expect-error the item has no field at this path
    item.field("nope");
  });
  const count = defineWorkflow({
    name: "count",
    inputs: { n: integerInput() },
  }).input("n");
  assertThrows(() =>
    // @ts-expect-error a reference to a number is not a list
    w.forEach("numbers", count, { max: 2, as: "n" }, () => {})
  );
});
