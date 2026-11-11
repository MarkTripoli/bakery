import type { WorkerConfig } from "../../../apps/worker/src/config.ts";
import { WorkerApiClient } from "../../../apps/worker/src/client.ts";
import type {
  ExecutionOutcome,
  WorkerExecutor,
} from "../../../apps/worker/src/executor.ts";
import { main } from "../../../apps/worker/src/main.ts";
import { RegistrationStore } from "../../../apps/worker/src/registration.ts";
import { EventSpool } from "../../../apps/worker/src/spool.ts";
import type {
  JobAssignment,
  JsonValue,
} from "../../../apps/worker/src/types.ts";
import type { ArtifactRef } from "../../e2e/helpers/durable-core/artifact-client.ts";
import { workerActionCapabilities } from "../../../packages/contracts/src/contracts.ts";
import {
  readWorkerActionMarker,
  type WorkerActionAttempt,
  type WorkerActionJournal,
  type WorkerActionMarker,
  writeWorkerActionMarker,
} from "./worker-action-marker.ts";

const MAX_ARTIFACT_BYTES = 4 * 1024;
const ACTION_TIMEOUT_MS = 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`DURABLE_CORE_WORKER_${name}_REQUIRED`);
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")
  }}`;
}

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

function boundedAssignmentBytes(assignment: JobAssignment): Uint8Array {
  const source = stableJson({
    action: assignment.action,
    input: assignment.input,
    jobId: assignment.jobId,
  });
  const bytes = new TextEncoder().encode(`durable-core-action:${source}`);
  return bytes.byteLength <= MAX_ARTIFACT_BYTES
    ? bytes
    : bytes.slice(0, MAX_ARTIFACT_BYTES);
}

function assertArtifactRef(value: unknown): ArtifactRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DURABLE_CORE_WORKER_ARTIFACT_RESPONSE_INVALID");
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.id !== "string" || !UUID.test(body.id) ||
    typeof body.artifactId !== "string" || !UUID.test(body.artifactId) ||
    typeof body.sha256 !== "string" || !SHA256.test(body.sha256)
  ) {
    throw new Error("DURABLE_CORE_WORKER_ARTIFACT_RESPONSE_INVALID");
  }
  return {
    artifactId: body.artifactId,
    versionId: body.id,
    sha256: body.sha256,
  };
}

async function uploadArtifact(
  serverUrl: string,
  credential: string,
  assignment: JobAssignment,
  runStepId: string,
  bytes: Uint8Array,
  effectKey: string,
): Promise<ArtifactRef> {
  const contentSha256 = await sha256Hex(bytes);
  const form = new FormData();
  form.set("leaseToken", assignment.leaseToken);
  form.set("fence", assignment.fence);
  form.set("workerSessionId", assignment.workerSessionId ?? "");
  form.set(
    "workerSessionGeneration",
    String(assignment.workerSessionGeneration ?? ""),
  );
  form.set("artifactType", "patch");
  form.set("name", "durable-core-terminal-artifact");
  form.set("contentType", "application/octet-stream");
  form.set("contentDigest", contentSha256);
  form.set("runStepId", runStepId);
  form.set("stepKey", "worker");
  form.set("metadata", JSON.stringify({ source: "issue-43", immutable: true }));
  form.set(
    "content",
    new File([bytes.slice().buffer as ArrayBuffer], "durable-core.bin", {
      type: "application/octet-stream",
    }),
  );
  const response = await fetch(
    `${serverUrl}/v1/worker/attempts/${
      encodeURIComponent(assignment.attemptId)
    }/artifacts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Idempotency-Key": effectKey,
        "X-Bakery-Worker-Protocol-Version": "2",
      },
      body: form,
    },
  );
  const raw = await response.text();
  if (response.status !== 201) {
    throw new Error(
      `DURABLE_CORE_WORKER_ARTIFACT_UPLOAD_FAILED:${response.status}:${
        raw.slice(0, 512)
      }`,
    );
  }
  const artifact = assertArtifactRef(JSON.parse(raw));
  if (artifact.sha256 !== contentSha256) {
    throw new Error("DURABLE_CORE_WORKER_ARTIFACT_DIGEST_MISMATCH");
  }
  return artifact;
}

