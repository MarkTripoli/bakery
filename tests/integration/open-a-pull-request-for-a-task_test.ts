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

Deno.test("a task opens a pull request from a pushed branch and registers it, once per branch", async () => {
  const fixture = await openGitHubAppFixture();
  let seed: Awaited<ReturnType<typeof seedTaskAndRepository>> | undefined;
  try {
    const connection = await enabledConnection(fixture, { selected: 1 });
    const resource = connection.selected[0];
    seed = await seedTaskAndRepository(fixture, resource);
    const open = (key: string, body: Record<string, unknown>) =>
      call(
        fixture,
        "POST",
        `/v1/tasks/${seed!.taskId}/pull-requests/open`,
        fixture.developerCookie!,
        {
          body,
          headers: {
            ...orgHeader(seed!.organizationId),
            "Idempotency-Key": key,
          },
        },
      );
    const request = {
      repositoryId: seed.repositoryId,
      headBranch: "bakery/task-feature",
      baseBranch: "main",
      title: "Add the feature",
      body: "What changed and why.",
    };

    fixture.github.failNext("pulls", "server_error");
    const failed = await open(crypto.randomUUID(), request);
    assertEquals(failed.status === 201, false, await failed.clone().text());
    assertEquals(fixture.github.openedPullRequests().length, 0);

    const key = crypto.randomUUID();
    const opened = await open(key, request);
    assertEquals(opened.status, 201, await opened.clone().text());
    const body = await opened.json() as {
      id: string;
      taskId: string;
      repositoryId: string;
      providerNumber: number;
      status: string;
    };
    const created = fixture.github.openedPullRequests();
    assertEquals(created.map((pull) => [pull.head, pull.base, pull.title]), [
      ["bakery/task-feature", "main", "Add the feature"],
    ]);
    assertEquals(
      [body.taskId, body.repositoryId, body.providerNumber, body.status],
      [seed.taskId, seed.repositoryId, created[0]!.number, "open"],
    );

    const replay = await open(key, request);
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals(await replay.json(), body);

    const again = await open(crypto.randomUUID(), request);
    assertEquals(again.status, 201, await again.clone().text());
    assertEquals((await again.json() as { id: string }).id, body.id);
    assertEquals(fixture.github.openedPullRequests().length, 1);

    const stored = await fixture.pgDatabase.query<{ n: number }>(
      `select count(*)::int as n from bakery.pull_requests
        where organization_id = $1 and repository_id = $2`,
      [seed.organizationId, seed.repositoryId],
    );
    assertEquals(stored.rows[0]!.n, 1);
  } finally {
    if (seed) await removeSeed(fixture, seed);
    await fixture.finish();
  }
});

Deno.test("a task cannot open a pull request when the App's token cannot write pull requests", async () => {
  const fixture = await openGitHubAppFixture();
  let seed: Awaited<ReturnType<typeof seedTaskAndRepository>> | undefined;
  try {
    const connection = await enabledConnection(fixture, { selected: 1 });
    seed = await seedTaskAndRepository(fixture, connection.selected[0]);
    fixture.github.failures.downgraded.add(connection.installation.id);
    const refused = await call(
      fixture,
      "POST",
      `/v1/tasks/${seed.taskId}/pull-requests/open`,
      fixture.developerCookie!,
      {
        body: {
          repositoryId: seed.repositoryId,
          headBranch: "bakery/task-feature",
          title: "Add the feature",
        },
        headers: {
          ...orgHeader(seed.organizationId),
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    );
    const text = await refused.text();
    assertEquals(refused.status, 409, text);
    assertEquals(
      (JSON.parse(text) as { reason?: string }).reason,
      "provider_open_authority_missing",
    );
    assertEquals(fixture.github.openedPullRequests().length, 0);
    const stored = await fixture.pgDatabase.query<{ n: number }>(
      `select count(*)::int as n from bakery.pull_requests
        where organization_id = $1 and repository_id = $2`,
      [seed.organizationId, seed.repositoryId],
    );
    assertEquals(stored.rows[0]!.n, 0);
  } finally {
    if (seed) await removeSeed(fixture, seed);
    await fixture.finish();
  }
});

Deno.test("any branch name git accepts opens a pull request; a bad name or title is refused before GitHub", async () => {
  const fixture = await openGitHubAppFixture();
  let seed: Awaited<ReturnType<typeof seedTaskAndRepository>> | undefined;
  try {
    const connection = await enabledConnection(fixture, { selected: 1 });
    seed = await seedTaskAndRepository(fixture, connection.selected[0]);
    const open = (body: Record<string, unknown>) =>
      call(
        fixture,
        "POST",
        `/v1/tasks/${seed!.taskId}/pull-requests/open`,
        fixture.developerCookie!,
        {
          body: { repositoryId: seed!.repositoryId, title: "Change", ...body },
          headers: {
            ...orgHeader(seed!.organizationId),
            "Idempotency-Key": crypto.randomUUID(),
          },
        },
      );
    for (
      const branch of [
        "fix/#123",
        "release+1",
        "dependabot/npm_and_yarn/@types/node-22",
        "rama/año",
      ]
    ) {
      const opened = await open({ headBranch: branch, baseBranch: "main" });
      assertEquals(opened.status, 201, `${branch}: ${await opened.text()}`);
    }
    assertEquals(fixture.github.openedPullRequests().length, 4);
    for (
      const [body, field] of [
        [{ headBranch: "a..b" }, "headBranch"],
        [{ headBranch: "feature", baseBranch: "main.lock" }, "baseBranch"],
        [{ headBranch: "feature", title: "   " }, "title"],
        [{ headBranch: "feature", title: "x".repeat(300) }, "title"],
      ] as const
    ) {
      const refused = await open(body);
      const text = await refused.text();
      assertEquals([400, 422].includes(refused.status), true, text);
      assertEquals(text.includes(field), true, text);
    }
    assertEquals(fixture.github.openedPullRequests().length, 4);
  } finally {
    if (seed) {
      await fixture.pgDatabase.query(
        "delete from bakery.pull_requests where organization_id = $1",
        [seed.organizationId],
      );
      await removeSeed(fixture, seed);
    }
    await fixture.finish();
  }
});
