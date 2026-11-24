/**
 * #46 against Postgres and the real routes: lifecycle facts from provider
 * reads (duplicates, reordering, reopen), metrics.get and metrics.sources
 * over them, tenancy (a foreign organization's pull requests never count)
 * and authorization before aggregation (a guest is refused).
 */

import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import { observePullRequest } from "../../apps/server/src/modules/integrations/pull-requests.ts";
import {
  enabledConnection,
  type GitHubAppFixture,
  openGitHubAppFixture,
} from "../helpers/github-app-registration.ts";
import { fakeRepositories } from "../helpers/fake-github-app.ts";
import { call, orgHeader } from "../helpers/account-settings.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
type Json = Record<string, unknown>;

async function seedRepository(
  f: GitHubAppFixture,
  organizationId: string,
  connectionId: string,
  providerRepoId: string,
) {
  const principalId = (await f.pgDatabase.query<{ id: string }>(
    `select principal_id as id from bakery.organization_memberships
      where organization_id = $1 order by created_at, id limit 1`,
    [organizationId],
  )).rows[0]!.id;
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  await f.pgDatabase.query(
    "insert into bakery.applications (id,organization_id,slug,name) values ($1,$2,$3,'Metrics App')",
    [applicationId, organizationId, "metrics-" + applicationId],
  );
  await f.pgDatabase.query(
    `insert into bakery.repositories (id, organization_id, application_id,
       integration_connection_id, provider_repo_id, owner, name,
       default_branch, version)
     values ($1,$2,$3,$4,$5,'acme','widgets','main',1)`,
    [repositoryId, organizationId, applicationId, connectionId, providerRepoId],
  );
  await f.pgDatabase.query(
    "insert into bakery.conversations (id,organization_id,application_id,title,created_by) values ($1,$2,$3,'c',$4)",
    [conversationId, organizationId, applicationId, principalId],
  );
  await f.pgDatabase.query(
    `insert into bakery.tasks (id,organization_id,application_id,conversation_id,
       title,task_type,status,priority,created_by)
     values ($1,$2,$3,$4,'Metrics task','feature','active',50,$5)`,
    [taskId, organizationId, applicationId, conversationId, principalId],
  );
  return { repositoryId, taskId };
}

async function seedPullRequest(
  f: GitHubAppFixture,
  organizationId: string,
  repo: { repositoryId: string; taskId: string },
  number: number,
) {
  const id = crypto.randomUUID();
  await f.pgDatabase.query(
    `insert into bakery.pull_requests (id,organization_id,task_id,repository_id,
       provider_number,url,head_sha,base_sha,status,version)
     values ($1,$2,$3,$4,$5,$6,$7,$7,'open',1)`,
    [
      id,
      organizationId,
      repo.taskId,
      repo.repositoryId,
      number,
      "https://github.com/acme/widgets/pull/" + number,
      SHA,
    ],
  );
  return id;
}

function read(
  organizationId: string,
  number: number,
  over: Partial<Parameters<typeof observePullRequest>[2]> = {},
): Parameters<typeof observePullRequest>[2] {
  return {
    organizationId,
    number,
    state: "open",
    merged: false,
    url: "https://github.com/acme/widgets/pull/" + number,
    headSha: SHA,
    baseSha: SHA,
    mergedSha: null,
    providerUpdatedAt: new Date("2026-06-01T12:00:00Z"),
    observedStartedAt: new Date(),
    openedAt: new Date("2026-06-01T12:00:00Z"),
    closedAt: null,
    mergedAt: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    ...over,
  };
}

function observe(
  f: GitHubAppFixture,
  repositoryId: string,
  observation: Parameters<typeof observePullRequest>[2],
) {
  return withPgTransaction(
    f.pgDatabase,
    (tx) => observePullRequest(tx, repositoryId, observation),
  );
}

async function get(f: GitHubAppFixture, path: string, organizationId?: string) {
  return await call(f, "GET", path, f.adminCookie, {
    headers: orgHeader(organizationId ?? f.organizationId),
  });
}

async function ok(response: Response): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, 200, text);
  return JSON.parse(text) as Json;
}

const june = "from=2026-06-01T00:00:00Z&to=2026-07-01T00:00:00Z&resolution=day";
const sum = (series: Json) =>
  (series.points as { value: number | null }[]).reduce(
    (s, p) => s + (p.value ?? 0),
    0,
  );

