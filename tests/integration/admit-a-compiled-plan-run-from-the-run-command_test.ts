import { assert, assertEquals } from "@std/assert";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  planRuntimeFromSnapshot,
  planTaskFromSnapshot,
} from "../../apps/server/src/modules/workflow-adapter/plan-state.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { pinWorkflowRuntime } from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetPolicy,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";
import {
  asOverride,
  numbersRule,
  publishWorkflow,
  seedRulesRepository,
} from "../helpers/pinned-rules.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

// #30 E3b-2c. The run command admits a published workflow that declares
// `apiVersion` as a compiled plan: it compiles the version again, resolves the
// agent each step will run as, freezes the plan and the sections it reads, and
// writes no step rows (the engine appends each step as the plan decides it).
// A flat workflow is admitted as before.

type RunBody = { id: string; status: string; workflowVersionId: string };
type PlanDefinition = {
  steps: { steps: { with: Record<string, unknown> }[] }[];
};

const plan = (
  over: {
    stepAgent?: string;
    agents?: Record<string, string>;
    unboundSecondStep?: boolean;
    /** The steps as a bare list, which the fixed executor runs. */
    flat?: boolean;
    /** A wait between the two steps, which the engine cannot run yet. */
    wait?: boolean;
  } = {},
) => {
  const artifact = `$step.${
    over.flat === true ? "" : "flow."
  }brief.artifact.versionId`;
  const implement = (id: string, needs: string, extra: object = {}) => ({
    id,
    needs: [needs],
    uses: "harness.implement",
    ...extra,
    with: {
      repositoryId: "$input.repositoryId",
      planArtifact: artifact,
      instructions: "$input.instructions",
    },
  });
  const body = [
    {
      id: "brief",
      uses: "task.brief",
      with: { brief: "$input.brief", repositoryId: "$input.repositoryId" },
    },
    ...(over.wait !== true
      ? []
      : [{ id: "pause", needs: ["brief"], wait: { duration: "1m" } }]),
    implement(
      "implement",
      over.wait === true ? "pause" : "brief",
      over.stepAgent === undefined ? {} : { agentVersionId: over.stepAgent },
    ),
    ...(over.unboundSecondStep !== true
      ? []
      : [implement("again", "implement")]),
  ];
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: "plan-admission",
    description: "A compiled plan admitted by the run command.",
    ...(over.agents === undefined ? {} : { agents: over.agents }),
    inputs: {
      repositoryId: { type: "uuid", required: true },
      brief: { type: "TaskBrief", required: true },
      instructions: { type: "string", required: true },
      note: { type: "string", required: false },
    },
    // A sequence is a container node, which makes this a compiled plan.
    steps: over.flat === true ? body : [{ id: "flow", steps: body }],
  };
};

const runInputs = (repository: { repositoryId: string }) => ({
  repositoryId: repository.repositoryId,
  brief: {
    title: "Add upload retry",
    description: "Retry failed uploads twice.",
    taskType: "feature",
  },
  instructions: "Go.",
});

async function repositoryWithAgent(fixture: WorkerFixture, label: string) {
  const agent = await seedFundedCodingAgent(fixture, fixture, label);
  const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
    agentVersionId: agent,
  });
  return { agent, repository };
}

/** Starts a run of one published version, returning the raw response. */
async function start(
  fixture: WorkerFixture,
  repository: Awaited<ReturnType<typeof seedPresetRepository>>,
  versionId: string,
  body: Record<string, unknown> = {},
) {
  const task = await createPresetTask(fixture, fixture, repository);
  const response = await apiCall(
    fixture,
    fixture,
    "POST",
    `/v1/tasks/${task.id}/runs`,
    {
      body: {
        workflowVersionId: versionId,
        executionMode: "repository",
        repositoryProfileId: repository.profileId,
        budgetLimitUsd: "5.00",
        inputs: runInputs(repository),
        ...body,
      },
    },
  );
  return { task, response };
}

