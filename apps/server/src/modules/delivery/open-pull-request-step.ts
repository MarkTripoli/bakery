import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgDatabase } from "../../platform/database.ts";
import type { ReconcileDependencies } from "../integrations/reconcile.ts";
import type {
  EngineStepRequest,
  EngineStepResult,
  EngineStepRunner,
} from "../workflow-adapter/engine-steps.ts";
import { openPullRequestForRun } from "./pull-request-registration.ts";

export const OPEN_PULL_REQUEST_STEP = "delivery.openPullRequest";

const OPEN_STEP_DEADLINE_MS = 60_000;

const RETRYABLE = new Set([
  "DEPENDENCY_UNAVAILABLE",
  "DEPENDENCY_TIMEOUT",
  "PROVIDER_QUOTA_EXCEEDED",
]);

function failed(code: string, message: string): EngineStepResult {
  return { kind: "failed", code, message };
}

function refusalReason(error: StandardError): string {
  const params = error.params as
    | { reason?: unknown; issues?: readonly { code?: unknown }[] }
    | undefined;
  if (typeof params?.reason === "string") return params.reason;
  const issue = params?.issues?.[0]?.code;
  return typeof issue === "string" ? issue : error.code;
}

async function runOpen(
  database: PgDatabase,
  dependencies: ReconcileDependencies,
  request: EngineStepRequest,
): Promise<EngineStepResult> {
  const parsed = contractSchemas.OpenPullRequestInput.safeParse(request.input);
  if (!parsed.success) {
    return failed("STEP_INPUT_INVALID", "The step's input is not valid.");
  }
  const repositoryId = parsed.data.repositoryId ?? request.repositoryId;
  if (repositoryId === null) {
    return failed(
      "REPOSITORY_REQUIRED",
      "The step names no repository and its run has none.",
    );
  }
  try {
    const pullRequest = await openPullRequestForRun(database, dependencies, {
      organizationId: request.organizationId,
      taskId: request.taskId,
      runId: request.runId,
      principalId: request.requestedBy,
      repositoryId,
      headBranch: parsed.data.headBranch,
      ...(parsed.data.baseBranch === undefined
        ? {}
        : { baseBranch: parsed.data.baseBranch }),
      title: parsed.data.title,
      ...(parsed.data.body === undefined ? {} : { body: parsed.data.body }),
    }, AbortSignal.timeout(OPEN_STEP_DEADLINE_MS));
    return { kind: "completed", output: pullRequest };
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    if (RETRYABLE.has(error.code)) return { kind: "pending" };
    return failed(error.code, refusalReason(error));
  }
}

export function createOpenPullRequestStepRunner(
  deps: Readonly<{
    database: PgDatabase;
    registration: ReconcileDependencies;
  }>,
): EngineStepRunner {
  return {
    handles: (action) => action === OPEN_PULL_REQUEST_STEP,
    run: (request) => runOpen(deps.database, deps.registration, request),
  };
}
