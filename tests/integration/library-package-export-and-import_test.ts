import { assertEquals } from "@std/assert";
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

// #426: a T0 package carries validated data between organizations. Export
// writes workflows and kinds; import checks every digest and slug first and
// then creates drafts and kind versions whole or not at all, with lineage.
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
const kindDefinition = {
  key: "brief",
  name: "Brief",
  description: "A short statement of what to build.",
  text: true,
  facts: [],
  rules: [{ type: "nonEmpty", severity: "require", options: {} }],
};

type Fixture = Awaited<ReturnType<typeof openAuthFixture>>;

async function seedOrganization(fixture: Fixture, label: string) {
  const owner = fixture.database;
  const now = new Date();
  const organizationId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `admin-${crypto.randomUUID()}`;
  await owner`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
    values (${organizationId}, ${label}, ${`${label}-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
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
  return { organizationId, send, json };
}

type Org = Awaited<ReturnType<typeof seedOrganization>>;
type Pkg = {
  name: string;
  packageDigest: string;
  items: { kind: string; key: string; digest: string; data: unknown }[];
};

async function publishWorkflow(org: Org, slug: string): Promise<string> {
  const { send, json } = org;
  const source = await json<{ id: string }>(
    await send("POST", "/v1/workflows", {
      slug,
      name: "Source flow",
      description: "The source.",
    }),
    201,
  );
  const draft = await json<{ id: string }>(
    await send("POST", `/v1/workflows/${source.id}/versions`, { definition }),
    201,
  );
  const published = await json<{ id: string }>(
    await send(
      "POST",
      `/v1/workflows/${source.id}/versions/${draft.id}/publish`,
      {},
      { "If-Match": '"1"' },
    ),
    200,
  );
  await json(
    await send(
      "POST",
      `/v1/workflows/${source.id}/activations`,
      { versionId: published.id },
      { "If-Match": '"1"' },
    ),
    200,
  );
  return source.id;
}

Deno.test("a package leaves one organization and arrives whole in another, with lineage", async () => {
  await resetDatabase();
  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  try {
    const from = await seedOrganization(fixture, "from");
    const to = await seedOrganization(fixture, "to");
    const workflowId = await publishWorkflow(from, "triage");
    await from.json(
      await from.send(
        "POST",
        `/v1/organizations/${from.organizationId}/artifact-kinds/brief/versions`,
        { expectedRevision: 0, definition: kindDefinition },
      ),
      201,
    );

    const pkg = await from.json<Pkg>(
      await from.send("POST", "/v1/library-packages/export", {
        name: "Starter",
        workflowIds: [workflowId],
        artifactKindKeys: ["brief"],
      }),
      200,
    );
    assertEquals(pkg.items.map((item) => `${item.kind}:${item.key}`), [
      "workflow:triage",
      "artifactKind:brief",
    ]);

    // A tampered item is refused and nothing is written.
    const tampered = structuredClone(pkg);
    (tampered.items[0]!.data as { name: string }).name = "Changed";
    const refused = await to.send("POST", "/v1/library-packages/import", {
      package: tampered,
    });
    assertEquals(refused.status, 422, await refused.text());
    assertEquals(
      (await owner`select count(*)::int as n from bakery.workflow_definitions where organization_id = ${to.organizationId}`)[
        0
      ]!.n,
      0,
    );

    // The real package arrives as a draft and a kind version, never active.
    const result = await to.json<{
      packageDigest: string;
      imported: { kind: string; key: string; resultingId: string }[];
    }>(
      await to.send("POST", "/v1/library-packages/import", { package: pkg }),
      201,
    );
    assertEquals(result.packageDigest, pkg.packageDigest);
    assertEquals(result.imported.length, 2);
    const workflow =
      (await owner`select id, slug, active_version_id, origin_kind from bakery.workflow_definitions where organization_id = ${to.organizationId}`)[
        0
      ]!;
    assertEquals(workflow.slug, "triage");
    assertEquals(workflow.active_version_id, null);
    assertEquals(workflow.origin_kind, "package");
    const draft =
      (await owner`select definition from bakery.workflow_drafts where workflow_id = ${workflow.id}`)[
        0
      ]!;
    assertEquals(draft.definition, definition);
    assertEquals(
      (await owner`select count(*)::int as n from bakery.artifact_kind_versions where organization_id = ${to.organizationId}`)[
        0
      ]!.n,
      1,
    );
    const lineage =
      await owner`select item_kind, item_key, item_digest, resulting_id from bakery.package_imports where organization_id = ${to.organizationId} and package_digest = ${pkg.packageDigest} order by item_key`;
    assertEquals(lineage.length, 2);
    assertEquals(
      lineage.map((row) => row.item_digest).sort(),
      pkg.items.map((item) => item.digest).sort(),
    );

    // Importing again is refused: the slug is taken, and nothing more is written.
    const again = await to.send("POST", "/v1/library-packages/import", {
      package: pkg,
    });
    assertEquals(again.status, 422, await again.text());
    assertEquals(
      (await owner`select count(*)::int as n from bakery.package_imports where organization_id = ${to.organizationId}`)[
        0
      ]!.n,
      2,
    );
  } finally {
    await fixture.close();
  }
});
