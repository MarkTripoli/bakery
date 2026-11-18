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

// #35 AC2: a draft's source YAML is stored beside its definition at publish, so
// publish is where an unsafe or foreign source is stopped. A draft still saves
// (like a draft with semantic errors) and the findings are fixed codes and
// pointers that never echo the submitted text.
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
const SECRET = "do-not-echo-this-value";

Deno.test("publication refuses an unsafe or foreign source YAML and accepts a safe one", async () => {
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
      values (${organizationId}, 'Yaml org', ${`yaml-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
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
    let n = 0;
    // A new workflow with one draft whose source YAML is as given.
    const draftWith = async (sourceYaml: string | undefined) => {
      n += 1;
      const workflow = await (await send("POST", "/v1/workflows", {
        slug: `yaml-flow-${n}`,
        name: `Yaml flow ${n}`,
        description: "x",
      })).json() as { id: string };
      const created = await send(
        "POST",
        `/v1/workflows/${workflow.id}/versions`,
        sourceYaml === undefined ? { definition } : { definition, sourceYaml },
      );
      assertEquals(created.status, 201, await created.clone().text());
      return {
        workflow: workflow.id,
        draft: (await created.json() as { id: string }).id,
      };
    };
    const publish = (workflow: string, draft: string) =>
      send(
        "POST",
        `/v1/workflows/${workflow}/versions/${draft}/publish`,
        {},
        { "If-Match": '"1"' },
      );
    const publishedCount = async (workflow: string) =>
      Number(
        (await fixture.runtimePgDatabase.query<{ n: string }>(
          "select count(*) as n from bakery.workflow_versions where workflow_id = $1",
          [workflow],
        )).rows[0]!.n,
      );

    // Unsafe or foreign sources save, then publish answers 422 with fixed codes.
    const refusals: [string, string][] = [
      [`kind: !!str fixed\nsteps: []\nnote: ${SECRET}`, "yaml_tag_forbidden"],
      [`base: &a\n  v: ${SECRET}\nuse: *a`, "yaml_alias_forbidden"],
      [`kind: fixed\nkind: ${SECRET}`, "definition_duplicate_key"],
      [`<<: {a: ${SECRET}}\nkind: fixed`, "yaml_merge_key_forbidden"],
      [
        "kind: fixed\nsteps:\n  - id: other\n    uses: workflow.noop\n",
        "source_yaml_mismatch",
      ],
    ];
    for (const [sourceYaml, code] of refusals) {
      const { workflow, draft } = await draftWith(sourceYaml);
      const response = await publish(workflow, draft);
      const text = await response.text();
      assertEquals(response.status, 422, text);
      assert(text.includes(code), `${code}: ${text}`);
      assert(!text.includes(SECRET), "the refusal echoed submitted text");
      assertEquals(await publishedCount(workflow), 0);
    }

    // A safe YAML that is the definition's own publishes, as does a draft with
    // no YAML at all (the server stores canonical JSON by default).
    const safe = await draftWith(
      "# imported\nkind: fixed\nsteps:\n  - id: first\n    uses: workflow.noop\n",
    );
    assertEquals((await publish(safe.workflow, safe.draft)).status, 200);
    const plain = await draftWith(undefined);
    assertEquals((await publish(plain.workflow, plain.draft)).status, 200);
  } finally {
    try {
      await fixture.close();
    } finally {
      await resetDatabase();
    }
  }
});
