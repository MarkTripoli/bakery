import type { ArtifactRef } from "./client.ts";
import { enforceWorkerFixedPolicy, type WorkerExecutor } from "./executor.ts";
import type { ExecutionOutcome } from "./executor.ts";
import { HARNESS_REPAIR_ACTION, readRepairInput } from "./harness-common.ts";
import {
  assembleReviewReport,
  ReviewerModelOutputSchema,
  reviewPinsFromProfile,
} from "./review-report.ts";
import {
  provenCanceledOutcome,
  type PublishArtifact,
  publishFailureOutcome,
} from "./task-brief.ts";
import type { JobAssignment, JsonValue } from "./types.ts";
import { registeredWorkerActionInputSchema } from "../../../packages/contracts/src/contracts.ts";
import { RepositoryExecutionContextSchema } from "../../../packages/contracts/src/repository-inspection.ts";

const POLL_INTERVAL_MS = 50;
/** Git's empty tree id: the base when a strict profile pins no source commit. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SCRIPTED_ACTION = "harness.implement";
const SCRIPTED_REVIEW_ACTION = "review.independent";
const SCRIPTED_FAULT_NAMING = Object.freeze({
  prefix: "SCRIPTED_HARNESS",
  title: "Scripted harness could not complete",
});
const encoder = new TextEncoder();

async function digestHex(
  algorithm: "SHA-1" | "SHA-256",
  bytes: Uint8Array,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    algorithm,
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Deterministic patch derived only from the plan artifact version it follows. */
export function scriptedPatch(planArtifact: string): Uint8Array {
  return encoder.encode([
    "diff --git a/BAKERY_SCRIPTED_HARNESS.md b/BAKERY_SCRIPTED_HARNESS.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/BAKERY_SCRIPTED_HARNESS.md",
    "@@ -0,0 +1 @@",
    `+Scripted harness patch following plan artifact ${planArtifact}.`,
    "",
  ].join("\n"));
}

/**
 * Deterministic repair patch derived only from the input it answers: the
 * revision it follows and how many findings and failed checks it addresses.
 */
export function scriptedRepairPatch(
  revision: string,
  findings: number,
  failedChecks: number,
): Uint8Array {
  return encoder.encode([
    "diff --git a/BAKERY_SCRIPTED_REPAIR.md b/BAKERY_SCRIPTED_REPAIR.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/BAKERY_SCRIPTED_REPAIR.md",
    "@@ -0,0 +1 @@",
    `+Scripted repair of revision ${revision} for ${findings} finding(s) and ${failedChecks} failed check(s).`,
    "",
  ].join("\n"));
}

function scriptedFault(code: string, detail: string): ExecutionOutcome {
  return {
    status: "failed",
    fault: {
      type: "about:blank",
      title: "Scripted harness could not complete",
      status: 500,
      detail,
      code,
      requestId: crypto.randomUUID(),
      retryable: false,
    },
  };
}

/**
 * Marks the job started and waits for the test to release it. False when the
 * assignment was canceled first.
 */
async function waitForRelease(
  dir: string,
  assignment: JobAssignment,
  signal: AbortSignal,
): Promise<boolean> {
  const started = `${dir}/${assignment.jobId}.started`;
  const release = `${dir}/${assignment.jobId}.release`;
  await Deno.writeTextFile(started, `${assignment.attemptId}\n`);
  while (!await exists(release)) {
    if (signal.aborted) return false;
    await sleep(POLL_INTERVAL_MS, signal);
  }
  return !signal.aborted;
}

