import { assert, assertEquals } from "@std/assert";
import {
  createDurableArtifactClients,
  type DurableWorkerEvent,
  fetchArtifact,
  fetchRunSteps,
  fetchTaskSync,
  postWorkerEvents,
  postWorkerResult,
  publishArtifact,
} from "../e2e/helpers/durable-core/artifact-client.ts";
import {
  checkoutRevision,
  parseDurableCoreBoundaryProof,
  writeDurableCoreBoundaryProof,
} from "../e2e/helpers/durable-core/evidence.ts";
import type {
  DurableCoreAuditRef,
  DurableCoreJournalObservation,
  DurableCoreSpoolObservation,
} from "../helpers/durable-core/evidence.ts";
import {
  admitEngineOwnedRun,
  assertEngineOwnerLeaseLive,
  assertEngineRecoveryStateOpen,
  type EngineAdmission,
  type EngineRecoveryTriggerObservation,
  publishWorkflowReconciliation,
  readDatabaseClock,
  waitForEngineInvocation,
  waitForEngineOwnerLeaseExpiry,
  waitForPostRestartEngineEvent,
  waitForWorkflowRecoveryInvocation,
} from "../helpers/durable-core/engine-admission.ts";
import {
  readWorkerActionMarker,
  type WorkerActionMarker,
} from "../helpers/durable-core/worker-action-marker.ts";
import { collectDurableCoreEvidence } from "../e2e/helpers/durable-core/evidence.ts";
import {
  assertDurableCoreAuditLinks,
  createDurableCoreCase,
} from "../helpers/durable-core/evidence.ts";
import { waitForPersistedCheckpoint } from "../helpers/durable-core/checkpoint.ts";
import {
  type DurableCoreStack,
  upDurableCoreStack,
} from "../helpers/durable-core/stack.ts";
import {
  type JobSeed,
  workerCredential,
  workerFixtureCapabilities,
} from "../helpers/worker-execution.ts";

function now(): string {
  return new Date().toISOString();
}

function timestampEpochMicros(value: string, label: string): bigint {
  const match = value.match(
    /^(.+?)(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/,
  );
  assert(match !== null, `${label} must include an explicit timezone offset`);
  const zone = match[3] === "Z" || match[3].includes(":")
    ? match[3]
    : `${match[3]}:00`;
  const milliseconds = Date.parse(`${match[1]}${zone}`);
  assert(Number.isSafeInteger(milliseconds), `${label} is not parseable`);
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return BigInt(milliseconds) * 1000n + BigInt(fraction);
}

function assertTimestampEpochMicros(
  value: string,
  micros: string,
  label: string,
): void {
  assertEquals(timestampEpochMicros(value, label), BigInt(micros), label);
}

const ENGINE_NATURAL_SUCCESSOR_WAIT_TIMEOUT_MS = 4_000;
const ENGINE_NATURAL_SUCCESSOR_RECHECK_TIMEOUT_MS = 1_000;

function event(
  localSeq: string,
  eventType: string,
  payload: unknown,
): DurableWorkerEvent {
  return {
    eventId: crypto.randomUUID(),
    localSeq,
    eventType,
    payload,
  };
}

type ProblemEvidence = {
  readonly raw: string;
  readonly code: string;
  readonly requestId: string;
  readonly traceId: string;
};

async function problemEvidence(response: Response): Promise<ProblemEvidence> {
  const raw = await response.text();
  const body = JSON.parse(raw) as Record<string, unknown>;
  assertEquals(typeof body.code, "string", raw);
  assertEquals(typeof body.requestId, "string", raw);
  assertEquals(typeof body.traceId, "string", raw);
  return {
    raw,
    code: body.code as string,
    requestId: body.requestId as string,
    traceId: body.traceId as string,
  };
}

type DurableClients = EngineAdmission["clients"];

type RealWorkerScenario = {
  readonly admission: EngineAdmission;
  readonly clients: DurableClients;
  readonly job: JobSeed;
  readonly enrollmentToken: string;
  readonly workerCredential: string;
  readonly workerName: string;
  readonly serverUrl: string;
  readonly stateDir: string;
  readonly markerPath: string;
  readonly releasePath: string;
  readonly replacementReleasePath: string;
  readonly effectKey: string;
};

type AttemptObservation = {
  readonly id: string;
  readonly fence: string;
  readonly status: string;
  readonly workerSessionId: string | null;
  readonly workerSessionGeneration: string;
  readonly lastEventSeq: string;
};

type TerminalObservation = {
  readonly attemptId: string;
  readonly eventId: string;
  readonly jobId: string;
  readonly taskId: string;
  readonly taskStatus: "completed";
  readonly runId: string;
  readonly runStatus: "completed";
  readonly runStepId: string;
  readonly runStepStatus: "completed";
  readonly terminalTaskCount: 1;
  readonly terminalRunCount: 1;
  readonly terminalStepCount: 1;
  readonly acceptedCount: number;
  readonly effectCount: number;
  readonly artifactCount: number;
  readonly versionCount: number;
  readonly terminalAttemptCount: number;
  readonly acceptedAuditCount: number;
  readonly completionReadAudit: DurableCoreAuditRef;
  readonly verifiedSha256: string;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

async function createRealWorkerScenario(
  stack: DurableCoreStack,
): Promise<RealWorkerScenario> {
  const admission = await admitEngineOwnedRun(stack);
  const { clients, job } = admission;
  const workerName = `durable-core-child-${crypto.randomUUID()}`;
  const enrollmentHeaders = new Headers({
    "content-type": "application/json",
    origin: stack.origin,
    cookie: clients.producer.cookie ?? "",
    "Bakery-Organization-Id": clients.identity.organizationId,
    "Idempotency-Key": `durable-core-enrollment-${crypto.randomUUID()}`,
  });
  const enrollmentResponse = await stack.fetch(
    new Request(`${stack.origin}/v1/worker-enrollments`, {
      method: "POST",
      headers: enrollmentHeaders,
      body: JSON.stringify({
        name: workerName,
        os: "linux",
        architecture: "x64",
        capabilities: workerFixtureCapabilities,
        slots: 1,
      }),
    }),
  );
  const enrollmentBody = await enrollmentResponse.clone().text();
  assertEquals(enrollmentResponse.status, 201, enrollmentBody);
  const enrollment = JSON.parse(enrollmentBody) as {
    enrollmentToken: string;
  };
  if (typeof enrollment.enrollmentToken !== "string") {
    throw new Error("DURABLE_CORE_WORKER_ENROLLMENT_TOKEN_MISSING");
  }
  const stateDir = await Deno.makeTempDir({
    prefix: "bakery-durable-core-worker-",
  });
  return {
    admission,
    clients,
    job,
    enrollmentToken: enrollment.enrollmentToken,
    workerCredential: workerCredential(),
    workerName,
    serverUrl: stack.origin,
    stateDir,
    markerPath: `${stateDir}/action-marker.json`,
    releasePath: `${stateDir}/release`,
    replacementReleasePath: `${stateDir}/replacement-release`,
    effectKey: `durable-core-${job.jobId}`,
  };
}

function spawnRealWorker(scenario: RealWorkerScenario): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      // The worker imports bare workspace specifiers mapped only by the root config.
      "--config=deno.json",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--allow-net",
      "--allow-sys=uid",
      "tests/helpers/durable-core/worker-action.child.ts",
    ],
    cwd: Deno.cwd(),
    env: {
      ...Deno.env.toObject(),
      BAKERY_DURABLE_CORE_SERVER_URL: scenario.serverUrl,
      BAKERY_DURABLE_CORE_RUN_STEP_ID: scenario.job.runStepId,
      BAKERY_DURABLE_CORE_SESSION_ID: scenario.job.sessionId,
      BAKERY_DURABLE_CORE_ENROLLMENT_TOKEN: scenario.enrollmentToken,
      BAKERY_DURABLE_CORE_WORKER_CREDENTIAL: scenario.workerCredential,
      BAKERY_DURABLE_CORE_WORKER_NAME: scenario.workerName,
      BAKERY_DURABLE_CORE_STATE_DIR: scenario.stateDir,
      BAKERY_DURABLE_CORE_MARKER_PATH: scenario.markerPath,
      BAKERY_DURABLE_CORE_RELEASE_PATH: scenario.releasePath,
      BAKERY_DURABLE_CORE_REPLACEMENT_RELEASE_PATH:
        scenario.replacementReleasePath,
    },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
}

async function stopRealWorker(
  child: Deno.ChildProcess,
  signal: Deno.Signal,
): Promise<void> {
  try {
    child.kill(signal);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await child.status;
}

async function waitForWorkerMarker(
  path: string,
): Promise<WorkerActionMarker> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const marker = await readWorkerActionMarker(path);
    if (marker?.phase === "checkpoint-acked") return marker;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`DURABLE_CORE_WORKER_MARKER_TIMEOUT:${path}`);
}
async function waitForReplacementMarker(
  path: string,
  previousAttemptId: string,
): Promise<WorkerActionMarker> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const marker = await readWorkerActionMarker(path);
    if (
      marker?.phase === "checkpoint-acked" &&
      marker.latest.attemptId !== previousAttemptId
    ) return marker;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`DURABLE_CORE_WORKER_REPLACEMENT_MARKER_TIMEOUT:${path}`);
}

async function writeWorkerRelease(path: string): Promise<void> {
  await Deno.writeTextFile(path, "release\n", { createNew: true, mode: 0o600 });
}

