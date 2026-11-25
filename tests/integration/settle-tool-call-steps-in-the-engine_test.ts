import { assert, assertEquals } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  composeEngineStepRunners,
  type EngineStepRequest,
} from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import { createToolCallStepRunner } from "../../apps/server/src/modules/tool-call/tool-call-step.ts";
import { seedPlanRun, setRow } from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { fundedModelPolicy } from "../helpers/funded-model-job.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import {
  consumerDepsFor,
  type FakeGithub,
  fakeGithub,
  GITHUB_ACTION,
  GITHUB_ARGS,
  seededEffectRig,
} from "../helpers/external-effects.ts";

// #435 slice 1. A tool.call step is settled by the engine in its admission, like
// a delivery step: no worker job, the call made as the person who started the run
// through the integration door, so a write is one effect in the ledger keyed by
// the step. A replayed step finds that effect instead of sending again; an effect
// whose outcome is not known leaves the step pending; a refused write fails it.

type EffectOptions = Parameters<typeof consumerDepsFor>[3];

async function atTheToolCall(
  fixture: WorkerFixture,
  github: FakeGithub,
  effects: EffectOptions = {},
) {
  const rig = await seededEffectRig(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const deps = consumerDepsFor(fixture.pgDatabase, rig, github, effects);
  const input = {
    connectionId: rig.connectionId,
    tool: GITHUB_ACTION,
    toolVersion: 1,
    resourceId: rig.resourceId,
    arguments: { ...GITHUB_ARGS },
  };
  const seeded = await seedPlanRun(
    fixture,
    await compiled([
      noop("first"),
      {
        id: "comment",
        uses: "tool.call",
        needs: ["first"],
        with: { ...input, arguments: { $literal: { ...GITHUB_ARGS } } },
        effectKey: ["comment", "$input.target"],
        limits: { maxCostUsd: 0.1 },
      },
    ], { target: { type: "uuid", required: true } }),
    { inputs: { target: rig.resourceId } },
  );
  await setRow(fixture, seeded, seeded.firstKey, "completed", { n: 1 });
  const runner = createToolCallStepRunner({
    database: fixture.pgDatabase,
    registry: deps.registry,
    providerRequests: deps.providerRequests!,
    snapshots: deps.snapshots,
    effects,
  });
  const repository = createBakeryPostgresWorkflowRepository({
    database: fixture.pgDatabase,
    maxAttempts: 3,
    engineSteps: composeEngineStepRunners([runner]),
    budgetPolicy: fundedModelPolicy,
  });
  const request: EngineStepRequest = {
    organizationId: fixture.organizationId,
    runId: seeded.job.runId,
    taskId: seeded.job.runId,
    repositoryId: null,
    requestedBy: fixture.principalId,
    traceId: "trace-435",
    stepKey: "comment",
    iteration: 0,
    action: "tool.call",
    input,
  };
  return { seeded, runner, repository, request };
}

const step = async (fixture: WorkerFixture, runId: string) =>
  (await fixture.pgDatabase.query<{
    status: string;
    output: unknown;
    error: unknown;
    retryAt: string | null;
  }>(
    `select status, output, error,
            dispatch ->> 'stepRetryAt' as "retryAt"
       from bakery.run_steps where run_id = $1 and step_key = 'comment'`,
    [runId],
  )).rows[0];

const effectsOf = async (fixture: WorkerFixture) =>
  (await fixture.pgDatabase.query<{ id: string; key: string; status: string }>(
    `select id, idempotency_key as key, status from bakery.external_effects
      where organization_id = $1`,
    [fixture.organizationId],
  )).rows;

const reservationsOf = async (fixture: WorkerFixture, runId: string) =>
  (await fixture.pgDatabase.query<{
    status: string;
    reserved: string;
    settled: string | null;
  }>(
    `select reservation.status,
            reservation.reserved_usd::text as reserved,
            reservation.settled_usd::text as settled
       from bakery.budget_reservations reservation
       join bakery.run_steps step
         on step.organization_id = reservation.organization_id
        and step.id = reservation.run_step_id
      where step.run_id = $1 and step.step_key = 'comment'
      order by reservation.id`,
    [runId],
  )).rows;

Deno.test("a tool.call write is settled by the engine through one keyed ledger effect (#435)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    const { seeded, repository } = await atTheToolCall(fixture, github);
    const key = await repository.findNext(seeded.job.runId, seeded.owner);
    assert(key !== undefined);
    assertEquals(key.stepKey, "comment");
    const admitted = await repository.admit(key, seeded.owner);
    assertEquals(admitted.terminal, true);
    const row = await step(fixture, seeded.job.runId);
    assertEquals(row.status, "completed");
    const output = row.output as Record<string, unknown>;
    assertEquals(output.accepted, true);
    assertEquals(output.operation, GITHUB_ACTION);
    assertEquals(github.posts(), 1);
    const effects = await effectsOf(fixture);
    assertEquals(effects.length, 1);
    assertEquals(effects[0].status, "confirmed");
    // The one effect key of the step: run, step key, iteration.
    assertEquals(effects[0].key, `${seeded.job.runId}:comment:0`);
    assertEquals(output.externalEffectId, effects[0].id);
    // No worker job: the engine wrote the step itself.
    const jobs = await fixture.pgDatabase.query(
      `select 1 from bakery.jobs j join bakery.run_steps s
         on s.organization_id = j.organization_id and s.id = j.run_step_id
        where s.run_id = $1 and s.step_key = 'comment'`,
      [seeded.job.runId],
    );
    assertEquals(jobs.rows.length, 0);
    const replay = await repository.admit(key, seeded.owner);
    assertEquals(replay.terminal, true);
    const reservations = await reservationsOf(fixture, seeded.job.runId);
    assertEquals(reservations, [
      { status: "settled", reserved: "0.100000", settled: "0.100000" },
      { status: "settled", reserved: "0.100000", settled: "0.100000" },
    ]);
  }));

