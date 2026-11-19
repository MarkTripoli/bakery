import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { z } from "zod";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type AppCredentials,
  readAppCredentials,
} from "../integrations/callbacks.ts";
import {
  type GitHubAppClient,
  type GitHubMergeMethod,
  GitHubReadFailure,
} from "../integrations/github-app.ts";
import type {
  InstallationTokenBroker,
  TokenTarget,
} from "../integrations/token-broker.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  checksPassed,
  decideMerge,
  type MergeObservation,
  type MergeRefusalReason,
} from "./merge-candidate.ts";
import {
  lockMergeTarget,
  type MergeAttempt,
  type MergeAttemptTarget,
  recordMergeAttempt,
  settleMergeAttempt,
  unknownMergeAttempts,
} from "./merge-attempts.ts";
import { settleEntriesOfPullRequest } from "./merge-entries.ts";

/**
 * The live merge dispatch (#40, B10.04). The action re-reads the pull request
 * from GitHub, decides with the pure rule, and records the attempt in the same
 * transaction that sends it. A lost answer is recorded as `unknown` and settled
 * by a later read, never by a second dispatch.
 */

/** The GitHub permissions a merge needs: read the candidate, write the merge. */
const MERGE_PERMISSIONS = {
  metadata: "read",
  contents: "write",
} as const;

/** A merge reads at most this many pages of check runs before refusing. */
const MAX_CHECK_PAGES = 20;

export type MergeDispatchDependencies = {
  github: GitHubAppClient;
  broker: InstallationTokenBroker;
};

type PullRequestRow = {
  id: string;
  repositoryId: string;
  providerNumber: number;
  headSha: string;
  baseSha: string;
  status: string;
  mergedSha: string | null;
};

type RepositoryRow = {
  owner: string;
  name: string;
  defaultBranch: string;
  connectionId: string;
  providerRepoId: string;
};

type ConnectionRow = {
  status: string;
  installationId: string;
};

type InstallationRow = {
  status: string;
  externalId: string;
  registrationId: string;
};

type MergeAuthority = {
  organizationId: string;
  pullRequest: PullRequestRow;
  repository: RepositoryRow;
  connection: ConnectionRow;
  installation: InstallationRow;
  credentials: AppCredentials | null;
};

/**
 * Loads the pull request, its repository, the connection and installation that
 * own it, and the App credentials, in the caller's transaction. A pull request
 * whose repository is archived or whose connection is gone is not found.
 */
