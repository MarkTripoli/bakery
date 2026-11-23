import { assert, assertEquals } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  composeEngineStepRunners,
  type EngineStepRequest,
} from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import { createToolCallStepRunner } from "../../apps/server/src/modules/tool-call/tool-call-step.ts";
import { createPostgresToolCallRecorder } from "../../apps/server/src/modules/tool-call/tool-call-record.ts";
import { createPostgresToolCallCosts } from "../../apps/server/src/modules/tool-call/tool-call-cost.ts";
import { readRunFeed } from "../../apps/server/src/modules/work/run-feed.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { seedPlanRun, setRow } from "../helpers/plan-run.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
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

// #439: a step may name a per-call cost ceiling. Seeded runs carry a 0.005 USD
// budget, so one 0.003 USD ceiling fits and a second does not.
const COST_POLICY = {
  installationMonthlyLimitUsd: "100.000000",
  reservationTtlSeconds: 3_600,
  maxRunDurationSeconds: 86_400,
} as const;
const CEILING = 0.003;

async function atTheToolCall(
  fixture: WorkerFixture,
  github: FakeGithub,
  effects: EffectOptions = {},
  ceiling: number | null = null,
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
        ...(ceiling === null ? {} : { limits: { maxCostUsd: ceiling } }),
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
    toolCalls: createPostgresToolCallRecorder(fixture.pgDatabase),
    ...(ceiling === null ? {} : {
      costs: createPostgresToolCallCosts(fixture.pgDatabase, COST_POLICY),
    }),
  });
  const repository = createBakeryPostgresWorkflowRepository({
    database: fixture.pgDatabase,
    maxAttempts: 3,
    engineSteps: composeEngineStepRunners([runner]),
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
    runStepId: "00000000-0000-4000-8000-000000000000",
    costCeilingUsd: ceiling === null ? null : ceiling.toFixed(6),
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

type AtTheToolCall = Awaited<ReturnType<typeof atTheToolCall>>;

/**
 * Admits the comment step through the repository, as the engine does: that
 * creates the step's row (a feed item belongs to a step that exists) and runs
 * the call once.
 */
async function admitComment({ repository, seeded }: AtTheToolCall) {
  const key = await repository.findNext(seeded.job.runId, seeded.owner);
  assert(key !== undefined);
  await repository.admit(key, seeded.owner);
}

const FEED_SECRET = "feed-secret-for-the-test-cursor-binding";

/** The run's tool feed as one page, oldest first. */
const feedOf = (fixture: WorkerFixture, runId: string, limit?: number) =>
  withPgTransaction(
    fixture.pgDatabase,
    (transaction) =>
      readRunFeed(transaction, {
        secret: FEED_SECRET,
        organizationId: fixture.organizationId,
        principalId: fixture.principalId,
        runId,
        cursor: undefined,
        limit,
      }),
  );

/** A feed page as (phase, ok, code) in feed order. */
const phases = (page: Awaited<ReturnType<typeof feedOf>>) =>
  page.items.map((item) => [item.tool.phase, item.tool.ok, item.tool.code]);

const effectsOf = async (fixture: WorkerFixture) =>
  (await fixture.pgDatabase.query<{ id: string; key: string; status: string }>(
    `select id, idempotency_key as key, status from bakery.external_effects
      where organization_id = $1`,
    [fixture.organizationId],
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
    // The run's tool feed: the call started, then completed, under the effect key.
    const feed = await feedOf(fixture, seeded.job.runId);
    assertEquals(phases(feed), [["started", null, null], [
      "completed",
      true,
      null,
    ]]);
    assertEquals(
      feed.items.map((item) => item.tool.callId),
      [`${seeded.job.runId}:comment:0`, `${seeded.job.runId}:comment:0`],
    );
    assertEquals(feed.items[0].tool.name, GITHUB_ACTION);
    assertEquals(feed.items.every((item) => item.redacted === false), true);
    assertEquals(feed.nextCursor, null);
    // No worker job: the engine wrote the step itself.
    const jobs = await fixture.pgDatabase.query(
      `select 1 from bakery.jobs j join bakery.run_steps s
         on s.organization_id = j.organization_id and s.id = j.run_step_id
        where s.run_id = $1 and s.step_key = 'comment'`,
      [seeded.job.runId],
    );
    assertEquals(jobs.rows.length, 0);
  }));

Deno.test("a tool.call step replayed after a crash finds its effect and sends nothing twice (#435)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    const at = await atTheToolCall(fixture, github);
    const { seeded, runner, request } = at;
    await admitComment(at);
    // Looked at again after the crash: the same effect, no second send.
    const first = await runner.run(request);
    const again = await runner.run(request);
    assertEquals(first.kind, "completed");
    assertEquals(again, first);
    // The replay recorded nothing: each phase of one call is written once.
    assertEquals(
      phases(await feedOf(fixture, seeded.job.runId)),
      [["started", null, null], ["completed", true, null]],
    );
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
    const at = await atTheToolCall(fixture, github, { deadlineMs: 50 });
    const { seeded, runner, request } = at;
    await admitComment(at);
    const result = await runner.run(request);
    assertEquals(result, { kind: "pending" });
    // Still open: the feed shows the start and no outcome.
    assertEquals(
      phases(await feedOf(fixture, seeded.job.runId)),
      [["started", null, null]],
    );
    const effects = await effectsOf(fixture);
    assertEquals(effects.length, 1);
    assert(effects[0].status !== "confirmed");
  }));

