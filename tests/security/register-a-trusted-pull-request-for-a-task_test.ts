import { assertEquals, assertNotEquals } from "@std/assert";
import { call, orgHeader } from "../helpers/account-settings.ts";
import {
  enabledConnection,
  openGitHubAppFixture,
} from "../helpers/github-app-registration.ts";
import {
  removeSeed,
  seedTaskAndRepository,
} from "../helpers/github-intake/seed.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";

Deno.test("registration rejects cross-repository, cross-run, cross-task and cross-tenant bindings", async () => {
  const fixture = await openGitHubAppFixture();
  let own: Awaited<ReturnType<typeof seedTaskAndRepository>> | undefined;
  let foreign: Awaited<ReturnType<typeof seedTaskAndRepository>> | undefined;
  const secondConversationId = crypto.randomUUID();
  const secondTaskId = crypto.randomUUID();
  try {
    const connection = await enabledConnection(fixture, { selected: 2 });
    const [ownResource, foreignResource] = connection.selected;
    own = await seedTaskAndRepository(fixture, ownResource);
    foreign = await seedTaskAndRepository(fixture, foreignResource);
    const headSha = "1".repeat(40);
    const baseSha = "2".repeat(40);
    fixture.github.seedPullRequest(Number(ownResource.external_id), {
      number: 81,
      headSha,
      baseSha,
      updatedAt: "2026-11-25T09:00:00Z",
    });
    fixture.github.seedPullRequest(Number(foreignResource.external_id), {
      number: 82,
      headSha,
      baseSha,
      updatedAt: "2026-11-25T09:00:00Z",
    });
    const register = (
      taskId: string,
      organizationId: string,
      body: Record<string, unknown>,
    ) =>
      call(
        fixture,
        "POST",
        `/v1/tasks/${taskId}/pull-requests`,
        fixture.developerCookie!,
        {
          body,
          headers: {
            ...orgHeader(organizationId),
            "Idempotency-Key": crypto.randomUUID(),
          },
        },
      );

    const wrongRepository = await register(own.taskId, own.organizationId, {
      repositoryId: foreign.repositoryId,
      providerNumber: 82,
    });
    assertEquals(
      wrongRepository.status,
      404,
      await wrongRepository.clone().text(),
    );

    const otherRun = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      own.organizationId,
      fixture.adminId,
    );
    const wrongRun = await register(own.taskId, own.organizationId, {
      repositoryId: own.repositoryId,
      providerNumber: 81,
      runId: otherRun.runId,
    });
    assertEquals(wrongRun.status, 404, await wrongRun.clone().text());

    const wrongTenant = await register(
      own.taskId,
      crypto.randomUUID(),
      { repositoryId: own.repositoryId, providerNumber: 81 },
    );
    assertNotEquals(wrongTenant.status, 201);

    const accepted = await register(own.taskId, own.organizationId, {
      repositoryId: own.repositoryId,
      providerNumber: 81,
    });
    assertEquals(accepted.status, 201, await accepted.clone().text());

    await fixture.pgDatabase.query(
      `insert into bakery.conversations
         (id, organization_id, application_id, repository_id, title, created_by)
       values ($1, $2, $3, $4, 'Second task', $5)`,
      [
        secondConversationId,
        own.organizationId,
        own.applicationId,
        own.repositoryId,
        fixture.adminId,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.tasks
         (id, organization_id, application_id, repository_id, conversation_id,
          title, task_type, created_by)
       values ($1, $2, $3, $4, $5, 'Second task', 'feature', $6)`,
      [
        secondTaskId,
        own.organizationId,
        own.applicationId,
        own.repositoryId,
        secondConversationId,
        fixture.adminId,
      ],
    );
    const wrongTask = await register(secondTaskId, own.organizationId, {
      repositoryId: own.repositoryId,
      providerNumber: 81,
    });
    assertEquals(wrongTask.status, 409, await wrongTask.clone().text());
    assertEquals((await wrongTask.json()).code, "STATE_CONFLICT");

    const stored = await fixture.pgDatabase.query<{ records: number }>(
      `select count(*)::int as records from bakery.pull_requests
        where organization_id = $1 and repository_id = any($2::uuid[])`,
      [own.organizationId, [own.repositoryId, foreign.repositoryId]],
    );
    assertEquals(stored.rows[0].records, 1);
  } finally {
    if (own) {
      await fixture.pgDatabase.query(
        "delete from bakery.tasks where organization_id = $1 and id = $2",
        [own.organizationId, secondTaskId],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.conversations where organization_id = $1 and id = $2",
        [own.organizationId, secondConversationId],
      );
    }
    if (foreign) await removeSeed(fixture, foreign);
    if (own) await removeSeed(fixture, own);
    await fixture.finish();
  }
});

Deno.test("registration rechecks installation and resource authority after the provider read", async () => {
  const fixture = await openGitHubAppFixture();
  let seed: Awaited<ReturnType<typeof seedTaskAndRepository>> | undefined;
  try {
    const connection = await enabledConnection(fixture, { selected: 1 });
    const resource = connection.selected[0];
    seed = await seedTaskAndRepository(fixture, resource);
    const installation = await fixture.pgDatabase.query<{
      installation_id: string;
    }>(
      "select installation_id from bakery.integration_connections where id = $1",
      [connection.connectionId],
    );
    const installationId = installation.rows[0].installation_id;
    const headSha = "3".repeat(40);
    const baseSha = "4".repeat(40);
    const register = (number: number) =>
      call(
        fixture,
        "POST",
        `/v1/tasks/${seed!.taskId}/pull-requests`,
        fixture.developerCookie!,
        {
          body: { repositoryId: seed!.repositoryId, providerNumber: number },
          headers: {
            ...orgHeader(seed!.organizationId),
            "Idempotency-Key": crypto.randomUUID(),
          },
        },
      );
    const race = async (
      number: number,
      revoke: () => Promise<unknown>,
    ) => {
      fixture.github.seedPullRequest(Number(resource.external_id), {
        number,
        headSha,
        baseSha,
        updatedAt: "2026-11-25T09:30:00Z",
      });
      let reached!: () => void;
      let release!: () => void;
      const providerReached = new Promise<void>((resolve) => reached = resolve);
      const providerRelease = new Promise<void>((resolve) => release = resolve);
      fixture.github.hooks.beforeResponse = async (request) => {
        if (request.url.endsWith(`/pulls/${number}`)) {
          reached();
          await providerRelease;
        }
      };
      const pending = register(number);
      await providerReached;
      await revoke();
      release();
      const response = await pending;
      fixture.github.hooks.beforeResponse = null;
      assertEquals(response.status, 409, await response.clone().text());
      assertEquals((await response.json()).code, "STATE_CONFLICT");
    };

    await race(83, () =>
      fixture.pgDatabase.query(
        "update bakery.integration_installations set status = 'suspended' where id = $1",
        [installationId],
      ));
    await fixture.pgDatabase.query(
      "update bakery.integration_installations set status = 'enabled' where id = $1",
      [installationId],
    );
    await race(84, () =>
      fixture.pgDatabase.query(
        "update bakery.integration_resources set selected = false where id = $1",
        [resource.id],
      ));

    const stored = await fixture.pgDatabase.query<{ records: number }>(
      `select count(*)::int as records from bakery.pull_requests
        where organization_id = $1 and repository_id = $2`,
      [seed.organizationId, seed.repositoryId],
    );
    assertEquals(stored.rows[0].records, 0);
  } finally {
    fixture.github.hooks.beforeResponse = null;
    if (seed) await removeSeed(fixture, seed);
    await fixture.finish();
  }
});
