/**
 * Probe designed and written by qa-qa (qapool-qa3) for PR #518; renamed from
 * qa3-518-disarm-probe_test.ts to the repo's descriptive convention, header
 * kept as written.
 *
 * Run admission must still REFUSE a plan
 * document that does not compile. The repository-not-bound check must be an
 * ADDITION to the compiler gate, not a replacement for it - a fix that made
 * admission accept a non-plan would turn the 12 coordination failures green
 * while disarming the gate, which is the failure mode this probe guards.
 *
 * The non-compilable version is written past the publisher (same technique as
 * the activation-refusal test in pin-and-enforce): a real digest over a
 * document that names an unregistered action, active, then a run started
 * against it. Expected: 409 STATE_CONFLICT, reason workflow_plan_not_compilable.
 */
import { assertEquals } from "@std/assert";
import { apiCall, createPresetTask } from "../helpers/fixed-coding-preset.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  planDefinition,
  publishWorkflow,
  seedRulesRepository,
} from "../helpers/pinned-rules.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";

const UNCOMPILABLE = planDefinition({
  inputs: {
    repositoryId: { type: "uuid", required: true },
  },
  steps: [{
    id: "implement",
    uses: "totally.unknown.action",
    with: { repositoryId: "$input.repositoryId" },
  }],
});

Deno.test("run admission still refuses a plan document that does not compile", async () => {
  await withWorkerFixture(async (fixture) => {
    const repository = await seedRulesRepository(fixture, fixture, "disarm");
    const workflow = await publishWorkflow(
      fixture,
      fixture,
      "disarm",
      planDefinition({
        inputs: {
          repositoryId: { type: "uuid", required: true },
          plan: { type: "uuid", required: true },
        },
        steps: [{
          id: "implement",
          uses: "harness.implement",
          with: {
            repositoryId: "$input.repositoryId",
            planArtifact: "$input.plan",
          },
        }],
      }),
      { activate: true },
    );
    // Overwrite the active version's spec, past the publisher, with a document
    // that is valid JSON of the right shape but names an unregistered action.
    const digest = await sha256Hex(canonicalJson(UNCOMPILABLE));
    await fixture.pgDatabase.query(
      `update bakery.workflow_versions
          set normalized_spec = $2::jsonb, digest = $3
        where id = $1`,
      [workflow.versionId, JSON.stringify(UNCOMPILABLE), digest],
    );
    const task = await createPresetTask(fixture, fixture, repository);
    const response = await apiCall(
      fixture,
      fixture,
      "POST",
      `/v1/tasks/${task.id}/runs`,
      {
        body: {
          executionMode: "repository",
          repositoryProfileId: repository.profileId,
          workflowId: workflow.workflowId,
          budgetLimitUsd: "5",
          inputs: {
            repositoryId: repository.repositoryId,
            plan: crypto.randomUUID(),
          },
        },
      },
    );
    const body = await response.json() as Record<string, unknown>;
    assertEquals(
      response.status,
      409,
      `admission must refuse a non-compilable plan, got ${
        JSON.stringify(body)
      }`,
    );
    assertEquals(body.reason, "workflow_plan_not_compilable");
  });
});
