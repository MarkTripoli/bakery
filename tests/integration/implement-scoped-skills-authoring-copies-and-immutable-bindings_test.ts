/**
 * #42 [B13.04] integration proofs through the real app and database:
 *
 * - another member's personal skill reaches no list, read, search, library
 *   folder, Used by or agent binding (the only path to an agent run's context);
 *   once its owner publishes an organization copy, the others see and can bind
 *   the copy, and still never the original;
 * - Used by lists only workflow and agent versions its reader may open, and its
 *   pages stay whole;
 * - replaying the same idempotency key and revision of a save, a copy and a
 *   publish leaves exactly the audit rows and domain events of one delivery.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { resolveAgentSkillBindings } from "../../apps/server/src/modules/catalog/agent-skill-bindings.ts";
import { listLibraryFolder } from "../../apps/server/src/modules/knowledge/file-search.ts";
import {
  authTestOrigin,
  cleanupAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

type Fx = Awaited<ReturnType<typeof openPersonalSkillFixture>>;
type Skill = {
  id: string;
  name: string;
  scope: "global" | "organization" | "personal";
  activeVersionId: string | null;
  copiedFromSkillId: string | null;
  version: number;
};
type Draft = { id: string; version: number };
type Usage = {
  kind: "workflow" | "agent";
  definitionId: string;
  versionId: string;
  skillVersionIds: string[];
};
type UsagePage = { items: Usage[]; nextCursor: string | null };

const encoder = new TextEncoder();
const b64 = (text: string) =>
  btoa(String.fromCharCode(...encoder.encode(text)));

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A one-file version upload, as the publication route takes it. */
async function upload(text: string, revision = 1) {
  const bytes = encoder.encode(text);
  const manifest = {
    schemaVersion: 1,
    license: "MIT",
    entryPath: "SKILL.md",
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown",
      sizeBytes: bytes.byteLength,
      sha256: await sha256(bytes),
      isExecutable: false,
    }],
  };
  return {
    revision,
    digest: await sha256(encoder.encode(canonicalJson(manifest))),
    entryPath: "SKILL.md",
    manifest,
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown",
      isExecutable: false,
      contentBase64: b64(text),
    }],
  };
}

/** Any method, with an explicit key and If-Match, so a replay is exact. */
function call(
  f: Fx,
  cookie: string,
  method: string,
  path: string,
  options: { body?: unknown; key?: string; version?: number } = {},
) {
  return f.fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers: {
        cookie,
        "Bakery-Organization-Id": f.organizationId,
        "content-type": "application/json",
        origin: authTestOrigin,
        ...(options.key === undefined
          ? {}
          : { "Idempotency-Key": options.key }),
        ...(options.version === undefined
          ? {}
          : { "If-Match": `"${options.version}"` }),
      },
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    }),
  );
}

/** Emails of the members a test adds, removed before its fixture closes. */
const addedEmails: string[] = [];

async function closeFixture(f: Fx): Promise<void> {
  try {
    await cleanupAuthFixture(f.fixture.pgDatabase, addedEmails.splice(0));
  } finally {
    await f.close();
  }
}

