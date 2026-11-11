import { assert, assertEquals, assertThrows } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { validateRunInputs } from "../../apps/server/src/modules/work/run-command.ts";
const ID = "00000000-0000-4000-8000-000000000001";

Deno.test("generated RunCreate and Run schemas enforce the public projection boundary", () => {
  const runInput = contractSchemas.RunCreate.safeParse({
    workflowVersionId: ID,
    executionMode: "cloud_only",
    budgetLimitUsd: "12.500000",
    inputs: { taskId: ID },
  });
  assert(runInput.success);
  const unknownRunInput = contractSchemas.RunCreate.safeParse({
    workflowVersionId: ID,
    executionMode: "cloud_only",
    unexpected: true,
  });
  assert(!unknownRunInput.success);

  const run = {
    id: ID,
    taskId: ID,
    workflowVersionId: ID,
    repositoryProfileId: null,
    repositoryProfileRevision: null,
    repositoryProfileDigest: null,
    observationId: null,
    observationDigest: null,
    baseSha: null,
    workspaceBaseSha: null,
    requestedBy: ID,
    inngestRunId: null,
    status: "queued",
    budgetLimitUsd: "12.500000",
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    version: 1,
    budgetSummary: {
      installation: null,
      run: {
        scope: "run",
        runId: ID,
        periodStart: null,
        periodEnd: null,
        limitUsd: "12.500000",
        reservedUsd: "0",
        settledUsd: "0",
        availableUsd: "12.500000",
        unknownCount: 0,
      },
    },
  };
  const parsedRun = contractSchemas.Run.safeParse(run);
  assert(parsedRun.success);
  if (parsedRun.success) {
    assertEquals(parsedRun.data.budgetSummary.installation, null);
    assertEquals(parsedRun.data.kind, undefined);
    assertEquals(parsedRun.data.skillSourceId, undefined);
  }

  const importedRun = contractSchemas.Run.safeParse({
    ...run,
    kind: "skill_import",
    taskId: null,
    workflowVersionId: null,
    skillSourceId: ID,
  });
  assert(importedRun.success);
  if (importedRun.success) {
    assertEquals(importedRun.data.kind, "skill_import");
    assertEquals(importedRun.data.taskId, null);
    assertEquals(importedRun.data.workflowVersionId, null);
    assertEquals(importedRun.data.skillSourceId, ID);
  }

  const runWithSnapshot = {
    ...run,
    snapshot: { repositoryProfile: { secret: "not-public" } },
  };
  const rejectedRun = contractSchemas.Run.safeParse(runWithSnapshot);
  assert(!rejectedRun.success);
  if (!rejectedRun.success) {
    assert(
      rejectedRun.error.issues.some((issue) =>
        issue.code === "unrecognized_keys" &&
        issue.keys?.includes("snapshot")
      ),
    );
  }
  const step = {
    id: ID,
    runId: ID,
    stepKey: "review",
    iteration: 0,
    status: "pending",
    input: { taskId: ID },
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    version: 1,
  };
  const rejectedStep = contractSchemas.RunStep.safeParse({
    ...step,
    secret: "not-public",
  });
  assert(!rejectedStep.success);
});

Deno.test("RunCreate and runtime share serialized JSON byte bounds", () => {
  const create = (inputs: unknown) =>
    contractSchemas.RunCreate.safeParse({
      workflowVersionId: ID,
      executionMode: "cloud_only",
      inputs,
    });
  const accepted = [
    "x".repeat(99_998),
    "\n".repeat(49_999),
    { value: '"'.repeat(49_994) },
  ];
  for (const inputs of accepted) {
    assert(create(inputs).success);
    assertEquals(validateRunInputs(inputs), inputs);
  }

  const oversized = "\n".repeat(50_000);
  assert(!create(oversized).success);
  assertThrows(() => validateRunInputs(oversized));

  const ordinaryString = contractSchemas.ArtifactCommentCreate.safeParse({
    body: '"'.repeat(10_240),
  });
  assert(ordinaryString.success);
});
