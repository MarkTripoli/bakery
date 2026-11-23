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
      "artifactKind:brief",
      "workflow:triage",
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

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("skills and agents travel, workflows are rebound to the new ids, and nothing from the source leaks", async () => {
  await resetDatabase();
  const root = await Deno.makeTempDir({ prefix: "bakery-426-skill-store-" });
  const fixture = await openAuthFixture({
    databaseConfig,
    skillFileRoot: root,
  });
  const owner = fixture.database;
  try {
    const from = await seedOrganization(fixture, "from");
    const to = await seedOrganization(fixture, "to");

    // A published organization skill with one file.
    const skill = await from.json<{ id: string }>(
      await from.send("POST", "/v1/skills", {
        slug: "research",
        name: "Research",
      }),
      201,
    );
    const body = new TextEncoder().encode("# Research\nAsk first.\n");
    const manifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: body.byteLength,
        sha256: await sha256(body),
        isExecutable: false,
      }],
    };
    const published = await from.json<{ id: string }>(
      await from.send("POST", `/v1/skills/${skill.id}/versions`, {
        revision: 1,
        digest: await sha256(canonicalJson(manifest)),
        entryPath: "SKILL.md",
        manifest,
        files: [{
          path: "SKILL.md",
          mediaType: "text/markdown",
          isExecutable: false,
          contentBase64: btoa(String.fromCharCode(...body)),
        }],
      }),
      201,
    );

    // An agent that binds that skill.
    const agent = await from.json<{ id: string }>(
      await from.send("POST", "/v1/agents", {
        slug: "reviewer",
        name: "Reviewer",
        description: "Reviews.",
      }),
      201,
    );
    const config = {
      harness: "claude_code",
      allowedCapabilities: [],
      skillBindings: { research: published.id },
    };
    const agentVersion = await from.json<{ id: string }>(
      await from.send("POST", `/v1/agents/${agent.id}/versions`, {
        revision: 1,
        config,
        digest: await sha256(canonicalJson(config)),
      }),
      201,
    );
    await from.json(
      await from.send(
        "POST",
        `/v1/agents/${agent.id}/activations`,
        { versionId: agentVersion.id },
        { "If-Match": '"1"' },
      ),
      200,
    );

    // An agent that binds a skill the package leaves out is refused, naming it.
    const missing = await from.send("POST", "/v1/library-packages/export", {
      name: "Incomplete",
      agentIds: [agent.id],
    });
    assertEquals(missing.status, 422);
    assert((await missing.text()).includes("agent_skill_not_in_package"));

    const exported = await from.json<{
      items: { kind: string; key: string; data: unknown }[];
    }>(
      await from.send("POST", "/v1/library-packages/export", {
        name: "Review kit",
        skillIds: [skill.id],
        agentIds: [agent.id],
      }),
      200,
    );
    assertEquals(
      exported.items.map((item) => `${item.kind}:${item.key}`).sort(),
      ["agent:reviewer", "skill:research"],
    );
    const text = JSON.stringify(exported);
    for (
      const id of [
        skill.id,
        published.id,
        agent.id,
        agentVersion.id,
        from.organizationId,
      ]
    ) {
      assertEquals(text.includes(id), false, `${id} must not leave`);
    }

    // The package gains a workflow that names both by package reference and
    // one skill from nowhere, as an export of such a workflow would write it.
    const workflowDefinition = {
      kind: "fixed",
      steps: [{
        id: "first",
        uses: "workflow.noop",
        skills: ["package:skill/research"],
        agentVersionId: "package:agent/reviewer",
      }],
    };
    const pkg = await buildPackage("Review kit", [
      ...exported.items.map((item) => ({ ...item }) as never),
      {
        kind: "workflow",
        key: "triage",
        data: {
          slug: "triage",
          name: "Triage",
          description: "Sort.",
          definition: canonicalJson(workflowDefinition),
          openBindings: [{
            path: "/steps/1/skills/0",
            kind: "skill",
            name: "House rules",
          }],
        },
      },
    ]);
    const result = await to.json<{
      imported: { kind: string; key: string; resultingId: string }[];
      openBindings: { key: string; kind: string; name: string }[];
    }>(
      await to.send("POST", "/v1/library-packages/import", { package: pkg }),
      201,
    );
    assertEquals(result.imported.length, 3);

    const newSkill =
      (await owner`select id, active_version_id from bakery.skills where organization_id = ${to.organizationId} and slug = 'research'`)[
        0
      ]!;
    assert(newSkill.active_version_id, "the skill arrives published");
    assert(
      newSkill.id !== skill.id && newSkill.active_version_id !== published.id,
    );
    const newAgent =
      (await owner`select agent.id, version.id as version_id, version.config from bakery.agent_definitions agent join bakery.agent_versions version on version.agent_id = agent.id where agent.organization_id = ${to.organizationId}`)[
        0
      ]!;
    assertEquals(
      (newAgent.config as { skillBindings: Record<string, string> })
        .skillBindings.research,
      newSkill.active_version_id,
    );
    assertEquals(
      "billing" in (newAgent.config as Record<string, unknown>),
      false,
      "billing never travels",
    );
    const draft =
      (await owner`select draft.definition from bakery.workflow_drafts draft join bakery.workflow_definitions definition on definition.id = draft.workflow_id where definition.organization_id = ${to.organizationId}`)[
        0
      ]!;
    const step = (draft.definition as {
      steps: { skills: string[]; agentVersionId: string }[];
    }).steps[0]!;
    assertEquals(step.skills, [newSkill.active_version_id]);
    assertEquals(step.agentVersionId, newAgent.version_id);
    assertEquals(
      result.openBindings.map((b) => `${b.key}:${b.kind}:${b.name}`).sort(),
      ["reviewer:billing:Reviewer", "triage:skill:House rules"],
    );

    // A hand-built package whose skill names a path that leaves its directory,
    // or whose bytes no longer match their manifest, is refused as
    // unprocessable (never a server fault) and writes nothing.
    const third = await seedOrganization(fixture, "third");
    const skillItem = exported.items.find((item) => item.kind === "skill")!;
    const skillData = skillItem.data as {
      files: { path: string; contentBase64: string }[];
      entryPath: string;
    };
    const rebuilt = (data: unknown) =>
      buildPackage("Hand built", [{
        kind: "skill",
        key: "research",
        data: data as never,
      }]);
    for (
      const [name, data, expected] of [
        [
          "traversal in a file path",
          {
            ...skillData,
            files: [{ ...skillData.files[0]!, path: "../../x" }],
          },
          "package_path_unsafe",
        ],
        [
          "traversal in the entry path",
          { ...skillData, entryPath: "../../x" },
          "package_path_unsafe",
        ],
        [
          "bytes that do not match the manifest",
          {
            ...skillData,
            files: [{
              ...skillData.files[0]!,
              contentBase64: btoa("not what was published"),
            }],
          },
          undefined,
        ],
      ] as const
    ) {
      const response = await third.send("POST", "/v1/library-packages/import", {
        package: await rebuilt(data),
      });
      const text = await response.text();
      assertEquals(response.status, 422, `${name}: ${text}`);
      if (expected) assert(text.includes(expected), `${name}: ${text}`);
    }
    assertEquals(
      (await owner`select count(*)::int as n from bakery.skills where organization_id = ${third.organizationId}`)[
        0
      ]!.n,
      0,
    );
    assertEquals(
      (await owner`select count(*)::int as n from bakery.package_imports where organization_id = ${third.organizationId}`)[
        0
      ]!.n,
      0,
    );
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
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

