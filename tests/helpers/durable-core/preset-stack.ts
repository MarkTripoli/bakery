import { carriedLaneVariables } from "../../../scripts/ci/lane-environment.ts";
import { assert, assertEquals } from "@std/assert";
import { workerShutdownReceiptPath } from "../../../apps/worker/src/shutdown-receipt.ts";
import { provisionDelegatedCgroupV2 } from "../../../scripts/lib/cgroup-v2.ts";
import {
  type AuthenticatedClients,
  authenticatedClients,
  postJson,
  responseJson,
  waitForEngineFunctionRegistration,
} from "./engine-admission.ts";
import type { DurableCoreStack } from "./stack.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import { agentVersionDigest } from "../../../apps/server/src/modules/agents/postgres.ts";
import { seedProviderPricingSnapshot } from "../funded-model-job.ts";
import {
  ownedSystemdUnitMainRunning,
  ownedSystemdUnitOutput,
  startOwnedSystemdUnit,
  stopOwnedSystemdUnit,
} from "../owned-process-group.ts";

const WORKER_SHUTDOWN_GRACE_MS = 10_000;
const WORKER_KILL_GRACE_MS = 5_000;
const POLL_MS = 100;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const HOSTILE_BRIEF_DESCRIPTION = [
  "<form action=x><script>alert(1)</script></form>",
  "<!doctype html>",
  "controls \u0001 \u000b \u007f end",
  "tab\tlf\ncr\rend & more > less",
].join("\n");

export type PresetWorld = Readonly<{
  clients: AuthenticatedClients;
  organizationId: string;
  applicationId: string;
  repositoryId: string;
  repositoryProfileId: string;
}>;

export type PresetRun = Readonly<{
  taskId: string;
  runId: string;
  briefStepId: string;
  implementStepId: string;
}>;

// A small reservation keeps the stack's one-dollar installation budget from
// starving the many runs this proof starts.
const presetBilling = {
  provider: "openai",
  billingAccountId: "preset-exec-account",
  model: "gpt-5.6-luna",
  billingRoute: "api",
  maxTokens: 1_000,
  maxUsdReservation: 0.01,
  pricingMetadataSnapshot: "preset-exec-price-v1",
} as const;

/**
 * The SQL exceptions in this proof, each with no application write path:
 * - provider_pricing_snapshots: pricing is operator authority and `bakery_app`
 *   can only read it (migration 0064), so the owner role seeds one snapshot.
 * - The worker admin user (`createSuperuser` in `authenticatedClients`): the
 *   stack has no sign-up path, so the owner-role helper provisions the admin.
 * Everything else (applications, agents, versions, repositories, profiles,
 * tasks, runs, controls) goes through the real API.
 */
async function seedCheapPricing(stack: DurableCoreStack): Promise<void> {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    await seedProviderPricingSnapshot(database, { billing: presetBilling });
  } finally {
    await closePgDatabase(database);
  }
}

async function createCodingAgentVersion(
  world: Pick<PresetWorld, "clients">,
): Promise<string> {
  const agent = await responseJson(
    await postJson(
      world.clients.producer,
      "/v1/agents",
      {
        slug: `preset-exec-agent-${crypto.randomUUID().slice(0, 8)}`,
        name: "Preset execution coding agent",
        description: "Coding agent bound to the fixed coding preset.",
      },
      `preset-agent-${crypto.randomUUID()}`,
    ),
    201,
    "AGENT_CREATE",
  );
  const config = { harness: "codex", billing: presetBilling };
  const version = await responseJson(
    await postJson(
      world.clients.producer,
      `/v1/agents/${agent.id}/versions`,
      { revision: 1, config, digest: await agentVersionDigest(config) },
      `preset-agent-version-${crypto.randomUUID()}`,
    ),
    201,
    "AGENT_VERSION_CREATE",
  );
  assert(typeof version.id === "string" && UUID.test(version.id));
  return version.id;
}

