import { assert, assertEquals, assertRejects } from "@std/assert";
import { NATIVE_OUTPUT_DETAIL_PREFIX } from "./helpers/native-output-child-diagnostics.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../packages/persistence/src/postgres.ts";
import { createAuthProvider } from "../../apps/server/src/modules/auth/index.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import { createBrowserSessionMiddleware } from "../../apps/server/src/modules/auth/middleware.ts";
import {
  createExecutionControlApp,
  createExecutionWorkerCleanupApp,
} from "../../apps/server/src/modules/execution/control.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import {
  createNativeExecutor,
  type WorkerExecutor,
} from "../../apps/worker/src/executor.ts";
import { main as workerMain } from "../../apps/worker/src/main.ts";
import type { NativeOutputSink } from "../../apps/worker/src/native-output.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import type { OutputBatch } from "../../apps/worker/src/types.ts";
import { provisionDelegatedCgroupV2 } from "../../scripts/lib/cgroup-v2.ts";
import { upPostgresStack } from "./helpers/stack.ts";
import {
  expireAndSupersedeAttempt,
  registeredWorker,
  seedFundedModelJob,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { supervisorConfig } from "../helpers/worker-execution/recovery-support.ts";
import {
  openRepositoryInspectionHarness,
} from "../helpers/repository-inspection.ts";

const secret = "native-synthetic-secret";
const reportPath = Deno.env.get("BAKERY_NATIVE_OUTPUT_REPORT")?.trim();
if (!reportPath) throw new Error("BAKERY_NATIVE_OUTPUT_REPORT_REQUIRED");

async function sourceIdentity(): Promise<{ head: string; diffSha256: string }> {
  const headResult = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const diffResult = await new Deno.Command("git", {
    args: ["diff", "--binary", "HEAD", "--", ".", ":(exclude).agents/tasks"],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!headResult.success || !diffResult.success) {
    throw new Error("NATIVE_OUTPUT_SOURCE_IDENTITY_FAILED");
  }
  const digest = await crypto.subtle.digest("SHA-256", diffResult.stdout);
  return {
    head: new TextDecoder().decode(headResult.stdout).trim(),
    diffSha256: [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join(""),
  };
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  code: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(code);
}

/**
 * Writes the one line the parent relays into its failure message. Callers pass
 * enumerated state (statuses, counts, ids, error codes) and never raw output.
 */
function reportDetail(detail: Record<string, unknown>): void {
  console.error(`${NATIVE_OUTPUT_DETAIL_PREFIX}${JSON.stringify(detail)}`);
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "NON_ERROR";
  return /^[A-Z0-9_:-]{1,80}$/.test(error.message)
    ? error.message
    : error.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || "ERROR";
}

/**
 * Awaits a worker main run and names its failure. An unlabelled rejection from
 * the run (a fatal supervisor failure) used to surface as an unclassified child
 * exit, so the parent could not tell it from a hang.
 */
async function settleWorker(
  run: Promise<void> | undefined,
  label: string,
): Promise<void> {
  if (!run) return;
  try {
    await run;
  } catch (error) {
    reportDetail({ worker: label, code: safeErrorCode(error) });
    throw new Error(`NATIVE_OUTPUT_WORKER_MAIN_FAILED:${label}`, {
      cause: error,
    });
  }
}

async function withDatabaseEnvironment<T>(
  ownerDatabaseUrl: string,
  appDatabaseUrl: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = {
    DATABASE_URL: Deno.env.get("DATABASE_URL"),
    BAKERY_APP_DATABASE_URL: Deno.env.get("BAKERY_APP_DATABASE_URL"),
    BAKERY_ADMIN_DATABASE_URL: Deno.env.get("BAKERY_ADMIN_DATABASE_URL"),
  };
  Deno.env.set("DATABASE_URL", ownerDatabaseUrl);
  Deno.env.set("BAKERY_APP_DATABASE_URL", appDatabaseUrl);
  Deno.env.delete("BAKERY_ADMIN_DATABASE_URL");
  try {
    return await work();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

async function proveSqlAuthentication(
  ownerDatabaseUrl: string,
  appDatabaseUrl: string,
): Promise<void> {
  const owner = openPgDatabase(ownerDatabaseUrl, 1);
  const app = openPgDatabase(appDatabaseUrl, 1);
  const wrongUrl = new URL(ownerDatabaseUrl);
  wrongUrl.password = `${wrongUrl.password}-wrong`;
  const wrong = openPgDatabase(wrongUrl.toString(), 1);
  try {
    assertEquals(
      (await owner.query<{ value: number }>("select 1 as value")).rows[0]
        ?.value,
      1,
    );
    assertEquals(
      (await app.query<{ value: number }>("select 1 as value")).rows[0]?.value,
      1,
    );
    await assertRejects(() => wrong.query("select 1"));
  } finally {
    await Promise.all([
      closePgDatabase(owner),
      closePgDatabase(app),
      closePgDatabase(wrong),
    ]);
  }
}

async function runWorker(fixture: WorkerFixture, cgroupRoot: string) {
  const worker = await registeredWorker(fixture, {
    name: "native-output-main",
  });
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const stateDir = await Deno.makeTempDir({
    prefix: "bakery-native-output-main-",
  });
  const registrationStore = new RegistrationStore(
    `${stateDir}/registration.json`,
  );
  await registrationStore.saveRegistered(
    worker.credential,
    worker.registration,
  );
  const spool = await EventSpool.open({
    path: `${stateDir}/spool.json`,
    maxRecords: 1_000,
    maxBytes: 1024 * 1024,
  });
  let supervisor: { requestStop(reason?: string): void } | undefined;
  const config = {
    ...supervisorConfig(stateDir),
    serverUrl: fixture.config.publicBaseUrl,
    nativeCgroupRoot: cgroupRoot,
    outputRedactionSecrets: [secret],
    spoolMaxRecords: 1_000,
    spoolMaxBytes: 1024 * 1024,
  };
  let outputResponseDropped = false;
  let closeResponseDropped = false;
  let resultResponseDropped = false;
  const client = new WorkerApiClient({
    baseUrl: fixture.config.publicBaseUrl,
    credential: worker.credential,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = request.method === "POST"
        ? await request.clone().text()
        : "";
      if (path.endsWith("/events") && body.includes('"job.output"')) {
        assertEquals(body.includes(secret), false);
        assertEquals(
          (await Deno.readTextFile(`${stateDir}/spool.json`)).includes(secret),
          false,
        );
      }
      const response = await fixture.app.fetch(request);
      if (
        response.status < 300 && !outputResponseDropped &&
        path.endsWith("/events") && body.includes('"job.output"')
      ) {
        outputResponseDropped = true;
        throw new Error("INJECTED_LOST_OUTPUT_RESPONSE");
      }
      if (
        response.status < 300 && !closeResponseDropped &&
        path.endsWith("/output-bindings/close")
      ) {
        closeResponseDropped = true;
        throw new Error("INJECTED_LOST_CLOSE_RESPONSE");
      }
      if (
        response.status < 300 && !resultResponseDropped &&
        path.endsWith("/result")
      ) {
        resultResponseDropped = true;
        throw new Error("INJECTED_LOST_RESULT_RESPONSE");
      }
      return response;
    },
  });
  const previousFixture = Deno.env.get("BAKERY_WORKER_NATIVE_OUTPUT_FIXTURE");
  Deno.env.set("BAKERY_WORKER_NATIVE_OUTPUT_FIXTURE", "1");
  const run = workerMain({
    config,
    client,
    registrationStore,
    spool,
    onSupervisor: (value) => {
      supervisor = value;
    },
  });
  try {
    const stream = await waitFor(async () => {
      const rows = (await fixture.pgDatabase.query<{
        id: string;
        highwater: string;
        closed: boolean;
        capture: string;
        reason: string | null;
      }>(
        `select id,highwater::text,closed,capture,reason
           from bakery.session_output_streams
          where organization_id=$1 and job_id=$2`,
        [fixture.organizationId, job.jobId],
      )).rows;
      const row = rows[0];
      return row?.closed ? row : null;
    }, "NATIVE_OUTPUT_STREAM_CLOSE_TIMEOUT");
    const batches = (await fixture.pgDatabase.query<{
      sequence: string;
      payload: OutputBatch;
    }>(
      `select sequence::text,payload
         from bakery.session_output_batches
        where organization_id=$1 and session_id=$2 order by sequence`,
      [fixture.organizationId, stream.id],
    )).rows;
    const terminal = await waitFor(async () => {
      const row = (await fixture.pgDatabase.query<{ status: string }>(
        `select status from bakery.job_attempts where organization_id=$1 and job_id=$2`,
        [fixture.organizationId, job.jobId],
      )).rows[0];
      return row && ["completed", "failed", "canceled"].includes(row.status)
        ? row
        : null;
    }, "NATIVE_OUTPUT_RESULT_TIMEOUT");
    const journal = (await fixture.pgDatabase.query<{
      local_seq: string;
      event_type: string;
    }>(
      `select local_seq::text,event_type from bakery.attempt_events
        where organization_id=$1 and attempt_id=(
          select id from bakery.job_attempts where organization_id=$1 and job_id=$2
        ) order by local_seq`,
      [fixture.organizationId, job.jobId],
    )).rows;
    const serialized = JSON.stringify(batches.map((row) => row.payload));
    assert(batches.length >= 2);
    assertEquals(
      batches.map((row) => row.sequence),
      batches.map((_, index) => String(index + 1)),
    );
    assert(serialized.includes("stdout-before"));
    assert(serialized.includes("stdout-after"));
    assert(serialized.includes("stderr-safe"));
    assert(serialized.includes("🔐"));
    assertEquals(serialized.includes(secret), false);
    const stdout = batches.flatMap((row) => row.payload.parts).filter((part) =>
      part.channel === "stdout"
    ).map((part) => part.text).join("");
    assertEquals(stdout.includes(secret), false);
    assertEquals(stdout.includes("<script>"), false);
    assert(stdout.split("[REDACTED]").length >= 3);
    assert(serialized.includes("[REDACTED]"));
    assertEquals(serialized.includes("\\u001b"), false);
    assertEquals(serialized.split("stdout-before").length - 1, 1);
    assertEquals(stream.capture, "complete");
    assertEquals(stream.reason, "clean-end");
    assertEquals(BigInt(stream.highwater), BigInt(batches.length));
    assertEquals(
      journal.map((row) => row.local_seq),
      journal.map((_, index) => String(index + 1)),
    );
    assertEquals(
      journal.filter((row) => row.event_type === "job.output").length,
      batches.length,
    );
    // Each flag is set after its route commits and responds, so the rows read
    // above can be visible first: wait until the fetcher records every drop.
    await waitFor(
      () =>
        Promise.resolve(
          outputResponseDropped && closeResponseDropped &&
            resultResponseDropped
            ? true
            : null,
        ),
      "NATIVE_OUTPUT_INJECTED_DROPS_TIMEOUT",
      10_000,
    );
    assertEquals(outputResponseDropped, true);
    assertEquals(closeResponseDropped, true);
    assertEquals(resultResponseDropped, true);
    await waitFor(async () => {
      const registration = await registrationStore.load();
      return spool.records().length === 0 &&
          spool.pendingOutputCloses().length === 0 &&
          Object.keys(registration?.activeAssignments ?? {}).length === 0
        ? true
        : null;
    }, "NATIVE_OUTPUT_HAPPY_PATH_RELEASE_TIMEOUT");
    return {
      jobId: job.jobId,
      sessionId: stream.id,
      batches: batches.length,
      journalRecords: journal.length,
      terminalStatus: terminal.status,
      capture: stream.capture,
      reason: stream.reason,
      executions: 1,
      immutableOutputReplay: outputResponseDropped,
      immutableCloseReplay: closeResponseDropped,
      immutableResultReplay: resultResponseDropped,
    };
  } finally {
    supervisor?.requestStop("NATIVE_OUTPUT_E2E_COMPLETE");
    await settleWorker(run, "happy-path");
    if (previousFixture === undefined) {
      Deno.env.delete("BAKERY_WORKER_NATIVE_OUTPUT_FIXTURE");
    } else {
      Deno.env.set("BAKERY_WORKER_NATIVE_OUTPUT_FIXTURE", previousFixture);
    }
    await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
  }
}

async function boundaryDirectoryCount(root: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(root)) {
    if (entry.isDirectory && entry.name.startsWith("bakery-native-")) count++;
  }
  return count;
}

function cleanupAppForFixture(fixture: WorkerFixture) {
  return createExecutionWorkerCleanupApp({
    database: fixture.runtimePgDatabase,
    publicBaseUrl: fixture.config.publicBaseUrl,
    secret: fixture.config.auth!.secret,
  });
}

function controlAppForFixture(fixture: WorkerFixture) {
  const authStore = createPostgresAuthPersistence(fixture.runtimePgDatabase);
  const auth = createAuthProvider({
    pgDatabase: fixture.runtimePgDatabase,
    config: fixture.config.auth!,
    persistence: authStore,
  });
  return createExecutionControlApp({
    database: fixture.runtimePgDatabase,
    browserSession: createBrowserSessionMiddleware({
      auth,
      store: authStore,
      publicBaseUrl: fixture.config.publicBaseUrl,
      trustedOrigins: [fixture.config.publicBaseUrl],
      secret: fixture.config.auth!.secret,
    }),
    publicBaseUrl: fixture.config.publicBaseUrl,
    secret: fixture.config.auth!.secret,
  });
}

async function runMainFailureScenario(
  fixture: WorkerFixture,
  cgroupRoot: string,
  mode: "cancellation" | "total-drain",
) {
  const worker = await registeredWorker(fixture, {
    name: `native-output-${mode}`,
  });
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const stateDir = await Deno.makeTempDir({
    prefix: `bakery-native-output-${mode}-`,
  });
  const registrationStore = new RegistrationStore(
    `${stateDir}/registration.json`,
  );
  await registrationStore.saveRegistered(
    worker.credential,
    worker.registration,
  );
  const spool = await EventSpool.open({
    path: `${stateDir}/spool.json`,
    maxRecords: 1_000,
    maxBytes: 1024 * 1024,
  });
  let supervisor: { requestStop(reason?: string): void } | undefined;
  let cleanupCalls = 0;
  let delayedOutputResponse = false;
  let cleanupObservedAt: number | undefined;
  let delayedAt: number | undefined;
  let releasedAt: number | undefined;
  const totalDrainWrite = Promise.withResolvers<void>();
  let totalDrainWriteHeld = false;
  let totalDrainWriteReleased = false;
  const releaseTotalDrainWrite = () => {
    if (totalDrainWriteReleased) return;
    totalDrainWriteReleased = true;
    totalDrainWrite.resolve();
  };
  const cleanupApp = cleanupAppForFixture(fixture);
  const client = new WorkerApiClient({
    baseUrl: fixture.config.publicBaseUrl,
    credential: worker.credential,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = request.method === "POST"
        ? await request.clone().text()
        : "";
      // Count the call as it is made: the cleanup route commits before it
      // responds, so the test can read "complete" before this fetch returns.
      if (path.endsWith("/cleanup")) cleanupCalls++;
      const response = path.endsWith("/cleanup")
        ? await cleanupApp.fetch(request)
        : await fixture.app.fetch(request);
      if (
        mode === "total-drain" && !delayedOutputResponse &&
        response.status < 300 && path.endsWith("/events") &&
        body.includes('"job.output"')
      ) {
        delayedOutputResponse = true;
        delayedAt = performance.now();
        cleanupObservedAt = await waitFor(
          async () =>
            await boundaryDirectoryCount(cgroupRoot) === 0
              ? performance.now()
              : null,
          "NATIVE_OUTPUT_CGROUP_DID_NOT_CLEAN_DURING_DRAIN",
          3_000,
        );
        const remaining = delayedAt + 6_000 - performance.now();
        if (remaining > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        }
        releasedAt = performance.now();
        throw new Error("INJECTED_TOTAL_DRAIN_ACK_LOSS");
      }
      return response;
    },
  });
  const actionScript = mode === "cancellation"
    ? [
      'await Deno.stdout.write(new TextEncoder().encode("cancel-started\\n"));',
      "setInterval(() => undefined, 1_000);",
      "await new Promise(() => undefined);",
    ].join("\n")
    : [
      "const encoder = new TextEncoder();",
      'const output = encoder.encode("total-drain-native-output\\n");',
      "let offset = 0;",
      "while (offset < output.length) {",
      "  const written = await Deno.stdout.write(output.subarray(offset));",
      '  if (written === 0) throw new Error("NATIVE_OUTPUT_WRITE_STALLED");',
      "  offset += written;",
      "}",
    ].join("\n");
  const nativeExecutor = createNativeExecutor({
    cgroupRoot,
    stateDir,
    terminationGraceMs: 1_000,
    actions: [{
      action: "harness.implement",
      executable: Deno.execPath(),
      args: ["eval", actionScript],
    }],
  });
  const executor: WorkerExecutor = mode === "total-drain"
    ? {
      supportedActions: nativeExecutor.supportedActions,
      capturesNativeOutput: nativeExecutor.capturesNativeOutput,
      ...(nativeExecutor.initialize
        ? { initialize: () => nativeExecutor.initialize!() }
        : {}),
      async execute(assignment, signal, output, preparedSkills) {
        if (!output) {
          return await nativeExecutor.execute(
            assignment,
            signal,
            output,
            preparedSkills,
          );
        }
        const releaseOnAbort = () => releaseTotalDrainWrite();
        signal.addEventListener("abort", releaseOnAbort, { once: true });
        const heldOutput: NativeOutputSink = {
          async write(channel, chunk) {
            await output.write(channel, chunk);
            if (!totalDrainWriteHeld) {
              totalDrainWriteHeld = true;
              await totalDrainWrite.promise;
            }
          },
          async sourceLost(channel, reason) {
            try {
              await output.sourceLost(channel, reason);
            } finally {
              releaseTotalDrainWrite();
            }
          },
        };
        try {
          return await nativeExecutor.execute(
            assignment,
            signal,
            heldOutput,
            preparedSkills,
          );
        } catch (error) {
          releaseTotalDrainWrite();
          throw error;
        } finally {
          signal.removeEventListener("abort", releaseOnAbort);
        }
      },
    }
    : nativeExecutor;
  const config = {
    ...supervisorConfig(stateDir),
    serverUrl: fixture.config.publicBaseUrl,
    nativeCgroupRoot: cgroupRoot,
    spoolMaxRecords: 1_000,
    spoolMaxBytes: 1024 * 1024,
    requestTimeoutMs: mode === "total-drain" ? 10_000 : 1_000,
  };
  const run = workerMain({
    config,
    client,
    registrationStore,
    spool,
    executor,
    onSupervisor: (value) => {
      supervisor = value;
    },
  });
  try {
    if (mode === "cancellation") {
      const startedAttempt = await waitFor(async () => {
        const row = (await fixture.pgDatabase.query<{
          attemptId: string;
          count: number;
        }>(
          `select attempt.id as "attemptId", count(batch.*)::integer as count
             from bakery.job_attempts attempt
             join bakery.session_output_streams stream
               on stream.organization_id=attempt.organization_id
              and stream.job_id=attempt.job_id
             join bakery.session_output_batches batch
               on batch.organization_id=stream.organization_id
              and batch.session_id=stream.id
            where attempt.organization_id=$1 and attempt.job_id=$2
            group by attempt.id`,
          [fixture.organizationId, job.jobId],
        )).rows[0];
        return (row?.count ?? 0) > 0 ? row : null;
      }, "NATIVE_OUTPUT_CANCELLATION_START_TIMEOUT");
      const cancellation = await controlAppForFixture(fixture).fetch(
        new Request(
          `${fixture.config.publicBaseUrl}/v1/execution/attempts/${startedAttempt.attemptId}/control`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: fixture.config.publicBaseUrl,
              "Bakery-Organization-Id": fixture.organizationId,
              Cookie: fixture.adminCookie,
              "Idempotency-Key": `native-output-cancel-${job.jobId}`,
            },
            body: JSON.stringify({ action: "cancel" }),
          },
        ),
      );
      assertEquals(cancellation.status, 202);
      const readCancellation = async () =>
        (await fixture.pgDatabase.query<{
          attemptStatus: string;
          jobStatus: string;
          result: {
            cancellation?: {
              processExited?: boolean;
              cleanupStatus?: string;
              terminationStatus?: string;
              executionIdentity?: { cgroupPath?: string };
            };
          } | null;
        }>(
          `select attempt.status as "attemptStatus",
                  job.status as "jobStatus", attempt.result
             from bakery.job_attempts attempt
             join bakery.jobs job
               on job.organization_id=attempt.organization_id
              and job.id=attempt.job_id
            where attempt.organization_id=$1 and attempt.job_id=$2
            order by attempt.created_at desc limit 1`,
          [fixture.organizationId, job.jobId],
        )).rows[0] ?? null;
      let canceled;
      try {
        canceled = await waitFor(
          async () => {
            const row = await readCancellation();
            return row?.result?.cancellation?.cleanupStatus === "complete"
              ? row
              : null;
          },
          "NATIVE_OUTPUT_CANCELLATION_CLEANUP_TIMEOUT",
          10_000,
        );
      } catch (error) {
        const commands = (await fixture.pgDatabase.query<{
          status: string;
          commandType: string;
        }>(
          `select status,command_type as "commandType"
             from bakery.worker_commands
            where organization_id=$1 and attempt_id=$2`,
          [fixture.organizationId, startedAttempt.attemptId],
        )).rows;
        const registration = await registrationStore.load();
        const termination = registration?.terminationEvidence?.[
          startedAttempt.attemptId
        ];
        throw new Error(
          `NATIVE_OUTPUT_CANCELLATION_CLEANUP_TIMEOUT:${
            JSON.stringify({
              cleanupCalls,
              cancellation: await readCancellation(),
              commands,
              active: Object.keys(registration?.activeAssignments ?? {}).length,
              termination: termination
                ? {
                  status: termination.status,
                  cleanupComplete: termination.cleanupComplete,
                  observedExitAt: termination.observedExitAt,
                }
                : null,
              boundaryDirectories: await boundaryDirectoryCount(cgroupRoot),
            })
          }`,
          { cause: error },
        );
      }
      // The parent relays only a failure's phase and class; name the values so
      // a failed assertion says which one differed.
      const settled = {
        attemptStatus: canceled.attemptStatus,
        jobStatus: canceled.jobStatus,
        processExited: canceled.result?.cancellation?.processExited,
        cleanupStatus: canceled.result?.cancellation?.cleanupStatus,
        terminationStatus: canceled.result?.cancellation?.terminationStatus,
        cleanupCalls,
        boundaryDirectories: await boundaryDirectoryCount(cgroupRoot),
      };
      try {
        assertEquals(settled.attemptStatus, "canceled");
        assertEquals(settled.jobStatus, "canceled");
        assertEquals(settled.processExited, true);
        assertEquals(settled.cleanupStatus, "complete");
        assertEquals(settled.terminationStatus, "confirmed");
        assertEquals(settled.cleanupCalls, 1);
        assertEquals(settled.boundaryDirectories, 0);
      } catch (error) {
        reportDetail({ cancellation: settled });
        throw error;
      }
      await waitFor(async () => {
        const registration = await registrationStore.load();
        return Object.keys(registration?.activeAssignments ?? {}).length === 0
          ? registration
          : null;
      }, "NATIVE_OUTPUT_CANCELLATION_RELEASE_TIMEOUT");
      return {
        apiCleanup: true,
        cleanupCalls,
        processExited: true,
        cleanupStatus: "complete",
        terminationStatus: "confirmed",
      };
    }

    const stream = await waitFor(async () => {
      const row = (await fixture.pgDatabase.query<{
        id: string;
        capture: string;
        reason: string | null;
        closed: boolean;
      }>(
        `select id,capture,reason,closed
           from bakery.session_output_streams
          where organization_id=$1 and job_id=$2`,
        [fixture.organizationId, job.jobId],
      )).rows[0];
      return row?.closed ? row : null;
    }, "NATIVE_OUTPUT_TOTAL_DRAIN_CLOSE_TIMEOUT");
    const batches = (await fixture.pgDatabase.query<{ payload: OutputBatch }>(
      `select payload from bakery.session_output_batches
        where organization_id=$1 and session_id=$2 order by sequence`,
      [fixture.organizationId, stream.id],
    )).rows;
    const text = batches.flatMap((row) => row.payload.parts).map((part) =>
      part.text
    ).join("");
    assertEquals(stream.capture, "interrupted");
    assertEquals(stream.reason, "source-lost");
    assert(text.includes("NATIVE_OUTPUT_DRAIN_TIMEOUT"));
    assert(delayedAt !== undefined);
    assert(cleanupObservedAt !== undefined);
    assert(releasedAt !== undefined);
    assert(cleanupObservedAt < releasedAt);
    assert(releasedAt - delayedAt >= 5_900);
    assertEquals(await boundaryDirectoryCount(cgroupRoot), 0);
    return {
      totalDrainForced: true,
      capture: stream.capture,
      reason: stream.reason,
      cleanupBeforeAckRelease: cleanupObservedAt < releasedAt,
      delayedResponseMs: Math.floor(releasedAt - delayedAt),
    };
  } finally {
    releaseTotalDrainWrite();
    supervisor?.requestStop(`NATIVE_OUTPUT_${mode.toUpperCase()}_COMPLETE`);
    await settleWorker(run, mode);
    await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
  }
}

type WorkerFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ReplacementRuntime = {
  stateDir: string;
  registrationStore: RegistrationStore;
  spool: EventSpool;
  stop: () => Promise<void>;
};

async function startReplacementRuntime(
  fixture: WorkerFixture,
  cgroupRoot: string,
  worker: Awaited<ReturnType<typeof registeredWorker>>,
  label: "original" | "successor",
  fetcher: WorkerFetcher,
): Promise<ReplacementRuntime> {
  const stateDir = await Deno.makeTempDir({
    prefix: `bakery-native-output-replacement-${label}-`,
  });
  const registrationStore = new RegistrationStore(
    `${stateDir}/registration.json`,
  );
  await registrationStore.saveRegistered(
    worker.credential,
    worker.registration,
  );
  const spool = await EventSpool.open({
    path: `${stateDir}/spool.json`,
    maxRecords: 1_000,
    maxBytes: 1024 * 1024,
  });
  const actionScript = label === "original"
    ? [
      "const stdout = Deno.stdout;",
      'await stdout.write(new TextEncoder().encode("safe-before carry-"));',
      "await stdout.write(new Uint8Array([255]));",
      "setInterval(() => undefined, 1_000);",
      "await new Promise(() => undefined);",
    ].join("\n")
    : 'await Deno.stdout.write(new TextEncoder().encode("after replacement\\n"));';
  const executor = createNativeExecutor({
    cgroupRoot,
    stateDir,
    terminationGraceMs: 1_000,
    actions: [{
      action: "harness.implement",
      executable: Deno.execPath(),
      args: ["eval", actionScript],
    }],
  });
  const client = new WorkerApiClient({
    baseUrl: fixture.config.publicBaseUrl,
    credential: worker.credential,
    fetcher,
  });
  let supervisor: { requestStop(reason?: string): void } | undefined;
  const run = workerMain({
    config: {
      ...supervisorConfig(stateDir),
      serverUrl: fixture.config.publicBaseUrl,
      nativeCgroupRoot: cgroupRoot,
      outputRedactionSecrets: ["carry-secret"],
      spoolMaxRecords: 1_000,
      spoolMaxBytes: 1024 * 1024,
    },
    client,
    registrationStore,
    spool,
    executor,
    onSupervisor: (value) => {
      supervisor = value;
    },
  });
  await waitFor(
    () => Promise.resolve(supervisor ? true : null),
    `NATIVE_OUTPUT_REPLACEMENT_${label.toUpperCase()}_START_TIMEOUT`,
  );
  let stopped = false;
  return {
    stateDir,
    registrationStore,
    spool,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      supervisor?.requestStop(
        `NATIVE_OUTPUT_REPLACEMENT_${label.toUpperCase()}_COMPLETE`,
      );
      try {
        await settleWorker(run, `replacement-${label}`);
      } finally {
        await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
      }
    },
  };
}

