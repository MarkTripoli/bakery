import { assert, assertEquals } from "@std/assert";
import { WORKFLOW_PRESETS } from "../../packages/contracts/src/workflow-presets.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  seedFundedCodingAgent,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { onboardObserved } from "../helpers/review-repair/preset-integration-cases.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { presetBudgetPolicy } from "../helpers/fixed-coding-preset.ts";

type PresetsPage = {
  items: Array<{
    id: string;
    digest: string;
    definition: { name?: string; inputs?: Record<string, unknown> };
    startableFromComposer: boolean;
  }>;
};

const withFixture = <T>(work: Parameters<typeof withWorkerFixture<T>>[0]) =>
  withWorkerFixture(work, { env: presetBudgetEnv });

const MODEL_ACTIONS = [
  "harness.implement",
  "harness.repair",
  "review.independent",
  "agent.freeform",
] as const;

Deno.test("the preset read lists the Deliver templates after the coding presets, each with its whole definition (#429)", () =>
  withFixture(async (fixture) => {
    const page = await expectJson<PresetsPage>(
      await apiCall(fixture, fixture, "GET", "/v1/workflow-presets"),
      200,
    );
    assertEquals(page.items.map((item) => item.id), [
      "fixed-coding",
      "fixed-coding-reviewed",
      "deliver-oneshot",
      "deliver-lean",
      "deliver-full",
      "deliver-prd",
    ]);
    for (const item of page.items) {
      const preset = WORKFLOW_PRESETS.find((p) => p.id === item.id)!;
      assertEquals(item.digest, preset.digest);
      assertEquals(item.definition, JSON.parse(JSON.stringify(preset.spec)));
      assert(item.startableFromComposer, item.id);
    }
    const deliver = page.items.filter((item) => item.id.startsWith("deliver-"));
    for (const item of deliver) {
      assertEquals(item.definition.name, item.id);
      assert(Object.hasOwn(item.definition.inputs ?? {}, "gates"), item.id);
    }
  }));

