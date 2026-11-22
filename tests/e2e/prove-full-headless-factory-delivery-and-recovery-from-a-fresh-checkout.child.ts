/**
 * #50: the complete headless factory on ONE real stack (compose server,
 * worker-dispatch, Postgres, real Inngest, the production worker with the
 * scripted harness). Every phase acts and asserts through a public interface
 * (REST, MCP, the worker protocol, the signed GitHub webhook), with owner-role
 * SQL only to read counts back and to seed what has no write path (pricing,
 * the superuser, the GitHub App authority, one uncertain effect). Launched by
 * the sibling _test.ts inside a delegated systemd scope.
 *
 * Owner-role seeds, each with no application write path:
 * - seedPresetWorld: provider pricing snapshot and the superuser.
 * - seedOrganization: the coordinator conversation's organization.
 * - seedAuthority + sealWebhookSecret: the GitHub App registration,
 *   installation, connection, resource and its webhook secret.
 * - one external effect left "uncertain", as a crash mid-send leaves it.
 */
import { assert, assertEquals } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { automationVersionInputs } from "../helpers/automation-fixtures.ts";
import {
  cleanupSeededOrganizations,
  type Harness,
  seedOrganization,
  sendMessage,
} from "../helpers/coordinator-turns.ts";
import {
  request as questionRequest,
  seedTask as seedQuestionTask,
} from "../helpers/durable-questions.ts";
import {
  postJson,
  publishWorkflowReconciliation,
  responseJson,
} from "../helpers/durable-core/engine-admission.ts";
import {
  assertWorkerRunning,
  fileExists,
  implementJobId,
  launchPresetWorker,
  type PresetRun,
  presetStepId,
  type PresetWorkerHandle,
  type PresetWorld,
  provisionDelegatedCgroupV2,
  removePaths,
  runAndTaskStatus,
  seedPresetWorld,
  stopPresetWorker,
  until,
  waitForTerminalRun,
} from "../helpers/durable-core/preset-stack.ts";
import {
  type DurableCoreStack,
  upDurableCoreStack,
} from "../helpers/durable-core/stack.ts";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import {
  assertFullAcceptanceCases,
  formatFullAcceptanceCase,
  type FullAcceptanceCase,
  type FullAcceptanceCaseRecord,
} from "../helpers/full-acceptance/cases.ts";
import { deliveryRequest } from "../helpers/github-intake/signed-delivery.ts";
import {
  connectClient,
  mcpRequest,
  type McpResult,
  READ_AND_OPERATE,
  TEST_REDIRECT_URI,
} from "../helpers/oauth-mcp.ts";
import {
  type Authority,
  sealWebhookSecret,
  seedAuthority,
} from "../helpers/ticket-admission/e2e-seed.ts";
import { cleanSeed } from "../helpers/review-repair/e2e-scenarios.ts";
import {
  onboardLoopRepository,
  seedLoopAgents,
  SubstituteWorker,
} from "../helpers/review-repair/e2e-world.ts";
import type { Stack } from "./helpers/stack.ts";

const WEBHOOK_SECRET = "full-acceptance-webhook-secret-test-only";
const SCRIPT_DIRECTORY = "tests/fixtures/scripted-coordinator";
const TERMINAL_TIMEOUT_MS = 180_000;
const MIGRATION_READ_PATHS = [
  "apps/server/src/platform/migrations",
  "apps/server/src/modules/auth/migrations",
  "apps/server/src/modules/work/migrations",
  "apps/server/src/modules/projects/migrations",
  "apps/server/src/modules/agents/migrations",
  "apps/server/src/modules/repository-rules/migrations",
  "apps/server/src/modules/artifact-kinds/migrations",
  "apps/server/src/modules/integrations/migrations",
  "apps/server/src/modules/delivery/migrations",
  "apps/server/src/modules/mcp/migrations",
  "apps/server/src/modules/knowledge/migrations",
  "apps/server/src/modules/catalog/migrations",
];

const recorded: FullAcceptanceCaseRecord[] = [];

function record(
  name: FullAcceptanceCase,
  facts: Record<string, unknown>,
): void {
  const entry: FullAcceptanceCaseRecord = { name, outcome: "passed", facts };
  recorded.push(entry);
  console.log(formatFullAcceptanceCase(entry));
}

/** The e2e Stack shape the shared seeds take; the durable stack carries every member they use. */
function asStack(stack: DurableCoreStack): Stack {
  return stack as unknown as Stack;
}

/** A request rewritten onto the stack, redirects left to the caller (the OAuth flow reads them). */
function driverFor(stack: DurableCoreStack) {
  return {
    app: {
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const target = new URL(stack.origin);
        url.protocol = target.protocol;
        url.host = target.host;
        const headers = new Headers(request.headers);
        if (headers.has("origin")) headers.set("origin", stack.origin);
        const body = request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.clone().arrayBuffer();
        return await fetch(url, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
        });
      },
    },
  };
}

