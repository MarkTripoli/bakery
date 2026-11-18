import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  defineAction,
  defineWorkflow,
  integerInput,
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
