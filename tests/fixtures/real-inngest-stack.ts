/**
 * Disposable local Inngest engine and Bakery server fixture for recovery tests.
 *
 * The compose project owns persistent Postgres/Redis volumes. Engine and server
 * restarts are separate process restarts; no Hono/router reconstruction is used.
 */
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import type { AgentVersionCreateConfig } from "../../packages/contracts/src/contracts.ts";
import { RepositoryExecutionContextSchema } from "../../packages/contracts/src/repository-inspection.ts";
import { formatRestartLineageDiagnostic } from "../helpers/restart-lineage.ts";
import {
  reserveProcessLoopbackPort,
  retryOnPortCollision,
} from "./loopback-port-allocation.ts";
import { workerFixtureCapabilities } from "../helpers/worker-execution.ts";
import {
  fundedModelPolicy,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";
import { registerLaneStack } from "../helpers/lane-stack-registry.ts";

export type SeededStep = {
  runStepId: string;
  sessionId: string;
};
export type SeededWorkflow = {
  organizationId: string;
  taskId: string;
  runId: string;
  requestDeliveryKey: string;
  steps: readonly [SeededStep, SeededStep];
  worker: {
    credential: string;
    workerHostId: string;
    workerSessionId: string;
    workerSessionGeneration: string;
  };
};
export type WorkflowState = {
  runStatus: string;
  taskStatus: string;
  runFinishedAt: string | null;
  engineOwnerToken: string | null;
  engineOwnerGeneration: string;
  engineOwnerLeaseExpiresAt: string | null;
  steps: Array<
    { status: string; jobStatus: string | null; attemptCount: number }
  >;
};
export type EngineInvocation = {
  functionRunId: string;
  eventId: string;
  eventName: string;
};
export type RealInngestStack = {
  readonly project: string;
  readonly eventKey: string;
  readonly inngestUrl: string;
  readonly serverUrl: string;
  readonly seedWorkflow: (runId: string) => Promise<SeededWorkflow>;
  readonly completeNextStep: (seed: SeededWorkflow) => Promise<void>;
  readonly setStepAvailableAt: (
    seed: SeededWorkflow,
    index: 0 | 1,
    delayMs: number,
  ) => Promise<void>;
  readonly readWorkflowState: (seed: SeededWorkflow) => Promise<WorkflowState>;
  readonly readEngineRegistration: () => Promise<{
    readonly function_count?: number;
    readonly [key: string]: unknown;
  }>;
  readonly start: () => Promise<void>;
  readonly stopEngine: () => Promise<void>;
  readonly restartEngine: () => Promise<void>;
  readonly stopServer: () => Promise<void>;
  readonly restartServer: () => Promise<void>;
  readonly stopDispatch: () => Promise<void>;
  readonly restartDispatch: () => Promise<void>;
  readonly stopPostgres: () => Promise<void>;
  readonly restartPostgres: () => Promise<void>;
  readonly engineInvocations: (
    runId: string,
  ) => Promise<readonly EngineInvocation[]>;
  readonly recoveryInvocationCount: () => Promise<number>;
  readonly requestEventCount: (seed: SeededWorkflow) => Promise<number>;
  readonly pendingOutboxCount: (seed: SeededWorkflow) => Promise<number>;
  readonly restartLineageDiagnostic: (
    seed: SeededWorkflow,
  ) => Promise<string>;
  readonly cleanup: () => Promise<void>;
};

type CommandResult = { success: boolean; output: string };

async function docker(
  args: string[],
  env: Record<string, string>,
): Promise<CommandResult> {
  const result = await new Deno.Command("docker", {
    args,
    cwd: Deno.cwd(),
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    output: `${new TextDecoder().decode(result.stdout)}${
      new TextDecoder().decode(result.stderr)
    }`,
  };
}

function composeArgs(project: string): string[] {
  return ["compose", "--project-name", project, "-f", "infra/compose.yaml"];
}
function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function inngestSignature(
  signingKey: string,
  timestamp: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(timestamp),
  );
  return [...new Uint8Array(signature)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function workerCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type RealInngestStackOptions = Readonly<{
  jobCompletionTimeout?: string;
}>;

export function createRealInngestStack(
  options: RealInngestStackOptions = {},
): RealInngestStack {
  const project = `bakery-issue40-inngest-${crypto.randomUUID()}`;
  registerLaneStack(project);
  const dispatchContainer = `${project}-dispatch`;
  const eventKey = `bakery-issue40-event-${crypto.randomUUID()}`;
  const signingKey =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    BAKERY_ENV: "development",
    BAKERY_INNGEST_EVENT_KEY: eventKey,
    BAKERY_INNGEST_SIGNING_KEY: signingKey,
    BAKERY_LOCAL_INNGEST_PASSWORD: `issue40-inngest-${crypto.randomUUID()}`,
    BAKERY_LOCAL_POSTGRES_PASSWORD: `issue40-postgres-${crypto.randomUUID()}`,
    BAKERY_LOCAL_REDIS_PASSWORD: `issue40-redis-${crypto.randomUUID()}`,
    BAKERY_LOCAL_BAKERY_PASSWORD: `issue40-bakery-${crypto.randomUUID()}`,
    BAKERY_LOCAL_APP_PASSWORD: `issue40-app-${crypto.randomUUID()}`,
    BETTER_AUTH_SECRET: `issue40-auth-${crypto.randomUUID()}-secret`,
    INNGEST_JOB_COMPLETION_TIMEOUT: options.jobCompletionTimeout ?? "3s",
  };
  const compose = composeArgs(project);
  let budgetOverridePath: string | undefined;
  const run = async (args: string[], allowFailure = false): Promise<string> => {
    const result = await docker([...compose, ...args], env);
    if (!allowFailure && !result.success) {
      const logs = await docker(
        [...compose, "logs", "--no-color", "migrate"],
        env,
      );
      throw new Error(
        `docker ${
          args.join(" ")
        } failed:\n${result.output}\nMigration logs:\n${logs.output}`,
      );
    }
    return result.output;
  };
  // Host ports are drawn by each `start` attempt: Docker can lose a bind race.
  let inngestUrl = "";
  let serverUrl = "";
  const waitReady = async (): Promise<void> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`${inngestUrl}/health`);
        if (response.ok) return;
      } catch {
        // The engine may still be starting.
      }
      await delay(250);
    }
    throw new Error(`Inngest did not become ready at ${inngestUrl}`);
  };
  const waitPostgresReady = async (): Promise<void> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = await docker(
        ["inspect", "-f", "{{.State.Health.Status}}", `${project}-postgres-1`],
        env,
      );
      if (status.output.trim() === "healthy") return;
      await delay(250);
    }
    throw new Error("PostgreSQL did not become ready");
  };
  const waitServerReady = async (): Promise<void> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`${serverUrl}/health/live`);
        if (response.ok) return;
      } catch {
        // The server may still be starting.
      }
      await delay(250);
    }
    throw new Error(`Bakery server did not become ready at ${serverUrl}`);
  };
  const waitDispatchReady = async (): Promise<void> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = await docker(
        ["inspect", "-f", "{{.State.Status}}", dispatchContainer],
        env,
      );
      const state = status.output.trim();
      if (state === "running") return;
      if (state === "exited" || state === "dead") {
        const logs = await docker(["logs", dispatchContainer], env);
        throw new Error(`dispatch exited during startup:\n${logs.output}`);
      }
      await delay(250);
    }
    throw new Error("dispatch did not become ready");
  };
  const heartbeatWorker = async (
    worker: SeededWorkflow["worker"],
  ): Promise<void> => {
    const heartbeat = await fetch(`${serverUrl}/v1/worker/heartbeat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${worker.credential}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-bakery-worker-protocol-version": "2",
        "x-request-id": crypto.randomUUID(),
        "x-trace-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        workerHostId: worker.workerHostId,
        observedAt: new Date().toISOString(),
        load: 0,
        activeAttemptIds: [],
        workerSessionId: worker.workerSessionId,
        workerSessionGeneration: worker.workerSessionGeneration,
      }),
    });
    const heartbeatBody = await heartbeat.json().catch(() => ({}));
    if (!heartbeat.ok) {
      throw new Error(
        `worker heartbeat failed: ${heartbeat.status} ${
          JSON.stringify(heartbeatBody)
        }`,
      );
    }
    const workerSessionId = String(heartbeatBody.workerSessionId ?? "");
    const workerSessionGeneration = String(
      heartbeatBody.workerSessionGeneration ?? "",
    );
    if (!workerSessionId || !workerSessionGeneration) {
      throw new Error("WORKER_HEARTBEAT_SESSION_MISSING");
    }
    worker.workerSessionId = workerSessionId;
    worker.workerSessionGeneration = workerSessionGeneration;
  };
  const seedWorkflow = async (runId: string): Promise<SeededWorkflow> => {
    const organizationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const applicationId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const workflowVersionId = crypto.randomUUID();
    const repositoryId = crypto.randomUUID();
    const repositoryProfileId = crypto.randomUUID();
    const profileConfig = {
      schemaVersion: 1,
      workflow: { kind: "fixed" },
      branches: { base: "main", allowedPatterns: ["feature/*"] },
      worktree: { root: ".bakery/worktrees" },
    };
    const profileDigest = await sha256Hex(canonicalJson(profileConfig));
    const repositoryProfile = RepositoryExecutionContextSchema.parse({
      organizationId,
      applicationId,
      repositoryId,
      id: repositoryProfileId,
      revision: 1,
      digest: profileDigest,
      config: profileConfig,
      observationId: null,
      observationDigest: null,
      baseSha: null,
    });
    const steps = [
      { runStepId: crypto.randomUUID(), sessionId: crypto.randomUUID() },
      { runStepId: crypto.randomUUID(), sessionId: crypto.randomUUID() },
    ] as const;
    const enrollmentToken = `issue40-enrollment-${crypto.randomUUID()}`;
    const credential = workerCredential();
    const action = "harness.implement";
    // Keep this caller-supplied, two-step seed unadmitted. Inngest owns admission.
    const agentId = crypto.randomUUID();
    const agentVersionId = crypto.randomUUID();
    const agentConfig = {
      harness: "pi",
      billing: {
        provider: "openai",
        billingAccountId: "budget-test-account",
        model: "gpt-5.6-luna",
        billingRoute: "api",
        maxTokens: 1_000,
        maxUsdReservation: 0.1,
        pricingMetadataSnapshot: "budget-test-price-v1",
      },
    } satisfies AgentVersionCreateConfig;
    const agentDigest = await sha256Hex(canonicalJson(agentConfig));
    const agent = {
      agentVersionId,
      revision: 1,
      digest: agentDigest,
      config: agentConfig,
      skillRefs: [],
    };
    const jobInputObject = {
      repositoryId,
      planArtifact: crypto.randomUUID(),
    };
    const workflowSteps = [
      { id: "step_1", uses: action, with: jobInputObject },
      { id: "step_2", uses: action, with: jobInputObject },
    ];
    const spec = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: `issue40-recovery-${workflowId.slice(0, 8)}`,
      workflow: { kind: "fixed" },
      agents: { [action]: agentVersionId },
      steps: workflowSteps,
    };
    const workflowSpec = JSON.stringify(spec);
    const workflowDigest = await sha256Hex(canonicalJson(spec));
    const snapshot = JSON.stringify({
      schemaVersion: 1,
      executionMode: "repository",
      inputs: {},
      workflow: {
        id: workflowVersionId,
        revision: 1,
        digest: workflowDigest,
        normalizedSpec: spec,
      },
      repositoryProfile,
      stepAgents: { step_1: agent, step_2: agent },
      admission: { dependencies: [], status: "queued", reason: null },
    });
    const traceId = crypto.randomUUID();
    const sql = `
      insert into bakery.principals (id, display_name, principal_type)
      values (:'principal_id'::uuid, 'Issue 40 recovery service', 'service');
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        :'organization_id'::uuid, 'Issue 40 recovery',
        :'organization_id', '{}'::jsonb, now(), now(), 1
      );
      insert into bakery.applications (id, organization_id, slug, name)
      values (
        :'application_id'::uuid, :'organization_id'::uuid, :'application_id',
        'Issue 40 recovery'
      );
      insert into bakery.repositories (
        id, organization_id, application_id, integration_connection_id,
        provider_repo_id, owner, name, default_branch
      ) values (
        :'repository_id'::uuid, :'organization_id'::uuid,
        :'application_id'::uuid, gen_random_uuid(), :'repository_id',
        'bakery-recovery', :'repository_id', 'main'
      );
      insert into bakery.repository_profiles (
        id, organization_id, application_id, repository_id, revision,
        config, digest, created_by
      ) values (
        :'repository_profile_id'::uuid, :'organization_id'::uuid,
        :'application_id'::uuid, :'repository_id'::uuid, 1,
        :'profile_config'::jsonb, :'profile_digest', :'principal_id'::uuid
      );
      update bakery.repositories
         set active_profile_id = :'repository_profile_id'::uuid
       where organization_id = :'organization_id'::uuid
         and id = :'repository_id'::uuid;
      insert into bakery.conversations (
        id, organization_id, application_id, title, created_by, repository_id
      ) values (
        :'conversation_id'::uuid, :'organization_id'::uuid,
        :'application_id'::uuid, 'Issue 40 recovery', :'principal_id'::uuid,
        :'repository_id'::uuid
      );
      insert into bakery.tasks (
        id, organization_id, application_id, conversation_id, parent_task_id,
        title, description, task_type, status, created_by, repository_id,
        repository_profile_id, repository_profile_revision, repository_profile_digest,
        observation_id, observation_digest, base_sha
      ) values (
        :'task_id'::uuid, :'organization_id'::uuid, :'application_id'::uuid,
        :'conversation_id'::uuid, null, 'Issue 40 recovery', '', 'feature',
        'queued', :'principal_id'::uuid, :'repository_id'::uuid,
        :'repository_profile_id'::uuid, 1, :'profile_digest', null, null, null
      );
      insert into bakery.agent_definitions (
        id, organization_id, slug, name, description, enabled
      ) values (
        :'agent_id'::uuid, :'organization_id'::uuid, :'agent_id',
        'Issue 40 recovery agent', '', true
      );
      insert into bakery.agent_versions (
        id, organization_id, agent_id, revision, config, digest, created_by
      ) values (
        :'agent_version_id'::uuid, :'organization_id'::uuid, :'agent_id'::uuid,
        1, :'agent_config'::jsonb, :'agent_digest', :'principal_id'::uuid
      );
      insert into bakery.workflow_definitions (
        id, organization_id, slug, name, description
      ) values (
        :'workflow_id'::uuid, :'organization_id'::uuid, :'workflow_id',
        'Issue 40 recovery', ''
      );
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by
      ) values (
        :'workflow_version_id'::uuid, :'organization_id'::uuid,
        :'workflow_id'::uuid, 1, :'workflow_spec', :'workflow_spec'::jsonb,
        :'workflow_digest', 'published', :'principal_id'::uuid
      );
      update bakery.workflow_definitions
         set active_version_id = :'workflow_version_id'::uuid
       where organization_id = :'organization_id'::uuid
         and id = :'workflow_id'::uuid;
      insert into bakery.workflow_runs (
        id, organization_id, task_id, workflow_version_id, requested_by,
        status, snapshot, budget_limit_usd, application_id, repository_id, repository_profile_id,
        repository_profile_revision, repository_profile_digest,
        observation_id, observation_digest, base_sha
      ) values (
        :'run_id'::uuid, :'organization_id'::uuid, :'task_id'::uuid,
        :'workflow_version_id'::uuid, :'principal_id'::uuid, 'running',
        :'snapshot'::jsonb, '1.000000', :'application_id'::uuid, :'repository_id'::uuid,
        :'repository_profile_id'::uuid, 1, :'profile_digest', null, null, null
      );
      update bakery.tasks
         set current_run_id = :'run_id'::uuid, status = 'active'
       where organization_id = :'organization_id'::uuid
         and id = :'task_id'::uuid;
      insert into bakery.run_steps (
        id, organization_id, run_id, step_key, position, iteration, status, input
      ) values
        (
          :'run_step_1_id'::uuid, :'organization_id'::uuid, :'run_id'::uuid,
          'step_1', 1, 0, 'pending', :'step_input'::jsonb
        ),
        (
          :'run_step_2_id'::uuid, :'organization_id'::uuid, :'run_id'::uuid,
          'step_2', 2, 0, 'pending', :'step_input'::jsonb
        );
      insert into bakery.agent_sessions (
        id, organization_id, run_step_id, conversation_id, agent_version_id,
        harness, status
      ) values
        (
          :'run_step_1_session_id'::uuid, :'organization_id'::uuid,
          :'run_step_1_id'::uuid, :'conversation_id'::uuid,
          :'agent_version_id'::uuid, 'codex', 'active'
        ),
        (
          :'run_step_2_session_id'::uuid, :'organization_id'::uuid,
          :'run_step_2_id'::uuid, :'conversation_id'::uuid,
          :'agent_version_id'::uuid, 'codex', 'active'
        );
      insert into bakery.event_clock (organization_id, stream, next_seq)
      values (:'organization_id'::uuid, 'domain_events', 2);
      insert into bakery.domain_events (
        organization_id, organization_sequence, event_type, schema_version,
        application_id, task_id, conversation_id, aggregate_id,
        aggregate_version, payload, trace_id
      ) values (
        :'organization_id'::uuid, 1, 'run.requested', 1,
        :'application_id'::uuid, :'task_id'::uuid, :'conversation_id'::uuid,
        :'run_id'::uuid, 1, jsonb_build_object('runId', :'run_id'::uuid),
        :'trace_id'
      );
      insert into bakery.outbox (
        organization_id, event_id, destination, delivery_key
      )
      select organization_id, id, 'inngest', 'issue40-recovery-' || :'run_id'
        from bakery.domain_events
       where organization_id = :'organization_id'::uuid
         and aggregate_id = :'run_id'::uuid
         and event_type = 'run.requested';
      insert into bakery.worker_enrollments (
        organization_id, principal_id, name, os, architecture,
        allowed_capabilities, slots, token_hash, expires_at
      ) values (
        :'organization_id'::uuid, :'principal_id'::uuid,
        'Issue 40 recovery worker', 'linux', 'x64', :'capabilities'::jsonb, 1,
        :'enrollment_hash', now() + interval '1 hour'
      );
    `;
    const pricingDatabase = openPgDatabase(
      `postgres://bakery:${env.BAKERY_LOCAL_BAKERY_PASSWORD}@127.0.0.1:${env.BAKERY_POSTGRES_PORT}/bakery`,
    );
    try {
      await seedProviderPricingSnapshot(pricingDatabase, {
        billing: agentConfig.billing,
      });
    } finally {
      await closePgDatabase(pricingDatabase);
    }
    await run([
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      [
        "printf '%s' \"$1\" | psql -U postgres -d bakery -v ON_ERROR_STOP=1",
        '-v principal_id="$2"',
        '-v organization_id="$3"',
        '-v application_id="$4"',
        '-v conversation_id="$5"',
        '-v task_id="$6"',
        '-v workflow_id="$7"',
        '-v workflow_version_id="$8"',
        '-v run_id="$9"',
        '-v run_step_1_id="${10}"',
        '-v run_step_2_id="${11}"',
        '-v run_step_1_session_id="${12}"',
        '-v run_step_2_session_id="${13}"',
        '-v workflow_spec="${14}"',
        '-v snapshot="${15}"',
        '-v trace_id="${16}"',
        '-v enrollment_hash="${17}"',
        '-v repository_id="${18}"',
        '-v repository_profile_id="${19}"',
        '-v profile_config="${20}"',
        '-v profile_digest="${21}"',
        '-v workflow_digest="${22}"',
        '-v step_input="${23}"',
        '-v capabilities="${24}"',
        '-v agent_id="${25}"',
        '-v agent_version_id="${26}"',
        '-v agent_config="${27}"',
        '-v agent_digest="${28}"',
        "-f -",
      ].join(" "),
      "--",
      sql,
      principalId,
      organizationId,
      applicationId,
      conversationId,
      taskId,
      workflowId,
      workflowVersionId,
      runId,
      steps[0].runStepId,
      steps[1].runStepId,
      steps[0].sessionId,
      steps[1].sessionId,
      workflowSpec,
      snapshot,
      traceId,
      await sha256Hex(enrollmentToken),
      repositoryId,
      repositoryProfileId,
      JSON.stringify(repositoryProfile.config),
      profileDigest,
      workflowDigest,
      JSON.stringify(jobInputObject),
      JSON.stringify(workerFixtureCapabilities),
      agentId,
      agentVersionId,
      JSON.stringify(agentConfig),
      agentDigest,
    ]);
    const registration = await fetch(`${serverUrl}/v1/worker/registration`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        "x-bakery-worker-protocol-version": "2",
      },
      body: JSON.stringify({
        enrollmentToken,
        workerCredential: credential,
        name: "Issue 40 recovery worker",
        os: "linux",
        architecture: "x64",
        capabilities: workerFixtureCapabilities,
        toolchainVersions: { deno: "2.x" },
        slots: 1,
      }),
    });
    const registrationBody = await registration.json().catch(() => ({}));
    if (!registration.ok) {
      throw new Error(
        `worker registration failed: ${registration.status} ${
          JSON.stringify(registrationBody)
        }`,
      );
    }
    const workerHostId = String(registrationBody.workerHostId ?? "");
    if (!workerHostId) throw new Error("WORKER_REGISTRATION_HOST_MISSING");
    const worker: SeededWorkflow["worker"] = {
      credential,
      workerHostId,
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "0",
    };
    await heartbeatWorker(worker);
    const requestDeliveryKey = `issue40-recovery-${runId}`;
    return {
      organizationId,
      taskId,
      runId,
      requestDeliveryKey,
      steps,
      worker,
    };
  };
  const nextStepIndexByRun = new Map<string, number>();
  const completeNextStep = async (seed: SeededWorkflow): Promise<void> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      await heartbeatWorker(seed.worker);
      const claimKey = crypto.randomUUID();
      const claimResponse = await fetch(`${serverUrl}/v1/worker/claims`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${seed.worker.credential}`,
          "content-type": "application/json",
          "idempotency-key": claimKey,
          "x-bakery-worker-protocol-version": "2",
          "x-request-id": claimKey,
          "x-trace-id": claimKey,
        },
        body: JSON.stringify({
          claimKey,
          workerHostId: seed.worker.workerHostId,
          capabilities: workerFixtureCapabilities,
          supportedActions: ["harness.implement"],
          workerSessionId: seed.worker.workerSessionId,
          workerSessionGeneration: seed.worker.workerSessionGeneration,
        }),
      });
      if (claimResponse.status === 204) {
        await claimResponse.arrayBuffer();
        await delay(250);
        continue;
      }
      const assignmentBody = await claimResponse.json().catch(() => ({}));
      if (!claimResponse.ok) {
        throw new Error(
          `worker claim failed: ${claimResponse.status} ${
            JSON.stringify(assignmentBody)
          }`,
        );
      }
      const assignment = assignmentBody as {
        attemptId?: string;
        leaseToken?: string;
        fence?: string;
      };
      const nextStepIndex = nextStepIndexByRun.get(seed.runId) ?? 0;
      const step = seed.steps[nextStepIndex];
      if (!step) throw new Error("WORKER_STEP_INDEX_EXHAUSTED");
      nextStepIndexByRun.set(seed.runId, nextStepIndex + 1);
      if (
        !assignment.attemptId || !assignment.leaseToken || !assignment.fence
      ) {
        throw new Error("WORKER_ASSIGNMENT_INCOMPLETE");
      }
      const startedEventId = crypto.randomUUID();
      const eventResponse = await fetch(
        `${serverUrl}/v1/worker/attempts/${
          encodeURIComponent(assignment.attemptId)
        }/events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${seed.worker.credential}`,
            "content-type": "application/json",
            "idempotency-key": startedEventId,
            "x-bakery-worker-protocol-version": "2",
            "x-request-id": crypto.randomUUID(),
            "x-trace-id": crypto.randomUUID(),
          },
          body: JSON.stringify({
            leaseToken: assignment.leaseToken,
            fence: assignment.fence,
            workerSessionId: seed.worker.workerSessionId,
            workerSessionGeneration: seed.worker.workerSessionGeneration,
            events: [{
              eventId: startedEventId,
              localSeq: "1",
              eventType: "job.accepted",
              payload: { acceptedAt: new Date().toISOString() },
            }],
          }),
        },
      );
      const eventBody = await eventResponse.json().catch(() => ({}));
      if (!eventResponse.ok) {
        throw new Error(
          `worker event failed: ${eventResponse.status} ${
            JSON.stringify(eventBody)
          }`,
        );
      }
      const resultRequest = {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        workerSessionId: seed.worker.workerSessionId,
        workerSessionGeneration: seed.worker.workerSessionGeneration,
        localSeq: "2",
        status: "completed" as const,
        result: {
          headSha: "recovery-head",
          baseSha: "recovery-base",
          sessionId: step.sessionId,
          artifacts: [],
        },
      };
      const resultIdempotencyKey = crypto.randomUUID();
      for (let resultAttempt = 0; resultAttempt < 20; resultAttempt++) {
        const resultResponse = await fetch(
          `${serverUrl}/v1/worker/attempts/${
            encodeURIComponent(assignment.attemptId)
          }/result`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${seed.worker.credential}`,
              "content-type": "application/json",
              "idempotency-key": resultIdempotencyKey,
              "x-bakery-worker-protocol-version": "2",
              "x-request-id": crypto.randomUUID(),
              "x-trace-id": crypto.randomUUID(),
            },
            body: JSON.stringify(resultRequest),
          },
        );
        const resultBody = await resultResponse.json().catch(() => ({}));
        if (resultResponse.ok) return;
        if (
          resultResponse.status === 404 &&
          resultBody.code === "RESOURCE_NOT_FOUND"
        ) {
          await delay(250);
          continue;
        }
        throw new Error(
          `worker result failed: ${resultResponse.status} ${
            JSON.stringify(resultBody)
          }`,
        );
      }
      throw new Error("WORKER_RESULT_RESOURCE_TIMEOUT");
    }
    throw new Error("WORKER_ASSIGNMENT_TIMEOUT");
  };
  const setStepAvailableAt = async (
    seed: SeededWorkflow,
    index: 0 | 1,
    delayMs: number,
  ): Promise<void> => {
    if (
      !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000
    ) {
      throw new Error("WORKFLOW_RETRY_SCHEDULE_INVALID");
    }
    const sql = `
      update bakery.jobs
         set available_at = clock_timestamp() +
           (:'delay_ms'::int * interval '1 millisecond')
       where organization_id = :'organization_id'::uuid
         and run_step_id = :'run_step_id'::uuid
         and status = 'queued'
      returning id;
    `;
    const output = await run([
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      [
        "printf '%s' \"$1\" | psql -U postgres -d bakery -At",
        '-v organization_id="$2"',
        '-v run_step_id="$3"',
        '-v delay_ms="$4"',
        "-v ON_ERROR_STOP=1",
        "-f -",
      ].join(" "),
      "--",
      sql,
      seed.organizationId,
      seed.steps[index].runStepId,
      String(delayMs),
    ]);
    if (!output.trim()) throw new Error("WORKFLOW_RETRY_JOB_MISSING");
  };
  const readWorkflowState = async (
    seed: SeededWorkflow,
  ): Promise<WorkflowState> => {
    const sql = `
      select json_build_object(
        'runStatus', run.status,
        'taskStatus', task.status,
        'runFinishedAt', run.finished_at,
        'engineOwnerToken', run.engine_owner_token,
        'engineOwnerGeneration', run.engine_owner_generation::text,
        'engineOwnerLeaseExpiresAt', run.engine_owner_lease_expires_at,
        'steps', coalesce((
          select json_agg(
            json_build_object(
              'status', step.status,
              'jobStatus', job.status,
              'attemptCount', (
                select count(*)::int
                  from bakery.job_attempts attempt
                 where attempt.organization_id = step.organization_id
                   and attempt.job_id = job.id
              )
            ) order by step.position
          )
            from bakery.run_steps step
            left join bakery.jobs job
              on job.organization_id = step.organization_id
             and job.run_step_id = step.id
           where step.organization_id = :'organization_id'::uuid
             and step.run_id = :'run_id'::uuid
        ), '[]'::json)
      )
        from bakery.workflow_runs run
        join bakery.tasks task
          on task.organization_id = run.organization_id
         and task.id = run.task_id
       where run.organization_id = :'organization_id'::uuid
         and run.id = :'run_id'::uuid;
    `;
    const output = await run([
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      [
        "printf '%s' \"$1\" | psql -U postgres -d bakery -At",
        '-v organization_id="$2"',
        '-v run_id="$3"',
      ].join(" "),
      "--",
      sql,
      seed.organizationId,
      seed.runId,
    ]);
    const line = output.trim().split("\n").at(-1);
    if (!line) throw new Error("SEEDED_WORKFLOW_STATE_MISSING");
    return JSON.parse(line) as WorkflowState;
  };
  const readEngineRegistration = async (): Promise<{
    readonly function_count?: number;
    readonly [key: string]: unknown;
  }> => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const response = await fetch(`${serverUrl}/api/inngest`, {
      method: "GET",
      headers: {
        "x-inngest-signature": `t=${timestamp}&s=${await inngestSignature(
          signingKey,
          timestamp,
        )}`,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `engine registration failed: ${response.status} ${
          JSON.stringify(body)
        }`,
      );
    }
    return body as {
      readonly function_count?: number;
      readonly [key: string]: unknown;
    };
  };
  const engineInvocations = async (
    runId: string,
  ): Promise<readonly EngineInvocation[]> => {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      throw new Error("RUN_ID_INVALID");
    }
    const output = await run([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "inngest",
      "-d",
      "inngest",
      "-At",
      "-c",
      `select encode(function_run.run_id, 'hex') || '|' ||
              event.event_id || '|' || event.event_name
         from public.function_runs as function_run
         join public.events as event
           on event.internal_id = function_run.event_id
        where event.event_data like '%${runId}%'
        order by function_run.run_started_at, function_run.run_id`,
    ]);
    return output.trim().split("\n").filter(Boolean).map((line) => {
      const [functionRunId, eventId, eventName] = line.split("|");
      return { functionRunId, eventId, eventName };
    });
  };
  const restartLineageDiagnostic = async (
    seed: SeededWorkflow,
  ): Promise<string> => {
    const parseRows = (output: string): Array<Record<string, unknown>> =>
      output.trim().split("\n").filter(Boolean).map((line) => {
        const parsed: unknown = JSON.parse(line);
        if (
          parsed === null || typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          throw new Error("RESTART_LINEAGE_ROW_INVALID");
        }
        return parsed as Record<string, unknown>;
      });
    const invocationOutput = await run([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "inngest",
      "-d",
      "inngest",
      "-At",
      "-c",
      `select json_build_object(
                'total', count(*) over (),
                'functionSlug', registered_function.slug,
                'functionRunId', encode(function_run.run_id, 'hex'),
                'eventId', event.event_id,
                'eventInternalId', encode(event.internal_id, 'hex'),
                'originalRunId', case
                  when function_run.original_run_id is null then null
                  else encode(function_run.original_run_id, 'hex') end,
                'startedAt', function_run.run_started_at,
                'finishStatus', coalesce(finish.status::text, 'running')
              )::text
         from public.function_runs as function_run
         join public.events as event
           on event.internal_id = function_run.event_id
         join public.functions as registered_function
           on registered_function.id = function_run.function_id
         left join public.function_finishes as finish
           on finish.run_id = function_run.run_id
        where event.event_data like '%${seed.runId}%'
        order by function_run.run_started_at, function_run.run_id
        limit 9`,
    ]);
    const requestOutput = await run([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "bakery",
      "-At",
      "-c",
      `select json_build_object(
                'total', count(*) over (),
                'requestEventId', event.id,
                'deliveryKey', delivery.delivery_key,
                'deliveryStatus', delivery.status,
                'attempts', delivery.attempt_count
              )::text
         from bakery.domain_events as event
         join bakery.outbox as delivery
           on delivery.organization_id = event.organization_id
          and delivery.event_id = event.id
        where event.organization_id = '${seed.organizationId}'
          and event.aggregate_id = '${seed.runId}'
          and event.event_type = 'run.requested'
          and delivery.destination = 'inngest'
        order by event.organization_sequence
        limit 9`,
    ]);
    // The lease is read against the database clock that fences it, not the
    // host's, so a lapse shows as a negative remaining time.
    const leaseOutput = await run([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "bakery",
      "-At",
      "-c",
      `select json_build_object(
                'ownerGeneration', run.engine_owner_generation::text,
                'expiresAt', run.engine_owner_lease_expires_at,
                'updatedAt', run.updated_at,
                'databaseNow', clock_timestamp(),
                'remainingMs', round(extract(epoch from (
                  run.engine_owner_lease_expires_at - clock_timestamp()
                )) * 1000)
              )::text
         from bakery.workflow_runs as run
        where run.organization_id = '${seed.organizationId}'
          and run.id = '${seed.runId}'`,
    ]);
    const invocations = parseRows(invocationOutput);
    const requests = parseRows(requestOutput);
    const [lease] = parseRows(leaseOutput);
    return formatRestartLineageDiagnostic({
      ownerGeneration: lease?.ownerGeneration,
      invocationCount: invocations[0]?.total ?? 0,
      requestCount: requests[0]?.total ?? 0,
      lease,
      invocations,
      requests,
    });
  };
  const recoveryInvocationCount = async (): Promise<number> => {
    const output = await run([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "inngest",
      "-d",
      "inngest",
      "-At",
      "-c",
      "select count(*) from public.function_runs " +
      "where function_id = 'bakery-workflow-recovery'",
    ]);
    return Number(output.trim().split("\n").at(-1) ?? "0");
  };
  const requestEventCount = async (seed: SeededWorkflow): Promise<number> => {
    const output = await run([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "bakery",
      "-At",
      "-c",
      `select count(*) from bakery.domain_events
        where organization_id = '${seed.organizationId}'
          and aggregate_id = '${seed.runId}'
          and event_type = 'run.requested'`,
    ]);
    return Number(output.trim().split("\n").at(-1) ?? "0");
  };
  const pendingOutboxCount = async (
    seed: SeededWorkflow,
  ): Promise<number> => {
    const output = await run([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "bakery",
      "-At",
      "-c",
      `select count(*) from bakery.outbox
        where organization_id = '${seed.organizationId}'
          and destination = 'inngest'
          and status in ('pending', 'sending')`,
    ]);
    return Number(output.trim().split("\n").at(-1) ?? "0");
  };
  return {
    project,
    eventKey,
    get inngestUrl() {
      return inngestUrl;
    },
    get serverUrl() {
      return serverUrl;
    },
    seedWorkflow,
    completeNextStep,
    setStepAvailableAt,
    readWorkflowState,
    readEngineRegistration,
    start: async () => {
      if (budgetOverridePath === undefined) {
        budgetOverridePath = await Deno.makeTempFile({
          prefix: "bakery-issue40-budget-",
          suffix: ".json",
        });
        await Deno.writeTextFile(
          budgetOverridePath,
          JSON.stringify({
            services: {
              server: {
                environment: {
                  BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD:
                    fundedModelPolicy.installationMonthlyLimitUsd,
                  BAKERY_BUDGET_RESERVATION_TTL_SECONDS: String(
                    fundedModelPolicy.reservationTtlSeconds,
                  ),
                  BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS: String(
                    fundedModelPolicy.maxRunDurationSeconds,
                  ),
                },
              },
            },
          }),
        );
        compose.push("-f", budgetOverridePath);
      }
      // A lost host-port bind re-runs the whole boot on fresh ports, after the
      // project the failed attempt created is removed.
      await retryOnPortCollision({
        run: async () => {
          env.BAKERY_INNGEST_PORT = String(reserveProcessLoopbackPort());
          env.BAKERY_POSTGRES_PORT = String(reserveProcessLoopbackPort());
          env.BAKERY_SERVER_PORT = String(reserveProcessLoopbackPort());
          inngestUrl = `http://127.0.0.1:${env.BAKERY_INNGEST_PORT}`;
          serverUrl = `http://127.0.0.1:${env.BAKERY_SERVER_PORT}`;
          await run([
            "up",
            "-d",
            "--wait",
            "postgres",
            "redis",
            "inngest",
            "migrate",
            "server",
          ]);
        },
        cleanupOwnedAttempt: async () => {
          await run(["down", "-v", "--remove-orphans"]);
        },
      });
      await waitReady();
      await waitServerReady();
      await run([
        "run",
        "-d",
        "--name",
        dispatchContainer,
        "--no-deps",
        "-e",
        `INNGEST_EVENT_KEY=${eventKey}`,
        "server",
        "sh",
        "-eu",
        "-c",
        'export BAKERY_APP_DATABASE_URL="postgres://bakery_app:$BAKERY_LOCAL_APP_PASSWORD@postgres:5432/bakery"; exec deno run --allow-env --allow-net apps/server/src/dispatch.ts',
      ]);
      await waitDispatchReady();
    },
    stopEngine: async () => {
      await run(["stop", "inngest"]);
    },
    restartEngine: async () => {
      await run(["stop", "inngest"]);
      await run(["up", "-d", "--wait", "inngest"]);
      await waitReady();
    },
    stopDispatch: async () => {
      const result = await docker(["stop", dispatchContainer], env);
      if (!result.success) throw new Error(result.output);
    },
    restartDispatch: async () => {
      const result = await docker(["start", dispatchContainer], env);
      if (!result.success) throw new Error(result.output);
      await waitDispatchReady();
    },
    stopPostgres: async () => {
      await run(["stop", "postgres"]);
    },
    restartPostgres: async () => {
      await run(["start", "postgres"]);
      await waitPostgresReady();
    },
    stopServer: async () => {
      await run(["stop", "server"]);
    },
    restartServer: async () => {
      await run(["stop", "server"]);
      await run(["up", "-d", "--wait", "--no-deps", "server"]);
      await waitServerReady();
    },
    cleanup: async () => {
      try {
        await docker(["rm", "-f", dispatchContainer], env);
        await run(["down", "-v"], true);
      } finally {
        if (budgetOverridePath !== undefined) {
          await Deno.remove(budgetOverridePath);
        }
      }
    },
    engineInvocations,
    recoveryInvocationCount,
    requestEventCount,
    pendingOutboxCount,
    restartLineageDiagnostic,
  };
}
