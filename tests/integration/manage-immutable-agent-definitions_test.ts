import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import { appendDomainEvent } from "../../packages/persistence/src/event-audit.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { resetTestDatabase } from "../../apps/server/src/platform/migrate.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
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

type FactCounts = {
  definitions: number;
  versions: number;
  audit: number;
  events: number;
  replay: number;
  outbox: number;
};

async function digest(config: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(config));
}

async function databaseCount(
  database: ReturnType<typeof openPgDatabase>,
  sql: string,
  values: readonly unknown[],
): Promise<number> {
  const result = await database.query<{ count: string }>(sql, [...values]);
  return Number(result.rows[0]?.count ?? 0);
}

async function counts(
  database: ReturnType<typeof openPgDatabase>,
  organizationId: string,
): Promise<FactCounts> {
  const values = [organizationId];
  return {
    definitions: await databaseCount(
      database,
      "select count(*) from bakery.agent_definitions where organization_id = $1",
      values,
    ),
    versions: await databaseCount(
      database,
      "select count(*) from bakery.agent_versions where organization_id = $1",
      values,
    ),
    audit: await databaseCount(
      database,
      `select count(*) from bakery.audit_events
        where organization_id = $1
          and operation in ('agents.create', 'agents.update', 'agentVersions.create')`,
      values,
    ),
    events: await databaseCount(
      database,
      `select count(*) from bakery.domain_events
        where organization_id = $1
          and event_type in ('agents.created', 'agents.updated', 'agent.version_created')`,
      values,
    ),
    replay: await databaseCount(
      database,
      `select count(*) from bakery.idempotency_records
        where organization_id = $1
          and operation in ('agents.create', 'agents.update', 'agentVersions.create')`,
      values,
    ),
    outbox: await databaseCount(
      database,
      "select count(*) from bakery.outbox where organization_id = $1",
      values,
    ),
  };
}