Deno.test("lifecycle facts dedupe, a reopen is one pull request, and the June numbers add up", async () => {
  const f = await openGitHubAppFixture();
  try {
    const { connectionId, selected } = await enabledConnection(f, {
      repositories: fakeRepositories(1, ["admin"]),
      selected: 1,
    });
    const repo = await seedRepository(
      f,
      f.organizationId,
      connectionId,
      selected[0].external_id,
    );
    const a = await seedPullRequest(f, f.organizationId, repo, 1);
    const b = await seedPullRequest(f, f.organizationId, repo, 2);
    const bOpened = new Date("2026-06-02T12:00:00Z");

    // A: merged June 3, read twice (a webhook delivered twice), then an
    // older open read arrives late.
    const mergedRead = read(f.organizationId, 1, {
      state: "closed",
      merged: true,
      mergedSha: SHA,
      providerUpdatedAt: new Date("2026-06-03T12:00:00Z"),
      closedAt: new Date("2026-06-03T12:00:00Z"),
      mergedAt: new Date("2026-06-03T12:00:00Z"),
      additions: 5,
      deletions: 2,
      changedFiles: 1,
    });
    assertEquals(await observe(f, repo.repositoryId, mergedRead), "written");
    assertEquals(
      await observe(f, repo.repositoryId, {
        ...mergedRead,
        observedStartedAt: new Date(),
      }),
      "unchanged",
    );
    assertEquals(
      await observe(f, repo.repositoryId, read(f.organizationId, 1)),
      "stale",
    );

    await observe(
      f,
      repo.repositoryId,
      read(f.organizationId, 2, { openedAt: bOpened }),
    );
    await observe(
      f,
      repo.repositoryId,
      read(f.organizationId, 2, {
        state: "closed",
        providerUpdatedAt: new Date("2026-06-05T00:00:00Z"),
        openedAt: bOpened,
        closedAt: new Date("2026-06-05T00:00:00Z"),
      }),
    );
    await observe(
      f,
      repo.repositoryId,
      read(f.organizationId, 2, {
        providerUpdatedAt: new Date("2026-06-10T00:00:00Z"),
        openedAt: bOpened,
      }),
    );

    const facts = await f.pgDatabase.query<
      { pull_request_id: string; kind: string }
    >(
      `select pull_request_id, kind from bakery.pull_request_transitions
        where organization_id = $1 order by pull_request_id, effective_at, kind`,
      [f.organizationId],
    );
    assertEquals(
      facts.rows.filter((r) => r.pull_request_id === a).map((r) => r.kind),
      ["opened", "merged"],
    );
    assertEquals(
      facts.rows.filter((r) => r.pull_request_id === b).map((r) => r.kind),
      ["opened", "closed", "reopened"],
    );
    const stored = (await f.pgDatabase.query<{ merged_at: Date | null }>(
      "select merged_at from bakery.pull_requests where id = $1",
      [a],
    )).rows[0];
    assertEquals(stored.merged_at?.toISOString(), "2026-06-03T12:00:00.000Z");

    const opened = await ok(
      await get(f, "/v1/metrics?metric=prs.opened&" + june),
    );
    assertEquals(sum(opened), 2);
    assertEquals(opened.unit, "count");
    assertEquals(opened.sampleCount, 2);
    assert(String(opened.measurementRevision).startsWith("prs.opened@"));
    assertEquals(opened.hiddenCount, 0);
    assertEquals(
      (opened.repositories as Json[]).map((r) => r.repositoryId),
      [repo.repositoryId],
    );
    assert(typeof opened.lastSyncAt === "string");

    const merged = await ok(
      await get(f, "/v1/metrics?metric=prs.merged&" + june),
    );
    assertEquals(sum(merged), 1);
    const closed = await ok(
      await get(f, "/v1/metrics?metric=prs.closedUnmerged&" + june),
    );
    // B was closed, then reopened: it is open now, not a final close.
    assertEquals(sum(closed), 0);
    const lines = await ok(
      await get(f, "/v1/metrics?metric=prs.changedLines&" + june),
    );
    assertEquals(sum(lines), 7);
    const rate = await ok(
      await get(f, "/v1/metrics?metric=prs.mergeRate&" + june),
    );
    assertEquals(rate.missingReasons, [{ reason: "still_open", count: 1 }]);

    // The records behind prs.opened, one per page.
    const first = await ok(
      await get(
        f,
        "/v1/metrics/sources?metric=prs.opened&limit=1&" +
          june.replace("&resolution=day", ""),
      ),
    );
    assertEquals((first.items as Json[]).length, 1);
    assert(typeof first.nextCursor === "string");
    const second = await ok(
      await get(
        f,
        "/v1/metrics/sources?metric=prs.opened&limit=1&" +
          june.replace("&resolution=day", "") + "&cursor=" +
          encodeURIComponent(first.nextCursor as string),
      ),
    );
    assertEquals(second.nextCursor, null);
    const sourceRows = [
      ...(first.items as Json[]),
      ...(second.items as Json[]),
    ];
    assertEquals(sourceRows.map((row) => row.id), [b, a]);
    assertEquals(sourceRows.map((row) => row.title), [
      "Metrics task",
      "Metrics task",
    ]);
  } finally {
    await f.finish();
  }
});