/** Runs the shipped register-oauth-client task in a one-off server container. */
async function registerOauthClient(stack: DurableCoreStack): Promise<string> {
  const containerOwnerUrl = stack.ownerDatabaseUrl.replace(
    /@[^/]+\//,
    "@postgres:5432/",
  );
  const result = await stack.runOneOff([
    "run",
    "--rm",
    "-T",
    "-e",
    "DATABASE_URL=" + containerOwnerUrl,
    "server",
    "deno",
    "run",
    "--allow-env",
    "--allow-net",
    "--allow-sys=hostname",
    "--allow-read=" + MIGRATION_READ_PATHS.join(","),
    "apps/server/src/tasks.ts",
    "register-oauth-client",
    "--name",
    "Full acceptance client",
    "--redirect-uri",
    TEST_REDIRECT_URI,
    "--scopes",
    READ_AND_OPERATE.join(" "),
  ]);
  assert(result.success, "register-oauth-client failed: " + result.output);
  const printed = result.output.split("\n").map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_-]{32,}$/.test(line));
  assertEquals(printed.length, 1, result.output);
  return printed[0]!;
}

async function mcpTool(
  driver: ReturnType<typeof driverFor>,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await driver.app.fetch(
    mcpRequest("tools/call", { name, arguments: args }, { token }),
  );
  const raw = await response.text();
  assertEquals(response.status, 200, name + ": " + raw);
  const body = JSON.parse(raw) as McpResult;
  assert(
    body.result && body.result.isError !== true,
    name + " returned an error: " + raw,
  );
  // A catalog tool answers the REST route's status and body.
  const value = JSON.parse(body.result.content![0]!.text) as Record<
    string,
    unknown
  >;
  const unwrapped = "body" in value && "status" in value
    ? value.body as Record<string, unknown>
    : value;
  assert(unwrapped && typeof unwrapped === "object", name + ": " + raw);
  return unwrapped;
}

async function get(
  world: PresetWorld,
  path: string,
): Promise<Record<string, unknown>> {
  const client = world.clients.consumer;
  const response = await client.stack.fetch(
    new Request(client.stack.origin + path, {
      headers: {
        cookie: client.cookie ?? "",
        "Bakery-Organization-Id": world.organizationId,
      },
    }),
  );
  return await responseJson(response, 200, "GET " + path);
}

function taskBody(world: PresetWorld, title: string) {
  return {
    applicationId: world.applicationId,
    repositoryId: world.repositoryId,
    repositoryProfileId: world.repositoryProfileId,
    taskType: "feature",
    title,
    description: "Add a health endpoint and a test for it.",
  };
}

const PRESET_RUN_BODY = {
  presetId: "fixed-coding",
  executionMode: "repository",
  budgetLimitUsd: "0.100000",
};

async function startRun(
  stack: DurableCoreStack,
  world: PresetWorld,
  taskId: string,
  key = "full-acceptance-run-" + crypto.randomUUID(),
): Promise<PresetRun> {
  const run = await responseJson(
    await postJson(
      world.clients.producer,
      "/v1/tasks/" + taskId + "/runs",
      { ...PRESET_RUN_BODY, repositoryProfileId: world.repositoryProfileId },
      key,
    ),
    201,
    "RUN_CREATE",
  );
  const runId = String(run.id);
  return {
    taskId,
    runId,
    briefStepId: await presetStepId(stack, world, runId, "brief"),
  };
}

async function createTask(
  world: PresetWorld,
  title: string,
): Promise<string> {
  const task = await responseJson(
    await postJson(
      world.clients.producer,
      "/v1/tasks",
      taskBody(world, title),
      "full-acceptance-task-" + crypto.randomUUID(),
    ),
    201,
    "TASK_CREATE",
  );
  return String(task.id);
}

type JobFacts = {
  attempts: number;
  completedAttempts: number;
  succeededEvents: number;
  jobStatus: string;
};

async function jobFacts(
  stack: DurableCoreStack,
  world: PresetWorld,
  jobId: string,
): Promise<JobFacts> {
  const rows = await stack.psql<JobFacts>(
    "select" +
      " (select count(*)::int from bakery.job_attempts where job_id = $2) as attempts," +
      " (select count(*)::int from bakery.job_attempts where job_id = $2 and status = 'completed') as \"completedAttempts\"," +
      " (select count(*)::int from bakery.attempt_events event join bakery.job_attempts attempt on attempt.id = event.attempt_id" +
      "   where attempt.job_id = $2 and event.event_type = 'job.succeeded') as \"succeededEvents\"," +
      ' (select status from bakery.jobs where organization_id = $1 and id = $2) as "jobStatus"',
    [world.organizationId, jobId],
  );
  return rows[0]!;
}

