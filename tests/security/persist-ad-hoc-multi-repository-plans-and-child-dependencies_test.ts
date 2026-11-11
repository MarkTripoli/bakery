import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  openCoordinationFixture,
  threeLaneSpec,
} from "../helpers/coordination-fixture.ts";

Deno.test("coordination plans enforce roles, tenancy, immutability and idempotency", async () => {
  const fx = await openCoordinationFixture();
  try {
    await fx.seedAliases();
    const parent = await fx.insertTask("security parent");

    // Alias administration is Admin only; reads stay Developer.
    const denied = await fx.send(
      fx.developer,
      "PUT",
      `/v1/applications/${fx.applicationId}/repository-roles`,
      {
        body: {
          alias: "extra",
          role: "backend",
          repositoryId: fx.repositories.api.repositoryId,
        },
      },
    );
    assertEquals(denied.status, 403);
    const readable = await fx.send(
      fx.developer,
      "GET",
      `/v1/applications/${fx.applicationId}/repository-roles`,
    );
    assertEquals(readable.status, 200);

    // A principal of another organization is not a member here.
    const create = await fx.send(
      fx.developer,
      "POST",
      "/v1/coordination-plans",
      {
        body: { parentTaskId: parent, spec: threeLaneSpec() },
      },
    );
    assertEquals(create.status, 201);
    const plan = await create.json();
    for (
      const [method, path, body] of [
        ["GET", `/v1/coordination-plans/${plan.id}`, undefined],
        ["GET", "/v1/coordination-plans", undefined],
        ["POST", `/v1/coordination-plans/${plan.id}/materialize`, {}],
        ["POST", `/v1/coordination-plans/${plan.id}/cancel`, {}],
        ["GET", `/v1/tasks/${parent}/repositories`, undefined],
      ] as const
    ) {
      const foreignHeader = await fx.send(fx.outsider, method, path, {
        organizationId: fx.organizationId,
        body,
      });
      assert(
        [403, 404].includes(foreignHeader.status),
        `${method} ${path} -> ${foreignHeader.status}`,
      );
    }
    // Inside its own organization the outsider cannot see or reach our rows.
    const ownScope = await fx.send(
      fx.outsider,
      "GET",
      `/v1/coordination-plans/${plan.id}`,
      { organizationId: fx.hostileOrganizationId },
    );
    assertEquals(ownScope.status, 404);
    const hostileCreate = await fx.send(
      fx.outsider,
      "POST",
      "/v1/coordination-plans",
      {
        organizationId: fx.hostileOrganizationId,
        body: { parentTaskId: parent, spec: threeLaneSpec() },
      },
    );
    assertEquals(hostileCreate.status, 404);
    const hostileList = await (await fx.send(
      fx.outsider,
      "GET",
      "/v1/coordination-plans",
      { organizationId: fx.hostileOrganizationId },
    )).json();
    assertEquals(hostileList.items, []);

    // Keys and bodies replay or conflict; they never create a second plan.
    const key = `replay-${crypto.randomUUID()}`;
    const body = { parentTaskId: parent, spec: threeLaneSpec() };
    const first = await fx.send(
      fx.developer,
      "POST",
      "/v1/coordination-plans",
      {
        body,
        key,
      },
    );
    const replay = await fx.send(
      fx.developer,
      "POST",
      "/v1/coordination-plans",
      {
        body,
        key,
      },
    );
    assertEquals(first.status, replay.status);
    assertEquals((await first.json()).id, (await replay.json()).id);
    const mismatch = await fx.send(
      fx.developer,
      "POST",
      "/v1/coordination-plans",
      {
        body: {
          parentTaskId: parent,
          spec: threeLaneSpec({ mobileInstructions: "x" }),
        },
        key,
      },
    );
    assert([409, 422].includes(mismatch.status), String(mismatch.status));

    // Unknown fields and server-owned values are rejected, not ignored.
    const smuggled = await fx.send(
      fx.developer,
      "POST",
      "/v1/coordination-plans",
      {
        body: {
          parentTaskId: parent,
          spec: threeLaneSpec(),
          status: "completed",
          revision: 99,
        },
      },
    );
    assertEquals(smuggled.status, 400);

    // The application role cannot rewrite or delete an immutable plan.
    await assertRejects(
      () =>
        fx.appPg.query(
          "update bakery.coordination_plans set spec = '{}'::jsonb where id = $1",
          [plan.id],
        ),
      Error,
      "permission denied",
    );
    await assertRejects(
      () =>
        fx.appPg.query(
          "update bakery.coordination_plans set budget_limit_usd = 999 where id = $1",
          [plan.id],
        ),
      Error,
      "permission denied",
    );
    await assertRejects(
      () =>
        fx.appPg.query(
          "delete from bakery.coordination_plans where id = $1",
          [plan.id],
        ),
      Error,
      "permission denied",
    );
    await assertRejects(
      () =>
        fx.appPg.query(
          "update bakery.coordination_lanes set repository_id = $2 where plan_id = $1",
          [plan.id, fx.repositories.foreign.repositoryId],
        ),
      Error,
      "permission denied",
    );

    // An alias can never name another application's repository, even directly.
    await assertRejects(
      () =>
        fx.ownerPg.query(
          `insert into bakery.repository_role_bindings (
             organization_id, application_id, alias, role, repository_id
           ) values ($1, $2, 'cross', 'backend', $3)`,
          [
            fx.organizationId,
            fx.applicationId,
            fx.repositories.foreign.repositoryId,
          ],
        ),
      Error,
      "repository_role_bindings_repository_fk",
    );

    // Production composition: sessions are required and wired.
    const anonymous = await fx.productionApp.fetch(
      new Request("http://test/v1/coordination-plans", {
        headers: { "Bakery-Organization-Id": fx.organizationId },
      }),
    );
    assert([401, 403].includes(anonymous.status), String(anonymous.status));
    const cookie = await fx.cookieFor(fx.developer);
    const authenticated = await fx.productionApp.fetch(
      new Request("http://test/v1/coordination-plans", {
        headers: {
          cookie,
          origin: fx.publicBaseUrl,
          "Bakery-Organization-Id": fx.organizationId,
        },
      }),
    );
    assertEquals(authenticated.status, 200);

    // Task repository bindings: only the binding fields are updatable by the
    // application role; identity and scope columns are not.
    const grants = await fx.owner`
      select column_name::text as column, has_column_privilege(
               'bakery_app', 'bakery.task_repositories', column_name, 'UPDATE'
             ) as updatable
        from information_schema.columns
       where table_schema = 'bakery' and table_name = 'task_repositories'
       order by column_name`;
    const updatable = grants.filter((row) => row.updatable).map((row) =>
      row.column
    );
    assertEquals(updatable, [
      "provenance",
      "required",
      "role",
      "updated_at",
      "version",
    ]);
  } finally {
    await fx.close();
  }
});