async function createPinnedRepository(
  world: Pick<PresetWorld, "clients" | "applicationId">,
  agentVersionId: string,
): Promise<{ repositoryId: string; repositoryProfileId: string }> {
  const slug = `preset-exec-${crypto.randomUUID().slice(0, 8)}`;
  const repository = await responseJson(
    await postJson(
      world.clients.producer,
      "/v1/repositories",
      {
        applicationId: world.applicationId,
        slug,
        integrationConnectionId: crypto.randomUUID(),
        providerRepoId: slug,
        owner: "preset-exec",
        name: slug,
        defaultBranch: "main",
      },
      `preset-repository-${crypto.randomUUID()}`,
    ),
    201,
    "REPOSITORY_CREATE",
  );
  const repositoryId = repository.id;
  assert(typeof repositoryId === "string" && UUID.test(repositoryId));
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["main", "durable/*"] },
    worktree: { root: "worktree" },
    agentBindings: { "harness.implement": agentVersionId },
  };
  const profile = await responseJson(
    await postJson(
      world.clients.producer,
      `/v1/repositories/${repositoryId}/profiles`,
      {
        revision: 1,
        config,
        digest: await sha256Hex(canonicalJson(config)),
      },
      `preset-profile-${crypto.randomUUID()}`,
    ),
    201,
    "PROFILE_CREATE",
  );
  assert(typeof profile.id === "string" && UUID.test(profile.id));
  return { repositoryId, repositoryProfileId: profile.id };
}

/** Real API application, owner-seeded funded coding agent and a pinned repository. */
export async function seedPresetWorld(
  stack: DurableCoreStack,
): Promise<PresetWorld> {
  await waitForEngineFunctionRegistration(stack);
  const clients = await authenticatedClients(stack);
  const application = await responseJson(
    await postJson(
      clients.producer,
      "/v1/applications",
      {
        slug: `preset-exec-${crypto.randomUUID().slice(0, 8)}`,
        name: "Preset execution",
        description: "Fixed coding preset execution proof",
      },
      `preset-application-${crypto.randomUUID()}`,
    ),
    201,
    "APPLICATION_CREATE",
  );
  const applicationId = application.id;
  assert(typeof applicationId === "string" && UUID.test(applicationId));
  await seedCheapPricing(stack);
  const agentVersionId = await createCodingAgentVersion({ clients });
  const repository = await createPinnedRepository(
    { clients, applicationId },
    agentVersionId,
  );
  return {
    clients,
    organizationId: clients.identity.organizationId,
    applicationId,
    repositoryId: repository.repositoryId,
    repositoryProfileId: repository.repositoryProfileId,
  };
}

/** Creates one task and starts the fixed coding preset on it. */
export async function startPresetTaskRun(
  stack: DurableCoreStack,
  world: PresetWorld,
  options: { title?: string; description?: string } = {},
): Promise<PresetRun> {
  const task = await responseJson(
    await postJson(
      world.clients.producer,
      "/v1/tasks",
      {
        applicationId: world.applicationId,
        repositoryId: world.repositoryId,
        repositoryProfileId: world.repositoryProfileId,
        taskType: "feature",
        title: options.title ?? "Preset execution task",
        description: options.description ?? HOSTILE_BRIEF_DESCRIPTION,
      },
      `preset-task-${crypto.randomUUID()}`,
    ),
    201,
    "TASK_CREATE",
  );
  const taskId = task.id;
  assert(typeof taskId === "string" && UUID.test(taskId));
  const run = await responseJson(
    await postJson(
      world.clients.producer,
      `/v1/tasks/${taskId}/runs`,
      {
        presetId: "fixed-coding",
        executionMode: "repository",
        repositoryProfileId: world.repositoryProfileId,
        budgetLimitUsd: "0.100000",
      },
      `preset-run-${crypto.randomUUID()}`,
    ),
    201,
    "RUN_CREATE",
  );
  const runId = run.id;
  assert(typeof runId === "string" && UUID.test(runId));
  const steps = await stack.psql<{ id: string; step_key: string }>(
    `select id, step_key from bakery.run_steps
      where organization_id = $1 and run_id = $2`,
    [world.organizationId, runId],
  );
  const stepId = (key: string): string => {
    const found = steps.find((step) => step.step_key === key)?.id;
    assert(found, `step ${key} missing`);
    return found;
  };
  return {
    taskId,
    runId,
    briefStepId: stepId("brief"),
    implementStepId: stepId("implement"),
  };
}

export async function until<T>(
  description: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined>,
  onWait?: () => Promise<void>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await onWait?.();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`PRESET_E2E_TIMEOUT:${description}`);
}

