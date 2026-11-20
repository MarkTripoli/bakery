import { assert, assertEquals } from "@std/assert";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { stepSkillIssues } from "../../apps/server/src/modules/workflows/version-skills.ts";
import { openPersonalSkillFixture } from "../helpers/private-skill-fixture.ts";
import { authTestOrigin } from "../helpers/auth.ts";

type Fx = Awaited<ReturnType<typeof openPersonalSkillFixture>>;
type Item = {
  status: string;
  mine: boolean;
  publishedVersionUsesIt: boolean;
  skillName: string | null;
  stepPath: string;
};
const DEF = (sv: string) => ({
  kind: "fixed",
  steps: [{
    id: "first",
    uses: "workflow.noop",
    action: "agent.run",
    skills: [sv],
  }],
});
const PLAIN = {
  kind: "fixed",
  steps: [{ id: "first", uses: "workflow.noop" }],
};

function send(
  f: Fx,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  org?: string,
) {
  return f.fixture.app.fetch(
    new Request(authTestOrigin + path, {
      method,
      headers: {
        cookie,
        "Bakery-Organization-Id": org ?? f.organizationId,
        "content-type": "application/json",
        origin: authTestOrigin,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function world() {
  const f = await openPersonalSkillFixture();
  const skillResponse = await f.post(f.ownerCookie, "/v1/skills", {
    slug: "my-notes",
    name: "My notes",
    scope: "personal",
  }, "pw-skill");
  assertEquals(skillResponse.status, 201, await skillResponse.clone().text());
  const skill = await skillResponse.json() as { id: string };
  const sv = await f.insertSkillVersion(skill.id);
  const wfRes = await f.post(f.ownerCookie, "/v1/workflows", {
    slug: "pw-flow",
    name: "Skill flow",
    description: "Skill flow",
  }, "pw-wf");
  assertEquals(wfRes.status, 201, await wfRes.clone().text());
  const wf = await wfRes.json() as { id: string };
  const versionsPath = "/v1/workflows/" + wf.id + "/versions";
  const created = await f.post(f.ownerCookie, versionsPath, {
    definition: DEF(sv),
    confirmPersonalSkillUse: [sv],
  }, "pw-draft");
  assertEquals(created.status, 201, await created.clone().text());
  const draft = await created.json() as { id: string; version: number };
  return { f, skill, sv, wf, versionsPath, draft };
}
const items = async (f: Fx, cookie: string, path: string) => {
  const r = await f.read(cookie, path);
  assertEquals(r.status, 200, await r.clone().text());
  return (await r.json() as { items: Item[] }).items;
};
const copyOf = async (
  f: Fx,
  cookie: string,
  wfId: string,
  srcVersion: string,
  slug: string,
) => {
  const c = await f.post(cookie, "/v1/workflows/" + wfId + "/copy", {
    slug,
    name: slug,
    description: "copy",
    sourceVersionId: srcVersion,
  }, "pw-" + slug);
  assertEquals(c.status, 201, await c.clone().text());
  const copy = await c.json() as { id: string };
  const list =
    await (await f.read(cookie, "/v1/workflows/" + copy.id + "/versions"))
      .json() as { items: { id: string; version: number; status: string }[] };
  return { copy, copyDraft: list.items.find((i) => i.status === "draft")! };
};

Deno.test("publishing a copied workflow is refused while a skill slot is open, and goes through once it is resolved", async () => {
  const w = await world();
  const f = w.f;
  try {
    const { copy, copyDraft } = await copyOf(
      f,
      f.ownerCookie,
      w.wf.id,
      w.draft.id,
      "pw-copy-1",
    );
    const base = "/v1/workflows/" + copy.id + "/versions/" + copyDraft.id;
    const refused = await send(
      f,
      f.adminCookie,
      "POST",
      base + "/publish",
      {},
      {
        "If-Match": '"' + copyDraft.version + '"',
        "Idempotency-Key": "pw-pub-1",
      },
    );
    const refusedText = await refused.text();
    assertEquals(refused.status, 422, refusedText);
    assert(refusedText.includes("step_skill_slot_open"), refusedText);
    const resolved = await f.patch(
      f.adminCookie,
      base,
      { definition: PLAIN, resolveSkillSlots: ["/steps/0"] },
      "pw-res-1",
      copyDraft.version,
    );
    assertEquals(resolved.status, 200, await resolved.clone().text());
    const next = (await resolved.json() as { version?: number }).version ??
      copyDraft.version + 1;
    const ok = await send(f, f.adminCookie, "POST", base + "/publish", {}, {
      "If-Match": '"' + next + '"',
      "Idempotency-Key": "pw-pub-2",
    });
    assertEquals(ok.status, 200, await ok.text());
  } finally {
    await f.close();
  }
});

Deno.test("validating a workflow flags another person's personal skill and passes its owner", async () => {
  const w = await world();
  const f = w.f;
  try {
    const post = async (cookie: string, definition: unknown) => {
      const r = await send(f, cookie, "POST", "/v1/workflow-validations", {
        definition,
      }, { "Idempotency-Key": "pw-val-" + crypto.randomUUID() });
      return { status: r.status, text: await r.text() };
    };
    const control = await post(f.adminCookie, PLAIN);
    assertEquals(control.status, 200, control.text);
    assert(!control.text.includes("step_skill"), control.text);
    const owner = await post(f.ownerCookie, DEF(w.sv));
    assertEquals(owner.status, 200, owner.text);
    assert(!owner.text.includes("step_skill"), owner.text);
    const other = await post(f.adminCookie, DEF(w.sv));
    assertEquals(other.status, 200, other.text);
    assert(other.text.includes("step_skill_unavailable"), other.text);
  } finally {
    await f.close();
  }
});

Deno.test("a switched-off skill or source reads as unavailable and is refused", async () => {
  const w = await world();
  const f = w.f;
  try {
    const path = w.versionsPath + "/" + w.draft.id + "/skills";
    assertEquals((await items(f, f.ownerCookie, path))[0].status, "available");
    const issues = () =>
      withPgTransaction(
        f.fixture.pgDatabase,
        (t) =>
          stepSkillIssues(t, {
            organizationId: f.organizationId,
            principalId: f.adminPrincipalId,
            workflowId: w.wf.id,
            definition: DEF(w.sv),
          }),
      );
    assertEquals((await issues()).length, 0);
    await f.fixture.pgDatabase.query(
      "update bakery.skills set enabled = false where id = $1",
      [w.skill.id],
    );
    for (const c of [f.ownerCookie, f.adminCookie]) {
      assertEquals((await items(f, c, path))[0].status, "unavailable");
    }
    assertEquals((await issues()).map((i) => i.code), [
      "step_skill_unavailable",
    ]);
    await f.fixture.pgDatabase.query(
      "update bakery.skills set enabled = true where id = $1",
      [w.skill.id],
    );
    assertEquals((await items(f, f.ownerCookie, path))[0].status, "available");
    await f.fixture.pgDatabase.query(
      "update bakery.skill_sources set enabled = false where id = (select source_id from bakery.skills where id = $1)",
      [w.skill.id],
    );
    for (const c of [f.ownerCookie, f.adminCookie]) {
      assertEquals((await items(f, c, path))[0].status, "unavailable");
    }
  } finally {
    await f.close();
  }
});

Deno.test("only a personal skill's owner learns that a published version uses it", async () => {
  const w = await world();
  const f = w.f;
  try {
    const pub = await send(
      f,
      f.ownerCookie,
      "POST",
      w.versionsPath + "/" + w.draft.id + "/publish",
      {},
      {
        "If-Match": '"' + w.draft.version + '"',
        "Idempotency-Key": "pw-pub-own",
      },
    );
    const pubText = await pub.text();
    assertEquals(pub.status, 200, pubText);
    const published = JSON.parse(pubText) as { id: string };
    const path = w.versionsPath + "/" + published.id + "/skills";
    const [mine] = await items(f, f.ownerCookie, path);
    assertEquals(mine.publishedVersionUsesIt, true);
    assertEquals(mine.status, "available");
    const [theirs] = await items(f, f.adminCookie, path);
    assertEquals(theirs.publishedVersionUsesIt, false);
    assertEquals(theirs.mine, false);
    assertEquals("skillId" in theirs, false);
  } finally {
    await f.close();
  }
});

Deno.test("the workflow skills read answers no other organization, no session and no foreign workflow", async () => {
  const w = await world();
  const f = w.f;
  try {
    const path = w.versionsPath + "/" + w.draft.id + "/skills";
    const foreignOrg = await send(
      f,
      f.adminCookie,
      "GET",
      path,
      undefined,
      {},
      crypto.randomUUID(),
    );
    const foreignText = await foreignOrg.text();
    assert(foreignOrg.status >= 400, String(foreignOrg.status) + foreignText);
    assert(!foreignText.includes("My notes"), foreignText);
    const anon = await f.fixture.app.fetch(
      new Request(authTestOrigin + path, {
        headers: { "Bakery-Organization-Id": f.organizationId },
      }),
    );
    const anonText = await anon.text();
    assert(anon.status >= 400, String(anon.status) + anonText);
    assert(!anonText.includes("My notes"), anonText);
    const wrong = await send(
      f,
      f.adminCookie,
      "GET",
      "/v1/workflows/" + crypto.randomUUID() + "/versions/" + w.draft.id +
        "/skills",
    );
    assertEquals(wrong.status, 404, await wrong.text());
  } finally {
    await f.close();
  }
});

Deno.test("a workflow copied by someone other than the owner carries no personal skill", async () => {
  const w = await world();
  const f = w.f;
  try {
    const { copy, copyDraft } = await copyOf(
      f,
      f.adminCookie,
      w.wf.id,
      w.draft.id,
      "pw-copy-2",
    );
    const body = await (await f.read(
      f.adminCookie,
      "/v1/workflows/" + copy.id + "/versions/" + copyDraft.id,
    )).text();
    assert(!body.includes(w.sv), body);
    const [slot] = await items(
      f,
      f.adminCookie,
      "/v1/workflows/" + copy.id + "/versions/" + copyDraft.id + "/skills",
    );
    assertEquals(slot.status, "missing");
    assertEquals(slot.skillName, "My notes");
  } finally {
    await f.close();
  }
});

Deno.test("a copy of a step that names two personal skills keeps both names in its slot", async () => {
  const f = await openPersonalSkillFixture();
  try {
    const make = async (slug: string, name: string) => {
      const response = await f.post(
        f.ownerCookie,
        "/v1/skills",
        { slug, name, scope: "personal" },
        "pw-" + slug,
      );
      assertEquals(response.status, 201, await response.clone().text());
      const skill = await response.json() as { id: string };
      return await f.insertSkillVersion(skill.id);
    };
    const first = await make("my-notes", "My notes");
    const second = await make("my-drafts", "My drafts");
    const workflow = await f.post(f.ownerCookie, "/v1/workflows", {
      slug: "two-skills",
      name: "Two skills",
      description: "Two skills",
    }, "pw-two-wf");
    assertEquals(workflow.status, 201, await workflow.clone().text());
    const wf = await workflow.json() as { id: string };
    const versionsPath = "/v1/workflows/" + wf.id + "/versions";
    const skills = [first, second].sort();
    const created = await f.post(f.ownerCookie, versionsPath, {
      definition: {
        kind: "fixed",
        steps: [{
          id: "first",
          uses: "workflow.noop",
          action: "agent.run",
          skills,
        }],
      },
      confirmPersonalSkillUse: skills,
    }, "pw-two-draft");
    assertEquals(created.status, 201, await created.clone().text());
    const draft = await created.json() as { id: string };
    const { copy, copyDraft } = await copyOf(
      f,
      f.ownerCookie,
      wf.id,
      draft.id,
      "pw-two-copy",
    );
    const slots = await items(
      f,
      f.ownerCookie,
      "/v1/workflows/" + copy.id + "/versions/" + copyDraft.id + "/skills",
    );
    assertEquals(slots.length, 1);
    assertEquals(slots[0].status, "missing");
    assert(
      slots[0].skillName?.includes("My notes"),
      String(slots[0].skillName),
    );
    assert(
      slots[0].skillName?.includes("My drafts"),
      String(slots[0].skillName),
    );
  } finally {
    await f.close();
  }
});

Deno.test("a published version that only mentions a skill's id is not reported as using it", async () => {
  const w = await world();
  const f = w.f;
  try {
    // The only draft is rewritten so the skill's id appears in its text without
    // any step using the skill, and published.
    const base = w.versionsPath + "/" + w.draft.id;
    const rewritten = await f.patch(
      f.ownerCookie,
      base,
      {
        definition: {
          kind: "fixed",
          // Carries the skill id in a skills list but names no action, so no step
          // uses it: the id appears in the published text only.
          steps: [{ id: "first", uses: "workflow.noop", skills: [w.sv] }],
        },
      },
      "pw-mention-edit",
      w.draft.version,
    );
    assertEquals(rewritten.status, 200, await rewritten.clone().text());
    const edited = await rewritten.json() as { version?: number };
    const published = await send(
      f,
      f.ownerCookie,
      "POST",
      base + "/publish",
      {},
      {
        "If-Match": '"' + (edited.version ?? w.draft.version + 1) + '"',
        "Idempotency-Key": "pw-mention-publish",
      },
    );
    assertEquals(published.status, 200, await published.clone().text());
    // A new draft that does use the skill, confirmed by its owner.
    const next = await f.post(
      f.ownerCookie,
      w.versionsPath,
      { definition: DEF(w.sv), confirmPersonalSkillUse: [w.sv] },
      "pw-mention-draft",
    );
    assertEquals(next.status, 201, await next.clone().text());
    const draft = await next.json() as { id: string };
    const [mine] = await items(
      f,
      f.ownerCookie,
      w.versionsPath + "/" + draft.id + "/skills",
    );
    assertEquals(mine.status, "available");
    assertEquals(mine.publishedVersionUsesIt, false);
  } finally {
    await f.close();
  }
});