async function readSpoolObservation(
  path: string,
  checkpoint: { readonly attemptId: string; readonly eventId: string },
): Promise<DurableCoreSpoolObservation> {
  const absent = (): DurableCoreSpoolObservation => ({
    kind: "spool",
    spoolState: "absent",
    checkpointAckedLocalSeq: null,
    nextLocalSeq: null,
    version: 1,
    recordCount: 0,
    records: [],
  });
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error("DURABLE_CORE_SPOOL_FILE_MISSING");
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DURABLE_CORE_SPOOL_STATE_INVALID");
  }
  const state = parsed as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  const requiredKeys = ["ackedLocalSeq", "nextLocalSeq", "records", "version"];
  // The worker also persists terminal reservations and bounded native-output state.
  const allowedKeys = new Set([
    ...requiredKeys,
    "outputCloses",
    "outputStatusUsage",
    "terminalReservations",
  ]);
  if (
    !requiredKeys.every((key) => keys.includes(key)) ||
    keys.some((key) => !allowedKeys.has(key))
  ) {
    throw new Error("DURABLE_CORE_SPOOL_STATE_INVALID");
  }
  if (state.version !== 1 || !Array.isArray(state.records)) {
    throw new Error("DURABLE_CORE_SPOOL_STATE_INVALID");
  }
  const decimal = /^(0|[1-9][0-9]*)$/;
  const decimalMap = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("DURABLE_CORE_SPOOL_STATE_INVALID");
    }
    const result = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(result)) {
      if (
        key.trim() === "" ||
        typeof entry !== "string" ||
        !decimal.test(entry)
      ) {
        throw new Error("DURABLE_CORE_SPOOL_STATE_INVALID");
      }
    }
    return result as Record<string, string>;
  };
  const ackedLocalSeq = decimalMap(state.ackedLocalSeq);
  const nextLocalSeq = decimalMap(state.nextLocalSeq);
  const observationRecord = (
    value: unknown,
  ): DurableCoreSpoolObservation["records"][number] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("DURABLE_CORE_SPOOL_RECORD_INVALID");
    }
    const record = value as Record<string, unknown>;
    const fields = [
      "attemptId",
      "fence",
      "localSeq",
      "eventId",
      "kind",
      "type",
    ] as const;
    if (
      fields.some((field) =>
        typeof record[field] !== "string" ||
        ((field === "fence" || field === "localSeq") &&
          !decimal.test(record[field] as string))
      )
    ) {
      throw new Error("DURABLE_CORE_SPOOL_RECORD_INVALID");
    }
    return {
      attemptId: record.attemptId as string,
      fence: record.fence as string,
      localSeq: record.localSeq as string,
      eventId: record.eventId as string,
      kind: record.kind as string,
      type: record.type as string,
    };
  };
  const allRecords = state.records.map(observationRecord);
  const boundedRecords = allRecords.slice(0, 8);
  const ackedValue = ackedLocalSeq[checkpoint.attemptId];
  const nextValue = nextLocalSeq[checkpoint.attemptId];
  if ((ackedValue === undefined) !== (nextValue === undefined)) {
    throw new Error("DURABLE_CORE_SPOOL_STATE_INVALID");
  }
  const absentForAttempt = ackedValue === undefined;
  if (absentForAttempt) {
    if (allRecords.length !== 0) {
      throw new Error("DURABLE_CORE_SPOOL_ABSENT_RECORDS_REMAIN");
    }
    return absent();
  }
  return {
    kind: "spool",
    spoolState: "present",
    checkpointAttemptId: checkpoint.attemptId,
    checkpointEventId: checkpoint.eventId,
    checkpointLocalSeq: "3",
    checkpointAckedLocalSeq: ackedValue,
    nextLocalSeq: nextValue,
    version: state.version,
    recordCount: allRecords.length,
    records: boundedRecords,
  };
}

/**
 * The terminal rows commit on the server before the worker receives the result
 * acknowledgement, and only then does it release the attempt and drop its spool
 * entries. Reading the spool right after the terminal rows therefore races the
 * worker; the authoritative condition is the spool no longer holding the attempt.
 */
async function waitForSpoolAbsent(
  path: string,
  checkpoint: { readonly attemptId: string; readonly eventId: string },
): Promise<DurableCoreSpoolObservation> {
  const deadline = Date.now() + 15_000;
  let latest = await readSpoolObservation(path, checkpoint);
  while (latest.spoolState !== "absent" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    latest = await readSpoolObservation(path, checkpoint);
  }
  return latest;
}

