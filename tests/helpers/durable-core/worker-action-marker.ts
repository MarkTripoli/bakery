import type { ArtifactRef } from "../../e2e/helpers/durable-core/artifact-client.ts";

export type WorkerActionJournal = {
  readonly nextLocalSeq: string;
  readonly ackedLocalSeq: string;
};

export type WorkerActionAttempt = {
  readonly attemptId: string;
  readonly fence: string;
  readonly workerSessionId: string;
  readonly workerSessionGeneration: string;
  readonly journalBefore: WorkerActionJournal;
  readonly journalAfter: WorkerActionJournal;
};

export type WorkerActionMarker = {
  readonly version: 1;
  readonly jobId: string;
  readonly effectKey: string;
  readonly artifact: ArtifactRef;
  readonly bytesSha256: string;
  readonly checkpointEventId: string;
  readonly checkpointLocalSeq: "3";
  readonly first: WorkerActionAttempt;
  readonly latest: WorkerActionAttempt;
  readonly phase: "uploaded" | "checkpoint-enqueued" | "checkpoint-acked";
};

const MAX_MARKER_BYTES = 16 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `DURABLE_CORE_WORKER_MARKER_${field.toUpperCase()}_INVALID`,
    );
  }
  return value;
}

function sequence(value: unknown, field: string): string {
  const result = nonEmpty(value, field);
  if (!DECIMAL.test(result)) {
    throw new Error(
      `DURABLE_CORE_WORKER_MARKER_${field.toUpperCase()}_INVALID`,
    );
  }
  return result;
}

function uuid(value: unknown, field: string): string {
  const result = nonEmpty(value, field);
  if (!UUID.test(result)) {
    throw new Error(
      `DURABLE_CORE_WORKER_MARKER_${field.toUpperCase()}_INVALID`,
    );
  }
  return result;
}

function journal(value: unknown, field: string): WorkerActionJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `DURABLE_CORE_WORKER_MARKER_${field.toUpperCase()}_INVALID`,
    );
  }
  const entry = value as Record<string, unknown>;
  return {
    nextLocalSeq: sequence(entry.nextLocalSeq, `${field}_NEXT_LOCAL_SEQ`),
    ackedLocalSeq: sequence(entry.ackedLocalSeq, `${field}_ACKED_LOCAL_SEQ`),
  };
}

function artifact(value: unknown): ArtifactRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DURABLE_CORE_WORKER_MARKER_ARTIFACT_INVALID");
  }
  const entry = value as Record<string, unknown>;
  return {
    artifactId: uuid(entry.artifactId, "artifact_id"),
    versionId: uuid(entry.versionId, "version_id"),
    sha256: nonEmpty(entry.sha256, "artifact_sha256"),
  };
}

function attempt(value: unknown, field: string): WorkerActionAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `DURABLE_CORE_WORKER_MARKER_${field.toUpperCase()}_INVALID`,
    );
  }
  const entry = value as Record<string, unknown>;
  return {
    attemptId: uuid(entry.attemptId, `${field}_ATTEMPT_ID`),
    fence: sequence(entry.fence, `${field}_FENCE`),
    workerSessionId: uuid(
      entry.workerSessionId,
      `${field}_WORKER_SESSION_ID`,
    ),
    workerSessionGeneration: sequence(
      entry.workerSessionGeneration,
      `${field}_WORKER_SESSION_GENERATION`,
    ),
    journalBefore: journal(entry.journalBefore, `${field}_JOURNAL_BEFORE`),
    journalAfter: journal(entry.journalAfter, `${field}_JOURNAL_AFTER`),
  };
}

export function parseWorkerActionMarker(value: unknown): WorkerActionMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DURABLE_CORE_WORKER_MARKER_INVALID");
  }
  const entry = value as Record<string, unknown>;
  if (entry.version !== 1 || entry.checkpointLocalSeq !== "3") {
    throw new Error("DURABLE_CORE_WORKER_MARKER_VERSION_INVALID");
  }
  const artifactRef = artifact(entry.artifact);
  const bytesSha256 = nonEmpty(entry.bytesSha256, "bytes_sha256");
  if (!SHA256.test(bytesSha256) || artifactRef.sha256 !== bytesSha256) {
    throw new Error("DURABLE_CORE_WORKER_MARKER_DIGEST_INVALID");
  }
  const phase = entry.phase;
  if (
    phase !== "uploaded" && phase !== "checkpoint-enqueued" &&
    phase !== "checkpoint-acked"
  ) {
    throw new Error("DURABLE_CORE_WORKER_MARKER_PHASE_INVALID");
  }
  return {
    version: 1,
    jobId: uuid(entry.jobId, "job_id"),
    effectKey: nonEmpty(entry.effectKey, "effect_key"),
    artifact: artifactRef,
    bytesSha256,
    checkpointEventId: uuid(entry.checkpointEventId, "checkpoint_event_id"),
    checkpointLocalSeq: "3",
    first: attempt(entry.first, "first"),
    latest: attempt(entry.latest, "latest"),
    phase,
  };
}

function assertMarkerPath(path: string): void {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("DURABLE_CORE_WORKER_MARKER_PATH_INVALID");
  }
}

function parentDirectory(path: string): string {
  assertMarkerPath(path);
  const separator = path.lastIndexOf("/");
  if (separator <= 0) {
    throw new Error("DURABLE_CORE_WORKER_MARKER_PATH_INVALID");
  }
  return path.slice(0, separator);
}

export async function readWorkerActionMarker(
  path: string,
): Promise<WorkerActionMarker | null> {
  assertMarkerPath(path);
  try {
    const text = await Deno.readTextFile(path);
    return parseWorkerActionMarker(JSON.parse(text));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

export async function writeWorkerActionMarker(
  path: string,
  marker: WorkerActionMarker,
): Promise<void> {
  const parsed = parseWorkerActionMarker(marker);
  const text = `${JSON.stringify(parsed)}\n`;
  if (new TextEncoder().encode(text).byteLength > MAX_MARKER_BYTES) {
    throw new Error("DURABLE_CORE_WORKER_MARKER_TOO_LARGE");
  }
  await Deno.mkdir(parentDirectory(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(temporary, text, { createNew: true, mode: 0o600 });
    await Deno.rename(temporary, path);
  } catch (error) {
    await Deno.remove(temporary).catch(() => undefined);
    throw error;
  }
}
