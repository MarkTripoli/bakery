import { registeredWorkerActionInputSchema } from "../../../packages/contracts/src/contracts.ts";
import {
  evaluateCheck,
  type EvaluationCheckSpec,
} from "../../../packages/contracts/src/evaluation-scoring.ts";
import type { WorkerContextInput } from "./client.ts";
import type { ExecutionOutcome, WorkerExecutor } from "./executor.ts";
import { NativeExecutorError } from "./executor.ts";
import { provenCanceledOutcome } from "./task-brief.ts";
import type { JobAssignment, JsonValue } from "./types.ts";

export const EVALUATION_CHECK_ACTION = "evaluation.check";
export const EVALUATION_SCORE_ACTION = "evaluation.score";

/**
 * Reason `evaluation.score` reports until a judge is wired. The worker has no
 * prompt-in, JSON-out model primitive: every model call runs a whole coding
 * harness against a repository worktree (claude-harness.ts, reviewer.ts), so
 * the judge answers unscored rather than inventing a client.
 */
/** The reason every model-scored result carries until the judge primitive lands (#44). */
export const MODEL_SCORING_NOT_AVAILABLE = "model scoring not available yet";

export type EvaluationExecutorOptions = {
  /**
   * Reads the attempt's pinned inputs with their bytes. The output artifact
   * version to score must be one of them; a worker cannot ask for anything else.
   */
  readonly readAttemptContext?: (
    attemptId: string,
  ) => Promise<readonly WorkerContextInput[]>;
};

type CheckInput = Readonly<{
  evaluationResultId: string;
  outputArtifactVersionId: string;
  check: EvaluationCheckSpec;
}>;

function completed(result: Record<string, JsonValue>): ExecutionOutcome {
  return { status: "completed", result };
}

function checkError(reason: string): ExecutionOutcome {
  return completed({ state: "error", score: null, reason });
}

/** The registered input, without the profile the server may attach beside it. */
function registeredInput(assignment: JobAssignment): unknown {
  const input = assignment.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const { repositoryProfile: _profile, ...registered } = input as Record<
    string,
    unknown
  >;
  return registered;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Reads the bytes of one pinned output version through the attempt-context
 * route and checks the server's digest against a local hash of them.
 */
async function readOutputBytes(
  assignment: JobAssignment,
  versionId: string,
  options: EvaluationExecutorOptions,
): Promise<Uint8Array | string> {
  if (!options.readAttemptContext) {
    return "this worker has no reader for pinned inputs";
  }
  const inputs = await options.readAttemptContext(assignment.attemptId);
  const pinned = inputs.find((item) => item.artifactVersionId === versionId);
  if (!pinned) {
    return "the output artifact version is not pinned to the attempt";
  }
  const bytes = decodeBase64(pinned.contentBase64);
  if (await sha256Hex(bytes) !== pinned.digest.toLowerCase()) {
    return "the output bytes do not match the digest the server sent";
  }
  return bytes;
}

/** Runs `evaluation.check`: a pure check over the pinned output bytes. */
export async function executeEvaluationCheck(
  assignment: JobAssignment,
  signal: AbortSignal,
  options: EvaluationExecutorOptions,
): Promise<ExecutionOutcome> {
  if (signal.aborted) return provenCanceledOutcome();
  const parsed = registeredWorkerActionInputSchema(EVALUATION_CHECK_ACTION)
    .safeParse(registeredInput(assignment));
  if (!parsed.success) return checkError("the check input is not valid");
  const input = parsed.data as CheckInput;
  try {
    const bytes = await readOutputBytes(
      assignment,
      input.outputArtifactVersionId,
      options,
    );
    if (signal.aborted) return provenCanceledOutcome();
    if (typeof bytes === "string") return checkError(bytes);
    const verdict = evaluateCheck(input.check, bytes);
    return completed({ ...verdict });
  } catch (error) {
    if (signal.aborted) return provenCanceledOutcome();
    return checkError(
      `the check crashed: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }
}

/**
 * Runs `evaluation.score`. No judge is wired yet (see
 * {@link MODEL_SCORING_NOT_AVAILABLE}), so a valid input answers unscored; the
 * server records that as an unmeasured attempt.
 */
export function executeEvaluationScore(
  assignment: JobAssignment,
  signal: AbortSignal,
): ExecutionOutcome {
  if (signal.aborted) return provenCanceledOutcome();
  const parsed = registeredWorkerActionInputSchema(EVALUATION_SCORE_ACTION)
    .safeParse(registeredInput(assignment));
  return completed({
    state: parsed.success ? "unscored" : "error",
    score: null,
    reason: parsed.success
      ? MODEL_SCORING_NOT_AVAILABLE
      : "the score input is not valid",
    judgeOutput: null,
  });
}

/**
 * Wraps `inner` so it also runs both evaluation actions in-process: they read
 * pinned bytes and run no untrusted code, so they need no sandbox or skills.
 * Every other action goes to `inner` unchanged.
 */
export function createEvaluationExecutor(
  inner: WorkerExecutor,
  options: EvaluationExecutorOptions,
): WorkerExecutor {
  return {
    supportedActions: [
      ...new Set([
        ...(inner.supportedActions ?? []),
        EVALUATION_CHECK_ACTION,
        EVALUATION_SCORE_ACTION,
      ]),
    ],
    capturesNativeOutput: inner.capturesNativeOutput,
    initialize: inner.initialize?.bind(inner),
    readinessChecks: inner.readinessChecks?.bind(inner),
    control: inner.control?.bind(inner),
    credentialRedactionSecrets: inner.credentialRedactionSecrets?.bind(inner),
    execute(assignment, signal, output, preparedSkills) {
      if (
        assignment.action !== EVALUATION_CHECK_ACTION &&
        assignment.action !== EVALUATION_SCORE_ACTION
      ) {
        return inner.execute(assignment, signal, output, preparedSkills);
      }
      if (
        assignment.skillRefs.length > 0 ||
        (preparedSkills?.roots.length ?? 0) > 0
      ) {
        throw new NativeExecutorError(
          `PREPARED_SKILL_ROOTS_UNSUPPORTED:${assignment.action}`,
        );
      }
      return assignment.action === EVALUATION_CHECK_ACTION
        ? executeEvaluationCheck(assignment, signal, options)
        : Promise.resolve(executeEvaluationScore(assignment, signal));
    },
  };
}