async function facts(fixture: WorkerFixture, taskId: string) {
  const db = fixture.pgDatabase;
  const runs = (await db.query<{ n: string }>(
    `select count(*)::text as n from bakery.workflow_runs where task_id = $1`,
    [taskId],
  )).rows[0].n;
  const task = (await db.query<{ status: string; run: string | null }>(
    `select status, current_run_id as run from bakery.tasks where id = $1`,
    [taskId],
  )).rows[0];
  return { runs: Number(runs), status: task.status, currentRun: task.run };
}

async function snapshotOf(fixture: WorkerFixture, runId: string) {
  return (await fixture.pgDatabase.query<{ snapshot: Record<string, unknown> }>(
    `select snapshot from bakery.workflow_runs where id = $1`,
    [runId],
  )).rows[0].snapshot;
}

async function stepRows(fixture: WorkerFixture, runId: string) {
  return (await fixture.pgDatabase.query<
    {
      stepKey: string;
      status: string;
      dispatch: Record<string, unknown> | null;
    }
  >(
    `select step_key as "stepKey", status, dispatch
       from bakery.run_steps where run_id = $1 order by position, id`,
    [runId],
  )).rows;
}

Deno.test("a published plan is admitted as a plan: frozen sections, no step rows, the task queued", () =>
  withWorkerFixture(async (fixture) => {
    const { agent, repository } = await repositoryWithAgent(fixture, "plan");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-run",
      plan(),
    );
    const { task, response } = await start(fixture, repository, versionId);
    const run = await expectJson<RunBody>(response, 201);
    assertEquals(run.status, "queued");
    assertEquals(run.workflowVersionId, versionId);

    const snapshot = await snapshotOf(fixture, run.id);
    // The runtime section has exactly the pin and the document.
    const runtime = snapshot.runtime as Record<string, unknown>;
    assertEquals(Object.keys(runtime).sort(), ["document", "pin"]);
    const read = await planRuntimeFromSnapshot(snapshot);
    assert(read !== null);
    assertEquals(read.pin, await pinWorkflowRuntime(read.document));
    assertEquals(read.document.apiVersion, "bakery.dev/v1");
    // The inputs are frozen whole; `$task` is the task as it was admitted.
    // An optional input the run did not give is frozen as null.
    assertEquals(snapshot.inputs, { ...runInputs(repository), note: null });
    const frozenTask = planTaskFromSnapshot(snapshot) as Record<
      string,
      unknown
    >;
    assertEquals(frozenTask.id, task.id);
    assertEquals(frozenTask.status, "draft");
    assertEquals(frozenTask.repositoryId, repository.repositoryId);
    assertEquals(frozenTask.title, "Add upload retry");
    // The one model step falls back to the profile's binding, frozen by id.
    assertEquals(Object.keys(snapshot.planAgents as object), [agent]);
    assertEquals(snapshot.planActionAgents, { "harness.implement": agent });
    // The flat sections are empty, not missing: flat readers still work.
    assertEquals(snapshot.stepAgents, {});
    assertEquals(snapshot.stepActions, {});
    assertEquals(snapshot.executionMode, "repository");
    // No rows up front; the task is queued on this run.
    assertEquals(await stepRows(fixture, run.id), []);
    assertEquals(await facts(fixture, task.id), {
      runs: 1,
      status: "queued",
      currentRun: run.id,
    });
  }));