async function executeScripted(
  dir: string,
  assignment: JobAssignment,
  signal: AbortSignal,
  publish: PublishArtifact,
): Promise<ExecutionOutcome> {
  await enforceWorkerFixedPolicy(assignment);
  const input = assignment.input as Record<string, unknown> | null;
  const planArtifact = input !== null && typeof input === "object"
    ? input.planArtifact
    : undefined;
  const profile = RepositoryExecutionContextSchema.safeParse(
    input?.repositoryProfile,
  );
  if (
    typeof planArtifact !== "string" || !profile.success ||
    !assignment.agentSessionId
  ) {
    return scriptedFault(
      "SCRIPTED_HARNESS_INPUT_INVALID",
      "The scripted harness needs a plan artifact, a profile and a session.",
    );
  }
  if (signal.aborted) return provenCanceledOutcome();
  if (!await waitForRelease(dir, assignment, signal)) {
    return provenCanceledOutcome();
  }
  const patch = scriptedPatch(planArtifact);
  const patchDigest = await digestHex("SHA-256", patch);
  const headSha = await digestHex("SHA-1", patch);
  const baseSha = profile.data.baseSha ?? EMPTY_TREE_SHA;
  let artifact: ArtifactRef;
  try {
    artifact = await publish({
      idempotencyKey: `patch:${assignment.jobId}:${assignment.fence}`,
      artifactType: "patch",
      mediaType: "text/x-diff",
      name: `scripted-patch-${assignment.jobId}-${assignment.fence}.diff`,
      bytes: patch,
      subjectHeadSha: headSha,
      subjectBaseSha: baseSha,
      metadata: { source: "scripted-harness", immutable: true },
    }, signal);
  } catch (error) {
    return publishFailureOutcome(error, signal);
  }
  if (artifact.sha256 !== patchDigest) {
    return scriptedFault(
      "SCRIPTED_HARNESS_ARTIFACT_DIGEST_MISMATCH",
      "The published patch digest differs from the rendered bytes.",
    );
  }
  return {
    status: "completed",
    result: {
      baseSha,
      headSha,
      sessionId: assignment.agentSessionId,
      artifacts: [artifact],
    },
  };
}

async function executeScriptedRepair(
  dir: string,
  assignment: JobAssignment,
  signal: AbortSignal,
  publish: PublishArtifact,
): Promise<ExecutionOutcome> {
  await enforceWorkerFixedPolicy(assignment);
  const request = readRepairInput(assignment, SCRIPTED_FAULT_NAMING);
  if ("status" in request) return request;
  if (!assignment.agentSessionId) {
    return scriptedFault(
      "SCRIPTED_HARNESS_INPUT_INVALID",
      "The scripted harness needs a session.",
    );
  }
  if (signal.aborted) return provenCanceledOutcome();
  if (!await waitForRelease(dir, assignment, signal)) {
    return provenCanceledOutcome();
  }
  const patch = scriptedRepairPatch(
    request.revision,
    request.findings.length,
    request.failedChecks.length,
  );
  const patchDigest = await digestHex("SHA-256", patch);
  const headSha = await digestHex("SHA-1", patch);
  let artifact: ArtifactRef;
  try {
    artifact = await publish({
      idempotencyKey: `patch:${assignment.jobId}:${assignment.fence}`,
      artifactType: "patch",
      mediaType: "text/x-diff",
      name: `scripted-repair-${assignment.jobId}-${assignment.fence}.diff`,
      bytes: patch,
      subjectHeadSha: headSha,
      subjectBaseSha: request.revision,
      metadata: { source: "scripted-harness", immutable: true },
    }, signal);
  } catch (error) {
    return publishFailureOutcome(error, signal);
  }
  if (artifact.sha256 !== patchDigest) {
    return scriptedFault(
      "SCRIPTED_HARNESS_ARTIFACT_DIGEST_MISMATCH",
      "The published patch digest differs from the rendered bytes.",
    );
  }
  return {
    status: "completed",
    result: {
      baseSha: request.revision,
      headSha,
      sessionId: assignment.agentSessionId,
      artifacts: [artifact],
    },
  };
}

/**
 * Scripted verdict of one review job: the file `<dir>/<jobId>.review.json`
 * holds `{"findings": [...]}` in the reviewer model's shape, and a job with no
 * file reviews clean. The report is built by the same code as the real
 * reviewer's, so lanes exercise the production byte rule and fingerprints.
 */
