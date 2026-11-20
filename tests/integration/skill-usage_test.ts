import { assert, assertEquals } from "@std/assert";
import { authTestOrigin } from "../helpers/auth.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";

type Fx = Awaited<ReturnType<typeof openPersonalSkillFixture>>;
type Usage = {
  kind: "workflow" | "agent";
  definitionId: string;
  definitionName: string;
  versionId: string;
  revision: number;
  skillVersionIds: string[];
  createdAt: string;
};
type Page = { items: Usage[]; nextCursor: string | null };

const step = (skills: string[], action = "agent.run") => ({
  kind: "fixed",
  steps: [{
    id: "first",
    uses: "workflow.noop",
    ...(action ? { action } : {}),
    skills,
  }],
});

async function publishedWorkflow(
  f: Fx,
  slug: string,
  definition: unknown,
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
  const draft = await f.post(
    f.ownerCookie,
    path,
    { definition },
    `draft-${slug}`,
  );
  assertEquals(draft.status, 201, await draft.clone().text());
  const created = await draft.json() as { id: string; version: number };
  const publish = await f.fixture.app.fetch(
    new Request(`${authTestOrigin}${path}/${created.id}/publish`, {
      method: "POST",
      headers: {
        cookie: f.ownerCookie,
        "Bakery-Organization-Id": f.organizationId,
        "content-type": "application/json",
        "Idempotency-Key": `pub-${slug}`,
        "If-Match": `"${created.version}"`,
        origin: authTestOrigin,
      },
      body: "{}",
    }),
  );
  assertEquals(publish.status, 200, await publish.clone().text());
  return { workflowId, versionId: (await publish.json() as { id: string }).id };
}