/** Every job of the run ran exactly once and the run holds one terminal result per step. */
async function assertRanOnce(
  stack: DurableCoreStack,
  world: PresetWorld,
  run: PresetRun,
): Promise<{ jobs: number; attempts: number; steps: number }> {
  const rows = await stack.psql<{
    jobs: number;
    attempts: number;
    completedAttempts: number;
    steps: number;
    completedSteps: number;
  }>(
    "select" +
      " (select count(*)::int from bakery.jobs job join bakery.run_steps step on step.id = job.run_step_id" +
      "   where step.organization_id = $1 and step.run_id = $2) as jobs," +
      " (select count(*)::int from bakery.job_attempts attempt join bakery.jobs job on job.id = attempt.job_id" +
      "   join bakery.run_steps step on step.id = job.run_step_id where step.run_id = $2) as attempts," +
      " (select count(*)::int from bakery.job_attempts attempt join bakery.jobs job on job.id = attempt.job_id" +
      "   join bakery.run_steps step on step.id = job.run_step_id where step.run_id = $2 and attempt.status = 'completed') as \"completedAttempts\"," +
      " (select count(*)::int from bakery.run_steps where organization_id = $1 and run_id = $2) as steps," +
      " (select count(*)::int from bakery.run_steps where organization_id = $1 and run_id = $2 and status = 'completed') as \"completedSteps\"",
    [world.organizationId, run.runId],
  );
  const facts = rows[0]!;
  assertEquals(facts.attempts, facts.jobs, "one attempt per job");
  assertEquals(facts.completedAttempts, facts.jobs, "every attempt completed");
  assertEquals(facts.completedSteps, facts.steps, "every step completed");
  assert(facts.jobs >= 2, "brief and implement both ran on the worker");
  return { jobs: facts.jobs, attempts: facts.attempts, steps: facts.steps };
}