Deno.test("a real workflow that names a skill and an agent goes through export and import by id, and another organization cannot export it", async () => {
  await resetDatabase();
  const root = await Deno.makeTempDir({ prefix: "bakery-426-real-flow-" });
  const fixture = await openAuthFixture({
    databaseConfig,
    skillFileRoot: root,
  });
  const owner = fixture.database;
  try {
    const from = await seedOrganization(fixture, "from");
    const to = await seedOrganization(fixture, "to");
    const stranger = await seedOrganization(fixture, "stranger");

    // A skill, an agent that binds it, and a kind, all published in `from`.
    const skill = await from.json<{ id: string }>(
      await from.send("POST", "/v1/skills", {
        slug: "research",
        name: "Research",
      }),
      201,
    );
    const body = new TextEncoder().encode("# Research\nAsk first.\n");
    const manifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: body.byteLength,
        sha256: await sha256(body),
        isExecutable: false,
      }],
    };
    const skillVersion = await from.json<{ id: string }>(
      await from.send("POST", `/v1/skills/${skill.id}/versions`, {
        revision: 1,
        digest: await sha256(canonicalJson(manifest)),
        entryPath: "SKILL.md",
        manifest,
        files: [{
          path: "SKILL.md",
          mediaType: "text/markdown",
          isExecutable: false,
          contentBase64: btoa(String.fromCharCode(...body)),
        }],
      }),
      201,
    );
    const agent = await from.json<{ id: string }>(
      await from.send("POST", "/v1/agents", {
        slug: "reviewer",
        name: "Reviewer",
        description: "Reviews.",
      }),
      201,
    );
    // The source agent has billing, as one that publishes in a workflow must.
    // Billing belongs to the source organization and never travels.
    const agentConfig = {
      harness: "claude_code",
      allowedCapabilities: ["model"],
      skillBindings: { research: skillVersion.id },
      billing: {
        provider: "anthropic",
        billingAccountId: "source-org-account",
        model: "claude-sonnet-5-5",
        billingRoute: "api",
        maxTokens: 1000,
        maxUsdReservation: 1,
        pricingMetadataSnapshot: "source-org-pricing",
      },
    };
    const agentVersion = await from.json<{ id: string }>(
      await from.send("POST", `/v1/agents/${agent.id}/versions`, {
        revision: 1,
        config: agentConfig,
        digest: await sha256(canonicalJson(agentConfig)),
      }),
      201,
    );
    await from.json(
      await from.send(
        "POST",
        `/v1/agents/${agent.id}/activations`,
        { versionId: agentVersion.id },
        { "If-Match": '"1"' },
      ),
      200,
    );
    await from.json(
      await from.send(
        "POST",
        `/v1/organizations/${from.organizationId}/artifact-kinds/brief/versions`,
        { expectedRevision: 0, definition: kindDefinition },
      ),
      201,
    );

    // A workflow through the real API that names both by their raw ids.
    const named = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      inputs: {},
      steps: [{
        id: "think",
        uses: "agent.freeform",
        agentVersionId: agentVersion.id,
        skills: [skillVersion.id],
        with: {
          prompt: "Think.",
          maxTurns: 1,
          timeout: "60s",
          maxCostUsd: 1,
          allowedTools: [],
        },
      }],
    };
    const made = await draftOf(from, "thinker", named);
    const published = await publish(from, made.workflowId, made.draftId);
    await from.json(
      await from.send(
        "POST",
        `/v1/workflows/${made.workflowId}/activations`,
        { versionId: published.id },
        { "If-Match": '"1"' },
      ),
      200,
    );

    // Another organization cannot export any of it: every item is "not
    // available", whatever it names, and no package comes back.
    for (
      const [field, value, code] of [
        ["workflowIds", made.workflowId, "workflow_package_source_unavailable"],
        ["skillIds", skill.id, "skill_package_source_unavailable"],
        ["agentIds", agent.id, "agent_package_source_unavailable"],
        [
          "artifactKindKeys",
          "brief",
          "artifact_kind_package_source_unavailable",
        ],
      ] as const
    ) {
      const response = await stranger.send(
        "POST",
        "/v1/library-packages/export",
        { name: "Theft", [field]: [value] },
      );
      const text = await response.text();
      assertEquals(response.status, 422, `${field}: ${text}`);
      assert(text.includes(code), `${field}: ${text}`);
      assertEquals(text.includes(skillVersion.id), false);
      assertEquals(text.includes(agentVersion.id), false);
    }

    // The owner exports the workflow with the skill and the agent it names.
    const exported = await from.json<{
      items: { kind: string; key: string; data: unknown }[];
    }>(
      await from.send("POST", "/v1/library-packages/export", {
        name: "Thinking kit",
        workflowIds: [made.workflowId],
        skillIds: [skill.id],
        agentIds: [agent.id],
      }),
      200,
    );
    const text = JSON.stringify(exported);
    // No raw id of the source organization is in the package, and the
    // workflow names its skill and agent by package reference.
    for (
      const id of [
        skillVersion.id,
        agentVersion.id,
        skill.id,
        agent.id,
        from.organizationId,
      ]
    ) assertEquals(text.includes(id), false, `${id} must not leave`);
    assert(text.includes("package:skill/research"));
    assert(text.includes("package:agent/reviewer"));
    // Billing belongs to the source organization and does not leave with it.
    for (
      const word of ["source-org-account", "source-org-pricing", "billing"]
    ) {
      assertEquals(text.includes(word), false, `${word} must not leave`);
    }

    // It lands in another organization with its references swapped for the
    // copies that organization just made.
    await to.json(
      await to.send("POST", "/v1/library-packages/import", {
        package: exported,
      }),
      201,
    );
    const newSkill =
      (await owner`select active_version_id from bakery.skills where organization_id = ${to.organizationId} and slug = 'research'`)[
        0
      ]!.active_version_id as string;
    const newAgent =
      (await owner`select version.id from bakery.agent_versions version join bakery.agent_definitions agent on agent.id = version.agent_id where agent.organization_id = ${to.organizationId}`)[
        0
      ]!.id as string;
    const draft =
      (await owner`select draft.definition from bakery.workflow_drafts draft join bakery.workflow_definitions definition on definition.id = draft.workflow_id where definition.organization_id = ${to.organizationId}`)[
        0
      ]!;
    const step = (draft.definition as {
      steps: { skills: string[]; agentVersionId: string }[];
    }).steps[0]!;
    assertEquals(step.skills, [newSkill]);
    assertEquals(step.agentVersionId, newAgent);
    assert(newSkill !== skillVersion.id && newAgent !== agentVersion.id);
  } finally {
    await fixture.close();
    await Deno.remove(root, { recursive: true });
    // The next integration file starts from the users this file made.
    await resetDatabase();
  }
});