Deno.test("a tool.call write the provider refuses fails the step with a fixed code (#435)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    github.post = { status: 422 };
    const at = await atTheToolCall(fixture, github);
    const { seeded, runner, request } = at;
    await admitComment(at);
    const result = await runner.run(request);
    assertEquals(
      result.kind === "failed" && result.code,
      "TOOL_CALL_EFFECT_FAILED",
    );
    assertEquals(
      phases(await feedOf(fixture, seeded.job.runId)),
      [["started", null, null], ["failed", false, "TOOL_CALL_EFFECT_FAILED"]],
    );
    // Paging: one item a page, resumed by the cursor, ends with a null cursor.
    const one = await feedOf(fixture, seeded.job.runId, 1);
    assertEquals(one.items.length, 1);
    assert(one.nextCursor !== null);
    const second = await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        readRunFeed(transaction, {
          secret: FEED_SECRET,
          organizationId: fixture.organizationId,
          principalId: fixture.principalId,
          runId: seeded.job.runId,
          cursor: one.nextCursor!,
          limit: 1,
        }),
    );
    assertEquals(second.items.map((item) => item.tool.phase), ["failed"]);
    assertEquals(second.nextCursor, null);
    const effects = await effectsOf(fixture);
    assertEquals(effects.length, 1);
    assertEquals(effects[0].status, "failed");
  }));

// ---------------------------------------------------------------------------
// #439: the per-call cost ceiling, held before a send and ended after it.
// ---------------------------------------------------------------------------

/** The two accounts the ceiling is held on, and the reservations it made. */
async function ledgerOf(fixture: WorkerFixture, runId: string) {
  const accounts = await fixture.pgDatabase.query<{
    scope: string;
    reserved: string;
    settled: string;
  }>(
    `select scope, reserved_usd::text as reserved, settled_usd::text as settled
       from bakery.budget_accounts
      where (scope = 'run' and organization_id = $1 and run_id = $2)
         or scope = 'installation'
      order by scope`,
    [fixture.organizationId, runId],
  );
  const reservations = await fixture.pgDatabase.query<{
    key: string;
    status: string;
    reserved: string;
    settled: string | null;
  }>(
    `select dedupe_key as key, status, reserved_usd::text as reserved,
            settled_usd::text as settled
       from bakery.budget_reservations
      where organization_id = $1 and dedupe_key like 'tool-call:%'
      order by dedupe_key, id`,
    [fixture.organizationId],
  );
  return { accounts: accounts.rows, reservations: reservations.rows };
}

type Ledger = Awaited<ReturnType<typeof ledgerOf>>;

/** What each account gained since `before`, as (scope, reserved, settled). */
const gained = (before: Ledger, after: Ledger) =>
  after.accounts.map((row, index) => [
    row.scope,
    (Number(row.reserved) - Number(before.accounts[index].reserved)).toFixed(6),
    (Number(row.settled) - Number(before.accounts[index].settled)).toFixed(6),
  ]);

/**
 * The seeded run's own job already holds money, so the run's account is capped
 * to leave exactly `headroom` USD above what it holds now: the test, not the
 * fixture, decides what fits.
 */
async function capRunBudget(
  fixture: WorkerFixture,
  runId: string,
  headroom: number,
) {
  await fixture.pgDatabase.query(
    `update bakery.budget_accounts
        set limit_usd = reserved_usd + settled_usd + $3::numeric
      where scope = 'run' and organization_id = $1 and run_id = $2`,
    [fixture.organizationId, runId, headroom.toFixed(6)],
  );
}

/** The request of the admitted step, with the id of its row. */
async function admittedRequest(
  fixture: WorkerFixture,
  at: AtTheToolCall,
): Promise<EngineStepRequest> {
  const row = await fixture.pgDatabase.query<{ id: string }>(
    `select id from bakery.run_steps where run_id = $1 and step_key = 'comment'`,
    [at.seeded.job.runId],
  );
  return { ...at.request, runStepId: row.rows[0].id };
}

/** A rig with a ceiling, the run's budget capped to one such call, and the ledger as it stands. */
async function withCeiling(
  fixture: WorkerFixture,
  github: FakeGithub,
  effects: EffectOptions = {},
) {
  const at = await atTheToolCall(fixture, github, effects, CEILING);
  await capRunBudget(fixture, at.seeded.job.runId, 0.005);
  return { at, before: await ledgerOf(fixture, at.seeded.job.runId) };
}

