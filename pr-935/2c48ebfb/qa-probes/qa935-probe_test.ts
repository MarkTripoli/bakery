import { assert, assertEquals } from "@std/assert";
import { buildPackage } from "../../packages/contracts/src/library-packages.ts";
import { canonicalJson } from "../../packages/contracts/src/workflow-compiler/canonical.ts";
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

async function seedOrganization(fixture: Fixture, label: string, role = "admin", existingOrganizationId?: string) {
  const owner = fixture.database;
  const now = new Date();
  const organizationId = existingOrganizationId ?? crypto.randomUUID();
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const token = `admin-${crypto.randomUUID()}`;
  if (!existingOrganizationId) await owner`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
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
    values (${crypto.randomUUID()}, ${organizationId}, ${principalId}, ${role}, 'active', ${now}, ${now}, ${now}, 1)`;
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


const textOf = (value: unknown) => JSON.stringify(value);

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeSkill(org: Org, slug: string, name: string) {
  const skill = await org.json<{ id: string }>(await org.send("POST", "/v1/skills", { slug, name }), 201);
  const body = new TextEncoder().encode("# " + name + "\nAsk first.\n");
  const manifest = { schemaVersion: 1, license: "MIT", entryPath: "SKILL.md", files: [{ path: "SKILL.md", mediaType: "text/markdown", sizeBytes: body.byteLength, sha256: await sha256(body), isExecutable: false }] };
  const published = await org.json<{ id: string }>(await org.send("POST", "/v1/skills/" + skill.id + "/versions", {
    revision: 1, digest: await sha256(canonicalJson(manifest)), entryPath: "SKILL.md", manifest,
    files: [{ path: "SKILL.md", mediaType: "text/markdown", isExecutable: false, contentBase64: btoa(String.fromCharCode(...body)) }],
  }), 201);
  return { skillId: skill.id, versionId: published.id };
}

async function makeAgent(org: Org, slug: string, name: string, bindings: Record<string, string>) {
  const agent = await org.json<{ id: string }>(await org.send("POST", "/v1/agents", { slug, name, description: "Reviews." }), 201);
  const config = { harness: "claude_code", allowedCapabilities: [], skillBindings: bindings };
  const version = await org.json<{ id: string }>(await org.send("POST", "/v1/agents/" + agent.id + "/versions", { revision: 1, config, digest: await sha256(canonicalJson(config)) }), 201);
  await org.json(await org.send("POST", "/v1/agents/" + agent.id + "/activations", { versionId: version.id }, { "If-Match": '"1"' }), 200);
  return { agentId: agent.id, versionId: version.id };
}

async function publishWith(org: Org, slug: string, def: unknown): Promise<{ workflowId: string; versionId: string }> {
  const source = await org.json<{ id: string }>(await org.send("POST", "/v1/workflows", { slug, name: "Source flow", description: "The source." }), 201);
  const draft = await org.json<{ id: string }>(await org.send("POST", "/v1/workflows/" + source.id + "/versions", { definition: def }), 201);
  const published = await org.json<{ id: string }>(await org.send("POST", "/v1/workflows/" + source.id + "/versions/" + draft.id + "/publish", {}, { "If-Match": '"1"' }), 200);
  await org.json(await org.send("POST", "/v1/workflows/" + source.id + "/activations", { versionId: published.id }, { "If-Match": '"1"' }), 200);
  return { workflowId: source.id, versionId: published.id };
}

const count = async (owner: Fixture["database"], table: string, org: string) =>
  (await owner.unsafe("select count(*)::int as n from bakery." + table + " where organization_id = '" + org + "'"))[0]!.n as number;
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

Deno.test("QA935-P1 another organization cannot export from A: refused like a missing id, nothing of A in the answer", async () => {
  await resetDatabase();
  const root = await Deno.makeTempDir({ prefix: "qa935-p1-" });
  const fixture = await openAuthFixture({ databaseConfig, skillFileRoot: root });
  try {
    const a = await seedOrganization(fixture, "a");
    const b = await seedOrganization(fixture, "b");
    const wf = await publishWith(a, "triage", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop" }] });
    await a.json(await a.send("POST", "/v1/organizations/" + a.organizationId + "/artifact-kinds/brief/versions", { expectedRevision: 0, definition: kindDefinition }), 201);
    const sk = await makeSkill(a, "research", "Research");
    const ag = await makeAgent(a, "reviewer", "Reviewer", { research: sk.versionId });
    const foreign = await b.send("POST", "/v1/library-packages/export", { name: "Steal", workflowIds: [wf.workflowId], skillIds: [sk.skillId], agentIds: [ag.agentId], artifactKindKeys: ["brief"] });
    const foreignText = await foreign.text();
    const random = await b.send("POST", "/v1/library-packages/export", { name: "Steal", workflowIds: [crypto.randomUUID()], skillIds: [crypto.randomUUID()], agentIds: [crypto.randomUUID()], artifactKindKeys: ["brief"] });
    const randomText = await random.text();
    console.log("QA935 P1 foreign status", foreign.status, "random status", random.status);
    console.log("QA935 P1 foreign body", foreignText.slice(0, 600));
    assertEquals(foreign.status, 422, foreignText);
    for (const secret of [wf.workflowId, sk.skillId, sk.versionId, ag.agentId, ag.versionId, a.organizationId, "Source flow", "Research", "Reviewer"]) assertEquals(foreignText.includes(secret), false, secret + " leaked in the refusal");
    assertEquals(random.status, foreign.status);
    assertEquals(randomText.replace(UUIDS, "ID"), foreignText.replace(UUIDS, "ID"), "a foreign id must look exactly like a missing one");
  } finally { await fixture.close(); await Deno.remove(root, { recursive: true }); }
});

Deno.test("QA935-P2 a member without workflow:manage and a caller with no session cannot export or import", async () => {
  await resetDatabase();
  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  try {
    const a = await seedOrganization(fixture, "a");
    const member = await seedOrganization(fixture, "a-member", "member", a.organizationId);
    const wf = await publishWith(a, "triage", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop" }] });
    const pkg = await a.json<Pkg>(await a.send("POST", "/v1/library-packages/export", { name: "Starter", workflowIds: [wf.workflowId] }), 200);
    const b = await seedOrganization(fixture, "b");
    const bMember = await seedOrganization(fixture, "b-member", "member", b.organizationId);
    const e = await member.send("POST", "/v1/library-packages/export", { name: "x", workflowIds: [wf.workflowId] });
    const i = await bMember.send("POST", "/v1/library-packages/import", { package: pkg });
    const anon = await fixture.app.fetch(new Request(authTestOrigin + "/v1/library-packages/export", { method: "POST", headers: { origin: authTestOrigin, "content-type": "application/json", "Bakery-Organization-Id": a.organizationId, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ name: "x", workflowIds: [wf.workflowId] }) }));
    const es = e.status, is = i.status, as = anon.status;
    await e.text(); await i.text(); await anon.text();
    console.log("QA935 P2 member export", es, "member import", is, "anonymous export", as);
    assertEquals([es, is].every((s) => s === 403), true, "member statuses " + es + "," + is);
    assertEquals(as === 401 || as === 403, true, "anonymous " + as);
    assertEquals(await count(owner, "workflow_definitions", b.organizationId), 0);
  } finally { await fixture.close(); }
});

Deno.test("QA935-P3 a real workflow that names skills and an agent exports with none of A's ids and imports rebound", async () => {
  await resetDatabase();
  const root = await Deno.makeTempDir({ prefix: "qa935-p3-" });
  const fixture = await openAuthFixture({ databaseConfig, skillFileRoot: root });
  const owner = fixture.database;
  try {
    const a = await seedOrganization(fixture, "a");
    const b = await seedOrganization(fixture, "b");
    const research = await makeSkill(a, "research", "Research");
    const secret = await makeSkill(a, "secret-sauce", "Secret sauce");
    const reviewer = await makeAgent(a, "reviewer", "Reviewer", { research: research.versionId });
    const def = { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop", skills: [research.versionId, secret.versionId], agentVersionId: reviewer.versionId }] };
    const wf = await publishWith(a, "triage", def);
    const pkg = await a.json<Pkg>(await a.send("POST", "/v1/library-packages/export", { name: "Kit", workflowIds: [wf.workflowId], skillIds: [research.skillId], agentIds: [reviewer.agentId] }), 200);
    const text = textOf(pkg);
    const ids = { org: a.organizationId, workflow: wf.workflowId, workflowVersion: wf.versionId, research: research.skillId, researchV: research.versionId, secret: secret.skillId, secretV: secret.versionId, agent: reviewer.agentId, agentV: reviewer.versionId };
    console.log("QA935 P3 uuids anywhere in the exported package:", (text.match(UUIDS) ?? []).length);
    console.log("QA935 P3 exported workflow data", JSON.stringify(pkg.items.find((x) => x.kind === "workflow")!.data).slice(0, 600));
    for (const [name, id] of Object.entries(ids)) assertEquals(text.toLowerCase().includes(id.toLowerCase()), false, name + " " + id + " leaked into the package");
    const result = await b.json<{ imported: unknown[]; openBindings: { key: string; kind: string; name: string }[] }>(await b.send("POST", "/v1/library-packages/import", { package: pkg }), 201);
    console.log("QA935 P3 openBindings", JSON.stringify(result.openBindings));
    const newSkill = (await owner`select active_version_id from bakery.skills where organization_id = ${b.organizationId} and slug = 'research'`)[0]!;
    const newAgentV = (await owner`select v.id from bakery.agent_versions v join bakery.agent_definitions d on d.id = v.agent_id where d.organization_id = ${b.organizationId}`)[0]!;
    const draft = (await owner`select draft.definition from bakery.workflow_drafts draft join bakery.workflow_definitions d on d.id = draft.workflow_id where d.organization_id = ${b.organizationId}`)[0]!;
    const step = (draft.definition as { steps: { skills?: string[]; agentVersionId?: string }[] }).steps[0]!;
    console.log("QA935 P3 imported step", JSON.stringify(step));
    assertEquals(step.skills, [newSkill.active_version_id]);
    assertEquals(step.agentVersionId, newAgentV.id);
    assertEquals(JSON.stringify(draft.definition).includes(secret.versionId), false);
    assert(result.openBindings.some((o) => o.kind === "skill" && o.name === "Secret sauce"), "the unexported skill is listed by name");
  } finally { await fixture.close(); await Deno.remove(root, { recursive: true }); }
});

Deno.test("QA935-P4 a failure after the first write leaves nothing behind", async () => {
  await resetDatabase();
  const root = await Deno.makeTempDir({ prefix: "qa935-p4-" });
  const fixture = await openAuthFixture({ databaseConfig, skillFileRoot: root });
  const owner = fixture.database;
  try {
    const a = await seedOrganization(fixture, "a");
    const b = await seedOrganization(fixture, "b");
    const research = await makeSkill(a, "research", "Research");
    const ex = await a.json<Pkg>(await a.send("POST", "/v1/library-packages/export", { name: "Kit", skillIds: [research.skillId] }), 200);
    const wfData = (slug: string) => ({ slug, name: "Dup", description: "d", definition: canonicalJson({ kind: "fixed", steps: [{ id: "first", uses: "workflow.noop" }] }), openBindings: [] });
    const pkg = await buildPackage("Mid failure", [
      ...ex.items.map((i) => ({ ...i }) as never),
      { kind: "workflow", key: "one", data: wfData("dup") },
      { kind: "workflow", key: "two", data: wfData("dup") },
    ]);
    const res = await b.send("POST", "/v1/library-packages/import", { package: pkg });
    const body = await res.text();
    console.log("QA935 P4 status", res.status, body.slice(0, 300));
    const after = { skills: await count(owner, "skills", b.organizationId), workflows: await count(owner, "workflow_definitions", b.organizationId), lineage: await count(owner, "package_imports", b.organizationId) };
    console.log("QA935 P4 rows after", JSON.stringify(after));
    assertEquals(res.status >= 400, true, "status " + res.status);
    assertEquals(after, { skills: 0, workflows: 0, lineage: 0 });
  } finally { await fixture.close(); await Deno.remove(root, { recursive: true }); }
});

Deno.test("QA935-P5 packages built by someone who recomputes every digest are still refused", async () => {
  await resetDatabase();
  const root = await Deno.makeTempDir({ prefix: "qa935-p5-" });
  const fixture = await openAuthFixture({ databaseConfig, skillFileRoot: root });
  const owner = fixture.database;
  try {
    const b = await seedOrganization(fixture, "b");
    const nothing = async (label: string) => assertEquals({ w: await count(owner, "workflow_definitions", b.organizationId), s: await count(owner, "skills", b.organizationId), l: await count(owner, "package_imports", b.organizationId) }, { w: 0, s: 0, l: 0 }, label + " wrote something");
    const wfItem = (slug: string, def: unknown) => ({ kind: "workflow", key: slug, data: { slug, name: "W", description: "d", definition: canonicalJson(def), openBindings: [] } }) as never;
    const grant = await buildPackage("grant", [wfItem("g", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop", with: { Grants: [{ scope: "all" }] } }] })]);
    const r1 = await b.send("POST", "/v1/library-packages/import", { package: grant });
    const t1 = await r1.text(); console.log("QA935 P5a grant member", r1.status, t1.slice(0, 200)); assertEquals(r1.status, 422); await nothing("a");
    const ok = await buildPackage("ok", [wfItem("okflow", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop" }] })]);
    const r2 = await b.send("POST", "/v1/library-packages/import", { package: { ...ok, packageDigest: "0".repeat(64) } });
    await r2.text(); console.log("QA935 P5b package digest", r2.status); assertEquals(r2.status, 422); await nothing("b");
    const body = new TextEncoder().encode("x");
    const evil = { slug: "evil", name: "Evil", entryPath: "../../etc/evil.md", manifest: { schemaVersion: 1, license: "MIT", entryPath: "../../etc/evil.md", files: [{ path: "../../etc/evil.md", mediaType: "text/markdown", sizeBytes: 1, sha256: await sha256(body), isExecutable: false }] }, files: [{ path: "../../etc/evil.md", mediaType: "text/markdown", isExecutable: false, contentBase64: btoa("x") }] };
    const trav = await buildPackage("trav", [{ kind: "skill", key: "evil", data: evil } as never]);
    const r3 = await b.send("POST", "/v1/library-packages/import", { package: trav });
    const t3 = await r3.text(); console.log("QA935 P5c traversal", r3.status, t3.slice(0, 200)); assertEquals(r3.status >= 400, true); await nothing("c");
    const foreignSkill = crypto.randomUUID(); const foreignAgent = crypto.randomUUID();
    const raw = await buildPackage("raw", [wfItem("rawflow", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop", skills: [foreignSkill], agentVersionId: foreignAgent }] })]);
    const r4 = await b.send("POST", "/v1/library-packages/import", { package: raw });
    const t4 = await r4.text(); console.log("QA935 P5d raw foreign ids status", r4.status, t4.slice(0, 200));
    if (r4.status === 201) {
      const d = (await owner`select draft.definition from bakery.workflow_drafts draft join bakery.workflow_definitions d on d.id = draft.workflow_id where d.organization_id = ${b.organizationId}`)[0]!;
      console.log("QA935 P5d draft kept raw ids:", JSON.stringify(d.definition).includes(foreignSkill));
    }
  } finally { await fixture.close(); await Deno.remove(root, { recursive: true }); }
});

Deno.test("QA935-P6 a kind-only package imported twice, and two imports at once", async () => {
  await resetDatabase();
  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  try {
    const a = await seedOrganization(fixture, "a");
    const b = await seedOrganization(fixture, "b");
    await a.json(await a.send("POST", "/v1/organizations/" + a.organizationId + "/artifact-kinds/brief/versions", { expectedRevision: 0, definition: kindDefinition }), 201);
    const kind = await a.json<Pkg>(await a.send("POST", "/v1/library-packages/export", { name: "Kinds", artifactKindKeys: ["brief"] }), 200);
    const first = await b.send("POST", "/v1/library-packages/import", { package: kind });
    const second = await b.send("POST", "/v1/library-packages/import", { package: kind });
    const s1 = first.status, s2 = second.status;
    await first.text(); await second.text();
    console.log("QA935 P6 kind import #1", s1, "#2", s2, "versions now", await count(owner, "artifact_kind_versions", b.organizationId));
    const c = await seedOrganization(fixture, "c");
    const wf = await publishWith(a, "triage", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop" }] });
    const pkg = await a.json<Pkg>(await a.send("POST", "/v1/library-packages/export", { name: "Flow", workflowIds: [wf.workflowId] }), 200);
    const both = await Promise.all([c.send("POST", "/v1/library-packages/import", { package: pkg }), c.send("POST", "/v1/library-packages/import", { package: pkg })]);
    const statuses = both.map((r) => r.status).sort();
    for (const r of both) await r.text();
    console.log("QA935 P6 concurrent statuses", JSON.stringify(statuses), "workflows", await count(owner, "workflow_definitions", c.organizationId), "lineage", await count(owner, "package_imports", c.organizationId));
    assertEquals(await count(owner, "workflow_definitions", c.organizationId), 1);
    assertEquals(await count(owner, "package_imports", c.organizationId), 1);
  } finally { await fixture.close(); }
});
