import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { SecretIdentityToolResultSchema } from "../../packages/contracts/src/secret-identity.ts";
import { workerShutdownReceiptPath } from "../../apps/worker/src/shutdown-receipt.ts";
import { provisionDelegatedCgroupV2 } from "../../scripts/lib/cgroup-v2.ts";
import { admitEngineOwnedSecretIdentityRun } from "../helpers/durable-core/engine-admission.ts";
import { upDurableCoreStack } from "../helpers/durable-core/stack.ts";
import {
  ownedSystemdUnitMainRunning,
  ownedSystemdUnitOutput,
  startOwnedSystemdUnit,
  stopOwnedSystemdUnit,
} from "../helpers/owned-process-group.ts";

const PROVIDER_EVENT = '"event":"CONTROLLED_SECRET_IDENTITY_PROVIDER_IO"';
const WORKER_SHUTDOWN_GRACE_MS = 10_000;
const WORKER_KILL_GRACE_MS = 5_000;

function providerCalls(logs: string): number {
  return logs.split(PROVIDER_EVENT).length - 1;
}

async function stateText(directory: string): Promise<string> {
  const parts: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile) continue;
    parts.push(
      await Deno.readTextFile(`${directory}/${entry.name}`).catch(() => ""),
    );
  }
  return parts.join("\n");
}

