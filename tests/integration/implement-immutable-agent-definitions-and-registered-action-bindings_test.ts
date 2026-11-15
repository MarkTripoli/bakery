import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { agentVersionDigest } from "../../apps/server/src/modules/agents/postgres.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import {
  type BillingConfig,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  WORKFLOW_ACTION_NAMES,
  WORKFLOW_ACTION_REGISTRY_VERSION,
} from "../../packages/contracts/src/workflow-action-registry.ts";
import {
  FIXED_CODING_PRESET,
  renderImplementInstructions,
} from "../../packages/contracts/src/workflow-presets.ts";
import {
  admitPresetRun,
  apiCall,
  createPresetTask,
  expectJson,
  presetBilling,
  presetBudgetEnv,
  type PresetRepository,
  seedPresetRepository,
} from "../helpers/fixed-coding-preset.ts";
import { seedProviderPricingSnapshot } from "../helpers/funded-model-job.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  registeredWorker,
  type WorkerFixture,
  workerFixtureCapabilities,
} from "../helpers/worker-execution.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";

type Json = Record<string, unknown>;
type AgentVersion = Readonly<{
  id: string;
  agentId: string;
  revision: number;
  digest: string;
  config: Json;
}>;
type RunBody = { id: string; status: string; workflowVersionId: string };
type Problem = {
  code: string;
  status: number;
  issues?: { path: unknown; code: string }[];
  params?: { reason?: string; issues?: { path: unknown; code: string }[] };
};
type Report = {
  valid: boolean;
  errors: { path: string; code: string }[];
  warnings: { path: string; code: string }[];
  stepBindings?: Json[];
};

const withFixture = <T>(work: (fixture: WorkerFixture) => Promise<T>) =>
  withWorkerFixture(work, { env: presetBudgetEnv });

// Revision 3 declares the repository as an input (a compiled definition is
// type-checked), so the brief inputs are built per repository.
const briefInputs = (repositoryId: string) => ({
  repositoryId,
  brief: {
    title: "Add upload retry",
    description: "Retry failed uploads twice.",
    taskType: "feature",
  },
  instructions: renderImplementInstructions({
    title: "Add upload retry",
    description: "Retry failed uploads twice.",
  }),
});

/** Deep copy of the two-step fixed coding spec with optional bindings. */
function definitionWith(
  bindings: {
    stepAgentVersionId?: string;
    workflowAgentVersionId?: string;
    implementWith?: Json;
    root?: Json;
  } = {},
): Json {
  const spec = JSON.parse(JSON.stringify(FIXED_CODING_PRESET.spec)) as Json;
  // Revision 3 nests the stages in one sequence.
  const steps = spec.steps as Json[];
  const sequence = steps.find((step) => step.id === "flow")!;
  const implement = (sequence.steps as Json[]).find((step) =>
    step.id === "implement"
  )!;
  if (bindings.stepAgentVersionId !== undefined) {
    implement.agentVersionId = bindings.stepAgentVersionId;
  }
  if (bindings.implementWith !== undefined) {
    implement.with = bindings.implementWith;
  }
  if (bindings.workflowAgentVersionId !== undefined) {
    spec.agents = { "harness.implement": bindings.workflowAgentVersionId };
  }
  return { ...spec, ...(bindings.root ?? {}) };
}

