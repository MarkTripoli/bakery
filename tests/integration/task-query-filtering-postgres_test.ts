import { assert, assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  authRequest,
  authTestOrigin,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";
import { upPostgresStack } from "../e2e/helpers/stack.ts";

type TaskItem = {
  id: string;
  repositoryId: string | null;
  status: string;
  title: string;
};

type TaskPage = {
  items: TaskItem[];
  nextCursor: string | null;
};

Deno.test("task filters bind real PostgreSQL, HTTP pagination, and tenant authorization", async (test) => {
  const stack = await upPostgresStack("task-filters");
  const owner = openPgDatabase(stack.ownerDatabaseUrl, 1);
  const application = openPgDatabase(stack.appDatabaseUrl, 1);
  const administrator = openPgDatabase(stack.adminDatabaseUrl, 1);
  console.log(JSON.stringify({
    project: stack.project,
    postgresPort: stack.postgresPort,
    roles: {
      owner: new URL(stack.ownerDatabaseUrl).username,
      application: new URL(stack.appDatabaseUrl).username,
      administrator: new URL(stack.adminDatabaseUrl).username,
    },
  }));
  let fixture: Awaited<ReturnType<typeof openAuthFixture>> | undefined;
  try {
    const [ownerIdentity, applicationIdentity, administratorIdentity] =
      await Promise.all([
        owner.query<{ currentUser: string; databaseOwner: string }>(
          `select current_user as "currentUser",
             pg_get_userbyid(datdba) as "databaseOwner"
           from pg_database where datname = current_database()`,
        ),
        application.query<{ currentUser: string; superuser: boolean }>(
          `select current_user as "currentUser", rolsuper as superuser
           from pg_roles where rolname = current_user`,
        ),
        administrator.query<{ currentUser: string; superuser: boolean }>(
          `select current_user as "currentUser", rolsuper as superuser
           from pg_roles where rolname = current_user`,
        ),
      ]);
    assertEquals(ownerIdentity.rows[0], {
      currentUser: "bakery",
      databaseOwner: "bakery",
    });
    assertEquals(applicationIdentity.rows[0], {
      currentUser: "bakery_app",
      superuser: false,
    });
    assertEquals(administratorIdentity.rows[0], {
      currentUser: "postgres",
      superuser: true,
    });
    assertEquals(new URL(stack.ownerDatabaseUrl).username, "bakery");
    assertEquals(new URL(stack.appDatabaseUrl).username, "bakery_app");
    assertEquals(new URL(stack.adminDatabaseUrl).username, "postgres");

    fixture = await openAuthFixture({
      databaseConfig: {
        databaseUrl: stack.ownerDatabaseUrl,
        appDatabaseUrl: stack.appDatabaseUrl,
      },
    });
    const suffix = crypto.randomUUID();
    const email = `task-filter-${suffix}@example.test`;
    const password = `TaskFilter-${suffix}`;
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Task Filter Reviewer", password });
    const scope = await fixture.pgDatabase.query<{
      principalId: string;
      organizationId: string;
    }>(
      `select principal.id as "principalId",
        membership.organization_id as "organizationId"
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       join bakery.organization_memberships as membership
         on membership.principal_id = principal.id
       where provider_user.email = $1`,
      [email],
    );
    const { principalId, organizationId } = scope.rows[0];
    const applicationId = crypto.randomUUID();
    const repositoryA = crypto.randomUUID();
    const repositoryB = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, 'Task filter application')`,
      [applicationId, organizationId, `task-filter-${suffix}`],
    );
    for (
      const [repositoryId, name] of [
        [repositoryA, "alpha"],
        [repositoryB, "beta"],
      ]
    ) {
      await fixture.pgDatabase.query(
        `insert into bakery.repositories (
           id, organization_id, application_id, integration_connection_id,
           provider_repo_id, owner, name, default_branch
         ) values ($1, $2, $3, $4, $5, 'bakery', $6, 'main')`,
        [
          repositoryId,
          organizationId,
          applicationId,
          crypto.randomUUID(),
          `task-filter/${repositoryId}`,
          name,
        ],
      );
    }

    const taskIds = {
      titleMatch: crypto.randomUUID(),
      descriptionMatch: crypto.randomUUID(),
      literalSpecial: crypto.randomUUID(),
      wildcardDecoy: crypto.randomUUID(),
      completed: crypto.randomUUID(),
      otherTenant: crypto.randomUUID(),
    };
    const insertTask = async (input: {
      id: string;
      organizationId: string;
      applicationId: string;
      repositoryId: string | null;
      title: string;
      description: string;
      status: string;
      createdAt: Date;
    }) => {
      const conversationId = crypto.randomUUID();
      await fixture!.pgDatabase.query(
        `insert into bakery.conversations (
           id, organization_id, application_id, repository_id, title,
           created_by, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          conversationId,
          input.organizationId,
          input.applicationId,
          input.repositoryId,
          `Conversation ${input.title}`,
          principalId,
          input.createdAt,
        ],
      );
      await fixture!.pgDatabase.query(
        `insert into bakery.tasks (
           id, organization_id, application_id, repository_id,
           conversation_id, title, description, task_type, status,
           priority, created_by, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, 'feature', $8, 50, $9, $10, $10)`,
        [
          input.id,
          input.organizationId,
          input.applicationId,
          input.repositoryId,
          conversationId,
          input.title,
          input.description,
          input.status,
          principalId,
          input.createdAt,
        ],
      );
    };
    const timestamp = new Date("2026-10-01T12:00:00.123456Z");
    await insertTask({
      id: taskIds.titleMatch,
      organizationId,
      applicationId,
      repositoryId: repositoryA,
      title: "Needle in TITLE",
      description: "ordinary",
      status: "queued",
      createdAt: timestamp,
    });
    await insertTask({
      id: taskIds.descriptionMatch,
      organizationId,
      applicationId,
      repositoryId: repositoryB,
      title: "ordinary",
      description: "Needle in DESCRIPTION",
      status: "queued",
      createdAt: timestamp,
    });
    await insertTask({
      id: taskIds.literalSpecial,
      organizationId,
      applicationId,
      repositoryId: repositoryA,
      title: "Deploy 100%_safe\\path",
      description: "literal search marker",
      status: "queued",
      createdAt: timestamp,
    });
    await insertTask({
      id: taskIds.wildcardDecoy,
      organizationId,
      applicationId,
      repositoryId: repositoryB,
      title: "Deploy 100Xsafe",
      description: "wildcard decoy",
      status: "queued",
      createdAt: timestamp,
    });
    await insertTask({
      id: taskIds.completed,
      organizationId,
      applicationId,
      repositoryId: repositoryA,
      title: "completed task",
      description: "ordinary",
      status: "completed",
      createdAt: timestamp,
    });

    const otherOrganizationId = crypto.randomUUID();
    const otherApplicationId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
         id, name, slug, metadata, created_at, updated_at, version
       ) values ($1, 'Other task-filter tenant', $2, '{}'::jsonb, now(), now(), 1)`,
      [otherOrganizationId, `other-task-filter-${suffix}`],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, 'Other task-filter application')`,
      [otherApplicationId, otherOrganizationId, `other-task-filter-${suffix}`],
    );
    await insertTask({
      id: taskIds.otherTenant,
      organizationId: otherOrganizationId,
      applicationId: otherApplicationId,
      repositoryId: null,
      title: "Needle hidden tenant",
      description: "Needle hidden tenant",
      status: "queued",
      createdAt: timestamp,
    });

    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    assertEquals(signIn.status, 200);
    const cookie = sessionCookie(signIn);
    const get = (query = "", authenticated = true) =>
      fixture!.app.fetch(
        new Request(`${authTestOrigin}/v1/tasks${query}`, {
          headers: authenticated
            ? {
              cookie,
              origin: authTestOrigin,
              "Bakery-Organization-Id": organizationId,
            }
            : {
              origin: authTestOrigin,
              "Bakery-Organization-Id": organizationId,
            },
        }),
      );
    const page = async (query: string): Promise<TaskPage> => {
      const response = await get(query);
      assertEquals(response.status, 200);
      return await response.json() as TaskPage;
    };

    await test.step("status and tenant filters execute through the application role", async () => {
      const result = await page("?status=completed");
      assertEquals(result.items.map(({ id }) => id), [taskIds.completed]);
      assertEquals(
        result.items.every(({ status }) => status === "completed"),
        true,
      );
      assertEquals(
        result.items.some(({ id }) => id === taskIds.otherTenant),
        false,
      );
    });

    await test.step("repository filter binds its UUID", async () => {
      const result = await page(`?repositoryId=${repositoryA}`);
      assertEquals(
        new Set(result.items.map(({ id }) => id)),
        new Set([
          taskIds.titleMatch,
          taskIds.literalSpecial,
          taskIds.completed,
        ]),
      );
      assertEquals(
        result.items.every(({ repositoryId }) => repositoryId === repositoryA),
        true,
      );
    });

    await test.step("text filter is case-insensitive across title and description", async () => {
      const result = await page("?search=needle");
      assertEquals(
        new Set(result.items.map(({ id }) => id)),
        new Set([taskIds.titleMatch, taskIds.descriptionMatch]),
      );
    });

    await test.step("text filter treats SQL wildcard characters literally", async () => {
      const query = new URLSearchParams({ search: "%_" });
      const result = await page(`?${query}`);
      assertEquals(result.items.map(({ id }) => id), [taskIds.literalSpecial]);
    });

    await test.step("text filter treats the escape character literally", async () => {
      const query = new URLSearchParams({ search: "\\" });
      const result = await page(`?${query}`);
      assertEquals(result.items.map(({ id }) => id), [taskIds.literalSpecial]);
    });

    await test.step("filtered cursor pages preserve identity and reject filter changes", async () => {
      const first = await page("?status=queued&limit=1");
      assertEquals(first.items.length, 1);
      assert(first.nextCursor);
      const seen = [first.items[0].id];
      let cursor: string | null = first.nextCursor;
      while (cursor) {
        const next = await page(
          `?status=queued&limit=1&cursor=${encodeURIComponent(cursor)}`,
        );
        seen.push(...next.items.map(({ id }) => id));
        cursor = next.nextCursor;
      }
      assertEquals(
        new Set(seen),
        new Set([
          taskIds.titleMatch,
          taskIds.descriptionMatch,
          taskIds.literalSpecial,
          taskIds.wildcardDecoy,
        ]),
      );
      assertEquals(seen.length, 4);
      const changed = await get(
        `?status=completed&limit=1&cursor=${
          encodeURIComponent(first.nextCursor)
        }`,
      );
      assertEquals(changed.status, 400);
      assertEquals(
        (await changed.json() as { code: string }).code,
        "INVALID_CURSOR",
      );
    });

    await test.step("HTTP authorization and limit bounds reject before listing", async () => {
      const unauthorized = await get("?status=queued", false);
      assertEquals(unauthorized.status, 401);
      const oversized = await get("?limit=101");
      assertEquals(oversized.status, 400);
      assertEquals(
        (await oversized.json() as { code: string }).code,
        "MALFORMED_REQUEST",
      );
    });
  } finally {
    if (fixture) await fixture.close();
    await Promise.all([
      closePgDatabase(owner),
      closePgDatabase(application),
      closePgDatabase(administrator),
    ]);
    await stack.down();
  }
});
