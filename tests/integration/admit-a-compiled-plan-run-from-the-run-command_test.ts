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
  type PresetRepository,
  seedFundedCodingAgent,
  seedPresetRepository,
} from "../helpers/fixed-coding-preset.ts";
import {
  asOverride,
  numbersRule,
  publishWorkflow,
  seedRulesRepository,
} from "../helpers/pinned-rules.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
  receiveInspectionSource,
} from "../helpers/repository-inspection.ts";
import { reviewedPlanDocument } from "../helpers/review-repair/plan-loop-document.ts";
import {
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
} from "../helpers/worker-execution.ts";
import { clientFor } from "../helpers/output-ingestion.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
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
    /**
     * A wait between the two steps: `true` is a duration wait, which the
     * engine runs; "event" is an event wait, which it cannot run yet.
     */
    wait?: boolean | "event";
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
    ...(over.wait === undefined || over.wait === false ? [] : [{
      id: "pause",
      needs: ["brief"],
      wait: over.wait === "event"
        ? { event: "question.answered", timeout: "1h" }
        : { duration: "1m" },
    }]),
    implement(
      "implement",
      over.wait ? "pause" : "brief",
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

/**
 * A repository whose active profile is a server-derived v2 observation, with the
 * plan's actions bound to one funded agent.
 *
 * A review-loop plan is refused on a profile whose fixed policy denies its
 * steps, and a hand-built v2 profile is refused because it names a checker
 * digest no observation backs. So the profile is produced the way production
 * produces it: a real inspection over a mapped repository.
 */
async function observedRepositoryWithAgent(
  fixture: WorkerFixture,
  label: string,
): Promise<{ agent: string; repository: PresetRepository }> {
  const agent = await seedFundedCodingAgent(fixture, fixture, label);
  const harness = await openRepositoryInspectionHarness(
    { authDb: fixture.pgDatabase, appPg: fixture.runtimePgDatabase },
    {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
    },
  );
  try {
    const created = await harness.createRepository(false, {
      // A fixed-policy publication is a command: it needs the repository
      // version it was read at, and a freshly created repository is at 1.
      profileHeaders: { "if-match": '"1"' },
      profileConfig: {
        schemaVersion: 1,
        workflow: { kind: "fixed" },
        branches: { base: "main", allowedPatterns: ["feature/*"] },
        worktree: { root: ".bakery/worktrees" },
        agentBindings: {
          "harness.implement": agent,
          "harness.repair": agent,
          "review.independent": agent,
        },
        // A fixed-policy draft on the baseline. The inspection derives the v2
        // profile from it and stamps the trusted checker, which is the only
        // profile admission accepts for a plan that checks or reviews.
        fixedPolicy: {
          schemaVersion: 1,
          commands: [
            { id: "unit", argv: ["pnpm", "test:unit"] },
            { id: "lint", argv: ["pnpm", "lint"] },
          ],
          allowedEffects: [
            "artifact_only",
            "repository_revision",
            "evidence_only",
            "review_evidence",
          ],
          lockedConfiguration: {
            branches: true,
            worktree: true,
            checker: true,
          },
          decisions: [
            { commandId: "unit", mode: "require" },
            { commandId: "lint", mode: "warn" },
          ],
        },
      },
    });
    await harness.onboard(created.repositoryId);
    const assignment = await readInspectionAssignment(await harness.claim());
    await harness.start(assignment);
    const receipt = await receiveInspectionSource(harness, assignment);
    const report = await harness.report(assignment.input, receipt);
    const result = await harness.result(assignment, report);
    assertEquals(result.status, 200, await result.clone().text());
    const active = await fixture.pgDatabase.query<
      { active_profile_id: string; digest: string }
    >(
      `select r.active_profile_id, p.digest
         from bakery.repositories r
         join bakery.repository_profiles p
           on p.organization_id = r.organization_id
          and p.id = r.active_profile_id
        where r.organization_id = $1 and r.id = $2`,
      [fixture.organizationId, created.repositoryId],
    );
    const row = active.rows[0]!;
    return {
      agent,
      repository: {
        organizationId: fixture.organizationId,
        applicationId: created.applicationId,
        repositoryId: created.repositoryId,
        profileId: row.active_profile_id,
        profileDigest: row.digest,
        agentVersionId: agent,
      },
    };
  } finally {
    await harness.close();
  }
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
    issues?: { path: string[]; message?: string; code?: string }[];
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

Deno.test("a step agent that does not exist is refused when the plan is published, and a budget below its reservation at admission", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "refuse");
    // A definition naming an agent version that does not exist is refused when
    // it is published, not when someone tries to run it: a published version is
    // a frozen contract, and one that can never run must not exist.
    const ghost = await apiCall(fixture, fixture, "POST", "/v1/workflows", {
      body: {
        slug: "plan-ghost-agent",
        name: "plan-ghost-agent",
        description: "",
      },
    });
    const ghostWorkflow = await expectJson<{ id: string }>(ghost, 201);
    const ghostDraft = await expectJson<{ id: string }>(
      await apiCall(
        fixture,
        fixture,
        "POST",
        `/v1/workflows/${ghostWorkflow.id}/versions`,
        { body: { definition: plan({ stepAgent: crypto.randomUUID() }) } },
      ),
      201,
    );
    const ghostPublish = await apiCall(
      fixture,
      fixture,
      "POST",
      `/v1/workflows/${ghostWorkflow.id}/versions/${ghostDraft.id}/publish`,
      { body: {}, headers: { "If-Match": '"1"' } },
    );
    const ghostProblem = await expectJson<{
      issues: { path: (string | number)[]; code: string }[];
    }>(ghostPublish, 422);
    assertEquals(
      ghostProblem.issues.map((item) => [item.path, item.code]),
      [[
        ["steps", 0, "steps", 1, "agentVersionId"],
        "agent_version_unavailable",
      ]],
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

/** The plan of `plan()` with a check stage of the pinned rule after its implement step. */
const checkedPlan = (over: { guarded?: boolean; before?: boolean } = {}) => {
  const base = plan();
  const flow = base.steps[0] as { steps: Record<string, unknown>[] };
  const [brief, implement] = flow.steps;
  const check = {
    id: "check",
    needs: [over.before === true ? "brief" : "implement"],
    uses: "quality.check",
    ...(over.guarded === true ? { if: '$input.note == "go"' } : {}),
    with: {
      repositoryId: "$input.repositoryId",
      revision: over.before === true
        ? "0000000000000000000000000000000000000000"
        : "$step.flow.implement.headSha",
      checks: ["magic.numbers"],
    },
  };
  return {
    ...base,
    steps: [{
      id: "flow",
      steps: over.before === true
        ? [brief, check, { ...implement, needs: ["check"] }]
        : [brief, implement, check],
    }],
  };
};

Deno.test("a repository rule that requires a check is read against a plan's shape: a plan with its check after the last revision is admitted, and one without is refused naming the rule", () =>
  withWorkerFixture(async (fixture) => {
    const governed = await seedRulesRepository(fixture, fixture, "governed", {
      entries: [asOverride(numbersRule())],
    });
    const refusal = async (
      name: string,
      document: unknown,
      code: string,
    ) => {
      const { versionId } = await publishWorkflow(
        fixture,
        fixture,
        name,
        document,
      );
      const { task, response } = await start(fixture, governed, versionId);
      const text = await response.text();
      assertEquals(response.status, 422, text);
      const body = JSON.parse(text) as {
        code: string;
        issues: { code: string; message: string }[];
      };
      assertEquals(body.code, "UNPROCESSABLE");
      assertEquals(body.issues.map((issue) => issue.code), [code]);
      assert(body.issues[0].message.includes("Rule code.magicNumbers "));
      // Nothing was admitted: no run, the task stays a draft.
      assertEquals(await facts(fixture, task.id), {
        runs: 0,
        status: "draft",
        currentRun: null,
      });
    };
    await refusal(
      "plan-governed-missing",
      plan(),
      "repository_rule_stage_missing",
    );
    await refusal(
      "plan-governed-guarded",
      checkedPlan({ guarded: true }),
      "repository_rule_stage_missing",
    );
    await refusal(
      "plan-governed-reordered",
      checkedPlan({ before: true }),
      "repository_rule_stage_before_revision",
    );
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-governed-ok",
      checkedPlan(),
    );
    const { response } = await start(fixture, governed, versionId);
    const run = await expectJson<RunBody>(response, 201);
    assert(Object.hasOwn(await snapshotOf(fixture, run.id), "runtime"));
    // (The same plan without a check is admitted where no rule requires one: the first test.)
  }));

Deno.test("a bare list of steps is admitted as a plan, not kept on a fixed executor", () =>
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
    // #400: admission resolves a plan for every run, so even a bare step list
    // carries a plan runtime and gets no flat rows of its own.
    assert(Object.hasOwn(snapshot, "runtime"));
    assertEquals(await stepRows(fixture, run.id), []);
  }));