function makeApi(fixture: WorkerFixture) {
  const call = (
    method: "GET" | "POST" | "PATCH",
    path: string,
    options: { body?: unknown; ifMatch?: string } = {},
  ) =>
    apiCall(fixture, fixture, method, path, {
      body: options.body,
      headers: options.ifMatch === undefined
        ? undefined
        : { "If-Match": options.ifMatch },
    });
  const problemOf = async (response: Response): Promise<Problem> =>
    await response.json() as Problem;
  const issuesOf = (problem: Problem) =>
    problem.issues ?? problem.params?.issues ?? [];

  const createAgent = async (slug: string): Promise<string> =>
    (await expectJson<{ id: string }>(
      await call("POST", "/v1/agents", {
        body: {
          slug: `${slug}-${crypto.randomUUID().slice(0, 8)}`,
          name: `Agent ${slug}`,
          description: "Immutable agent for binding precedence proofs.",
        },
      }),
      201,
    )).id;

  const addVersion = async (
    agentId: string,
    revision: number,
    config: Json,
    options: { priced?: boolean } = {},
  ): Promise<AgentVersion> => {
    const billing = config.billing as BillingConfig | undefined;
    if (billing !== undefined && options.priced !== false) {
      await seedProviderPricingSnapshot(fixture.pgDatabase, { billing });
    }
    return await expectJson<AgentVersion>(
      await call("POST", `/v1/agents/${agentId}/versions`, {
        body: { revision, config, digest: await agentVersionDigest(config) },
      }),
      201,
    );
  };
  const billedConfig = (label: string): Json => ({
    harness: "codex",
    billing: presetBilling(label),
  });
  const agentState = async (agentId: string) =>
    await expectJson<
      { version: number; activeVersionId: string | null; enabled: boolean }
    >(await call("GET", `/v1/agents/${agentId}`), 200);
  const activateAgentVersion = async (agentId: string, versionId: string) => {
    const before = await agentState(agentId);
    await expectJson(
      await call("POST", `/v1/agents/${agentId}/activations`, {
        body: { versionId },
        ifMatch: `"${before.version}"`,
      }),
      200,
    );
  };

  const createWorkflow = async (slug: string): Promise<string> =>
    (await expectJson<{ id: string }>(
      await call("POST", "/v1/workflows", {
        body: {
          slug: `${slug}-${crypto.randomUUID().slice(0, 8)}`,
          name: slug,
          description: "Synthetic workflow for agent binding proofs.",
        },
      }),
      201,
    )).id;
  const publishDraft = async (
    workflowId: string,
    definition: Json,
  ): Promise<Response> => {
    const draft = await expectJson<{ id: string }>(
      await call("POST", `/v1/workflows/${workflowId}/versions`, {
        body: { definition },
      }),
      201,
    );
    return await call(
      "POST",
      `/v1/workflows/${workflowId}/versions/${draft.id}/publish`,
      { body: {}, ifMatch: '"1"' },
    );
  };
  const publish = async (
    workflowId: string,
    definition: Json,
  ): Promise<string> =>
    (await expectJson<{ id: string }>(
      await publishDraft(workflowId, definition),
      200,
    )).id;
  const activateWorkflow = async (workflowId: string, versionId: string) => {
    const definition = await expectJson<{ version: number }>(
      await call("GET", `/v1/workflows/${workflowId}`),
      200,
    );
    await expectJson(
      await call("POST", `/v1/workflows/${workflowId}/activations`, {
        body: { versionId },
        ifMatch: `"${definition.version}"`,
      }),
      200,
    );
  };
  const validate = async (definition: Json): Promise<Report> => {
    const report = await expectJson<Report>(
      await call("POST", "/v1/workflow-validations", { body: { definition } }),
      200,
    );
    assert(contractSchemas.ValidationReport.safeParse(report).success);
    return report;
  };

  const startRun = async (
    repository: PresetRepository,
    target: { workflowId?: string; workflowVersionId?: string },
    title: string,
  ): Promise<Response> => {
    const task = await createPresetTask(fixture, fixture, repository, {
      title,
    });
    return await call("POST", `/v1/tasks/${task.id}/runs`, {
      body: {
        ...target,
        executionMode: "repository",
        repositoryProfileId: repository.profileId,
        budgetLimitUsd: "5.00",
        inputs: briefInputs(repository.repositoryId),
      },
    });
  };

  return {
    call,
    problemOf,
    issuesOf,
    createAgent,
    addVersion,
    billedConfig,
    agentState,
    activateAgentVersion,
    createWorkflow,
    publishDraft,
    publish,
    activateWorkflow,
    validate,
    startRun,
  };
}

