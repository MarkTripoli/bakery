import type { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  validateEncodedSuccessResponse,
} from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import {
  createNormalizedCommandMetadata,
  StandardError,
} from "@bakery/contracts/http";
import { effectivePermissions } from "../auth/application/authorize.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { readCompletedCommandReplay } from "../../platform/command-replay.ts";
import { boundRetryAfterSeconds } from "../../platform/retry-after.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { readAppCredentials } from "../integrations/callbacks.ts";
import {
  authorityDeniedAtWrite,
  checkRunFactOf,
  forgetFailedToken,
  MAX_CHECK_PAGES,
  mintReadToken,
} from "../integrations/fact-reads.ts";
import {
  DEFAULT_RATE_LIMIT_SECONDS,
  type GitHubPullRequest,
  GitHubReadFailure,
} from "../integrations/github-app.ts";
import {
  countLines,
  type DiffFile,
  MAX_LINE_COUNT_PAGES,
} from "../integrations/line-counter.ts";
import {
  observePullRequest,
  registerPullRequest,
  resolveRepositoryId,
} from "../integrations/pull-requests.ts";
import type { ReconcileDependencies } from "../integrations/reconcile.ts";
import { type RemoteFact, upsertFact } from "../integrations/remote-facts.ts";
import { PULL_REQUEST_MERGE_METHOD } from "./postgres.ts";

type RegistrationInput = {
  repositoryId: string;
  providerNumber: number;
  runId?: string;
};
const PullRequestRegistrationCreateSchema = contractSchemas
  .PullRequestRegistrationCreate as z.ZodType<RegistrationInput>;
type PullRequestOutput = z.output<typeof contractSchemas.PullRequest>;

type RegistrationAuthority = {
  organizationId: string;
  taskId: string;
  repositoryId: string;
  runId: string | null;
  connectionId: string;
  installationId: string;
  installationExternalId: string;
  registrationId: string;
  resourceId: string;
  resourceExternalId: string;
  displayName: string;
  connectionStatus: string;
  installationStatus: string;
};

type PreparedRegistration = {
  authority: RegistrationAuthority;
  pullRequest: GitHubPullRequest;
  observedStartedAt: Date;
  checkFacts: RemoteFact[];
  lineCount: ReturnType<typeof countLines> | null;
};

type PreparedContext = ActionContext & {
  registration: PreparedRegistration;
};

function taskIdOf(context: ActionContext): string {
  const parsed = contractSchemas.IdPath.safeParse({ id: context.params.id });
  if (!parsed.success) throw new StandardError({ code: "MALFORMED_REQUEST" });
  return parsed.data.id;
}