async function loadMergeAuthority(
  transaction: PgTransactionClient,
  organizationId: string,
  pullRequestId: string,
): Promise<MergeAuthority> {
  const pullRequest = (await transaction.query<PullRequestRow>(
    `select id, repository_id as "repositoryId",
       provider_number as "providerNumber", head_sha as "headSha",
       base_sha as "baseSha", status, merged_sha as "mergedSha"
       from bakery.pull_requests
      where organization_id = $1 and id = $2`,
    [organizationId, pullRequestId],
  )).rows[0];
  if (!pullRequest) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const repository = (await transaction.query<RepositoryRow>(
    `select owner, name, default_branch as "defaultBranch",
       integration_connection_id as "connectionId",
       provider_repo_id as "providerRepoId"
       from bakery.repositories
      where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, pullRequest.repositoryId],
  )).rows[0];
  if (!repository) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const connection = (await transaction.query<ConnectionRow>(
    `select status, installation_id as "installationId"
       from bakery.integration_connections
      where organization_id = $1 and id = $2 and archived_at is null`,
    [organizationId, repository.connectionId],
  )).rows[0];
  if (!connection) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const installation = (await transaction.query<InstallationRow>(
    `select status, external_authorization_id as "externalId",
       registration_id as "registrationId"
       from bakery.integration_installations
      where id = $1`,
    [connection.installationId],
  )).rows[0];
  if (!installation) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return {
    organizationId,
    pullRequest,
    repository,
    connection,
    installation,
    credentials: await readAppCredentials(transaction),
  };
}

/**
 * Mints a token narrowed to the one repository and the merge permissions. A
 * connection or installation that is not enabled, or one edited since the
 * generation was captured, is refused before GitHub is called.
 */
async function mintMergeToken(
  broker: InstallationTokenBroker,
  authority: MergeAuthority,
  generation: number,
  signal: AbortSignal,
): Promise<string> {
  const { credentials, installation, repository, connection } = authority;
  if (
    credentials === null ||
    credentials.registrationId !== installation.registrationId
  ) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  const target: TokenTarget = {
    connectionId: repository.connectionId,
    generation,
    status: connection.status,
    installationStatus: installation.status,
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    installationId: Number(installation.externalId),
    repositoryIds: [Number(repository.providerRepoId)],
    permissions: { ...MERGE_PERMISSIONS },
  };
  const minted = await broker.token(target, signal);
  if (minted.kind === "refused") {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return minted.token;
}

/** A provider read failure is a dependency outage, never a merge decision. */
function asDependencyFailure(error: unknown): never {
  if (error instanceof GitHubReadFailure) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  throw error;
}

/** Every check run on the head, or `null` when the list is too long to trust. */
async function readChecksPassed(
  github: GitHubAppClient,
  token: string,
  fullName: string,
  headSha: string,
  signal: AbortSignal,
): Promise<boolean | null> {
  const runs: { status: string; conclusion: string | null }[] = [];
  for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
    const answer = await github.listCheckRuns(
      { token, fullName, headSha, page },
      signal,
    );
    for (const run of answer.checkRuns) {
      runs.push({ status: run.status, conclusion: run.conclusion });
    }
    if (!answer.hasNext) return checksPassed(runs);
  }
  // A list this long is not proven: refuse rather than merge over a check the
  // read never reached.
  return null;
}

function fullNameOf(repository: RepositoryRow): string {
  return `${repository.owner}/${repository.name}`;
}

function attemptTarget(
  authority: MergeAuthority,
  input: z.output<typeof contractSchemas.PullRequestMerge>,
  principalId: string,
  requestId: string,
  traceId: string,
): MergeAttemptTarget {
  return {
    organizationId: authority.organizationId,
    pullRequestId: authority.pullRequest.id,
    repositoryId: authority.pullRequest.repositoryId,
    providerNumber: authority.pullRequest.providerNumber,
    baseBranch: authority.repository.defaultBranch,
    expectedHeadSha: input.expectedHeadSha,
    expectedBaseSha: input.expectedBaseSha ?? null,
    mergeMethod: input.mergeMethod as GitHubMergeMethod,
    requestedById: principalId,
    requestId,
    traceId,
  };
}

/** Who a dispatch is for, and the request it belongs to. */
export type MergeDispatchParams = {
  organizationId: string;
  principalId: string;
  pullRequestId: string;
  requestId: string;
  traceId: string;
  signal: AbortSignal;
};

/**
 * What one dispatch came to: an attempt recorded (merged, refused by GitHub, or
 * unknown), or a refusal before anything was sent, with the reason.
 */
export type MergeDispatchResult =
  | { kind: "attempt"; attempt: MergeAttempt }
  | { kind: "refused"; reason: MergeRefusalReason };

/**
 * Dispatches one merge at the exact head the caller verified. The advisory lock
 * is taken before the live read, so two callers can never both verify the same
 * candidate and both send a merge. Shared by the action and the merge queue, so
 * both decide and record the same way.
 */
export async function dispatchMerge(
  dependencies: MergeDispatchDependencies,
  transaction: PgTransactionClient,
  params: MergeDispatchParams,
  input: z.output<typeof contractSchemas.PullRequestMerge>,
): Promise<MergeDispatchResult> {
  const { organizationId, principalId, signal } = params;
  const authority = await loadMergeAuthority(
    transaction,
    organizationId,
    params.pullRequestId,
  );
  const generation = dependencies.broker.generation(
    authority.repository.connectionId,
  );
  await lockMergeTarget(transaction, {
    organizationId,
    repositoryId: authority.pullRequest.repositoryId,
    baseBranch: authority.repository.defaultBranch,
  });
  const token = await mintMergeToken(
    dependencies.broker,
    authority,
    generation,
    signal,
  );
  const fullName = fullNameOf(authority.repository);
  let observed: MergeObservation;
  try {
    const pullRequest = await dependencies.github.readPullRequest(
      {
        token,
        fullName,
        number: authority.pullRequest.providerNumber,
      },
      signal,
    );
    if ("kind" in pullRequest) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const passed = await readChecksPassed(
      dependencies.github,
      token,
      fullName,
      pullRequest.headSha,
      signal,
    );
    observed = {
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      state: pullRequest.state,
      merged: pullRequest.merged,
      mergedSha: pullRequest.mergedSha,
      checksPassed: passed === true,
    };
  } catch (error) {
    asDependencyFailure(error);
  }
  const decision = decideMerge(
    {
      expectedHeadSha: input.expectedHeadSha,
      expectedBaseSha: input.expectedBaseSha ?? null,
      mergeMethod: input.mergeMethod as GitHubMergeMethod,
    },
    observed,
  );
  const target = attemptTarget(
    authority,
    input,
    principalId,
    params.requestId,
    params.traceId,
  );
  if (decision.kind === "already_merged") {
    return {
      kind: "attempt",
      attempt: await recordMergeAttempt(transaction, target, {
        kind: "merged",
        mergedSha: decision.mergedSha,
      }),
    };
  }
  if (decision.kind === "refused") {
    return { kind: "refused", reason: decision.reason };
  }
  const outcome = await dependencies.github.mergePullRequest(
    {
      token,
      fullName,
      number: authority.pullRequest.providerNumber,
      headSha: decision.headSha,
      mergeMethod: input.mergeMethod as GitHubMergeMethod,
    },
    signal,
  );
  return {
    kind: "attempt",
    attempt: await recordMergeAttempt(transaction, target, outcome),
  };
}

/** The action: dispatches for the caller and answers a refusal as a problem. */
export async function mergePullRequest(
  dependencies: MergeDispatchDependencies,
  context: ActionContext,
  input: z.output<typeof contractSchemas.PullRequestMerge>,
): Promise<MergeAttempt> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const result = await dispatchMerge(dependencies, transaction, {
    organizationId,
    principalId,
    pullRequestId: context.params.id,
    requestId: context.requestId,
    traceId: context.traceId,
    signal: context.signal,
  }, input);
  if (result.kind === "refused") {
    throw new StandardError({
      code: result.reason === "checks_not_passed"
        ? "UNPROCESSABLE"
        : "STATE_CONFLICT",
    });
  }
  return result.attempt;
}

/**
 * Settles every unknown attempt of one pull request from a live read. A merge
 * that happened is recorded as merged; one that did not is recorded as refused.
 * Nothing is ever sent, so a lost answer can never become a second merge.
 */
export async function reconcileMergeAttempts(
  dependencies: MergeDispatchDependencies,
  context: ActionContext,
  input: z.output<typeof contractSchemas.MergeAttemptReconcile>,
): Promise<z.output<typeof contractSchemas.MergeReconciliation>> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const signal = context.signal;
  const unknown = await unknownMergeAttempts(
    transaction,
    organizationId,
    input.pullRequestId,
  );
  if (unknown.length === 0) {
    return { reconciled: 0, merged: 0, refused: 0 };
  }
  const authority = await loadMergeAuthority(
    transaction,
    organizationId,
    input.pullRequestId,
  );
  const generation = dependencies.broker.generation(
    authority.repository.connectionId,
  );
  const token = await mintMergeToken(
    dependencies.broker,
    authority,
    generation,
    signal,
  );
  let pullRequest;
  try {
    pullRequest = await dependencies.github.readPullRequest(
      {
        token,
        fullName: fullNameOf(authority.repository),
        number: authority.pullRequest.providerNumber,
      },
      signal,
    );
  } catch (error) {
    asDependencyFailure(error);
  }
  if ("kind" in pullRequest) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const outcome = pullRequest.merged
    ? { kind: "merged" as const, mergedSha: pullRequest.mergedSha }
    : { kind: "refused" as const, status: 200 };
  let merged = 0;
  let refused = 0;
  for (const attempt of unknown) {
    const settled = await settleMergeAttempt(transaction, {
      organizationId,
      attemptId: attempt.id,
      outcome,
    });
    if (settled.state === "merged") merged += 1;
    else refused += 1;
  }
  // The entry waiting on that outcome finishes with it; nothing is sent.
  await settleEntriesOfPullRequest(
    transaction,
    organizationId,
    input.pullRequestId,
    merged > 0 ? "merged" : "refused",
  );
  return { reconciled: unknown.length, merged, refused };
}