async function factCounts(database: PgDatabase, organizationId: string) {
  const result = await database.query<{
    jobs: string;
    reservations: string;
    intents: string;
    runs: string;
  }>(
    `select
       (select count(*) from bakery.jobs where organization_id = $1)::text as jobs,
       (select count(*) from bakery.budget_reservations where organization_id = $1)::text as reservations,
       (select count(*) from bakery.budget_action_intents where organization_id = $1)::text as intents,
       (select count(*) from bakery.workflow_runs where organization_id = $1)::text as runs`,
    [organizationId],
  );
  return result.rows[0]!;
}

type Snapshot = {
  stepAgents: Record<string, {
    agentVersionId: string;
    revision: number;
    digest: string;
    config: unknown;
  }>;
  stepActions: Record<string, {
    registryVersion: number | null;
    metadata: unknown;
  }>;
};

async function snapshotOf(
  database: PgDatabase,
  organizationId: string,
  runId: string,
): Promise<Snapshot> {
  const result = await database.query<{ snapshot: Snapshot }>(
    `select snapshot from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  return result.rows[0]!.snapshot;
}

async function addProfileRevision(
  database: PgDatabase,
  fixture: WorkerFixture,
  repository: PresetRepository,
  revision: number,
  agentVersionId: string,
): Promise<PresetRepository> {
  const profileId = crypto.randomUUID();
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
    agentBindings: { "harness.implement": agentVersionId },
  };
  const profileDigest = await sha256Hex(canonicalJson(config));
  await database.query(
    `insert into bakery.repository_profiles (
       id, organization_id, application_id, repository_id, revision, config,
       digest, created_by
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      profileId,
      fixture.organizationId,
      repository.applicationId,
      repository.repositoryId,
      revision,
      JSON.stringify(config),
      profileDigest,
      fixture.principalId,
    ],
  );
  await database.query(
    `update bakery.repositories set active_profile_id = $3
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, repository.repositoryId, profileId],
  );
  return { ...repository, profileId, profileDigest, agentVersionId };
}

Deno.test("step, workflow and profile bindings freeze v1 and survive every default change", () =>
  withFixture(async (fixture) => {
    const api = makeApi(fixture);
    const database = fixture.pgDatabase;
    const agentId = await api.createAgent("precedence");
    const v1 = await api.addVersion(agentId, 1, api.billedConfig("prec-v1"));
    const v2 = await api.addVersion(agentId, 2, api.billedConfig("prec-v2"));
    const v3 = await api.addVersion(agentId, 3, api.billedConfig("prec-v3"));
    await api.activateAgentVersion(agentId, v1.id);

    // Separate repositories, each profile binds v3 except the profile leg (v1).
    const repoS = await seedPresetRepository(database, fixture, {
      agentVersionId: v3.id,
    });
    const repoW = await seedPresetRepository(database, fixture, {
      agentVersionId: v3.id,
    });
    const repoP = await seedPresetRepository(database, fixture, {
      agentVersionId: v1.id,
    });

    const definitionS = definitionWith({
      stepAgentVersionId: v1.id,
      workflowAgentVersionId: v2.id,
    });
    const definitionW = definitionWith({ workflowAgentVersionId: v1.id });
    const definitionP = definitionWith();

    // Validation reports the effective binding source per step.
    const reportOf = async (definition: Json) => {
      const report = await api.validate(definition);
      assertEquals(report.valid, true, JSON.stringify(report));
      // The plan qualifies each step with its container's id.
      const binding = report.stepBindings?.find((entry) =>
        entry.stepId === "flow.implement"
      );
      assert(binding, JSON.stringify(report));
      return binding;
    };
    const stepBinding = await reportOf(definitionS);
    assertEquals(stepBinding.source, "step");
    assertEquals(stepBinding.agentVersionId, v1.id);
    assertEquals(stepBinding.revision, 1);
    assertEquals(stepBinding.digest, v1.digest);
    assertEquals(stepBinding.modelBillingRequired, true);
    assertEquals((await reportOf(definitionW)).source, "workflow");
    assertEquals((await reportOf(definitionW)).agentVersionId, v1.id);
    assertEquals((await reportOf(definitionW)).digest, v1.digest);
    const noneBinding = await reportOf(definitionP);
    assertEquals(noneBinding.source, "none");
    assertEquals(noneBinding.agentVersionId, null);

    // Publish and activate r1 of three workflows.
    const workflowS = await api.createWorkflow("prec-step");
    const workflowW = await api.createWorkflow("prec-workflow");
    const workflowP = await api.createWorkflow("prec-profile");
    const r1S = await api.publish(workflowS, definitionS);
    const r1W = await api.publish(workflowW, definitionW);
    const r1P = await api.publish(workflowP, definitionP);
    await api.activateWorkflow(workflowS, r1S);
    await api.activateWorkflow(workflowW, r1W);
    await api.activateWorkflow(workflowP, r1P);

    const runS = await expectJson<RunBody>(
      await api.startRun(repoS, { workflowId: workflowS }, "Step run"),
      201,
    );
    const runW = await expectJson<RunBody>(
      await api.startRun(repoW, { workflowId: workflowW }, "Workflow run"),
      201,
    );
    const runP = await expectJson<RunBody>(
      await api.startRun(repoP, { workflowId: workflowP }, "Profile run"),
      201,
    );
    assertEquals(runS.workflowVersionId, r1S);
    assertEquals(runW.workflowVersionId, r1W);
    assertEquals(runP.workflowVersionId, r1P);
    const legs = [
      ["step", runS],
      ["workflow", runW],
      ["profile", runP],
    ] as const;
    for (const [leg, run] of legs) {
      const snapshot = await snapshotOf(
        database,
        fixture.organizationId,
        run.id,
      );
      // A plan run freezes its resolved agents by version id, not by step key.
      const planAgents = (snapshot as unknown as {
        planAgents: Record<
          string,
          { agentVersionId: string; digest: string; revision: number }
        >;
      }).planAgents;
      const frozen = Object.values(planAgents);
      assertEquals(
        frozen.length,
        1,
        `${leg} freezes the one model step's agent`,
      );
      assertEquals(
        frozen[0].agentVersionId,
        v1.id,
        `${leg} run freezes v1 at admission`,
      );
      assertEquals(frozen[0].digest, v1.digest, `${leg} digest`);
      assertEquals(frozen[0].revision, 1, `${leg} revision`);
    }

    // A plan freezes its resolved agents by version id, so the one model step's
    // agent is the only entry.
    const frozenAgentOf = async (runId: string) =>
      Object.values(
        (await snapshotOf(
          database,
          fixture.organizationId,
          runId,
        ) as unknown as {
          planAgents: Record<
            string,
            { agentVersionId: string; digest: string; revision: number }
          >;
        }).planAgents,
      )[0];

    // Change every default. Run admission never reads
    // agent_definitions.active_version_id (agent-run-admission.ts resolves
    // step > workflow > profile and activation only moves that column), so the
    // activation leg asserts the pointer moved while the jobs below keep v1.
    await api.activateAgentVersion(agentId, v2.id);
    assertEquals((await api.agentState(agentId)).activeVersionId, v2.id);
    const r2S = await api.publish(
      workflowS,
      definitionWith({
        stepAgentVersionId: v2.id,
        workflowAgentVersionId: v2.id,
      }),
    );
    const r2W = await api.publish(
      workflowW,
      definitionWith({ workflowAgentVersionId: v2.id }),
    );
    await api.activateWorkflow(workflowS, r2S);
    await api.activateWorkflow(workflowW, r2W);
    const profileS2 = await addProfileRevision(
      database,
      fixture,
      repoS,
      2,
      v2.id,
    );
    const profileW2 = await addProfileRevision(
      database,
      fixture,
      repoW,
      2,
      v2.id,
    );
    const profileP2 = await addProfileRevision(
      database,
      fixture,
      repoP,
      2,
      v2.id,
    );
    assertNotEquals(profileS2.profileId, repoS.profileId);
    assertNotEquals(profileW2.profileId, repoW.profileId);

    // Engine admission, dispatch recheck and worker claim for every old run.
    const expectedConfig = (await database.query<{ config: unknown }>(
      "select config from bakery.agent_versions where organization_id = $1 and id = $2",
      [fixture.organizationId, v1.id],
    )).rows[0]!.config;
    const admitted = new Map<string, string>();
    for (const [, run] of legs) {
      const result = await admitPresetRun(database, fixture, run);
      admitted.set(result.implementJobId, run.id);
    }
    const workers = [];
    for (let index = 0; index < legs.length; index += 1) {
      workers.push(
        await registeredWorker(fixture, {
          name: `precedence-${index}-${crypto.randomUUID().slice(0, 6)}`,
          capabilities: workerFixtureCapabilities,
        }),
      );
    }
    for (const worker of workers) {
      const assignment = await claimAssignment(fixture, worker, {
        supportedActions: ["harness.implement"],
      });
      const runId = admitted.get(assignment.jobId);
      assert(runId, "claimed job belongs to an admitted run");
      assertEquals(assignment.agentVersionId, v1.id);
      assertEquals(assignment.agentConfig, expectedConfig);
      assertEquals(
        (assignment.billing as BillingConfig).pricingMetadataSnapshot,
        "preset-price-prec-v1",
      );
      const job = await database.query<{
        agent_version_id: string;
        agent_config: unknown;
      }>(
        `select agent_version_id, agent_config from bakery.jobs
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, assignment.jobId],
      );
      assertEquals(job.rows[0]!.agent_version_id, v1.id);
      assertEquals(job.rows[0]!.agent_config, expectedConfig);
      const snapshot = await snapshotOf(
        database,
        fixture.organizationId,
        runId,
      );
      assertEquals(
        (snapshot as unknown as {
          planAgents: Record<string, { agentVersionId: string }>;
        }).planAgents[v1.id].agentVersionId,
        v1.id,
      );
      const frozenAgent = (snapshot as unknown as {
        planAgents: Record<
          string,
          { digest: string; revision: number }
        >;
      }).planAgents[v1.id];
      assertEquals(frozenAgent.digest, v1.digest);
      assertEquals(frozenAgent.revision, 1);
      // A plan run freezes no per-step action rows; it pins the compiled
      // document itself, which is what the flat snapshot's stepActions recorded
      // per step.
      const pin = (snapshot as unknown as {
        runtime: {
          pin: { semanticDigest: string; compilerVersion: string };
        };
      }).runtime.pin;
      assert(/^[a-f0-9]{64}$/.test(pin.semanticDigest), pin.semanticDigest);
      assertEquals(pin.compilerVersion, "2");
    }
    assertEquals(admitted.size, 3);
    assertEquals((await api.agentState(agentId)).activeVersionId, v2.id);

    // Non-vacuity: the same changes steer fresh runs to v2. The workflow leg
    // uses a repository whose profile still binds v3, so v2 can only come
    // from the newly activated workflow version.
    const repoFresh = await seedPresetRepository(database, fixture, {
      agentVersionId: v3.id,
    });
    const freshW = await expectJson<RunBody>(
      await api.startRun(
        repoFresh,
        { workflowId: workflowW },
        "Fresh workflow",
      ),
      201,
    );
    assertEquals(freshW.workflowVersionId, r2W);
    assertEquals(
      (await frozenAgentOf(freshW.id)).agentVersionId,
      v2.id,
    );
    const freshS = await expectJson<RunBody>(
      await api.startRun(repoFresh, { workflowId: workflowS }, "Fresh step"),
      201,
    );
    assertEquals(freshS.workflowVersionId, r2S);
    assertEquals(
      (await frozenAgentOf(freshS.id)).agentVersionId,
      v2.id,
    );
    const freshP = await expectJson<RunBody>(
      await api.startRun(profileP2, { workflowId: workflowP }, "Fresh profile"),
      201,
    );
    assertEquals(freshP.workflowVersionId, r1P);
    assertEquals(
      (await frozenAgentOf(freshP.id)).agentVersionId,
      v2.id,
    );
  }));

Deno.test("a model step without a billed, model-capable agent version is refused at every binding level", () =>
  withFixture(async (fixture) => {
    const api = makeApi(fixture);
    const database = fixture.pgDatabase;
    const ok = await api.createAgent("ac1-ok");
    const okVersion = await api.addVersion(ok, 1, api.billedConfig("ac1-ok"));
    const unbilledAgent = await api.createAgent("ac1-unbilled");
    const unbilled = await api.addVersion(unbilledAgent, 1, {
      harness: "codex",
    });
    const deniedAgent = await api.createAgent("ac1-denied");
    const denied = await api.addVersion(deniedAgent, 1, {
      ...api.billedConfig("ac1-denied"),
      allowedCapabilities: ["git", "shell", "web"],
    });

    const before = await factCounts(database, fixture.organizationId);

    // Step and workflow levels fail publication with a pointer.
    for (
      const [name, version, expectedCode] of [
        ["unbilled", unbilled, "model_billing_required"],
        ["denied", denied, "agent_action_capability_denied"],
      ] as const
    ) {
      for (
        const [level, definition, path] of [
          [
            "step",
            definitionWith({ stepAgentVersionId: version.id }),
            // The plan's authored pointer reaches the step inside its sequence.
            ["steps", 0, "steps", 1, "agentVersionId"],
          ],
          [
            "workflow",
            definitionWith({ workflowAgentVersionId: version.id }),
            ["agents", "harness.implement"],
          ],
        ] as const
      ) {
        const label = `${name}/${level}`;
        const report = await api.validate(definition);
        assertEquals(report.valid, false, label);
        assertEquals(report.stepBindings, undefined, label);
        const response = await api.publishDraft(
          await api.createWorkflow("ac1"),
          definition,
        );
        assertEquals(response.status, 422, label);
        const issues = api.issuesOf(await api.problemOf(response));
        assertEquals(issues.length >= 1, true, label);
        assertEquals(issues[0].path, path, label);
        assertEquals(issues[0].code, expectedCode, label);
        assertEquals(report.errors[0].code, expectedCode, label);
      }
    }

    // Profile and none levels pass publication and fail run creation (409).
    const plain = await api.createWorkflow("ac1-plain");
    const plainVersion = await api.publish(plain, definitionWith());
    await api.activateWorkflow(plain, plainVersion);
    const cases: [string, PresetRepository][] = [
      [
        "profile/unbilled",
        await seedPresetRepository(database, fixture, {
          agentVersionId: unbilled.id,
        }),
      ],
      [
        "profile/denied",
        await seedPresetRepository(database, fixture, {
          agentVersionId: denied.id,
        }),
      ],
      ["none", await seedPresetRepository(database, fixture)],
    ];
    for (const [name, repository] of cases) {
      const response = await api.startRun(
        repository,
        { workflowId: plain },
        `AC1 ${name}`,
      );
      assertEquals(
        response.status,
        409,
        `${name}: ${await response.clone().text()}`,
      );
      await response.body?.cancel();
    }

    // Sanity: the same shape with a usable version is accepted.
    const goodRepository = await seedPresetRepository(database, fixture, {
      agentVersionId: okVersion.id,
    });
    const good = await api.startRun(
      goodRepository,
      { workflowId: plain },
      "AC1 ok",
    );
    assertEquals(good.status, 201);
    await good.body?.cancel();

    const after = await factCounts(database, fixture.organizationId);
    assertEquals(after.jobs, before.jobs);
    assertEquals(after.reservations, before.reservations);
    assertEquals(after.intents, before.intents);
    assertEquals(Number(after.runs), Number(before.runs) + 1);
  }));

Deno.test("action input carrying model or billing is refused at admission and creates no job", () =>
  withFixture(async (fixture) => {
    const api = makeApi(fixture);
    const database = fixture.pgDatabase;
    // Revision 3 is compiled, so the references are the document's own and the
    // repository is a declared input; `model`/`billing` are what the case is
    // about: the compiler refuses them on a step, which is why the case now
    // proves the refusal at publish and then that nothing is admitted.
    const implementWith = {
      repositoryId: "$input.repositoryId",
      planArtifact: "$step.flow.brief.artifact.versionId",
      instructions: "$input.instructions",
      model: "gpt-override",
      billing: { maxUsdReservation: 1000 },
    };
    const before = await factCounts(database, fixture.organizationId);
    const workflow = await api.createWorkflow("d6-input");
    // Revision 3 compiles, so a step carrying `model` or `billing` is refused
    // before anything can run: the input's fields come from the registry alone,
    // which is a stronger guarantee than refusing it later at admission.
    const refused = await api.publishDraft(
      workflow,
      definitionWith({ implementWith }),
    );
    assertEquals(refused.status, 422);
    const problem = await api.problemOf(refused);
    assertEquals(problem.code, "UNPROCESSABLE");
    assert(
      JSON.stringify(problem).includes("input_field_unknown"),
      JSON.stringify(problem),
    );
    const after = await factCounts(database, fixture.organizationId);
    assertEquals(after.jobs, before.jobs);
    assertEquals(after.reservations, before.reservations);
    assertEquals(after.intents, before.intents);
    assertEquals(Number(after.runs), Number(before.runs));
  }));

Deno.test("a disabled agent blocks run creation and no job exists", () =>
  withFixture(async (fixture) => {
    const api = makeApi(fixture);
    const database = fixture.pgDatabase;
    const agentId = await api.createAgent("disabled");
    const version = await api.addVersion(agentId, 1, api.billedConfig("dis"));
    const definition = definitionWith({ stepAgentVersionId: version.id });
    const workflow = await api.createWorkflow("disabled");
    const versionId = await api.publish(workflow, definition);
    await api.activateWorkflow(workflow, versionId);
    const repository = await seedPresetRepository(database, fixture);
    const before = await factCounts(database, fixture.organizationId);
    const state = await api.agentState(agentId);
    await expectJson(
      await api.call("PATCH", `/v1/agents/${agentId}`, {
        body: { enabled: false },
        ifMatch: `"${state.version}"`,
      }),
      200,
    );
    const refused = await api.startRun(
      repository,
      { workflowId: workflow },
      "Disabled agent",
    );
    assertEquals(refused.status, 409, await refused.clone().text());
    await refused.body?.cancel();
    assertEquals(await factCounts(database, fixture.organizationId), before);
  }));

Deno.test("mounted discovery answers parse with the generated schemas and unauthenticated reads are a Problem", () =>
  withFixture(async (fixture) => {
    const api = makeApi(fixture);
    const page = await expectJson<{
      items: Json[];
      nextCursor: string | null;
    }>(await api.call("GET", "/v1/workflow-actions?limit=100"), 200);
    assertEquals(page.items.length, WORKFLOW_ACTION_NAMES.length);
    assertEquals(
      contractSchemas["Page<WorkflowActionDeclaration>"].safeParse(page)
        .success,
      true,
    );
    for (const declaration of page.items) {
      const detail = await expectJson<Json>(
        await api.call(
          "GET",
          `/v1/workflow-actions/${declaration.actionId}/versions/${WORKFLOW_ACTION_REGISTRY_VERSION}`,
        ),
        200,
      );
      assertEquals(detail, declaration);
      assertEquals(
        contractSchemas.WorkflowActionDeclaration.safeParse(detail).success,
        true,
        String(declaration.actionId),
      );
    }
    for (
      const path of [
        "/v1/workflow-actions",
        `/v1/workflow-actions/harness.implement/versions/${WORKFLOW_ACTION_REGISTRY_VERSION}`,
      ]
    ) {
      const response = await fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`),
      );
      assertEquals(response.status, 401);
      const body = await response.json();
      assertEquals(contractSchemas.Problem.safeParse(body).success, true);
      assert(!JSON.stringify(body).includes("harness.implement"));
    }
  }));
