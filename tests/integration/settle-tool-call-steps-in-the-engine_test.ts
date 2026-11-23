import { assert, assertEquals } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  composeEngineStepRunners,
  type EngineStepRequest,
} from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import { createToolCallStepRunner } from "../../apps/server/src/modules/tool-call/tool-call-step.ts";
import { createPostgresToolCallRecorder } from "../../apps/server/src/modules/tool-call/tool-call-record.ts";
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