export async function implementJobId(
  stack: DurableCoreStack,
  world: PresetWorld,
  run: PresetRun,
): Promise<string> {
  try {
    return await until("implement job admitted", 150_000, async () => {
      const rows = await stack.psql<{ id: string }>(
        `select id from bakery.jobs
          where organization_id = $1 and run_step_id = $2`,
        [world.organizationId, run.implementStepId],
      );
      return rows[0]?.id;
    });
  } catch (error) {
    const state = await stack.psql(
      `select run.status as run_status, step.step_key, step.status,
              step.error, run.id as run_id
         from bakery.workflow_runs run
         join bakery.run_steps step
           on step.organization_id = run.organization_id
          and step.run_id = run.id
        where run.organization_id = $1 and run.id = $2`,
      [world.organizationId, run.runId],
    );
    throw new Error(
      `${(error as Error).message}:${JSON.stringify(state)}`,
    );
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export type RunRow = {
  run_status: string;
  task_status: string;
};

export async function runAndTaskStatus(
  stack: DurableCoreStack,
  world: PresetWorld,
  run: PresetRun,
): Promise<RunRow> {
  const rows = await stack.psql<RunRow>(
    `select run.status as run_status, task.status as task_status
       from bakery.workflow_runs run
       join bakery.tasks task
         on task.organization_id = run.organization_id and task.id = run.task_id
      where run.organization_id = $1 and run.id = $2`,
    [world.organizationId, run.runId],
  );
  assert(rows[0], "run row missing");
  return rows[0];
}

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "canceled"];

export async function waitForTerminalRun(
  stack: DurableCoreStack,
  world: PresetWorld,
  run: PresetRun,
  timeoutMs = 120_000,
  onWait?: () => Promise<void>,
): Promise<RunRow> {
  return await until(
    `run ${run.runId} terminal`,
    timeoutMs,
    async () => {
      const row = await runAndTaskStatus(stack, world, run);
      return TERMINAL_RUN_STATUSES.includes(row.run_status) ? row : undefined;
    },
    onWait,
  );
}

export type PresetWorkerHandle = {
  readonly unit: Awaited<ReturnType<typeof startOwnedSystemdUnit>>;
  readonly stateDir: string;
  readonly tokenPath: string;
  readonly launchId: string;
  readonly name: string;
};

async function privateTempDirectory(prefix: string): Promise<string> {
  const result = await new Deno.Command("mktemp", {
    args: ["-d", `${Deno.env.get("TMPDIR") ?? "/tmp"}/${prefix}-XXXXXX`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error("PRESET_E2E_TEMP_DIRECTORY_FAILED");
  const path = new TextDecoder().decode(result.stdout).trim();
  return path;
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  const process = new Deno.Command("bash", {
    args: ["-c", 'umask 077; cat > "$1"', "bash", path],
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(value));
  await writer.close();
  if (!(await process.status).success) {
    throw new Error("PRESET_E2E_PRIVATE_FILE_FAILED");
  }
}

export async function removePaths(paths: readonly string[]): Promise<void> {
  const present = paths.filter(Boolean);
  if (present.length === 0) return;
  await new Deno.Command("rm", {
    args: ["-rf", "--", ...present],
    stdout: "null",
    stderr: "null",
  }).output();
}

/**
 * Enrolls and starts the production worker (`pnpm --filter @bakery/worker
 * start`) as an owned systemd unit bound to the delegated owner scope.
 * `stateDir` reuse restarts the same registered worker.
 */
export async function launchPresetWorker(
  stack: DurableCoreStack,
  world: PresetWorld,
  options: {
    cgroupRoot: string;
    /** Worker API origin when `stack.origin` is a proxy in front of the server. */
    serverUrl?: string;
    scriptedHarnessDir?: string;
    slots?: number;
    stateDir?: string;
    tokenPath?: string;
    name?: string;
    /** Capabilities enrolled and advertised; defaults to git, shell, web, model. */
    capabilities?: readonly string[];
    /** Extra worker settings, such as a coding harness repository. */
    environment?: Readonly<Record<string, string>>;
    /**
     * `pnpm-start` (default) runs `pnpm --filter @bakery/worker start`, whose
     * `env -i` list carries no coding-harness setting. `run-worker` runs
     * `bash scripts/run-worker.sh` from `apps/worker`, the launcher compose and
     * the deploy script use, so a harness repository reaches the worker.
     */
    launcher?: "pnpm-start" | "run-worker";
  },
): Promise<PresetWorkerHandle> {
  const ownerUnit = Deno.env.get("BAKERY_E2E_OWNER_UNIT")?.trim();
  if (!ownerUnit) throw new Error("BAKERY_E2E_OWNER_UNIT_REQUIRED");
  const name = options.name ??
    `preset-worker-${crypto.randomUUID().slice(0, 8)}`;
  const capabilities = options.capabilities ?? ["git", "shell", "web", "model"];
  let stateDir = options.stateDir;
  let tokenPath = options.tokenPath;
  if (stateDir === undefined || tokenPath === undefined) {
    const enrollmentResponse = await stack.fetch(
      new Request(`${stack.origin}/v1/worker-enrollments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: stack.origin,
          cookie: world.clients.producer.cookie ?? "",
          "Bakery-Organization-Id": world.organizationId,
          "Idempotency-Key": `preset-enrollment-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          name,
          os: "linux",
          architecture: "x64",
          capabilities,
          slots: options.slots ?? 1,
        }),
      }),
    );
    const enrollmentText = await enrollmentResponse.text();
    assertEquals(enrollmentResponse.status, 201, enrollmentText);
    const enrollment = JSON.parse(enrollmentText) as {
      enrollmentToken?: unknown;
    };
    assert(typeof enrollment.enrollmentToken === "string");
    stateDir = await privateTempDirectory("bakery-preset-worker");
    tokenPath = `${stateDir}/enrollment-token`;
    await writePrivateFile(tokenPath, `${enrollment.enrollmentToken}\n`);
  }
  const launchId = crypto.randomUUID();
  const unit = await startOwnedSystemdUnit({
    ...(options.launcher === "run-worker"
      ? {
        command: "bash",
        args: ["scripts/run-worker.sh"],
        cwd: `${Deno.cwd()}/apps/worker`,
      }
      : {
        command: "pnpm",
        args: ["--filter", "@bakery/worker", "start"],
        cwd: Deno.cwd(),
      }),
    environment: {
      // The lane's mise, cache, XDG and git settings: the unit starts inside
      // `env -i`, and without them mise looks for the operator's own.
      ...carriedLaneVariables(Deno.env.toObject()),
      ...options.environment,
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: Deno.env.get("HOME") ?? "/tmp",
      TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
      BAKERY_ENV: "test",
      BAKERY_SERVER_URL: options.serverUrl ?? stack.origin,
      BAKERY_VERSION: "preset-execution-evidence",
      BAKERY_WORKER_CGROUP_ROOT: options.cgroupRoot,
      BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: tokenPath,
      BAKERY_WORKER_STATE_DIR: stateDir,
      BAKERY_WORKER_NAME: name,
      BAKERY_WORKER_CAPABILITIES: capabilities.join(","),
      BAKERY_WORKER_ADAPTER_CAPABILITIES: "steer,follow_up",
      BAKERY_WORKER_SLOTS: String(options.slots ?? 1),
      BAKERY_WORKER_HEARTBEAT_MS: "100",
      BAKERY_WORKER_CLAIM_BACKOFF_MS: "100",
      BAKERY_WORKER_CLAIM_BACKOFF_MAX_MS: "500",
      BAKERY_WORKER_REQUEST_TIMEOUT_MS: "5000",
      BAKERY_WORKER_DRAIN_MS: "5000",
      BAKERY_WORKER_LAUNCH_ID: launchId,
      ...(options.scriptedHarnessDir
        ? { BAKERY_WORKER_SCRIPTED_HARNESS_DIR: options.scriptedHarnessDir }
        : {}),
    },
    bindToUnit: ownerUnit,
    workerShutdownReceipt: {
      path: workerShutdownReceiptPath(stateDir),
      launchId,
    },
    gracefulTimeoutMs: WORKER_SHUTDOWN_GRACE_MS,
    forceTimeoutMs: WORKER_KILL_GRACE_MS,
  });
  return { unit, stateDir, tokenPath, launchId, name };
}

/** Throws with redacted worker output when the owned worker process died. */
export async function assertWorkerRunning(
  worker: PresetWorkerHandle,
): Promise<void> {
  if (!(await ownedSystemdUnitMainRunning(worker.unit))) {
    throw new Error(
      `PRODUCTION_WORKER_EXITED:${ownedSystemdUnitOutput(worker.unit)}`,
    );
  }
}

export async function stopPresetWorker(
  worker: PresetWorkerHandle,
): Promise<void> {
  const stopped = await stopOwnedSystemdUnit(worker.unit);
  assertEquals(
    stopped.forced,
    false,
    `PRODUCTION_WORKER_SHUTDOWN_FORCED:${ownedSystemdUnitOutput(worker.unit)}`,
  );
}

export { provisionDelegatedCgroupV2 };