Deno.test("a tool.call step with a per-call ceiling holds it, then settles it at the ceiling once the write is confirmed (#439)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    const { at, before } = await withCeiling(fixture, github);
    // Through the engine: the ceiling comes from the step's own dispatch.
    await admitComment(at);
    assertEquals(
      (await step(fixture, at.seeded.job.runId)).status,
      "completed",
    );
    assertEquals(github.posts(), 1);
    const key = `tool-call:${at.seeded.job.runId}:comment:0`;
    const ledger = await ledgerOf(fixture, at.seeded.job.runId);
    // One hold on each account, settled at the ceiling: a tool reports no cost.
    assertEquals(
      ledger.reservations.map((row) => [row.key, row.status, row.settled]),
      [[key, "settled", "0.003000"], [key, "settled", "0.003000"]],
    );
    assertEquals(gained(before, ledger), [
      ["installation", "0.000000", "0.003000"],
      ["run", "0.000000", "0.003000"],
    ]);
    // Looked at again after the crash: the same effect, and nothing charged twice.
    const request = await admittedRequest(fixture, at);
    assertEquals((await at.runner.run(request)).kind, "completed");
    assertEquals(await ledgerOf(fixture, at.seeded.job.runId), ledger);
    assertEquals(github.posts(), 1);
  }));

Deno.test("a ceiling the run's budget cannot cover refuses the step before anything is sent (#439)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    const { at, before } = await withCeiling(fixture, github);
    await admitComment(at);
    const request = await admittedRequest(fixture, at);
    assertEquals(github.posts(), 1);
    // The run has 0.005 USD of room and 0.003 is spent: a second 0.003 does not fit.
    const second = await at.runner.run({ ...request, iteration: 1 });
    assertEquals(
      second.kind === "failed" && second.code,
      "TOOL_CALL_BUDGET_EXCEEDED",
    );
    assertEquals(github.posts(), 1);
    assertEquals((await effectsOf(fixture)).length, 1);
    const ledger = await ledgerOf(fixture, at.seeded.job.runId);
    // Nothing was held for the refused call, and the first call's charge stands.
    assertEquals(ledger.reservations.length, 2);
    assertEquals(gained(before, ledger), [
      ["installation", "0.000000", "0.003000"],
      ["run", "0.000000", "0.003000"],
    ]);
  }));

Deno.test("a write the provider refuses gives the ceiling back (#439)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    github.post = { status: 422 };
    const { at, before } = await withCeiling(fixture, github);
    await admitComment(at);
    const ledger = await ledgerOf(fixture, at.seeded.job.runId);
    assertEquals(
      ledger.reservations.map((row) => [row.status, row.settled]),
      [["released", null], ["released", null]],
    );
    assertEquals(gained(before, ledger), [
      ["installation", "0.000000", "0.000000"],
      ["run", "0.000000", "0.000000"],
    ]);
  }));

Deno.test("a write whose outcome is not known keeps the ceiling held until the engine gives up, which charges it (#439)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    github.post = "hang";
    const { at, before } = await withCeiling(fixture, github, {
      deadlineMs: 50,
    });
    await admitComment(at);
    const request = await admittedRequest(fixture, at);
    // Looked at again while still unproven: the same hold, no second one.
    assertEquals(await at.runner.run(request), { kind: "pending" });
    let ledger = await ledgerOf(fixture, at.seeded.job.runId);
    assertEquals(ledger.reservations.length, 2);
    assertEquals(
      ledger.reservations.every((row) => row.status === "held"),
      true,
    );
    assertEquals(gained(before, ledger), [
      ["installation", "0.003000", "0.000000"],
      ["run", "0.003000", "0.000000"],
    ]);
    // The engine ends the step it never settled: whether the write ran is not
    // known, so the ceiling is charged, never handed back.
    await at.runner.abandon!(request);
    await at.runner.abandon!(request);
    ledger = await ledgerOf(fixture, at.seeded.job.runId);
    assertEquals(
      ledger.reservations.every((row) => row.status === "settled"),
      true,
    );
    assertEquals(gained(before, ledger), [
      ["installation", "0.000000", "0.003000"],
      ["run", "0.000000", "0.003000"],
    ]);
  }));

Deno.test("a step with no ceiling holds nothing (#439)", () =>
  withWorkerFixture(async (fixture) => {
    const github = fakeGithub();
    const at = await atTheToolCall(fixture, github);
    await admitComment(at);
    assertEquals(
      (await step(fixture, at.seeded.job.runId)).status,
      "completed",
    );
    assertEquals(
      (await ledgerOf(fixture, at.seeded.job.runId)).reservations,
      [],
    );
  }));
