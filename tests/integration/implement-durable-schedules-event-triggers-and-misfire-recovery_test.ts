import { assert, assertEquals } from "@std/assert";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { resetTestDatabase } from "../../apps/server/src/platform/migrate.ts";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";

// #36 [B07.06], slice 2: automation definitions, immutable versions with a
// validated trigger, the lifecycle (name, enabled, active version, schedule
// cursor) and the firings read, through the mounted PostgreSQL API.

const databaseConfig = readTestDatabaseConfig();

type SendOptions = {
  cookie?: string;
  organizationId?: string;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
};

async function databaseCount(
  database: ReturnType<typeof openPgDatabase>,
  sql: string,
  values: unknown[],
): Promise<number> {
  const result = await database.query<{ count: string }>(sql, values);
  return Number(result.rows[0]?.count);
}

async function resetDatabase(): Promise<void> {
  const reset = openDatabase(databaseConfig.databaseUrl);
  try {
    await resetTestDatabase(reset, {
      targetUrl: databaseConfig.databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
  } finally {
    await closeDatabase(reset);
  }
}

Deno.test("automations: definitions, versions with a validated trigger, lifecycle and firings through the mounted PostgreSQL API", async (test) => {
  await resetDatabase();
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
  const developerA = identity("developer-a", organizationAId, "developer");
  const adminB = identity("admin-b", organizationBId, "admin");

  try {
    for (
      const [organizationId, name, slug] of [
        [organizationAId, "Organization A", `org-a-${organizationAId}`],
        [organizationBId, "Organization B", `org-b-${organizationBId}`],
      ] as const
    ) {
      await owner`
        insert into bakery.organizations (
          id, name, slug, metadata, created_at, updated_at, version
        ) values (
          ${organizationId}, ${name}, ${slug}, '{}'::jsonb,
          ${now}, ${now}, 1
        )`;
    }
    for (const who of [adminA, developerA, adminB]) {
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
          ${crypto.randomUUID()}, ${who.organizationId}, ${who.principalId},
          ${who.role}, 'active', ${now}, ${now}, ${now}, 1
        )`;
    }
    const secret = fixture.config.auth!.secret;
    const cookies = {
      adminA: await signSessionCookie(adminA.token, secret),
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
      if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
        headers.set("origin", authTestOrigin);
      }
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
    const command = (overrides: Partial<SendOptions> = {}): SendOptions => ({
      cookie: cookies.adminA,
      organizationId: organizationAId,
      idempotencyKey: crypto.randomUUID(),
      ...overrides,
    });
    const read = (cookie: string, organizationId: string): SendOptions => ({
      cookie,
      organizationId,
    });
    const facts = async () => ({
      definitions: await databaseCount(
        runtime,
        "select count(*) from bakery.automation_definitions where organization_id = $1",
        [organizationAId],
      ),
      versions: await databaseCount(
        runtime,
        "select count(*) from bakery.automation_versions where organization_id = $1",
        [organizationAId],
      ),
      audit: await databaseCount(
        runtime,
        `select count(*) from bakery.audit_events where organization_id = $1
          and operation in ('automations.create','automations.update','automationVersions.create')`,
        [organizationAId],
      ),
      events: await databaseCount(
        runtime,
        `select count(*) from bakery.domain_events where organization_id = $1
          and event_type in ('automations.created','automations.updated','automation.version_created')`,
        [organizationAId],
      ),
    });
    const expectNoFacts = async (
      request: () => Promise<Response> | Response,
      expectedStatus: number,
    ): Promise<Response> => {
      const before = await facts();
      const response = await request();
      assertEquals(response.status, expectedStatus);
      assertEquals(await facts(), before);
      return response;
    };

    // A published workflow version in each organization, and a draft one.
    const workflowA = crypto.randomUUID();
    const workflowB = crypto.randomUUID();
    const publishedA = crypto.randomUUID();
    const draftA = crypto.randomUUID();
    const publishedB = crypto.randomUUID();
    for (
      const [organizationId, workflowId, versions, principalId] of [
        [organizationAId, workflowA, [[publishedA, 1, "published"], [
          draftA,
          2,
          "draft",
        ]], adminA.principalId],
        [
          organizationBId,
          workflowB,
          [[publishedB, 1, "published"]],
          adminB
            .principalId,
        ],
      ] as const
    ) {
      await owner`
        insert into bakery.workflow_definitions (id, organization_id, slug, name, description)
        values (${workflowId}, ${organizationId}, ${`wf-${workflowId}`}, 'Workflow', '')`;
      for (const [versionId, revision, status] of versions) {
        await owner`
          insert into bakery.workflow_versions (
            id, organization_id, workflow_id, revision, source_yaml,
            normalized_spec, digest, status, created_by
          ) values (
            ${versionId}, ${organizationId}, ${workflowId}, ${revision},
            'kind: fixed', ${
          owner.json({ kind: "fixed" })
        }, ${`digest-${versionId}`},
            ${status}, ${principalId}
          )`;
      }
    }

    const schedule = {
      type: "schedule",
      cron: "0 9 * * mon-fri",
      timezone: "Europe/Berlin",
    };
    const versionBody = (over: Record<string, unknown> = {}) => ({
      trigger: schedule,
      workflowVersionId: publishedA,
      inputs: { branch: "main" },
      misfirePolicy: "coalesce",
      overlapPolicy: "skip",
      ...over,
    });
    let automationId = "";
    let versionId = "";
    let secondVersionId = "";

    await test.step("create, get and list: Admin writes, Developer reads, another organization sees nothing", async () => {
      assertEquals(
        (await send("GET", "/v1/automations", {
          organizationId: organizationAId,
        })).status,
        401,
      );
      assertEquals(
        (await send("POST", "/v1/automations", {
          cookie: cookies.developerA,
          organizationId: organizationAId,
          idempotencyKey: crypto.randomUUID(),
          body: { slug: "forbidden", name: "Forbidden", description: "" },
        })).status,
        403,
      );
      const created = await send(
        "POST",
        "/v1/automations",
        command({
          body: {
            slug: "nightly-report",
            name: "Nightly report",
            description: "Synthetic scheduled automation.",
          },
        }),
      );
      assertEquals(created.status, 201);
      const body = await created.json() as Record<string, unknown>;
      automationId = body.id as string;
      assertEquals(body.slug, "nightly-report");
      assertEquals(body.activeVersionId, null);
      assertEquals(body.enabled, true);
      assertEquals(body.nextFireAt, null);
      assertEquals(body.version, 1);
      assertEquals(await facts(), {
        definitions: 1,
        versions: 0,
        audit: 1,
        events: 1,
      });
      // A duplicate slug is a conflict and writes nothing.
      await expectNoFacts(
        () =>
          send(
            "POST",
            "/v1/automations",
            command({
              body: { slug: "nightly-report", name: "Again", description: "" },
            }),
          ),
        409,
      );
      const got = await send(
        "GET",
        `/v1/automations/${automationId}`,
        read(cookies.developerA, organizationAId),
      );
      assertEquals(got.status, 200);
      assertEquals((await got.json() as { id: string }).id, automationId);
      for (
        const [cookie, organizationId, expected] of [
          [cookies.adminB, organizationBId, 0],
          [cookies.developerA, organizationAId, 1],
        ] as const
      ) {
        const listed = await send(
          "GET",
          "/v1/automations",
          read(cookie, organizationId),
        );
        assertEquals(listed.status, 200);
        assertEquals(
          (await listed.json() as { items: unknown[] }).items.length,
          expected,
        );
      }
      // Another organization cannot read it.
      assertEquals(
        (await send(
          "GET",
          `/v1/automations/${automationId}`,
          read(cookies.adminB, organizationBId),
        )).status,
        404,
      );
    });

    await test.step("a version pins a validated trigger, a published workflow version and its inputs", async () => {
      const created = await send(
        "POST",
        `/v1/automations/${automationId}/versions`,
        command({ body: versionBody() }),
      );
      assertEquals(created.status, 201);
      const body = await created.json() as Record<string, unknown>;
      versionId = body.id as string;
      assertEquals(body.revision, 1);
      assertEquals(body.automationId, automationId);
      assertEquals(body.workflowVersionId, publishedA);
      assertEquals(body.actorId, adminA.principalId);
      assertEquals(body.misfirePolicy, "coalesce");
      assertEquals(body.overlapPolicy, "skip");
      assertEquals(body.trigger, schedule);
      assertEquals(body.inputs, { branch: "main" });
      assert(typeof body.digest === "string" && body.digest.length === 64);
      // An event trigger is normalized, and the revision counts up.
      const event = await send(
        "POST",
        `/v1/automations/${automationId}/versions`,
        command({
          body: versionBody({
            trigger: {
              type: "event",
              provider: "github",
              kind: "issues",
              action: "opened",
              filter: { repository: "acme/web", draft: false },
            },
            misfirePolicy: "skip",
            overlapPolicy: "queue_one",
          }),
        }),
      );
      assertEquals(event.status, 201);
      const eventBody = await event.json() as Record<string, unknown>;
      secondVersionId = eventBody.id as string;
      assertEquals(eventBody.revision, 2);
      assertEquals(eventBody.trigger, {
        type: "event",
        provider: "github",
        kind: "issues",
        action: "opened",
        filter: { draft: false, repository: "acme/web" },
      });
      assert(eventBody.digest !== body.digest);
      // The same content is the same digest.
      const again = await send(
        "POST",
        `/v1/automations/${automationId}/versions`,
        command({ body: versionBody() }),
      );
      assertEquals(
        (await again.json() as { digest: string }).digest,
        body.digest,
      );
      assertEquals((await facts()).versions, 3);
    });

    await test.step("a trigger that is not exactly one of the two shapes, an unpublished or foreign workflow version, and a stranger are refused with nothing written", async () => {
      const bad: Record<string, unknown>[] = [
        { type: "schedule", cron: "@daily", timezone: "UTC" },
        { type: "schedule", cron: "* * * * * *", timezone: "UTC" },
        { type: "schedule", cron: "0 9 * * *", timezone: "+02:00" },
        { type: "schedule", cron: "0 9 * * *", timezone: "Mars/Olympus" },
        { type: "schedule", cron: "0 9 * * *", timezone: "UTC", extra: 1 },
        { type: "schedule", cron: "0 9 * * *" },
        {
          type: "event",
          provider: "github",
          kind: "issues",
          filter: { a: { b: 1 } },
        },
        { type: "event", provider: "gitlab", kind: "issues" },
        { type: "event", provider: "github", kind: "Issues" },
        {
          type: "event",
          provider: "github",
          kind: "issues",
          filter: { "a b": 1 },
        },
        { type: "run", command: "rm -rf /" },
        { type: "schedule", cron: "$(id)", timezone: "UTC" },
      ];
      for (const trigger of bad) {
        const response = await expectNoFacts(
          () =>
            send(
              "POST",
              `/v1/automations/${automationId}/versions`,
              command({ body: versionBody({ trigger }) }),
            ),
          422,
        );
        await response.body?.cancel();
      }
      for (const trigger of [null, 7, "0 9 * * *", [schedule]]) {
        const response = await expectNoFacts(
          () =>
            send(
              "POST",
              `/v1/automations/${automationId}/versions`,
              command({ body: versionBody({ trigger }) }),
            ),
          422,
        );
        await response.body?.cancel();
      }
      for (
        const workflowVersionId of [
          draftA, // not published
          publishedB, // another organization's
          crypto.randomUUID(), // none
        ]
      ) {
        const response = await expectNoFacts(
          () =>
            send(
              "POST",
              `/v1/automations/${automationId}/versions`,
              command({ body: versionBody({ workflowVersionId }) }),
            ),
          422,
        );
        await response.body?.cancel();
      }
      // A developer cannot publish; another organization's admin cannot reach the automation.
      await expectNoFacts(
        () =>
          send(
            "POST",
            `/v1/automations/${automationId}/versions`,
            command({ cookie: cookies.developerA, body: versionBody() }),
          ),
        403,
      );
      assertEquals(
        (await send(
          "POST",
          `/v1/automations/${automationId}/versions`,
          command({
            cookie: cookies.adminB,
            organizationId: organizationBId,
            body: versionBody({ workflowVersionId: publishedB }),
          }),
        )).status,
        404,
      );
    });

    await test.step("versions list newest first with a cursor, for Developers, nothing for another organization", async () => {
      const first = await send(
        "GET",
        `/v1/automations/${automationId}/versions?limit=2`,
        read(cookies.developerA, organizationAId),
      );
      assertEquals(first.status, 200);
      const page = await first.json() as {
        items: { revision: number }[];
        nextCursor: string | null;
      };
      assertEquals(page.items.map((item) => item.revision), [3, 2]);
      assert(page.nextCursor);
      const second = await send(
        "GET",
        `/v1/automations/${automationId}/versions?limit=2&cursor=${
          encodeURIComponent(page.nextCursor)
        }`,
        read(cookies.developerA, organizationAId),
      );
      const rest = await second.json() as {
        items: { revision: number }[];
        nextCursor: string | null;
      };
      assertEquals(rest.items.map((item) => item.revision), [1]);
      assertEquals(rest.nextCursor, null);
      assertEquals(
        (await send(
          "GET",
          `/v1/automations/${automationId}/versions`,
          read(cookies.adminB, organizationBId),
        )).status,
        404,
      );
    });

    await test.step("activating a scheduled version starts the cursor, disabling keeps it hidden, an event version has none, a stranger's version is refused", async () => {
      const activate = await send(
        "PATCH",
        `/v1/automations/${automationId}`,
        command({ body: { activeVersionId: versionId }, ifMatch: '"1"' }),
      );
      assertEquals(activate.status, 200);
      const active = await activate.json() as Record<string, unknown>;
      assertEquals(active.activeVersionId, versionId);
      assertEquals(active.version, 2);
      // The cursor is the first weekday 09:00 in Berlin after now, in UTC.
      assert(typeof active.nextFireAt === "string");
      const fire = new Date(active.nextFireAt as string);
      assert(fire.getTime() > Date.now());
      assertEquals(fire.getUTCMinutes(), 0);
      assert([7, 8].includes(fire.getUTCHours()), `hour ${fire.getUTCHours()}`);
      assert(![0, 6].includes(fire.getUTCDay()));
      // Disabled: no next fire time is shown, but the scheduler keeps its cursor.
      const disabled = await send(
        "PATCH",
        `/v1/automations/${automationId}`,
        command({ body: { enabled: false }, ifMatch: '"2"' }),
      );
      const off = await disabled.json() as Record<string, unknown>;
      assertEquals(off.enabled, false);
      assertEquals(off.nextFireAt, null);
      const cursor = await owner<{ next: Date | null }[]>`
        select next_fire_at as next from bakery.automation_definitions where id = ${automationId}`;
      assertEquals(cursor[0]!.next?.toISOString(), active.nextFireAt);
      // Re-enabled: the same cursor is shown again.
      const enabled = await send(
        "PATCH",
        `/v1/automations/${automationId}`,
        command({ body: { enabled: true, name: "Nightly" }, ifMatch: '"3"' }),
      );
      const on = await enabled.json() as Record<string, unknown>;
      assertEquals(on.enabled, true);
      assertEquals(on.name, "Nightly");
      assertEquals(on.nextFireAt, active.nextFireAt);
      // An event version has no schedule: the cursor is cleared.
      const toEvent = await send(
        "PATCH",
        `/v1/automations/${automationId}`,
        command({ body: { activeVersionId: secondVersionId }, ifMatch: '"4"' }),
      );
      const event = await toEvent.json() as Record<string, unknown>;
      assertEquals(event.activeVersionId, secondVersionId);
      assertEquals(event.nextFireAt, null);
      // No active version at all.
      const none = await send(
        "PATCH",
        `/v1/automations/${automationId}`,
        command({ body: { activeVersionId: null }, ifMatch: '"5"' }),
      );
      const cleared = await none.json() as Record<string, unknown>;
      assertEquals(cleared.activeVersionId, null);
      assertEquals(cleared.nextFireAt, null);
      assertEquals(cleared.version, 6);
      // A version of another automation, or one that does not exist.
      const other = await send(
        "POST",
        "/v1/automations",
        command({
          body: { slug: "other", name: "Other", description: "" },
        }),
      );
      const otherId = (await other.json() as { id: string }).id;
      const foreign = await send(
        "POST",
        `/v1/automations/${otherId}/versions`,
        command({ body: versionBody() }),
      );
      const foreignVersion = (await foreign.json() as { id: string }).id;
      for (const activeVersionId of [foreignVersion, crypto.randomUUID()]) {
        const before = await facts();
        const refused = await send(
          "PATCH",
          `/v1/automations/${automationId}`,
          command({ body: { activeVersionId }, ifMatch: '"6"' }),
        );
        assertEquals(refused.status, 422);
        await refused.body?.cancel();
        assertEquals(await facts(), before);
      }
    });

    await test.step("a change needs the current version; a developer and another organization cannot make one", async () => {
      const before = await facts();
      const stale = await send(
        "PATCH",
        `/v1/automations/${automationId}`,
        command({ body: { name: "Stale" }, ifMatch: '"1"' }),
      );
      assertEquals(stale.status, 412);
      await stale.body?.cancel();
      const missing = await send(
        "PATCH",
        `/v1/automations/${automationId}`,
        command({ body: { name: "Missing" } }),
      );
      assertEquals(missing.status, 428);
      await missing.body?.cancel();
      const developer = await send(
        "PATCH",
        `/v1/automations/${automationId}`,
        command({
          cookie: cookies.developerA,
          body: { name: "Developer" },
          ifMatch: '"6"',
        }),
      );
      assertEquals(developer.status, 403);
      await developer.body?.cancel();
      const stranger = await send(
        "PATCH",
        `/v1/automations/${automationId}`,
        command({
          cookie: cookies.adminB,
          organizationId: organizationBId,
          body: { name: "Stranger" },
          ifMatch: '"6"',
        }),
      );
      assertEquals(stranger.status, 404);
      await stranger.body?.cancel();
      assertEquals(await facts(), before);
    });

    await test.step("firings list by scheduled instant, newest first, with pending and skippedCount, across versions", async () => {
      const instants = [
        "2026-11-10T08:00:00.000Z",
        "2026-11-11T08:00:00.000Z",
        "2026-11-12T08:00:00.000Z",
      ];
      for (const [index, instant] of instants.entries()) {
        await owner`
          insert into bakery.automation_firings (
            organization_id, automation_version_id, scheduled_at, status,
            pending, skipped_count
          ) values (
            ${organizationAId},
            ${index === 1 ? secondVersionId : versionId},
            ${instant}, ${index === 2 ? "queued" : "started"},
            ${index === 2}, ${index === 2 ? 3 : 0}
          )`;
      }
      const first = await send(
        "GET",
        `/v1/automations/${automationId}/firings?limit=2`,
        read(cookies.developerA, organizationAId),
      );
      assertEquals(first.status, 200);
      const page = await first.json() as {
        items: {
          scheduledAt: string;
          status: string;
          pending: boolean;
          skippedCount: number;
          triggerEventId: string | null;
          runId: string | null;
          version: number;
        }[];
        nextCursor: string | null;
      };
      assertEquals(page.items.map((item) => item.scheduledAt), [
        instants[2],
        instants[1],
      ]);
      assertEquals(page.items[0]!.status, "queued");
      assertEquals(page.items[0]!.pending, true);
      assertEquals(page.items[0]!.skippedCount, 3);
      assertEquals(page.items[1]!.pending, false);
      assertEquals(page.items[1]!.skippedCount, 0);
      assertEquals(page.items[0]!.triggerEventId, null);
      assertEquals(page.items[0]!.runId, null);
      assert(page.nextCursor);
      const second = await send(
        "GET",
        `/v1/automations/${automationId}/firings?limit=2&cursor=${
          encodeURIComponent(page.nextCursor)
        }`,
        read(cookies.developerA, organizationAId),
      );
      const rest = await second.json() as {
        items: { scheduledAt: string }[];
        nextCursor: string | null;
      };
      assertEquals(rest.items.map((item) => item.scheduledAt), [instants[0]]);
      assertEquals(rest.nextCursor, null);
      // Another automation has none, and another organization cannot read these.
      assertEquals(
        (await send(
          "GET",
          `/v1/automations/${automationId}/firings`,
          read(cookies.adminB, organizationBId),
        )).status,
        404,
      );
    });
  } finally {
    await fixture.close();
  }
});