async function waitForPersistedSpoolObservation(
  path: string,
  checkpoint: { readonly attemptId: string; readonly eventId: string },
): Promise<DurableCoreSpoolObservation> {
  const deadline = Date.now() + 10_000;
  let latest: DurableCoreSpoolObservation | undefined;
  while (Date.now() < deadline) {
    latest = await readSpoolObservation(path, checkpoint);
    if (
      latest.spoolState === "present" &&
      latest.checkpointAckedLocalSeq === "3"
    ) {
      return latest;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `DURABLE_CORE_SPOOL_ACK_TIMEOUT:${JSON.stringify(latest)}`,
  );
}

function journalObservation(
  attemptId: string,
  eventId: string,
  journal: { readonly nextLocalSeq: string; readonly ackedLocalSeq: string },
): DurableCoreJournalObservation {
  return {
    kind: "journal",
    checkpointAttemptId: attemptId,
    checkpointEventId: eventId,
    checkpointLocalSeq: "3",
    checkpointAckedLocalSeq: journal.ackedLocalSeq,
    nextLocalSeq: journal.nextLocalSeq,
  };
}

async function readAttemptObservations(
  stack: DurableCoreStack,
  jobId: string,
): Promise<AttemptObservation[]> {
  return await stack.psql<AttemptObservation>(
    `select id,
            fence::text as fence,
            status,
            worker_session_id as "workerSessionId",
            worker_session_generation::text as "workerSessionGeneration",
            last_event_seq::text as "lastEventSeq"
       from bakery.job_attempts
      where job_id = $1
      order by created_at, id`,
    [jobId],
  );
}

async function waitForReplacementAttempt(
  stack: DurableCoreStack,
  jobId: string,
  firstAttemptId: string,
): Promise<{
  readonly attempts: AttemptObservation[];
  readonly oldAttemptStatuses: readonly string[];
}> {
  const deadline = Date.now() + 60_000;
  const oldAttemptStatuses = new Set<string>();
  let attempts: AttemptObservation[] = [];
  while (Date.now() < deadline) {
    attempts = await readAttemptObservations(stack, jobId);
    const old = attempts.find((candidate) => candidate.id === firstAttemptId);
    if (old) oldAttemptStatuses.add(old.status);
    const replacement = attempts.find((candidate) =>
      candidate.id !== firstAttemptId
    );
    if (
      replacement &&
      old &&
      (old.status === "quarantined" || old.status === "lost") &&
      BigInt(replacement.fence) > BigInt(old.fence)
    ) {
      return {
        attempts,
        oldAttemptStatuses: [...oldAttemptStatuses],
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `DURABLE_CORE_WORKER_REPLACEMENT_TIMEOUT:${
      JSON.stringify({
        attempts,
        oldAttemptStatuses: [...oldAttemptStatuses],
      })
    }`,
  );
}

async function observeTerminal(
  stack: DurableCoreStack,
  scenario: RealWorkerScenario,
  marker: WorkerActionMarker,
): Promise<TerminalObservation> {
  const terminalRows = await stack.psql<{
    attemptId: string;
    eventId: string;
  }>(
    `select attempt.id as "attemptId", event.event_id as "eventId"
       from bakery.attempt_events event
       join bakery.job_attempts attempt on attempt.id = event.attempt_id
      where attempt.job_id = $1
        and event.event_type = 'job.succeeded'`,
    [scenario.job.jobId],
  );
  const lifecycleRows = await stack.psql<{
    jobId: string;
    taskId: string;
    taskStatus: "completed";
    runId: string;
    runStatus: "completed";
    runStepId: string;
    runStepStatus: "completed";
    terminalTaskCount: 1;
    terminalRunCount: 1;
    terminalStepCount: 1;
  }>(
    `select job.id as "jobId",
            task.id as "taskId",
            task.status as "taskStatus",
            run.id as "runId",
            run.status as "runStatus",
            step.id as "runStepId",
            step.status as "runStepStatus",
            (select count(*)::int
               from bakery.tasks candidate
              where candidate.organization_id = task.organization_id
                and candidate.id = task.id
                and candidate.status = 'completed') as "terminalTaskCount",
            (select count(*)::int
               from bakery.workflow_runs candidate
              where candidate.organization_id = run.organization_id
                and candidate.id = run.id
                and candidate.status = 'completed') as "terminalRunCount",
            (select count(*)::int
               from bakery.run_steps candidate
              where candidate.organization_id = step.organization_id
                and candidate.id = step.id
                and candidate.status = 'completed') as "terminalStepCount"
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
       join bakery.tasks task
         on task.organization_id = run.organization_id
        and task.id = run.task_id
      where job.organization_id = $1 and job.id = $2
      limit 1`,
    [scenario.clients.identity.organizationId, scenario.job.jobId],
  );
  const facts = await stack.psql<{
    acceptedCount: number;
    effectCount: number;
    artifactCount: number;
    versionCount: number;
    terminalAttemptCount: number;
    acceptedAuditCount: number;
  }>(
    `select
       (select count(*)::int
          from bakery.attempt_events event
          join bakery.job_attempts attempt on attempt.id = event.attempt_id
         where attempt.job_id = $1
           and event.event_type = 'job.succeeded') as "acceptedCount",
       (select count(*)::int
          from bakery.artifact_publication_replays replay
          join bakery.job_attempts attempt on attempt.id = replay.attempt_id
         where attempt.job_id = $1
           and replay.idempotency_key = $2) as "effectCount",
       (select count(*)::int
          from bakery.artifacts
         where organization_id = $3
           and task_id = $4
           and artifact_type = 'patch'
           and name = 'durable-core-terminal-artifact') as "artifactCount",
       (select count(*)::int
          from bakery.artifact_versions version
          join bakery.artifacts artifact
            on artifact.organization_id = version.organization_id
           and artifact.id = version.artifact_id
         where artifact.organization_id = $3
           and artifact.id = $5
           and artifact.task_id = $4
           and artifact.artifact_type = 'patch'
           and artifact.name = 'durable-core-terminal-artifact') as "versionCount",
       (select count(*)::int
          from bakery.job_attempts
         where job_id = $1
           and status in ('completed', 'failed', 'canceled')) as
         "terminalAttemptCount",
       (select count(*)::int
          from bakery.audit_events
         where organization_id = $3
           and operation = 'workers.result'
           and outcome = 'succeeded'
           and resource_id in (
             select id::text from bakery.job_attempts where job_id = $1
           )) as "acceptedAuditCount"`,
    [
      scenario.job.jobId,
      scenario.effectKey,
      scenario.clients.identity.organizationId,
      scenario.job.taskId,
      marker.artifact.artifactId,
    ],
  );
  const terminal = terminalRows[0];
  const lifecycle = lifecycleRows[0];
  const fact = facts[0];
  if (!terminal || !lifecycle || !fact) {
    throw new Error("DURABLE_CORE_TERMINAL_ROWS_MISSING");
  }
  assertEquals(lifecycle.jobId, scenario.job.jobId);
  assertEquals(lifecycle.taskStatus, "completed");
  assertEquals(lifecycle.runStatus, "completed");
  assertEquals(lifecycle.runStepStatus, "completed");
  assertEquals(
    {
      terminalTaskCount: lifecycle.terminalTaskCount,
      terminalRunCount: lifecycle.terminalRunCount,
      terminalStepCount: lifecycle.terminalStepCount,
    },
    {
      terminalTaskCount: 1,
      terminalRunCount: 1,
      terminalStepCount: 1,
    },
  );
  assertEquals(fact, {
    acceptedCount: 1,
    effectCount: 1,
    artifactCount: 1,
    versionCount: 1,
    terminalAttemptCount: 1,
    acceptedAuditCount: 1,
  });
  const completionReadRequestId = crypto.randomUUID();
  const completionReadTraceId = crypto.randomUUID().replaceAll("-", "");
  const stepsResponse = await fetchRunSteps(
    scenario.clients.consumer,
    scenario.job.runId,
    undefined,
    {
      requestId: completionReadRequestId,
      traceId: completionReadTraceId,
    },
  );
  assertEquals(stepsResponse.status, 200, await stepsResponse.clone().text());
  const steps = await stepsResponse.json() as {
    items: Array<{ status: string; output: unknown }>;
  };
  assertEquals(steps.items.length, 1);
  assertEquals(steps.items[0]?.status, "completed");
  const completionReadAuditRows = await stack.psql<DurableCoreAuditRef>(
    `select id,
            organization_id as "organizationId",
            resource_type as "resourceType",
            resource_id as "resourceId",
            operation,
            outcome,
            request_id as "requestId",
            trace_id as "traceId"
       from bakery.audit_events
      where organization_id = $1
        and request_id = $2
        and trace_id = $3
        and operation = 'runs.steps.list'
        and resource_type = 'workflow_run'
        and resource_id = $4
        and outcome = 'allowed'`,
    [
      scenario.clients.identity.organizationId,
      completionReadRequestId,
      completionReadTraceId,
      scenario.job.runId,
    ],
  );
  assertEquals(completionReadAuditRows.length, 1);
  const completionReadAudit = completionReadAuditRows[0]!;
  assertEquals(completionReadAudit.requestId, completionReadRequestId);
  assertEquals(completionReadAudit.traceId, completionReadTraceId);
  const artifactResponse = await fetchArtifact(
    scenario.clients.consumer,
    marker.artifact,
  );
  assertEquals(
    artifactResponse.status,
    200,
    await artifactResponse.clone().text(),
  );
  const artifactBytes = new Uint8Array(await artifactResponse.arrayBuffer());
  const verifiedSha256 = await sha256Hex(artifactBytes);
  assertEquals(verifiedSha256, marker.bytesSha256);
  return {
    attemptId: terminal.attemptId,
    eventId: terminal.eventId,
    ...lifecycle,
    ...fact,
    completionReadAudit,
    verifiedSha256,
  };
}

async function waitForTerminalRows(
  stack: DurableCoreStack,
  jobId: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = await stack.psql<{ count: number }>(
      `select count(*)::int as count
         from bakery.attempt_events event
         join bakery.job_attempts attempt on attempt.id = event.attempt_id
        where attempt.job_id = $1
          and event.event_type = 'job.succeeded'`,
      [jobId],
    );
    if (rows[0]?.count === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const [attempts, ...logs] = await Promise.all([
    readAttemptObservations(stack, jobId),
    ...(["server", "inngest", "worker"] as const).map(async (service) =>
      `${service}:\n${await stack.logs(service)}`
    ),
  ]);
  throw new Error(
    `DURABLE_CORE_TERMINAL_TIMEOUT:${jobId}\n${JSON.stringify(attempts)}\n${
      logs.join("\n")
    }`,
  );
}

async function removeScenarioState(
  scenario: RealWorkerScenario,
): Promise<void> {
  await Deno.remove(scenario.stateDir, { recursive: true }).catch(() =>
    undefined
  );
}
type ReadOnlyLifecycleSnapshot = {
  readonly auditRows: number;
  readonly taskVersion: number;
  readonly taskStatus: string;
  readonly runVersion: number;
  readonly runStatus: string;
  readonly stepVersion: number;
  readonly stepStatus: string;
  readonly jobVersion: number;
  readonly jobStatus: string;
};

async function readOnlyLifecycleSnapshot(
  stack: DurableCoreStack,
  organizationId: string,
  job: Pick<JobSeed, "taskId" | "runId" | "runStepId" | "jobId">,
  attemptId: string,
): Promise<ReadOnlyLifecycleSnapshot> {
  const rows = await stack.psql<ReadOnlyLifecycleSnapshot>(
    `select
       (select count(*)::int
          from bakery.audit_events
         where organization_id = $1
           and (
             (resource_type = 'workflow_run' and resource_id = ($3::uuid)::text)
             or
             (resource_type = 'job_attempt' and resource_id = $6::text)
           )) as "auditRows",
       (select task.version::int
          from bakery.tasks task
         where task.organization_id = $1 and task.id = $2)
         as "taskVersion",
       (select task.status
          from bakery.tasks task
         where task.organization_id = $1 and task.id = $2)
         as "taskStatus",
       (select run.version::int
          from bakery.workflow_runs run
         where run.organization_id = $1 and run.id = $3)
         as "runVersion",
       (select run.status
          from bakery.workflow_runs run
         where run.organization_id = $1 and run.id = $3)
         as "runStatus",
       (select step.version::int
          from bakery.run_steps step
         where step.organization_id = $1 and step.id = $4)
         as "stepVersion",
       (select step.status
          from bakery.run_steps step
         where step.organization_id = $1 and step.id = $4)
         as "stepStatus",
       (select job.version::int
          from bakery.jobs job
         where job.organization_id = $1 and job.id = $5)
         as "jobVersion",
       (select job.status
          from bakery.jobs job
         where job.organization_id = $1 and job.id = $5)
         as "jobStatus"`,
    [
      organizationId,
      job.taskId,
      job.runId,
      job.runStepId,
      job.jobId,
      attemptId,
    ],
  );
  const snapshot = rows[0];
  if (!snapshot) throw new Error("DURABLE_CORE_READ_ONLY_SNAPSHOT_MISSING");
  return snapshot;
}
Deno.test(
  "durable core recovers a worker-produced checkpoint across a real worker process kill",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upDurableCoreStack("durable-core-worker-boundary");
    let scenario: RealWorkerScenario | undefined;
    let firstChild: Deno.ChildProcess | undefined;
    let secondChild: Deno.ChildProcess | undefined;
    let firstStopped = false;
    let secondStopped = false;
    try {
      scenario = await createRealWorkerScenario(stack);
      firstChild = spawnRealWorker(scenario);
      const firstMarker = await waitForWorkerMarker(scenario.markerPath);
      const firstCheckpoint = await waitForPersistedCheckpoint({
        stack,
        attemptId: firstMarker.first.attemptId,
        effectKey: scenario.effectKey,
        artifact: firstMarker.artifact,
        expectedLocalSeq: "3",
      });
      assertEquals(firstCheckpoint.localSeq, "3");
      assertEquals(firstCheckpoint.ackedLocalSeq, "3");
      assertEquals(firstCheckpoint.jobId, scenario.job.jobId);
      assertEquals(firstCheckpoint.runId, scenario.job.runId);
      assertEquals(firstCheckpoint.runStepId, scenario.job.runStepId);
      const spoolBefore = await waitForPersistedSpoolObservation(
        `${scenario.stateDir}/spool.json`,
        {
          attemptId: firstCheckpoint.attemptId,
          eventId: firstCheckpoint.eventId,
        },
      );
      const beforeProcessId = firstChild.pid;

      await stopRealWorker(firstChild, "SIGKILL");
      firstStopped = true;
      await writeWorkerRelease(scenario.releasePath);
      secondChild = spawnRealWorker(scenario);
      const replacement = await waitForReplacementAttempt(
        stack,
        scenario.job.jobId,
        firstMarker.first.attemptId,
      );
      assert(
        replacement.oldAttemptStatuses.some((status) =>
          status === "quarantined" || status === "lost"
        ),
        `old attempt was not quarantined or reclaimed: ${
          replacement.oldAttemptStatuses.join(",")
        }`,
      );
      const secondMarker = await waitForReplacementMarker(
        scenario.markerPath,
        firstMarker.first.attemptId,
      );
      assertEquals(secondMarker.artifact, firstMarker.artifact);
      const secondCheckpoint = await waitForPersistedCheckpoint({
        stack,
        attemptId: secondMarker.latest.attemptId,
        effectKey: scenario.effectKey,
        artifact: secondMarker.artifact,
        expectedLocalSeq: "3",
      });
      assertEquals(secondCheckpoint.localSeq, "3");
      assertEquals(secondCheckpoint.ackedLocalSeq, "3");
      assertEquals(secondMarker.first.attemptId, firstMarker.first.attemptId);
      assert(secondMarker.latest.attemptId !== firstMarker.first.attemptId);
      assertEquals(secondCheckpoint.jobId, scenario.job.jobId);
      assertEquals(secondCheckpoint.runId, scenario.job.runId);
      assertEquals(secondCheckpoint.runStepId, scenario.job.runStepId);
      await writeWorkerRelease(scenario.replacementReleasePath);
      const terminal = await (async () => {
        await waitForTerminalRows(stack, scenario!.job.jobId);
        return await observeTerminal(stack, scenario!, secondMarker);
      })();
      const spoolAfter = await waitForSpoolAbsent(
        `${scenario.stateDir}/spool.json`,
        {
          attemptId: secondCheckpoint.attemptId,
          eventId: secondCheckpoint.eventId,
        },
      );
      assertEquals(terminal.acceptedCount, 1);
      assertEquals(terminal.effectCount, 1);
      assertEquals(terminal.artifactCount, 1);
      assertEquals(terminal.versionCount, 1);
      assertEquals(terminal.terminalAttemptCount, 1);
      assertEquals(spoolAfter.spoolState, "absent");
      assertEquals(spoolAfter.checkpointAckedLocalSeq, null);
      assertEquals(spoolAfter.nextLocalSeq, null);
      assert(terminal.attemptId !== firstCheckpoint.attemptId);
      assertEquals(terminal.attemptId, secondMarker.latest.attemptId);
      const proof = {
        kind: "worker",
        revision: await checkoutRevision(),
        configuration: { project: stack.project, ports: stack.ports },
        runId: scenario.job.runId,
        effectKey: scenario.effectKey,
        checkpoint: {
          attemptId: firstCheckpoint.attemptId,
          jobId: firstCheckpoint.jobId,
          runId: firstCheckpoint.runId,
          runStepId: firstCheckpoint.runStepId,
          fence: firstMarker.first.fence,
          workerSessionId: firstMarker.first.workerSessionId,
          workerSessionGeneration: firstMarker.first.workerSessionGeneration,
          eventId: firstCheckpoint.eventId,
          localSeq: "3",
          ackedLocalSeq: firstCheckpoint.ackedLocalSeq as "3",
          artifactRef: firstMarker.artifact,
        },
        replacementAttempt: {
          attemptId: secondMarker.latest.attemptId,
          fence: secondMarker.latest.fence,
          workerSessionId: secondMarker.latest.workerSessionId,
          workerSessionGeneration: secondMarker.latest.workerSessionGeneration,
          checkpointEventId: secondCheckpoint.eventId,
          checkpointLocalSeq: secondCheckpoint.localSeq as "3",
        },
        secondCheckpoint: {
          attemptId: secondCheckpoint.attemptId,
          eventId: secondCheckpoint.eventId,
          localSeq: "3",
          ackedLocalSeq: secondCheckpoint.ackedLocalSeq as "3",
          artifactRef: secondMarker.artifact,
        },
        restart: {
          service: "worker",
          beforeProcessId: String(beforeProcessId),
          afterProcessId: String(secondChild.pid),
        },
        terminal: {
          jobId: terminal.jobId,
          attemptId: terminal.attemptId,
          eventId: terminal.eventId,
          taskId: terminal.taskId,
          taskStatus: terminal.taskStatus,
          runId: terminal.runId,
          runStatus: terminal.runStatus,
          runStepId: terminal.runStepId,
          runStepStatus: terminal.runStepStatus,
          terminalTaskCount: terminal.terminalTaskCount,
          terminalRunCount: terminal.terminalRunCount,
          terminalStepCount: terminal.terminalStepCount,
          acceptedCount: 1,
          effectCount: 1,
          artifactCount: 1,
        },
        artifact: {
          ref: firstMarker.artifact,
          sha256: firstMarker.bytesSha256,
          verifiedSha256: terminal.verifiedSha256,
        },
        observations: {
          journalBefore: journalObservation(
            firstMarker.first.attemptId,
            firstCheckpoint.eventId,
            firstMarker.first.journalBefore,
          ),
          journalAfter: journalObservation(
            secondMarker.latest.attemptId,
            secondCheckpoint.eventId,
            secondMarker.latest.journalAfter,
          ),
          spoolBefore,
          spoolAfter,
        },
      } as const;
      await writeDurableCoreBoundaryProof(proof);
    } finally {
      if (secondChild && !secondStopped) {
        await stopRealWorker(secondChild, "SIGTERM");
        secondStopped = true;
      }
      if (firstChild && !firstStopped) {
        await stopRealWorker(firstChild, "SIGKILL");
        firstStopped = true;
      }
      await stack.down();
      if (scenario) await removeScenarioState(scenario);
    }
  },
);

Deno.test(
  "durable core recovers a worker-produced checkpoint across an actual Inngest restart",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upDurableCoreStack("durable-core-engine-boundary", {
      jobCompletionTimeout: "10s",
    });
    let scenario: RealWorkerScenario | undefined;
    let child: Deno.ChildProcess | undefined;
    let childStopped = false;
    try {
      scenario = await createRealWorkerScenario(stack);
      child = spawnRealWorker(scenario);
      const marker = await waitForWorkerMarker(scenario.markerPath);
      const checkpoint = await waitForPersistedCheckpoint({
        stack,
        attemptId: marker.first.attemptId,
        effectKey: scenario.effectKey,
        artifact: marker.artifact,
        expectedLocalSeq: "3",
      });
      assertEquals(checkpoint.localSeq, "3");
      assertEquals(checkpoint.ackedLocalSeq, "3");
      assertEquals(checkpoint.jobId, scenario.job.jobId);
      assertEquals(checkpoint.runId, scenario.job.runId);
      assertEquals(checkpoint.runStepId, scenario.job.runStepId);
      const spoolBefore = await waitForPersistedSpoolObservation(
        `${scenario.stateDir}/spool.json`,
        { attemptId: checkpoint.attemptId, eventId: checkpoint.eventId },
      );
      if (
        spoolBefore.spoolState !== "present" ||
        spoolBefore.checkpointAckedLocalSeq === null ||
        spoolBefore.nextLocalSeq === null
      ) {
        throw new Error("DURABLE_CORE_PRE_RESTART_SPOOL_NOT_PERSISTED");
      }
      const journalBefore = journalObservation(
        checkpoint.attemptId,
        checkpoint.eventId,
        {
          ackedLocalSeq: spoolBefore.checkpointAckedLocalSeq,
          nextLocalSeq: spoolBefore.nextLocalSeq,
        },
      );
      const engineBeforeProcessId = await stack.processId("inngest");
      const engineBeforeObservation = await waitForEngineInvocation(
        stack,
        scenario.job.runId,
        scenario.clients.identity.organizationId,
      );
      // Inngest timestamps are PostgreSQL timestamps; do not mix them with
      // the host clock when recording the observation boundary.
      const engineBeforeObservedAt = await readDatabaseClock(stack);
      const engineBefore = {
        processId: String(engineBeforeProcessId),
        runId: scenario.job.runId,
        organizationId: scenario.clients.identity.organizationId,
        outboxStatus: engineBeforeObservation.outboxStatus,
        engineEventId: engineBeforeObservation.engineEventId,
        functionDefinitionId: engineBeforeObservation.functionDefinitionId,
        functionEventInternalId:
          engineBeforeObservation.functionEventInternalId,
        functionRunId: engineBeforeObservation.functionRunId,
        functionEventId: engineBeforeObservation.functionEventId,
        runStatus: engineBeforeObservation.runStatus,
        engineOwnerPresent: true as const,
        engineOwnerGeneration: engineBeforeObservation.engineOwnerGeneration,
        jobStatus: engineBeforeObservation.jobStatus,
        checkpointAttemptId: checkpoint.attemptId,
        checkpointEventId: checkpoint.eventId,
        checkpointLocalSeq: checkpoint.localSeq as "3",
        checkpointAckedLocalSeq: checkpoint.ackedLocalSeq as "3",
        observedAt: engineBeforeObservedAt,
      };
      assertEquals(
        engineBefore.engineEventId,
        scenario.admission.observation.engineEventId,
      );
      assertEquals(
        engineBefore.functionEventId,
        scenario.admission.observation.functionEventId,
      );
      assertEquals(
        engineBeforeObservation.deliveryKey,
        scenario.admission.observation.deliveryKey,
      );
      assertEquals(
        engineBefore.functionEventId,
        engineBeforeObservation.deliveryKey,
      );
      const engineBeforeOwner = await assertEngineOwnerLeaseLive(
        stack,
        scenario.job.runId,
        scenario.clients.identity.organizationId,
        engineBeforeObservation,
      );
      await stack.stopService("inngest");
      const stopBoundary = await readDatabaseClock(stack);
      const expiryBoundary = (
        await waitForEngineOwnerLeaseExpiry(
          stack,
          scenario.job.runId,
          scenario.clients.identity.organizationId,
          engineBeforeOwner,
        )
      ).expiredAt;
      const restartBoundary = await readDatabaseClock(stack);
      await stack.startService("inngest");
      const orderRows = await stack.psql<{ ordered: boolean }>(
        `select $1::timestamptz < $2::timestamptz
                and $2::timestamptz < $3::timestamptz as ordered`,
        [stopBoundary, expiryBoundary, restartBoundary],
      );
      if (orderRows[0]?.ordered !== true) {
        throw new Error(
          `DURABLE_CORE_ENGINE_RESTART_ORDER_INVALID:${
            JSON.stringify({
              stopBoundary,
              expiryBoundary,
              restartBoundary,
              ordered: orderRows[0]?.ordered ?? null,
            })
          }`,
        );
      }
      let recoveryEventId: string | undefined;
      let recoveryTrigger: EngineRecoveryTriggerObservation | undefined;
      let naturalEvent = await waitForPostRestartEngineEvent(
        stack,
        scenario.job.runId,
        restartBoundary,
        ENGINE_NATURAL_SUCCESSOR_WAIT_TIMEOUT_MS,
      );
      if (naturalEvent === undefined) {
        naturalEvent = await waitForPostRestartEngineEvent(
          stack,
          scenario.job.runId,
          restartBoundary,
          ENGINE_NATURAL_SUCCESSOR_RECHECK_TIMEOUT_MS,
        );
      }
      if (naturalEvent === undefined) {
        await assertEngineRecoveryStateOpen(
          stack,
          scenario.job.runId,
          scenario.clients.identity.organizationId,
        );
        recoveryEventId = await publishWorkflowReconciliation(
          stack,
          scenario.job.runId,
        );
        recoveryTrigger = await waitForWorkflowRecoveryInvocation(
          stack,
          scenario.job.runId,
          recoveryEventId,
        );
      }
      const engineAfterObservation = await waitForEngineInvocation(
        stack,
        scenario.job.runId,
        scenario.clients.identity.organizationId,
        {
          previous: engineBeforeObservation,
          restartBoundary,
          recoveryTrigger,
        },
      );
      const recoverySource = engineAfterObservation.recoverySource;
      if (recoverySource === undefined) {
        throw new Error("DURABLE_CORE_ENGINE_RECOVERY_SOURCE_MISSING");
      }
      if (
        recoverySource !== "cron" &&
        recoverySource !== "handoff" &&
        recoverySource !== "reconciliation"
      ) {
        throw new Error("DURABLE_CORE_ENGINE_RECOVERY_SOURCE_INVALID");
      }
      // The pre-POST poll is only a potential natural recovery observation;
      // the admitted owner and its durable source are proven after the race.
      const naturalRecoveryProven = recoverySource === "cron" ||
        recoverySource === "handoff";
      const recoveryMode = naturalRecoveryProven ? "natural" : "reconciliation";
      const cronRecoveryProven = recoverySource === "cron";
      if (naturalEvent !== undefined) {
        assertEquals(naturalEvent.runId, scenario.job.runId);
      }
      assertEquals(
        engineAfterObservation.engineOwnerToken,
        engineAfterObservation.functionEventId,
      );
      await assertEngineOwnerLeaseLive(
        stack,
        scenario.job.runId,
        scenario.clients.identity.organizationId,
        engineAfterObservation,
      );
      const engineAfterProcessId = await stack.processId("inngest");
      // This clock read follows the final engine SELECT, so it is causally
      // after the recovery run's PostgreSQL start timestamp.
      const engineAfterObservedAt = await readDatabaseClock(stack);
      if (
        recoveryMode === "reconciliation" &&
        (recoveryEventId === undefined || recoveryTrigger === undefined)
      ) {
        throw new Error("DURABLE_CORE_RECONCILIATION_EVIDENCE_MISSING");
      }
      const engineAfterBase = {
        processId: String(engineAfterProcessId),
        runId: scenario.job.runId,
        organizationId: scenario.clients.identity.organizationId,
        outboxStatus: engineAfterObservation.outboxStatus,
        engineEventId: engineBefore.engineEventId,
        functionDefinitionId: engineAfterObservation.functionDefinitionId,
        functionEventInternalId: engineAfterObservation.functionEventInternalId,
        functionRunId: engineAfterObservation.functionRunId,
        functionEventId: engineAfterObservation.functionEventId,
        runStatus: engineAfterObservation.runStatus,
        engineOwnerPresent: true as const,
        engineOwnerGeneration: engineAfterObservation.engineOwnerGeneration,
        jobStatus: engineAfterObservation.jobStatus,
        checkpointAttemptId: checkpoint.attemptId,
        checkpointEventId: checkpoint.eventId,
        checkpointLocalSeq: checkpoint.localSeq as "3",
        checkpointAckedLocalSeq: checkpoint.ackedLocalSeq as "3",
        observedAt: engineAfterObservedAt,
        recoveryFunctionDefinitionId:
          engineAfterObservation.functionDefinitionId,
        recoveryFunctionRunId: engineAfterObservation.functionRunId,
        recoveryFunctionEventId: engineAfterObservation.functionEventId,
        recoveryInvocationCount: engineAfterObservation.invocationCount -
          engineBeforeObservation.invocationCount,
        recoveryFunctionRunStartedAt:
          engineAfterObservation.functionRunStartedAt,
      };
      const engineAfter = recoveryMode === "reconciliation"
        ? {
          ...engineAfterBase,
          recoveryMode: "reconciliation" as const,
          recoveryEventId: recoveryEventId as string,
          recoveryEventInternalId: recoveryTrigger!.recoveryEventInternalId,
          recoveryTriggerFunctionId: recoveryTrigger!.recoveryFunctionId,
          recoveryTriggerFunctionDefinitionId:
            recoveryTrigger!.recoveryFunctionDefinitionId,
          recoveryTriggerFunctionRunId: recoveryTrigger!.recoveryFunctionRunId,
          recoveryTriggerFunctionEventId:
            recoveryTrigger!.recoveryFunctionEventId,
        }
        : {
          ...engineAfterBase,
          recoveryMode: "natural" as const,
          ...(cronRecoveryProven
            ? { recoveryTriggerSource: "cron" as const }
            : {}),
        };
      assert(engineAfter.processId !== engineBefore.processId);
      assertEquals(
        engineAfter.engineEventId,
        engineBefore.engineEventId,
      );
      assert(
        engineAfter.functionEventId !== engineBeforeObservation.deliveryKey,
      );
      assert(
        engineAfter.functionEventId !== engineBefore.functionEventId,
      );
      assert(
        BigInt(engineAfterObservation.engineOwnerGeneration) >
          BigInt(engineBeforeOwner.engineOwnerGeneration),
      );
      assert(
        engineAfterObservation.engineOwnerToken !==
          engineBeforeOwner.engineOwnerToken,
      );
      assert(
        engineAfterObservation.functionRunId !==
          engineBeforeObservation.functionRunId,
      );
      assert(
        engineAfterObservation.functionEventId !==
          engineBeforeObservation.functionEventId,
      );
      assert(
        engineAfterObservation.invocationCount >
          engineBeforeObservation.invocationCount,
      );
      assertEquals(
        engineAfter.functionDefinitionId,
        engineBefore.functionDefinitionId,
      );
      assertEquals(
        engineAfter.recoveryFunctionDefinitionId,
        engineAfter.functionDefinitionId,
      );
      assertEquals(
        engineAfter.recoveryFunctionRunId,
        engineAfter.functionRunId,
      );
      assertEquals(
        engineAfter.recoveryFunctionEventId,
        engineAfter.functionEventId,
      );
      assertEquals(
        engineAfter.recoveryFunctionRunStartedAt,
        engineAfterObservation.functionRunStartedAt,
      );
      assertEquals(
        engineAfter.recoveryInvocationCount,
        engineAfterObservation.invocationCount -
          engineBeforeObservation.invocationCount,
      );
      assert(
        engineAfter.recoveryInvocationCount > 0,
      );
      assertTimestampEpochMicros(
        engineBeforeObservation.functionRunStartedAt,
        engineBeforeObservation.functionRunStartedAtMicros,
        "engineBefore.functionRunStartedAt",
      );
      assertTimestampEpochMicros(
        engineBeforeObservation.functionEventReceivedAt,
        engineBeforeObservation.functionEventReceivedAtMicros,
        "engineBefore.functionEventReceivedAt",
      );
      assertTimestampEpochMicros(
        engineAfterObservation.functionRunStartedAt,
        engineAfterObservation.functionRunStartedAtMicros,
        "engineAfter.functionRunStartedAt",
      );
      assertTimestampEpochMicros(
        engineAfterObservation.functionEventReceivedAt,
        engineAfterObservation.functionEventReceivedAtMicros,
        "engineAfter.functionEventReceivedAt",
      );
      const restartChronology = await stack.psql<{
        beforeObservedBeforeRestart: boolean;
        runStartedAfterRestart: boolean;
        eventReceivedAfterRestart: boolean;
        runStartedBeforeAfterObserved: boolean;
      }>(
        `select $1::timestamptz < $2::timestamptz
                  as "beforeObservedBeforeRestart",
                $2::timestamptz < $3::timestamptz
                  as "runStartedAfterRestart",
                $2::timestamptz < $4::timestamptz
                  as "eventReceivedAfterRestart",
                $3::timestamptz <= $5::timestamptz
                  as "runStartedBeforeAfterObserved"`,
        [
          engineBeforeObservedAt,
          restartBoundary,
          engineAfterObservation.functionRunStartedAt,
          engineAfterObservation.functionEventReceivedAt,
          engineAfterObservedAt,
        ],
      );
      assertEquals(restartChronology, [{
        beforeObservedBeforeRestart: true,
        runStartedAfterRestart: true,
        eventReceivedAfterRestart: true,
        runStartedBeforeAfterObserved: true,
      }]);
      assert(
        BigInt(engineAfterObservation.functionEventReceivedAtMicros) >
          BigInt(engineBeforeObservation.functionEventReceivedAtMicros),
      );
      assert(
        Date.parse(engineAfterObservation.functionRunStartedAt) >
          Date.parse(restartBoundary),
      );
      if (recoveryMode === "reconciliation") {
        const trigger = recoveryTrigger;
        if (recoveryEventId === undefined || trigger === undefined) {
          throw new Error("DURABLE_CORE_RECONCILIATION_EVIDENCE_MISSING");
        }
        assertEquals(
          trigger.recoveryFunctionId,
          "bakery-server-bakery-workflow-recovery",
        );
        assertEquals(trigger.recoveryFunctionEventId, recoveryEventId);
        assert(trigger.recoveryFunctionDefinitionId.trim() !== "");
        assertEquals(
          (engineAfter as Record<string, unknown>).recoveryEventId,
          recoveryEventId,
        );
        assertEquals(
          (engineAfter as Record<string, unknown>).recoveryEventInternalId,
          trigger.recoveryEventInternalId,
        );
        assertEquals(
          (engineAfter as Record<string, unknown>)
            .recoveryTriggerFunctionEventId,
          recoveryEventId,
        );
        assertEquals(
          (engineAfter as Record<string, unknown>)
            .recoveryTriggerFunctionDefinitionId,
          trigger.recoveryFunctionDefinitionId,
        );
        assertEquals(
          (engineAfter as Record<string, unknown>).recoveryTriggerFunctionId,
          trigger.recoveryFunctionId,
        );
        assertEquals(
          (engineAfter as Record<string, unknown>).recoveryTriggerFunctionRunId,
          trigger.recoveryFunctionRunId,
        );
        assertTimestampEpochMicros(
          trigger.recoveryFunctionRunStartedAt,
          trigger.recoveryFunctionRunStartedAtMicros,
          "recoveryTrigger.functionRunStartedAt",
        );
        assertTimestampEpochMicros(
          trigger.recoveryEventReceivedAt,
          trigger.recoveryEventReceivedAtMicros,
          "recoveryTrigger.eventReceivedAt",
        );
        const reconciliationChronology = await stack.psql<{
          triggerRunStartedAfterRestart: boolean;
          successorRunStartedAfterTrigger: boolean;
          successorEventReceivedAfterTrigger: boolean;
          successorInternalIdAfterTrigger: boolean;
        }>(
          `select $1::timestamptz < $2::timestamptz
                    as "triggerRunStartedAfterRestart",
                  $2::timestamptz < $3::timestamptz
                    as "successorRunStartedAfterTrigger",
                  $4::timestamptz < $5::timestamptz
                    as "successorEventReceivedAfterTrigger",
                  decode($6, 'hex') < decode($7, 'hex')
                    as "successorInternalIdAfterTrigger"`,
          [
            restartBoundary,
            trigger.recoveryFunctionRunStartedAt,
            engineAfterObservation.functionRunStartedAt,
            trigger.recoveryEventReceivedAt,
            engineAfterObservation.functionEventReceivedAt,
            trigger.recoveryEventInternalId,
            engineAfterObservation.functionEventInternalId,
          ],
        );
        assertEquals(reconciliationChronology, [{
          triggerRunStartedAfterRestart: true,
          successorRunStartedAfterTrigger: true,
          successorEventReceivedAfterTrigger: true,
          successorInternalIdAfterTrigger: true,
        }]);
        assert(
          BigInt(engineAfterObservation.functionRunStartedAtMicros) >
            BigInt(trigger.recoveryFunctionRunStartedAtMicros),
        );
        assert(
          BigInt(engineAfterObservation.functionEventReceivedAtMicros) >
            BigInt(trigger.recoveryEventReceivedAtMicros),
        );
        assert(
          BigInt(`0x${engineAfterObservation.functionEventInternalId}`) >
            BigInt(`0x${trigger.recoveryEventInternalId}`),
        );
        assert(
          Date.parse(trigger.recoveryFunctionRunStartedAt) >
            Date.parse(restartBoundary),
        );
        assert(
          Date.parse(engineAfterObservation.functionRunStartedAt) >
            Date.parse(trigger.recoveryFunctionRunStartedAt),
        );
        assert(
          trigger.recoveryFunctionRunId !== engineAfter.recoveryFunctionRunId,
        );
      } else {
        const engineAfterRecord = engineAfter as Record<string, unknown>;
        for (
          const field of [
            "recoveryEventId",
            "recoveryEventInternalId",
            "recoveryTriggerFunctionId",
            "recoveryTriggerFunctionDefinitionId",
            "recoveryTriggerFunctionRunId",
            "recoveryTriggerFunctionEventId",
          ]
        ) {
          assert(
            !(field in engineAfterRecord),
            `natural recovery has ${field}`,
          );
        }
        if (recoveryEventId !== undefined || recoveryTrigger !== undefined) {
          if (recoveryEventId === undefined || recoveryTrigger === undefined) {
            throw new Error("DURABLE_CORE_RECONCILIATION_EVIDENCE_MISSING");
          }
          assertEquals(
            recoveryTrigger.recoveryFunctionEventId,
            recoveryEventId,
          );
          assertEquals(recoveryTrigger.runId, scenario.job.runId);
          assertEquals(
            recoveryTrigger.recoveryFunctionId,
            "bakery-server-bakery-workflow-recovery",
          );
        }
      }
      assert(
        !["completed", "failed", "canceled"].includes(engineAfter.runStatus),
      );
      assert(
        !["completed", "failed", "canceled"].includes(engineAfter.jobStatus),
      );
      await writeWorkerRelease(scenario.releasePath);
      await waitForTerminalRows(stack, scenario.job.jobId);
      const terminal = await observeTerminal(stack, scenario, marker);
      const spoolAfter = await waitForSpoolAbsent(
        `${scenario.stateDir}/spool.json`,
        { attemptId: checkpoint.attemptId, eventId: checkpoint.eventId },
      );
      assertEquals(terminal.attemptId, marker.first.attemptId);
      assertEquals(terminal.acceptedCount, 1);
      assertEquals(terminal.effectCount, 1);
      assertEquals(terminal.artifactCount, 1);
      assertEquals(terminal.versionCount, 1);
      assertEquals(terminal.terminalAttemptCount, 1);
      assertEquals(spoolAfter.spoolState, "absent");
      assertEquals(spoolAfter.checkpointAckedLocalSeq, null);
      assertEquals(spoolAfter.nextLocalSeq, null);
      const proof = {
        kind: "engine",
        revision: await checkoutRevision(),
        configuration: { project: stack.project, ports: stack.ports },
        runId: scenario.job.runId,
        effectKey: scenario.effectKey,
        checkpoint: {
          attemptId: checkpoint.attemptId,
          jobId: checkpoint.jobId,
          runId: checkpoint.runId,
          runStepId: checkpoint.runStepId,
          fence: marker.first.fence,
          workerSessionId: marker.first.workerSessionId,
          workerSessionGeneration: marker.first.workerSessionGeneration,
          eventId: checkpoint.eventId,
          localSeq: "3",
          ackedLocalSeq: checkpoint.ackedLocalSeq as "3",
          artifactRef: marker.artifact,
        },
        restart: {
          service: "inngest",
          beforeProcessId: engineBefore.processId,
          afterProcessId: engineAfter.processId,
        },
        terminal: {
          jobId: terminal.jobId,
          attemptId: terminal.attemptId,
          eventId: terminal.eventId,
          taskId: terminal.taskId,
          taskStatus: terminal.taskStatus,
          runId: terminal.runId,
          runStatus: terminal.runStatus,
          runStepId: terminal.runStepId,
          runStepStatus: terminal.runStepStatus,
          terminalTaskCount: terminal.terminalTaskCount,
          terminalRunCount: terminal.terminalRunCount,
          terminalStepCount: terminal.terminalStepCount,
          acceptedCount: 1,
          effectCount: 1,
          artifactCount: 1,
        },
        artifact: {
          ref: marker.artifact,
          sha256: marker.bytesSha256,
          verifiedSha256: terminal.verifiedSha256,
        },
        observations: {
          journalBefore,
          journalAfter: journalObservation(
            marker.latest.attemptId,
            checkpoint.eventId,
            marker.latest.journalAfter,
          ),
          spoolBefore,
          spoolAfter,
          engineBefore,
          engineAfter,
        },
      } as const;
      const boundaryPath = await writeDurableCoreBoundaryProof(proof);
      if (boundaryPath !== undefined) {
        const persisted = JSON.parse(await Deno.readTextFile(boundaryPath));
        assertEquals(
          parseDurableCoreBoundaryProof(persisted, {
            revision: proof.revision,
            runId: proof.runId,
          }),
          proof,
        );
      }
    } finally {
      if (child && !childStopped) {
        await stopRealWorker(child, "SIGTERM");
        childStopped = true;
      }
      await stack.down();
      if (scenario) await removeScenarioState(scenario);
    }
  },
);

Deno.test(
  "durable core correlates the admitted owner across natural and reconciliation interleaving",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upDurableCoreStack("durable-core-recovery-race", {
      jobCompletionTimeout: "1s",
    });
    try {
      const admission = await admitEngineOwnedRun(stack);
      const { job } = admission;
      await stack.stopService("inngest");
      await waitForEngineOwnerLeaseExpiry(
        stack,
        job.runId,
        admission.clients.identity.organizationId,
        admission.observation,
      );
      const restartBoundary = await readDatabaseClock(stack);
      const emptyPoll = await waitForPostRestartEngineEvent(
        stack,
        job.runId,
        restartBoundary,
        0,
      );
      assertEquals(emptyPoll, undefined);

      await stack.startService("inngest");
      const naturalEvent = await waitForPostRestartEngineEvent(
        stack,
        job.runId,
        restartBoundary,
        60_000,
      );
      if (naturalEvent === undefined) {
        throw new Error(
          "DURABLE_CORE_NATURAL_SUCCESSOR_AFTER_EMPTY_POLL_MISSING",
        );
      }

      const recoveryEventId = await publishWorkflowReconciliation(
        stack,
        job.runId,
      );
      const recoveryTrigger = await waitForWorkflowRecoveryInvocation(
        stack,
        job.runId,
        recoveryEventId,
      );
      const engineAfter = await waitForEngineInvocation(
        stack,
        job.runId,
        admission.clients.identity.organizationId,
        {
          previous: admission.observation,
          restartBoundary,
          recoveryTrigger,
        },
      );
      assert(
        engineAfter.recoverySource === "cron" ||
          engineAfter.recoverySource === "handoff" ||
          engineAfter.recoverySource === "reconciliation",
      );
      assertEquals(
        engineAfter.engineOwnerToken,
        engineAfter.functionEventId,
      );
      assertEquals(naturalEvent.runId, job.runId);
      if (engineAfter.recoverySource === "reconciliation") {
        assert(engineAfter.functionEventId !== naturalEvent.eventId);
      }
      assertEquals(recoveryTrigger.recoveryFunctionEventId, recoveryEventId);
      assertEquals(recoveryTrigger.runId, job.runId);
    } finally {
      await stack.down();
    }
  },
);

Deno.test(
  "durable core replays a persisted checkpoint across a real server restart",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upDurableCoreStack("durable-core-recovery");
    try {
      const clients = await createDurableArtifactClients(stack);
      const assignment = clients.producer.producer!.assignment;
      const effectKey = `durable-core-recovery-${crypto.randomUUID()}`;
      const bytes = new TextEncoder().encode("durable-core-recovery-artifact");
      const workspaceId = crypto.randomUUID();
      const initialEvents = [
        event("1", "job.accepted", { acceptedAt: now() }),
        event("2", "job.started", { startedAt: now(), workspaceId }),
        event("3", "job.progress", {
          message: "checkpoint barrier reached",
          percent: 50,
        }),
      ];
      const initialResponse = await postWorkerEvents(
        clients.producer,
        initialEvents,
      );
      assertEquals(
        initialResponse.status,
        200,
        await initialResponse.clone().text(),
      );

      const artifact = await publishArtifact(
        clients.producer,
        bytes,
        effectKey,
      );
      const checkpointEvent = event("4", "job.checkpoint", {
        artifact,
        resumeHandleRef: effectKey,
      });
      const checkpointResponse = await postWorkerEvents(
        clients.producer,
        [checkpointEvent],
      );
      assertEquals(
        checkpointResponse.status,
        200,
        await checkpointResponse.clone().text(),
      );
      const checkpoint = await waitForPersistedCheckpoint({
        stack,
        attemptId: assignment.attemptId,
        effectKey,
        artifact,
      });
      assertEquals(checkpoint.jobId, clients.job.jobId);
      assertEquals(checkpoint.runId, clients.job.runId);
      assertEquals(checkpoint.runStepId, clients.job.runStepId);

      const liveStepsResponse = await fetchRunSteps(
        clients.producer,
        clients.job.runId,
      );
      assertEquals(
        liveStepsResponse.status,
        200,
        await liveStepsResponse.clone().text(),
      );
      const liveSteps = await liveStepsResponse.json() as {
        items: Array<{ id: string; status: string }>;
      };
      assertEquals(liveSteps.items.map(({ id }) => id), [
        clients.job.runStepId,
      ]);

      const snapshotResponse = await fetchTaskSync(
        clients.consumer,
        clients.job.taskId,
      );
      assertEquals(
        snapshotResponse.status,
        200,
        await snapshotResponse.clone().text(),
      );
      const snapshot = await snapshotResponse.json() as {
        nextCursor: string | null;
      };
      if (snapshot.nextCursor === null) {
        throw new Error("DURABLE_CORE_PROGRESS_CURSOR_MISSING");
      }
      const progressCursor = snapshot.nextCursor;

      await stack.restartService("server", checkpoint.eventId);

      const replayResponse = await postWorkerEvents(
        clients.producer,
        [checkpointEvent],
      );
      assertEquals(
        replayResponse.status,
        200,
        await replayResponse.clone().text(),
      );
      const artifactReplay = await publishArtifact(
        clients.producer,
        bytes,
        effectKey,
      );
      assertEquals(artifactReplay, artifact);

      const terminalResult = {
        headSha: "durable-core-head",
        baseSha: "durable-core-base",
        sessionId: clients.job.sessionId,
        artifacts: [artifact],
      };
      const resultKey = crypto.randomUUID();
      const resultRequestId = crypto.randomUUID();
      const resultTraceId = crypto.randomUUID().replaceAll("-", "");
      const resultResponse = await postWorkerResult(
        clients.producer,
        { localSeq: "5", status: "completed", result: terminalResult },
        resultKey,
        {
          requestId: resultRequestId,
          traceId: resultTraceId,
        },
      );
      assertEquals(
        resultResponse.status,
        200,
        await resultResponse.clone().text(),
      );
      const resultReplay = await postWorkerResult(
        clients.producer,
        { localSeq: "5", status: "completed", result: terminalResult },
        resultKey,
      );
      assertEquals(resultReplay.status, 200, await resultReplay.text());

      const replayedSyncResponse = await fetchTaskSync(
        clients.consumer,
        clients.job.taskId,
        progressCursor,
      );
      assertEquals(
        replayedSyncResponse.status,
        200,
        await replayedSyncResponse.clone().text(),
      );
      const replayedSync = await replayedSyncResponse.json() as {
        events: Array<{ type?: string; eventType?: string }>;
      };
      assert(
        replayedSync.events.some((entry) =>
          entry.type === "job.completed" || entry.eventType === "job.completed"
        ),
        "cursor replay must include the terminal lifecycle event",
      );

      const completionReadRequestId = crypto.randomUUID();
      const completionReadTraceId = crypto.randomUUID().replaceAll("-", "");
      const finalStepsResponse = await fetchRunSteps(
        clients.consumer,
        clients.job.runId,
        undefined,
        {
          requestId: completionReadRequestId,
          traceId: completionReadTraceId,
        },
      );
      assertEquals(
        finalStepsResponse.status,
        200,
        await finalStepsResponse.clone().text(),
      );
      const finalSteps = await finalStepsResponse.json() as {
        items: Array<{ status: string; output: unknown }>;
      };
      assertEquals(finalSteps.items.length, 1);
      assertEquals(finalSteps.items[0]?.status, "completed");
      assertEquals(finalSteps.items[0]?.output, terminalResult);
      const completionReadAuditRows = await stack.psql<DurableCoreAuditRef>(
        `select id,
                organization_id as "organizationId",
                resource_type as "resourceType",
                resource_id as "resourceId",
                operation,
                outcome,
                request_id as "requestId",
                trace_id as "traceId"
           from bakery.audit_events
          where organization_id = $1
            and request_id = $2
            and trace_id = $3
            and operation = 'runs.steps.list'
            and resource_type = 'workflow_run'
            and resource_id = $4
            and outcome = 'allowed'`,
        [
          clients.producer.organizationId,
          completionReadRequestId,
          completionReadTraceId,
          clients.job.runId,
        ],
      );
      assertEquals(completionReadAuditRows.length, 1);
      const completionReadAudit = completionReadAuditRows[0]!;
      assertEquals(completionReadAudit.requestId, completionReadRequestId);
      assertEquals(completionReadAudit.traceId, completionReadTraceId);

      const contentResponse = await fetchArtifact(clients.consumer, artifact);
      assertEquals(
        contentResponse.status,
        200,
        await contentResponse.clone().text(),
      );
      assertEquals(
        Array.from(new Uint8Array(await contentResponse.arrayBuffer())),
        Array.from(bytes),
      );

      const lifecycle = await stack.psql<{
        jobStatus: string;
        runStatus: string;
        stepStatus: string;
        taskStatus: string;
      }>(
        `select job.status as "jobStatus",
                run.status as "runStatus",
                step.status as "stepStatus",
                task.status as "taskStatus"
           from bakery.jobs job
           join bakery.run_steps step
             on step.organization_id = job.organization_id
            and step.id = job.run_step_id
           join bakery.workflow_runs run
             on run.organization_id = step.organization_id
            and run.id = step.run_id
           join bakery.tasks task
             on task.organization_id = run.organization_id
            and task.id = run.task_id
          where job.id = $1`,
        [clients.job.jobId],
      );
      assertEquals(lifecycle, [{
        jobStatus: "completed",
        runStatus: "completed",
        stepStatus: "completed",
        taskStatus: "completed",
      }]);

      const facts = await stack.psql<{
        terminalResults: number;
        terminalEvents: number;
        artifacts: number;
        versions: number;
        effectKeys: number;
        acceptedAudits: number;
        eventRows: number;
      }>(
        `select
           (select count(*)::int from bakery.job_attempts
             where job_id = $1 and status = 'completed') as "terminalResults",
           (select count(*)::int from bakery.attempt_events event
             join bakery.job_attempts attempt on attempt.id = event.attempt_id
            where attempt.job_id = $1 and event.event_type = 'job.succeeded') as "terminalEvents",
           (select count(*)::int from bakery.artifacts
             where organization_id = $2 and task_id = $3
               and artifact_type = 'patch'
               and name = 'durable-core-terminal-artifact') as "artifacts",
           (select count(*)::int from bakery.artifact_versions version
             join bakery.artifacts artifact
               on artifact.organization_id = version.organization_id
              and artifact.id = version.artifact_id
            where artifact.organization_id = $2 and artifact.task_id = $3
              and version.id = $4) as "versions",
           (select count(*)::int from bakery.artifact_publication_replays
             where organization_id = $2 and attempt_id = $5
               and idempotency_key = $6) as "effectKeys",
           (select count(*)::int from bakery.audit_events
             where organization_id = $2 and operation = 'workers.result'
               and resource_id = $5::text and outcome = 'succeeded') as "acceptedAudits",
           (select count(*)::int from bakery.attempt_events event
             join bakery.job_attempts attempt on attempt.id = event.attempt_id
            where attempt.job_id = $1) as "eventRows"`,
        [
          clients.job.jobId,
          clients.producer.organizationId,
          clients.job.taskId,
          artifact.versionId,
          assignment.attemptId,
          effectKey,
        ],
      );
      assertEquals(facts, [{
        terminalResults: 1,
        terminalEvents: 1,
        artifacts: 1,
        versions: 1,
        effectKeys: 1,
        acceptedAudits: 1,
        eventRows: 5,
      }]);
      const auditRows = await stack.psql<DurableCoreAuditRef>(
        `select audit.id,
                audit.organization_id as "organizationId",
                audit.resource_type as "resourceType",
                audit.resource_id as "resourceId",
                audit.operation,
                audit.outcome,
                audit.request_id as "requestId",
                audit.trace_id as "traceId"
           from bakery.audit_events audit
           join bakery.job_attempts attempt
             on audit.resource_type = 'job_attempt'
            and audit.resource_id = attempt.id::text
            and attempt.organization_id = audit.organization_id
           join bakery.jobs job
             on job.organization_id = attempt.organization_id
            and job.id = attempt.job_id
           join bakery.run_steps step
             on step.organization_id = job.organization_id
            and step.id = job.run_step_id
           join bakery.workflow_runs run
             on run.organization_id = step.organization_id
            and run.id = step.run_id
          where audit.organization_id = $1
            and run.id = $2
            and audit.resource_id = $3
            and audit.operation = 'workers.result'
            and audit.outcome = 'succeeded'
          order by audit.created_at`,
        [
          clients.producer.organizationId,
          clients.job.runId,
          assignment.attemptId,
        ],
      );
      if (auditRows.length !== 1) {
        throw new Error(
          `DURABLE_CORE_RECOVERY_AUDIT_ROWS_INVALID:${auditRows.length}`,
        );
      }
      const terminalAudit = auditRows[0]!;
      assertEquals(terminalAudit.requestId, resultRequestId);
      assertEquals(terminalAudit.traceId, resultTraceId);
      if (
        terminalAudit.requestId.trim() === "" ||
        terminalAudit.traceId.trim() === "" ||
        terminalAudit.id.trim() === ""
      ) {
        throw new Error("DURABLE_CORE_RECOVERY_AUDIT_EVIDENCE_MISSING");
      }
      const cases = [
        ...[
          "persisted-checkpoint",
          "server-restart",
          "cursor-replay",
          "one-terminal-winner",
        ].map((name) =>
          createDurableCoreCase({
            name,
            outcome: "passed",
            requestId: resultRequestId,
            traceId: resultTraceId,
            auditRefs: [terminalAudit],
          })
        ),
        createDurableCoreCase({
          name: "completion-before-wait-durable-read",
          outcome: "passed",
          requestId: completionReadRequestId,
          traceId: completionReadTraceId,
          auditRefs: [completionReadAudit],
        }),
      ] as const;
      const producerOrganizationId = clients.producer.organizationId;
      if (!producerOrganizationId) {
        throw new Error("DURABLE_CORE_PRODUCER_ORGANIZATION_MISSING");
      }
      await assertDurableCoreAuditLinks(
        stack.psql,
        cases,
        {
          "persisted-checkpoint": {
            organizationId: producerOrganizationId,
            resourceType: "job_attempt",
            resourceId: assignment.attemptId,
            operation: "workers.result",
            outcome: "succeeded",
          },
          "server-restart": {
            organizationId: producerOrganizationId,
            resourceType: "job_attempt",
            resourceId: assignment.attemptId,
            operation: "workers.result",
            outcome: "succeeded",
          },
          "cursor-replay": {
            organizationId: producerOrganizationId,
            resourceType: "job_attempt",
            resourceId: assignment.attemptId,
            operation: "workers.result",
            outcome: "succeeded",
          },
          "one-terminal-winner": {
            organizationId: producerOrganizationId,
            resourceType: "job_attempt",
            resourceId: assignment.attemptId,
            operation: "workers.result",
            outcome: "succeeded",
          },
          "completion-before-wait-durable-read": {
            organizationId: producerOrganizationId,
            resourceType: "workflow_run",
            resourceId: clients.job.runId,
            operation: "runs.steps.list",
            outcome: "allowed",
          },
        },
      );

      const evidence = await collectDurableCoreEvidence({
        stack,
        runId: clients.job.runId,
        effectKey,
        artifactRef: artifact,
        terminalResultCount: facts[0]!.terminalResults,
        artifactCount: facts[0]!.artifacts,
        cases,
      });
      console.log(`DURABLE_CORE_EVIDENCE ${JSON.stringify(evidence)}`);
    } finally {
      await stack.down();
    }
  },
);