Deno.test("another organization's pull requests never count, and a guest is refused before aggregation", async () => {
  const f = await openGitHubAppFixture();
  try {
    const created = await call(f, "POST", "/v1/organizations", f.adminCookie, {
      body: {
        name: "Other Org",
        slug: "other-" + crypto.randomUUID().slice(0, 8),
      },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    assertEquals(created.status, 201, await created.clone().text());
    const other = (await created.json() as { id: string }).id;
    // No connection in that organization: any id (no foreign key) reads as
    // a disconnected source.
    const foreign = await seedRepository(f, other, crypto.randomUUID(), "999");
    await seedPullRequest(f, other, foreign, 7);
    await observe(f, foreign.repositoryId, read(other, 7));

    // In my organization: nothing, and naming the foreign repository adds nothing.
    for (
      const path of [
        "/v1/metrics?metric=prs.opened&" + june,
        "/v1/metrics?metric=prs.opened&repositoryId=" + foreign.repositoryId +
        "&" + june,
      ]
    ) {
      const mine = await ok(await get(f, path));
      assertEquals(mine.sampleCount, 0);
      assertEquals(
        (mine.repositories as Json[]).some((r) =>
          r.repositoryId === foreign.repositoryId
        ),
        false,
      );
    }
    // In the other organization it counts.
    const theirs = await ok(
      await get(f, "/v1/metrics?metric=prs.opened&" + june, other),
    );
    assertEquals(sum(theirs), 1);

    await f.pgDatabase.query(
      "update bakery.organization_memberships set role = 'guest' where organization_id = $1",
      [other],
    );
    const refused = await get(
      f,
      "/v1/metrics?metric=prs.opened&" + june,
      other,
    );
    assert(
      refused.status === 403 || refused.status === 404,
      String(refused.status),
    );
    await refused.body?.cancel();
  } finally {
    await f.finish();
  }
});

async function otherOrganization(f: GitHubAppFixture): Promise<string> {
  const created = await call(f, "POST", "/v1/organizations", f.adminCookie, {
    body: {
      name: "Other Org",
      slug: "other-" + crypto.randomUUID().slice(0, 8),
    },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  assertEquals(created.status, 201, await created.clone().text());
  return (await created.json() as { id: string }).id;
}

Deno.test("another organization's delivered task never counts toward my lead time", async () => {
  const f = await openGitHubAppFixture();
  try {
    const other = await otherOrganization(f);
    const principalId = (await f.pgDatabase.query<{ id: string }>(
      "select principal_id as id from bakery.organization_memberships where organization_id = $1 order by created_at, id limit 1",
      [other],
    )).rows[0]!.id;
    const job = await seedEligibleNonmodelJob(f.pgDatabase, other, principalId);
    await f.pgDatabase.query(
      "update bakery.workflow_runs set created_at = $2, status = 'completed', finished_at = $3 where id = $1",
      [
        job.runId,
        new Date("2026-06-10T00:00:00Z"),
        new Date("2026-06-10T10:00:00Z"),
      ],
    );
    await f.pgDatabase.query(
      "update bakery.tasks set status = 'completed' where id = $1",
      [job.taskId],
    );
    const known = (s: Json) =>
      (s.points as { value: number | null }[]).filter((p) => p.value !== null)
        .length;
    const path = "/v1/metrics?metric=tasks.leadTimeHours&" + june;
    assertEquals(
      known(await ok(await get(f, path, other))),
      1,
      "control: it counts in its own organization",
    );
    assertEquals(
      known(await ok(await get(f, path))),
      0,
      "a foreign task counted in mine",
    );
    const sources = "/v1/metrics/sources?metric=tasks.leadTimeHours&" +
      june.replace("&resolution=day", "");
    assertEquals(
      ((await ok(await get(f, sources, other))).items as Json[]).length,
      1,
    );
    assertEquals(((await ok(await get(f, sources))).items as Json[]).length, 0);
  } finally {
    await f.finish();
  }
});

Deno.test("a later read without totals or merge time does not erase what is known", async () => {
  const f = await openGitHubAppFixture();
  try {
    const { connectionId, selected } = await enabledConnection(f, {
      repositories: fakeRepositories(1, ["admin"]),
      selected: 1,
    });
    const repo = await seedRepository(
      f,
      f.organizationId,
      connectionId,
      selected[0].external_id,
    );
    const id = await seedPullRequest(f, f.organizationId, repo, 1);
    const mergedRead = read(f.organizationId, 1, {
      state: "closed",
      merged: true,
      mergedSha: SHA,
      providerUpdatedAt: new Date("2026-06-03T12:00:00Z"),
      closedAt: new Date("2026-06-03T12:00:00Z"),
      mergedAt: new Date("2026-06-03T12:00:00Z"),
      additions: 5,
      deletions: 2,
      changedFiles: 1,
    });
    assertEquals(await observe(f, repo.repositoryId, mergedRead), "written");
    // The same state read again later, without diff totals: totals stay.
    await observe(f, repo.repositoryId, {
      ...mergedRead,
      additions: null,
      deletions: null,
      changedFiles: null,
      observedStartedAt: new Date(Date.now() + 1000),
    });
    assertEquals(
      sum(
        await ok(await get(f, "/v1/metrics?metric=prs.changedLines&" + june)),
      ),
      7,
    );
    // A newer read without a merge time never clears the recorded merge.
    await observe(
      f,
      repo.repositoryId,
      read(f.organizationId, 1, {
        state: "closed",
        merged: false,
        providerUpdatedAt: new Date("2026-06-04T12:00:00Z"),
        closedAt: new Date("2026-06-04T12:00:00Z"),
        mergedAt: null,
      }),
    );
    const stored = (await f.pgDatabase.query<
      { merged_at: Date | null; additions: number | null }
    >(
      "select merged_at, additions from bakery.pull_requests where id = $1",
      [id],
    )).rows[0];
    assertEquals(stored.merged_at?.toISOString(), "2026-06-03T12:00:00.000Z");
    assertEquals(stored.additions, 5);
  } finally {
    await f.finish();
  }
});

Deno.test("a closed read without a close time keeps the stored one; a reopen clears it", async () => {
  const f = await openGitHubAppFixture();
  try {
    const { connectionId, selected } = await enabledConnection(f, {
      repositories: fakeRepositories(1, ["admin"]),
      selected: 1,
    });
    const repo = await seedRepository(
      f,
      f.organizationId,
      connectionId,
      selected[0].external_id,
    );
    const id = await seedPullRequest(f, f.organizationId, repo, 1);
    const closedAt = async () =>
      (await f.pgDatabase.query<{ closed_at: Date | null }>(
        "select closed_at from bakery.pull_requests where id = $1",
        [id],
      )).rows[0].closed_at?.toISOString() ?? null;
    const closedRead = read(f.organizationId, 1, {
      state: "closed",
      merged: false,
      providerUpdatedAt: new Date("2026-06-03T12:00:00Z"),
      closedAt: new Date("2026-06-03T12:00:00Z"),
      mergedAt: null,
    });
    assertEquals(await observe(f, repo.repositoryId, closedRead), "written");
    assertEquals(await closedAt(), "2026-06-03T12:00:00.000Z");
    // The same closed state read again later, without a close time.
    await observe(f, repo.repositoryId, {
      ...closedRead,
      closedAt: null,
      observedStartedAt: new Date(Date.now() + 1000),
    });
    assertEquals(await closedAt(), "2026-06-03T12:00:00.000Z");
    // A later close (a reopen Bakery never saw) replaces the stored time.
    await observe(f, repo.repositoryId, {
      ...closedRead,
      providerUpdatedAt: new Date("2026-06-05T12:00:00Z"),
      closedAt: new Date("2026-06-05T12:00:00Z"),
      observedStartedAt: new Date(Date.now() + 2000),
    });
    assertEquals(await closedAt(), "2026-06-05T12:00:00.000Z");
    // A reopen is the only read that clears it.
    await observe(
      f,
      repo.repositoryId,
      read(f.organizationId, 1, {
        state: "open",
        merged: false,
        providerUpdatedAt: new Date("2026-06-06T12:00:00Z"),
        closedAt: null,
        mergedAt: null,
      }),
    );
    assertEquals(await closedAt(), null);
  } finally {
    await f.finish();
  }
});

Deno.test("loc.changedLines reads the current count of the merged head only, and the drilldown carries the count as evidence", async () => {
  const f = await openGitHubAppFixture();
  try {
    const { connectionId, selected } = await enabledConnection(f, {
      repositories: fakeRepositories(1, ["admin"]),
      selected: 1,
    });
    const repo = await seedRepository(
      f,
      f.organizationId,
      connectionId,
      selected[0].external_id,
    );
    const merged = (over: Partial<Parameters<typeof observePullRequest>[2]>) =>
      read(f.organizationId, 0, {
        state: "closed",
        merged: true,
        mergedSha: SHA,
        providerUpdatedAt: new Date("2026-06-03T12:00:00Z"),
        closedAt: new Date("2026-06-03T12:00:00Z"),
        mergedAt: new Date("2026-06-03T12:00:00Z"),
        additions: 9000,
        deletions: 1,
        changedFiles: 3,
        ...over,
      });
    const ids: string[] = [];
    for (const number of [1, 2, 3]) {
      ids.push(await seedPullRequest(f, f.organizationId, repo, number));
      await observe(f, repo.repositoryId, merged({ number }));
    }
    const insert = (
      id: string,
      head: string,
      version: string,
      coverage: string,
      added: number,
    ) =>
      f.pgDatabase.query(
        `insert into bakery.pull_request_line_counts
           (organization_id, pull_request_id, head_sha, counter_version,
            coverage, added, deleted, counted_files, excluded_files,
            binary_files, categories)
         values ($1,$2,$3,$4,$5,$6,0,1,1,0,$7::jsonb)`,
        [
          f.organizationId,
          id,
          head,
          version,
          coverage,
          added,
          JSON.stringify([{ category: "source", added, deleted: 0, files: 1 }]),
        ],
      );
    // #1: a complete count of its head, plus an older version and an old head
    // that must never be read. #2: a binary count. #3: no count.
    await insert(ids[0], SHA, "loc-1", "complete", 12);
    await insert(ids[0], SHA, "loc-0", "complete", 999);
    await insert(ids[0], "f".repeat(40), "loc-1", "complete", 555);
    await insert(ids[1], SHA, "loc-1", "binary", 7);

    const lines = await ok(
      await get(f, "/v1/metrics?metric=loc.changedLines&" + june),
    );
    assertEquals(sum(lines), 12);
    assertEquals(lines.unit, "lines");
    assertEquals(lines.sampleCount, 1);
    assertEquals(lines.missingReasons, [
      { reason: "line_count_binary", count: 1 },
      { reason: "no_line_count", count: 1 },
    ]);

    const sources = await ok(
      await get(
        f,
        "/v1/metrics/sources?metric=loc.changedLines&" +
          june.replace("&resolution=day", ""),
      ),
    );
    const byId = new Map(
      (sources.items as Json[]).map((item) => [item.id as string, item]),
    );
    assertEquals(byId.get(ids[0])!.value, 12);
    assertEquals(byId.get(ids[0])!.lineCount, {
      counterVersion: "loc-1",
      coverage: "complete",
      added: 12,
      deleted: 0,
      countedFiles: 1,
      excludedFiles: 1,
      binaryFiles: 0,
      categories: [{ category: "source", added: 12, deleted: 0, files: 1 }],
    });
    assertEquals(
      [byId.get(ids[1])!.value, byId.get(ids[1])!.missingReason],
      [null, "line_count_binary"],
    );
    assertEquals(
      [byId.get(ids[2])!.lineCount, byId.get(ids[2])!.missingReason],
      [null, "no_line_count"],
    );
  } finally {
    await f.finish();
  }
});
