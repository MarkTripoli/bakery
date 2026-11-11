import { registeredWorkerActionInputSchema } from "../../../packages/contracts/src/contracts.ts";
import { RepositoryExecutionContextSchema } from "../../../packages/contracts/src/repository-inspection.ts";
import {
  type ArtifactRef,
  type WorkerArtifactPublishRequest,
  WorkerRequestError,
} from "./client.ts";
import type { ExecutionOutcome } from "./executor.ts";
import type { JobAssignment } from "./types.ts";

export const TASK_BRIEF_SCHEMA = "bakery.task-brief/v1";
export const TASK_BRIEF_MEDIA_TYPE = "application/json";

export type RenderedTaskBrief = Readonly<{
  bytes: Uint8Array;
  mediaType: typeof TASK_BRIEF_MEDIA_TYPE;
  name: string;
}>;

type BriefInput = Readonly<{
  brief: Readonly<{
    title: string;
    description: string;
    taskType: string;
    approvedPlan?: Readonly<{
      planRevisionId: string;
      revision: number;
      digest: string;
      title: string;
      steps: readonly Readonly<
        { id: string; title: string; detail: string }
      >[];
    }>;
  }>;
  repositoryId: string;
}>;

type BriefProfile = Readonly<{
  id: string;
  revision: number;
  digest: string;
  baseSha: string | null;
}>;

const encoder = new TextEncoder();

function unicodeEscape(codeUnit: number): string {
  return `\\u${codeUnit.toString(16).padStart(4, "0")}`;
}

/**
 * Standard JSON string encoding, except that `<`, `>`, `&`, DEL and every C0
 * control other than tab, line feed and carriage return are written as
 * lowercase `\uXXXX` escapes, so the media sniffer never sees a tag opener or
 * a disallowed control byte. Lone surrogates are escaped too.
 */
function encodeString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += "\\\\";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0d) out += "\\r";
    else if (
      code < 0x20 || code === 0x3c || code === 0x3e || code === 0x26 ||
      code === 0x7f || (code >= 0xd800 && code <= 0xdfff)
    ) out += unicodeEscape(code);
    else out += character;
  }
  return `${out}"`;
}

function encodeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(encodeValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) =>
        `${encodeString(key)}:${encodeValue(record[key])}`
      ).join(",")
    }}`;
  }
  throw new Error("TASK_BRIEF_VALUE_UNSUPPORTED");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Deterministic canonical JSON for the frozen brief and its profile pin. */
export function renderTaskBrief(
  input: BriefInput,
  profile: BriefProfile,
): RenderedTaskBrief {
  const text = encodeValue({
    schema: TASK_BRIEF_SCHEMA,
    title: input.brief.title,
    taskType: input.brief.taskType,
    description: input.brief.description,
    ...(input.brief.approvedPlan === undefined
      ? {}
      : { approvedPlan: input.brief.approvedPlan }),
    repositoryId: input.repositoryId,
    profile: {
      id: profile.id,
      revision: profile.revision,
      digest: profile.digest,
    },
    baseSha: profile.baseSha,
  });
  return Object.freeze({
    bytes: encoder.encode(text),
    mediaType: TASK_BRIEF_MEDIA_TYPE,
    name: "task-brief.json",
  });
}

export type PublishArtifact = (
  request: Omit<
    WorkerArtifactPublishRequest,
    | "leaseToken"
    | "fence"
    | "workerSessionId"
    | "workerSessionGeneration"
    | "signal"
  >,
  signal?: AbortSignal,
) => Promise<ArtifactRef>;

/**
 * Artifact names are unique per task, type and name, and a second version of
 * an existing name needs a parent. Each attempt owns a fresh fence, so naming
 * by job and fence lets a reclaimed attempt publish again without a parent.
 */
export function taskBriefArtifactName(jobId: string, fence: string | number) {
  return `task-brief-${jobId}-${fence}.json`;
}

/** Lease codes mean the result is no longer ours to report; the server refuses it. */
const LEASE_FAULT_CODES: ReadonlySet<string> = new Set([
  "LEASE_EXPIRED",
  "LEASE_FENCED",
]);

/**
 * Maps a failed publish to the worker's outcome: an aborted job is canceled,
 * a transient transport or server failure is a dependency fault, and anything
 * else (lease loss, rejection) propagates to the supervisor. The fault is not
 * `retryable`: the engine finishes the step as failed and never re-admits it
 * from the worker's report, so the label states what happens.
 */
export function publishFailureOutcome(
  error: unknown,
  signal: AbortSignal,
): ExecutionOutcome {
  if (signal.aborted) return provenCanceledOutcome();
  if (
    error instanceof WorkerRequestError && error.retryable &&
    !LEASE_FAULT_CODES.has(error.code)
  ) {
    return {
      status: "failed",
      fault: {
        type: "about:blank",
        title: "Artifact publication is temporarily unavailable",
        status: 503,
        detail: "The artifact byte boundary could not be reached.",
        code: "DEPENDENCY_UNAVAILABLE",
        requestId: crypto.randomUUID(),
        retryable: false,
      },
    };
  }
  throw error;
}

export function provenCanceledOutcome(): ExecutionOutcome {
  // Nothing was started, so no process or boundary can outlive this outcome.
  return {
    status: "canceled",
    cancellation: {
      processExited: true,
      exitedAt: new Date().toISOString(),
      cleanupStatus: "complete",
      terminationStatus: "confirmed",
    },
  };
}

/** Cancellation whose process teardown could not be confirmed; never replay-safe. */
export function unconfirmedCanceledOutcome(): ExecutionOutcome {
  return {
    status: "canceled",
    cancellation: {
      processExited: false,
      exitedAt: null,
      cleanupStatus: "pending",
      terminationStatus: "unknown",
    },
  };
}

function briefFault(code: string, detail: string): ExecutionOutcome {
  return {
    status: "failed",
    fault: {
      type: "about:blank",
      title: "Task brief could not be published",
      status: 500,
      detail,
      code,
      requestId: crypto.randomUUID(),
      retryable: false,
    },
  };
}

/**
 * Renders and publishes the task brief. It runs in-process because it reads no
 * repository bytes and starts no untrusted code.
 */
export async function executeTaskBrief(
  assignment: JobAssignment,
  signal: AbortSignal,
  publish: PublishArtifact,
): Promise<ExecutionOutcome> {
  if (signal.aborted) return provenCanceledOutcome();
  const rawInput = assignment.input !== null &&
      typeof assignment.input === "object" && !Array.isArray(assignment.input)
    ? assignment.input as Record<string, unknown>
    : null;
  // The server attaches the frozen profile beside the registered input.
  const { repositoryProfile: rawProfile, ...registered } = rawInput ?? {};
  const parsed = rawInput === null
    ? null
    : registeredWorkerActionInputSchema("task.brief").safeParse(registered);
  const input = parsed?.success ? parsed.data as BriefInput : null;
  const profile = RepositoryExecutionContextSchema.safeParse(rawProfile);
  if (input === null || !profile.success) {
    return briefFault(
      "TASK_BRIEF_INPUT_INVALID",
      "The task brief input or repository profile was not valid.",
    );
  }
  const rendered = renderTaskBrief(input, {
    id: profile.data.id,
    revision: profile.data.revision,
    digest: profile.data.digest,
    baseSha: profile.data.baseSha,
  });
  const localDigest = await sha256Hex(rendered.bytes);
  if (signal.aborted) return provenCanceledOutcome();
  let artifact: ArtifactRef;
  try {
    artifact = await publish({
      idempotencyKey: `brief:${assignment.jobId}:${assignment.fence}`,
      artifactType: "plan",
      mediaType: rendered.mediaType,
      name: taskBriefArtifactName(assignment.jobId, assignment.fence),
      bytes: rendered.bytes,
      metadata: { schema: TASK_BRIEF_SCHEMA, immutable: true },
    }, signal);
  } catch (error) {
    return publishFailureOutcome(error, signal);
  }
  if (artifact.sha256 !== localDigest) {
    return briefFault(
      "TASK_BRIEF_ARTIFACT_DIGEST_MISMATCH",
      "The published brief digest differs from the rendered bytes.",
    );
  }
  return { status: "completed", result: { artifact } };
}