async function executeScriptedReview(
  dir: string,
  assignment: JobAssignment,
  signal: AbortSignal,
): Promise<ExecutionOutcome> {
  await enforceWorkerFixedPolicy(assignment);
  const raw = assignment.input;
  const { repositoryProfile, ...registered } =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
  const input = registeredWorkerActionInputSchema(SCRIPTED_REVIEW_ACTION)
    .safeParse(registered);
  const profile = RepositoryExecutionContextSchema.safeParse(repositoryProfile);
  const pins = profile.success
    ? await reviewPinsFromProfile(profile.data)
    : null;
  if (
    !input.success || pins === null || !assignment.agentSessionId ||
    assignment.currentCheckpoints.length > 0
  ) {
    return scriptedFault(
      "SCRIPTED_HARNESS_INPUT_INVALID",
      "The scripted reviewer needs a review input, a fixed-policy profile, a fresh session and no checkpoints.",
    );
  }
  if (signal.aborted) return provenCanceledOutcome();
  if (!await waitForRelease(dir, assignment, signal)) {
    return provenCanceledOutcome();
  }
  let verdict: unknown = { findings: [] };
  try {
    verdict = JSON.parse(
      await Deno.readTextFile(`${dir}/${assignment.jobId}.review.json`),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return scriptedFault(
        "SCRIPTED_HARNESS_REVIEW_INVALID",
        "The scripted review verdict file is not valid JSON.",
      );
    }
  }
  const findings = ReviewerModelOutputSchema.safeParse(verdict);
  if (!findings.success) {
    return scriptedFault(
      "SCRIPTED_HARNESS_REVIEW_INVALID",
      "The scripted review verdict does not match the reviewer answer shape.",
    );
  }
  const assembled = await assembleReviewReport({
    sessionId: assignment.agentSessionId,
    headSha: (input.data as { revision: string }).revision,
    baseSha: pins.baseSha,
    policyDigest: pins.policyDigest,
  }, findings.data.findings);
  if (assembled.status !== "ok") {
    return scriptedFault(
      "SCRIPTED_HARNESS_REVIEW_INVALID",
      "The scripted review verdict cannot be turned into one valid review report.",
    );
  }
  return {
    status: "completed",
    result: assembled.report as unknown as JsonValue,
  };
}

/**
 * Test-only decorator: completes `harness.implement` and `harness.repair` with
 * a deterministic patch, and `review.independent` with a scripted verdict, once
 * the test writes `<dir>/<jobId>.release`, and leaves every other action to the
 * wrapped executor. Production never constructs it.
 */
export function createScriptedHarnessExecutor(options: {
  readonly dir: string;
  readonly inner: WorkerExecutor;
  readonly publishFor: (assignment: JobAssignment) => PublishArtifact;
}): WorkerExecutor {
  const { dir, inner, publishFor } = options;
  return {
    supportedActions: [
      ...new Set([
        ...(inner.supportedActions ?? []),
        HARNESS_REPAIR_ACTION,
        SCRIPTED_REVIEW_ACTION,
      ]),
    ],
    capturesNativeOutput: inner.capturesNativeOutput,
    initialize: inner.initialize?.bind(inner),
    readinessChecks: inner.readinessChecks?.bind(inner),
    execute(assignment, signal, output, preparedSkills) {
      switch (assignment.action) {
        case SCRIPTED_ACTION:
          return executeScripted(
            dir,
            assignment,
            signal,
            publishFor(assignment),
          );
        case HARNESS_REPAIR_ACTION:
          return executeScriptedRepair(
            dir,
            assignment,
            signal,
            publishFor(assignment),
          );
        case SCRIPTED_REVIEW_ACTION:
          return executeScriptedReview(dir, assignment, signal);
        default:
          return inner.execute(assignment, signal, output, preparedSkills);
      }
    },
  };
}