async function admittedCloudOnlyJob(fixture: WorkerFixture) {
  const { agent, repository } = await repositoryWithAgent(fixture, "cloud");
  const task = await expectJson<{ id: string }>(
    await apiCall(fixture, fixture, "POST", "/v1/tasks", {
      body: {
        applicationId: repository.applicationId,
        taskType: "maintenance",
        title: "Cloud-only plan",
        description: "A plan that mounts no repository.",
      },
    }),
    201,
  );
  const { versionId } = await publishWorkflow(
    fixture,
    fixture,
    "plan-cloud-only",
    {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "plan-cloud-only",
      description: "A model step with no repository.",
      agents: { "agent.freeform": agent },
      inputs: { prompt: { type: "string", required: true } },
      steps: [{
        id: "flow",
        steps: [{
          id: "draft",
          uses: "agent.freeform",
          with: {
            prompt: "$input.prompt",
            maxTurns: 3,
            timeout: "5m",
            maxCostUsd: 1,
            allowedTools: [],
          },
        }],
      }],
    },
  );
  const response = await apiCall(
    fixture,
    fixture,
    "POST",
    `/v1/tasks/${task.id}/runs`,
    {
      body: {
        workflowVersionId: versionId,
        executionMode: "cloud_only",
        budgetLimitUsd: "5.00",
        inputs: { prompt: "Summarise the open maintenance work." },
      },
    },
  );
  const run = await expectJson<RunBody>(response, 201);
  const snapshot = await snapshotOf(fixture, run.id);
  assertEquals(snapshot.executionMode, "cloud_only");
  assertEquals(snapshot.repositoryProfile, null);
  assertEquals(Object.keys(snapshot.planAgents as object), [agent]);

  const engine = createBakeryPostgresWorkflowRepository({
    database: fixture.pgDatabase,
    maxAttempts: 3,
    budgetPolicy: presetBudgetPolicy,
  });
  const owner = await engine.acquireEngineOwner(
    run.id,
    `cloud-${crypto.randomUUID()}`,
    60_000,
  );
  assert(owner !== undefined);
  const key = await engine.findNext(run.id, owner);
  assertEquals(key?.stepKey, "flow.draft");
  const admission = await engine.admit(key!, owner);
  assertEquals(admission.terminal, false);
  assert(admission.jobId !== undefined);
  return { agent, repository, task, jobId: admission.jobId! };
}