async function main(): Promise<void> {
  let stack: DurableCoreStack | undefined;
  let lease:
    | Awaited<ReturnType<typeof provisionDelegatedCgroupV2>>
    | undefined;
  let worker: PresetWorkerHandle | undefined;
  let owner: PgDatabase | undefined;
  let substitute: SubstituteWorker | undefined;
  const scriptFiles: string[] = [];
  const stateDirs: string[] = [];
  const harnessDir = await Deno.makeTempDir({
    prefix: "bakery-full-acceptance-",
  });
  try {
    stack = await upDurableCoreStack("full-acceptance", {
      jobCompletionTimeout: "30s",
    });
    const live = stack;
    owner = openPgDatabase(live.ownerDatabaseUrl);
    lease = await provisionDelegatedCgroupV2("bakery-full-acceptance-");
    const world = await seedPresetWorld(live);
    const launch = async (from?: PresetWorkerHandle) =>
      await launchPresetWorker(live, world, {
        cgroupRoot: lease!.root,
        scriptedHarnessDir: harnessDir,
        slots: 2,
        ...(from
          ? {
            stateDir: from.stateDir,
            tokenPath: from.tokenPath,
            name: from.name,
          }
          : {}),
      });
    worker = await launch();
    stateDirs.push(worker.stateDir);
    const alive = () => assertWorkerRunning(worker!);
    const started = async (run: PresetRun): Promise<string> => {
      const jobId = await implementJobId(live, world, run);
      await until(
        "scripted harness started " + jobId,
        120_000,
        async () =>
          (await fileExists(harnessDir + "/" + jobId + ".started"))
            ? true
            : undefined,
        alive,
      );
      return jobId;
    };
    const release = async (jobId: string) =>
      await Deno.writeTextFile(harnessDir + "/" + jobId + ".release", "go\n");
    const terminal = (run: PresetRun) =>
      waitForTerminalRun(live, world, run, TERMINAL_TIMEOUT_MS, alive);

    // An effect a crash left mid-send: the ledger cannot tell whether the
    // provider applied it. Seeded first so every restart below runs past it.
    const uncertainEffect = (await live.psql<{ id: string }>(
      "insert into bakery.external_effects" +
        " (organization_id, operation, target, requesting_principal_id, actor_ref," +
        "  idempotency_key, request_digest, adapter_version, status, dispatch_generation)" +
        " values ($1, 'github.comment.create', 'full-acceptance/uncertain', $2," +
        "  'actor:full-acceptance', $3, $4, 'v1', 'uncertain', 1)" +
        " returning id",
      [
        world.organizationId,
        world.clients.identity.principalId,
        "full-acceptance-uncertain-" + crypto.randomUUID(),
        "e".repeat(64),
      ],
    ))[0]!.id;
    const effectRow = async () =>
      (await live.psql<Record<string, unknown>>(
        "select status, dispatch_generation, updated_at::text as updated_at" +
          " from bakery.external_effects where id = $1",
        [uncertainEffect],
      ))[0];
    const effectBefore = await effectRow();

    // 1. The same work through REST and through MCP, under one idempotency key.
    const title = "Full acceptance " + crypto.randomUUID().slice(0, 8);
    const intakeKey = "full-acceptance-intake-" + crypto.randomUUID();
    const restFirst = await responseJson(
      await postJson(
        world.clients.producer,
        "/v1/tasks",
        taskBody(world, title),
        intakeKey,
      ),
      201,
      "REST_INTAKE",
    );
    const restReplay = await postJson(
      world.clients.producer,
      "/v1/tasks",
      taskBody(world, title),
      intakeKey,
    );
    const restReplayBody = await responseJson(
      restReplay,
      201,
      "REST_INTAKE_REPLAY",
    );
    assertEquals(restReplayBody.id, restFirst.id);
    assertEquals(restReplay.headers.get("Idempotent-Replayed"), "true");
    const clientId = await registerOauthClient(live);
    const driver = driverFor(live);
    const { accessToken } = await connectClient(driver, {
      cookie: world.clients.producer.cookie ?? "",
      clientId,
      resource: live.origin + "/mcp",
    });
    const mcpCreated = await mcpTool(
      driver,
      accessToken,
      "bakery_tasks_create",
      {
        ...taskBody(world, title),
        idempotencyKey: intakeKey,
      },
    );
    assertEquals(mcpCreated.id, restFirst.id, JSON.stringify(mcpCreated));
    const mcpRead = await mcpTool(driver, accessToken, "bakery_tasks_get", {
      id: restFirst.id,
    });
    assertEquals(mcpRead.title, title);
    const intakeCounts = await live.psql<{ tasks: number }>(
      "select count(*)::int as tasks from bakery.tasks where organization_id = $1 and title = $2",
      [world.organizationId, title],
    );
    assertEquals(intakeCounts, [{ tasks: 1 }]);
    record("rest-and-mcp-intake-of-the-same-work", {
      taskId: restFirst.id,
      restReplayed: true,
      mcpSameTask: true,
    });

    // 2. Duplicate intake of the run: one admission, one engine run.
    const runKey = "full-acceptance-run-" + crypto.randomUUID();
    const primary = await startRun(live, world, String(restFirst.id), runKey);
    const duplicateRun = await responseJson(
      await postJson(
        world.clients.producer,
        "/v1/tasks/" + primary.taskId + "/runs",
        { ...PRESET_RUN_BODY, repositoryProfileId: world.repositoryProfileId },
        runKey,
      ),
      201,
      "RUN_CREATE_REPLAY",
    );
    assertEquals(duplicateRun.id, primary.runId);
    const admissions = await live.psql<{ runs: number }>(
      "select count(*)::int as runs from bakery.workflow_runs where organization_id = $1 and task_id = $2",
      [world.organizationId, primary.taskId],
    );
    assertEquals(admissions, [{ runs: 1 }]);
    record("duplicate-intake-one-admission", {
      runId: primary.runId,
      runs: 1,
    });

    // 3. The server is force-restarted while the worker holds the implement
    // step; the held attempt finishes on the restarted server, once.
    const primaryJob = await started(primary);
    const serverBefore = await live.processId("server");
    await live.restartService("server", primaryJob);
    const serverAfter = await live.processId("server");
    assert(serverBefore !== serverAfter, "the server process was replaced");
    await release(primaryJob);
    assertEquals(await terminal(primary), {
      run_status: "completed",
      task_status: "completed",
    });
    const primaryOnce = await assertRanOnce(live, world, primary);
    const primaryJobFacts = await jobFacts(live, world, primaryJob);
    assertEquals(primaryJobFacts.succeededEvents, 1);
    record("server-restart-mid-run", {
      runId: primary.runId,
      serverProcess: { before: serverBefore, after: serverAfter },
      ...primaryOnce,
    });

    // 4. The isolated worker job's artifact, read and commented through REST.
    const implementStepId = await presetStepId(
      live,
      world,
      primary.runId,
      "implement",
    );
    const patches = await live.psql<{ versionId: string; artifactId: string }>(
      'select version.id as "versionId", version.artifact_id as "artifactId"' +
        " from bakery.artifact_versions version join bakery.artifacts artifact" +
        "   on artifact.organization_id = version.organization_id and artifact.id = version.artifact_id" +
        " where version.organization_id = $1 and version.run_step_id = $2 and artifact.artifact_type = 'patch'",
      [world.organizationId, implementStepId],
    );
    assertEquals(patches.length, 1, "one patch artifact version");
    const patch = patches[0]!;
    const artifact = await get(world, "/v1/artifacts/" + patch.artifactId);
    assertEquals(artifact.currentVersionId, patch.versionId);
    const comment = await responseJson(
      await postJson(
        world.clients.producer,
        "/v1/artifact-versions/" + patch.versionId + "/comments",
        { body: "Reviewed: the scripted patch adds the expected file." },
        "full-acceptance-comment-" + crypto.randomUUID(),
      ),
      201,
      "ARTIFACT_COMMENT_CREATE",
    );
    const comments = await get(
      world,
      "/v1/artifact-versions/" + patch.versionId + "/comments",
    );
    assertEquals(
      (comments.items as { id: string }[]).map((item) => item.id),
      [String(comment.id)],
    );
    const steps = await get(world, "/v1/runs/" + primary.runId + "/steps");
    assert(
      (steps.items as { status: string }[]).every((step) =>
        step.status === "completed"
      ),
      "every step reads completed: " + JSON.stringify(steps.items),
    );
    record("worker-artifact-and-comment", {
      artifactId: patch.artifactId,
      versionId: patch.versionId,
      commentId: comment.id,
    });

    // 5. Budget: the run's usage summary through the public read.
    const usage = await get(world, "/v1/usage?runId=" + primary.runId);
    const reservations = await live.psql<{ reservations: number }>(
      "select count(*)::int as reservations from bakery.budget_reservations reservation" +
        " join bakery.run_steps step on step.organization_id = reservation.organization_id and step.id = reservation.run_step_id" +
        " where reservation.organization_id = $1 and step.run_id = $2",
      [world.organizationId, primary.runId],
    );
    assert(
      reservations[0]!.reservations >= 1,
      "the run's model job reserved budget",
    );
    record("budget-recorded", {
      runId: primary.runId,
      reservations: reservations[0]!.reservations,
      usageKeys: Object.keys(usage).sort(),
    });

    // 6. Metrics read back the delivered task.
    const metrics = await get(world, "/v1/metrics?metric=tasks.leadTimeHours");
    assert(
      Array.isArray(metrics.points) || Array.isArray(metrics.buckets) ||
        Array.isArray(metrics.series) || metrics.summary !== undefined,
      "metrics answer a series: " + JSON.stringify(metrics).slice(0, 500),
    );
    record("metrics-read", {
      metric: "tasks.leadTimeHours",
      keys: Object.keys(metrics).sort(),
    });

    // 7. The worker is stopped mid-run (the run admitted, its steps waiting)
    // and the same registered worker comes back: the run completes once.
    await stopPresetWorker(worker);
    const stoppedWorker = worker;
    worker = undefined;
    const restartedRun = await startRun(
      live,
      world,
      await createTask(world, "Worker restart"),
    );
    const workerRunMidway = await runAndTaskStatus(live, world, restartedRun);
    assert(
      !["completed", "failed", "canceled"].includes(workerRunMidway.run_status),
      "the run is mid-way while no worker runs",
    );
    worker = await launch(stoppedWorker);
    await release(await started(restartedRun));
    assertEquals((await terminal(restartedRun)).run_status, "completed");
    record("worker-restart-mid-run", {
      runId: restartedRun.runId,
      statusWhileStopped: workerRunMidway.run_status,
      ...(await assertRanOnce(live, world, restartedRun)),
    });

    // 8 + 9. The engine is stopped while the implement step runs; the worker
    // completes the job before the engine is back to wait for it. The run
    // still ends with one result.
    const engineRun = await startRun(
      live,
      world,
      await createTask(world, "Engine restart"),
    );
    const engineJob = await started(engineRun);
    const engineBefore = await live.processId("inngest");
    await live.stopService("inngest");
    await release(engineJob);
    const completedWhileDown = await until(
      "implement job completed while the engine is down",
      120_000,
      async () => {
        const facts = await jobFacts(live, world, engineJob);
        return facts.jobStatus === "completed" ? facts : undefined;
      },
      alive,
    );
    await live.startService("inngest");
    const engineAfter = await live.processId("inngest");
    assert(engineBefore !== engineAfter, "the engine process was replaced");
    let reconciled = false;
    let engineTerminal = await waitForTerminalRun(
      live,
      world,
      engineRun,
      TERMINAL_TIMEOUT_MS,
      alive,
    ).catch(() => undefined);
    if (engineTerminal === undefined) {
      // No natural successor inside the window: the shipped reconciliation
      // event resumes the run from its durable rows.
      reconciled = true;
      await publishWorkflowReconciliation(live, engineRun.runId);
      engineTerminal = await terminal(engineRun);
    }
    assertEquals(engineTerminal.run_status, "completed");
    const engineOnce = await assertRanOnce(live, world, engineRun);
    record("engine-restart-mid-run", {
      runId: engineRun.runId,
      engineProcess: { before: engineBefore, after: engineAfter },
      reconciled,
      ...engineOnce,
    });
    const engineJobAfter = await jobFacts(live, world, engineJob);
    assertEquals(engineJobAfter, completedWhileDown);
    assertEquals(engineJobAfter.completedAttempts, 1);
    assertEquals(engineJobAfter.succeededEvents, 1);
    record("completion-before-wait", {
      jobId: engineJob,
      completedBeforeEngineReturned: true,
      completedAttempts: 1,
      succeededEvents: 1,
    });

    // 10. Cancellation races completion: exactly one terminal winner.
    const raced = await startRun(live, world, await createTask(world, "Race"));
    const raceJob = await started(raced);
    const [cancel] = await Promise.all([
      postJson(
        world.clients.producer,
        "/v1/runs/" + raced.runId + "/controls",
        { action: "cancel", reason: "Full acceptance race." },
        "full-acceptance-cancel-" + crypto.randomUUID(),
      ),
      release(raceJob),
    ]);
    const cancelText = await cancel.text();
    assert(
      cancel.status >= 200 && cancel.status < 300 || cancel.status === 409,
      "cancel answered " + cancel.status + ": " + cancelText,
    );
    const raceFinal = await terminal(raced);
    assert(
      ["completed", "canceled"].includes(raceFinal.run_status),
      "race ended " + raceFinal.run_status,
    );
    const raceFacts = await until(
      "the raced job settled",
      60_000,
      async () => {
        const facts = await jobFacts(live, world, raceJob);
        return ["completed", "canceled"].includes(facts.jobStatus)
          ? facts
          : undefined;
      },
    );
    assertEquals(raceFacts.attempts, 1);
    // The winner alone is recorded: a canceled job holds no success, and a
    // completed one holds exactly one.
    if (raceFacts.jobStatus === "completed") {
      assertEquals(
        [raceFacts.completedAttempts, raceFacts.succeededEvents],
        [1, 1],
        JSON.stringify(raceFacts),
      );
    } else {
      assertEquals(
        [raceFacts.completedAttempts, raceFacts.succeededEvents],
        [0, 0],
        JSON.stringify(raceFacts),
      );
    }
    assertEquals(
      raceFacts.jobStatus,
      raceFinal.run_status,
      "the job and the run name the same winner",
    );
    record("cancellation-races-completion", {
      runId: raced.runId,
      winner: raceFinal.run_status,
      cancelStatus: cancel.status,
      attempts: raceFacts.attempts,
    });

    // 11. A coordinator turn asks a durable question; one answer resumes the
    // conversation exactly once.
    const harness: Harness = {
      pgDatabase: owner,
      config: { auth: { secret: live.authSecret } },
      app: { fetch: (request: Request) => live.fetch(request) },
    };
    const seed = await seedOrganization(
      harness as never,
      "full-acceptance-questions",
    );
    await seedQuestionTask(harness as never, seed);
    const scriptPath = SCRIPT_DIRECTORY + "/" + seed.conversationId + ".json";
    scriptFiles.push(scriptPath);
    await Deno.writeTextFile(
      scriptPath,
      JSON.stringify({
        effects: [{
          type: "question",
          prompt: "Ship the health endpoint?",
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
        }],
      }),
    );
    assertEquals(
      (await sendMessage(harness as never, seed, "agent_request", "ship it"))
        .status,
      201,
    );
    const turnRows = () =>
      live.psql<Record<string, unknown>>(
        "select status, failure from bakery.conversation_turns where conversation_id = $1",
        [seed.conversationId],
      );
    const open = await until("an open question", 120_000, async () => {
      const response = await questionRequest(
        harness as never,
        seed,
        "/v1/questions?conversationId=" + seed.conversationId +
          "&status=open",
      );
      const items = ((await response.json()) as { items: { id: string }[] })
        .items;
      return items.length === 1 ? items[0] : undefined;
    }).catch(async (error) => {
      throw new Error(
        (error as Error).message + ":" + JSON.stringify(await turnRows()),
      );
    });
    await Deno.writeTextFile(
      scriptPath,
      JSON.stringify({ effects: [{ type: "reply", body: "Shipping it." }] }),
    );
    const answerPath = "/v1/questions/" + open.id + "/answer";
    const answer = (optionId: string) =>
      questionRequest(harness as never, seed, answerPath, {
        method: "PUT",
        body: { answer: { optionId } },
      });
    assertEquals((await answer("yes")).status, 200);
    assertEquals((await answer("yes")).status, 200);
    assertEquals((await answer("no")).status, 409);
    await until("the resumed turn", 120_000, async () => {
      const turns = await live.psql<{ status: string }>(
        "select status from bakery.conversation_turns where conversation_id = $1 order by created_at, id",
        [seed.conversationId],
      );
      return turns.length === 2 &&
          turns.every((turn) => turn.status === "completed")
        ? true
        : undefined;
    });
    const replies = await live.psql<{ body: string }>(
      "select body from bakery.messages where conversation_id = $1 and intent = 'agent_output' order by sequence",
      [seed.conversationId],
    );
    assertEquals(replies, [{ body: "Shipping it." }]);
    record("question-answer-turn", {
      questionId: open.id,
      turns: 2,
      replies: 1,
    });

    // 12. A signed GitHub simulator delivery starts an event automation; the
    // same delivery again changes nothing.
    // The App's repository binds the world's funded agent, so the run the
    // automation starts on it can admit its implement step (case 13).
    const implementAgent = (await live.psql<{ id: string }>(
      "select config->'agentBindings'->>'harness.implement' as id" +
        " from bakery.repository_profiles where organization_id = $1 and id = $2",
      [world.organizationId, world.repositoryProfileId],
    ))[0]!.id;
    const authority: Authority = await seedAuthority(asStack(live), owner, {
      principalId: world.clients.identity.principalId,
      organizationId: world.organizationId,
      cookie: world.clients.producer.cookie ?? "",
    }, { agentVersionId: implementAgent });
    await sealWebhookSecret(asStack(live), authority, WEBHOOK_SECRET);
    const create = async (path: string, body: unknown, status = 201) =>
      await responseJson(
        await postJson(
          world.clients.producer,
          path,
          body,
          "full-acceptance-" + crypto.randomUUID(),
        ),
        status,
        "CREATE " + path,
      );
    const workflow = await create("/v1/workflows", {
      slug: "full-acceptance-" + crypto.randomUUID().slice(0, 8),
      name: "Full acceptance",
      description: "Started by a GitHub issue.",
    });
    const draft = await create("/v1/workflows/" + workflow.id + "/versions", {
      definition: JSON.parse(JSON.stringify(FIXED_CODING_PRESET.spec)),
    });
    const publishResponse = await world.clients.producer.stack.fetch(
      new Request(
        live.origin + "/v1/workflows/" + workflow.id + "/versions/" +
          draft.id + "/publish",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: live.origin,
            cookie: world.clients.producer.cookie ?? "",
            "Bakery-Organization-Id": world.organizationId,
            "Idempotency-Key": "full-acceptance-publish-" + crypto.randomUUID(),
            "If-Match": '"1"',
          },
          body: "{}",
        },
      ),
    );
    const published = await responseJson(publishResponse, 200, "PUBLISH");
    const automation = await create("/v1/automations", {
      slug: "full-acceptance-issue",
      name: "Issue opened",
      description: "Implements an opened issue.",
    });
    const automationVersion = await create(
      "/v1/automations/" + automation.id + "/versions",
      {
        trigger: {
          type: "event",
          provider: "github",
          kind: "issues",
          action: "opened",
          filter: {},
        },
        workflowVersionId: published.id,
        inputs: automationVersionInputs(authority.repository.repositoryId),
        applicationId: authority.repository.applicationId,
        repositoryId: authority.repository.repositoryId,
        budgetLimitUsd: "1",
        brief: "Implement the opened issue.",
        misfirePolicy: "coalesce",
        overlapPolicy: "skip",
      },
    );
    // The version goes live only when the automation is enabled on it.
    const activation = await live.fetch(
      new Request(live.origin + "/v1/automations/" + automation.id, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: live.origin,
          cookie: world.clients.producer.cookie ?? "",
          "Bakery-Organization-Id": world.organizationId,
          "Idempotency-Key": "full-acceptance-activate-" + crypto.randomUUID(),
          "If-Match": '"' + String(automation.version) + '"',
        },
        body: JSON.stringify({
          enabled: true,
          activeVersionId: automationVersion.id,
        }),
      }),
    );
    const activated = await responseJson(activation, 200, "AUTOMATION_ENABLE");
    assertEquals(
      [activated.enabled, activated.activeVersionId],
      [true, automationVersion.id],
    );
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 50, title: "Full acceptance", state: "open" },
      repository: {
        id: Number(authority.repositoryExternalId),
        full_name: authority.repositoryFullName,
      },
      installation: { id: Number(authority.installationExternalId) },
    });
    const deliveryId = crypto.randomUUID();
    const deliver = async () =>
      await live.fetch(
        await deliveryRequest({
          url: live.origin + "/v1/webhooks/github",
          secret: WEBHOOK_SECRET,
          eventName: "issues",
          deliveryId,
          body: payload,
          contentType: "application/json",
        }),
      );
    const accepted = await deliver();
    assertEquals(accepted.status, 202, await accepted.clone().text());
    const firings = () =>
      live.psql<{ id: string; status: string }>(
        "select firing.id, firing.status from bakery.automation_firings firing" +
          " join bakery.automation_versions version on version.id = firing.automation_version_id" +
          " where version.organization_id = $1 and version.automation_id = $2",
        [world.organizationId, automation.id],
      );
    const firing = await until("the automation fired", 120_000, async () => {
      const rows = await firings();
      return rows.length === 1 ? rows[0] : undefined;
    }).catch(async (error) => {
      const routes = await live.psql(
        "select route.purpose, route.status, route.outcome_code from bakery.inbound_event_routes route" +
          " join bakery.inbound_events event on event.id = route.inbound_event_id" +
          " where event.external_delivery_id = $1",
        [deliveryId],
      ).catch((diagnostic) => String(diagnostic));
      throw new Error(
        (error as Error).message + ":" + JSON.stringify(routes),
      );
    });
    const redelivered = await deliver();
    assert(
      redelivered.status === 202 || redelivered.status === 200,
      "redelivery answered " + redelivered.status,
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assertEquals((await firings()).length, 1, "a redelivery fires nothing");
    record("signed-github-event-starts-automation", {
      deliveryId,
      automationId: automation.id,
      firingId: firing.id,
      firingStatus: firing.status,
      firings: 1,
    });

    // 13. The run the firing started completes on the worker and reads back
    // through the run and the automation's firing list.
    const fired = await until("the firing started a run", 120_000, async () => {
      const rows = await live.psql<
        {
          status: string;
          failureCode: string | null;
          runId: string | null;
          taskId: string | null;
        }
      >(
        'select firing.status, firing.failure_code as "failureCode",' +
          ' firing.run_id as "runId", run.task_id as "taskId"' +
          " from bakery.automation_firings firing left join bakery.workflow_runs run" +
          "   on run.organization_id = firing.organization_id and run.id = firing.run_id" +
          " where firing.id = $1",
        [firing.id],
      );
      const row = rows[0];
      if (row?.status === "failed") {
        throw new Error("the firing failed: " + JSON.stringify(row));
      }
      return row?.runId && row.taskId ? row : undefined;
    });
    const firedRun: PresetRun = {
      taskId: fired.taskId!,
      runId: fired.runId!,
      briefStepId: await presetStepId(live, world, fired.runId!, "brief"),
    };
    await release(await started(firedRun));
    assertEquals(await terminal(firedRun), {
      run_status: "completed",
      task_status: "completed",
    });
    const firedRunRead = await get(world, "/v1/runs/" + firedRun.runId);
    assertEquals(firedRunRead.status, "completed");
    const firingPage = await get(
      world,
      "/v1/automations/" + automation.id + "/firings",
    );
    const firingItems = firingPage.items as {
      id: string;
      runId: string | null;
    }[];
    assertEquals(
      firingItems.map((item) => [item.id, item.runId]),
      [[firing.id, firedRun.runId]],
    );
    record("automation-run-completes", {
      automationId: automation.id,
      firingId: firing.id,
      runId: firedRun.runId,
      runStatus: firedRunRead.status,
      ...(await assertRanOnce(live, world, firedRun)),
    });

    // 14. Deterministic checks and an independent review on one candidate,
    // read back through the run's check, review and decision reads. The
    // preset worker (which holds the model capability) stops first; a
    // production worker without it runs the brief and the checks for real,
    // and a substitute worker answers implement and review over the real
    // worker protocol (tests/helpers/review-repair/e2e-world.ts says why).
    await stopPresetWorker(worker);
    worker = undefined;
    const loopAgents = await seedLoopAgents(live, world.clients);
    const loopRepository = await onboardLoopRepository(
      live,
      {
        organizationId: world.organizationId,
        principalId: world.clients.identity.principalId,
      },
      harnessDir + "/loop-operator",
      loopAgents,
    );
    const codexAuth = harnessDir + "/codex-auth";
    await Deno.mkdir(codexAuth, { mode: 0o700 });
    await Deno.writeTextFile(
      codexAuth + "/auth.json",
      '{"note":"placeholder for the e2e proof, not a credential"}\n',
    );
    const checkWorker = await launchPresetWorker(live, {
      ...world,
      applicationId: loopRepository.applicationId,
      repositoryId: loopRepository.repositoryId,
      repositoryProfileId: loopRepository.profileId,
    }, {
      cgroupRoot: lease!.root,
      launcher: "run-worker",
      capabilities: ["git", "shell", "browser"],
      environment: {
        BAKERY_CODEX_HARNESS: "1",
        BAKERY_CODEX_HARNESS_REPOSITORY: loopRepository.commits.repository,
        BAKERY_CODEX_HARNESS_EXECUTABLE: "/usr/bin/true",
        BAKERY_CODEX_HARNESS_TIME_LIMIT_MS: "30000",
        BAKERY_CODEX_AUTH_SOURCE_DIR: codexAuth,
      },
    });
    worker = checkWorker;
    stateDirs.push(checkWorker.stateDir);
    substitute = await SubstituteWorker.register(live, world.clients, [
      "git",
      "shell",
      "web",
      "model",
      "reviewer",
    ]);
    const reviewed = await cleanSeed({
      stack: live,
      organizationId: world.organizationId,
      worker: substitute,
      production: checkWorker,
      clients: world.clients,
      repository: loopRepository,
      progress: (message) => console.error("full-acceptance " + message),
    });
    substitute.stop();
    substitute = undefined;
    record("checks-and-review-read-back", reviewed);

    // 15. The uncertain effect is held: listed for a person, never sent
    // again across the server, worker and engine restarts above.
    const uncertain = await get(world, "/v1/installation/uncertain-actions");
    const kinds = uncertain.kinds as { operation: string; count: number }[];
    assert(
      kinds.some((kind) =>
        kind.operation === "github.comment.create" && kind.count >= 1
      ),
      "the uncertain effect is listed: " + JSON.stringify(uncertain),
    );
    assertEquals(await effectRow(), effectBefore, "the effect never moved");
    record("unknown-effect-held-not-repeated", {
      effectId: uncertainEffect,
      status: "uncertain",
      dispatchGeneration: 1,
      listedTotal: uncertain.total,
    });

    assertFullAcceptanceCases(recorded);
    await stopPresetWorker(worker);
    worker = undefined;
    await cleanupSeededOrganizations({ pgDatabase: owner } as never);
  } catch (error) {
    const text = await stack?.logs("server").catch(() => "");
    if (text) console.log("SERVER_LOG_TAIL\n" + text.slice(-6000));
    throw error;
  } finally {
    substitute?.stop();
    if (worker) await stopPresetWorker(worker).catch(() => undefined);
    for (const path of scriptFiles) {
      await Deno.remove(path).catch(() => undefined);
    }
    if (owner) await closePgDatabase(owner).catch(() => undefined);
    await lease?.release().catch(() => undefined);
    await stack?.down().catch(() => undefined);
    await removePaths([harnessDir, ...stateDirs]);
  }
}

Deno.test({
  name:
    "full headless factory delivery and recovery on one stack, exactly once (#50)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: main,
});
