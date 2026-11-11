import { assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { executeSkillImport } from "../../apps/server/src/modules/catalog/import-workflow.ts";
import type {
  SkillSourceAdapter,
  SkillSourceFetchRequest,
  SkillSourceProof,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  authRequest,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";
import {
  createRemoteSkillFixture,
  fixtureSha256,
} from "../fixtures/remote-skill-source.ts";

Deno.test("Admin API import executes pinned proof through PostgreSQL and filesystem", async () => {
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
    const requests: SkillSourceFetchRequest[] = [];
    const sourceAdapter: SkillSourceAdapter = {
      fetchPinnedSource(request) {
        requests.push(request);
        return Promise.resolve(proof);
      },
    };
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
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});