Deno.test("the engine runs the admitted plan on: it appends each step, and the fallback agent rides the dispatch", () =>
  withWorkerFixture(async (fixture) => {
    const { agent, repository } = await repositoryWithAgent(fixture, "engine");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-engine",
      plan(),
    );
    const { response } = await start(fixture, repository, versionId);
    const run = await expectJson<RunBody>(response, 201);
    const engine = createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 3,
      budgetPolicy: presetBudgetPolicy,
    });
    const owner = await engine.acquireEngineOwner(
      run.id,
      `e3b2c-${crypto.randomUUID()}`,
      60_000,
    );
    assert(owner !== undefined);

    const first = await engine.findNext(run.id, owner);
    assertEquals(first?.stepKey, "flow.brief");
    let rows = await stepRows(fixture, run.id);
    assertEquals(rows.map((row) => [row.stepKey, row.status]), [[
      "flow.brief",
      "pending",
    ]]);
    assertEquals(rows[0].dispatch?.action, "task.brief");
    // task.brief is not a model step: it has no agent.
    assertEquals(rows[0].dispatch?.agentVersionId, undefined);
    // The engine turns that dispatch into a worker job on this very snapshot.
    const briefJob = await engine.admit(first!, owner);
    assertEquals(briefJob.terminal, false);
    assert(briefJob.jobId !== undefined);

    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set status = 'completed', finished_at = now(), output = $2::jsonb
        where run_id = $1 and step_key = 'flow.brief'`,
      [
        run.id,
        JSON.stringify({ artifact: { versionId: crypto.randomUUID() } }),
      ],
    );
    const second = await engine.findNext(run.id, owner);
    assertEquals(second?.stepKey, "flow.implement");
    rows = await stepRows(fixture, run.id);
    assertEquals(rows.map((row) => row.stepKey), [
      "flow.brief",
      "flow.implement",
    ]);
    assertEquals(rows[1].dispatch?.action, "harness.implement");
    // The step names no agent; its action's fallback was frozen at admission.
    assertEquals(rows[1].dispatch?.agentVersionId, agent);
    assertEquals(
      (rows[1].dispatch?.input as Record<string, unknown>).instructions,
      "Go.",
    );
    // And the job it becomes runs as that agent, which the run froze.
    const implementJob = await engine.admit(second!, owner);
    assertEquals(implementJob.terminal, false);
    const job = (await fixture.pgDatabase.query<
      { action: string; agentVersionId: string | null }
    >(
      `select action, agent_version_id as "agentVersionId"
         from bakery.jobs where id = $1`,
      [implementJob.jobId],
    )).rows[0];
    assertEquals(job, { action: "harness.implement", agentVersionId: agent });
  }));

Deno.test("a step's own agent is the one frozen and dispatched; a profile binding nothing uses is not frozen", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "profile");
    const stepAgent = await seedFundedCodingAgent(fixture, fixture, "step");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-step-agent",
      plan({ stepAgent }),
    );
    const { response } = await start(fixture, repository, versionId);
    const run = await expectJson<RunBody>(response, 201);
    const snapshot = await snapshotOf(fixture, run.id);
    assertEquals(Object.keys(snapshot.planAgents as object), [stepAgent]);
    assertEquals(snapshot.planActionAgents, {});
  }));

// Each refusal below is set up to break exactly one rule, is named by the reason
// the problem carries, and leaves no run, no step rows and the task still a
// draft.

async function refused(
  fixture: WorkerFixture,
  repository: Awaited<ReturnType<typeof seedPresetRepository>>,
  versionId: string,
  status: number,
  body: Record<string, unknown> = {},
) {
  const { task, response } = await start(fixture, repository, versionId, body);
  const text = await response.text();
  assertEquals(response.status, status, text);
  assertEquals(await facts(fixture, task.id), {
    runs: 0,
    status: "draft",
    currentRun: null,
  });
  return JSON.parse(text) as {
    code: string;
    reason?: string;
    issues?: { path: string[] }[];
  };
}

Deno.test("the workflow's own agents map wins over the profile's binding, and only the winner is frozen", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "profile");
    const workflowAgent = await seedFundedCodingAgent(fixture, fixture, "wf");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-workflow-agents",
      plan({ agents: { "harness.implement": workflowAgent } }),
    );
    const { response } = await start(fixture, repository, versionId);
    const run = await expectJson<RunBody>(response, 201);
    const snapshot = await snapshotOf(fixture, run.id);
    assertEquals(Object.keys(snapshot.planAgents as object), [workflowAgent]);
    assertEquals(snapshot.planActionAgents, {
      "harness.implement": workflowAgent,
    });
  }));

Deno.test("a step keeps its own agent while a later step of the same action takes the fallback", () =>
  withWorkerFixture(async (fixture) => {
    const { agent, repository } = await repositoryWithAgent(fixture, "profile");
    const stepAgent = await seedFundedCodingAgent(fixture, fixture, "step");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-two-implements",
      plan({ stepAgent, unboundSecondStep: true }),
    );
    const { response } = await start(fixture, repository, versionId);
    const run = await expectJson<RunBody>(response, 201);
    const snapshot = await snapshotOf(fixture, run.id);
    assertEquals(
      Object.keys(snapshot.planAgents as object).sort(),
      [agent, stepAgent].sort(),
    );
    assertEquals(snapshot.planActionAgents, { "harness.implement": agent });

    const engine = createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 3,
    });
    const owner = await engine.acquireEngineOwner(
      run.id,
      `e3b2c-${crypto.randomUUID()}`,
      60_000,
    );
    assert(owner !== undefined);
    const agents: Record<string, unknown> = {};
    for (const key of ["flow.brief", "flow.implement", "flow.again"]) {
      assertEquals((await engine.findNext(run.id, owner))?.stepKey, key);
      agents[key] = (await stepRows(fixture, run.id)).find((row) =>
        row.stepKey === key
      )?.dispatch?.agentVersionId;
      await fixture.pgDatabase.query(
        `update bakery.run_steps
            set status = 'completed', finished_at = now(), output = $3::jsonb
          where run_id = $1 and step_key = $2`,
        [
          run.id,
          key,
          JSON.stringify({ artifact: { versionId: crypto.randomUUID() } }),
        ],
      );
    }
    assertEquals(agents, {
      "flow.brief": undefined,
      "flow.implement": stepAgent,
      "flow.again": agent,
    });
  }));

Deno.test("a run whose fallback-agent section is malformed ends failed by name when the engine reaches it, never half dispatched", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "malformed");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-malformed",
      plan(),
    );
    const { task, response } = await start(fixture, repository, versionId);
    const run = await expectJson<RunBody>(response, 201);
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs
          set snapshot = jsonb_set(snapshot, '{planActionAgents}', '"x"'::jsonb)
        where id = $1`,
      [run.id],
    );
    const engine = createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 3,
    });
    const owner = await engine.acquireEngineOwner(
      run.id,
      `e3b2c-${crypto.randomUUID()}`,
      60_000,
    );
    assert(owner !== undefined);
    // The first step (task.brief) has no agent but the section is still read.
    assertEquals(await engine.findNext(run.id, owner), undefined);
    assertEquals(await stepRows(fixture, run.id), []);
    assertEquals((await facts(fixture, task.id)).status, "failed");
    const codes = (await fixture.pgDatabase.query<{ code: string }>(
      `select details->>'code' as code from bakery.audit_events
        where resource_id = $1 and operation = 'workflow.plan_failed'`,
      [run.id],
    )).rows.map((row) => row.code);
    assertEquals(codes, ["plan_snapshot_invalid"]);
  }));

