import { assert, assertEquals, assertRejects } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type {
  GitHubAppClient,
  GitHubMergeOutcome,
  GitHubPullRequest,
} from "../../apps/server/src/modules/integrations/github-app.ts";
import {
  mergePullRequest,
  reconcileMergeAttempts,
} from "../../apps/server/src/modules/delivery/merge-dispatch.ts";
import {
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
} from "../helpers/github-app-registration.ts";
import { fakeRepositories } from "../helpers/fake-github-app.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "2222222222222222222222222222222222222222";
const MERGED = "3333333333333333333333333333333333333333";

type Seed = {
  organizationId: string;
  principalId: string;
  repositoryId: string;
  pullRequestId: string;
  fullName: string;
};

/** A repository, task and pull request bound to the fixture's live connection. */
async function seedPullRequest(
  f: GitHubAppFixture,
  connectionId: string,
  resource: { external_id: string; display_name: string },
): Promise<Seed> {
  const organizationId = f.organizationId;
  const principalId = (await f.pgDatabase.query<{ id: string }>(
    `select principal_id as id from bakery.organization_memberships
      where organization_id = $1 and role = 'admin'
      order by created_at, id limit 1`,
    [organizationId],
  )).rows[0]!.id;
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const pullRequestId = crypto.randomUUID();
  const [owner, name] = resource.display_name.split("/");
  await f.pgDatabase.query(
    `insert into bakery.applications (id,organization_id,slug,name)
     values ($1,$2,$3,'Merge Application')`,
    [applicationId, organizationId, `merge-${applicationId}`],
  );
  await f.pgDatabase.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch, version
     ) values ($1,$2,$3,$4,$5,$6,$7,'main',1)`,
    [
      repositoryId,
      organizationId,
      applicationId,
      connectionId,
      resource.external_id,
      owner,
      name,
    ],
  );
  await f.pgDatabase.query(
    `insert into bakery.conversations (
       id,organization_id,application_id,title,created_by
     ) values ($1,$2,$3,'Merge Conversation',$4)`,
    [conversationId, organizationId, applicationId, principalId],
  );
  await f.pgDatabase.query(
    `insert into bakery.tasks (
       id,organization_id,application_id,conversation_id,title,task_type,
       status,priority,created_by
     ) values ($1,$2,$3,$4,'Merge Task','feature','active',50,$5)`,
    [taskId, organizationId, applicationId, conversationId, principalId],
  );
  await f.pgDatabase.query(
    `insert into bakery.pull_requests (
       id,organization_id,task_id,repository_id,provider_number,url,head_sha,
       base_sha,status,version
     ) values ($1,$2,$3,$4,12,$5,$6,$7,'open',1)`,
    [
      pullRequestId,
      organizationId,
      taskId,
      repositoryId,
      `https://github.com/${resource.display_name}/pull/12`,
      HEAD,
      BASE,
    ],
  );
  return {
    organizationId,
    principalId,
    repositoryId,
    pullRequestId,
    fullName: resource.display_name,
  };
}

type Script = {
  pullRequest: GitHubPullRequest;
  checks: { status: string; conclusion: string | null }[];
  merge: GitHubMergeOutcome;
};

/** A GitHub client that answers the three calls a merge makes, and records them. */
function fakeGitHub(script: Script) {
  const merges: { headSha: string; mergeMethod: string }[] = [];
  const client = {
    readPullRequest: () => Promise.resolve(script.pullRequest),
    listCheckRuns: () =>
      Promise.resolve({
        checkRuns: script.checks.map((run, index) => ({
          id: index + 1,
          name: `check-${index}`,
          headSha: script.pullRequest.headSha,
          status: run.status,
          conclusion: run.conclusion,
          startedAt: null,
          completedAt: null,
          appId: null,
          appSlug: null,
        })),
        hasNext: false,
        totalCount: script.checks.length,
      }),
    mergePullRequest: (request: { headSha: string; mergeMethod: string }) => {
      merges.push({
        headSha: request.headSha,
        mergeMethod: request.mergeMethod,
      });
      return Promise.resolve(script.merge);
    },
  } as unknown as GitHubAppClient;
  return { client, merges };
}

function openPullRequest(overrides: Partial<GitHubPullRequest> = {}) {
  return {
    number: 12,
    state: "open" as const,
    merged: false,
    headSha: HEAD,
    baseSha: BASE,
    mergedSha: null,
    updatedAt: "2026-10-01T00:00:00Z",
    url: "https://github.com/acme/widgets/pull/12",
    ...overrides,
  };
}