Deno.test(
  "durable core drains a canceled result after checkpoint and rejects later success",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const stack = await upDurableCoreStack("durable-core-cancellation");
    try {
      const clients = await createDurableArtifactClients(stack);
      const assignment = clients.producer.producer!.assignment;
      const organizationId = clients.producer.organizationId;
      if (typeof organizationId !== "string") {
        throw new Error("DURABLE_CORE_ORGANIZATION_ID_MISSING");
      }
      const effectKey = `durable-core-cancellation-${crypto.randomUUID()}`;
      const bytes = new TextEncoder().encode(
        "durable-core-cancellation-artifact",
      );
      const initialEvents = [
        event("1", "job.accepted", { acceptedAt: now() }),
        event("2", "job.started", {
          startedAt: now(),
          workspaceId: crypto.randomUUID(),
        }),
        event("3", "job.progress", {
          message: "cancellation checkpoint barrier reached",
          percent: 50,
        }),
      ];
      const initialResponse = await postWorkerEvents(
        clients.producer,
        initialEvents,
      );
      assertEquals(
        initialResponse.status,
        200,
        await initialResponse.clone().text(),
      );

      const artifact = await publishArtifact(
        clients.producer,
        bytes,
        effectKey,
      );
      const checkpointEvent = event("4", "job.checkpoint", {
        artifact,
        resumeHandleRef: effectKey,
      });
      const checkpointResponse = await postWorkerEvents(
        clients.producer,
        [checkpointEvent],
      );
      assertEquals(
        checkpointResponse.status,
        200,
        await checkpointResponse.clone().text(),
      );
      const checkpoint = await waitForPersistedCheckpoint({
        stack,
        attemptId: assignment.attemptId,
        effectKey,
        artifact,
      });
      assertEquals(checkpoint.jobId, clients.job.jobId);
      assertEquals(checkpoint.runId, clients.job.runId);
      assertEquals(checkpoint.runStepId, clients.job.runStepId);

      await stack.restartService("server", checkpoint.eventId);

      const cancellationKey = crypto.randomUUID();
      const cancellationResponse = await postWorkerResult(
        clients.producer,
        {
          localSeq: "5",
          status: "canceled",
          cancellation: {
            processExited: true,
            exitedAt: now(),
            cleanupStatus: "complete",
          },
        },
        cancellationKey,
      );
      const cancellationBody = await cancellationResponse.clone().text();
      assertEquals(cancellationResponse.status, 200, cancellationBody);
      assertEquals(await cancellationResponse.json(), {
        eventId: cancellationKey,
        status: "applied",
        lastEventSeq: "5",
      });

      const readOnlyBeforeRejection = await readOnlyLifecycleSnapshot(
        stack,
        organizationId,
        clients.job,
        assignment.attemptId,
      );
      const rejectedRequestId = crypto.randomUUID();
      const rejectedTraceId = crypto.randomUUID().replaceAll("-", "");
      const successfulResult = await clients.producer.stack.fetch(
        new Request(
          `${clients.producer.stack.origin}/v1/worker/attempts/${assignment.attemptId}/result`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${clients.producer.producer!.credential}`,
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
              Origin: clients.producer.stack.origin,
              "X-Bakery-Worker-Protocol-Version": "2",
              "X-Request-Id": rejectedRequestId,
              "X-Trace-Id": rejectedTraceId,
              traceparent: `00-${rejectedTraceId}-${
                crypto.randomUUID().replaceAll("-", "").slice(0, 16)
              }-01`,
            },
            body: JSON.stringify({
              leaseToken: assignment.leaseToken,
              fence: assignment.fence,
              workerSessionId: assignment.workerSessionId,
              workerSessionGeneration: assignment.workerSessionGeneration,
              localSeq: "6",
              status: "completed",
              result: {
                headSha: "durable-core-canceled-head",
                baseSha: "durable-core-canceled-base",
                sessionId: clients.job.sessionId,
                artifacts: [artifact],
              },
            }),
          },
        ),
      );
      const rejectedEvidence = await problemEvidence(successfulResult);
      assertEquals(successfulResult.status, 409, rejectedEvidence.raw);
      assertEquals(rejectedEvidence.code, "ALREADY_TERMINAL");
      assertEquals(rejectedEvidence.requestId, rejectedRequestId);
      assertEquals(rejectedEvidence.traceId, rejectedTraceId);
      const rejectedAuditRows = await stack.psql<
        DurableCoreAuditRef & { details: Record<string, unknown> }
      >(
        `select id,
                organization_id as "organizationId",
                resource_type as "resourceType",
                resource_id as "resourceId",
                operation,
                outcome,
                request_id as "requestId",
                trace_id as "traceId",
                details
           from bakery.audit_events
          where organization_id = $1
            and request_id = $2
            and trace_id = $3
            and operation = 'workers.result'
            and resource_type = 'job_attempt'
            and resource_id = $4
            and outcome = 'denied'`,
        [
          organizationId,
          rejectedEvidence.requestId,
          rejectedEvidence.traceId,
          assignment.attemptId,
        ],
      );
      assertEquals(rejectedAuditRows.length, 1);
      const {
        details: rejectedAuditDetails,
        ...rejectedAudit
      } = rejectedAuditRows[0]!;
      assertEquals(rejectedAuditDetails, {
        requested: "completed",
        observed: "canceled",
        code: "ALREADY_TERMINAL",
        httpStatus: 409,
      });

      const readOnlyAfterRejection = await readOnlyLifecycleSnapshot(
        stack,
        organizationId,
        clients.job,
        assignment.attemptId,
      );
      const {
        auditRows: beforeRejectionAuditRows,
        ...beforeRejectionLifecycle
      } = readOnlyBeforeRejection;
      const {
        auditRows: afterRejectionAuditRows,
        ...afterRejectionLifecycle
      } = readOnlyAfterRejection;
      assertEquals(afterRejectionAuditRows, beforeRejectionAuditRows + 1);
      assertEquals(afterRejectionLifecycle, beforeRejectionLifecycle);

      const completionReadRequestId = crypto.randomUUID();
      const completionReadTraceId = crypto.randomUUID().replaceAll("-", "");
      const completedBeforeWait = await fetchRunSteps(
        clients.consumer,
        clients.job.runId,
        undefined,
        {
          requestId: completionReadRequestId,
          traceId: completionReadTraceId,
        },
      );
      const completedBeforeWaitBody = await completedBeforeWait.clone().text();
      assertEquals(completedBeforeWait.status, 200, completedBeforeWaitBody);
      const readOnlyAfter = await readOnlyLifecycleSnapshot(
        stack,
        organizationId,
        clients.job,
        assignment.attemptId,
      );
      const {
        auditRows: beforeAuditRows,
        ...beforeLifecycle
      } = readOnlyAfterRejection;
      const { auditRows: afterAuditRows, ...afterLifecycle } = readOnlyAfter;
      assertEquals(afterAuditRows, beforeAuditRows + 1);
      assertEquals(afterLifecycle, beforeLifecycle);
      const completedBeforeWaitSteps = await completedBeforeWait.json() as {
        items: Array<{ id: string; status: string }>;
      };
      assertEquals(
        completedBeforeWaitSteps.items.map(({ id, status }) => ({
          id,
          status,
        })),
        [{
          id: clients.job.runStepId,
          status: "canceled",
        }],
      );

      const completionReadAuditRows = await stack.psql<DurableCoreAuditRef>(
        `select id,
                organization_id as "organizationId",
                resource_type as "resourceType",
                resource_id as "resourceId",
                operation,
                outcome,
                request_id as "requestId",
                trace_id as "traceId"
           from bakery.audit_events
          where organization_id = $1
            and request_id = $2
            and trace_id = $3
            and operation = 'runs.steps.list'
            and resource_type = 'workflow_run'
            and resource_id = $4
            and outcome = 'allowed'`,
        [
          organizationId,
          completionReadRequestId,
          completionReadTraceId,
          clients.job.runId,
        ],
      );
      assertEquals(completionReadAuditRows.length, 1);
      const completionReadAudit = completionReadAuditRows[0]!;

      const lifecycle = await stack.psql<{
        jobStatus: string;
        runStatus: string;
        stepStatus: string;
        taskStatus: string;
      }>(
        `select job.status as "jobStatus",
                run.status as "runStatus",
                step.status as "stepStatus",
                task.status as "taskStatus"
           from bakery.jobs job
           join bakery.run_steps step
             on step.organization_id = job.organization_id
            and step.id = job.run_step_id
           join bakery.workflow_runs run
             on run.organization_id = step.organization_id
            and run.id = step.run_id
           join bakery.tasks task
             on task.organization_id = run.organization_id
            and task.id = run.task_id
          where job.id = $1`,
        [clients.job.jobId],
      );
      assertEquals(lifecycle, [{
        jobStatus: "canceled",
        runStatus: "canceled",
        stepStatus: "canceled",
        taskStatus: "canceled",
      }]);

      const facts = await stack.psql<{
        terminalAttempts: number;
        canceledAttempts: number;
        canceledEvents: number;
        successfulEvents: number;
        artifacts: number;
        versions: number;
        effectKeys: number;
        acceptedAudits: number;
        eventRows: number;
      }>(
        `select
           (select count(*)::int from bakery.job_attempts
             where job_id = $1
               and status in ('completed', 'failed', 'canceled'))
               as "terminalAttempts",
           (select count(*)::int from bakery.job_attempts
             where job_id = $1 and status = 'canceled')
               as "canceledAttempts",
           (select count(*)::int from bakery.attempt_events event
             join bakery.job_attempts attempt on attempt.id = event.attempt_id
            where attempt.job_id = $1 and event.event_type = 'job.cancelled')
               as "canceledEvents",
           (select count(*)::int from bakery.attempt_events event
             join bakery.job_attempts attempt on attempt.id = event.attempt_id
            where attempt.job_id = $1 and event.event_type = 'job.succeeded')
               as "successfulEvents",
           (select count(*)::int from bakery.artifacts
             where organization_id = $2 and task_id = $3
               and artifact_type = 'patch'
               and name = 'durable-core-terminal-artifact')
               as "artifacts",
           (select count(*)::int from bakery.artifact_versions version
             join bakery.artifacts artifact
               on artifact.organization_id = version.organization_id
              and artifact.id = version.artifact_id
            where artifact.organization_id = $2
              and artifact.task_id = $3
              and version.id = $4)
               as "versions",
           (select count(*)::int from bakery.artifact_publication_replays
             where organization_id = $2
               and attempt_id = $5
               and idempotency_key = $6)
               as "effectKeys",
           (select count(*)::int from bakery.audit_events
             where organization_id = $2
               and operation = 'workers.result'
               and resource_id = $5::text
               and outcome = 'succeeded')
               as "acceptedAudits",
           (select count(*)::int from bakery.attempt_events event
             join bakery.job_attempts attempt on attempt.id = event.attempt_id
            where attempt.job_id = $1)
               as "eventRows"`,
        [
          clients.job.jobId,
          organizationId,
          clients.job.taskId,
          artifact.versionId,
          assignment.attemptId,
          effectKey,
        ],
      );
      assertEquals(facts, [{
        terminalAttempts: 1,
        canceledAttempts: 1,
        canceledEvents: 1,
        successfulEvents: 0,
        artifacts: 1,
        versions: 1,
        effectKeys: 1,
        acceptedAudits: 1,
        eventRows: 5,
      }]);

      const auditRows = await stack.psql<DurableCoreAuditRef>(
        `select id,
                organization_id as "organizationId",
                resource_type as "resourceType",
                resource_id as "resourceId",
                operation,
                outcome,
                request_id as "requestId",
                trace_id as "traceId"
           from bakery.audit_events
          where organization_id = $1
            and operation = 'workers.result'
            and resource_id = $2
            and outcome = 'succeeded'
          order by created_at`,
        [organizationId, assignment.attemptId],
      );
      assertEquals(auditRows.length, 1);
      const cancellationAudit = auditRows[0]!;
      const cases = [
        createDurableCoreCase({
          name: "cancellation-drain-after-checkpoint",
          outcome: "passed",
          requestId: cancellationAudit.requestId,
          traceId: cancellationAudit.traceId,
          auditRefs: [cancellationAudit],
        }),
        createDurableCoreCase({
          name: "reject-success-after-cancellation",
          outcome: "passed",
          requestId: rejectedEvidence.requestId,
          traceId: rejectedEvidence.traceId,
          auditRefs: [rejectedAudit],
        }),
        createDurableCoreCase({
          name: "cancellation-completion-before-wait-durable-read",
          outcome: "passed",
          requestId: completionReadRequestId,
          traceId: completionReadTraceId,
          auditRefs: [completionReadAudit],
        }),
      ] as const;
      await assertDurableCoreAuditLinks(stack.psql, cases, {
        "cancellation-drain-after-checkpoint": {
          organizationId,
          resourceType: "job_attempt",
          resourceId: assignment.attemptId,
          operation: "workers.result",
          outcome: "succeeded",
        },
        "reject-success-after-cancellation": {
          organizationId,
          resourceType: "job_attempt",
          resourceId: assignment.attemptId,
          operation: "workers.result",
          outcome: "denied",
        },
        "cancellation-completion-before-wait-durable-read": {
          organizationId,
          resourceType: "workflow_run",
          resourceId: clients.job.runId,
          operation: "runs.steps.list",
          outcome: "allowed",
        },
      });

      const evidence = await collectDurableCoreEvidence({
        stack,
        runId: clients.job.runId,
        effectKey,
        artifactRef: artifact,
        terminalResultCount: facts[0]!.terminalAttempts,
        artifactCount: facts[0]!.artifacts,
        cases,
      });
      console.log(`DURABLE_CORE_EVIDENCE ${JSON.stringify(evidence)}`);
    } finally {
      await stack.down();
    }
  },
);