async function proveProducerReplacement(
  fixture: WorkerFixture,
  cgroupRoot: string,
) {
  const job = await seedFundedModelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const originalWorker = await registeredWorker(fixture, {
    name: "native-output-replacement-original",
  });
  let responseDropped = false;
  let replayObserved = false;
  const originalRuntime = await startReplacementRuntime(
    fixture,
    cgroupRoot,
    originalWorker,
    "original",
    async (input, init) => {
      const request = new Request(input, init);
      const body = request.method === "POST"
        ? await request.clone().text()
        : "";
      const response = await fixture.app.fetch(request);
      if (
        response.status < 300 &&
        new URL(request.url).pathname.endsWith("/events") &&
        body.includes('"job.output"')
      ) {
        if (response.headers.get("Idempotent-Replayed") === "true") {
          replayObserved = true;
        }
        if (!responseDropped) {
          responseDropped = true;
          await response.arrayBuffer();
          throw new Error("INJECTED_REPLACEMENT_ACK_LOSS");
        }
      }
      return response;
    },
  );
  let successorRuntime: ReplacementRuntime | undefined;
  try {
    const original = await waitFor(async () => {
      const row = (await fixture.pgDatabase.query<{
        id: string;
        capture: string;
        reason: string | null;
        highwater: string;
        writerGeneration: string;
      }>(
        `select id,capture,reason,highwater::text,
                writer_generation::text as "writerGeneration"
           from bakery.session_output_streams
          where organization_id=$1 and job_id=$2`,
        [fixture.organizationId, job.jobId],
      )).rows[0];
      return row?.capture === "interrupted" && row.reason === "source-lost"
        ? row
        : null;
    }, "NATIVE_OUTPUT_REPLACEMENT_SOURCE_LOSS_TIMEOUT");
    await waitFor(
      () => Promise.resolve(responseDropped && replayObserved ? true : null),
      "NATIVE_OUTPUT_REPLACEMENT_REPLAY_TIMEOUT",
    );
    const originalSpool = await Deno.readTextFile(
      `${originalRuntime.stateDir}/spool.json`,
    );
    assertEquals(originalSpool.includes("carry-"), false);
    assertEquals(originalSpool.includes("safe-before"), false);

    await expireAndSupersedeAttempt(fixture.pgDatabase, job.jobId);
    await originalRuntime.stop();
    assertEquals(await boundaryDirectoryCount(cgroupRoot), 0);

    const successorWorker = await registeredWorker(fixture, {
      name: "native-output-replacement-successor",
    });
    successorRuntime = await startReplacementRuntime(
      fixture,
      cgroupRoot,
      successorWorker,
      "successor",
      async (input, init) => await fixture.app.fetch(new Request(input, init)),
    );
    const closed = await waitFor(async () => {
      const row = (await fixture.pgDatabase.query<{
        id: string;
        capture: string;
        reason: string | null;
        highwater: string;
        writerGeneration: string;
        closed: boolean;
      }>(
        `select id,capture,reason,highwater::text,
                writer_generation::text as "writerGeneration",closed
           from bakery.session_output_streams
          where organization_id=$1 and job_id=$2`,
        [fixture.organizationId, job.jobId],
      )).rows[0];
      return row?.closed ? row : null;
    }, "NATIVE_OUTPUT_REPLACEMENT_CLOSE_TIMEOUT");
    await waitFor(async () => {
      const registration = await successorRuntime!.registrationStore.load();
      return successorRuntime!.spool.records().length === 0 &&
          successorRuntime!.spool.pendingOutputCloses().length === 0 &&
          Object.keys(registration?.activeAssignments ?? {}).length === 0
        ? true
        : null;
    }, "NATIVE_OUTPUT_REPLACEMENT_RELEASE_TIMEOUT");
    const batches = (await fixture.pgDatabase.query<{
      sequence: string;
      payload: OutputBatch;
    }>(
      `select sequence::text,payload
         from bakery.session_output_batches
        where organization_id=$1 and session_id=$2 order by sequence`,
      [fixture.organizationId, original.id],
    )).rows;
    const producers = (await fixture.pgDatabase.query<{
      writerGeneration: string;
      endedReason: string | null;
    }>(
      `select writer_generation::text as "writerGeneration",
              ended_reason as "endedReason"
         from bakery.session_output_producers
        where organization_id=$1 and session_id=$2
        order by writer_generation`,
      [fixture.organizationId, original.id],
    )).rows;
    const lifecycle = (await fixture.pgDatabase.query<{
      attempts: number;
      workers: number;
      fences: number;
      starts: number;
    }>(
      `select count(distinct attempt.id)::integer as attempts,
              count(distinct attempt.worker_host_id)::integer as workers,
              count(distinct attempt.fence)::integer as fences,
              count(*) filter (where event.event_type='job.started')::integer as starts
         from bakery.job_attempts attempt
         left join bakery.attempt_events event
           on event.organization_id=attempt.organization_id
          and event.attempt_id=attempt.id
        where attempt.organization_id=$1 and attempt.job_id=$2`,
      [fixture.organizationId, job.jobId],
    )).rows[0];
    const producersSettled = JSON.stringify(producers) === JSON.stringify([
      { writerGeneration: "1", endedReason: "producer-replaced" },
      { writerGeneration: "2", endedReason: "clean-end" },
    ]);
    // Only a mismatch is reported, so a later phase never relays stale state.
    if (!producersSettled || batches.length !== 2) {
      reportDetail({
        replacement: {
          closed: {
            capture: closed.capture,
            reason: closed.reason,
            generation: closed.writerGeneration,
          },
          batchSequences: batches.map((row) => row.sequence),
          producers,
          lifecycle,
        },
      });
    }
    assertEquals(closed.id, original.id);
    assertEquals(original.writerGeneration, "1");
    assertEquals(closed.writerGeneration, "2");
    assertEquals(closed.highwater, "2");
    assertEquals(closed.capture, "interrupted");
    assertEquals(closed.reason, "source-lost");
    assertEquals(batches.map((row) => row.sequence), ["1", "2"]);
    assertEquals(batches[0]?.payload.writerGeneration, "1");
    assertEquals(batches[0]?.payload.capture, "interrupted");
    assertEquals(batches[0]?.payload.reason, "source-lost");
    assertEquals(
      batches[0]?.payload.parts.some((part) => part.channel === "status"),
      true,
    );
    assertEquals(JSON.stringify(batches).includes("carry-"), false);
    assertEquals(JSON.stringify(batches).includes("safe-before"), false);
    assertEquals(batches[1]?.payload.writerGeneration, "2");
    assertEquals(batches[1]?.payload.parts[0]?.text, "after replacement\n");
    assertEquals(producers, [
      { writerGeneration: "1", endedReason: "producer-replaced" },
      { writerGeneration: "2", endedReason: "clean-end" },
    ]);
    assertEquals(lifecycle, { attempts: 2, workers: 2, fences: 2, starts: 2 });
    return {
      producerReplacement: true,
      ackLossReplay: responseDropped && replayObserved,
      carryDiscarded: true,
      workerMainExecutions: lifecycle.starts,
      authorityTransitions: lifecycle.fences,
      workerHosts: lifecycle.workers,
      sessionId: closed.id,
      writerGeneration: closed.writerGeneration,
      highwater: closed.highwater,
    };
  } finally {
    await successorRuntime?.stop();
    await originalRuntime.stop();
  }
}