function contextOf(
  seed: Seed,
  transaction: unknown,
  pullRequestId = seed.pullRequestId,
): ActionContext {
  return {
    request: new Request(
      `http://test/v1/pull-requests/${pullRequestId}/merge`,
      { headers: { "Bakery-Organization-Id": seed.organizationId } },
    ),
    params: { id: pullRequestId },
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    authority: {
      organizationId: seed.organizationId,
      subject: { principalId: seed.principalId },
    },
    transaction,
  } as unknown as ActionContext;
}

async function withMergeFixture(
  run: (
    f: GitHubAppFixture,
    seed: Seed,
    connectionId: string,
  ) => Promise<void>,
) {
  const f = await openGitHubAppFixture();
  try {
    const { connectionId, selected } = await enabledConnection(f, {
      repositories: fakeRepositories(1, ["admin"]),
      selected: 1,
    });
    const seed = await seedPullRequest(f, connectionId, selected[0]);
    await run(f, seed, connectionId);
  } finally {
    await f.finish();
  }
}

Deno.test("a merge at the exact head is dispatched once and recorded", async () => {
  await withMergeFixture(async (f, seed) => {
    const github = fakeGitHub({
      pullRequest: openPullRequest(),
      checks: [{ status: "completed", conclusion: "success" }],
      merge: { kind: "merged", mergedSha: MERGED },
    });
    const context = contextOf(seed, null);
    const attempt = await withPgTransaction(
      f.pgDatabase,
      (transaction) =>
        mergePullRequest(
          { github: github.client, broker: f.broker },
          { ...context, transaction } as unknown as ActionContext,
          {
            expectedHeadSha: HEAD,
            expectedBaseSha: BASE,
            mergeMethod: "squash",
          },
        ),
    );
    assertEquals(attempt.state, "merged");
    assertEquals(attempt.mergedSha, MERGED);
    assertEquals(attempt.expectedHeadSha, HEAD);
    assert(attempt.settledAt !== null);
    assertEquals(github.merges, [{ headSha: HEAD, mergeMethod: "squash" }]);
    // The durable row carries the platform's own request and trace ids, never
    // a client header or an empty string.
    const audit = (await f.pgDatabase.query<{
      requestId: string;
      traceId: string;
    }>(
      `select request_id as "requestId", trace_id as "traceId"
         from bakery.pull_request_merge_attempts where id = $1`,
      [attempt.id],
    )).rows[0]!;
    assertEquals(audit.requestId, context.requestId);
    assertEquals(audit.traceId, context.traceId);
    assert(audit.requestId !== "" && audit.traceId !== "");
  });
});

Deno.test("a moved head is refused before any provider write", async () => {
  await withMergeFixture(async (f, seed) => {
    const github = fakeGitHub({
      pullRequest: openPullRequest({
        headSha: "9".repeat(40),
      }),
      checks: [{ status: "completed", conclusion: "success" }],
      merge: { kind: "merged", mergedSha: MERGED },
    });
    const error = await assertRejects(
      () =>
        withPgTransaction(f.pgDatabase, (transaction) =>
          mergePullRequest(
            { github: github.client, broker: f.broker },
            contextOf(seed, transaction),
            {
              expectedHeadSha: HEAD,
              expectedBaseSha: BASE,
              mergeMethod: "squash",
            },
          )),
      StandardError,
    );
    assertEquals((error as StandardError).code, "STATE_CONFLICT");
    assertEquals(github.merges.length, 0);
  });
});

Deno.test("an unknown answer is recorded and settled by a read, never resent", async () => {
  await withMergeFixture(async (f, seed) => {
    const github = fakeGitHub({
      pullRequest: openPullRequest(),
      checks: [{ status: "completed", conclusion: "success" }],
      merge: { kind: "unknown" },
    });
    const attempt = await withPgTransaction(
      f.pgDatabase,
      (transaction) =>
        mergePullRequest(
          { github: github.client, broker: f.broker },
          contextOf(seed, transaction),
          {
            expectedHeadSha: HEAD,
            expectedBaseSha: BASE,
            mergeMethod: "squash",
          },
        ),
    );
    assertEquals(attempt.state, "unknown");
    assertEquals(attempt.settledAt, null);
    assertEquals(github.merges.length, 1);

    // The reconciliation reads the pull request and settles the attempt; it
    // never sends a second merge.
    const settled = fakeGitHub({
      pullRequest: openPullRequest({ merged: true, mergedSha: MERGED }),
      checks: [],
      merge: { kind: "merged", mergedSha: MERGED },
    });
    const result = await withPgTransaction(
      f.pgDatabase,
      (transaction) =>
        reconcileMergeAttempts(
          { github: settled.client, broker: f.broker },
          contextOf(seed, transaction),
          { pullRequestId: seed.pullRequestId },
        ),
    );
    assertEquals(result, { reconciled: 1, merged: 1, refused: 0 });
    assertEquals(settled.merges.length, 0);
  });
});
