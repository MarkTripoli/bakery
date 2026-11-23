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

// #418 (one engine O10): a workflow calls a published version of another. The
// compiler inlines it at validation, publication and run admission; a version
// of another organization, and one that is only a draft, are not on offer.
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

const base = { apiVersion: "bakery.dev/v1", kind: "workflow" };
const child = {
  ...base,
  inputs: { topic: { type: "string", required: true } },
  outputs: { summary: "$step.write.status" },
  steps: [{
    id: "write",
    uses: "agent.freeform",
    with: {
      prompt: "$input.topic",
      maxTurns: 1,
      timeout: "60s",
      maxCostUsd: 1,
      allowedTools: [],
    },
  }],
};
const parentOf = (version: string) => ({
  ...base,
  inputs: { subject: { type: "string", required: true } },
  steps: [
    {
      id: "research",
      call: { workflow: version, with: { topic: "$input.subject" } },
    },
    {
      id: "after",
      needs: ["research"],
      uses: "workflow.stop",
      with: { outcome: "completed", reason: "$step.research.summary" },
    },
  ],
});

async function draftOf(org: Org, slug: string, definition: unknown) {
  const { send, json } = org;
  const workflow = await json<{ id: string }>(
    await send("POST", "/v1/workflows", {
      slug,
      name: slug,
      description: "A workflow.",
    }),
    201,
  );
  const draft = await json<{ id: string }>(
    await send("POST", `/v1/workflows/${workflow.id}/versions`, { definition }),
    201,
  );
  return { workflowId: workflow.id, draftId: draft.id };
}

const publish = async (org: Org, workflowId: string, draftId: string) =>
  await org.json<{ id: string }>(
    await org.send(
      "POST",
      `/v1/workflows/${workflowId}/versions/${draftId}/publish`,
      {},
      { "If-Match": '"1"' },
    ),
    200,
  );

const validate = async (org: Org, definition: unknown) =>
  await org.json<{
    valid: boolean;
    compilerDiagnostics: { code: string }[];
  }>(
    await org.send("POST", "/v1/workflow-validations", { definition }),
    200,
  );

Deno.test("a workflow calls a published version of its own organization, and no other", async () => {
  await resetDatabase();
  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  try {
    const mine = await seedOrganization(fixture, "mine");
    const theirs = await seedOrganization(fixture, "theirs");

    const made = await draftOf(mine, "researcher", child);
    // A draft is not a version anyone can call.
    const draftOnly = await validate(mine, parentOf(made.draftId));
    assertEquals(draftOnly.valid, false);
    assert(
      draftOnly.compilerDiagnostics.some((d) =>
        d.code === "call_version_unavailable"
      ),
    );

    const published = await publish(mine, made.workflowId, made.draftId);

    // Its own organization may call it, and the caller reads its output.
    const report = await validate(mine, parentOf(published.id));
    assertEquals(report.compilerDiagnostics, []);
    assertEquals(report.valid, true);

    // Another organization may not, and is told no more than "not available".
    const foreign = await validate(theirs, parentOf(published.id));
    assertEquals(foreign.valid, false);
    assertEquals(
      foreign.compilerDiagnostics.map((d) => d.code),
      ["call_version_unavailable"],
    );
    const missing = await validate(
      theirs,
      parentOf(crypto.randomUUID()),
    );
    assertEquals(
      missing.compilerDiagnostics.map((d) => d.code),
      ["call_version_unavailable"],
    );

    // Publishing the caller works for its own organization and is refused for
    // the other, and the stored caller still names the version it calls.
    const parentMade = await draftOf(mine, "caller", parentOf(published.id));
    const parentPublished = await publish(
      mine,
      parentMade.workflowId,
      parentMade.draftId,
    );
    const stored =
      (await owner`select normalized_spec, semantic_digest from bakery.workflow_versions where id = ${parentPublished.id}`)[
        0
      ]!;
    assert(JSON.stringify(stored.normalized_spec).includes(published.id));
    assert(stored.semantic_digest);

    const foreignMade = await draftOf(theirs, "caller", parentOf(published.id));
    const refused = await theirs.send(
      "POST",
      `/v1/workflows/${foreignMade.workflowId}/versions/${foreignMade.draftId}/publish`,
      {},
      { "If-Match": '"1"' },
    );
    assertEquals(refused.status, 422, await refused.text());
  } finally {
    await fixture.close();
  }
});

Deno.test("calls nest two levels through the loader and a third level is refused (#418)", async () => {
  await resetDatabase();
  const fixture = await openAuthFixture({ databaseConfig });
  try {
    const org = await seedOrganization(fixture, "nest");
    const leaf = {
      ...base,
      steps: [{ id: "leafstep", uses: "workflow.noop", with: {} }],
    };
    const g = await draftOf(org, "grand", leaf);
    const gp = await publish(org, g.workflowId, g.draftId);
    const m = await draftOf(org, "middle", {
      ...base,
      steps: [{ id: "middlestep", call: { workflow: gp.id } }],
    });
    const mp = await publish(org, m.workflowId, m.draftId);
    // parent -> middle -> grandchild: two levels, valid
    const two = await validate(org, {
      ...base,
      steps: [{ id: "parentstep", call: { workflow: mp.id } }],
    });
    assertEquals(two.compilerDiagnostics, []);
    assertEquals(two.valid, true);
    // publish the parent, then a fourth: top -> parent -> middle -> grandchild is three levels
    const p = await draftOf(org, "parent", {
      ...base,
      steps: [{ id: "parentstep", call: { workflow: mp.id } }],
    });
    const pp = await publish(org, p.workflowId, p.draftId);
    const three = await validate(org, {
      ...base,
      steps: [{ id: "topstep", call: { workflow: pp.id } }],
    });
    assertEquals(three.valid, false);
    assert(
      three.compilerDiagnostics.some((d) => d.code === "call_depth_exceeded"),
      JSON.stringify(three.compilerDiagnostics),
    );
  } finally {
    await fixture.close();
  }
});