Deno.test("inputs the plan cannot start with are refused at their own path and leave nothing behind", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "inputs");
    const full = runInputs(repository);
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-inputs",
      plan(),
    );
    for (
      const [inputs, name] of [
        [{ ...full, brief: undefined }, "brief"],
        [{ ...full, extra: "x" }, "extra"],
        [{ ...full, brief: 7 }, "brief"],
        [{ ...full, repositoryId: "not-a-uuid" }, "repositoryId"],
      ] as [Record<string, unknown>, string][]
    ) {
      const problem = await refused(fixture, repository, versionId, 422, {
        inputs,
      });
      assertEquals(problem.code, "UNPROCESSABLE");
      assertEquals(problem.issues?.[0].path, ["inputs", name]);
    }
  }));

Deno.test("inputs that fit the run but not the job once the profile rides along are refused up front", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "toolarge");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-too-large",
      plan(),
    );
    // 98,000 bytes pass the run's own 100,000-byte bound; the job also carries
    // the repository profile and rules, which tips it over the transport bound.
    const inputs = {
      ...runInputs(repository),
      instructions: "x".repeat(98_000),
    };
    const problem = await refused(fixture, repository, versionId, 422, {
      inputs,
    });
    assertEquals(problem.issues?.[0].path, ["inputs"]);
    assertEquals(JSON.stringify(problem).includes("inputs_too_large"), true);
    // Without the profile (a smaller input) the same plan is admitted.
    const { response } = await start(fixture, repository, versionId, {
      inputs: { ...inputs, instructions: "x".repeat(90_000) },
    });
    await expectJson<RunBody>(response, 201);
  }));

