import { assertEquals, assertRejects } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { executeSkillImport } from "../../apps/server/src/modules/catalog/import-workflow.ts";
import {
  SkillSourceAdapterError,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";
import type {
  SkillSourceAdapter,
  SkillSourceFetchRequest,
  SkillSourceProof,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import { deriveSkillMdManifest } from "../../apps/server/src/modules/catalog/skill-md-manifest.ts";
import {
  authRequest,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";
import {
  createRemoteSkillFixture,
  fixtureSha256,
  type RemoteSkillFixture,
} from "../fixtures/remote-skill-source.ts";

async function openImport() {
  const root = await Deno.makeTempDir({ prefix: "bakery-import-execution-" });
  const store = new SkillFileStore(root);
  await store.initialize();
  const fixture = await openAuthFixture({ skillFileStore: store });
  const suffix = crypto.randomUUID();
  const email = `skill-execution-${suffix}@example.test`;
  const password = `SkillExecution-${suffix}`;
  const etag = '"fixture-revision-1"';
  const locator = "https://example.com/skills.tar.gz";
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Skill Execution Admin", password });
    const scope = await fixture.pgDatabase.query<{ organizationId: string }>(
      `select organization_id as "organizationId"
         from bakery.organization_memberships as membership
         join bakery.principals as principal
           on principal.id = membership.principal_id
         join public."user" as provider_user
           on provider_user.id = principal.provider_user_id
        where provider_user.email = $1`,
      [email],
    );
    const organizationId = scope.rows[0]?.organizationId;
    if (!organizationId) throw new Error("TEST_ORGANIZATION_MISSING");
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    assertEquals(signIn.status, 200);
    const cookie = sessionCookie(signIn);
    const headers = {
      cookie,
      "Bakery-Organization-Id": organizationId,
    };
    const sourceResponse = await fixture.app.fetch(authRequest(
      "/v1/skill-sources",
      { sourceType: "url", url: locator, name: "Fixture", license: "MIT" },
      {
        cookie,
        headers: { ...headers, "Idempotency-Key": `source-${suffix}` },
      },
    ));
    assertEquals(
      sourceResponse.status,
      201,
      await sourceResponse.clone().text(),
    );
    const source = await sourceResponse.json() as { id: string };
    const importResponse = await fixture.app.fetch(authRequest(
      "/v1/skill-imports",
      { sourceId: source.id, revision: etag },
      {
        cookie,
        headers: { ...headers, "Idempotency-Key": `import-${suffix}` },
      },
    ));
    assertEquals(
      importResponse.status,
      201,
      await importResponse.clone().text(),
    );
    const run = await importResponse.json() as { id: string };
    return {
      root,
      store,
      fixture,
      organizationId,
      headers,
      run,
      etag,
      locator,
      close: async () => {
        await cleanupAuthFixture(fixture.pgDatabase, [email]);
        await fixture.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}

function adapterFor(proof: SkillSourceProof) {
  const requests: SkillSourceFetchRequest[] = [];
  const sourceAdapter: SkillSourceAdapter = {
    fetchPinnedSource(request) {
      requests.push(request);
      return Promise.resolve(proof);
    },
  };
  return { requests, sourceAdapter };
}

Deno.test("Admin API import executes pinned proof through PostgreSQL and filesystem", async () => {
  const { store, fixture, organizationId, headers, run, etag, locator, close } =
    await openImport();
  try {
    const remote = await createRemoteSkillFixture();
    const proof: SkillSourceProof = Object.freeze({
      sourceType: "url",
      normalizedLocator: locator,
      requestedRevision: etag,
      sourceRevision: etag,
      sourceProofDigest: await fixtureSha256(remote.manifestBytes),
      normalizedPath: "",
      inventory: Object.freeze({
        manifest: remote.manifest,
        manifestBytes: remote.manifestBytes,
        files: Object.freeze(remote.files.map((file) =>
          Object.freeze({
            path: file.path,
            content: file.content,
            isExecutable: file.isExecutable ?? false,
          })
        )),
      }),
    });
    const { requests, sourceAdapter } = adapterFor(proof);
    const result = await executeSkillImport(run.id, {
      database: fixture.runtimePgDatabase,
      sourceAdapter,
      skillFileStore: store,
    });
    assertEquals(result.state, "completed");
    assertEquals(
      requests.map(({ expectedSourceRevision }) =>
        expectedSourceRevision ?? null
      ),
      [null, etag],
    );
    const terminalResponse = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/runs/${run.id}`,
        { headers },
      ),
    );
    assertEquals(
      terminalResponse.status,
      200,
      await terminalResponse.clone().text(),
    );
    const terminalRun = await terminalResponse.json() as {
      id: string;
      kind: string;
      status: string;
      taskId: null;
    };
    assertEquals(terminalRun.id, run.id);
    assertEquals(terminalRun.kind, "skill_import");
    assertEquals(terminalRun.status, "completed");
    assertEquals(terminalRun.taskId, null);

    const persisted = await fixture.pgDatabase.query<{
      runStatus: string;
      importState: string;
      sourceRevision: string;
      versionStatus: string;
      versionCount: string;
      fileCount: string;
      stepCount: string;
      jobCount: string;
    }>(
      `select run.status as "runStatus", import.state as "importState",
              version.source_revision as "sourceRevision",
              version.status as "versionStatus",
              (select count(*)::text from bakery.skill_versions
                where organization_id = run.organization_id
                  and skill_id = import.skill_id) as "versionCount",
              (select count(*)::text from bakery.skill_files
                where organization_id = run.organization_id
                  and skill_version_id = import.skill_version_id) as "fileCount",
              (select count(*)::text from bakery.run_steps
                where organization_id = run.organization_id
                  and run_id = run.id) as "stepCount",
              (select count(*)::text from bakery.jobs as job
                join bakery.run_steps as step on step.id = job.run_step_id
                where step.organization_id = run.organization_id
                  and step.run_id = run.id) as "jobCount"
         from bakery.workflow_runs as run
         join bakery.skill_imports as import
           on import.organization_id = run.organization_id
          and import.run_id = run.id
         join bakery.skill_versions as version
           on version.organization_id = import.organization_id
          and version.id = import.skill_version_id
        where run.organization_id = $1 and run.id = $2`,
      [organizationId, run.id],
    );
    assertEquals(persisted.rows[0], {
      runStatus: "completed",
      importState: "completed",
      sourceRevision: etag,
      versionStatus: "published",
      versionCount: "1",
      fileCount: "1",
      stepCount: "0",
      jobCount: "0",
    });
    const replay = await executeSkillImport(run.id, {
      database: fixture.runtimePgDatabase,
      sourceAdapter,
      skillFileStore: store,
    });
    assertEquals(replay.skillVersionId, result.skillVersionId);
    assertEquals(requests.length, 2);
  } finally {
    await close();
  }
});

const PLAIN_SKILL_MD = [
  "---",
  "name: pptx",
  'description: "Presentation creation, editing, and analysis. When Claude needs to work with presentations (.pptx files) for: (1) Creating new presentations"',
  "license: Proprietary. LICENSE.txt has complete terms",
  "metadata:",
  "  version: 1",
  "---",
  "",
  "# PPTX",
  "",
].join("\n");
const LONG_DESCRIPTION = "Builds apps with the Claude API. ".repeat(40).trim();

Deno.test("a SKILL.md folder with scripts and no manifest.json imports through PostgreSQL with its YAML read as written", async () => {
  const { store, fixture, organizationId, run, etag, locator, close } =
    await openImport();
  const encoder = new TextEncoder();
  try {
    const files = [
      {
        path: "SKILL.md",
        content: encoder.encode(PLAIN_SKILL_MD),
        isExecutable: false,
      },
      {
        path: "Reference/notes.md",
        content: encoder.encode("# Notes\n"),
        isExecutable: false,
      },
      {
        path: "scripts/build.py",
        content: encoder.encode("print('x')\n"),
        isExecutable: true,
      },
      {
        path: "scripts/helpers/a.sh",
        content: encoder.encode("echo a\n"),
        isExecutable: true,
      },
    ];
    const proof: SkillSourceProof = Object.freeze({
      sourceType: "url",
      normalizedLocator: locator,
      requestedRevision: etag,
      sourceRevision: etag,
      sourceProofDigest: "e".repeat(64),
      normalizedPath: "",
      inventory: Object.freeze({
        manifest: Object.freeze({}),
        manifestBytes: new Uint8Array(),
        files: Object.freeze(files.map((file) => Object.freeze(file))),
      }),
    });
    const { sourceAdapter } = adapterFor(proof);
    const result = await executeSkillImport(run.id, {
      database: fixture.runtimePgDatabase,
      sourceAdapter,
      skillFileStore: store,
    });
    assertEquals(result.state, "completed");
    const stored = await fixture.pgDatabase.query<{
      manifest: { name: string; description: string };
      paths: string[];
    }>(
      `select version.manifest,
              array(select file.path from bakery.skill_files file
                     where file.organization_id = version.organization_id
                       and file.skill_version_id = version.id
                     order by file.path collate "C") as paths
         from bakery.skill_imports import
         join bakery.skill_versions version
           on version.organization_id = import.organization_id
          and version.id = import.skill_version_id
        where import.organization_id = $1 and import.run_id = $2`,
      [organizationId, run.id],
    );
    assertEquals(stored.rows[0]?.manifest.name, "pptx");
    assertEquals(
      stored.rows[0]?.manifest.description,
      "Presentation creation, editing, and analysis. When Claude needs to work with presentations (.pptx files) for: (1) Creating new presentations",
    );
    assertEquals(stored.rows[0]?.paths, [
      "Reference/notes.md",
      "SKILL.md",
      "scripts/build.py",
      "scripts/helpers/a.sh",
    ]);
  } finally {
    await close();
  }
});

Deno.test("every refused import leaves no skill behind", async () => {
  const encoder = new TextEncoder();
  const file = (path: string, text: string) =>
    Object.freeze({ path, content: encoder.encode(text), isExecutable: false });
  const skillMd = "---\nname: s\ndescription: d\n---\n# S\n";
  const otherLicense = await createRemoteSkillFixture(undefined, {
    license: "Apache-2.0",
  });
  const stale = await createRemoteSkillFixture();
  const withManifest = (fixture: RemoteSkillFixture, content?: string) =>
    Object.freeze({
      manifest: fixture.manifest,
      manifestBytes: fixture.manifestBytes,
      files: Object.freeze(fixture.files.map((entry) =>
        Object.freeze({
          path: entry.path,
          content: content === undefined
            ? entry.content
            : encoder.encode(content),
          isExecutable: entry.isExecutable ?? false,
        })
      )),
    });
  const withoutManifest = (files: ReturnType<typeof file>[]) =>
    Object.freeze({
      manifest: Object.freeze({}),
      manifestBytes: new Uint8Array(),
      files: Object.freeze(files),
    });
  const refusals = {
    "missing folder": withoutManifest([]),
    "no SKILL.md": withoutManifest([file("README.md", "# Not a skill\n")]),
    "SKILL.md without front matter": withoutManifest([
      file("SKILL.md", "# No front matter\n"),
    ]),
    "two paths differing only by case": withoutManifest([
      file("SKILL.md", skillMd),
      file("Notes.md", "a\n"),
      file("notes.md", "b\n"),
    ]),
    "a licence other than the source's": withManifest(otherLicense),
    "a stale file hash": withManifest(stale, "# Changed after hashing\n"),
    "a lone surrogate in the description": withoutManifest([
      file("SKILL.md", '---\nname: s\ndescription: "\\ud800"\n---\n# S\n'),
    ]),
  };
  for (const [name, inventory] of Object.entries(refusals)) {
    const { store, fixture, organizationId, run, etag, locator, close } =
      await openImport();
    try {
      const { sourceAdapter } = adapterFor(Object.freeze({
        sourceType: "url",
        normalizedLocator: locator,
        requestedRevision: etag,
        sourceRevision: etag,
        sourceProofDigest: "d".repeat(64),
        normalizedPath: "",
        inventory,
      }));
      const error = await assertRejects(
        () =>
          executeSkillImport(run.id, {
            database: fixture.runtimePgDatabase,
            sourceAdapter,
            skillFileStore: store,
          }),
        SkillSourceAdapterError,
      );
      assertEquals(error.code, "SOURCE_INVALID", name);
      const skills = await fixture.pgDatabase.query(
        "select 1 from bakery.skills where organization_id = $1 and source_id is not null",
        [organizationId],
      );
      assertEquals(skills.rows.length, 0, name);
    } finally {
      await close();
    }
  }
});

Deno.test("a SKILL.md description longer than a thousand characters is kept whole", async () => {
  const manifest = await deriveSkillMdManifest([{
    path: "SKILL.md",
    content: new TextEncoder().encode(
      `---\nname: claude-api\ndescription: >\n  ${LONG_DESCRIPTION}\n---\n# Claude API\n`,
    ),
    isExecutable: false,
  }], "MIT");
  assertEquals(manifest.description, LONG_DESCRIPTION);
});