function stateConflict(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

async function connectionIdFor(
  transaction: PgTransactionClient,
  organizationId: string,
  repositoryId: string,
): Promise<string> {
  const result = await transaction.query<{ connection_id: string | null }>(
    `select integration_connection_id as connection_id
       from bakery.repositories
      where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, repositoryId],
  );
  const connectionId = result.rows[0]?.connection_id;
  if (connectionId === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (connectionId === null) {
    throw stateConflict("repository_integration_unbound");
  }
  return connectionId;
}

async function readRegistrationAuthority(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
  input: RegistrationInput,
  expectedConnectionId: string,
  lock: boolean,
): Promise<RegistrationAuthority> {
  const result = await transaction.query<{
    connection_id: string;
    installation_id: string;
    installation_external_id: string;
    registration_id: string;
    resource_id: string;
    resource_external_id: string;
    display_name: string;
    connection_status: string;
    installation_status: string;
  }>(
    `select repository.integration_connection_id as connection_id,
            connection.installation_id,
            installation.external_authorization_id as installation_external_id,
            installation.registration_id,
            resource.id as resource_id,
            resource.external_id as resource_external_id,
            resource.display_name,
            connection.status as connection_status,
            installation.status as installation_status
       from bakery.tasks as task
       join bakery.repositories as repository
         on repository.organization_id = task.organization_id
        and repository.id = $3
        and repository.application_id = task.application_id
        and repository.archived_at is null
       join bakery.integration_connections as connection
         on connection.organization_id = repository.organization_id
        and connection.id = repository.integration_connection_id
        and connection.archived_at is null
       join bakery.integration_installations as installation
         on installation.id = connection.installation_id
       join bakery.integration_resources as resource
         on resource.organization_id = repository.organization_id
        and resource.connection_id = connection.id
        and resource.kind = 'repository'
        and resource.archived_at is null
        and (resource.external_id = repository.provider_repo_id
          or resource.display_name = repository.provider_repo_id)
      where task.organization_id = $1 and task.id = $2
        and task.archived_at is null
        and repository.integration_connection_id = $4
        and (task.repository_id = repository.id or exists (
              select 1 from bakery.task_repositories as binding
               where binding.organization_id = task.organization_id
                 and binding.task_id = task.id
                 and binding.repository_id = repository.id))
        and resource.selected = true and resource.available = true
      ${lock ? "for update of task, repository" : ""}`,
    [organizationId, taskId, input.repositoryId, expectedConnectionId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const row = result.rows[0];
  if (row.connection_status !== "enabled") {
    throw stateConflict("integration_connection_not_enabled");
  }
  if (row.installation_status !== "enabled") {
    throw stateConflict("integration_installation_not_enabled");
  }
  const resolvedRepositoryId = await resolveRepositoryId(transaction, {
    organizationId,
    connectionId: row.connection_id,
    externalId: row.resource_external_id,
    displayName: row.display_name,
  });
  if (resolvedRepositoryId !== input.repositoryId) {
    throw stateConflict("repository_resource_mapping_changed");
  }
  if (input.runId !== undefined) {
    const run = await transaction.query<{ id: string }>(
      `select id from bakery.workflow_runs
        where organization_id = $1 and id = $2 and task_id = $3
          and application_id = (
            select application_id from bakery.tasks
             where organization_id = $1 and id = $3)
          and repository_id = $4
        ${lock ? "for update" : ""}`,
      [organizationId, input.runId, taskId, input.repositoryId],
    );
    if (run.rows[0] === undefined) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
  }
  return {
    organizationId,
    taskId,
    repositoryId: input.repositoryId,
    runId: input.runId ?? null,
    connectionId: row.connection_id,
    installationId: row.installation_id,
    installationExternalId: row.installation_external_id,
    registrationId: row.registration_id,
    resourceId: row.resource_id,
    resourceExternalId: row.resource_external_id,
    displayName: row.display_name,
    connectionStatus: row.connection_status,
    installationStatus: row.installation_status,
  };
}

function sameAuthority(
  expected: RegistrationAuthority,
  current: RegistrationAuthority,
): boolean {
  return expected.organizationId === current.organizationId &&
    expected.taskId === current.taskId &&
    expected.repositoryId === current.repositoryId &&
    expected.runId === current.runId &&
    expected.connectionId === current.connectionId &&
    expected.installationId === current.installationId &&
    expected.installationExternalId === current.installationExternalId &&
    expected.registrationId === current.registrationId &&
    expected.resourceId === current.resourceId &&
    expected.resourceExternalId === current.resourceExternalId &&
    expected.displayName === current.displayName;
}

function samePullRequest(
  expected: GitHubPullRequest,
  current: GitHubPullRequest,
): boolean {
  return expected.number === current.number &&
    expected.state === current.state &&
    expected.merged === current.merged &&
    expected.headSha === current.headSha &&
    expected.baseSha === current.baseSha &&
    expected.mergedSha === current.mergedSha &&
    expected.updatedAt === current.updatedAt &&
    expected.url === current.url &&
    expected.openedAt === current.openedAt &&
    expected.closedAt === current.closedAt &&
    expected.mergedAt === current.mergedAt &&
    expected.additions === current.additions &&
    expected.deletions === current.deletions &&
    expected.changedFiles === current.changedFiles;
}

function providerFailure(error: unknown): StandardError {
  if (error instanceof GitHubReadFailure) {
    if (error.kind === "rate_limited") {
      return new StandardError({
        code: "PROVIDER_QUOTA_EXCEEDED",
        params: {
          retryAfterSeconds: boundRetryAfterSeconds(
            error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS,
          ),
        },
      });
    }
    if (error.kind === "timeout") {
      return new StandardError({ code: "DEPENDENCY_TIMEOUT" });
    }
  }
  return new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
}

async function readPullRequest(
  dependencies: ReconcileDependencies,
  authority: RegistrationAuthority,
  generation: number,
  credentials: Awaited<ReturnType<typeof readAppCredentials>>,
  number: number,
  signal: AbortSignal,
): Promise<PreparedRegistration> {
  const tokenAuthority = {
    connectionId: authority.connectionId,
    generation,
    connection: { status: authority.connectionStatus },
    installation: {
      status: authority.installationStatus,
      externalId: authority.installationExternalId,
      registrationId: authority.registrationId,
    },
    resource: { externalId: authority.resourceExternalId },
    credentials,
  };
  const pullToken = await mintReadToken(
    dependencies,
    tokenAuthority,
    "pull_request",
    signal,
  );
  if (pullToken.kind === "refused") {
    throw stateConflict("provider_read_authority_changed");
  }
  const observedStartedAt = new Date();
  let initial;
  try {
    initial = await dependencies.github.readPullRequest({
      token: pullToken.token,
      fullName: authority.displayName,
      number,
    }, signal);
  } catch (error) {
    forgetFailedToken(
      dependencies,
      authority.connectionId,
      pullToken.token,
      error,
      signal,
    );
    signal.throwIfAborted();
    throw providerFailure(error);
  }
  if ("kind" in initial) {
    if (initial.kind === "moved") {
      throw stateConflict("provider_repository_moved");
    }
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (initial.number !== number) {
    throw stateConflict("provider_pull_request_number_mismatch");
  }

  const checkToken = await mintReadToken(
    dependencies,
    tokenAuthority,
    "check",
    signal,
  );
  if (checkToken.kind === "refused") {
    throw stateConflict("provider_check_authority_changed");
  }
  const checkFacts: RemoteFact[] = [];
  try {
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const readAt = new Date();
      const result = await dependencies.github.listCheckRuns({
        token: checkToken.token,
        fullName: authority.displayName,
        headSha: initial.headSha,
        page,
      }, signal);
      for (const run of result.checkRuns) {
        const fact = checkRunFactOf(
          {
            organizationId: authority.organizationId,
            resourceId: authority.resourceId,
          },
          initial.headSha,
          run,
          readAt,
        );
        if (fact !== null) checkFacts.push(fact);
      }
      if (!result.hasNext) break;
    }
  } catch (error) {
    forgetFailedToken(
      dependencies,
      authority.connectionId,
      checkToken.token,
      error,
      signal,
    );
    signal.throwIfAborted();
    throw providerFailure(error);
  }

  let lineCount: ReturnType<typeof countLines> | null = null;
  if (initial.merged) {
    const files: DiffFile[] = [];
    let listCut = false;
    try {
      for (let page = 1; page <= MAX_LINE_COUNT_PAGES; page++) {
        const result = await dependencies.github.listPullRequestFiles({
          token: pullToken.token,
          fullName: authority.displayName,
          number,
          page,
        }, signal);
        if ("kind" in result) {
          if (result.kind === "moved") {
            throw stateConflict("provider_repository_moved");
          }
          throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
        }
        files.push(...result.items);
        if (!result.hasNext) break;
        if (page === MAX_LINE_COUNT_PAGES) listCut = true;
      }
    } catch (error) {
      forgetFailedToken(
        dependencies,
        authority.connectionId,
        pullToken.token,
        error,
        signal,
      );
      signal.throwIfAborted();
      if (error instanceof StandardError) throw error;
      throw providerFailure(error);
    }
    lineCount = countLines(files, {
      expectedFiles: initial.changedFiles,
      listCut,
    });
  }

  let confirmed;
  try {
    confirmed = await dependencies.github.readPullRequest({
      token: pullToken.token,
      fullName: authority.displayName,
      number,
    }, signal);
  } catch (error) {
    forgetFailedToken(
      dependencies,
      authority.connectionId,
      pullToken.token,
      error,
      signal,
    );
    signal.throwIfAborted();
    throw providerFailure(error);
  }
  if ("kind" in confirmed || !samePullRequest(initial, confirmed)) {
    throw stateConflict("provider_pull_request_changed_during_registration");
  }
  return {
    authority,
    pullRequest: confirmed,
    observedStartedAt,
    checkFacts,
    lineCount,
  };
}

export function createPullRequestRegistrationAuthorityRunner(
  authority: ActionAuthorityRunner,
  dependencies: ReconcileDependencies,
): ActionAuthorityRunner {
  return {
    async run(action, context, input, next) {
      if ((action.name as string) !== "pullRequests.register") {
        return await authority.run(action, context, input, next);
      }
      const parsed = PullRequestRegistrationCreateSchema.parse(input);
      const taskId = taskIdOf(context);
      const metadata = createNormalizedCommandMetadata(
        action,
        context.request,
        context.params,
        parsed,
      );
      const first = await authority.run(
        action,
        context,
        parsed,
        async (authorized) => {
          const replay = await readCompletedCommandReplay({
            context: authorized,
            metadata,
            input: parsed,
          });
          if (replay) {
            return { replay: validateEncodedSuccessResponse(action, replay) };
          }
          const work = requireWorkTransaction(authorized);
          return {
            connectionId: await connectionIdFor(
              work.transaction,
              work.organizationId,
              parsed.repositoryId,
            ),
          };
        },
      ) as
        | { replay: ReturnType<typeof validateEncodedSuccessResponse> }
        | { connectionId: string };
      if ("replay" in first) return first.replay;
      const generation = dependencies.broker.generation(first.connectionId);
      const preparedAuthority = await authority.run(
        action,
        context,
        parsed,
        async (authorized) => {
          const work = requireWorkTransaction(authorized);
          const registrationAuthority = await readRegistrationAuthority(
            work.transaction,
            work.organizationId,
            taskId,
            parsed,
            first.connectionId,
            false,
          );
          return {
            registrationAuthority,
            credentials: await readAppCredentials(work.transaction),
          };
        },
      ) as {
        registrationAuthority: RegistrationAuthority;
        credentials: Awaited<ReturnType<typeof readAppCredentials>>;
      };
      const prepared = await readPullRequest(
        dependencies,
        preparedAuthority.registrationAuthority,
        generation,
        preparedAuthority.credentials,
        parsed.providerNumber,
        context.signal,
      );
      return await authority.run(
        action,
        context,
        parsed,
        (authorized) =>
          next(Object.assign({}, authorized, { registration: prepared })),
      );
    },
  };
}

function preparedRegistration(context: ActionContext): PreparedRegistration {
  const prepared = (context as Partial<PreparedContext>).registration;
  if (prepared === undefined) {
    throw new StandardError({ code: "INTERNAL" });
  }
  return prepared;
}

function toIso(value: string | Date): string {
  return typeof value === "string"
    ? new Date(value).toISOString()
    : value.toISOString();
}

export function createPullRequestRegistrationHandler() {
  return async (
    context: ActionContext,
    input: unknown,
  ): Promise<PullRequestOutput> => {
    const parsed = PullRequestRegistrationCreateSchema.parse(input);
    const work = requireWorkTransaction(context);
    const prepared = preparedRegistration(context);
    const denied = await authorityDeniedAtWrite(work.transaction, {
      organizationId: work.organizationId,
      connectionId: prepared.authority.connectionId,
      installationId: prepared.authority.installationId,
      resourceId: prepared.authority.resourceId,
      purpose: "fact_refresh",
      eventKind: "pull_request",
    });
    if (denied !== null) throw stateConflict(denied);
    const currentAuthority = await readRegistrationAuthority(
      work.transaction,
      work.organizationId,
      taskIdOf(context),
      parsed,
      prepared.authority.connectionId,
      true,
    );
    if (!sameAuthority(prepared.authority, currentAuthority)) {
      throw stateConflict("registration_authority_changed");
    }
    const read = prepared.pullRequest;
    const registered = await registerPullRequest(work.transaction, {
      organizationId: work.organizationId,
      taskId: currentAuthority.taskId,
      repositoryId: currentAuthority.repositoryId,
      providerNumber: read.number,
      url: read.url,
      headSha: read.headSha,
      baseSha: read.baseSha,
      ...(currentAuthority.runId === null
        ? {}
        : { runId: currentAuthority.runId }),
    });
    await observePullRequest(work.transaction, currentAuthority.repositoryId, {
      organizationId: work.organizationId,
      number: read.number,
      state: read.state,
      merged: read.merged,
      url: read.url,
      headSha: read.headSha,
      baseSha: read.baseSha,
      mergedSha: read.mergedSha,
      providerUpdatedAt: new Date(read.updatedAt),
      observedStartedAt: prepared.observedStartedAt,
      openedAt: read.openedAt ? new Date(read.openedAt) : null,
      closedAt: read.closedAt ? new Date(read.closedAt) : null,
      mergedAt: read.mergedAt ? new Date(read.mergedAt) : null,
      additions: read.additions,
      deletions: read.deletions,
      changedFiles: read.changedFiles,
    });
    for (const fact of prepared.checkFacts) {
      await upsertFact(work.transaction, fact);
    }
    if (prepared.lineCount !== null) {
      const count = prepared.lineCount;
      await work.transaction.query(
        `insert into bakery.pull_request_line_counts
           (organization_id, pull_request_id, head_sha, counter_version,
            coverage, added, deleted, counted_files, excluded_files,
            binary_files, categories)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         on conflict (pull_request_id, head_sha, counter_version) do nothing`,
        [
          work.organizationId,
          registered.pullRequest.id,
          read.headSha,
          count.counterVersion,
          count.coverage,
          count.added,
          count.deleted,
          count.countedFiles,
          count.excludedFiles,
          count.binaryFiles,
          JSON.stringify(count.categories),
        ],
      );
    }
    const stored = await work.transaction.query<{
      id: string;
      task_id: string;
      repository_id: string;
      run_id: string | null;
      provider_number: number;
      url: string;
      head_sha: string;
      base_sha: string;
      status: "open" | "merged" | "closed";
      merged_sha: string | null;
      created_at: Date | string;
      updated_at: Date | string;
      version: number;
      target_branch: string;
    }>(
      `select pull_request.id, pull_request.task_id,
              pull_request.repository_id, pull_request.run_id,
              pull_request.provider_number, pull_request.url,
              pull_request.head_sha, pull_request.base_sha,
              pull_request.status, pull_request.merged_sha,
              pull_request.created_at, pull_request.updated_at,
              pull_request.version,
              repository.default_branch as target_branch
         from bakery.pull_requests as pull_request
         join bakery.repositories as repository
           on repository.organization_id = pull_request.organization_id
          and repository.id = pull_request.repository_id
        where pull_request.organization_id = $1 and pull_request.id = $2`,
      [work.organizationId, registered.pullRequest.id],
    );
    const row = stored.rows[0];
    if (row === undefined) throw new StandardError({ code: "INTERNAL" });
    const actor = (context as AuthorizedActionContext)
      .authority as OrganizationActor;
    return {
      id: row.id,
      taskId: row.task_id,
      repositoryId: row.repository_id,
      runId: row.run_id,
      providerNumber: row.provider_number,
      url: row.url,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      status: row.status,
      mergedSha: row.merged_sha,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      version: row.version,
      mayMerge: effectivePermissions(actor).includes("pullRequest:merge"),
      mergeMethod: PULL_REQUEST_MERGE_METHOD,
      targetBranch: row.target_branch,
    };
  };
}
