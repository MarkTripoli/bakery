import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { WORKFLOW_ACTION_NAMES } from "../../packages/contracts/src/workflow-action-registry.ts";
import { compileWorkflowDocument } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { defaultWorkflowCompilerCatalog } from "../../packages/contracts/src/workflow-compiler/default-catalog.ts";

// #30 slice A2: the contracts of artifact.publish, memory.promote,
// evaluation.sample and integration.action, written to the schema registry in
// docs/technical-design/06. With slice A1 this leaves no registered action
// without a schema, which is what lets a workflow using any of them compile.

const UUID = "00000000-0000-4000-8000-0000000000a1";
const ARTIFACT = { artifactId: UUID, versionId: UUID, sha256: "e".repeat(64) };

type Step = Record<string, unknown>;

function workflow(steps: Step[]) {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "action-contracts",
    description: "Exercises the artifact, memory and evaluation contracts.",
    inputs: {
      taskId: { type: "uuid", required: true },
      repositoryId: { type: "uuid", required: true },
      runId: { type: "uuid", required: true },
    },
    steps,
  };
}

async function diagnose(steps: Step[]) {
  const result = await compileWorkflowDocument(workflow(steps), {
    catalog: defaultWorkflowCompilerCatalog(),
  });
  return result.ok
    ? []
    : result.diagnostics.map(({ path, code }) => ({ path, code }));
}

const research: Step = {
  id: "research",
  uses: "rpi.research",
  with: { taskId: "$input.taskId", repositoryId: "$input.repositoryId" },
};

Deno.test("no registered workflow action is left without a schema", () => {
  const catalog = defaultWorkflowCompilerCatalog();
  assertEquals(
    WORKFLOW_ACTION_NAMES.filter((name) => !catalog.resolveAction(name)),
    [],
  );
});

Deno.test("a research artifact flows into artifact.publish and memory.promote", async () => {
  // ResearchOutput.artifact is an ArtifactRef, and so are both inputs: the
  // typed reference compiles without any conversion step.
  assertEquals(
    await diagnose([
      research,
      {
        id: "publish",
        needs: ["research"],
        uses: "artifact.publish",
        with: { artifact: "$step.research.artifact" },
      },
      {
        id: "remember",
        needs: ["research"],
        uses: "memory.promote",
        with: {
          artifact: "$step.research.artifact",
          sourceRevision: "$step.research.repositoryRevision",
        },
      },
    ]),
    [],
  );
});

Deno.test("evaluation.sample and integration.action compile with valid input", async () => {
  assertEquals(
    await diagnose([
      {
        id: "sample",
        uses: "evaluation.sample",
        with: { runId: "$input.runId", sampleRate: 0.25 },
      },
      {
        id: "notify",
        needs: ["sample"],
        uses: "integration.action",
        with: {
          actionId: "chat.post",
          actionVersion: 1,
          resourceId: "$input.runId",
          arguments: { $literal: { text: "done" } },
        },
        effectKey: ["notify", "$input.runId"],
      },
    ]),
    [],
  );
});

Deno.test("an output the producer does not declare, or of the wrong type, is refused", async () => {
  assertEquals(
    await diagnose([
      research,
      {
        id: "remember",
        needs: ["research"],
        uses: "memory.promote",
        with: {
          artifact: "$step.research.artifact",
          sourceRevision: "$step.research.nope",
        },
      },
    ]),
    [{ path: "/steps/1/with/sourceRevision", code: "reference_field_unknown" }],
  );
  // EvaluationOutput.status is text; MemoryPromoteInput.artifact needs a
  // whole ArtifactRef.
  assertEquals(
    await diagnose([
      {
        id: "sample",
        uses: "evaluation.sample",
        with: { runId: "$input.runId", sampleRate: 1 },
      },
      {
        id: "remember",
        needs: ["sample"],
        uses: "memory.promote",
        with: {
          artifact: "$step.sample.status",
          sourceRevision: "r1",
        },
      },
    ]),
    [{ path: "/steps/1/with/artifact", code: "type_mismatch" }],
  );
});