/** Adds an active member with one role and returns a signed session cookie. */
async function addMember(f: Fx, role: "viewer" | "developer" | "guest") {
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `scoped-skills-${role}-${crypto.randomUUID()}`;
  const now = new Date();
  await f.fixture.pgDatabase.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, $2, $3, true, $4, $4)`,
    [userId, `A ${role}`, `${token}@example.test`, now],
  );
  addedEmails.push(`${token}@example.test`);
  await f.fixture.pgDatabase.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type
     ) values ($1, $2, $3, 'human')`,
    [principalId, userId, `A ${role}`],
  );
  await f.fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status, joined_at,
       created_at, updated_at, version
     ) values ($1, $2, $3, $4, 'active', $5, $5, $5, 1)`,
    [crypto.randomUUID(), f.organizationId, principalId, role, now],
  );
  await f.fixture.pgDatabase.query(
    `insert into public.session (
       id, token, "userId", "expiresAt", "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $5, $5)`,
    [
      crypto.randomUUID(),
      token,
      userId,
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  return {
    principalId,
    cookie: await signSessionCookie(token, f.fixture.config.auth!.secret),
  };
}

async function publishedWorkflow(
  f: Fx,
  slug: string,
  skills: string[],
): Promise<{ workflowId: string; versionId: string }> {
  const workflow = await f.post(
    f.ownerCookie,
    "/v1/workflows",
    { slug, name: slug, description: slug },
    `wf-${slug}`,
  );
  assertEquals(workflow.status, 201, await workflow.clone().text());
  const workflowId = (await workflow.json() as { id: string }).id;
  const path = `/v1/workflows/${workflowId}/versions`;
  const draft = await f.post(f.ownerCookie, path, {
    definition: {
      kind: "fixed",
      steps: [{
        id: "first",
        uses: "workflow.noop",
        action: "agent.run",
        skills,
      }],
    },
  }, `draft-${slug}`);
  assertEquals(draft.status, 201, await draft.clone().text());
  const created = await draft.json() as { id: string; version: number };
  const publish = await call(
    f,
    f.ownerCookie,
    "POST",
    `${path}/${created.id}/publish`,
    { body: {}, key: `pub-${slug}`, version: created.version },
  );
  assertEquals(publish.status, 200, await publish.clone().text());
  return { workflowId, versionId: (await publish.json() as { id: string }).id };
}

async function count(
  f: Fx,
  sql: string,
  values: unknown[],
): Promise<number> {
  const result = await f.fixture.pgDatabase.query<{ count: number }>(
    `select count(*)::int as count ${sql}`,
    values,
  );
  return result.rows[0].count;
}

Deno.test("another member's personal skill reaches no list, read, search, library folder, Used by or agent; its published organization copy does", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-42-scoped-ac1-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const owner = f.ownerCookie;
    const developer = await addMember(f, "developer");
    const others = [
      {
        name: "an Admin",
        cookie: f.adminCookie,
        principalId: f.adminPrincipalId,
      },
      { name: "a Developer", ...developer },
    ];
    const created = await f.post(owner, "/v1/skills", {
      slug: "secret-recipe",
      name: "Secret recipe",
      scope: "personal",
    }, "ac1-create");
    assertEquals(created.status, 201, await created.clone().text());
    const original = await created.json() as Skill;
    const published = await f.post(
      owner,
      `/v1/skills/${original.id}/versions`,
      await upload("# Secret recipe\n\nFold twice.\n"),
      "ac1-publish",
    );
    assertEquals(published.status, 201, await published.clone().text());
    const originalVersion = (await published.json() as { id: string }).id;

    const searchIds = async (cookie: string) => {
      const response = await f.read(
        cookie,
        "/v1/library/search?query=secret%20recipe",
      );
      assertEquals(response.status, 200, await response.clone().text());
      return (await response.json() as { items: { id: string }[] }).items
        .map((hit) => hit.id);
    };
    const listIds = async (cookie: string) => {
      const response = await f.read(cookie, "/v1/skills?limit=100");
      assertEquals(response.status, 200, await response.clone().text());
      return (await response.json() as { items: Skill[] }).items
        .map((skill) => skill.id);
    };
    const libraryIds = async (principalId: string) =>
      (await withPgTransaction(
        f.fixture.pgDatabase,
        (transaction) =>
          listLibraryFolder(transaction, {
            organizationId: f.organizationId,
            principalId,
            section: "skills",
          }),
      ))?.map((child) => child.id) ?? [];
    const bind = (versionId: string) =>
      withPgTransaction(
        f.fixture.pgDatabase,
        (transaction) =>
          resolveAgentSkillBindings(transaction, f.organizationId, {
            main: versionId,
          }),
      );

    // The owner finds it everywhere.
    assert((await listIds(owner)).includes(original.id));
    assert((await searchIds(owner)).includes(original.id));
    assert((await libraryIds(f.ownerPrincipalId)).includes(original.id));

    // Nobody else does, by any path, and an agent cannot carry it, so it never
    // reaches a run's pinned skills or its prompt.
    for (const other of others) {
      assert(!(await listIds(other.cookie)).includes(original.id), other.name);
      assert(
        !(await searchIds(other.cookie)).includes(original.id),
        other.name,
      );
      assert(
        !(await libraryIds(other.principalId)).includes(original.id),
        other.name,
      );
      for (
        const path of [
          `/v1/skills/${original.id}`,
          `/v1/skills/${original.id}/used-by`,
        ]
      ) {
        assertEquals((await f.read(other.cookie, path)).status, 404, path);
      }
    }
    const refused = await assertRejects(() => bind(originalVersion)) as {
      code?: string;
    };
    assertEquals(refused.code, "UNPROCESSABLE");

    // The owner shares an organization copy; it is published as it is made.
    const copied = await f.post(owner, `/v1/skills/${original.id}/copy`, {
      name: "Secret recipe (shared)",
      scope: "organization",
    }, "ac1-copy");
    assertEquals(copied.status, 201, await copied.clone().text());
    const copy = await copied.json() as Skill;
    assertEquals(copy.scope, "organization");
    assertEquals(copy.copiedFromSkillId, original.id);
    assert(copy.activeVersionId !== null);
    const copyStatus = await f.fixture.pgDatabase.query<{ status: string }>(
      "select status from bakery.skill_versions where id = $1",
      [copy.activeVersionId],
    );
    assertEquals(copyStatus.rows[0].status, "published");

    // Everyone now sees the copy, and an agent can carry it; the original stays
    // its owner's alone.
    for (const other of others) {
      assert((await listIds(other.cookie)).includes(copy.id), other.name);
      assert(!(await listIds(other.cookie)).includes(original.id), other.name);
      const hits = await searchIds(other.cookie);
      assert(hits.includes(copy.id), other.name);
      assert(!hits.includes(original.id), other.name);
      const library = await libraryIds(other.principalId);
      assert(library.includes(copy.id), other.name);
      assert(!library.includes(original.id), other.name);
      assertEquals(
        (await f.read(other.cookie, `/v1/skills/${copy.id}`)).status,
        200,
      );
      assertEquals(
        (await f.read(other.cookie, `/v1/skills/${original.id}`)).status,
        404,
      );
    }
    const pins = await bind(copy.activeVersionId);
    assertEquals(pins.map((pin) => pin.versionId), [copy.activeVersionId]);
    await assertRejects(() => bind(originalVersion));
  } finally {
    await closeFixture(f);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Used by lists only what its reader may open, on whole pages", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const created = await f.post(f.ownerCookie, "/v1/skills", {
      slug: "used-widely",
      name: "Used widely",
    }, "usage-skill");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as Skill;
    const version = await f.insertSkillVersion(skill.id);
    const workflows = [
      await publishedWorkflow(f, "first-user", [version]),
      await publishedWorkflow(f, "second-user", [version]),
      await publishedWorkflow(f, "third-user", [version]),
    ];
    const agent = await f.post(f.ownerCookie, "/v1/agents", {
      slug: "usage-agent",
      name: "Usage agent",
      description: "Binds the skill.",
    }, "usage-agent");
    assertEquals(agent.status, 201, await agent.clone().text());
    const agentId = (await agent.json() as { id: string }).id;
    const agentVersionId = crypto.randomUUID();
    await f.fixture.pgDatabase.query(
      `insert into bakery.agent_versions (
         id, organization_id, agent_id, revision, config, digest, created_by
       ) values ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
      [
        agentVersionId,
        f.organizationId,
        agentId,
        JSON.stringify({ harness: "pi", skillBindings: { main: version } }),
        "f".repeat(64),
        f.ownerPrincipalId,
      ],
    );
    const expected = new Set([
      ...workflows.map((item) => item.versionId),
      agentVersionId,
    ]);

    const viewer = await addMember(f, "viewer");
    const developer = await addMember(f, "developer");
    for (const reader of [viewer, developer, { cookie: f.adminCookie }]) {
      // A page of one at a time: every row exactly once, none skipped.
      const seen: Usage[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor === null
          ? "?limit=1"
          : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
        const response = await f.read(
          reader.cookie,
          `/v1/skills/${skill.id}/used-by${query}`,
        );
        assertEquals(response.status, 200, await response.clone().text());
        const page = await response.json() as UsagePage;
        assertEquals(page.items.length, 1);
        seen.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);
      assertEquals(seen.length, expected.size);
      assertEquals(new Set(seen.map((row) => row.versionId)), expected);
      // Each row opens for the same reader through the workflow and agent reads.
      for (const row of seen) {
        const path = row.kind === "workflow"
          ? `/v1/workflows/${row.definitionId}/versions/${row.versionId}`
          : `/v1/agents/${row.definitionId}`;
        assertEquals((await f.read(reader.cookie, path)).status, 200, path);
        assertEquals(row.skillVersionIds, [version]);
      }
    }

    // A member who may open no workflow reads no Used by either: the refusal is
    // the one the workflow read gives.
    const guest = await addMember(f, "guest");
    const refusedWorkflow = await f.read(
      guest.cookie,
      `/v1/workflows/${workflows[0].workflowId}`,
    );
    assert(refusedWorkflow.status >= 400);
    assertEquals(
      (await f.read(guest.cookie, `/v1/skills/${skill.id}/used-by`)).status,
      refusedWorkflow.status,
    );
  } finally {
    await closeFixture(f);
  }
});

Deno.test("replaying a save, a copy and a publish leaves one delivery's audit rows and domain events", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-42-scoped-ac4-" });
  const f = await openPersonalSkillFixture({ skillFileRoot: root });
  try {
    const owner = f.ownerCookie;
    const created = await f.post(owner, "/v1/skills", {
      slug: "replayed",
      name: "Replayed",
    }, "ac4-create");
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as Skill;
    const first = await f.post(
      owner,
      `/v1/skills/${skill.id}/versions`,
      await upload("# Replayed\n\nFirst.\n"),
      "ac4-v1",
    );
    assertEquals(first.status, 201, await first.clone().text());
    const audits = (operation: string, resourceId: string) =>
      count(
        f,
        `from bakery.audit_events
          where organization_id = $1 and operation = $2
            and resource_id::text = $3`,
        [f.organizationId, operation, resourceId],
      );
    const events = (resourceId: string, eventType?: string) =>
      count(
        f,
        `from bakery.domain_events
          where organization_id = $1 and aggregate_id::text = $2
            and ($3::text is null or event_type = $3)`,
        [f.organizationId, resourceId, eventType ?? null],
      );
    const twice = async (
      method: string,
      path: string,
      options: { body?: unknown; key: string; version?: number },
      status: number,
    ) => {
      const once = await call(f, owner, method, path, options);
      assertEquals(once.status, status, await once.clone().text());
      const again = await call(f, owner, method, path, options);
      assertEquals(again.status, status, await again.clone().text());
      assertEquals(again.headers.get("Idempotent-Replayed"), "true");
      const body = await once.json() as { id: string; version: number };
      assertEquals((await again.json() as { id: string }).id, body.id);
      return body;
    };

    // A skill save (rename) at revision 2 of the skill.
    const current = await (await f.read(owner, `/v1/skills/${skill.id}`))
      .json() as Skill;
    const beforeUpdateEvents = await events(skill.id, "skills.updated");
    await twice("PATCH", `/v1/skills/${skill.id}`, {
      body: { name: "Replayed twice" },
      key: "ac4-update",
      version: current.version,
    }, 200);
    assertEquals(await audits("skills.update", skill.id), 1);
    assertEquals(
      await events(skill.id, "skills.updated"),
      beforeUpdateEvents + 1,
    );

    // A draft file save. A draft is not a domain aggregate, so the save writes
    // its audit row and no event.
    const draftPath = `/v1/skills/${skill.id}/draft`;
    const opened = await call(f, owner, "POST", draftPath, {
      key: "ac4-open",
    });
    assertEquals(opened.status, 200, await opened.clone().text());
    const draft = await opened.json() as Draft;
    const saved = await twice("POST", `${draftPath}/files`, {
      body: {
        path: "SKILL.md",
        mediaType: "text/markdown",
        contentBase64: b64("# Replayed\n\nSecond.\n"),
      },
      key: "ac4-save",
      version: draft.version,
    }, 200);
    assertEquals(saved.id, draft.id);
    assertEquals(await audits("skillDraftFiles.save", draft.id), 1);
    assertEquals(await events(draft.id), 0);

    // The draft's publish: one version, its audit rows and one event.
    const version = await twice("POST", `${draftPath}/publish`, {
      key: "ac4-publish",
      version: saved.version,
    }, 201);
    assertEquals(await audits("skillDrafts.publish", draft.id), 1);
    assertEquals(await audits("skillVersions.create", version.id), 1);
    assertEquals(await events(version.id, "skill.version_created"), 1);
    assertEquals(await events(version.id), 1);
    assertEquals(
      await count(
        f,
        "from bakery.skill_versions where organization_id = $1 and skill_id = $2",
        [f.organizationId, skill.id],
      ),
      2,
    );

    // A copy: one new skill, one audit row, one event.
    const copy = await twice("POST", `/v1/skills/${skill.id}/copy`, {
      body: { name: "Replayed copy", scope: "organization" },
      key: "ac4-copy",
    }, 201);
    assertEquals(await audits("skills.copy", copy.id), 1);
    assertEquals(await events(copy.id, "skills.copied"), 1);
    assertEquals(
      await count(
        f,
        `from bakery.skills
          where organization_id = $1 and copied_from_skill_id = $2`,
        [f.organizationId, skill.id],
      ),
      1,
    );
  } finally {
    await closeFixture(f);
    await Deno.remove(root, { recursive: true });
  }
});
