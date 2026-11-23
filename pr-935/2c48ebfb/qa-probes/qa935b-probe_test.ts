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


Deno.test("QA935-P1b a foreign id is refused exactly like a missing one (issues compared, ids normalised)", async () => {
  await resetDatabase();
  const root = await Deno.makeTempDir({ prefix: "qa935-p1b-" });
  const fixture = await openAuthFixture({ databaseConfig, skillFileRoot: root });
  try {
    const a = await seedOrganization(fixture, "a");
    const b = await seedOrganization(fixture, "b");
    const wf = await publishWith(a, "triage", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop" }] });
    await a.json(await a.send("POST", "/v1/organizations/" + a.organizationId + "/artifact-kinds/brief/versions", { expectedRevision: 0, definition: kindDefinition }), 201);
    const sk = await makeSkill(a, "research", "Research");
    const ag = await makeAgent(a, "reviewer", "Reviewer", { research: sk.versionId });
    const f = await b.send("POST", "/v1/library-packages/export", { name: "Steal", workflowIds: [wf.workflowId], skillIds: [sk.skillId], agentIds: [ag.agentId], artifactKindKeys: ["brief"] });
    const ft = await f.text();
    const r = await b.send("POST", "/v1/library-packages/export", { name: "Steal", workflowIds: [crypto.randomUUID()], skillIds: [crypto.randomUUID()], agentIds: [crypto.randomUUID()], artifactKindKeys: ["brief"] });
    const rt = await r.text();
    const issues = (t: string) => JSON.stringify(JSON.parse(t).issues).replace(UUIDS, "ID");
    console.log("QA935 P1b statuses", f.status, r.status, "issues foreign:", issues(ft).slice(0, 500));
    console.log("QA935 P1b issues random :", issues(rt).slice(0, 500));
    assertEquals(f.status, 422);
    assertEquals(r.status, 422);
    assertEquals(issues(ft), issues(rt));
    for (const secret of [wf.workflowId, sk.skillId, sk.versionId, ag.agentId, ag.versionId, a.organizationId, "Source flow", "Research", "Reviewer"]) assertEquals(ft.includes(secret), false, secret + " leaked in the refusal");
  } finally { await fixture.close(); await Deno.remove(root, { recursive: true }); }
});

Deno.test("QA935-P2b why a member gets 500: the body, and the same member on an existing admin route", async () => {
  await resetDatabase();
  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  try {
    const a = await seedOrganization(fixture, "a");
    const member = await seedOrganization(fixture, "a-member", "member", a.organizationId);
    const wf = await publishWith(a, "triage", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop" }] });
    const e = await member.send("POST", "/v1/library-packages/export", { name: "x", workflowIds: [wf.workflowId] });
    const et = await e.text();
    const control = await member.send("POST", "/v1/workflows", { slug: "ctl", name: "Control", description: "d" });
    const ct = await control.text();
    const read = await member.send("GET", "/v1/workflows");
    const rt = await read.text();
    const roles = await owner`select role, status from bakery.organization_memberships where organization_id = ${a.organizationId}`;
    console.log("QA935 P2b member export", e.status, et.slice(0, 400));
    console.log("QA935 P2b member POST /v1/workflows (control)", control.status, ct.slice(0, 300));
    console.log("QA935 P2b member GET /v1/workflows", read.status, rt.slice(0, 120));
    console.log("QA935 P2b memberships", JSON.stringify(roles));
  } finally { await fixture.close(); }
});

Deno.test("QA935-P7 can a raw id from another organization, smuggled in by a hand-built package, be published in B", async () => {
  await resetDatabase();
  const root = await Deno.makeTempDir({ prefix: "qa935-p7-" });
  const fixture = await openAuthFixture({ databaseConfig, skillFileRoot: root });
  const owner = fixture.database;
  try {
    const a = await seedOrganization(fixture, "a");
    const b = await seedOrganization(fixture, "b");
    const sk = await makeSkill(a, "research", "Research");
    const ag = await makeAgent(a, "reviewer", "Reviewer", { research: sk.versionId });
    const def = { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop", skills: [sk.versionId], agentVersionId: ag.versionId }] };
    const pkg = await buildPackage("raw", [{ kind: "workflow", key: "rawflow", data: { slug: "rawflow", name: "W", description: "d", definition: canonicalJson(def), openBindings: [] } } as never]);
    const imp = await b.send("POST", "/v1/library-packages/import", { package: pkg });
    console.log("QA935 P7 import of A's real ids into B", imp.status); await imp.text();
    const row = (await owner`select d.id, draft.definition from bakery.workflow_drafts draft join bakery.workflow_definitions d on d.id = draft.workflow_id where d.organization_id = ${b.organizationId}`)[0]!;
    console.log("QA935 P7 draft in B names A's skill version:", JSON.stringify(row.definition).includes(sk.versionId), "and A's agent version:", JSON.stringify(row.definition).includes(ag.versionId));
    const ver = await b.send("POST", "/v1/workflows/" + row.id + "/versions", { definition: row.definition });
    const vt = await ver.text();
    console.log("QA935 P7 B creates a version from that draft:", ver.status, vt.slice(0, 400));
    if (ver.status === 201) {
      const vid = JSON.parse(vt).id as string;
      const pub = await b.send("POST", "/v1/workflows/" + row.id + "/versions/" + vid + "/publish", {}, { "If-Match": '"1"' });
      const pt = await pub.text();
      console.log("QA935 P7 B publishes it:", pub.status, pt.slice(0, 400));
    }
    // control: the same definition with a made-up skill id, published in A itself
    const ctl = await a.send("POST", "/v1/workflows", { slug: "ctl", name: "C", description: "d" });
    const ctlId = (JSON.parse(await ctl.text()) as { id: string }).id;
    const cv = await a.send("POST", "/v1/workflows/" + ctlId + "/versions", { definition: { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop", skills: [crypto.randomUUID()] }] } });
    console.log("QA935 P7 control, A creates a version naming a skill id that exists nowhere:", cv.status, (await cv.text()).slice(0, 300));
  } finally { await fixture.close(); await Deno.remove(root, { recursive: true }); }
});