Deno.test("a model step with no agent anywhere is refused", () =>
  withWorkerFixture(async (fixture) => {
    const bare = await seedPresetRepository(fixture.pgDatabase, fixture, {});
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-no-agent",
      plan(),
    );
    assertEquals(
      (await refused(fixture, bare, versionId, 409)).reason,
      "model_agent_required",
    );
  }));

Deno.test("a step agent that does not exist, and a budget below its reservation, are refused", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "refuse");
    const ghost = await publishWorkflow(
      fixture,
      fixture,
      "plan-ghost-agent",
      plan({ stepAgent: crypto.randomUUID() }),
    );
    assertEquals(
      (await refused(fixture, repository, ghost.versionId, 409)).reason,
      "agent_version_unavailable",
    );
    const ordinary = await publishWorkflow(
      fixture,
      fixture,
      "plan-budget",
      plan(),
    );
    // The seeded agent reserves 1.00 per step; 0.50 cannot cover it.
    assertEquals(
      (await refused(fixture, repository, ordinary.versionId, 409, {
        budgetLimitUsd: "0.50",
      })).reason,
      "budget_below_reservation",
    );
  }));

Deno.test("a published plan that no longer compiles is refused, not half started", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "stale");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-stale",
      plan(),
    );
    // As if a later compiler or registry now judged an input of the first
    // step to be the wrong type. The stored digest is kept true to the edited
    // spec, so this is the compile that refuses, not the version's integrity
    // check (an action it no longer knew would already be refused as an invalid
    // version, before the plan is compiled).
    const stored = (await fixture.pgDatabase.query<{ spec: PlanDefinition }>(
      `select normalized_spec as spec from bakery.workflow_versions where id = $1`,
      [versionId],
    )).rows[0].spec;
    stored.steps[0].steps[0].with.brief = 7;
    await fixture.pgDatabase.query(
      `update bakery.workflow_versions
          set normalized_spec = $2::jsonb, digest = $3
        where id = $1`,
      [
        versionId,
        JSON.stringify(stored),
        await sha256Hex(canonicalJson(stored)),
      ],
    );
    assertEquals(
      (await refused(fixture, repository, versionId, 409)).reason,
      "workflow_plan_not_compilable",
    );
  }));

Deno.test("a repository rule that requires a check stage refuses a plan, which the guard cannot read yet, and leaves nothing behind", () =>
  withWorkerFixture(async (fixture) => {
    const governed = await seedRulesRepository(fixture, fixture, "governed", {
      entries: [asOverride(numbersRule())],
    });
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-governed",
      plan(),
    );
    assertEquals(
      (await refused(fixture, governed, versionId, 409)).reason,
      "workflow_plan_rules_unsupported",
    );
    // (The same plan is admitted where no rule requires a stage: the first test.)
  }));

Deno.test("a compiler-grammar workflow that is a bare list of steps stays on the fixed executor, rows and all", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "bare");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-bare-list",
      plan({ flat: true }),
    );
    const { response } = await start(fixture, repository, versionId);
    const run = await expectJson<RunBody>(response, 201);
    const snapshot = await snapshotOf(fixture, run.id);
    assert(!Object.hasOwn(snapshot, "runtime"));
    assertEquals(
      (await stepRows(fixture, run.id)).map((row) => row.stepKey),
      ["brief", "implement"],
    );
  }));

Deno.test("a plan with a wait, which the engine cannot run yet, is refused as the fixed executor refused it", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "wait");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-wait",
      plan({ wait: true }),
    );
    assertEquals(
      (await refused(fixture, repository, versionId, 409)).reason,
      "workflow_not_executable",
    );
  }));

Deno.test("a flat workflow is admitted exactly as before: its rows, its agents, no runtime section", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "flat");
    const task = await createPresetTask(fixture, fixture, repository);
    const run = await expectJson<RunBody>(
      await startPresetRun(fixture, fixture, task, repository),
      201,
    );
    const snapshot = await snapshotOf(fixture, run.id);
    for (
      const key of ["runtime", "task", "planAgents", "planActionAgents"]
    ) {
      assert(!Object.hasOwn(snapshot, key), key);
    }
    assertEquals((await stepRows(fixture, run.id)).length, 2);
    assertEquals(
      Object.keys(snapshot.stepAgents as object).length > 0,
      true,
    );
  }));