Deno.test("a Deliver run takes gates from the request; the plan sign-off is a Deliver template default, not a requirement on any workflow; other runs refuse gates (#429)", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "gates");
    const repository = await onboardObserved(
      fixture,
      Object.fromEntries(MODEL_ACTIONS.map((action) => [action, agent])),
    );
    const gatesOf = async (runId: string) =>
      (await fixture.pgDatabase.query<{ gates: unknown }>(
        `select snapshot -> 'inputs' -> 'gates' as gates
           from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, runId],
      )).rows[0].gates;
    const start = async (extra: Record<string, unknown>, title: string) => {
      const task = await createPresetTask(fixture, fixture, repository, {
        title,
      });
      return await startPresetRun(fixture, fixture, task, repository, {
        extra,
      });
    };

    const byDefault = await expectJson<{ id: string }>(
      await start({ presetId: "deliver-oneshot" }, "default gates"),
      201,
    );
    assertEquals(await gatesOf(byDefault.id), "plan");
    const ungated = await expectJson<{ id: string }>(
      await start({ presetId: "deliver-oneshot", gates: "none" }, "no gates"),
      201,
    );
    assertEquals(await gatesOf(ungated.id), "none");
    const gated = await expectJson<{ id: string }>(
      await start({ presetId: "deliver-lean", gates: "plan" }, "plan gates"),
      201,
    );
    assertEquals(await gatesOf(gated.id), "plan");

    const fixedCoding = await start(
      { presetId: "fixed-coding", gates: "plan" },
      "fixed coding gates",
    );
    assertEquals(fixedCoding.status, 422);
    assert((await fixedCoding.text()).includes("gates_not_accepted"));
    const malformed = await start(
      { presetId: "deliver-oneshot", gates: "maybe" },
      "bad gates",
    );
    assert(malformed.status >= 400 && malformed.status < 500);
    await malformed.body?.cancel();
  }));

Deno.test("a Deliver run's plan sign-off lands in the task's approvals, and a decision lets the run go on (#429)", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "signoff");
    const repository = await onboardObserved(
      fixture,
      Object.fromEntries(MODEL_ACTIONS.map((action) => [action, agent])),
    );
    const database = fixture.pgDatabase;
    const engine = createBakeryPostgresWorkflowRepository({
      database,
      maxAttempts: 1,
      budgetPolicy: presetBudgetPolicy,
    });

    const failureOf = async (runId: string) =>
      (await database.query<{ code: string }>(
        `select details->>'code' as code from bakery.audit_events
          where resource_id = $1 and operation = 'workflow.plan_failed'`,
        [runId],
      )).rows.map((row) => row.code).join(",") || "no failure recorded";
    const startedAtThePlan = async (extra: Record<string, unknown>) => {
      const task = await createPresetTask(fixture, fixture, repository, {
        title: `signoff ${crypto.randomUUID().slice(0, 8)}`,
      });
      const run = await expectJson<{ id: string }>(
        await startPresetRun(fixture, fixture, task, repository, { extra }),
        201,
      );
      const owner = await engine.acquireEngineOwner(
        run.id,
        crypto.randomUUID(),
        60_000,
      );
      assert(owner);
      const complete = async (stepKey: string, output: unknown) => {
        await database.query(
          `update bakery.run_steps
              set status = 'completed', output = $3::jsonb, finished_at = now()
            where organization_id = $1 and run_id = $2 and step_key = $4`,
          [fixture.organizationId, run.id, JSON.stringify(output), stepKey],
        );
      };
      const brief = await engine.findNext(run.id, owner);
      assertEquals(brief?.stepKey, "brief");
      await complete("brief", {
        artifact: {
          artifactId: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          sha256: "d".repeat(64),
        },
      });
      const plan = await engine.findNext(run.id, owner);
      assertEquals(plan?.stepKey, "plan");
      await complete("plan", {
        sessionId: crypto.randomUUID(),
        status: "completed",
        artifacts: [{
          artifactId: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          sha256: "e".repeat(64),
        }],
      });
      return { task, run, owner };
    };

    const gated = await startedAtThePlan({ presetId: "deliver-oneshot" });
    try {
      const signoff = await engine.findNext(gated.run.id, gated.owner);
      assertEquals(signoff?.stepKey, "plan_signoff.approve");
      const step = (await database.query<{
        status: string;
        dispatch: { kind: string; wait?: { approvalId?: string } };
      }>(
        `select status, dispatch from bakery.run_steps
          where run_id = $1 and step_key = 'plan_signoff.approve'`,
        [gated.run.id],
      )).rows[0];
      assertEquals(step.status, "waiting");
      assertEquals(step.dispatch.kind, "wait");
      const approvalId = step.dispatch.wait?.approvalId;
      assert(approvalId, "the wait pins the approval it waits on");

      const listed = await expectJson<
        { items: { id: string; version: number; status: string }[] }
      >(
        await apiCall(
          fixture,
          fixture,
          "GET",
          `/v1/approvals?taskId=${gated.task.id}&limit=100`,
        ),
        200,
      );
      const approval = listed.items.find((item) => item.id === approvalId);
      assert(approval, "the sign-off is in the task's approvals");
      assertEquals(approval.status, "open");

      assertEquals(
        await engine.completeApprovalWait(signoff!, gated.owner),
        false,
      );
      const decided = await apiCall(
        fixture,
        fixture,
        "POST",
        `/v1/approvals/${approvalId}/decision`,
        { body: { decision: "approve", expectedVersion: approval.version } },
      );
      assertEquals(decided.status, 200, await decided.clone().text());
      assertEquals(
        await engine.completeApprovalWait(signoff!, gated.owner),
        true,
      );
      const output =
        (await database.query<{ status: string; output: { decision: string } }>(
          `select status, output from bakery.run_steps
          where run_id = $1 and step_key = 'plan_signoff.approve'`,
          [gated.run.id],
        )).rows[0];
      assertEquals(output.status, "completed");
      assertEquals(output.output.decision, "approve");
      const next = await engine.findNext(gated.run.id, gated.owner);
      assertEquals(
        next?.stepKey,
        "build.implement",
        await failureOf(gated.run.id),
      );
    } finally {
      await engine.releaseEngineOwner(gated.owner);
    }

    const ungated = await startedAtThePlan({
      presetId: "deliver-oneshot",
      gates: "none",
    });
    try {
      const next = await engine.findNext(ungated.run.id, ungated.owner);
      assertEquals(
        next?.stepKey,
        "build.implement",
        await failureOf(ungated.run.id),
      );
      const asked = await database.query<{ n: string }>(
        `select count(*)::text as n from bakery.questions
          where organization_id = $1 and run_id = $2 and kind = 'approval'`,
        [fixture.organizationId, ungated.run.id],
      );
      assertEquals(asked.rows[0].n, "0");
    } finally {
      await engine.releaseEngineOwner(ungated.owner);
    }
  }));

Deno.test("a task starts with no workflow chosen, and no server path assigns one: built-ins are optional (#429)", () =>
  withFixture(async (fixture) => {
    const agent = await seedFundedCodingAgent(fixture, fixture, "optional");
    const repository = await onboardObserved(
      fixture,
      Object.fromEntries(MODEL_ACTIONS.map((action) => [action, agent])),
    );
    const task = await createPresetTask(fixture, fixture, repository, {
      title: "no workflow chosen",
    });
    const runs = await expectJson<{ items: unknown[] }>(
      await apiCall(fixture, fixture, "GET", `/v1/tasks/${task.id}/runs`),
      200,
    );
    assertEquals(runs.items, []);
    const presets = await expectJson<PresetsPage>(
      await apiCall(fixture, fixture, "GET", "/v1/workflow-presets"),
      200,
    );
    assert(presets.items.length > 0);
    assertEquals(
      (await expectJson<{ items: unknown[] }>(
        await apiCall(fixture, fixture, "GET", `/v1/tasks/${task.id}/runs`),
        200,
      )).items,
      [],
    );
  }));
