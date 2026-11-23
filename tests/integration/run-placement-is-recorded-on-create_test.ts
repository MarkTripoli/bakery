import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { resolveOrganizationActor } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { createRunCommand } from "../../apps/server/src/modules/work/run-command.ts";
import {
  apiCall,
  createPresetTask,
  presetBudgetEnv,
  presetRunBody,
  seedFundedCodingAgent,
  seedPresetRepository,
} from "../helpers/fixed-coding-preset.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";

// #428. The placement a run records is written by `createRunCommand` and read
// back by engine admission. These tests go through the real command: the
// `runs.create` route for the ordinary run, and the command itself for the one
// that carries a placement (no public field sets it yet). The refusal of a
// placement no host can satisfy is in run-placement-conflict-fails-the-step.

const withFixture = <T>(work: (fixture: WorkerFixture) => Promise<T>) =>
  withWorkerFixture(work, { env: presetBudgetEnv });

const placementOf = async (fixture: WorkerFixture, runId: string) =>
  (await fixture.pgDatabase.query<{ placement: unknown }>(
    `select placement from bakery.workflow_runs where id = $1`,
    [runId],
  )).rows[0].placement;

async function repository(fixture: WorkerFixture) {
  const agent = await seedFundedCodingAgent(
    fixture,
    fixture,
    `pl-${crypto.randomUUID().slice(0, 8)}`,
  );
  return await seedPresetRepository(fixture.pgDatabase, fixture, {
    agentVersionId: agent,
  });
}

Deno.test("a run created through runs.create records the empty placement, {}", () =>
  withFixture(async (fixture) => {
    const repo = await repository(fixture);
    const task = await createPresetTask(fixture, fixture, repo);
    const response = await apiCall(
      fixture,
      fixture,
      "POST",
      `/v1/tasks/${task.id}/runs`,
      { body: presetRunBody(repo) },
    );
    const text = await response.text();
    assertEquals(response.status, 201, text);
    const run = JSON.parse(text) as { id: string };
    assertEquals(await placementOf(fixture, run.id), {});
  }));

Deno.test("a run created with a placement records exactly that placement", () =>
  withFixture(async (fixture) => {
    const repo = await repository(fixture);
    const task = await createPresetTask(fixture, fixture, repo);
    const placement = {
      requirements: { capabilities: ["gpu"], platform: "linux" },
      affinityKey: "run-affinity",
    };
    const run = await withPgTransaction(
      fixture.pgDatabase,
      async (transaction) => {
        const actor = await resolveOrganizationActor(
          transaction,
          fixture.principalId as never,
          fixture.organizationId as never,
        );
        const context = {
          request: new Request("https://internal.invalid/placement-test"),
          params: { id: task.id },
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID().replaceAll("-", ""),
          signal: new AbortController().signal,
          principal: actor.subject,
          authority: actor,
          transaction,
          commandMetadata: {
            operation: "runs.create",
            idempotencyKey: `placement-${crypto.randomUUID()}`,
            target: `/v1/tasks/${task.id}/runs`,
          },
        } as ActionContext;
        return await createRunCommand(
          context,
          contractSchemas.RunCreate.parse(presetRunBody(repo)),
          { placement },
        );
      },
    );
    assertEquals(await placementOf(fixture, run.id), placement);
  }));