Deno.test("a skill's Used by lists the published workflow versions and agent versions that pin it, and only to someone who can see the skill", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const created = await f.post(
      f.ownerCookie,
      "/v1/skills",
      { slug: "research", name: "Research" },
      "skill-research",
    );
    assertEquals(created.status, 201, await created.clone().text());
    const skill = await created.json() as { id: string };
    const v1 = await f.insertSkillVersion(skill.id);
    const v2 = `00000000-0000-8000-8000-${crypto.randomUUID().slice(-12)}`;
    await f.fixture.pgDatabase.query(
      `insert into bakery.skill_versions (
         id, organization_id, skill_id, revision, source_revision, digest,
         entry_path, manifest, status, created_by
       ) values ($1, $2, $3, 2, 'rev-2', $4, 'SKILL.md', '{}'::jsonb,
                 'published', $5)`,
      [
        v2,
        f.organizationId,
        skill.id,
        `sha256:${"d".repeat(64)}`,
        f.ownerPrincipalId,
      ],
    );

    // Nothing pins it yet.
    const none = await f.read(f.adminCookie, `/v1/skills/${skill.id}/used-by`);
    assertEquals(none.status, 200, await none.clone().text());
    assertEquals(await none.json(), { items: [], nextCursor: null });

    // A published workflow version that names v1 in a step.
    const used = await publishedWorkflow(f, "uses-v1", step([v1]));
    // A draft that names v2 is not a published version, so it is not listed.
    const draftOnly = await f.post(f.ownerCookie, "/v1/workflows", {
      slug: "draft-only",
      name: "draft-only",
      description: "draft-only",
    }, "wf-draft-only");
    const draftOnlyId = (await draftOnly.json() as { id: string }).id;
    const draftOnlyVersion = await f.post(
      f.ownerCookie,
      `/v1/workflows/${draftOnlyId}/versions`,
      { definition: step([v2]) },
      "draft-draft-only",
    );
    assertEquals(draftOnlyVersion.status, 201);
    // A published version that carries v2 in a skills list on a step with no
    // action: the id is in its text but no step uses the skill.
    await publishedWorkflow(f, "mentions-v2", step([v2], ""));
    // An agent version that binds v2.
    const agent = await f.post(f.ownerCookie, "/v1/agents", {
      slug: "binder",
      name: "Binder",
      description: "Binds a skill.",
    }, "agent-binder");
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
        JSON.stringify({ harness: "pi", skillBindings: { main: v2 } }),
        "e".repeat(64),
        f.ownerPrincipalId,
      ],
    );

    const read = async (cookie: string, query = "") => {
      const response = await f.read(
        cookie,
        `/v1/skills/${skill.id}/used-by${query}`,
      );
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json() as Page;
    };
    const all = await read(f.adminCookie);
    assertEquals(all.nextCursor, null);
    // Newest first: the agent version was added last.
    assertEquals(all.items.map((item) => [item.kind, item.definitionName]), [
      ["agent", "Binder"],
      ["workflow", "uses-v1"],
    ]);
    assertEquals(all.items[0].versionId, agentVersionId);
    assertEquals(all.items[0].skillVersionIds, [v2]);
    assertEquals(all.items[1].versionId, used.versionId);
    assertEquals(all.items[1].definitionId, used.workflowId);
    assertEquals(all.items[1].skillVersionIds, [v1]);

    // A page of one, then the rest, in the same order.
    const first = await read(f.adminCookie, "?limit=1");
    assertEquals(first.items.length, 1);
    assert(first.nextCursor !== null);
    const second = await read(
      f.adminCookie,
      `?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    assertEquals(second.items.map((i) => i.definitionName), ["uses-v1"]);
    assertEquals(second.nextCursor, null);

    // Someone else's Private skill is not found, however it is used; the owner
    // reads it. A skill that does not exist is not found either.
    const personal = await f.post(
      f.ownerCookie,
      "/v1/skills",
      { slug: "mine", name: "Mine", scope: "personal" },
      "skill-mine",
    );
    const mine = await personal.json() as { id: string };
    assertEquals(
      (await f.read(f.adminCookie, `/v1/skills/${mine.id}/used-by`)).status,
      404,
    );
    assertEquals(
      (await f.read(f.ownerCookie, `/v1/skills/${mine.id}/used-by`)).status,
      200,
    );
    assertEquals(
      (await f.read(f.ownerCookie, `/v1/skills/${crypto.randomUUID()}/used-by`))
        .status,
      404,
    );
  } finally {
    await f.close();
  }
});

Deno.test("a Used by cursor belongs to its skill, and a row lists each pinned version once, oldest revision first", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const make = async (slug: string) => {
      const created = await f.post(
        f.ownerCookie,
        "/v1/skills",
        { slug, name: slug },
        `skill-${slug}`,
      );
      assertEquals(created.status, 201, await created.clone().text());
      return (await created.json() as { id: string }).id;
    };
    const alpha = await make("alpha");
    const beta = await make("beta");
    const a1 = await f.insertSkillVersion(alpha);
    const a2 = `00000000-0000-8000-8000-${crypto.randomUUID().slice(-12)}`;
    await f.fixture.pgDatabase.query(
      `insert into bakery.skill_versions (
         id, organization_id, skill_id, revision, source_revision, digest,
         entry_path, manifest, status, created_by
       ) values ($1, $2, $3, 2, 'rev-2', $4, 'SKILL.md', '{}'::jsonb, 'published', $5)`,
      [
        a2,
        f.organizationId,
        alpha,
        `sha256:${"d".repeat(64)}`,
        f.ownerPrincipalId,
      ],
    );
    const b1 = await f.insertSkillVersion(beta);
    // One workflow version names both revisions of alpha, the newer first, and
    // the older again in a second step: still one row listing [a1, a2] once each.
    const both = await publishedWorkflow(f, "pins-both", {
      kind: "fixed",
      steps: [
        {
          id: "first",
          uses: "workflow.noop",
          action: "agent.run",
          skills: [a2, a1],
        },
        {
          id: "second",
          uses: "workflow.noop",
          action: "agent.run",
          skills: [a1],
        },
      ],
    });
    // A second workflow pins alpha too, so alpha has two rows and a cursor.
    const other = await publishedWorkflow(f, "pins-a1", step([a1]));
    // Beta has its own row, so replaying alpha's cursor on it is a real attempt.
    await publishedWorkflow(f, "pins-b1", step([b1]));
    const read = (id: string, query = "") =>
      f.read(f.adminCookie, `/v1/skills/${id}/used-by${query}`);
    const all = await (await read(alpha)).json() as Page;
    const bothRows = all.items.filter((item) =>
      item.versionId === both.versionId
    );
    assertEquals(bothRows.length, 1);
    assertEquals(
      bothRows[0].skillVersionIds,
      [a1, a2],
      "each version once, oldest revision first",
    );
    assert(all.items.some((item) => item.versionId === other.versionId));
    // A cursor taken from alpha pages alpha, and is refused on beta.
    const first = await (await read(alpha, "?limit=1")).json() as Page;
    assert(first.nextCursor !== null, "alpha has a second page");
    const cursor = encodeURIComponent(first.nextCursor);
    const onAlpha = await read(alpha, `?limit=1&cursor=${cursor}`);
    assertEquals(onAlpha.status, 200, await onAlpha.clone().text());
    await onAlpha.body?.cancel();
    const onBeta = await read(beta, `?limit=1&cursor=${cursor}`);
    assertEquals(onBeta.status, 400, await onBeta.clone().text());
    await onBeta.body?.cancel();
  } finally {
    await f.close();
  }
});
