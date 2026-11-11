import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { agentVersionDigest } from "../../apps/server/src/modules/agents/postgres.ts";
import { extractFixedWorkflowSteps } from "../../apps/server/src/modules/work/run-steps.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { createClaimsRepository } from "../../packages/persistence/src/claims.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import type { WorkerIdentity } from "../../packages/persistence/src/types.ts";
import { authRequest } from "../helpers/auth.ts";
import {
  makeUpload,
  openPublicationTestContext,
} from "../helpers/local-skill-publication.ts";
import { workerFixtureCapabilities } from "../helpers/worker-execution.ts";

const text = (value: string) => new TextEncoder().encode(value);
const digest64 = (character: string) => character.repeat(64);

type AgentVersion = Readonly<{
  id: string;
  agentId: string;
  revision: number;
  config: Record<string, unknown>;
  digest: string;
}>;

type RunFixture = Readonly<{
  runId: string;
  taskId: string;
  workflowVersionId: string;
  idempotencyKey: string;
  requestBody: Record<string, unknown>;
  responseBody: Record<string, unknown>;
}>;

type JobProjection = Readonly<{
  id: string;
  agent_version_id: string | null;
  agent_config: unknown;
  skill_refs: unknown;
}>;

Deno.test("authenticated run admission freezes agent pins and job admission projects only frozen context", async (test) => {
  const root = await Deno.makeTempDir({ prefix: "bakery-pin-producer-" });
  await Deno.chmod(root, 0o700);
  const context = await openPublicationTestContext({ root });
  const { fixture, organizationId, principalId } = context;
  const database = fixture.pgDatabase;
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const replacementProfileId = crypto.randomUUID();
  const agentlessProfileId = crypto.randomUUID();
  let agentlessProfileDigest = "";
  let legacyWrongInputJob: { runId: string; id: string } | null = null;
  const headers = {
    ...context.headers,
    "content-type": "application/json",
  };
  const post = (
    path: string,
    body: unknown,
    idempotencyKey: string = crypto.randomUUID(),
  ) =>
    fixture.app.fetch(authRequest(path, body, {
      cookie: context.cookie,
      headers: { ...headers, "Idempotency-Key": idempotencyKey },
    }));

  const createAgent = async (
    slug: string,
    config: Record<string, unknown>,
  ): Promise<AgentVersion> => {
    const agentResponse = await post("/v1/agents", {
      slug,
      name: `Agent ${slug}`,
      description: `Immutable ${slug} execution agent.`,
    });
    assertEquals(
      agentResponse.status,
      201,
      await agentResponse.clone().text(),
    );
    const agentId = (await agentResponse.json() as { id: string }).id;
    const versionResponse = await post(`/v1/agents/${agentId}/versions`, {
      revision: 1,
      config,
      digest: await agentVersionDigest(config),
    });
    assertEquals(
      versionResponse.status,
      201,
      await versionResponse.clone().text(),
    );
    return await versionResponse.json() as AgentVersion;
  };

  const createWorkflow = async (options: {
    action?: string;
    workflowAgentVersionId?: string;
    slug?: string;
    stepIds?: readonly string[];
    requires?: readonly string[];
    input?: unknown;
  }): Promise<string> => {
    const action = options.action ?? "quality.check";
    const workflowId = crypto.randomUUID();
    const workflowVersionId = crypto.randomUUID();
    const spec = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: options.slug ?? `pin-producer-${workflowId.slice(0, 8)}`,
      workflow: { kind: "fixed" },
      ...(options.workflowAgentVersionId
        ? { agents: { [action]: options.workflowAgentVersionId } }
        : {}),
      steps: (options.stepIds ?? ["quality"]).map((id) => ({
        id,
        uses: action,
        ...(options.requires === undefined
          ? {}
          : { requires: options.requires }),
        with: Object.hasOwn(options, "input")
          ? options.input
          : action === "quality.check"
          ? {
            repositoryId: "$task.repositoryId",
            revision: "HEAD",
            checks: ["fmt"],
          }
          : {},
      })),
    };
    // Workflow authoring is unavailable. Fixture persistence is allowed only
    // after the production fixed-workflow validator accepts the immutable spec.
    assertEquals(
      extractFixedWorkflowSteps(spec, "fixed").length,
      options.stepIds?.length ?? 1,
    );
    const workflowDigest = await sha256Hex(canonicalJson(spec));
    await database.query(
      `insert into bakery.workflow_definitions (
         id, organization_id, slug, name, description, enabled
       ) values ($1, $2, $3, $4, '', true)`,
      [
        workflowId,
        organizationId,
        options.slug ?? `pin-producer-${workflowId}`,
        options.slug ?? "Pin producer workflow",
      ],
    );
    await database.query(
      `insert into bakery.workflow_versions (
         id, organization_id, workflow_id, revision, source_yaml,
         normalized_spec, digest, status, created_by
       ) values ($1, $2, $3, 1, '', $4::jsonb, $5, 'published', $6)`,
      [
        workflowVersionId,
        organizationId,
        workflowId,
        JSON.stringify(spec),
        workflowDigest,
        principalId,
      ],
    );
    await database.query(
      `update bakery.workflow_definitions set active_version_id = $3
        where organization_id = $1 and id = $2`,
      [organizationId, workflowId, workflowVersionId],
    );
    return workflowVersionId;
  };

  const createTask = async (
    label: string,
    selectedProfile = { id: profileId, revision: 1, digest: profileDigest },
  ): Promise<string> => {
    const conversationId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    await database.query(
      `insert into bakery.conversations (
         id, organization_id, application_id, repository_id, title,
         created_by
       ) values ($1, $2, $3, $4, $5, $6)`,
      [
        conversationId,
        organizationId,
        applicationId,
        repositoryId,
        label,
        principalId,
      ],
    );
    await database.query(
      `insert into bakery.tasks (
         id, organization_id, application_id, repository_id, conversation_id,
         title, description, task_type, status, priority, created_by,
         repository_profile_id, repository_profile_revision,
         repository_profile_digest
       ) values ($1, $2, $3, $4, $5, $6, '', 'feature', 'draft', 50,
                 $7, $8, $9, $10)`,
      [
        taskId,
        organizationId,
        applicationId,
        repositoryId,
        conversationId,
        label,
        principalId,
        selectedProfile.id,
        selectedProfile.revision,
        selectedProfile.digest,
      ],
    );
    return taskId;
  };

  const startRun = async (
    workflowVersionId: string,
    label: string,
    selectedProfile = { id: profileId, revision: 1, digest: profileDigest },
    budgetLimitUsd?: string,
  ): Promise<RunFixture> => {
    const taskId = await createTask(label, selectedProfile);
    const idempotencyKey = `run-${label}-${crypto.randomUUID()}`;
    const requestBody = {
      workflowVersionId,
      executionMode: "repository",
      repositoryProfileId: selectedProfile.id,
      inputs: {},
      ...(budgetLimitUsd === undefined ? {} : { budgetLimitUsd }),
    };
    const response = await post(
      `/v1/tasks/${taskId}/runs`,
      requestBody,
      idempotencyKey,
    );
    assertEquals(response.status, 201, await response.clone().text());
    const responseBody = await response.json() as Record<string, unknown>;
    return {
      runId: responseBody.id as string,
      taskId,
      workflowVersionId,
      idempotencyKey,
      requestBody,
      responseBody,
    };
  };

  const expectRunRejectedAtomically = async (
    workflowVersionId: string,
    label: string,
  ): Promise<Record<string, unknown>> => {
    const taskId = await createTask(label);
    const key = `rejected-${label}-${crypto.randomUUID()}`;
    const before = await database.query<
      { runs: string; steps: string; jobs: string }
    >(
      `select
         (select count(*) from bakery.workflow_runs where organization_id = $1) as runs,
         (select count(*) from bakery.run_steps where organization_id = $1) as steps,
         (select count(*) from bakery.jobs where organization_id = $1) as jobs`,
      [organizationId],
    );
    const response = await post(`/v1/tasks/${taskId}/runs`, {
      workflowVersionId,
      executionMode: "repository",
      repositoryProfileId: profileId,
      inputs: {},
    }, key);
    assertEquals(response.status, 409, await response.clone().text());
    const problem = await response.json() as Record<string, unknown>;
    const after = await database.query<
      { runs: string; steps: string; jobs: string }
    >(
      `select
         (select count(*) from bakery.workflow_runs where organization_id = $1) as runs,
         (select count(*) from bakery.run_steps where organization_id = $1) as steps,
         (select count(*) from bakery.jobs where organization_id = $1) as jobs`,
      [organizationId],
    );
    assertEquals(after.rows, before.rows);
    const task = await database.query<{
      status: string;
      current_run_id: string | null;
    }>(
      `select status, current_run_id from bakery.tasks
        where organization_id = $1 and id = $2`,
      [organizationId, taskId],
    );
    assertEquals(task.rows[0], { status: "draft", current_run_id: null });
    const receipt = await database.query<{ count: string }>(
      `select count(*) from bakery.idempotency_records
        where organization_id = $1 and operation = 'runs.create' and key = $2`,
      [organizationId, key],
    );
    assertEquals(receipt.rows[0]?.count, "0");
    return problem;
  };

  let profileDigest = "";
  let foreignOrganizationId: string | undefined;
  try {
    const skillVersions: Array<{
      id: string;
      digest: string;
      skillId: string;
    }> = [];
    for (const name of ["explicit", "workflow", "profile"]) {
      const skill = await context.createSkill(`pin-${name}`);
      const upload = await makeUpload([
        { path: "SKILL.md", content: text(`${name} skill`) },
      ]);
      const publication = await context.publish(skill.id, upload);
      assertEquals(
        publication.status,
        201,
        await publication.clone().text(),
      );
      skillVersions.push({
        ...await publication.json() as { id: string; digest: string },
        skillId: skill.id,
      });
    }
    const explicitSkill = skillVersions[0]!;
    const workflowSkill = skillVersions[1]!;
    const profileSkill = skillVersions[2]!;
    const explicitAgent = await createAgent("pin-explicit-agent", {
      harness: "pi",
      billing: {
        provider: "immutable-provider",
        billingAccountId: "immutable-account",
        model: "immutable-model",
        billingRoute: "api",
        maxTokens: 2048,
        maxUsdReservation: 1,
        pricingMetadataSnapshot: "immutable-pricing-v1",
      },
      skillBindings: { primary: explicitSkill.id },
    });
    const workflowAgent = await createAgent("pin-workflow-agent", {
      harness: "pi",
      skillBindings: { primary: workflowSkill.id },
    });
    const profileAgent = await createAgent("pin-profile-agent", {
      harness: "pi",
      skillBindings: { primary: profileSkill.id },
    });
    const emptyAgent = await createAgent("pin-empty-agent", {
      harness: "pi",
      skillBindings: {},
    });
    const disabledAgent = await createAgent("pin-disabled-agent", {
      harness: "pi",
      skillBindings: { primary: explicitSkill.id },
    });
    const corruptAgent = await createAgent("pin-corrupt-agent", {
      harness: "pi",
      skillBindings: { primary: explicitSkill.id },
    });

    const profileConfig = {
      schemaVersion: 1,
      workflow: { kind: "fixed" },
      branches: { base: "main", allowedPatterns: ["feature/*"] },
      worktree: { root: ".bakery/worktrees" },
      agentBindings: { "quality.check": profileAgent.id },
    };
    profileDigest = await sha256Hex(canonicalJson(profileConfig));
    const replacementProfileConfig = {
      ...profileConfig,
      agentBindings: { "quality.check": emptyAgent.id },
    };
    const replacementProfileDigest = await sha256Hex(
      canonicalJson(replacementProfileConfig),
    );
    await database.query(
      `insert into bakery.applications (
         id, organization_id, slug, name, description
       ) values ($1, $2, $3, 'Pin producer app', '')`,
      [applicationId, organizationId, `pin-producer-${applicationId}`],
    );
    await database.query(
      `insert into bakery.repositories (
         id, organization_id, application_id, integration_connection_id,
         provider_repo_id, owner, name, default_branch
       ) values ($1, $2, $3, $4, $5, 'bakery', 'pin-producer', 'main')`,
      [
        repositoryId,
        organizationId,
        applicationId,
        crypto.randomUUID(),
        `bakery/pin-producer-${repositoryId}`,
      ],
    );
    await database.query(
      `insert into bakery.repository_profiles (
         id, organization_id, application_id, repository_id, revision,
         config, digest, created_by
       ) values
         ($1, $2, $3, $4, 1, $5::jsonb, $6, $7),
         ($8, $2, $3, $4, 2, $9::jsonb, $10, $7)`,
      [
        profileId,
        organizationId,
        applicationId,
        repositoryId,
        JSON.stringify(profileConfig),
        profileDigest,
        principalId,
        replacementProfileId,
        JSON.stringify(replacementProfileConfig),
        replacementProfileDigest,
      ],
    );
    await database.query(
      `update bakery.repositories set active_profile_id = $3
        where organization_id = $1 and id = $2`,
      [organizationId, repositoryId, profileId],
    );

    const agentlessProfileConfig = { ...profileConfig, agentBindings: {} };
    agentlessProfileDigest = await sha256Hex(
      canonicalJson(agentlessProfileConfig),
    );
    await database.query(
      `insert into bakery.repository_profiles (
         id, organization_id, application_id, repository_id, revision,
         config, digest, created_by
       ) values ($1, $2, $3, $4, 3, $5::jsonb, $6, $7)`,
      [
        agentlessProfileId,
        organizationId,
        applicationId,
        repositoryId,
        JSON.stringify(agentlessProfileConfig),
        agentlessProfileDigest,
        principalId,
      ],
    );

    const explicitWorkflow = await createWorkflow({
      workflowAgentVersionId: explicitAgent.id,
      slug: "workflow-primary",
    });
    const workflowDefault = await createWorkflow({
      workflowAgentVersionId: workflowAgent.id,
      slug: "workflow-same-action",
      stepIds: ["quality", "quality_two"],
    });
    const profileDefault = await createWorkflow({
      slug: "profile-precedence",
    });
    const noAgentWorkflow = await createWorkflow({
      slug: "no-agent",
      requires: ["web"],
    });
    const emptyBindingsWorkflow = await createWorkflow({
      workflowAgentVersionId: emptyAgent.id,
      slug: "empty-bindings",
      requires: ["web"],
    });
    const tamperWorkflow = await createWorkflow({
      workflowAgentVersionId: workflowAgent.id,
      slug: "step-selector-tamper",
    });

    const explicitRun = await startRun(explicitWorkflow, "workflow-primary");
    const workflowRun = await startRun(workflowDefault, "workflow");
    const profileRun = await startRun(profileDefault, "profile");
    await database.query(
      `update bakery.repositories set active_profile_id = $3 where organization_id = $1 and id = $2`,
      [organizationId, repositoryId, agentlessProfileId],
    );
    const noAgentRun = await startRun(noAgentWorkflow, "no-agent", {
      id: agentlessProfileId,
      revision: 3,
      digest: agentlessProfileDigest,
    });
    await database.query(
      `update bakery.repositories set active_profile_id = $3 where organization_id = $1 and id = $2`,
      [organizationId, repositoryId, profileId],
    );
    const emptyBindingsRun = await startRun(
      emptyBindingsWorkflow,
      "empty-bindings",
    );
    const tamperRun = await startRun(tamperWorkflow, "step-selector-tamper");

    await test.step("action binding selection freezes valid exact agent context and pins", async () => {
      const expected = [
        [explicitRun.runId, explicitAgent, explicitSkill],
        [workflowRun.runId, workflowAgent, workflowSkill],
        [profileRun.runId, profileAgent, profileSkill],
      ] as const;
      for (const [runId, agent, skill] of expected) {
        const result = await database.query<
          { snapshot: Record<string, unknown> }
        >(
          `select snapshot from bakery.workflow_runs
            where organization_id = $1 and id = $2`,
          [organizationId, runId],
        );
        const snapshot = result.rows[0]?.snapshot as {
          stepAgents: Record<string, {
            agentVersionId: string;
            revision: number;
            digest: string;
            config: unknown;
            skillRefs: unknown;
          }>;
        };
        const expectedAgent = {
          agentVersionId: agent.id,
          revision: agent.revision,
          digest: agent.digest,
          config: agent.config,
          skillRefs: [{ versionId: skill.id, digest: skill.digest }],
        };
        assertEquals(snapshot.stepAgents.quality, expectedAgent);
        if (runId === workflowRun.runId) {
          assertEquals(snapshot.stepAgents.quality_two, expectedAgent);
        }
      }
      const noAgentSnapshot = await database.query<{
        snapshot: { stepAgents: Record<string, unknown> };
      }>(
        `select snapshot from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [organizationId, noAgentRun.runId],
      );
      assertEquals(noAgentSnapshot.rows[0]?.snapshot.stepAgents, {});
      const emptySnapshot = await database.query<{
        snapshot: { stepAgents: Record<string, { skillRefs: unknown }> };
      }>(
        `select snapshot from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [organizationId, emptyBindingsRun.runId],
      );
      assertEquals(
        emptySnapshot.rows[0]?.snapshot.stepAgents.quality.skillRefs,
        [],
      );
    });

    foreignOrganizationId = crypto.randomUUID();
    const foreignAgentId = crypto.randomUUID();
    const foreignVersionId = crypto.randomUUID();
    const foreignConfig = { harness: "pi", skillBindings: {} };
    await database.query(
      `insert into bakery.organizations (
         id, name, slug, metadata, created_at, updated_at, version
       ) values ($1, 'Foreign pin org', $2, '{}'::jsonb, now(), now(), 1)`,
      [foreignOrganizationId, `foreign-pin-${foreignOrganizationId}`],
    );
    await database.query(
      `insert into bakery.agent_definitions (
         id, organization_id, slug, name, description, enabled
       ) values ($1, $2, 'foreign-pin-agent', 'Foreign pin agent', '', true)`,
      [foreignAgentId, foreignOrganizationId],
    );
    await database.query(
      `insert into bakery.agent_versions (
         id, organization_id, agent_id, revision, config, digest, created_by
       ) values ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
      [
        foreignVersionId,
        foreignOrganizationId,
        foreignAgentId,
        JSON.stringify(foreignConfig),
        await agentVersionDigest(foreignConfig),
        principalId,
      ],
    );
    await database.query(
      `update bakery.agent_definitions set enabled = false
        where organization_id = $1 and id = $2`,
      [organizationId, disabledAgent.agentId],
    );
    // Negative immutable-row tamper fixture: run admission must detect the
    // stored config digest mismatch and roll the whole command back.
    await database.query(
      `update bakery.agent_versions set digest = $3
        where organization_id = $1 and id = $2`,
      [organizationId, corruptAgent.id, digest64("f")],
    );

    await test.step("cross-org, missing, disabled, and hash mismatch selectors roll back", async () => {
      const missing = crypto.randomUUID();
      const cases = [
        ["cross-org", foreignVersionId, "agent_version_unavailable"],
        ["missing", missing, "agent_version_unavailable"],
        ["disabled", disabledAgent.id, "agent_version_unavailable"],
        ["hash-mismatch", corruptAgent.id, "agent_version_invalid"],
      ] as const;
      let unavailableProblem: Record<string, unknown> | undefined;
      for (const [label, selected, reason] of cases) {
        const workflowVersionId = await createWorkflow({
          workflowAgentVersionId: selected,
          slug: `rejected-${label}`,
        });
        const problem = await expectRunRejectedAtomically(
          workflowVersionId,
          label,
        );
        assertEquals(problem.code, "STATE_CONFLICT");
        if (reason === "agent_version_unavailable") {
          const publicProblem = {
            type: problem.type,
            title: problem.title,
            status: problem.status,
            detail: problem.detail,
            code: problem.code,
            retryable: problem.retryable,
          };
          unavailableProblem ??= publicProblem;
          assertEquals(publicProblem, unavailableProblem);
        }
      }
    });

    const workflowRepository = createBakeryPostgresWorkflowRepository({
      database,
      maxAttempts: 3,
    });

    await test.step("run admission rejects unavailable actions, invalid requirements and insufficient agent policy atomically", async () => {
      const restricted = await createAgent("pin-restricted", {
        harness: "pi",
        allowedCapabilities: ["git"],
        skillBindings: {},
      });
      const cases = [
        { action: "unknown.action" },
        { action: "rpi.research" },
        { action: "workflow.noop" },
        { requires: ["unknown"] },
        { requires: ["git", "git"] },
        { action: "rpi.design" },
        { action: "rpi.design", workflowAgentVersionId: emptyAgent.id },
        { workflowAgentVersionId: restricted.id },
      ];
      for (const [index, options] of cases.entries()) {
        const version = await createWorkflow({
          ...options,
          slug: `admission-denial-${index}`,
        });
        const problem = await expectRunRejectedAtomically(
          version,
          `policy-${index}`,
        );
        assertEquals(problem.code, "STATE_CONFLICT");
      }
    });

    const admissionState = async (run: RunFixture) =>
      (await database.query(
        `select run.status, run.version, task.status as task_status, task.version as task_version,
              (select jsonb_agg(jsonb_build_object('id', step.id, 'status', step.status, 'version', step.version) order by step.id)
                 from bakery.run_steps step where step.organization_id = $1 and step.run_id = run.id) as steps,
              (select count(*) from bakery.jobs where organization_id = $1) as jobs,
              (select count(*) from bakery.job_attempts where organization_id = $1) as attempts,
              (select count(*) from bakery.domain_events where organization_id = $1) as events
         from bakery.workflow_runs run join bakery.tasks task
           on task.organization_id = run.organization_id and task.id = run.task_id
        where run.organization_id = $1 and run.id = $2`,
        [organizationId, run.runId],
      )).rows;
    const expectEnqueueRejected = async (run: RunFixture) => {
      const before = await admissionState(run);
      await assertRejects(
        () =>
          workflowRepository.admit({
            runId: run.runId,
            stepKey: "quality",
            iteration: 0,
            actionVersion: run.workflowVersionId,
          }),
        StandardError,
        "STATE_CONFLICT",
      );
      assertEquals(await admissionState(run), before);
    };

    await test.step("frozen action version and metadata substitution are rejected before enqueue", async () => {
      const version = await createWorkflow({ slug: "action-pin" });
      for (const change of ["version", "input", "capabilities"]) {
        const run = await startRun(version, `action-pin-${change}`);
        const frozen = await database.query<
          { binding: Record<string, unknown> }
        >(
          `select snapshot #> '{stepActions,quality}' as binding
             from bakery.workflow_runs where organization_id = $1 and id = $2`,
          [organizationId, run.runId],
        );
        assertEquals(frozen.rows.length, 1);
        const binding = frozen.rows[0]!.binding;
        assertEquals(binding.action, "quality.check");
        assertEquals(binding.registryVersion, 1);
        assertEquals(binding.capabilities, ["git", "shell", "browser"]);
        const modified = change === "version"
          ? { ...binding, registryVersion: 2 }
          : change === "capabilities"
          ? { ...binding, capabilities: [] }
          : {
            ...binding,
            metadata: {
              ...(binding.metadata as Record<string, unknown>),
              input: "DesignInput",
            },
          };
        await database.query(
          `update bakery.workflow_runs set snapshot = jsonb_set(snapshot, '{stepActions,quality}', $3::jsonb) where organization_id = $1 and id = $2`,
          [organizationId, run.runId, JSON.stringify(modified)],
        );
        await expectEnqueueRejected(run);
      }
    });

    await test.step("typed model billing without real funding never creates a job or changes lifecycle", async () => {
      const unfunded = await createAgent("pin-unfunded-model", {
        harness: "pi",
        billing: explicitAgent.config.billing,
        skillBindings: {},
      });
      const version = await createWorkflow({
        action: "rpi.design",
        workflowAgentVersionId: unfunded.id,
        input: { researchArtifact: crypto.randomUUID() },
        slug: "unfunded-model",
      });
      // The run budget covers the reservation, so creation succeeds; the
      // missing installation budget policy then refuses admission for good.
      const run = await startRun(
        version,
        "unfunded-model",
        undefined,
        "1",
      );
      const [before] = await admissionState(run);
      for (const pass of [1, 2]) {
        const admission = await workflowRepository.admit({
          runId: run.runId,
          stepKey: "quality",
          iteration: 0,
          actionVersion: run.workflowVersionId,
        }).then((result) => result.terminal, (error: unknown) => {
          // A repeat finds the run already failed.
          if (pass === 2 && error instanceof StandardError) return true;
          throw error;
        });
        assertEquals(admission, true);
      }
      const [state] = await admissionState(run);
      assertEquals(state.status, "failed");
      assertEquals(state.task_status, "failed");
      assertEquals(state.jobs, before.jobs);
      const failedStep = await database.query<{ code: string }>(
        `select error->>'code' as code from bakery.run_steps
          where organization_id = $1 and run_id = $2`,
        [organizationId, run.runId],
      );
      assertEquals(failedStep.rows[0]?.code, "BUDGET_POLICY_UNAVAILABLE");
    });

    await test.step("resolved wrong-action input is rejected before insertion and on existing-job readmission", async () => {
      for (const existing of [false, true]) {
        const version = await createWorkflow({
          input: { researchArtifact: crypto.randomUUID() },
          slug: `wrong-input-${existing}`,
        });
        const run = await startRun(version, `wrong-input-${existing}`);
        let legacyJobId: string | null = null;
        if (existing) {
          // Legacy malformed row: preserve it through both readmission checks.
          const inserted = await database.query<{ id: string }>(
            `insert into bakery.jobs (
               organization_id, run_step_id, action, input, requirements, status,
               application_id, repository_id, repository_profile_id, repository_profile_revision,
               repository_profile_digest, agent_version_id, agent_config, skill_refs
             ) select run.organization_id, step.id, 'quality.check',
                      (run.snapshot #> '{workflow,normalizedSpec,steps,0,with}') || jsonb_build_object('repositoryProfile', run.snapshot->'repositoryProfile'),
                      '{"capabilities":["git","shell","browser"]}'::jsonb, 'queued',
                      run.application_id, run.repository_id, run.repository_profile_id,
                      run.repository_profile_revision, run.repository_profile_digest,
                      (run.snapshot #>> '{stepAgents,quality,agentVersionId}')::uuid,
                      run.snapshot #> '{stepAgents,quality,config}', run.snapshot #> '{stepAgents,quality,skillRefs}'
                 from bakery.workflow_runs run join bakery.run_steps step on step.run_id = run.id and step.organization_id = run.organization_id
                where run.organization_id = $1 and run.id = $2
             returning id`,
            [organizationId, run.runId],
          );
          assertEquals(inserted.rows.length, 1);
          legacyJobId = inserted.rows[0]!.id;
        }
        await expectEnqueueRejected(run);
        await expectEnqueueRejected(run);
        if (legacyJobId !== null) {
          legacyWrongInputJob = { runId: run.runId, id: legacyJobId };
        }
      }
    });

    await test.step("command replay and catalog mutations cannot change frozen pins", async () => {
      const replacementAgentConfig = {
        harness: "pi",
        skillBindings: { primary: workflowSkill.id },
      };
      const replacementAgentResponse = await post(
        `/v1/agents/${explicitAgent.agentId}/versions`,
        {
          revision: 2,
          config: replacementAgentConfig,
          digest: await agentVersionDigest(replacementAgentConfig),
        },
      );
      assertEquals(
        replacementAgentResponse.status,
        201,
        await replacementAgentResponse.clone().text(),
      );
      const replacementAgentVersion = await replacementAgentResponse.json() as {
        id: string;
      };
      const replacementSkillUpload = await makeUpload([
        { path: "SKILL.md", content: text("explicit skill replacement") },
      ], { revision: 2 });
      const replacementSkillResponse = await context.publish(
        explicitSkill.skillId,
        replacementSkillUpload,
      );
      assertEquals(
        replacementSkillResponse.status,
        201,
        await replacementSkillResponse.clone().text(),
      );
      await database.query(
        `update bakery.agent_definitions
            set active_version_id = $3, enabled = false
          where organization_id = $1 and id = $2`,
        [organizationId, explicitAgent.agentId, replacementAgentVersion.id],
      );
      await database.query(
        `update bakery.skills set enabled = false
          where organization_id = $1 and id = $2`,
        [organizationId, explicitSkill.skillId],
      );
      await database.query(
        `update bakery.repositories set active_profile_id = $3
          where organization_id = $1 and id = $2`,
        [organizationId, repositoryId, replacementProfileId],
      );
      const replay = await post(
        `/v1/tasks/${explicitRun.taskId}/runs`,
        explicitRun.requestBody,
        explicitRun.idempotencyKey,
      );
      assertEquals(replay.status, 201, await replay.clone().text());
      assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
      assertEquals(await replay.json(), explicitRun.responseBody);
    });

    await test.step("tampered frozen snapshot step selector is rejected before job insertion", async () => {
      await database.query(
        `update bakery.workflow_runs
            set snapshot = jsonb_set(
              snapshot,
              '{workflow,normalizedSpec,steps,0,agentVersionId}',
              'null'::jsonb,
              true
            )
          where organization_id = $1 and id = $2`,
        [organizationId, tamperRun.runId],
      );
      await assertRejects(
        () =>
          workflowRepository.admit({
            runId: tamperRun.runId,
            stepKey: "quality",
            iteration: 0,
            actionVersion: tamperRun.workflowVersionId,
          }),
        Error,
        "WORKFLOW_AGENT_SELECTOR_INVALID",
      );
      const jobs = await database.query<{ count: number }>(
        `select count(*)::integer as count
           from bakery.jobs job
           join bakery.run_steps step on step.id = job.run_step_id
          where step.organization_id = $1 and step.run_id = $2`,
        [organizationId, tamperRun.runId],
      );
      assertEquals(jobs.rows[0]?.count, 0);
    });
    const runs = [
      explicitRun,
      workflowRun,
      profileRun,
      noAgentRun,
      emptyBindingsRun,
    ];
    const jobs = new Map<string, JobProjection>();
    await test.step("job insertion writes only frozen context and retries byte-equivalently", async () => {
      for (const run of runs) {
        const key = {
          runId: run.runId,
          stepKey: "quality",
          iteration: 0,
          actionVersion: run.workflowVersionId,
        };
        const admission = await workflowRepository.admit(key);
        assert(admission.jobId);
        const selected = await database.query<JobProjection>(
          `select id, agent_version_id, agent_config, skill_refs
             from bakery.jobs where organization_id = $1 and id = $2`,
          [organizationId, admission.jobId],
        );
        const projected = selected.rows[0];
        assert(projected);
        jobs.set(run.runId, projected);
        const retry = await workflowRepository.admit(key);
        assertEquals(retry.jobId, projected.id);
        const afterRetry = await database.query<JobProjection>(
          `select id, agent_version_id, agent_config, skill_refs
             from bakery.jobs where organization_id = $1 and id = $2`,
          [organizationId, projected.id],
        );
        assertEquals(afterRetry.rows[0], projected);
      }
      assertEquals(jobs.get(explicitRun.runId), {
        id: jobs.get(explicitRun.runId)!.id,
        agent_version_id: explicitAgent.id,
        agent_config: explicitAgent.config,
        skill_refs: [{
          versionId: explicitSkill.id,
          digest: explicitSkill.digest,
        }],
      });
      assertEquals(
        jobs.get(workflowRun.runId)?.agent_version_id,
        workflowAgent.id,
      );
      assertEquals(
        jobs.get(profileRun.runId)?.agent_version_id,
        profileAgent.id,
      );
      assertEquals(jobs.get(noAgentRun.runId), {
        id: jobs.get(noAgentRun.runId)!.id,
        agent_version_id: null,
        agent_config: {},
        skill_refs: [],
      });
      assertEquals(jobs.get(emptyBindingsRun.runId), {
        id: jobs.get(emptyBindingsRun.runId)!.id,
        agent_version_id: emptyAgent.id,
        agent_config: emptyAgent.config,
        skill_refs: [],
      });
      const positiveRequirements = await database.query<
        {
          requirements: { capabilities: string[] };
          billing: unknown;
          installation_reservation_id: unknown;
        }
      >(
        `select requirements, billing, installation_reservation_id from bakery.jobs where organization_id = $1 and id = any($2::uuid[])`,
        [organizationId, [
          jobs.get(noAgentRun.runId)!.id,
          jobs.get(emptyBindingsRun.runId)!.id,
        ]],
      );
      assertEquals(positiveRequirements.rows.length, 2);
      for (const row of positiveRequirements.rows) {
        assertEquals(row.requirements.capabilities, [
          "git",
          "shell",
          "browser",
          "web",
        ]);
        assertEquals(row.billing, null);
        assertEquals(row.installation_reservation_id, null);
      }
    });

    await test.step("negative job tampering fails retry, claim, and rebind without overwrite", async () => {
      const explicitJob = jobs.get(explicitRun.runId)!;
      const workflowJob = jobs.get(workflowRun.runId)!;
      const profileJob = jobs.get(profileRun.runId)!;
      const wrongAgentVersionId = crypto.randomUUID();
      // Negative tamper fixtures modify producer columns only after positive
      // authenticated run admission and production job insertion have passed.
      await database.query(
        `update bakery.jobs set agent_version_id = $3
          where organization_id = $1 and id = $2`,
        [organizationId, explicitJob.id, wrongAgentVersionId],
      );
      await database.query(
        `update bakery.jobs set agent_config = '{}'::jsonb
          where organization_id = $1 and id = $2`,
        [organizationId, workflowJob.id],
      );
      await database.query(
        `update bakery.jobs set skill_refs = '[]'::jsonb
          where organization_id = $1 and id = $2`,
        [organizationId, profileJob.id],
      );
      for (const run of [explicitRun, workflowRun, profileRun]) {
        await assertRejects(
          () =>
            workflowRepository.admit({
              runId: run.runId,
              stepKey: "quality",
              iteration: 0,
              actionVersion: run.workflowVersionId,
            }),
          StandardError,
          "STATE_CONFLICT",
        );
      }
      const tampered = await database.query<JobProjection>(
        `select id, agent_version_id, agent_config, skill_refs
           from bakery.jobs where id = any($1::uuid[]) order by id`,
        [[explicitJob.id, workflowJob.id, profileJob.id]],
      );
      assertEquals(
        tampered.rows.find((row) => row.id === explicitJob.id)
          ?.agent_version_id,
        wrongAgentVersionId,
      );
      assertEquals(
        tampered.rows.find((row) => row.id === workflowJob.id)?.agent_config,
        {},
      );
      assertEquals(
        tampered.rows.find((row) => row.id === profileJob.id)?.skill_refs,
        [],
      );

      const workerSessionId = crypto.randomUUID();
      const workerIdentity: WorkerIdentity = {
        tokenHash: digest64("1"),
        host: {
          id: crypto.randomUUID(),
          organizationId,
          principalId,
          principalType: "human",
          name: "Pin producer consistency host",
          os: "linux",
          architecture: "x64",
          capabilities: workerFixtureCapabilities,
          slots: 1,
          status: "online",
          desiredMode: "accepting",
          credentialHash: digest64("2"),
          credentialGeneration: 1,
          protocolVersion: 1,
          inventoryRevision: 1,
          readinessRevision: 1,
          workerSessionId,
          workerSessionGeneration: 1,
          lastHeartbeatAt: new Date(),
        },
      };
      await database.query(
        `insert into bakery.worker_hosts (
           id, organization_id, principal_id, principal_type, name, os,
           architecture, capabilities, slots, status, desired_mode,
           credential_hash, worker_session_id, worker_session_generation
         ) values ($1, $2, $3, 'human', $4, 'linux', 'x64', $5::jsonb, 1,
                   'online', 'accepting', $6, $7, 1)`,
        [
          workerIdentity.host.id,
          organizationId,
          principalId,
          workerIdentity.host.name,
          JSON.stringify(workerFixtureCapabilities),
          workerIdentity.host.credentialHash,
          workerSessionId,
        ],
      );
      const attemptId = crypto.randomUUID();
      await database.query(
        `update bakery.jobs set current_fence = 1 where id = $1`,
        [explicitJob.id],
      );
      await database.query(
        `insert into bakery.job_attempts (
           id, organization_id, job_id, worker_host_id, worker_session_id,
           worker_session_generation, attempt_no, fence, lease_token_hash,
           lease_expires_at, status
         ) values ($1, $2, $3, $4, $5, 1, 1, 1, $6,
                   clock_timestamp() + interval '5 minutes', 'leased')`,
        [
          attemptId,
          organizationId,
          explicitJob.id,
          workerIdentity.host.id,
          workerSessionId,
          digest64("3"),
        ],
      );
      await withPgTransaction(database, async (transaction) => {
        const claims = createClaimsRepository(transaction, workerIdentity);
        assertEquals(
          await claims.findClaimableJob({
            organizationId,
            // Exclude the positive controls requiring web; only the tampered jobs match.
            requestedCapabilities: ["git", "shell", "browser"],
            supportedActions: ["quality.check"],
            metadata: {
              requestId: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
            },
            principalId,
          }),
          null,
        );
        await assertRejects(
          () => claims.rebindLiveAttempt(attemptId),
          StandardError,
          "STATE_CONFLICT",
        );
      });
      assert(legacyWrongInputJob !== null);
      const disposed = await database.query<{
        id: string;
        status: string;
        error_code: string;
        attempt_count: string;
      }>(
        `select job.id, job.status, step.error->>'code' as error_code,
                (select count(*)::text from bakery.job_attempts attempt
                  where attempt.organization_id = job.organization_id
                    and attempt.job_id = job.id) as attempt_count
           from bakery.jobs job
           join bakery.run_steps step
             on step.organization_id = job.organization_id and step.id = job.run_step_id
          where job.organization_id = $1 and step.run_id = $2 and job.id = $3`,
        [organizationId, legacyWrongInputJob.runId, legacyWrongInputJob.id],
      );
      assertEquals(disposed.rows, [{
        id: legacyWrongInputJob.id,
        status: "failed",
        error_code: "INVALID_ASSIGNMENT_PAYLOAD",
        attempt_count: "0",
      }]);
    });
  } finally {
    if (foreignOrganizationId) {
      await database.query(
        "delete from bakery.organizations where id = $1",
        [foreignOrganizationId],
      ).catch(() => undefined);
    }
    await context.close(true);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