async function proveInspectionByteIdentity(
  fixture: WorkerFixture,
  cgroupRoot: string,
) {
  const harness = await openRepositoryInspectionHarness(
    { authDb: fixture.pgDatabase, appPg: fixture.runtimePgDatabase },
    {
      organizationId: fixture.organizationId,
      principalId: fixture.principalId,
    },
  );
  const stateDir = await Deno.makeTempDir({
    prefix: "bakery-native-output-inspection-",
  });
  let supervisor: { requestStop(reason?: string): void } | undefined;
  let run: Promise<void> | undefined;
  try {
    const repository = await harness.createRepository(true);
    const onboarding = await harness.onboard(repository.repositoryId);
    const registrationStore = new RegistrationStore(
      `${stateDir}/registration.json`,
    );
    const registeredHost = (await fixture.pgDatabase.query<{
      principalId: string;
    }>(
      `select principal_id as "principalId"
         from bakery.worker_hosts
        where organization_id=$1 and id=$2`,
      [fixture.organizationId, harness.registration.workerHostId],
    )).rows[0];
    assert(registeredHost);
    await registrationStore.saveRegistered(
      harness.credential,
      {
        ...harness.registration,
        principalId: registeredHost.principalId,
        registrationGeneration: 1,
        status: "registered",
      },
    );
    const spool = await EventSpool.open({
      path: `${stateDir}/spool.json`,
      maxRecords: 1_000,
      maxBytes: 1024 * 1024,
    });
    let resultRequest: Record<string, unknown> | undefined;
    const client = new WorkerApiClient({
      baseUrl: "http://inspection.test",
      credential: harness.credential,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/result")) {
          resultRequest = JSON.parse(await request.clone().text()) as Record<
            string,
            unknown
          >;
        }
        return await harness.app.fetch(request);
      },
    });
    const config = {
      ...supervisorConfig(stateDir),
      serverUrl: "http://inspection.test",
      nativeCgroupRoot: cgroupRoot,
      capabilities: ["git"],
      spoolMaxRecords: 1_000,
      spoolMaxBytes: 1024 * 1024,
    };
    // Names what is stuck when the stream never closes: server rows plus the
    // worker's local spool and registration. Enumerated fields only.
    const reportInspectionState = async (error: unknown) => {
      const rows = async (sql: string) =>
        (await fixture.pgDatabase.query(sql, [
          fixture.organizationId,
          onboarding.jobId,
        ])).rows;
      const registration = await registrationStore.load();
      reportDetail({
        timeout: safeErrorCode(error),
        streams: await rows(
          `select closed,capture,reason,writer_generation::text as generation,
                  highwater::text as highwater
             from bakery.session_output_streams
            where organization_id=$1 and job_id=$2`,
        ),
        attempts: await rows(
          `select status,result is not null as has_result
             from bakery.job_attempts
            where organization_id=$1 and job_id=$2`,
        ),
        jobs: await rows(
          `select status from bakery.jobs where organization_id=$1 and id=$2`,
        ),
        producers: await rows(
          `select writer_generation::text as generation,ended_reason
             from bakery.session_output_producers
            where organization_id=$1 and session_id in (
              select id from bakery.session_output_streams
               where organization_id=$1 and job_id=$2)`,
        ),
        spoolRecords: spool.records().length,
        pendingCloses: spool.pendingOutputCloses().length,
        activeAssignments: Object.keys(registration?.activeAssignments ?? {})
          .length,
        resultPosted: resultRequest !== undefined,
      });
    };
    let parserInputBytes: Uint8Array | undefined;
    run = workerMain({
      config,
      client,
      registrationStore,
      spool,
      nativeExecutorTestHooks: {
        afterInspectionParserInput: (bytes) => {
          parserInputBytes = bytes.slice();
        },
      },
      onSupervisor: (value) => {
        supervisor = value;
      },
    });
    let stream;
    try {
      stream = await waitFor(async () => {
        const row = (await fixture.pgDatabase.query<{
          id: string;
          closed: boolean;
          capture: string;
          reason: string | null;
        }>(
          `select id,closed,capture,reason
             from bakery.session_output_streams
            where organization_id=$1 and job_id=$2`,
          [fixture.organizationId, onboarding.jobId],
        )).rows[0];
        return row?.closed ? row : null;
      }, "NATIVE_OUTPUT_INSPECTION_CLOSE_TIMEOUT");
    } catch (error) {
      await reportInspectionState(error);
      throw error;
    }
    await waitFor(
      () =>
        resultRequest ? Promise.resolve(resultRequest) : Promise.resolve(null),
      "NATIVE_OUTPUT_INSPECTION_RESULT_TIMEOUT",
    );
    const batches = (await fixture.pgDatabase.query<{ payload: OutputBatch }>(
      `select payload from bakery.session_output_batches
        where organization_id=$1 and session_id=$2 order by sequence`,
      [fixture.organizationId, stream.id],
    )).rows;
    assertEquals(
      resultRequest?.status,
      "completed",
      `NATIVE_OUTPUT_INSPECTION_RESULT:${
        JSON.stringify({
          status: resultRequest?.status,
          fault: resultRequest?.fault,
        })
      }`,
    );
    const parts = batches.flatMap((row) => row.payload.parts);
    const reportBytes = parts.filter((part) => part.channel === "stdout").map(
      (part) => part.text,
    ).join("");
    assert(
      reportBytes.length > 0,
      `NATIVE_OUTPUT_INSPECTION_BYTES_MISSING:${
        JSON.stringify({
          capture: stream.capture,
          reason: stream.reason,
          batches: batches.length,
          channels: parts.map((part) => part.channel),
        })
      }`,
    );
    assert(parserInputBytes);
    const persistedReportBytes = new TextEncoder().encode(reportBytes);
    assertEquals(persistedReportBytes, parserInputBytes);
    const parsedReport = JSON.parse(new TextDecoder().decode(parserInputBytes));
    assertEquals(parsedReport, resultRequest?.result);
    const sha256 = async (bytes: Uint8Array) =>
      [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes.slice().buffer),
        ),
      ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const parserInputDigest = await sha256(parserInputBytes);
    const persistedReportDigest = await sha256(persistedReportBytes);
    assertEquals(persistedReportDigest, parserInputDigest);
    assertEquals(stream.capture, "complete");
    assertEquals(stream.reason, "clean-end");
    assertEquals(await boundaryDirectoryCount(cgroupRoot), 0);
    return {
      inspectionByteIdentity: persistedReportDigest === parserInputDigest,
      reportBytes: persistedReportBytes.byteLength,
      parserInputSha256: parserInputDigest,
      persistedReportSha256: persistedReportDigest,
      capture: stream.capture,
      reason: stream.reason,
    };
  } finally {
    supervisor?.requestStop("NATIVE_OUTPUT_INSPECTION_COMPLETE");
    await settleWorker(run, "inspection");
    await harness.close();
    await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
  }
}