function attemptSnapshot(
  assignment: JobAssignment,
  journalBefore: WorkerActionJournal,
  journalAfter: WorkerActionJournal,
): WorkerActionAttempt {
  if (
    typeof assignment.workerSessionId !== "string" ||
    !UUID.test(assignment.workerSessionId) ||
    typeof assignment.workerSessionGeneration !== "string" ||
    !/^\d+$/.test(assignment.workerSessionGeneration)
  ) {
    throw new Error("DURABLE_CORE_WORKER_ASSIGNMENT_SESSION_INVALID");
  }
  return {
    attemptId: assignment.attemptId,
    fence: assignment.fence,
    workerSessionId: assignment.workerSessionId,
    workerSessionGeneration: assignment.workerSessionGeneration,
    journalBefore,
    journalAfter,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCheckpointAck(
  spool: EventSpool,
  attemptId: string,
): Promise<WorkerActionJournal> {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let latest = spool.journalState(attemptId);
  while (Date.now() < deadline) {
    latest = spool.journalState(attemptId);
    if (BigInt(latest.ackedLocalSeq) >= 3n) {
      return latest;
    }
    await delay(25);
  }
  throw new Error(
    `DURABLE_CORE_WORKER_CHECKPOINT_ACK_TIMEOUT:${attemptId}:${
      JSON.stringify(latest)
    }`,
  );
}

async function waitForRelease(
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("DURABLE_CORE_WORKER_ACTION_ABORTED");
    try {
      await Deno.stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await delay(25);
  }
  throw new Error("DURABLE_CORE_WORKER_RELEASE_TIMEOUT");
}

function markerForAttempt(
  existing: WorkerActionMarker | null,
  assignment: JobAssignment,
  artifact: ArtifactRef,
  effectKey: string,
  bytesSha256: string,
  checkpointEventId: string,
  journalBefore: WorkerActionJournal,
  journalAfter: WorkerActionJournal,
  phase: WorkerActionMarker["phase"],
): WorkerActionMarker {
  const current = attemptSnapshot(assignment, journalBefore, journalAfter);
  return {
    version: 1,
    jobId: assignment.jobId,
    effectKey,
    artifact,
    bytesSha256,
    checkpointEventId,
    checkpointLocalSeq: "3",
    first: existing?.first ?? current,
    latest: current,
    phase,
  };
}

function createConfig(options: {
  serverUrl: string;
  workerName: string;
  stateDir: string;
  enrollmentToken: string;
}): WorkerConfig {
  return {
    environment: "test",
    serverUrl: options.serverUrl,
    version: "issue-43-durable-core",
    name: options.workerName,
    os: "linux",
    architecture: "x64",
    capabilities: [...workerActionCapabilities("harness.implement")],
    toolchainVersions: { deno: "2.x" },
    slots: 1,
    enrollmentToken: options.enrollmentToken,
    stateDir: options.stateDir,
    registrationPath: `${options.stateDir}/registration.json`,
    spoolPath: `${options.stateDir}/spool.json`,
    heartbeatIntervalMs: 100,
    claimBackoffBaseMs: 100,
    claimBackoffMaxMs: 1_000,
    requestTimeoutMs: 5_000,
    drainTimeoutMs: 5_000,
    terminationGraceMs: 5_000,
    spoolMaxRecords: 1_000,
    spoolMaxBytes: 1_048_576,
  };
}

function createExecutor(options: {
  serverUrl: string;
  credential: string;
  runStepId: string;
  sessionId: string;
  markerPath: string;
  releasePath: string;
  replacementReleasePath: string;
  spool: EventSpool;
}): WorkerExecutor {
  return {
    supportedActions: ["harness.implement"],
    execute: async (
      assignment: JobAssignment,
      signal: AbortSignal,
    ): Promise<ExecutionOutcome> => {
      const effectKey = `durable-core-${assignment.jobId}`;
      const bytes = boundedAssignmentBytes(assignment);
      const bytesSha256 = await sha256Hex(bytes);
      const existing = await readWorkerActionMarker(options.markerPath);
      if (
        existing &&
        (existing.jobId !== assignment.jobId ||
          existing.effectKey !== effectKey)
      ) {
        throw new Error("DURABLE_CORE_WORKER_MARKER_ASSIGNMENT_MISMATCH");
      }
      if (existing && existing.bytesSha256 !== bytesSha256) {
        throw new Error("DURABLE_CORE_WORKER_MARKER_BYTES_MISMATCH");
      }
      const artifact = existing?.artifact ?? await uploadArtifact(
        options.serverUrl,
        options.credential,
        assignment,
        options.runStepId,
        bytes,
        effectKey,
      );
      if (artifact.sha256 !== bytesSha256) {
        throw new Error("DURABLE_CORE_WORKER_ARTIFACT_BYTES_MISMATCH");
      }
      const checkpointEventId =
        existing?.latest.attemptId === assignment.attemptId
          ? existing.checkpointEventId
          : crypto.randomUUID();
      const journalBefore = options.spool.journalState(assignment.attemptId);
      const checkpointAlreadyAcked = journalBefore.nextLocalSeq === "4" &&
        journalBefore.ackedLocalSeq === "3";
      const checkpointReadyToEnqueue = journalBefore.nextLocalSeq === "3" &&
        journalBefore.ackedLocalSeq === "2";
      if (!checkpointAlreadyAcked && !checkpointReadyToEnqueue) {
        throw new Error(
          `DURABLE_CORE_WORKER_CHECKPOINT_SEQUENCE_INVALID:${
            JSON.stringify(journalBefore)
          }`,
        );
      }
      if (checkpointAlreadyAcked) {
        const acknowledgedMarker = markerForAttempt(
          existing,
          assignment,
          artifact,
          effectKey,
          bytesSha256,
          checkpointEventId,
          journalBefore,
          journalBefore,
          "checkpoint-acked",
        );
        await writeWorkerActionMarker(options.markerPath, acknowledgedMarker);
        if (assignment.attemptId === acknowledgedMarker.first.attemptId) {
          await waitForRelease(options.releasePath, signal);
        }
        return {
          status: "completed",
          result: {
            headSha: `durable-core-head-${assignment.jobId}`,
            baseSha: `durable-core-base-${assignment.jobId}`,
            sessionId: options.sessionId,
            artifacts: [artifact],
          },
        };
      }
      const uploadedMarker = markerForAttempt(
        existing,
        assignment,
        artifact,
        effectKey,
        bytesSha256,
        checkpointEventId,
        journalBefore,
        journalBefore,
        "uploaded",
      );
      await writeWorkerActionMarker(options.markerPath, uploadedMarker);
      await options.spool.enqueueEvent({
        attemptId: assignment.attemptId,
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        localSeq: "3",
        eventId: checkpointEventId,
        eventType: "job.checkpoint",
        payload: {
          artifact,
          resumeHandleRef: effectKey,
        } as JsonValue,
      });
      const enqueuedJournal = options.spool.journalState(assignment.attemptId);
      await writeWorkerActionMarker(
        options.markerPath,
        markerForAttempt(
          uploadedMarker,
          assignment,
          artifact,
          effectKey,
          bytesSha256,
          checkpointEventId,
          journalBefore,
          enqueuedJournal,
          "checkpoint-enqueued",
        ),
      );
      const acknowledgedJournal = await waitForCheckpointAck(
        options.spool,
        assignment.attemptId,
      );
      const acknowledgedMarker = markerForAttempt(
        uploadedMarker,
        assignment,
        artifact,
        effectKey,
        bytesSha256,
        checkpointEventId,
        journalBefore,
        acknowledgedJournal,
        "checkpoint-acked",
      );
      await writeWorkerActionMarker(options.markerPath, acknowledgedMarker);
      if (assignment.attemptId === acknowledgedMarker.first.attemptId) {
        await waitForRelease(options.releasePath, signal);
      } else {
        await waitForRelease(options.replacementReleasePath, signal);
      }
      return {
        status: "completed",
        result: {
          headSha: `durable-core-head-${assignment.jobId}`,
          baseSha: `durable-core-base-${assignment.jobId}`,
          sessionId: options.sessionId,
          artifacts: [artifact],
        },
      };
    },
  };
}

async function run(): Promise<void> {
  const serverUrl = requiredEnvironment("BAKERY_DURABLE_CORE_SERVER_URL");
  const workerName = requiredEnvironment("BAKERY_DURABLE_CORE_WORKER_NAME");
  const enrollmentToken = requiredEnvironment(
    "BAKERY_DURABLE_CORE_ENROLLMENT_TOKEN",
  );
  const credential = requiredEnvironment(
    "BAKERY_DURABLE_CORE_WORKER_CREDENTIAL",
  );
  const runStepId = requiredEnvironment("BAKERY_DURABLE_CORE_RUN_STEP_ID");
  const sessionId = requiredEnvironment("BAKERY_DURABLE_CORE_SESSION_ID");
  const stateDir = requiredEnvironment("BAKERY_DURABLE_CORE_STATE_DIR");
  const markerPath = requiredEnvironment("BAKERY_DURABLE_CORE_MARKER_PATH");
  const releasePath = requiredEnvironment("BAKERY_DURABLE_CORE_RELEASE_PATH");
  const replacementReleasePath = requiredEnvironment(
    "BAKERY_DURABLE_CORE_REPLACEMENT_RELEASE_PATH",
  );
  const config = createConfig({
    serverUrl,
    workerName,
    stateDir,
    enrollmentToken,
  });
  const registrationStore = new RegistrationStore(config.registrationPath);
  const registration = await registrationStore.load();
  if (!registration) {
    await registrationStore.savePendingRegistration(
      credential,
      crypto.randomUUID(),
    );
  } else if (registration.workerCredential !== credential) {
    throw new Error("DURABLE_CORE_WORKER_CREDENTIAL_MISMATCH");
  }
  const client = new WorkerApiClient({
    baseUrl: config.serverUrl,
    credential,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const spool = await EventSpool.open({
    path: config.spoolPath,
    maxRecords: config.spoolMaxRecords,
    maxBytes: config.spoolMaxBytes,
  });
  await main({
    config,
    client,
    registrationStore,
    spool,
    executor: createExecutor({
      serverUrl,
      credential,
      runStepId,
      sessionId,
      markerPath,
      releasePath,
      replacementReleasePath,
      spool,
    }),
  });
}

if (import.meta.main) {
  try {
    console.log(`DURABLE_CORE_WORKER_CHILD_READY pid=${Deno.pid}`);
    await run();
  } catch (error) {
    console.error(
      `durable-core worker child stopped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }
}
