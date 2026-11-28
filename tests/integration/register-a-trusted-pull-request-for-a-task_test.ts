import { assertEquals } from "@std/assert";
import { call, orgHeader } from "../helpers/account-settings.ts";
import {
  enabledConnection,
  openGitHubAppFixture,
} from "../helpers/github-app-registration.ts";
import {
  removeSeed,
  seedTaskAndRepository,
} from "../helpers/github-intake/seed.ts";

Deno.test("a task registers provider-owned pull request state through the authenticated production action", async () => {
  const fixture = await openGitHubAppFixture();
  let seed: Awaited<ReturnType<typeof seedTaskAndRepository>> | undefined;
  try {
    const connection = await enabledConnection(fixture, { selected: 1 });
    const resource = connection.selected[0];
    seed = await seedTaskAndRepository(fixture, resource);
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const mergedSha = "c".repeat(40);
    fixture.github.seedPullRequest(Number(resource.external_id), {
      number: 73,
      state: "closed",
      merged: true,
      headSha,
      baseSha,
      mergedSha,
      additions: 12,
      deletions: 3,
      changedFiles: 1,
      updatedAt: "2026-11-25T09:00:00Z",
    });
    fixture.github.seedCheckRuns(Number(resource.external_id), headSha, [{
      name: "verify",
      status: "completed",
      conclusion: "success",
    }]);
    fixture.github.seedPullRequestFiles(Number(resource.external_id), 73, [{
      filename: "src/feature.ts",
      status: "modified",
      additions: 12,
      deletions: 3,
      patch: "@@ -1 +1 @@\n-old\n+new",
    }]);

    const registration = {
      repositoryId: seed.repositoryId,
      providerNumber: 73,
    };
    const registrationKey = crypto.randomUUID();
    const register = (
      key: string,
      body: Record<string, unknown> = registration,
    ) =>
      call(
        fixture,
        "POST",
        `/v1/tasks/${seed!.taskId}/pull-requests`,
        fixture.developerCookie!,
        {
          body,
          headers: {
            ...orgHeader(seed!.organizationId),
            "Idempotency-Key": key,
          },
        },
      );
    const response = await register(registrationKey);

    assertEquals(response.status, 201, await response.clone().text());
    const body = await response.json();
    assertEquals(
      {
        taskId: body.taskId,
        repositoryId: body.repositoryId,
        runId: body.runId,
        providerNumber: body.providerNumber,
        url: body.url,
        headSha: body.headSha,
        baseSha: body.baseSha,
        status: body.status,
        mergedSha: body.mergedSha,
      },
      {
        taskId: seed.taskId,
        repositoryId: seed.repositoryId,
        runId: null,
        providerNumber: 73,
        url: `https://github.com/${resource.display_name}/pull/73`,
        headSha,
        baseSha,
        status: "merged",
        mergedSha,
      },
    );
    const readsAfterFirst = fixture.github.repositoryReadCalls().length;
    const replay = await register(registrationKey);
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals(await replay.json(), body);
    assertEquals(
      fixture.github.repositoryReadCalls().length,
      readsAfterFirst,
    );
    const mismatch = await register(registrationKey, {
      ...registration,
      providerNumber: 74,
    });
    assertEquals(mismatch.status, 422, await mismatch.clone().text());
    assertEquals(
      (await mismatch.json()).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    assertEquals(
      fixture.github.repositoryReadCalls().length,
      readsAfterFirst,
    );
    const freshKey = await register(crypto.randomUUID());
    assertEquals(freshKey.status, 201, await freshKey.clone().text());
    assertEquals(await freshKey.json(), body);
    const stored = await fixture.pgDatabase.query<{
      pull_requests: number;
      lifecycle: number;
      checks: number;
      line_counts: number;
    }>(
      `select
         (select count(*)::int from bakery.pull_requests
           where organization_id = $1 and repository_id = $2 and provider_number = 73) as pull_requests,
         (select count(*)::int from bakery.pull_request_transitions
           where organization_id = $1 and pull_request_id = $3) as lifecycle,
         (select count(*)::int from bakery.integration_remote_facts
           where organization_id = $1 and resource_id = $4 and kind = 'check_run') as checks,
         (select count(*)::int from bakery.pull_request_line_counts
           where organization_id = $1 and pull_request_id = $3) as line_counts`,
      [seed.organizationId, seed.repositoryId, body.id, resource.id],
    );
    assertEquals(stored.rows[0], {
      pull_requests: 1,
      lifecycle: 2,
      checks: 1,
      line_counts: 1,
    });
    const window =
      "from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z&resolution=day";
    const metric = async (name: string) => {
      const read = await call(
        fixture,
        "GET",
        `/v1/metrics?metric=${name}&${window}`,
        fixture.developerCookie!,
        { headers: orgHeader(seed!.organizationId) },
      );
      assertEquals(read.status, 200, await read.clone().text());
      return await read.json() as {
        points: { value: number | null }[];
      };
    };
    const total = (series: { points: { value: number | null }[] }) =>
      series.points.reduce((sum, point) => sum + (point.value ?? 0), 0);
    assertEquals(total(await metric("prs.merged")), 1);
    assertEquals(total(await metric("prs.changedLines")), 15);
    const sources = await call(
      fixture,
      "GET",
      `/v1/metrics/sources?metric=prs.merged&${
        window.replace("&resolution=day", "")
      }`,
      fixture.developerCookie!,
      { headers: orgHeader(seed.organizationId) },
    );
    assertEquals(sources.status, 200, await sources.clone().text());
    assertEquals(
      ((await sources.json()).items as { id: string }[]).map((row) => row.id),
      [body.id],
    );
    const concurrentHead = "d".repeat(40);
    fixture.github.seedPullRequest(Number(resource.external_id), {
      number: 74,
      state: "open",
      merged: false,
      headSha: concurrentHead,
      baseSha,
      updatedAt: "2026-11-25T09:30:00Z",
    });
    const concurrentRegistration = {
      repositoryId: seed.repositoryId,
      providerNumber: 74,
    };
    const concurrent = await Promise.all([
      register(crypto.randomUUID(), concurrentRegistration),
      register(crypto.randomUUID(), concurrentRegistration),
    ]);
    const concurrentBodies = [];
    for (const result of concurrent) {
      assertEquals(result.status, 201, await result.clone().text());
      concurrentBodies.push(await result.json());
    }
    assertEquals(concurrentBodies[0].id, concurrentBodies[1].id);
    const converged = await fixture.pgDatabase.query<{
      records: number;
      version: number;
    }>(
      `select count(*)::int as records, max(version)::int as version
         from bakery.pull_requests
        where organization_id = $1 and repository_id = $2
          and provider_number = 74`,
      [seed.organizationId, seed.repositoryId],
    );
    assertEquals(converged.rows[0], { records: 1, version: 2 });
  } finally {
    if (seed) await removeSeed(fixture, seed);
    await fixture.finish();
  }
});