Deno.test("missing, unknown and mistyped input fields are refused at their paths", async () => {
  const cases: [string, Step, { path: string; code: string }[]][] = [
    [
      "publish without an artifact",
      { id: "publish", uses: "artifact.publish", with: {} },
      [{ path: "/steps/0/with/artifact", code: "input_field_missing" }],
    ],
    [
      "memory.promote without sourceRevision",
      {
        id: "remember",
        uses: "memory.promote",
        with: { artifact: { $literal: ARTIFACT } },
      },
      [{ path: "/steps/0/with/sourceRevision", code: "input_field_missing" }],
    ],
    [
      "evaluation.sample with a rate given as text",
      {
        id: "sample",
        uses: "evaluation.sample",
        with: { runId: "$input.runId", sampleRate: "half" },
      },
      [{ path: "/steps/0/with/sampleRate", code: "type_mismatch" }],
    ],
    [
      "evaluation.sample with an extra field",
      {
        id: "sample",
        uses: "evaluation.sample",
        with: { runId: "$input.runId", sampleRate: 1, extra: true },
      },
      [{ path: "/steps/0/with", code: "input_field_unknown" }],
    ],
  ];
  for (const [name, step, expected] of cases) {
    assertEquals(await diagnose([step]), expected, name);
  }
});

type Parser = { safeParse: (value: unknown) => { success: boolean } };
const accepts = (name: string, value: unknown) => {
  const schema = (contractSchemas as unknown as Record<string, Parser>)[name];
  assert(schema !== undefined, `${name} is not a contract`);
  return schema.safeParse(value).success;
};

Deno.test("EvaluationInput bounds the sample rate to 0..1", () => {
  const ok = { runId: UUID, sampleRate: 0.5 };
  assert(accepts("EvaluationInput", ok));
  assert(accepts("EvaluationInput", { ...ok, sampleRate: 0 }));
  assert(accepts("EvaluationInput", { ...ok, sampleRate: 1 }));
  assert(!accepts("EvaluationInput", { ...ok, sampleRate: -0.01 }));
  assert(!accepts("EvaluationInput", { ...ok, sampleRate: 1.01 }));
  assert(!accepts("EvaluationInput", { ...ok, runId: "not-a-uuid" }));
  assert(!accepts("EvaluationInput", { ...ok, extra: 1 }));
});

Deno.test("artifact and memory inputs require a whole ArtifactRef and a non-empty revision", () => {
  assert(accepts("ArtifactPublishInput", { artifact: ARTIFACT }));
  assert(!accepts("ArtifactPublishInput", { artifact: UUID }));
  assert(
    !accepts("ArtifactPublishInput", {
      artifact: { ...ARTIFACT, sha256: "NOT-HEX" },
    }),
  );
  const promote = { artifact: ARTIFACT, sourceRevision: "a".repeat(40) };
  assert(accepts("MemoryPromoteInput", promote));
  assert(!accepts("MemoryPromoteInput", { ...promote, sourceRevision: "" }));
  const { sourceRevision: _dropped, ...withoutRevision } = promote;
  assert(!accepts("MemoryPromoteInput", withoutRevision));
});

Deno.test("the outputs are fixed shapes with their declared statuses", () => {
  assert(
    accepts("MemoryOutput", { memoryId: UUID, status: "promoted" }),
  );
  assert(!accepts("MemoryOutput", { memoryId: UUID, status: "pending" }));
  assert(!accepts("MemoryOutput", { memoryId: "x", status: "promoted" }));

  for (const status of ["completed", "failed"]) {
    assert(
      accepts("EvaluationOutput", {
        evaluationId: UUID,
        status,
        measured: true,
      }),
      `EvaluationOutput status ${status}`,
    );
  }
  assert(
    !accepts("EvaluationOutput", {
      evaluationId: UUID,
      status: "running",
      measured: true,
    }),
  );
  assert(
    !accepts("EvaluationOutput", { evaluationId: UUID, status: "failed" }),
  );
});

Deno.test("IntegrationActionOutput is the ActionResult contract, not a second copy", () => {
  const schemas = contractSchemas as unknown as Record<string, unknown>;
  assert(schemas.IntegrationActionOutput === schemas.ActionResult);
  const result = {
    accepted: true,
    operation: "chat.post",
    externalEffectId: null,
    result: { ok: true },
  };
  assert(accepts("IntegrationActionOutput", result));
  assert(
    !accepts("IntegrationActionOutput", { ...result, accepted: "yes" }),
  );
});
