import { assert, assertEquals } from "@std/assert";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  openDatabase,
} from "../../apps/server/src/platform/database.ts";
import { resetTestDatabase } from "../../apps/server/src/platform/migrate.ts";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";

// A definition installed from the catalog is system managed: the server refuses
// every organization-facing authoring mutation on it, whatever its slug says,
// and still lets the organization read it and choose what to run. The lock is
// the definition's immutable origin, so these tests make a definition catalog
// origin by the column and give it an ordinary slug.
const databaseConfig = readTestDatabaseConfig();

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

Deno.test("an organization cannot edit, draft or publish a catalog definition, and can still edit its own", async () => {
  await resetDatabase();
  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  const now = new Date();
  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `admin-${crypto.randomUUID()}`;
  try {
    await owner`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'Lock org', ${`lock-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    await owner`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, 'admin', ${`admin-${userId}@example.test`}, true, ${now}, ${now})`;
    await owner`insert into public.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
      values (${crypto.randomUUID()}, ${token}, ${userId}, ${new Date(
      Date.now() + 86_400_000,
    )}, ${now}, ${now})`;
    await owner`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
      values (${principalId}, ${userId}, 'admin', 'human')`;
    await owner`insert into bakery.organization_memberships (id, organization_id, principal_id, role, status, joined_at, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${principalId}, 'admin', 'active', ${now}, ${now}, ${now}, 1)`;
    const cookie = await signSessionCookie(token, fixture.config.auth!.secret);
    const send = (
      method: string,
      path: string,
      body?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const headers = new Headers({
        cookie,
        "Bakery-Organization-Id": organizationId,
        ...extra,
      });
      if (body !== undefined) headers.set("content-type", "application/json");
      if (method !== "GET") {
        headers.set("origin", authTestOrigin);
        headers.set("Idempotency-Key", crypto.randomUUID());
      }
      return fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    };
    const create = async (slug: string) => {
      const response = await send("POST", "/v1/workflows", {
        slug,
        name: slug,
        description: "A workflow.",
      });
      assertEquals(response.status, 201, await response.clone().text());
      return await response.json() as { id: string; version: number };
    };

    // The control: an authored definition is editable.
    const authored = await create("authored-flow");
    const edited = await send(
      "PATCH",
      `/v1/workflows/${authored.id}`,
      { name: "Renamed" },
      { "If-Match": `"${authored.version}"` },
    );
    assertEquals(edited.status, 200);

    // A catalog definition under an ordinary slug: the slug is not the lock.
    const supplied = await create("supplied-flow");
    await owner`update bakery.workflow_definitions
      set origin_kind = 'catalog', origin_catalog_key = 'supplied-flow',
          origin_catalog_version = 1
      where id = ${supplied.id}`;
    const refused = async (response: Response) => {
      assertEquals(response.status, 409);
      const problem = await response.json() as {
        code: string;
        reason?: string;
        params?: { reason?: string };
      };
      assertEquals(problem.code, "STATE_CONFLICT");
      assertEquals(problem.reason ?? problem.params?.reason, "workflow_locked");
    };
    await refused(
      await send(
        "PATCH",
        `/v1/workflows/${supplied.id}`,
        { name: "Mine now" },
        { "If-Match": `"${supplied.version}"` },
      ),
    );
    await refused(
      await send("POST", `/v1/workflows/${supplied.id}/versions`, {
        definition: { name: "x", steps: [] },
      }),
    );
    await refused(
      await send(
        "PATCH",
        `/v1/workflows/${supplied.id}/versions/${crypto.randomUUID()}`,
        { definition: { name: "x", steps: [] } },
        { "If-Match": '"1"' },
      ),
    );
    await refused(
      await send(
        "POST",
        `/v1/workflows/${supplied.id}/versions/${crypto.randomUUID()}/publish`,
        { expectedDigest: "0".repeat(64) },
        { "If-Match": '"1"' },
      ),
    );

    // The slug is not the lock in either direction: a person's own definition
    // whose slug merely starts with "preset:" is theirs to edit.
    const typed = await create("typed-by-a-person");
    await owner`update bakery.workflow_definitions set slug = 'preset:typed-by-a-person'
      where id = ${typed.id}`;
    const typedEdit = await send(
      "PATCH",
      `/v1/workflows/${typed.id}`,
      { name: "Still mine" },
      { "If-Match": `"${typed.version}"` },
    );
    assertEquals(typedEdit.status, 200);

    // Nothing was written, and reading it is still allowed.
    const after =
      await owner`select name, version from bakery.workflow_definitions where id = ${supplied.id}`;
    assertEquals(after[0]?.name, "supplied-flow");
    assertEquals(Number(after[0]?.version), supplied.version);
    const read = await send("GET", `/v1/workflows/${supplied.id}`);
    assertEquals(read.status, 200);
    assert(
      (await read.json() as { origin: { kind: string } }).origin.kind ===
        "catalog",
    );
  } finally {
    try {
      await fixture.close();
    } finally {
      await resetDatabase();
    }
  }
});
