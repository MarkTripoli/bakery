/**
 * #46 security: authorization runs before any aggregation, and another
 * organization's facts never reach an answer, for every metric including the
 * production delivery metrics, over the real routes and Postgres.
 */

import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "@bakery/persistence/postgres";
import { observePullRequest } from "../../apps/server/src/modules/integrations/pull-requests.ts";
import {
  type GitHubAppFixture,
  openGitHubAppFixture,
} from "../helpers/github-app-registration.ts";
import { call, orgHeader } from "../helpers/account-settings.ts";
import { MetricKey } from "../../apps/server/src/modules/delivery/metrics.ts";

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
const KEYS = Object.values(MetricKey);
/** metrics.sources takes the window without a resolution. */
const juneWindow = "from=2026-06-01T00:00:00Z&to=2026-07-01T00:00:00Z";

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

Deno.test("a guest is refused every metric and every drilldown before anything is aggregated", async () => {
  const f = await openGitHubAppFixture();
  try {
    const other = await otherOrganization(f);
    await f.pgDatabase.query(
      "update bakery.organization_memberships set role = 'guest' where organization_id = $1",
      [other],
    );
    for (const metric of KEYS) {
      for (const path of ["/v1/metrics", "/v1/metrics/sources"]) {
        const refused = await get(
          f,
          `${path}?metric=${metric}&${
            path.endsWith("sources") ? juneWindow : june
          }`,
          other,
        );
        assert(
          refused.status === 403 || refused.status === 404,
          `${path} ${metric}: ${refused.status}`,
        );
        const text = await refused.text();
        assert(!text.includes("points") && !text.includes("items"), text);
      }
    }
  } finally {
    await f.finish();
  }
});

Deno.test("an organization the caller does not belong to answers like one that does not exist", async () => {
  const f = await openGitHubAppFixture();
  try {
    const other = await otherOrganization(f);
    await f.pgDatabase.query(
      "delete from bakery.organization_memberships where organization_id = $1",
      [other],
    );
    for (const metric of [MetricKey.Opened, MetricKey.DeploymentFrequency]) {
      const foreign = await get(
        f,
        `/v1/metrics?metric=${metric}&${june}`,
        other,
      );
      const missing = await get(
        f,
        `/v1/metrics?metric=${metric}&${june}`,
        crypto.randomUUID(),
      );
      assertEquals(foreign.status, missing.status, metric);
      assert(foreign.status === 403 || foreign.status === 404);
      await foreign.body?.cancel();
      await missing.body?.cancel();
    }
  } finally {
    await f.finish();
  }
});

Deno.test("naming another organization's repository adds nothing to any metric or drilldown", async () => {
  const f = await openGitHubAppFixture();
  try {
    const other = await otherOrganization(f);
    const foreign = await seedRepository(f, other, crypto.randomUUID(), "998");
    await seedPullRequest(f, other, foreign, 9);
    await observe(
      f,
      foreign.repositoryId,
      read(other, 9, {
        state: "closed",
        merged: true,
        mergedAt: new Date("2026-06-02T12:00:00Z"),
        closedAt: new Date("2026-06-02T12:00:00Z"),
        additions: 10,
        deletions: 2,
      }),
    );
    for (const metric of KEYS) {
      const series = await ok(
        await get(
          f,
          `/v1/metrics?metric=${metric}&repositoryId=${foreign.repositoryId}&${june}`,
        ),
      );
      assertEquals(series.sampleCount, 0, metric);
      assertEquals(
        (series.repositories as Json[]).some((r) =>
          r.repositoryId === foreign.repositoryId
        ),
        false,
        metric,
      );
      const sources = await ok(
        await get(
          f,
          `/v1/metrics/sources?metric=${metric}&repositoryId=${foreign.repositoryId}&${juneWindow}`,
        ),
      );
      assertEquals((sources.items as Json[]).length, 0, metric);
    }
  } finally {
    await f.finish();
  }
});

Deno.test("production delivery metrics answer unknown with no deploy evidence, even beside merged pull requests", async () => {
  const f = await openGitHubAppFixture();
  try {
    const mine = await seedRepository(
      f,
      f.organizationId,
      crypto.randomUUID(),
      "997",
    );
    await seedPullRequest(f, f.organizationId, mine, 5);
    await observe(
      f,
      mine.repositoryId,
      read(f.organizationId, 5, {
        state: "closed",
        merged: true,
        mergedAt: new Date("2026-06-03T12:00:00Z"),
        closedAt: new Date("2026-06-03T12:00:00Z"),
      }),
    );
    for (
      const metric of [
        MetricKey.DeploymentFrequency,
        MetricKey.ChangeLeadTime,
        MetricKey.ChangeFailRate,
        MetricKey.FailedDeploymentRecovery,
        MetricKey.DeploymentReworkRate,
      ]
    ) {
      const series = await ok(
        await get(f, `/v1/metrics?metric=${metric}&${june}`),
      );
      const points = series.points as {
        value: unknown;
        unknownReason: unknown;
      }[];
      assertEquals(points.length, 30, metric);
      assert(
        points.every((p) =>
          p.value === null && p.unknownReason === "no_deploy_evidence"
        ),
        metric,
      );
      assertEquals(series.completeness, "unknown", metric);
      assertEquals(series.sampleCount, 0, metric);
      const sources = await ok(
        await get(f, `/v1/metrics/sources?metric=${metric}&${juneWindow}`),
      );
      assertEquals((sources.items as Json[]).length, 0, metric);
    }
  } finally {
    await f.finish();
  }
});