Deno.test("a cloud-only plan run with a model agent admits a real job that carries no repository pins", () =>
  withWorkerFixture(async (fixture) => {
    const { agent, jobId } = await admittedCloudOnlyJob(fixture);
    const job = (await fixture.pgDatabase.query<Record<string, unknown>>(
      `select application_id, repository_id, repository_profile_id,
              repository_profile_revision, repository_profile_digest,
              observation_id, observation_digest, base_sha, action, status,
              agent_version_id
         from bakery.jobs where id = $1`,
      [jobId],
    )).rows[0];
    assertEquals(job, {
      application_id: null,
      repository_id: null,
      repository_profile_id: null,
      repository_profile_revision: null,
      repository_profile_digest: null,
      observation_id: null,
      observation_digest: null,
      base_sha: null,
      action: "agent.freeform",
      status: "queued",
      agent_version_id: agent,
    });
  }));

Deno.test("a worker opens output for a cloud-only model job under its task's application", () =>
  withWorkerFixture(async (fixture) => {
    const { repository, task } = await admittedCloudOnlyJob(fixture);
    const worker = await registeredWorker(fixture, { slots: 1 });
    const client = clientFor(fixture, worker.credential);
    const session = {
      workerSessionId: worker.registration.workerSessionId,
      workerSessionGeneration: worker.registration.workerSessionGeneration,
    };
    const assignment = (await client.claim({
      claimKey: crypto.randomUUID(),
      workerHostId: worker.registration.workerHostId,
      capabilities: [...workerFixtureCapabilities],
      ...session,
    })).value;
    assert(assignment);
    const binding = (await client.openOutput(
      assignment.attemptId,
      contractSchemas.WorkerOutputOpen.parse({
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        ...session,
      }),
      crypto.randomUUID(),
    )).value;
    assertEquals(
      [binding.organizationId, binding.applicationId, binding.taskId],
      [fixture.organizationId, repository.applicationId, task.id],
    );
  }));

