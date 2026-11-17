import { assert, assertEquals } from "@std/assert";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

// #403: a step declares the skills it adds, the role it runs as, and the named
// input and output slots it reads and must publish. These are node fields, so
// they are digest-bearing data the compiler validates rather than passes
// through: a malformed slot, a repeated name or a non-identifier skill version
// is a diagnostic, never a silently dropped field.

const SKILL_A = "11111111-1111-4111-8111-111111111111";
const SKILL_B = "22222222-2222-4222-8222-222222222222";
const REPO = "$input.repositoryId";

type Step = Record<string, unknown>;

const INPUTS = {
  repositoryId: { type: "uuid", required: true },
  brief: { type: "TaskBrief", required: true },
  instructions: { type: "string", required: true },
};

function workflow(steps: Step[]) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "compiler-step-fields",
    description: "Exercises step skills, roles and named slots.",
    inputs: INPUTS,
    steps,
  };
}

async function compile(steps: Step[]) {
  return await compileWorkflowDocument(workflow(steps), {
    catalog: defaultWorkflowCompilerCatalog(),
  });
}

async function diagnose(steps: Step[]) {
  const result = await compile(steps);
  return result.ok
    ? []
    : result.diagnostics.map(({ path, code }) => ({ path, code }));
}

const brief: Step = {
  id: "brief",
  uses: "task.brief",
  with: { brief: "$input.brief", repositoryId: REPO },
};

function implement(extra: Step = {}): Step {
  return {
    id: "implement",
    needs: ["brief"],
    uses: "harness.implement",
    with: {
      repositoryId: REPO,
      planArtifact: "$step.brief.artifact.versionId",
      instructions: "$input.instructions",
    },
    ...extra,
  };
}

function actionNode(result: Awaited<ReturnType<typeof compile>>, id: string) {
  assert(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics));
  const node = result.document.steps.find((entry) => entry.id === id);
  assert(node && node.kind === "action", `missing action node ${id}`);
  return node;
}

Deno.test("a step carries its skills, role and named slots into the compiled plan", async () => {
  const result = await compile([
    brief,
    implement({
      skills: [SKILL_B, SKILL_A],
      role: "implementer",
      inputs: [{ name: "plan", from: "$step.brief.artifact.versionId" }],
      outputs: [{ name: "patch", kind: "patch" }, { name: "notes" }],
    }),
  ]);
  const node = actionNode(result, "implement");
  // Skills are an identifier set, so they are sorted and duplicate-free.
  assertEquals(node.skills, [SKILL_A, SKILL_B]);
  assertEquals(node.role, "implementer");
  // Slots keep authored order: a step reads and publishes in the order it said.
  assertEquals(node.inputs?.map((slot) => slot.name), ["plan"]);
  assertEquals(node.outputs, [{ name: "patch", kind: "patch" }, {
    name: "notes",
  }]);
});

Deno.test("a step without the new fields compiles exactly as before", async () => {
  const result = await compile([brief, implement()]);
  const node = actionNode(result, "implement");
  assertEquals(node.skills, undefined);
  assertEquals(node.role, undefined);
  assertEquals(node.inputs, undefined);
  assertEquals(node.outputs, undefined);
});

Deno.test("the new fields change the digest, so a version never silently changes", async () => {
  const plain = await compile([brief, implement()]);
  const withSkills = await compile([brief, implement({ skills: [SKILL_A] })]);
  const withRole = await compile([brief, implement({ role: "implementer" })]);
  assert(plain.ok && withSkills.ok && withRole.ok);
  assert(plain.digest !== withSkills.digest);
  assert(plain.digest !== withRole.digest);
  assert(withSkills.digest !== withRole.digest);
});

Deno.test("a malformed skill version is refused, not dropped", async () => {
  const diagnostics = await diagnose([
    brief,
    implement({ skills: ["not-a-uuid"] }),
  ]);
  assertEquals(diagnostics, [
    { path: "/steps/1/skills", code: "action_skills_invalid" },
  ]);
});

Deno.test("a repeated skill version is refused", async () => {
  const diagnostics = await diagnose([
    brief,
    implement({ skills: [SKILL_A, SKILL_A] }),
  ]);
  assertEquals(diagnostics, [
    { path: "/steps/1/skills", code: "action_skills_invalid" },
  ]);
});

Deno.test("a role that is not a declared name is refused", async () => {
  for (const role of ["Implementer", "a", "../escape", ""]) {
    const diagnostics = await diagnose([brief, implement({ role })]);
    assertEquals(
      diagnostics,
      [{ path: "/steps/1/role", code: "action_role_invalid" }],
      `role ${JSON.stringify(role)} must be refused`,
    );
  }
});

Deno.test("a slot name that could escape the context directory is refused", async () => {
  for (const name of ["../escape", "/absolute", "a/b", ""]) {
    const diagnostics = await diagnose([
      brief,
      implement({ outputs: [{ name }] }),
    ]);
    assertEquals(
      diagnostics,
      [{ path: "/steps/1/outputs/0/name", code: "action_slots_invalid" }],
      `slot name ${JSON.stringify(name)} must be refused`,
    );
  }
});

Deno.test("a repeated slot name is refused", async () => {
  const diagnostics = await diagnose([
    brief,
    implement({ outputs: [{ name: "patch" }, { name: "patch" }] }),
  ]);
  assertEquals(diagnostics, [
    { path: "/steps/1/outputs/1/name", code: "action_slots_invalid" },
  ]);
});

Deno.test("an unknown slot field is refused rather than ignored", async () => {
  const diagnostics = await diagnose([
    brief,
    implement({ outputs: [{ name: "patch", path: "/tmp/x" }] }),
  ]);
  assertEquals(diagnostics, [
    { path: "/steps/1/outputs/0/path", code: "action_slots_invalid" },
  ]);
});

Deno.test("an input slot carrying an output-only key is refused at that key", async () => {
  // The input reader builds {name, from} and nothing else, so a `kind` here
  // would be accepted and silently dropped. It is refused at the key itself,
  // not merely at the entry, so the diagnostic points at what to remove.
  const diagnostics = await diagnose([
    brief,
    implement({
      inputs: [{
        name: "plan",
        from: "$step.brief.artifact.versionId",
        kind: "patch",
      }],
    }),
  ]);
  assertEquals(diagnostics, [
    { path: "/steps/1/inputs/0/kind", code: "action_slots_invalid" },
  ]);
});

Deno.test("an output slot keeps its kind, and an input slot keeps its binding", async () => {
  // The mirror of the refusal above: the per-reader key sets must not have
  // narrowed the output reader, and the input reader must still build `from`.
  const result = await compile([
    brief,
    implement({
      inputs: [{ name: "plan", from: "$step.brief.artifact.versionId" }],
      outputs: [{ name: "patch", kind: "patch" }],
    }),
  ]);
  const node = actionNode(result, "implement");
  assertEquals(node.inputs?.map((slot) => slot.name), ["plan"]);
  assert(node.inputs?.[0].from !== undefined, "the input keeps its binding");
  assertEquals(node.outputs, [{ name: "patch", kind: "patch" }]);
});

Deno.test("an input slot must bind a value the compiler can build", async () => {
  const diagnostics = await diagnose([
    brief,
    implement({ inputs: [{ name: "plan" }] }),
  ]);
  assertEquals(diagnostics, [
    { path: "/steps/1/inputs/0/from", code: "field_invalid" },
  ]);
});
