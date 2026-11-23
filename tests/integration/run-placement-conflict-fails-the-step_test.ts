import { assert, assertEquals } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { readPlanHost } from "../../apps/server/src/modules/delivery/plan-host.ts";
import {
  presetBudgetEnv,
  presetBudgetPolicy,
} from "../helpers/fixed-coding-preset.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  fundedAgents,
  onboardObserved,
  startRun,
} from "../helpers/review-repair/preset-integration-cases.ts";

// #428. A run whose placement asks for a native OS the repository's observed
// profile does not share can be satisfied by no host. Admission fails the step
// with that reason, for the person to see; it does not roll back and retry the
// same refusal on every tick. The observed profile comes from a real
// onboarding, so this file needs the worker-backed inspection (x86 hosts).

Deno.test("a placement whose platform no host shares fails the step with its reason and does not retry", () =>
  withWorkerFixture(async (fixture) => {
    const agents = await fundedAgents(
      fixture,
      `pc-${crypto.randomUUID().slice(0, 8)}`,
    );
    const repository = await onboardObserved(fixture, agents);
    const { body } = await startRun(fixture, repository, "fixed-coding", 201);
    const runId = body.id as string;
    // The observed profile of the repository says linux; the run asks for a
    // different native OS, which no job could satisfy.
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set placement = $2::jsonb where id = $1`,
      [
        runId,
        JSON.stringify({
          requirements: { capabilities: [], platform: "darwin" },
        }),
      ],
    );
    const engine = createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 1,
      budgetPolicy: presetBudgetPolicy,
      planHost: readPlanHost,
    });
    const owner = await engine.acquireEngineOwner(
      runId,
      crypto.randomUUID(),
      60_000,
    );
    assert(owner);
    try {
      const key = await engine.findNext(runId, owner);
      assert(key);
      const admission = await engine.admit(key, owner);
      assertEquals(admission.jobId, undefined, "no job is dispatched");
      const step = (await fixture.pgDatabase.query<
        { status: string; error: { code: string; message: string } | null }
      >(
        `select status, error from bakery.run_steps
          where run_id = $1 and step_key = $2`,
        [runId, key.stepKey],
      )).rows[0];
      assertEquals(step.status, "failed");
      assert(
        step.error?.message.includes(
          "placement_conflict:placement_platform_conflict",
        ),
        `the reason is kept: ${JSON.stringify(step.error)}`,
      );
    } finally {
      await engine.releaseEngineOwner(owner);
    }
  }, { env: presetBudgetEnv }));
