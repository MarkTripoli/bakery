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

// #35: an organization copies a workflow into an independently editable one.
// The copy is a new definition with one inactive draft, made atomically; its
// origin names the source definition, version and digest; and nothing that
// belongs to the source (activation, runs, the lock) comes with it.
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

const definition = {
  kind: "fixed",
  steps: [{ id: "first", uses: "workflow.noop" }],
};

type Origin = {
  kind: string;
  catalogKey: string | null;
  catalogVersion: number | null;
  sourceWorkflowId: string | null;
  sourceVersionId: string | null;
  sourceDigest: string | null;
};
type Workflow = {
  id: string;
  slug: string;
  version: number;
  activeVersionId: string | null;
  origin: Origin;
};

Deno.test("an organization copies a workflow into an independent draft, with its lineage", async () => {
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
      values (${organizationId}, 'Copy org', ${`copy-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
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
        if (!headers.has("Idempotency-Key")) {
          headers.set("Idempotency-Key", crypto.randomUUID());
        }
      }
      return fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    };
    const json = async <T>(response: Response, status: number): Promise<T> => {
      const text = await response.text();
      assertEquals(response.status, status, text);
      return JSON.parse(text) as T;
    };
    const reasonOf = (problem: Record<string, unknown>) =>
      (problem.reason ??
        (problem.params as Record<string, unknown> | undefined)?.reason) as
          | string
          | undefined;
    const count = async (sql: string, values: unknown[]) =>
      Number(
        (await fixture.runtimePgDatabase.query<{ n: string }>(sql, values))
          .rows[0]!.n,
      );

    // A source with a published, active version.
    const source = await json<Workflow>(
      await send("POST", "/v1/workflows", {
        slug: "source-flow",
        name: "Source flow",
        description: "The source.",
      }),
      201,
    );
    const draft = await json<{ id: string }>(
      await send("POST", `/v1/workflows/${source.id}/versions`, { definition }),
      201,
    );
    const published = await json<{ id: string; digest: string }>(
      await send(
        "POST",
        `/v1/workflows/${source.id}/versions/${draft.id}/publish`,
        {},
        { "If-Match": '"1"' },
      ),
      200,
    );
    await json<Workflow>(
      await send(
        "POST",
        `/v1/workflows/${source.id}/activations`,
        { versionId: published.id },
        { "If-Match": '"1"' },
      ),
      200,
    );

    // Copy the active version: a new definition, origin copy, lineage recorded.
    const copyKey = crypto.randomUUID();
    const copyBody = {
      slug: "my-copy",
      name: "My copy",
      description: "An organization's own.",
    };
    const copy = await json<Workflow>(
      await send("POST", `/v1/workflows/${source.id}/copy`, copyBody, {
        "Idempotency-Key": copyKey,
      }),
      201,
    );
    assert(copy.id !== source.id);
    assertEquals(copy.slug, "my-copy");
    assertEquals(copy.origin, {
      kind: "copy",
      catalogKey: null,
      catalogVersion: null,
      sourceWorkflowId: source.id,
      sourceVersionId: published.id,
      sourceDigest: published.digest,
    });
    // Inactive: nothing is active, nothing is published, one draft exists.
    assertEquals(copy.activeVersionId, null);
    assertEquals(
      await count(
        "select count(*) as n from bakery.workflow_versions where workflow_id = $1",
        [copy.id],
      ),
      0,
    );
    assertEquals(
      await count(
        "select count(*) as n from bakery.workflow_drafts where workflow_id = $1",
        [copy.id],
      ),
      1,
    );
    const copiedDraft =
      (await owner`select definition, revision from bakery.workflow_drafts where workflow_id = ${copy.id}`)[
        0
      ]!;
    assertEquals(copiedDraft.definition, definition);
    assertEquals(Number(copiedDraft.revision), 1);

    // The same request replays; it does not make a second copy.
    const replay = await send(
      "POST",
      `/v1/workflows/${source.id}/copy`,
      copyBody,
      {
        "Idempotency-Key": copyKey,
      },
    );
    assertEquals((await json<Workflow>(replay, 201)).id, copy.id);
    assertEquals(
      await count(
        "select count(*) as n from bakery.workflow_definitions where organization_id = $1 and slug = 'my-copy'",
        [organizationId],
      ),
      1,
    );

    // The copy is editable; a second copy under the same slug is refused.
    const edited = await send(
      "PATCH",
      `/v1/workflows/${copy.id}`,
      { name: "Renamed copy" },
      { "If-Match": `"${copy.version}"` },
    );
    assertEquals(edited.status, 200);
    const taken = await send(
      "POST",
      `/v1/workflows/${source.id}/copy`,
      copyBody,
    );
    assertEquals(taken.status, 409);

    // A source that changes later never reaches the copy.
    const second = await json<{ id: string }>(
      await send("POST", `/v1/workflows/${source.id}/versions`, {
        definition: { ...definition, note: "v2" },
      }),
      201,
    );
    await json(
      await send(
        "POST",
        `/v1/workflows/${source.id}/versions/${second.id}/publish`,
        {},
        { "If-Match": '"1"' },
      ),
      200,
    );
    const reread = await json<Workflow>(
      await send("GET", `/v1/workflows/${copy.id}`),
      200,
    );
    assertEquals(reread.origin.sourceVersionId, published.id);
    assertEquals(reread.origin.sourceDigest, published.digest);

    // Refusals: a stale digest, and a source with no version to copy.
    const stale = await send(
      "POST",
      `/v1/workflows/${source.id}/copy`,
      {
        slug: "stale-copy",
        name: "Stale",
        description: "x",
        sourceVersionId: published.id,
        expectedDigest: "0".repeat(64),
      },
    );
    assertEquals(stale.status, 409);
    assertEquals(reasonOf(await stale.json()), "digest_mismatch");
    const empty = await json<Workflow>(
      await send("POST", "/v1/workflows", {
        slug: "empty-flow",
        name: "Empty",
        description: "No version.",
      }),
      201,
    );
    const unavailable = await send("POST", `/v1/workflows/${empty.id}/copy`, {
      slug: "from-empty",
      name: "From empty",
      description: "x",
    });
    assertEquals(unavailable.status, 409);
    assertEquals(
      reasonOf(await unavailable.json()),
      "workflow_copy_source_unavailable",
    );
    assertEquals(
      (await send(
        "POST",
        `/v1/workflows/${crypto.randomUUID()}/copy`,
        copyBody,
      ))
        .status,
      404,
    );

    // A draft is a legitimate source, with its digest as the guard.
    const draftOnly = await json<{ id: string; digest: string }>(
      await send("POST", `/v1/workflows/${empty.id}/versions`, { definition }),
      201,
    );
    const fromDraft = await json<Workflow>(
      await send("POST", `/v1/workflows/${empty.id}/copy`, {
        slug: "from-draft",
        name: "From draft",
        description: "x",
        sourceVersionId: draftOnly.id,
      }),
      201,
    );
    assertEquals(fromDraft.origin.sourceVersionId, draftOnly.id);

    // Copying a catalog definition is how an organization gets an editable one.
    await owner`update bakery.workflow_definitions
      set origin_kind = 'catalog', origin_catalog_key = 'source-flow',
          origin_catalog_version = 1
      where id = ${source.id}`;
    const locked = await send(
      "PATCH",
      `/v1/workflows/${source.id}`,
      { name: "No" },
      { "If-Match": `"${source.version + 1}"` },
    );
    assertEquals(locked.status, 409);
    const fromCatalog = await json<Workflow>(
      await send("POST", `/v1/workflows/${source.id}/copy`, {
        slug: "from-catalog",
        name: "From catalog",
        description: "x",
      }),
      201,
    );
    assertEquals(fromCatalog.origin.kind, "copy");
    const editable = await send(
      "PATCH",
      `/v1/workflows/${fromCatalog.id}`,
      { name: "Mine" },
      { "If-Match": `"${fromCatalog.version}"` },
    );
    assertEquals(editable.status, 200);
  } finally {
    try {
      await fixture.close();
    } finally {
      await resetDatabase();
    }
  }
});
