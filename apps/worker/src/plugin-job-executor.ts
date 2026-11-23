import { registeredWorkerActionInputSchema } from "../../../packages/contracts/src/contracts.ts";
import type { JobAssignment } from "./types.ts";
import type { ExecutionOutcome } from "./executor.ts";
import {
  materializePluginCode,
  PluginCodeError,
  type PluginCodeResponse,
} from "./plugin-job-code.ts";
import {
  type ContainmentRuntime,
  DEFAULT_CODE_MOUNT,
  DEFAULT_PLUGIN_JOB_LIMITS,
  type JobRelay,
  memoryResultSink,
  type PluginJobEnd,
  type PluginJobLimits,
  runPluginJob,
} from "./plugin-job-runtime.ts";

/**
 * Runs one `plugin.job` attempt (#29, B14.02): fetch the install's code,
 * write it where the contained runtime can read it, run it behind the
 * boundary, and turn however it ended into an execution outcome.
 *
 * Everything that touches the server or the host is injected, so the mapping
 * from "how a job ended" to "what the attempt reports" is one small function
 * with its own tests. A job that cannot be contained is never run: an
 * unsupported runtime is a failed attempt with that reason.
 */

export type PluginJobDeps = Readonly<{
  runtime: ContainmentRuntime;
  /** A directory the worker owns, where each attempt's code is written. */
  codeParent: string;
  limits?: PluginJobLimits;
  /** The command that runs `entry` inside the boundary, under the code mount. */
  command(entry: string, mount: string): readonly string[];
  /** Fetches the install's files; refusals arrive as a rejected promise. */
  fetchFiles(signal: AbortSignal): Promise<PluginCodeResponse>;
  /** Relays one request to the server's broker for this attempt. */
  relay(
    call: Parameters<JobRelay>[0],
    signal: AbortSignal,
  ): ReturnType<JobRelay>;
}>;

function fault(
  code: string,
  status: number,
  detail: string,
  title = "The plugin job did not finish",
): ExecutionOutcome {
  return {
    status: "failed",
    fault: {
      type: "about:blank",
      title,
      status,
      detail,
      code,
      requestId: crypto.randomUUID(),
      // A job may have had effects, so a rerun is for the schedule to decide.
      retryable: false,
    },
  };
}

function canceled(): ExecutionOutcome {
  // The runner awaits the boundary's removal before it returns, so by the
  // time this is reported the job has exited and its container is gone.
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

/** The attempt's outcome for one way a job can end. */
export function outcomeFor(end: PluginJobEnd): ExecutionOutcome {
  switch (end.kind) {
    case "result": {
      const resultJson = JSON.stringify(end.value ?? null);
      if (resultJson.length > 65536) {
        return fault(
          "UNPROCESSABLE",
          422,
          "The job's result is larger than the 64 KiB a result may be.",
        );
      }
      return { status: "completed", result: { resultJson } };
    }
    case "aborted":
      return canceled();
    case "timeout":
      return fault(
        "DEPENDENCY_TIMEOUT",
        504,
        "The job ran past its time budget and was stopped.",
      );
    case "unsupported":
      return fault(
        "DEPENDENCY_UNAVAILABLE",
        503,
        `This worker cannot contain plugin jobs: ${end.reason}.`,
        "Plugin jobs are unavailable on this worker",
      );
    case "start_failed":
      return fault(
        "DEPENDENCY_UNAVAILABLE",
        503,
        "The job's boundary could not be created.",
      );
    case "output_limit":
      return fault(
        "UNPROCESSABLE",
        422,
        "The job wrote more output than a job may, and was stopped.",
      );
    case "protocol_violation":
      return fault(
        "UNPROCESSABLE",
        422,
        `The job broke the message protocol (${end.detail}) and was stopped.`,
      );
    case "crashed":
      return fault(
        "INTERNAL",
        500,
        end.oomKilled
          ? "The job ran out of memory and was stopped."
          : "The job exited without a result.",
      );
  }
}

function refusalFor(error: unknown): ExecutionOutcome {
  if (error instanceof PluginCodeError) {
    return fault(
      "UNPROCESSABLE",
      422,
      "The code the server sent for this job was refused by the worker.",
    );
  }
  const status = (error as { status?: unknown } | null)?.status;
  // The server refuses to hand out code for an install that is off, removed or
  // not granted: the job's authority is gone, which is a conflict, not an outage.
  if (status === 409) {
    return fault(
      "STATE_CONFLICT",
      409,
      "The install this job belongs to can no longer run jobs.",
    );
  }
  return fault(
    "DEPENDENCY_UNAVAILABLE",
    503,
    "The job's code could not be fetched.",
  );
}

export async function executePluginJob(
  assignment: JobAssignment,
  signal: AbortSignal,
  deps: PluginJobDeps,
): Promise<ExecutionOutcome> {
  if (signal.aborted) return canceled();
  // The server attaches context beside the registered input (the repository
  // profile, for one), so only the fields the action declares are read.
  const raw = assignment.input !== null &&
      typeof assignment.input === "object" && !Array.isArray(assignment.input)
    ? assignment.input as Record<string, unknown>
    : {};
  const parsed = registeredWorkerActionInputSchema("plugin.job").safeParse({
    installId: raw.installId,
    entry: raw.entry,
    versionId: raw.versionId,
  });
  if (!parsed.success) {
    return fault(
      "VALIDATION_FAILED",
      422,
      "The plugin job input was not valid.",
    );
  }
  const input = parsed.data as {
    installId: string;
    entry: string;
    versionId: string;
  };

  let code: Awaited<ReturnType<typeof materializePluginCode>>;
  try {
    const response = await deps.fetchFiles(signal);
    // The entry the job was admitted with, not whatever the response names.
    if (response.entry !== input.entry) {
      return fault(
        "UNPROCESSABLE",
        422,
        "The server sent code for a different entry than this job names.",
      );
    }
    code = await materializePluginCode(response, deps.codeParent);
  } catch (error) {
    if (signal.aborted) return canceled();
    return refusalFor(error);
  }

  try {
    const end = await runPluginJob({
      runtime: deps.runtime,
      spec: {
        name: `job-${assignment.attemptId.slice(0, 8)}`,
        codeDir: code.dir,
        command: deps.command(
          code.entry,
          deps.runtime.codeMount ?? DEFAULT_CODE_MOUNT,
        ),
        limits: deps.limits ?? DEFAULT_PLUGIN_JOB_LIMITS,
      },
      relay: (call) => deps.relay(call, signal),
      // One attempt, one fence: the server's fenced result endpoint is the
      // record that matters; this identity only guards the local runner.
      identity: `${input.installId}:${assignment.jobId}:${assignment.fence}`,
      sink: memoryResultSink(),
      signal,
    });
    return outcomeFor(end);
  } finally {
    await code.remove();
  }
}