const source = await sourceIdentity();
const stack = await upPostgresStack("native-output");
const cgroup = await provisionDelegatedCgroupV2("bakery-native-output-e2e-");
let workerResult: Awaited<ReturnType<typeof runWorker>> | undefined;
let cancellationResult:
  | Awaited<ReturnType<typeof runMainFailureScenario>>
  | undefined;
let totalDrainResult:
  | Awaited<ReturnType<typeof runMainFailureScenario>>
  | undefined;
let replacementResult:
  | Awaited<ReturnType<typeof proveProducerReplacement>>
  | undefined;
let inspectionResult:
  | Awaited<ReturnType<typeof proveInspectionByteIdentity>>
  | undefined;
let cleanupPassed = false;
try {
  await proveSqlAuthentication(stack.ownerDatabaseUrl, stack.appDatabaseUrl);
  await withDatabaseEnvironment(
    stack.ownerDatabaseUrl,
    stack.appDatabaseUrl,
    async () => {
      console.log("native-output-e2e: happy-path");
      workerResult = await withWorkerFixture((fixture) =>
        runWorker(fixture, cgroup.root)
      );
      console.log("native-output-e2e: cancellation");
      cancellationResult = await withWorkerFixture((fixture) =>
        runMainFailureScenario(fixture, cgroup.root, "cancellation")
      );
      console.log("native-output-e2e: inspection");
      inspectionResult = await withWorkerFixture((fixture) =>
        proveInspectionByteIdentity(fixture, cgroup.root)
      );
      console.log("native-output-e2e: producer-replacement");
      replacementResult = await withWorkerFixture((fixture) =>
        proveProducerReplacement(fixture, cgroup.root)
      );
      console.log("native-output-e2e: total-drain");
      totalDrainResult = await withWorkerFixture((fixture) =>
        runMainFailureScenario(fixture, cgroup.root, "total-drain")
      );
    },
  );
} finally {
  await cgroup.release();
  await stack.down();
  cleanupPassed = true;
}
assert(workerResult);
assert(cancellationResult);
assert(inspectionResult);
assert(replacementResult);
assert(totalDrainResult);
await Deno.writeTextFile(
  reportPath,
  `${
    JSON.stringify(
      {
        candidateSha: source.head,
        sourceDiffSha256: source.diffSha256,
        project: stack.project,
        postgresPort: stack.postgresPort,
        tcpReadiness: true,
        ownerSqlAuth: true,
        appSqlAuth: true,
        badSqlAuthRejected: true,
        workerMain: true,
        nativeExecutor: true,
        productionRoutes: true,
        postgresPersistence: true,
        cleanupPassed,
        ...workerResult,
        cancellation: cancellationResult,
        inspection: inspectionResult,
        replacement: replacementResult,
        totalDrain: totalDrainResult,
      },
      null,
      2,
    )
  }\n`,
  { mode: 0o600 },
);