Deno.test("a tool.call step replayed after a crash finds its effect and sends nothing twice (#435)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    const { runner, request } = await atTheToolCall(fixture, github);
    const first = await runner.run(request);
    const again = await runner.run(request);
    assertEquals(first.kind, "completed");
    assertEquals(again, first);
    assertEquals(github.posts(), 1);
    assertEquals((await effectsOf(fixture)).length, 1);
    // A later iteration of the same step is a new send under its own key.
    const next = await runner.run({ ...request, iteration: 1 });
    assertEquals(next.kind, "completed");
    assertEquals(github.posts(), 2);
    assertEquals((await effectsOf(fixture)).length, 2);
  }));

Deno.test("a tool.call write whose outcome is not known leaves the step pending, not done (#435)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    github.post = "hang";
    const { seeded, repository } = await atTheToolCall(fixture, github, {
      deadlineMs: 50,
    });
    const key = await repository.findNext(seeded.job.runId, seeded.owner);
    assert(key !== undefined);
    const admitted = await repository.admit(key, seeded.owner);
    assertEquals(admitted, { key, terminal: false });
    const effects = await effectsOf(fixture);
    assertEquals(effects.length, 1);
    assert(effects[0].status !== "confirmed");
    assertEquals(await reservationsOf(fixture, seeded.job.runId), [
      { status: "held", reserved: "0.100000", settled: null },
      { status: "held", reserved: "0.100000", settled: null },
    ]);
  }));

Deno.test("canceling a pending tool.call settles both cost reservations before the plan halts", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    github.post = "hang";
    const { seeded, repository } = await atTheToolCall(fixture, github, {
      deadlineMs: 50,
    });
    const key = await repository.findNext(seeded.job.runId, seeded.owner);
    assert(key !== undefined);
    assertEquals(await repository.admit(key, seeded.owner), {
      key,
      terminal: false,
    });
    assertEquals(await reservationsOf(fixture, seeded.job.runId), [
      { status: "held", reserved: "0.100000", settled: null },
      { status: "held", reserved: "0.100000", settled: null },
    ]);

    await setRow(fixture, seeded, "comment", "canceled");
    assertEquals(
      await repository.findNext(seeded.job.runId, seeded.owner),
      undefined,
    );
    assertEquals(await reservationsOf(fixture, seeded.job.runId), [
      { status: "settled", reserved: "0.100000", settled: "0.100000" },
      { status: "settled", reserved: "0.100000", settled: "0.100000" },
    ]);
  }));

Deno.test("a tool.call write the provider refuses fails the step with a fixed code (#435)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    github.post = { status: 422 };
    const { seeded, repository } = await atTheToolCall(fixture, github);
    const key = await repository.findNext(seeded.job.runId, seeded.owner);
    assert(key !== undefined);
    const admitted = await repository.admit(key, seeded.owner);
    assertEquals(admitted.terminal, true);
    const row = await step(fixture, seeded.job.runId);
    assertEquals(row.status, "failed");
    assert(JSON.stringify(row.error).includes("TOOL_CALL_EFFECT_FAILED"));
    const effects = await effectsOf(fixture);
    assertEquals(effects.length, 1);
    assertEquals(effects[0].status, "failed");
    assertEquals(await reservationsOf(fixture, seeded.job.runId), [
      { status: "settled", reserved: "0.100000", settled: "0.100000" },
      { status: "settled", reserved: "0.100000", settled: "0.100000" },
    ]);
  }));
