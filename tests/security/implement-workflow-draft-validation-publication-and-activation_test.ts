import { assert, assertEquals } from "@std/assert";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import { openPgDatabase } from "../../apps/server/src/platform/database.ts";
import { agentVersionDigest } from "../../apps/server/src/modules/agents/postgres.ts";
import { postgresErrorCode } from "../../apps/server/src/platform/postgres-errors.ts";
import { AgentVersionCreateConfigSchema } from "../../packages/contracts/src/contracts.ts";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";

const databaseConfig = readTestDatabaseConfig();

type SendOptions = {
  cookie?: string;
  organizationId?: string;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
};

type Route = {
  name: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  ifMatch?: string;
};

type Problem = { code?: string; status?: number; title?: string };

async function count(
  database: ReturnType<typeof openPgDatabase>,
  sql: string,
  values: readonly unknown[],
): Promise<number> {
  const result = await database.query<{ count: string }>(sql, [...values]);
  return Number(result.rows[0]?.count ?? 0);
}

Deno.test("workflow draft, validation, publication and activation hold tenant and authority boundaries", async (test) => {
  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  const runtime = fixture.runtimePgDatabase;
  const now = new Date("2026-10-04T12:00:00.000Z");
  const sessionExpiresAt = new Date(Date.now() + 86_400_000);
  const organizationAId = crypto.randomUUID();
  const organizationBId = crypto.randomUUID();
  const identity = (label: string, organizationId: string, role: string) => ({
    userId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    token: `${label}-${crypto.randomUUID()}`,
    email: `${label}-${crypto.randomUUID()}@example.test`,
    name: label,
    organizationId,
    role,
  });
  const adminA = identity("admin-a", organizationAId, "admin");
  const adminC = identity("admin-c", organizationAId, "admin");
  const developerA = identity("developer-a", organizationAId, "developer");
  const adminB = identity("admin-b", organizationBId, "admin");
  const memberships = new Map<string, string>();

  try {
    for (
      const [organizationId, name] of [
        [organizationAId, "Organization A"],
        [organizationBId, "Organization B"],
      ] as const
    ) {
      await owner`
        insert into bakery.organizations (
          id, name, slug, metadata, created_at, updated_at, version
        ) values (
          ${organizationId}, ${name}, ${`org-${organizationId}`}, '{}'::jsonb,
          ${now}, ${now}, 1
        )`;
    }
    for (const who of [adminA, adminC, developerA, adminB]) {
      const membershipId = crypto.randomUUID();
      memberships.set(who.name, membershipId);
      await owner`
        insert into public."user" (
          id, name, email, "emailVerified", "createdAt", "updatedAt"
        ) values (
          ${who.userId}, ${who.name}, ${who.email}, true, ${now}, ${now}
        )`;
      await owner`
        insert into public.session (
          id, token, "userId", "expiresAt", "createdAt", "updatedAt"
        ) values (
          ${crypto.randomUUID()}, ${who.token}, ${who.userId},
          ${sessionExpiresAt}, ${now}, ${now}
        )`;
      await owner`
        insert into bakery.principals (
          id, provider_user_id, display_name, principal_type
        ) values (${who.principalId}, ${who.userId}, ${who.name}, 'human')`;
      await owner`
        insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status, joined_at,
          created_at, updated_at, version
        ) values (
          ${membershipId}, ${who.organizationId}, ${who.principalId},
          ${who.role}, 'active', ${now}, ${now}, ${now}, 1
        )`;
    }

    const secret = fixture.config.auth!.secret;
    const cookies = {
      adminA: await signSessionCookie(adminA.token, secret),
      adminC: await signSessionCookie(adminC.token, secret),
      developerA: await signSessionCookie(developerA.token, secret),
      adminB: await signSessionCookie(adminB.token, secret),
    };
    const send = (
      method: string,
      path: string,
      options: SendOptions = {},
    ): Promise<Response> | Response => {
      const headers = new Headers();
      if (options.cookie) headers.set("cookie", options.cookie);
      if (options.organizationId) {
        headers.set("Bakery-Organization-Id", options.organizationId);
      }
      if (options.body !== undefined) {
        headers.set("content-type", "application/json");
      }
      if (method !== "GET") headers.set("origin", authTestOrigin);
      if (options.idempotencyKey) {
        headers.set("Idempotency-Key", options.idempotencyKey);
      }
      if (options.ifMatch) headers.set("If-Match", options.ifMatch);
      return fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers,
          body: options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        }),
      );
    };
    const call = (
      route: Route,
      who: { cookie?: string; organizationId?: string },
    ) =>
      send(route.method, route.path, {
        ...who,
        body: route.body,
        ifMatch: route.ifMatch,
        idempotencyKey: route.method === "GET"
          ? undefined
          : crypto.randomUUID(),
      });
    const asAdminA = {
      cookie: cookies.adminA,
      organizationId: organizationAId,
    };
    const problemOf = async (response: Response): Promise<Problem> => {
      const text = await response.text();
      try {
        return JSON.parse(text) as Problem;
      } catch {
        return {};
      }
    };

    const validDefinition = {
      kind: "fixed",
      steps: [{ id: "first", uses: "workflow.noop" }],
    };
    const createWorkflow = async (slug: string): Promise<string> => {
      const response = await send("POST", "/v1/workflows", {
        ...asAdminA,
        idempotencyKey: crypto.randomUUID(),
        body: { slug, name: slug, description: "" },
      });
      assertEquals(response.status, 201);
      return (await response.json() as { id: string }).id;
    };
    const createDraft = async (
      workflowId: string,
      definition: unknown = validDefinition,
      sourceYaml?: string,
    ): Promise<string> => {
      const response = await send(
        "POST",
        `/v1/workflows/${workflowId}/versions`,
        {
          ...asAdminA,
          idempotencyKey: crypto.randomUUID(),
          body: sourceYaml === undefined
            ? { definition }
            : { definition, sourceYaml },
        },
      );
      assertEquals(response.status, 201);
      return (await response.json() as { id: string }).id;
    };
    const publishFor = (
      workflowId: string,
      versionId: string,
      who: SendOptions = asAdminA,
      ifMatch = '"1"',
    ) =>
      send(
        "POST",
        `/v1/workflows/${workflowId}/versions/${versionId}/publish`,
        {
          ...who,
          idempotencyKey: crypto.randomUUID(),
          body: {},
          ifMatch,
        },
      );
    const definitionVersion = async (workflowId: string): Promise<number> =>
      (await (await send("GET", `/v1/workflows/${workflowId}`, asAdminA))
        .json() as { version: number }).version;

    // Fixtures in org A: W1 with published V1 (active) and a fresh draft D2;
    // W2 with its own published V2.
    const w1 = await createWorkflow("sec-flow-one");
    const v1 = await createDraft(w1);
    assertEquals((await publishFor(w1, v1)).status, 200);
    const activated = await send("POST", `/v1/workflows/${w1}/activations`, {
      ...asAdminA,
      idempotencyKey: crypto.randomUUID(),
      body: { versionId: v1 },
      ifMatch: `"${await definitionVersion(w1)}"`,
    });
    assertEquals(activated.status, 200);
    const d2 = await createDraft(w1);
    const w2 = await createWorkflow("sec-flow-two");
    const v2 = await createDraft(w2);
    assertEquals((await publishFor(w2, v2)).status, 200);

    const routesFor = (
      workflow: string,
      draft: string,
      published: string,
    ): Route[] => [
      { name: "workflows.list", method: "GET", path: "/v1/workflows" },
      {
        name: "workflows.create",
        method: "POST",
        path: "/v1/workflows",
        body: { slug: "never-created", name: "Never", description: "" },
      },
      {
        name: "workflows.get",
        method: "GET",
        path: `/v1/workflows/${workflow}`,
      },
      {
        name: "workflows.update",
        method: "PATCH",
        path: `/v1/workflows/${workflow}`,
        body: { name: "Renamed" },
        ifMatch: '"1"',
      },
      {
        name: "workflowVersions.list",
        method: "GET",
        path: `/v1/workflows/${workflow}/versions`,
      },
      {
        name: "workflowVersions.get",
        method: "GET",
        path: `/v1/workflows/${workflow}/versions/${published}`,
      },
      {
        name: "workflowVersions.create",
        method: "POST",
        path: `/v1/workflows/${workflow}/versions`,
        body: { definition: validDefinition },
      },
      {
        name: "workflowVersions.update",
        method: "PATCH",
        path: `/v1/workflows/${workflow}/versions/${draft}`,
        body: { definition: validDefinition },
        ifMatch: '"1"',
      },
      {
        name: "workflowVersions.publish",
        method: "POST",
        path: `/v1/workflows/${workflow}/versions/${draft}/publish`,
        body: {},
        ifMatch: '"1"',
      },
      {
        name: "workflowActivations.create",
        method: "POST",
        path: `/v1/workflows/${workflow}/activations`,
        body: { versionId: published },
        ifMatch: '"1"',
      },
      {
        name: "workflows.validate",
        method: "POST",
        path: "/v1/workflow-validations",
        body: { definition: validDefinition },
      },
    ];
    const routes = routesFor(w1, d2, v1);
    assertEquals(routes.length, 11);
    const draftCount = (workflowId: string) =>
      count(
        runtime,
        `select count(*) from bakery.workflow_drafts
          where organization_id = $1 and workflow_id = $2`,
        [organizationAId, workflowId],
      );
    const publishedCount = (workflowId: string) =>
      count(
        runtime,
        `select count(*) from bakery.workflow_versions
          where organization_id = $1 and workflow_id = $2`,
        [organizationAId, workflowId],
      );
    const sentinelFreeSnapshot = async () => ({
      definitions: await count(
        runtime,
        "select count(*) from bakery.workflow_definitions where organization_id = $1",
        [organizationAId],
      ),
      published: await publishedCount(w1),
      drafts: await draftCount(w1),
      audit: await count(
        runtime,
        "select count(*) from bakery.audit_events where organization_id = $1",
        [organizationAId],
      ),
    });

    await test.step("unauthenticated requests are 401 on all 11 routes", async () => {
      const before = await sentinelFreeSnapshot();
      for (const route of routes) {
        const response = await call(route, {
          organizationId: organizationAId,
        });
        assertEquals(response.status, 401, route.name);
        await response.body?.cancel();
      }
      assertEquals(await sentinelFreeSnapshot(), before);
    });

    await test.step("a missing organization header is 403 SCOPE_REQUIRED on all 11 routes", async () => {
      const before = await sentinelFreeSnapshot();
      for (const route of routes) {
        const response = await call(route, { cookie: cookies.adminA });
        assertEquals(response.status, 403, route.name);
        assertEquals((await problemOf(response)).code, "SCOPE_REQUIRED");
      }
      assertEquals(await sentinelFreeSnapshot(), before);
    });

    await test.step("a malformed organization header is 400 MALFORMED_REQUEST on all 11 routes", async () => {
      for (const route of routes) {
        const response = await call(route, {
          cookie: cookies.adminA,
          organizationId: "not-a-uuid",
        });
        assertEquals(response.status, 400, route.name);
        assertEquals((await problemOf(response)).code, "MALFORMED_REQUEST");
      }
    });

    await test.step("org B gets 404 with no oracle for org A ids on every id-bearing route", async () => {
      const asAdminB = {
        cookie: cookies.adminB,
        organizationId: organizationBId,
      };
      const before = await sentinelFreeSnapshot();
      const foreign = routesFor(w1, d2, v1);
      const random = routesFor(
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      );
      let compared = 0;
      for (let index = 0; index < foreign.length; index++) {
        const route = foreign[index];
        if (!route.path.includes(w1)) continue;
        const real = await call(route, asAdminB);
        const fake = await call(random[index], asAdminB);
        assertEquals(real.status, 404, route.name);
        assertEquals(fake.status, 404, route.name);
        const realProblem = await problemOf(real);
        const fakeProblem = await problemOf(fake);
        assertEquals(realProblem.code, fakeProblem.code, route.name);
        assertEquals(realProblem.title, fakeProblem.title, route.name);
        compared++;
      }
      assertEquals(compared, 8);
      const listed = await call(foreign[0], asAdminB);
      assertEquals(listed.status, 200);
      assertEquals((await listed.json() as { items: unknown[] }).items, []);
      assertEquals(await sentinelFreeSnapshot(), before);
      // Org B authority does not reach org A through a header swap.
      const crossHeader = await call(foreign[0], {
        cookie: cookies.adminB,
        organizationId: organizationAId,
      });
      assert(crossHeader.status === 403 || crossHeader.status === 404);
      await crossHeader.body?.cancel();
    });

    await test.step("activating another workflow's version is 404", async () => {
      const response = await send("POST", `/v1/workflows/${w1}/activations`, {
        ...asAdminA,
        idempotencyKey: crypto.randomUUID(),
        body: { versionId: v2 },
        ifMatch: `"${await definitionVersion(w1)}"`,
      });
      assertEquals(response.status, 404);
      await response.body?.cancel();
      const active = await (await send("GET", `/v1/workflows/${w1}`, asAdminA))
        .json() as { activeVersionId: string };
      assertEquals(active.activeVersionId, v1);
    });

    await test.step("run start in org B with an org A workflowId is 404 and creates no run", async () => {
      const applicationId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const taskId = crypto.randomUUID();
      await owner`
        insert into bakery.applications (id, organization_id, slug, name)
        values (${applicationId}, ${organizationBId}, 'sec-app', 'Security app')`;
      await owner`
        insert into bakery.conversations (
          id, organization_id, application_id, title, created_by
        ) values (
          ${conversationId}, ${organizationBId}, ${applicationId},
          'Security task', ${adminB.principalId}
        )`;
      await owner`
        insert into bakery.tasks (
          id, organization_id, application_id, conversation_id, title,
          task_type, created_by
        ) values (
          ${taskId}, ${organizationBId}, ${applicationId}, ${conversationId},
          'Security task', 'feature', ${adminB.principalId}
        )`;
      const start = async (workflowId: string) => {
        const response = await send("POST", `/v1/tasks/${taskId}/runs`, {
          cookie: cookies.adminB,
          organizationId: organizationBId,
          idempotencyKey: crypto.randomUUID(),
          body: {
            workflowId,
            executionMode: "repository",
            repositoryProfileId: crypto.randomUUID(),
            budgetLimitUsd: "5.00",
            inputs: { brief: "Probe." },
          },
        });
        return { status: response.status, problem: await problemOf(response) };
      };
      const foreign = await start(w1);
      const fake = await start(crypto.randomUUID());
      assertEquals(foreign.status, 404, JSON.stringify(foreign.problem));
      assertEquals(fake.status, 404);
      assertEquals(foreign.problem.code, fake.problem.code);
      assertEquals(foreign.problem.title, fake.problem.title);
      assertEquals(
        await count(
          runtime,
          "select count(*) from bakery.workflow_runs where organization_id = $1",
          [organizationBId],
        ),
        0,
      );
    });

    await test.step("an agent binding to another org's agent version fails publish 422", async () => {
      const agentId = crypto.randomUUID();
      const agentVersionId = crypto.randomUUID();
      const config = AgentVersionCreateConfigSchema.parse({
        harness: "codex",
        billing: {
          provider: "preset-provider",
          billingAccountId: "preset-account-sec",
          model: "preset-model",
          billingRoute: "api",
          maxTokens: 1_000,
          maxUsdReservation: 1,
          pricingMetadataSnapshot: "preset-price-sec",
        },
      });
      await owner`
        insert into bakery.agent_definitions (
          id, organization_id, slug, name, description, enabled
        ) values (
          ${agentId}, ${organizationBId}, 'sec-agent', 'Org B agent', '', true
        )`;
      await owner`
        insert into bakery.agent_versions (
          id, organization_id, agent_id, revision, config, digest, created_by
        ) values (
          ${agentVersionId}, ${organizationBId}, ${agentId}, 1,
          ${owner.json(config)}, ${await agentVersionDigest(config)},
          ${adminB.principalId}
        )`;
      const id = await createWorkflow("sec-agent-flow");
      const draftId = await createDraft(id, {
        kind: "fixed",
        steps: [{ id: "impl", uses: "harness.implement" }],
        agents: { "harness.implement": agentVersionId },
      });
      const response = await publishFor(id, draftId);
      assertEquals(response.status, 422);
      const text = await response.text();
      assert(!text.includes(agentVersionId));
      const body = JSON.parse(text) as {
        issues?: { code: string }[];
        params?: { issues?: { code: string }[] };
      };
      const issues = body.issues ?? body.params?.issues ?? [];
      assertEquals(issues[0]?.code, "agent_version_unavailable");
      assertEquals(await publishedCount(id), 0);
      assertEquals(await draftCount(id), 1);
    });

    await test.step("Developer reads and validates; mutations are 403 AUTH_FORBIDDEN", async () => {
      const asDeveloper = {
        cookie: cookies.developerA,
        organizationId: organizationAId,
      };
      const readable = new Set([
        "workflows.list",
        "workflows.get",
        "workflowVersions.list",
        "workflowVersions.get",
        "workflows.validate",
      ]);
      const before = await sentinelFreeSnapshot();
      for (const route of routes) {
        const response = await call(route, asDeveloper);
        if (readable.has(route.name)) {
          assertEquals(response.status, 200, route.name);
          await response.body?.cancel();
        } else {
          assertEquals(response.status, 403, route.name);
          assertEquals((await problemOf(response)).code, "AUTH_FORBIDDEN");
        }
      }
      assertEquals(await sentinelFreeSnapshot(), before);
    });

    await test.step("demotion between validate and publish rejects the publish", async () => {
      const id = await createWorkflow("sec-demotion-flow");
      const draftId = await createDraft(id);
      const asAdminC = {
        cookie: cookies.adminC,
        organizationId: organizationAId,
      };
      const validated = await send("POST", "/v1/workflow-validations", {
        ...asAdminC,
        idempotencyKey: crypto.randomUUID(),
        body: { definition: validDefinition },
      });
      assertEquals(validated.status, 200);
      await validated.body?.cancel();
      await owner`
        update bakery.organization_memberships set role = 'developer'
         where id = ${memberships.get("admin-c")!}`;
      const response = await publishFor(id, draftId, asAdminC);
      assertEquals(response.status, 403);
      assertEquals((await problemOf(response)).code, "AUTH_FORBIDDEN");
      assertEquals(await publishedCount(id), 0);
      assertEquals(await draftCount(id), 1);
    });

    await test.step("bakery_app cannot UPDATE or DELETE workflow_versions", async () => {
      for (
        const sql of [
          "update bakery.workflow_versions set source_yaml = 'x' where id = $1",
          "delete from bakery.workflow_versions where id = $1",
        ]
      ) {
        let sqlState: string | undefined;
        try {
          await runtime.query(sql, [v1]);
        } catch (error) {
          sqlState = postgresErrorCode(error);
        }
        assertEquals(sqlState, "42501", sql);
      }
      assertEquals(await publishedCount(w1), 1);
    });

    await test.step("audit and event rows carry no definition or sourceYaml content", async () => {
      const sentinel = `sentinel-${crypto.randomUUID()}`;
      const id = await createWorkflow("sec-audit-flow");
      const draftId = await createDraft(
        id,
        { ...validDefinition, note: sentinel },
        `# ${sentinel}\nkind: fixed\n`,
      );
      const saved = await send(
        "PATCH",
        `/v1/workflows/${id}/versions/${draftId}`,
        {
          ...asAdminA,
          idempotencyKey: crypto.randomUUID(),
          body: {
            definition: { ...validDefinition, note: sentinel },
            sourceYaml: `# ${sentinel}\nkind: fixed\n`,
          },
          ifMatch: '"1"',
        },
      );
      assertEquals(saved.status, 200, await saved.clone().text());
      await saved.body?.cancel();
      const published = await publishFor(id, draftId, asAdminA, '"2"');
      assertEquals(published.status, 200);
      await published.body?.cancel();
      const pattern = `%${sentinel}%`;
      assert(
        await count(
          runtime,
          `select count(*) from bakery.audit_events
            where organization_id = $1 and operation like 'workflowVersions.%'`,
          [organizationAId],
        ) >= 3,
      );
      assertEquals(
        await count(
          runtime,
          `select count(*) from bakery.audit_events
            where organization_id = $1 and audit_events::text like $2`,
          [organizationAId, pattern],
        ),
        0,
      );
      assertEquals(
        await count(
          runtime,
          `select count(*) from bakery.domain_events
            where organization_id = $1 and domain_events::text like $2`,
          [organizationAId, pattern],
        ),
        0,
      );
    });

    await test.step("a preset: slug in workflows.create is 400 and creates no row", async () => {
      const before = await sentinelFreeSnapshot();
      const response = await send("POST", "/v1/workflows", {
        ...asAdminA,
        idempotencyKey: crypto.randomUUID(),
        body: { slug: "preset:sneaky", name: "Sneaky", description: "" },
      });
      assertEquals(response.status, 400);
      assertEquals((await problemOf(response)).code, "MALFORMED_REQUEST");
      assertEquals(
        await count(
          runtime,
          `select count(*) from bakery.workflow_definitions
            where organization_id = $1 and slug = 'preset:sneaky'`,
          [organizationAId],
        ),
        0,
      );
      assertEquals(await sentinelFreeSnapshot(), before);
    });
  } finally {
    try {
      // Remove only this test's rows. Provider users left behind with no
      // bootstrap principal make later createsuperuser fixtures fail
      // AUTH_BOOTSTRAP_LEGACY_IDENTITY_AMBIGUOUS. Organization deletes cascade
      // to every org-scoped row; principals restrict provider-user deletes.
      const people = [adminA, adminC, developerA, adminB];
      await owner`
        delete from bakery.organizations
         where id in (${organizationAId}, ${organizationBId})`;
      await owner`
        delete from bakery.principals
         where id = any(${people.map((who) => who.principalId)}::uuid[])`;
      await owner`
        delete from public."user"
         where id = any(${people.map((who) => who.userId)}::uuid[])`;
    } finally {
      await fixture.close();
    }
  }
});