Deno.test("a plan with a duration wait is admitted, and the engine puts the wait between its steps as a row without a job", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "duration");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-duration",
      plan({ wait: true }),
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
      `e4a-${crypto.randomUUID()}`,
      60_000,
    );
    assert(owner !== undefined);
    const first = await engine.findNext(run.id, owner);
    assertEquals(first?.stepKey, "flow.brief");
    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set status = 'completed', finished_at = now(), output = $2::jsonb
        where run_id = $1 and step_key = 'flow.brief'`,
      [
        run.id,
        JSON.stringify({ artifact: { versionId: crypto.randomUUID() } }),
      ],
    );
    const pause = await engine.findNext(run.id, owner);
    assertEquals(pause?.stepKey, "flow.pause");
    let rows = await stepRows(fixture, run.id);
    assertEquals(rows.map((row) => [row.stepKey, row.status]), [
      ["flow.brief", "completed"],
      ["flow.pause", "waiting"],
    ]);
    const boundary = await engine.readWait(pause!, owner);
    assertEquals(boundary?.durationMs, 60_000);
    assertEquals(
      (await fixture.pgDatabase.query<{ count: string }>(
        `select count(*)::text as count
           from bakery.jobs job join bakery.run_steps step
             on step.organization_id = job.organization_id
            and step.id = job.run_step_id
          where step.run_id = $1 and step.step_key = 'flow.pause'`,
        [run.id],
      )).rows[0].count,
      "0",
    );
    // Its time passes; the step after it is dispatched as itself.
    await fixture.pgDatabase.query(
      `update bakery.run_steps
          set started_at = started_at - interval '2 minutes'
        where run_id = $1 and step_key = 'flow.pause'`,
      [run.id],
    );
    assertEquals(await engine.completeWait(pause!, owner), true);
    const after = await engine.findNext(run.id, owner);
    assertEquals(after?.stepKey, "flow.implement");
    rows = await stepRows(fixture, run.id);
    assertEquals(rows.map((row) => row.stepKey), [
      "flow.brief",
      "flow.pause",
      "flow.implement",
    ]);
    assertEquals(rows[2].dispatch?.action, "harness.implement");
  }));

Deno.test("a plan with an event wait, which the engine cannot run yet, is refused as the fixed executor refused it", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "wait");
    const { versionId } = await publishWorkflow(
      fixture,
      fixture,
      "plan-wait",
      plan({ wait: "event" }),
    );
    assertEquals(
      (await refused(fixture, repository, versionId, 409)).reason,
      "workflow_not_executable",
    );
  }));

Deno.test("a preset run is admitted as a plan: plan sections written, no flat step agents", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "flat");
    // A bare list of steps, not a sequence: the fixed executor runs this one, so
    // it keeps its step rows and freezes no plan sections. The `fixed-coding`
    // preset used to be this shape; it is a compiled plan since it was written
    // as a document, so the flat case needs a definition of its own.
    const flat = await publishWorkflow(
      fixture,
      fixture,
      "plan-flat",
      plan({ flat: true }),
    );
    const run = await expectJson<RunBody>(
      (await start(fixture, repository, flat.versionId)).response,
      201,
    );
    const snapshot = await snapshotOf(fixture, run.id);
    // #400: a preset used to be the one remaining flat run. It is now admitted
    // as a plan like everything else, so the plan sections are present and the
    // flat ones the old path wrote are absent.
    for (const key of ["runtime", "task", "planAgents", "planActionAgents"]) {
      assert(Object.hasOwn(snapshot, key), key);
    }
    assertEquals(snapshot.stepAgents, {});
    assertEquals(snapshot.stepActions, {});
  }));

const reviewedDocument = (name: string, agent: string) =>
  reviewedPlanDocument({
    name,
    agents: {
      "harness.implement": agent,
      "harness.repair": agent,
      "review.independent": agent,
    },
    repairs: 3,
  });

Deno.test("a plan that reviews is refused when the profile cannot run a review loop", () =>
  withWorkerFixture(async (fixture) => {
    // A v1 profile has no fixed policy and no trusted checker, so it cannot run
    // checks or a review. The refusal is the point: the plan's review loop is
    // read at admission and the run is refused before anything is written.
    const { agent, repository } = await repositoryWithAgent(fixture, "v1");
    const reviewed = await publishWorkflow(
      fixture,
      fixture,
      "plan-reviewed-v1",
      reviewedDocument("plan-reviewed-v1", agent),
    );
    assertEquals(
      (await refused(fixture, repository, reviewed.versionId, 422)).reason,
      undefined,
    );
  }));

Deno.test("a plan that reviews is admitted on a server-derived v2 profile with its review loop frozen, and a plan that does not review freezes none", () =>
  withWorkerFixture(async (fixture) => {
    const { agent, repository } = await observedRepositoryWithAgent(
      fixture,
      "loop",
    );
    const reviewed = await publishWorkflow(
      fixture,
      fixture,
      "plan-reviewed",
      reviewedDocument("plan-reviewed", agent),
    );
    const first = await expectJson<RunBody>(
      (await start(fixture, repository, reviewed.versionId)).response,
      201,
    );
    assert(Object.hasOwn(await snapshotOf(fixture, first.id), "reviewLoop"));

    const plain = await publishWorkflow(fixture, fixture, "plan-plain", plan());
    const second = await start(fixture, repository, plain.versionId);
    const other = await expectJson<RunBody>(second.response, 201);
    // A plan with no review freezes no review loop.
    assertEquals(
      Object.hasOwn(await snapshotOf(fixture, other.id), "reviewLoop"),
      false,
    );
  }));

Deno.test("a workflow that names a projection action is admitted as a compiled plan, even as a bare list the fixed executor would take", () =>
  withWorkerFixture(async (fixture) => {
    const { repository } = await repositoryWithAgent(fixture, "projection");
    const evidence = {
      headSha: "1".repeat(40),
      baseSha: "2".repeat(40),
      policyDigest: "c".repeat(64),
      checksPassed: true,
      checkRunIds: ["00000000-0000-4000-8000-0000000000c1"],
      failedCheckIds: [],
      blockingFindings: 0,
      reviewId: "00000000-0000-4000-8000-0000000000b1",
      findings: [],
    };
    const projection = {
      id: "project",
      uses: "delivery.candidate_evidence",
      with: evidence,
    };
    const document = (steps: unknown[]) => ({
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "projection-admission",
      description: "A step the engine completes itself.",
      inputs: {
        repositoryId: { type: "uuid", required: true },
        brief: { type: "TaskBrief", required: true },
        instructions: { type: "string", required: true },
      },
      steps,
    });
    // Both forms hold a step with no job: the engine runs them, not the fixed
    // executor, so each is admitted as a plan (a runtime section, no step rows).
    for (
      const [name, steps] of [
        ["projection-bare", [projection]],
        ["projection-container", [{ id: "flow", steps: [projection] }]],
      ] as const
    ) {
      const published = await publishWorkflow(
        fixture,
        fixture,
        name,
        document([...steps]),
      );
      const { response } = await start(
        fixture,
        repository,
        published.versionId,
      );
      const run = await expectJson<RunBody>(response, 201);
      const snapshot = await snapshotOf(fixture, run.id);
      assert(Object.hasOwn(snapshot, "runtime"), name);
      assertEquals(await stepRows(fixture, run.id), [], name);
    }
  }));