async function makePrivateDirectory(): Promise<string> {
  const result = await new Deno.Command("mktemp", {
    args: ["-d", "/tmp/bakery-issue286-worker-XXXXXX"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error("WORKER_STATE_DIRECTORY_CREATE_FAILED");
  return new TextDecoder().decode(result.stdout).trim();
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
    throw new Error("PRIVATE_FIXTURE_WRITE_FAILED");
  }
}

async function removePaths(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await new Deno.Command("rm", {
    args: ["-rf", "--", ...paths],
    stdout: "null",
    stderr: "null",
  }).output();
}

Deno.test({
  name:
    "authenticated repository run reaches fixed identity through real Inngest and production worker",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const root = Deno.cwd();
    const marker = `controlled-provider-credential-${crypto.randomUUID()}`;
    const previous = new Map<string, string | undefined>();
    const fixtureEnvironment = {
      BAKERY_ENV: "development",
      BAKERY_SECRETS_KEY_FILE:
        "/workspace/tests/fixtures/secret-identity-key.bin",
      BAKERY_SECRETS_KEY_ID: "issue286-controlled-key-v1",
      BAKERY_SECRET_IDENTITY_PROVIDER_FIXTURE_FILE:
        "/workspace/tests/fixtures/secret-identity-provider.json",
    } as const;
    let stack: Awaited<ReturnType<typeof upDurableCoreStack>> | undefined;
    let lease:
      | Awaited<ReturnType<typeof provisionDelegatedCgroupV2>>
      | undefined;
    let worker:
      | Awaited<ReturnType<typeof startOwnedSystemdUnit>>
      | undefined;
    let stateDir: string | undefined;
    let tokenPath: string | undefined;
    try {
      for (const [name, value] of Object.entries(fixtureEnvironment)) {
        previous.set(name, Deno.env.get(name));
        Deno.env.set(name, value);
      }
      stack = await upDurableCoreStack("issue286-secret", {
        jobCompletionTimeout: "30s",
      });
      const readiness = await stack.psql<{
        role: string;
        database: string;
        ready: number;
      }>(
        `select current_user as role, current_database() as database, 1 as ready`,
      );
      assertEquals(readiness, [{
        role: "bakery",
        database: "bakery",
        ready: 1,
      }]);
      const readinessRow = readiness[0]!;

      const admission = await admitEngineOwnedSecretIdentityRun(stack, marker);
      assertEquals(admission.observation.invocationCount, 1);
      assertEquals(admission.observation.jobStatus, "queued");
      assertEquals(providerCalls(await stack.logs("server")), 1);

      const workerName = `issue286-worker-${crypto.randomUUID().slice(0, 8)}`;
      const workerLaunchId = crypto.randomUUID();
      const enrollmentResponse = await stack.fetch(
        new Request(`${stack.origin}/v1/worker-enrollments`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: stack.origin,
            cookie: admission.clients.producer.cookie ?? "",
            "Bakery-Organization-Id": admission.clients.identity.organizationId,
            "Idempotency-Key": `issue286-enrollment-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            name: workerName,
            os: "linux",
            architecture: "x64",
            capabilities: ["secret.identity"],
            slots: 1,
          }),
        }),
      );
      const enrollmentText = await enrollmentResponse.text();
      assertEquals(enrollmentResponse.status, 201, enrollmentText);
      const enrollment = JSON.parse(enrollmentText) as {
        enrollmentToken?: unknown;
      };
      assert(typeof enrollment.enrollmentToken === "string");

      lease = await provisionDelegatedCgroupV2("bakery-issue286-full-stack-");
      stateDir = await makePrivateDirectory();
      tokenPath = `${stateDir}/enrollment-token`;
      await writePrivateFile(tokenPath, `${enrollment.enrollmentToken}\n`);
      const ownerUnit = Deno.env.get("BAKERY_E2E_OWNER_UNIT")?.trim();
      if (!ownerUnit) throw new Error("BAKERY_E2E_OWNER_UNIT_REQUIRED");
      worker = await startOwnedSystemdUnit({
        command: "pnpm",
        args: ["--filter", "@bakery/worker", "start"],
        cwd: root,
        environment: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          HOME: Deno.env.get("HOME") ?? "/tmp",
          TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
          BAKERY_ENV: "test",
          BAKERY_SERVER_URL: stack.origin,
          BAKERY_VERSION: "issue286-full-stack-evidence",
          BAKERY_WORKER_CGROUP_ROOT: lease.root,
          BAKERY_WORKER_ENROLLMENT_TOKEN_FILE: tokenPath,
          BAKERY_WORKER_STATE_DIR: stateDir,
          BAKERY_WORKER_NAME: workerName,
          BAKERY_WORKER_CAPABILITIES: "secret.identity",
          BAKERY_WORKER_SLOTS: "1",
          BAKERY_WORKER_HEARTBEAT_MS: "100",
          BAKERY_WORKER_CLAIM_BACKOFF_MS: "100",
          BAKERY_WORKER_CLAIM_BACKOFF_MAX_MS: "500",
          BAKERY_WORKER_REQUEST_TIMEOUT_MS: "5000",
          BAKERY_WORKER_DRAIN_MS: "5000",
          BAKERY_WORKER_LAUNCH_ID: workerLaunchId,
        },
        bindToUnit: ownerUnit,
        workerShutdownReceipt: {
          path: workerShutdownReceiptPath(stateDir),
          launchId: workerLaunchId,
        },
        gracefulTimeoutMs: WORKER_SHUTDOWN_GRACE_MS,
        forceTimeoutMs: WORKER_KILL_GRACE_MS,
      });

      type Observed = {
        requested_by: string;
        worker_host_id: string;
        worker_principal_id: string;
        worker_session_id: string;
        worker_session_generation: string;
        job_status: string;
        attempt_status: string;
        result: unknown;
        prepared_status: string;
        io_attempt: number;
        requester_id: string;
        verified_provider_account_id: string;
        safe_result: unknown;
        job_input: unknown;
      };
      let observed: Observed | undefined;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const rows = await stack.psql<Observed>(
          `select run.requested_by, host.id as worker_host_id,
                  host.principal_id as worker_principal_id,
                  host.worker_session_id as worker_session_id,
                  host.worker_session_generation::text as worker_session_generation,
                  job.status as job_status, attempt.status as attempt_status,
                  attempt.result, operation.status as prepared_status,
                  operation.io_attempt, operation.requester_id,
                  operation.verified_provider_account_id,
                  operation.safe_result, job.input as job_input
             from bakery.jobs job
             join bakery.run_steps step
               on step.organization_id = job.organization_id
              and step.id = job.run_step_id
             join bakery.workflow_runs run
               on run.organization_id = step.organization_id
              and run.id = step.run_id
             join bakery.job_attempts attempt
               on attempt.organization_id = job.organization_id
              and attempt.job_id = job.id
             join bakery.worker_hosts host
               on host.organization_id = attempt.organization_id
              and host.id = attempt.worker_host_id
             join bakery.prepared_operations operation
               on operation.organization_id = attempt.organization_id
              and operation.attempt_id = attempt.id
            where job.organization_id = $1 and job.id = $2
            order by attempt.attempt_no desc limit 1`,
          [admission.clients.identity.organizationId, admission.job.jobId],
        );
        observed = rows[0];
        if (
          observed?.job_status === "completed" &&
          observed.attempt_status === "completed"
        ) break;
        if (!(await ownedSystemdUnitMainRunning(worker))) {
          throw new Error(
            `PRODUCTION_WORKER_EXITED:${
              ownedSystemdUnitOutput(worker).replaceAll(marker, "[REDACTED]")
            }`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert(observed, "FULL_STACK_RESULT_MISSING");
      assertEquals(
        observed.requested_by,
        admission.clients.identity.principalId,
      );
      assertEquals(
        observed.requester_id,
        admission.clients.identity.principalId,
      );
      assertNotEquals(
        observed.worker_principal_id,
        admission.clients.identity.principalId,
      );
      assertEquals(observed.job_status, "completed");
      assertEquals(observed.attempt_status, "completed");
      assertEquals(observed.prepared_status, "completed");
      assertEquals(observed.io_attempt, 1);
      assertEquals(observed.verified_provider_account_id, "12345");
      assertEquals(SecretIdentityToolResultSchema.parse(observed.safe_result), {
        status: "completed",
        accountId: "12345",
        login: "fixture-user",
      });
      const result = observed.result as {
        status?: unknown;
        fault?: unknown;
        cancellation?: unknown;
        result?: unknown;
      };
      assertEquals(result.status, "completed");
      assertEquals(result.fault, undefined);
      assertEquals(result.cancellation, undefined);
      assertEquals(SecretIdentityToolResultSchema.parse(result.result), {
        status: "completed",
        accountId: "12345",
        login: "fixture-user",
      });
      assertEquals(providerCalls(await stack.logs("server")), 2);
      const persistedText = JSON.stringify({
        input: observed.job_input,
        result: observed.result,
        safeResult: observed.safe_result,
      });
      assert(!persistedText.includes(marker));
      assert(!ownedSystemdUnitOutput(worker).includes(marker));
      assert(!(await stateText(stateDir)).includes(marker));

      const evidence = {
        evidence: "FIXED_SECRET_IDENTITY_FULL_STACK_CONFIRMED",
        provider: "controlled fixture; not connected GitHub proof",
        composeProject: stack.project,
        database: readinessRow.database,
        sqlRole: readinessRow.role,
        runId: admission.job.runId,
        jobId: admission.job.jobId,
        inngestFunctionRunId: admission.observation.functionRunId,
        inngestInvocations: admission.observation.invocationCount,
        requesterPersisted: true,
        distinctWorkerPrincipal: true,
        preparedStatus: observed.prepared_status,
        ioAttempts: observed.io_attempt,
        ordinaryWorkerResult: true,
        providerCallsIncludingCreatePreflight: 2,
        actionProviderCalls: 1,
        nonleakage: true,
        productionWorkerCommand: "pnpm --filter @bakery/worker start",
        productionWorkerGracefulShutdownReceipt: true,
      };

      const stopped = await stopOwnedSystemdUnit(worker);
      assertEquals(
        stopped.forced,
        false,
        `PRODUCTION_WORKER_SHUTDOWN_FORCED:${
          ownedSystemdUnitOutput(worker).replaceAll(marker, "[REDACTED]")
        }`,
      );
      assert(
        stopped.status.success,
        ownedSystemdUnitOutput(worker).replaceAll(marker, "[REDACTED]"),
      );
      assertEquals(stopped.workerShutdownReceipt, {
        event: "bakery.worker.shutdown-complete.v1",
        launchId: workerLaunchId,
        signal: "SIGTERM",
        outcome: "drained",
        workerHostId: observed.worker_host_id,
        workerSessionId: observed.worker_session_id,
        workerSessionGeneration: observed.worker_session_generation,
      });
      worker = undefined;

      await lease.release();
      lease = undefined;
      await stack.down();
      stack = undefined;
      await removePaths(
        [stateDir].filter((path): path is string => Boolean(path)),
      );
      stateDir = undefined;
      tokenPath = undefined;
      console.log(JSON.stringify(evidence));
    } finally {
      if (worker) {
        await stopOwnedSystemdUnit(worker).catch(() => undefined);
      }
      await lease?.release().catch(() => undefined);
      await stack?.down().catch(() => undefined);
      await removePaths(
        [stateDir].filter((path): path is string => Boolean(path)),
      );
      for (const name of Object.keys(fixtureEnvironment)) {
        const value = previous.get(name);
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  },
});
