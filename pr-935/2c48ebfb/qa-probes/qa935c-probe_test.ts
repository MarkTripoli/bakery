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


Deno.test("QA935-P2c a developer-role member: export and import are refused the same way the existing workflow routes refuse", async () => {
  await resetDatabase();
  const fixture = await openAuthFixture({ databaseConfig });
  const owner = fixture.database;
  try {
    const a = await seedOrganization(fixture, "a");
    const dev = await seedOrganization(fixture, "a-dev", "developer", a.organizationId);
    const wf = await publishWith(a, "triage", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop" }] });
    const pkg = await a.json<Pkg>(await a.send("POST", "/v1/library-packages/export", { name: "Starter", workflowIds: [wf.workflowId] }), 200);
    const b = await seedOrganization(fixture, "b");
    const bDev = await seedOrganization(fixture, "b-dev", "developer", b.organizationId);
    const e = await dev.send("POST", "/v1/library-packages/export", { name: "x", workflowIds: [wf.workflowId] });
    const i = await bDev.send("POST", "/v1/library-packages/import", { package: pkg });
    const control = await dev.send("POST", "/v1/workflows", { slug: "ctl", name: "Control", description: "d" });
    const es = e.status, is = i.status, cs = control.status;
    await e.text(); await i.text(); await control.text();
    console.log("QA935 P2c developer export", es, "import", is, "control POST /v1/workflows", cs);
    console.log("QA935 P2c workflows written in B by the developer:", await count(owner, "workflow_definitions", b.organizationId));
  } finally { await fixture.close(); }
});

Deno.test("QA935-P7b does publish check that a skill or agent version belongs to the organization, with no import involved", async () => {
  await resetDatabase();
  const root = await Deno.makeTempDir({ prefix: "qa935-p7b-" });
  const fixture = await openAuthFixture({ databaseConfig, skillFileRoot: root });
  try {
    const a = await seedOrganization(fixture, "a");
    const b = await seedOrganization(fixture, "b");
    const sk = await makeSkill(a, "research", "Research");
    const ag = await makeAgent(a, "reviewer", "Reviewer", { research: sk.versionId });
    const mk = async (org: Org, slug: string, def: unknown) => {
      const w = await org.json<{ id: string }>(await org.send("POST", "/v1/workflows", { slug, name: "W", description: "d" }), 201);
      const v = await org.send("POST", "/v1/workflows/" + w.id + "/versions", { definition: def });
      const vt = await v.text();
      if (v.status !== 201) return { created: v.status, body: vt.slice(0, 200) };
      const vid = (JSON.parse(vt) as { id: string }).id;
      const p = await org.send("POST", "/v1/workflows/" + w.id + "/versions/" + vid + "/publish", {}, { "If-Match": '"1"' });
      return { created: 201, published: p.status, body: (await p.text()).slice(0, 300) };
    };
    const foreignSkill = await mk(b, "foreign-skill", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop", skills: [sk.versionId] }] });
    const foreignAgent = await mk(b, "foreign-agent", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop", agentVersionId: ag.versionId }] });
    const nowhere = await mk(a, "nowhere", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop", skills: [crypto.randomUUID()] }] });
    const own = await mk(a, "own", { kind: "fixed", steps: [{ id: "first", uses: "workflow.noop", skills: [sk.versionId], agentVersionId: ag.versionId }] });
    console.log("QA935 P7b B publishes a workflow naming A's skill version:", JSON.stringify(foreignSkill));
    console.log("QA935 P7b B publishes a workflow naming A's agent version:", JSON.stringify(foreignAgent));
    console.log("QA935 P7b A publishes a workflow naming a skill that exists nowhere:", JSON.stringify(nowhere));
    console.log("QA935 P7b A publishes a workflow naming its own skill and agent:", JSON.stringify(own).slice(0, 200));
  } finally { await fixture.close(); await Deno.remove(root, { recursive: true }); }
});