Deno.test("manage immutable agent definitions through the mounted PostgreSQL API", async (test) => {
  const readiness = openPgDatabase(databaseConfig.databaseUrl);
  const invalidUrl = new URL(databaseConfig.databaseUrl);
  invalidUrl.password = "synthetic-invalid-password";
  invalidUrl.searchParams.set("connect_timeout", "2");
  const rejectedAuthentication = openPgDatabase(invalidUrl.href);
  try {
    assertEquals(
      (await readiness.query<{ ready: number }>("select 1 as ready")).rows[0]
        ?.ready,
      1,
    );
    await assertRejects(() => rejectedAuthentication.query("select 1"));
  } finally {
    await Promise.all([
      closePgDatabase(readiness),
      closePgDatabase(rejectedAuthentication),
    ]);
  }

  const reset = openDatabase(databaseConfig.databaseUrl);
  try {
    await resetTestDatabase(reset, {
      targetUrl: databaseConfig.databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
  } finally {
    await closeDatabase(reset);
  }

  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  const runtime = fixture.runtimePgDatabase;
  const now = new Date("2026-10-04T12:00:00.000Z");
  const sessionExpiresAt = new Date(Date.now() + 86_400_000);
  const organizationAId = crypto.randomUUID();
  const organizationBId = crypto.randomUUID();
  const adminA = {
    userId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    token: `admin-a-${crypto.randomUUID()}`,
    email: `admin-a-${crypto.randomUUID()}@example.test`,
    name: "Admin A",
    organizationId: organizationAId,
    role: "admin",
  } as const;
  const developerA = {
    userId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    token: `developer-a-${crypto.randomUUID()}`,
    email: `developer-a-${crypto.randomUUID()}@example.test`,
    name: "Developer A",
    organizationId: organizationAId,
    role: "developer",
  } as const;
  const adminB = {
    userId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
    token: `admin-b-${crypto.randomUUID()}`,
    email: `admin-b-${crypto.randomUUID()}@example.test`,
    name: "Admin B",
    organizationId: organizationBId,
    role: "admin",
  } as const;

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
    for (const identity of [adminA, developerA, adminB]) {
      await owner`
        insert into public."user" (
          id, name, email, "emailVerified", "createdAt", "updatedAt"
        ) values (
          ${identity.userId}, ${identity.name}, ${identity.email}, true,
          ${now}, ${now}
        )`;
      await owner`
        insert into public.session (
          id, token, "userId", "expiresAt", "createdAt", "updatedAt"
        ) values (
          ${crypto.randomUUID()}, ${identity.token}, ${identity.userId},
          ${sessionExpiresAt}, ${now}, ${now}
        )`;
      await owner`
        insert into bakery.principals (
          id, provider_user_id, display_name, principal_type
        ) values (
          ${identity.principalId}, ${identity.userId}, ${identity.name}, 'human'
        )`;
      await owner`
        insert into bakery.organization_memberships (
          id, organization_id, principal_id, role, status, joined_at,
          created_at, updated_at, version
        ) values (
          ${crypto.randomUUID()}, ${identity.organizationId},
          ${identity.principalId}, ${identity.role}, 'active', ${now},
          ${now}, ${now}, 1
        )`;
    }

    const cookies = {
      adminA: await signSessionCookie(
        adminA.token,
        fixture.config.auth!.secret,
      ),
      developerA: await signSessionCookie(
        developerA.token,
        fixture.config.auth!.secret,
      ),
      adminB: await signSessionCookie(
        adminB.token,
        fixture.config.auth!.secret,
      ),
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
    const expectNoFacts = async (
      request: () => Promise<Response> | Response,
      expectedStatus: number,
    ): Promise<Response> => {
      const before = await counts(runtime, organizationAId);
      const response = await request();
      assertEquals(response.status, expectedStatus);
      assertEquals(await counts(runtime, organizationAId), before);
      return response;
    };

    await test.step("mounted readiness and authentication boundary", async () => {
      const ready = await send("GET", "/readyz");
      assertEquals(ready.status, 200);
      const unauthenticated = await send("GET", "/v1/agents", {
        organizationId: organizationAId,
      });
      assertEquals(unauthenticated.status, 401);
      const developerCreate = await send("POST", "/v1/agents", {
        cookie: cookies.developerA,
        organizationId: organizationAId,
        idempotencyKey: crypto.randomUUID(),
        body: { slug: "forbidden", name: "Forbidden", description: "" },
      });
      assertEquals(developerCreate.status, 403);
    });

    let agentAId = "";
    let createdAgentBody = "";
    await test.step("create, exact replay, mismatch, and scoped reads", async () => {
      const createOptions = command({
        idempotencyKey: "agent-create-replay",
        body: {
          slug: "release-manager",
          name: "Release manager",
          description: "Coordinates a synthetic release.",
        },
      });
      const created = await send("POST", "/v1/agents", createOptions);
      assertEquals(created.status, 201);
      createdAgentBody = await created.text();
      agentAId = (JSON.parse(createdAgentBody) as { id: string }).id;
      const afterCreate = await counts(runtime, organizationAId);
      assertEquals(afterCreate, {
        definitions: 1,
        versions: 0,
        audit: 1,
        events: 1,
        replay: 1,
        outbox: 0,
      });

      const replay = await send("POST", "/v1/agents", createOptions);
      assertEquals(replay.status, 201);
      assertEquals(await replay.text(), createdAgentBody);
      assertEquals(await counts(runtime, organizationAId), afterCreate);

      const mismatch = await expectNoFacts(
        () =>
          send("POST", "/v1/agents", {
            ...createOptions,
            body: {
              slug: "release-manager-changed",
              name: "Changed",
              description: "Changed replay input.",
            },
          }),
        422,
      );
      assertEquals(
        (await mismatch.json() as { code: string }).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );

      const developerGet = await send("GET", `/v1/agents/${agentAId}`, {
        cookie: cookies.developerA,
        organizationId: organizationAId,
      });
      assertEquals(developerGet.status, 200);
      const foreignGet = await send("GET", `/v1/agents/${agentAId}`, {
        cookie: cookies.adminB,
        organizationId: organizationBId,
      });
      assertEquals(foreignGet.status, 404);
    });

    await test.step("optimistic update changes only mutable fields", async () => {
      await expectNoFacts(
        () =>
          send(
            "PATCH",
            `/v1/agents/${agentAId}`,
            command({
              body: { name: "No precondition" },
              idempotencyKey: "agent-update-no-precondition",
            }),
          ),
        428,
      );
      const update = await send(
        "PATCH",
        `/v1/agents/${agentAId}`,
        command({
          body: {
            name: "Release coordinator",
            description: null,
            enabled: false,
          },
          ifMatch: '"1"',
          idempotencyKey: "agent-update-success",
        }),
      );
      assertEquals(update.status, 200);
      const updated = await update.json() as Record<string, unknown>;
      assertEquals(updated.slug, "release-manager");
      assertEquals(updated.name, "Release coordinator");
      assertEquals(updated.description, null);
      assertEquals(updated.enabled, false);
      assertEquals(updated.activeVersionId, null);
      assertEquals(updated.version, 2);
      await expectNoFacts(
        () =>
          send(
            "PATCH",
            `/v1/agents/${agentAId}`,
            command({
              body: { enabled: true },
              ifMatch: '"1"',
              idempotencyKey: "agent-update-stale",
            }),
          ),
        412,
      );
    });

    const config1 = {
      skillBindings: {},
      allowedCapabilities: ["shell", "git"],
      harness: "pi",
      promptBindings: {},
    };
    let version1Id = "";
    await test.step("canonical publication validates config, digest, and bindings", async () => {
      const canonicalDigest = await digest(config1);
      const publishOptions = command({
        idempotencyKey: "agent-version-1",
        body: { revision: 1, config: config1, digest: canonicalDigest },
      });
      const published = await send(
        "POST",
        `/v1/agents/${agentAId}/versions`,
        publishOptions,
      );
      assertEquals(published.status, 201);
      const publishedText = await published.text();
      const body = JSON.parse(publishedText) as Record<string, unknown>;
      version1Id = body.id as string;
      assertEquals(body.revision, 1);
      assertEquals(body.digest, canonicalDigest);
      assertEquals(body.config, config1);
      assertEquals(body.version, 1);
      const afterPublish = await counts(runtime, organizationAId);
      const replay = await send(
        "POST",
        `/v1/agents/${agentAId}/versions`,
        publishOptions,
      );
      assertEquals(replay.status, 201);
      assertEquals(await replay.text(), publishedText);
      assertEquals(await counts(runtime, organizationAId), afterPublish);
      const mismatch = await expectNoFacts(
        () =>
          send("POST", `/v1/agents/${agentAId}/versions`, {
            ...publishOptions,
            body: {
              revision: 1,
              config: config1,
              digest: "0".repeat(64),
            },
          }),
        422,
      );
      assertEquals(
        (await mismatch.json() as { code: string }).code,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
      );

      await expectNoFacts(
        () =>
          send(
            "POST",
            `/v1/agents/${agentAId}/versions`,
            command({
              body: {
                revision: 2,
                config: config1,
                digest: "0".repeat(64),
              },
            }),
          ),
        422,
      );
      const invalidCapabilityConfig = {
        harness: "pi",
        allowedCapabilities: ["agents.create"],
      };
      const invalidCapabilityDigest = await digest(invalidCapabilityConfig);
      await expectNoFacts(
        () =>
          send(
            "POST",
            `/v1/agents/${agentAId}/versions`,
            command({
              body: {
                revision: 2,
                config: invalidCapabilityConfig,
                digest: invalidCapabilityDigest,
              },
            }),
          ),
        422,
      );
      const unknownConfig = { harness: "pi", unknown: true };
      const unknownDigest = await digest(unknownConfig);
      await expectNoFacts(
        () =>
          send(
            "POST",
            `/v1/agents/${agentAId}/versions`,
            command({
              body: {
                revision: 2,
                config: unknownConfig,
                digest: unknownDigest,
              },
            }),
          ),
        422,
      );
      for (const binding of ["promptBindings", "skillBindings"] as const) {
        const invalidConfig = { harness: "pi", [binding]: { main: "v1" } };
        const invalidDigest = await digest(invalidConfig);
        await expectNoFacts(
          () =>
            send(
              "POST",
              `/v1/agents/${agentAId}/versions`,
              command({
                body: {
                  revision: 2,
                  config: invalidConfig,
                  digest: invalidDigest,
                },
              }),
            ),
          422,
        );
      }
      const stored = await runtime.query<{ config: unknown }>(
        "select config from bakery.agent_versions where organization_id = $1 and id = $2",
        [organizationAId, version1Id],
      );
      assertEquals(stored.rows[0]?.config, config1);
      const privilege = await runtime.query<{ allowed: boolean }>(
        "select has_table_privilege(current_user, 'bakery.agent_versions', 'UPDATE') as allowed",
      );
      assertEquals(privilege.rows[0]?.allowed, false);
    });

    await test.step("same revision concurrency commits once", async () => {
      const config = { harness: "codex", allowedCapabilities: ["shell"] };
      const input = { revision: 2, config, digest: await digest(config) };
      let requests: [
        Promise<Response> | Response,
        Promise<Response> | Response,
      ];
      await withPgTransaction(runtime, async (transaction) => {
        await transaction.query(
          "select 1 from bakery.agent_definitions where organization_id = $1 and id = $2 for update",
          [organizationAId, agentAId],
        );
        const first = send(
          "POST",
          `/v1/agents/${agentAId}/versions`,
          command({
            idempotencyKey: "same-revision-a",
            body: input,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        const second = send(
          "POST",
          `/v1/agents/${agentAId}/versions`,
          command({
            idempotencyKey: "same-revision-b",
            body: input,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        requests = [first, second];
      });
      const responses = await Promise.all(requests!);
      assertEquals(responses.map(({ status }) => status).sort(), [201, 409]);
      assertEquals(
        await databaseCount(
          runtime,
          "select count(*) from bakery.agent_versions where organization_id = $1 and agent_id = $2 and revision = 2",
          [organizationAId, agentAId],
        ),
        1,
      );
    });

    await test.step("next revision queued first commits both in caller order", async () => {
      const config3 = { harness: "pi", allowedCapabilities: ["web"] };
      const config4 = { harness: "pi", allowedCapabilities: ["browser"] };
      let requests: [
        Promise<Response> | Response,
        Promise<Response> | Response,
      ];
      await withPgTransaction(runtime, async (transaction) => {
        await transaction.query(
          "select 1 from bakery.agent_definitions where organization_id = $1 and id = $2 for update",
          [organizationAId, agentAId],
        );
        const next = send(
          "POST",
          `/v1/agents/${agentAId}/versions`,
          command({
            idempotencyKey: "distinct-revision-3",
            body: {
              revision: 3,
              config: config3,
              digest: await digest(config3),
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        const following = send(
          "POST",
          `/v1/agents/${agentAId}/versions`,
          command({
            idempotencyKey: "distinct-revision-4",
            body: {
              revision: 4,
              config: config4,
              digest: await digest(config4),
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        requests = [next, following];
      });
      assertEquals(
        (await Promise.all(requests!)).map(({ status }) => status),
        [201, 201],
      );
    });

    let agentBId = "";
    await test.step("later revision queued first conflicts without reordering", async () => {
      const created = await send(
        "POST",
        "/v1/agents",
        command({
          idempotencyKey: "agent-b-create",
          body: {
            slug: "quality-agent",
            name: "Quality agent",
            description: "",
          },
        }),
      );
      assertEquals(created.status, 201);
      agentBId = (await created.json() as { id: string }).id;
      const firstConfig = { harness: "pi", allowedCapabilities: ["paper"] };
      assertEquals(
        (await send(
          "POST",
          `/v1/agents/${agentBId}/versions`,
          command({
            idempotencyKey: "agent-b-version-1",
            body: {
              revision: 1,
              config: firstConfig,
              digest: await digest(firstConfig),
            },
          }),
        )).status,
        201,
      );
      const config2 = { harness: "pi", allowedCapabilities: ["model"] };
      const config3 = { harness: "pi", allowedCapabilities: ["web"] };
      let requests: [
        Promise<Response> | Response,
        Promise<Response> | Response,
      ];
      await withPgTransaction(runtime, async (transaction) => {
        await transaction.query(
          "select 1 from bakery.agent_definitions where organization_id = $1 and id = $2 for update",
          [organizationAId, agentBId],
        );
        const later = send(
          "POST",
          `/v1/agents/${agentBId}/versions`,
          command({
            idempotencyKey: "agent-b-version-3",
            body: {
              revision: 3,
              config: config3,
              digest: await digest(config3),
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        const next = send(
          "POST",
          `/v1/agents/${agentBId}/versions`,
          command({
            idempotencyKey: "agent-b-version-2",
            body: {
              revision: 2,
              config: config2,
              digest: await digest(config2),
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        requests = [later, next];
      });
      assertEquals(
        (await Promise.all(requests!)).map(({ status }) => status),
        [409, 201],
      );
    });

    await test.step("signed scoped cursors and version ordering", async () => {
      const firstPage = await send("GET", "/v1/agents?limit=1", {
        cookie: cookies.developerA,
        organizationId: organizationAId,
      });
      assertEquals(firstPage.status, 200);
      const page = await firstPage.json() as {
        items: unknown[];
        nextCursor: string | null;
      };
      assertEquals(page.items.length, 1);
      assert(page.nextCursor);
      const secondPage = await send(
        "GET",
        `/v1/agents?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
        { cookie: cookies.developerA, organizationId: organizationAId },
      );
      assertEquals(secondPage.status, 200);
      const foreignCursor = await send(
        "GET",
        `/v1/agents?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
        { cookie: cookies.adminB, organizationId: organizationBId },
      );
      assertEquals(foreignCursor.status, 400);
      assertEquals(
        (await send("GET", "/v1/agents?limit=0", {
          cookie: cookies.developerA,
          organizationId: organizationAId,
        })).status,
        400,
      );
      const versions = await send(
        "GET",
        `/v1/agents/${agentAId}/versions?limit=2`,
        { cookie: cookies.developerA, organizationId: organizationAId },
      );
      assertEquals(versions.status, 200);
      const versionPage = await versions.json() as {
        items: Array<{ revision: number }>;
        nextCursor: string | null;
      };
      assertEquals(versionPage.items.map(({ revision }) => revision), [4, 3]);
      assert(versionPage.nextCursor);
      assertEquals(
        (await send("GET", `/v1/agents/${agentAId}/versions`, {
          cookie: cookies.adminB,
          organizationId: organizationBId,
        })).status,
        404,
      );
    });

    await test.step("activation is Admin-only, tenant-scoped, compare-and-swap and audited", async () => {
      const activations = async (organizationId: string) =>
        (await runtime.query<{ count: string }>(
          `select count(*) from bakery.audit_events
            where organization_id = $1
              and operation = 'agents.activateVersion'`,
          [organizationId],
        )).rows[0].count;
      const definition = async () =>
        await (await send("GET", `/v1/agents/${agentAId}`, command()))
          .json() as { version: number; activeVersionId: string | null };
      const activate = (
        versionId: string,
        version: number,
        overrides: Partial<SendOptions> = {},
      ) =>
        send(
          "POST",
          `/v1/agents/${agentAId}/activations`,
          command({
            body: { versionId },
            ifMatch: `"${version}"`,
            ...overrides,
          }),
        );
      const versionIds = (await (await send(
        "GET",
        `/v1/agents/${agentAId}/versions`,
        command(),
      )).json() as { items: { id: string; revision: number }[] }).items
        .sort((left, right) => left.revision - right.revision)
        .map(({ id }) => id);
      assertEquals(versionIds[0], version1Id);
      const before = await definition();
      assertEquals(before.activeVersionId, null);

      // Not an Admin: refused before anything is written.
      const denied = await send(
        "POST",
        `/v1/agents/${agentAId}/activations`,
        command({
          cookie: cookies.developerA,
          body: { versionId: version1Id },
          ifMatch: `"${before.version}"`,
        }),
      );
      assertEquals(denied.status, 403);
      await denied.body?.cancel();
      // No If-Match, a stale one, an unknown version and an unknown agent.
      const missing = await activate(version1Id, before.version, {
        ifMatch: undefined,
      });
      assertEquals(missing.status, 428);
      await missing.body?.cancel();
      const stale = await activate(version1Id, before.version + 5);
      assertEquals(stale.status, 412);
      await stale.body?.cancel();
      const unknown = await activate(crypto.randomUUID(), before.version);
      assertEquals(unknown.status, 422);
      assertEquals(
        JSON.stringify(await unknown.json()).includes("agent_version_unknown"),
        true,
      );
      const missingAgent = await send(
        "POST",
        `/v1/agents/${crypto.randomUUID()}/activations`,
        command({ body: { versionId: version1Id }, ifMatch: '"1"' }),
      );
      assertEquals(missingAgent.status, 404);
      await missingAgent.body?.cancel();

      // A version from another organization is unknown here, and the other
      // organization's admin cannot reach this agent at all.
      const foreignAgent = await (await send(
        "POST",
        "/v1/agents",
        command({
          cookie: cookies.adminB,
          organizationId: organizationBId,
          body: { slug: "foreign", name: "Foreign", description: "" },
        }),
      )).json() as { id: string };
      const foreignConfig = { harness: "pi" };
      const foreignVersion = await (await send(
        "POST",
        `/v1/agents/${foreignAgent.id}/versions`,
        command({
          cookie: cookies.adminB,
          organizationId: organizationBId,
          body: {
            revision: 1,
            config: foreignConfig,
            digest: await digest(foreignConfig),
          },
        }),
      )).json() as { id: string };
      const crossTenant = await activate(foreignVersion.id, before.version);
      assertEquals(crossTenant.status, 422);
      await crossTenant.body?.cancel();
      const foreignAdmin = await send(
        "POST",
        `/v1/agents/${agentAId}/activations`,
        command({
          cookie: cookies.adminB,
          organizationId: organizationBId,
          body: { versionId: foreignVersion.id },
          ifMatch: `"${before.version}"`,
        }),
      );
      assertEquals(foreignAdmin.status, 404);
      await foreignAdmin.body?.cancel();
      assertEquals(await definition(), before);
      assertEquals(await activations(organizationAId), "0");

      // Success: pinned, versioned, audited, announced and replayable.
      const options = command({
        body: { versionId: version1Id },
        ifMatch: `"${before.version}"`,
        idempotencyKey: "agent-activate-1",
      });
      const activated = await send(
        "POST",
        `/v1/agents/${agentAId}/activations`,
        options,
      );
      assertEquals(activated.status, 200);
      const activatedText = await activated.text();
      const body = JSON.parse(activatedText) as {
        activeVersionId: string;
        version: number;
        slug: string;
      };
      assertEquals(body.activeVersionId, version1Id);
      assertEquals(body.version, before.version + 1);
      assertEquals(body.slug, "release-manager");
      assertEquals(await activations(organizationAId), "1");
      const event = await runtime.query<{ aggregate_version: number }>(
        `select aggregate_version from bakery.domain_events
          where organization_id = $1 and event_type = 'agents.updated'
            and aggregate_id = $2
          order by aggregate_version desc limit 1`,
        [organizationAId, agentAId],
      );
      assertEquals(event.rows[0].aggregate_version, body.version);
      const replay = await send(
        "POST",
        `/v1/agents/${agentAId}/activations`,
        options,
      );
      assertEquals(replay.status, 200);
      assertEquals(await replay.text(), activatedText);
      assertEquals(await activations(organizationAId), "1");

      // The same version again changes nothing; another version moves the
      // pin, and the previous If-Match is then stale.
      const again = await activate(version1Id, body.version);
      assertEquals(again.status, 200);
      assertEquals(
        (await again.json() as { version: number }).version,
        body.version,
      );
      assertEquals(await activations(organizationAId), "1");
      const moved = await activate(versionIds[1], body.version);
      assertEquals(moved.status, 200);
      const movedBody = await moved.json() as {
        activeVersionId: string;
        version: number;
      };
      assertEquals(movedBody.activeVersionId, versionIds[1]);
      assertEquals(movedBody.version, body.version + 1);
      assertEquals(await activations(organizationAId), "2");
      const late = await activate(version1Id, body.version);
      assertEquals(late.status, 412);
      await late.body?.cancel();
      assertEquals((await definition()).activeVersionId, versionIds[1]);
    });

    await test.step("audit and strict projection events commit with zero outbox", async () => {
      const eventRows = await runtime.query<{
        event_type: string;
        aggregate_id: string;
        aggregate_version: number;
        payload: { resourceId: string; resourceVersion: number };
      }>(
        `select event_type, aggregate_id, aggregate_version, payload
           from bakery.domain_events
          where organization_id = $1
            and event_type in ('agents.created', 'agents.updated', 'agent.version_created')
          order by created_at, id`,
        [organizationAId],
      );
      assert(eventRows.rows.length > 0);
      for (const event of eventRows.rows) {
        assertEquals(Object.keys(event.payload).sort(), [
          "resourceId",
          "resourceVersion",
        ]);
        assertEquals(event.payload.resourceId, event.aggregate_id);
        assertEquals(event.payload.resourceVersion, event.aggregate_version);
      }
      const revisionProjection = await runtime.query<{
        revision: number;
        version: number;
        aggregate_version: number;
      }>(
        `select version.revision, version.version, event.aggregate_version
           from bakery.agent_versions version
           join bakery.domain_events event
             on event.organization_id = version.organization_id
            and event.aggregate_id = version.id
            and event.event_type = 'agent.version_created'
          where version.organization_id = $1 and version.revision > 1
          order by version.revision desc
          limit 1`,
        [organizationAId],
      );
      assert((revisionProjection.rows[0]?.revision ?? 0) > 1);
      assertEquals(revisionProjection.rows[0]?.version, 1);
      assertEquals(revisionProjection.rows[0]?.aggregate_version, 1);
      assertEquals((await counts(runtime, organizationAId)).outbox, 0);
    });

    await test.step("malformed projection events roll back with no facts", async () => {
      for (
        const payload of [
          { resourceId: crypto.randomUUID() },
          {
            resourceId: crypto.randomUUID(),
            resourceVersion: 1,
            extra: true,
          },
        ]
      ) {
        const before = await counts(runtime, organizationAId);
        const error = await assertRejects(
          () =>
            withPgTransaction(runtime, async (transaction) => {
              await appendDomainEvent(transaction, {
                organizationId: organizationAId,
                eventType: "agents.updated",
                aggregateId: agentAId,
                aggregateVersion: 99,
                payload,
                traceId: crypto.randomUUID().replaceAll("-", ""),
              });
            }),
          StandardError,
        );
        assertEquals(error.code, "VALIDATION_FAILED");
        assertEquals(await counts(runtime, organizationAId), before);
      }
    });

    await test.step("failed commands leave no extra state, audit, replay, event, or outbox", async () => {
      const before = await counts(runtime, organizationAId);
      assertEquals(before.outbox, 0);
      const response = await send(
        "POST",
        `/v1/agents/${agentAId}/versions`,
        command({
          idempotencyKey: "non-next-final",
          body: {
            revision: 99,
            config: { harness: "pi" },
            digest: await digest({ harness: "pi" }),
          },
        }),
      );
      assertEquals(response.status, 409);
      assertEquals(await counts(runtime, organizationAId), before);
    });
  } finally {
    try {
      await fixture.close();
    } finally {
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
  }
});
