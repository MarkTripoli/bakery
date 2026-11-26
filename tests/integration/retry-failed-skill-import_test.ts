import { assertEquals, assertNotEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { failSkillImportExecution } from "../../apps/server/src/modules/catalog/import-persistence.ts";
import { executeSkillImport } from "../../apps/server/src/modules/catalog/import-workflow.ts";
import type { SkillImportCheckpointBoundary } from "../../apps/server/src/modules/catalog/import-workflow.ts";
import {
  type SkillSourceAdapter,
  SkillSourceAdapterError,
  type SkillSourceProof,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
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

const etag = '"fixture-revision-1"';
const locator = "https://example.com/retry-skills.tar.gz";

type Harness = Awaited<ReturnType<typeof openHarness>>;

async function openHarness(skillSourceAdapter?: SkillSourceAdapter) {
  const root = await Deno.makeTempDir({ prefix: "bakery-import-retry-" });
  const store = new SkillFileStore(root);
  await store.initialize();
  const fixture = await openAuthFixture({
    skillFileStore: store,
    skillSourceAdapter,
  });
  const suffix = crypto.randomUUID();
  const email = `skill-retry-${suffix}@example.test`;
  const password = `SkillRetry-${suffix}`;
  await createSuperuser({
    pgDatabase: fixture.pgDatabase,
    config: fixture.config.auth!,
  }, { email, displayName: "Skill Retry Admin", password });
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
  const headers = { cookie, "Bakery-Organization-Id": organizationId };
  const sourceResponse = await fixture.app.fetch(authRequest(
    "/v1/skill-sources",
    { sourceType: "url", url: locator, name: "Retry fixture", license: "MIT" },
    { cookie, headers: { ...headers, "Idempotency-Key": `source-${suffix}` } },
  ));
  assertEquals(sourceResponse.status, 201, await sourceResponse.clone().text());
  const source = await sourceResponse.json() as { id: string };
  const admit = async (
    idempotencyKey = `import-${crypto.randomUUID()}`,
    revision = etag,
  ) => {
    const response = await fixture.app.fetch(authRequest(
      "/v1/skill-imports",
      { sourceId: source.id, revision },
      {
        cookie,
        headers: { ...headers, "Idempotency-Key": idempotencyKey },
      },
    ));
    assertEquals(response.status, 201, await response.clone().text());
    return await response.json() as { id: string; status: string };
  };
  const close = async () => {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  };
  const checkUpdate = async (skillId: string) => {
    const response = await fixture.app.fetch(authRequest(
      `/v1/skills/${skillId}/source-update`,
      undefined,
      {
        cookie,
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      },
    ));
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json() as {
      status: string;
      installedRevision: string;
      latestRevision: string | null;
      changes: { path: string; change: string }[];
    };
  };
  return {
    fixture,
    store,
    organizationId,
    source,
    admit,
    checkUpdate,
    close,
  };
}

async function workingSource(): Promise<SkillSourceAdapter> {
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
  return { fetchPinnedSource: () => Promise.resolve(proof) };
}

const unavailableSource: SkillSourceAdapter = {
  fetchPinnedSource: () =>
    Promise.reject(new SkillSourceAdapterError("SOURCE_UNAVAILABLE")),
};

async function failWithUnavailableSource(h: Harness, runId: string) {
  let thrown: unknown;
  try {
    await executeSkillImport(runId, {
      database: h.fixture.runtimePgDatabase,
      sourceAdapter: unavailableSource,
      skillFileStore: h.store,
    });
  } catch (error) {
    thrown = error;
  }
  assertEquals(
    thrown instanceof SkillSourceAdapterError ? thrown.code : thrown,
    "SOURCE_UNAVAILABLE",
  );
  await withPgTransaction(
    h.fixture.runtimePgDatabase,
    (transaction) =>
      failSkillImportExecution(transaction, runId, "SOURCE_UNAVAILABLE"),
  );
}

async function importRuns(h: Harness) {
  const result = await h.fixture.pgDatabase.query<{
    runId: string;
    state: string;
    runStatus: string;
  }>(
    `select import.run_id as "runId", import.state,
            run.status as "runStatus"
       from bakery.skill_imports as import
       join bakery.workflow_runs as run
         on run.organization_id = import.organization_id
        and run.id = import.run_id
      where import.organization_id = $1 and import.source_id = $2
      order by import.created_at, import.id`,
    [h.organizationId, h.source.id],
  );
  return result.rows;
}

Deno.test("a repeat of an import that failed on an unavailable source starts a new attempt that can succeed", async () => {
  const h = await openHarness();
  try {
    const firstKey = `import-${crypto.randomUUID()}`;
    const first = await h.admit(firstKey);
    await failWithUnavailableSource(h, first.id);
    assertEquals(await importRuns(h), [
      { runId: first.id, state: "failed", runStatus: "failed" },
    ]);

    const sameRequest = await h.admit(firstKey);
    assertEquals(sameRequest.id, first.id);

    const retry = await h.admit();
    assertNotEquals(retry.id, first.id);
    assertEquals(retry.status, "queued");
    const result = await executeSkillImport(retry.id, {
      database: h.fixture.runtimePgDatabase,
      sourceAdapter: await workingSource(),
      skillFileStore: h.store,
    });
    assertEquals(result.state, "completed");

    const replay = await h.admit();
    assertEquals(replay.id, retry.id);
    assertEquals(await importRuns(h), [
      { runId: first.id, state: "failed", runStatus: "failed" },
      { runId: retry.id, state: "completed", runStatus: "completed" },
    ]);
  } finally {
    await h.close();
  }
});

Deno.test("two concurrent repeats of a failed import start exactly one new attempt", async () => {
  const h = await openHarness();
  try {
    const first = await h.admit();
    await failWithUnavailableSource(h, first.id);

    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const sourceLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = withPgTransaction(h.fixture.pgDatabase, async (tx) => {
      await tx.query(
        `select id from bakery.skill_sources
          where organization_id = $1 and id = $2 for update`,
        [h.organizationId, h.source.id],
      );
      locked();
      await released;
    });
    await sourceLocked;
    const repeats = Promise.all([h.admit(), h.admit()]);
    const waiting = async () => {
      const result = await h.fixture.pgDatabase.query<{ waiting: string }>(
        `select count(*)::text as waiting from pg_locks
          where not granted and locktype in ('transactionid', 'tuple')`,
      );
      return Number(result.rows[0]?.waiting ?? "0");
    };
    const deadline = Date.now() + 10_000;
    while (await waiting() < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertEquals(await waiting() >= 2, true);
    release();
    await holder;
    const [a, b] = await repeats;

    assertNotEquals(a.id, first.id);
    assertEquals(b.id, a.id);
    assertEquals(await importRuns(h), [
      { runId: first.id, state: "failed", runStatus: "failed" },
      { runId: a.id, state: "queued", runStatus: "queued" },
    ]);
  } finally {
    await h.close();
  }
});

async function skillVersions(h: Harness) {
  const result = await h.fixture.pgDatabase.query<{
    revision: number;
    status: string;
  }>(
    `select version.revision, version.status
       from bakery.skill_versions as version
       join bakery.skills as skill
         on skill.organization_id = version.organization_id
        and skill.id = version.skill_id
      where skill.organization_id = $1 and skill.source_id = $2
      order by version.revision`,
    [h.organizationId, h.source.id],
  );
  return result.rows;
}

for (
  const boundary of [
    "reserved",
    "stored",
  ] satisfies SkillImportCheckpointBoundary[]
) {
  Deno.test(`an import that failed after its version was ${boundary} is retried into that one version`, async () => {
    const h = await openHarness();
    try {
      const source = await workingSource();
      const first = await h.admit();
      let thrown: unknown;
      try {
        await executeSkillImport(first.id, {
          database: h.fixture.runtimePgDatabase,
          sourceAdapter: source,
          skillFileStore: h.store,
          processHooks: {
            afterCheckpoint: (reached) => {
              if (reached === boundary) {
                throw new SkillSourceAdapterError("SOURCE_UNAVAILABLE");
              }
            },
          },
        });
      } catch (error) {
        thrown = error;
      }
      assertEquals(
        thrown instanceof SkillSourceAdapterError ? thrown.code : thrown,
        "SOURCE_UNAVAILABLE",
      );
      await withPgTransaction(
        h.fixture.runtimePgDatabase,
        (transaction) =>
          failSkillImportExecution(transaction, first.id, "SOURCE_UNAVAILABLE"),
      );
      assertEquals(await skillVersions(h), [{ revision: 1, status: "draft" }]);

      const retry = await h.admit();
      assertNotEquals(retry.id, first.id);
      const result = await executeSkillImport(retry.id, {
        database: h.fixture.runtimePgDatabase,
        sourceAdapter: source,
        skillFileStore: h.store,
      });
      assertEquals(result.state, "completed");
      assertEquals(await skillVersions(h), [
        { revision: 1, status: "published" },
      ]);
      assertEquals(await importRuns(h), [
        { runId: first.id, state: "failed", runStatus: "failed" },
        { runId: retry.id, state: "completed", runStatus: "completed" },
      ]);
    } finally {
      await h.close();
    }
  });
}

Deno.test("an import whose source drops on its second read is retried to completion", async () => {
  const h = await openHarness();
  try {
    const good = await workingSource();
    let reads = 0;
    const flaky: SkillSourceAdapter = {
      fetchPinnedSource: (request) => {
        reads += 1;
        return reads === 1
          ? good.fetchPinnedSource(request)
          : Promise.reject(new SkillSourceAdapterError("SOURCE_UNAVAILABLE"));
      },
    };
    const first = await h.admit();
    let thrown: unknown;
    try {
      await executeSkillImport(first.id, {
        database: h.fixture.runtimePgDatabase,
        sourceAdapter: flaky,
        skillFileStore: h.store,
      });
    } catch (error) {
      thrown = error;
    }
    assertEquals(reads, 2);
    assertEquals(
      thrown instanceof SkillSourceAdapterError ? thrown.code : thrown,
      "SOURCE_UNAVAILABLE",
    );
    await withPgTransaction(
      h.fixture.runtimePgDatabase,
      (transaction) =>
        failSkillImportExecution(transaction, first.id, "SOURCE_UNAVAILABLE"),
    );
    const retry = await h.admit();
    const result = await executeSkillImport(retry.id, {
      database: h.fixture.runtimePgDatabase,
      sourceAdapter: good,
      skillFileStore: h.store,
    });
    assertEquals(result.state, "completed");
    assertEquals(await skillVersions(h), [
      { revision: 1, status: "published" },
    ]);
  } finally {
    await h.close();
  }
});

const one = '"fixture-revision-1"';
const two = '"fixture-revision-2"';

async function sourceAt(
  revision: string,
  body: string,
): Promise<SkillSourceAdapter> {
  const remote = await createRemoteSkillFixture([{
    path: "SKILL.md",
    content: new TextEncoder().encode(body),
    mediaType: "text/markdown",
  }]);
  const proof: SkillSourceProof = Object.freeze({
    sourceType: "url",
    normalizedLocator: locator,
    requestedRevision: revision,
    sourceRevision: revision,
    sourceProofDigest: await fixtureSha256(remote.manifestBytes),
    normalizedPath: "",
    inventory: Object.freeze({
      manifest: remote.manifest,
      manifestBytes: remote.manifestBytes,
      files: Object.freeze(remote.files.map((file) =>
        Object.freeze({
          path: file.path,
          content: file.content,
          isExecutable: false,
        })
      )),
    }),
  });
  return { fetchPinnedSource: () => Promise.resolve(proof) };
}

async function importAt(
  h: Harness,
  revision: string,
  body: string,
  faultAfterReserve = false,
) {
  const run = await h.admit(undefined, revision);
  try {
    const result = await executeSkillImport(run.id, {
      database: h.fixture.runtimePgDatabase,
      sourceAdapter: await sourceAt(revision, body),
      skillFileStore: h.store,
      processHooks: {
        afterCheckpoint: (reached) => {
          if (faultAfterReserve && reached === "reserved") {
            throw new SkillSourceAdapterError("SOURCE_UNAVAILABLE");
          }
        },
      },
    });
    return result;
  } catch (error) {
    if (!faultAfterReserve) throw error;
    await withPgTransaction(
      h.fixture.runtimePgDatabase,
      (transaction) =>
        failSkillImportExecution(transaction, run.id, "SOURCE_UNAVAILABLE"),
    );
    return { runId: run.id, state: "failed" as const };
  }
}

async function versionsBySourceRevision(h: Harness) {
  const result = await h.fixture.pgDatabase.query<{
    id: string;
    revision: number;
    sourceRevision: string;
    status: string;
  }>(
    `select version.id, version.revision,
            version.source_revision as "sourceRevision", version.status
       from bakery.skill_versions as version
       join bakery.skills as skill
         on skill.organization_id = version.organization_id
        and skill.id = version.skill_id
      where skill.organization_id = $1 and skill.source_id = $2
      order by version.revision`,
    [h.organizationId, h.source.id],
  );
  return result.rows;
}

Deno.test("a failed revision is retried into its draft after a later revision was imported", async () => {
  const h = await openHarness();
  try {
    assertEquals((await importAt(h, one, "# one\n", true)).state, "failed");
    assertEquals((await importAt(h, two, "# two\n")).state, "completed");
    const retry = await importAt(h, one, "# one\n");
    assertEquals(retry.state, "completed");
    const versions = await versionsBySourceRevision(h);
    assertEquals(
      versions.map(({ revision, sourceRevision, status }) => ({
        revision,
        sourceRevision,
        status,
      })),
      [
        { revision: 1, sourceRevision: one, status: "published" },
        { revision: 2, sourceRevision: two, status: "published" },
      ],
    );
    assertEquals(retry.skillVersionId, versions[0]?.id);
    const again = await h.admit(undefined, one);
    assertEquals(again.id, retry.runId);
  } finally {
    await h.close();
  }
});

Deno.test("two failed revisions are each retried into their own draft", async () => {
  const h = await openHarness();
  try {
    assertEquals((await importAt(h, one, "# one\n", true)).state, "failed");
    assertEquals((await importAt(h, two, "# two\n", true)).state, "failed");
    assertEquals((await importAt(h, one, "# one\n")).state, "completed");
    assertEquals((await importAt(h, two, "# two\n")).state, "completed");
    assertEquals(
      (await versionsBySourceRevision(h)).map(({ revision, status }) => ({
        revision,
        status,
      })),
      [
        { revision: 1, status: "published" },
        { revision: 2, status: "published" },
      ],
    );
  } finally {
    await h.close();
  }
});

Deno.test("a new revision whose files did not change completes onto the existing version", async () => {
  const h = await openHarness();
  try {
    const first = await importAt(h, one, "# same\n");
    assertEquals(first.state, "completed");
    const second = await importAt(h, two, "# same\n");
    assertEquals(second.state, "completed");
    assertEquals(second.skillVersionId, first.skillVersionId);
    assertEquals(
      (await versionsBySourceRevision(h)).map(({ revision, status }) => ({
        revision,
        status,
      })),
      [{ revision: 1, status: "published" }],
    );
  } finally {
    await h.close();
  }
});

Deno.test("after an unchanged revision lands on the existing version, the update check offers only a real change", async () => {
  const live = { revision: two, body: "# same\n" };
  const checked: SkillSourceAdapter = {
    fetchPinnedSource: async (request) =>
      (await sourceAt(live.revision, live.body)).fetchPinnedSource(request),
  };
  const h = await openHarness(checked);
  try {
    const first = await importAt(h, one, "# same\n");
    const second = await importAt(h, two, "# same\n");
    assertEquals(second.skillVersionId, first.skillVersionId);
    const skill = await h.fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.skills
        where organization_id = $1 and source_id = $2`,
      [h.organizationId, h.source.id],
    );
    const skillId = skill.rows[0]?.id;
    if (!skillId) throw new Error("TEST_SKILL_MISSING");

    const unchanged = await h.checkUpdate(skillId);
    assertEquals(
      [unchanged.status, unchanged.latestRevision, unchanged.changes],
      ["current", two, []],
    );

    live.revision = '"fixture-revision-3"';
    live.body = "# changed\n";
    const changed = await h.checkUpdate(skillId);
    assertEquals(
      [
        changed.status,
        changed.latestRevision,
        changed.changes.map(({ path, change }) => ({ path, change })),
      ],
      ["update_available", live.revision, [{
        path: "SKILL.md",
        change: "changed",
      }]],
    );
  } finally {
    await h.close();
  }
});

Deno.test("importing earlier files again as a new revision makes their version active and current", async () => {
  const live = { revision: '"fixture-revision-3"', body: "# a\n" };
  const checked: SkillSourceAdapter = {
    fetchPinnedSource: async (request) =>
      (await sourceAt(live.revision, live.body)).fetchPinnedSource(request),
  };
  const h = await openHarness(checked);
  try {
    const a = await importAt(h, one, "# a\n");
    const b = await importAt(h, two, "# b\n");
    assertNotEquals(b.skillVersionId, a.skillVersionId);
    const again = await importAt(h, live.revision, "# a\n");
    assertEquals(again.state, "completed");
    assertEquals(again.skillVersionId, a.skillVersionId);
    const skill = await h.fixture.pgDatabase.query<{
      id: string;
      activeVersionId: string;
    }>(
      `select id, active_version_id as "activeVersionId" from bakery.skills
        where organization_id = $1 and source_id = $2`,
      [h.organizationId, h.source.id],
    );
    assertEquals(skill.rows[0]?.activeVersionId, a.skillVersionId);
    const events = await h.fixture.pgDatabase.query<{
      aggregateVersion: number;
      skillVersion: number;
    }>(
      `select event.aggregate_version as "aggregateVersion",
              skill.version as "skillVersion"
         from bakery.domain_events as event
         join bakery.skills as skill on skill.id = event.aggregate_id
        where event.organization_id = $1 and event.aggregate_id = $2
          and event.event_type = 'skills.updated'`,
      [h.organizationId, skill.rows[0]?.id],
    );
    assertEquals(events.rows.length, 1);
    assertEquals(
      events.rows[0]?.aggregateVersion,
      events.rows[0]?.skillVersion,
    );
    const replay = await importAt(h, live.revision, "# a\n");
    assertEquals(replay.skillVersionId, a.skillVersionId);
    assertEquals(
      (await h.fixture.pgDatabase.query(
        `select 1 from bakery.domain_events
          where organization_id = $1 and aggregate_id = $2
            and event_type = 'skills.updated'`,
        [h.organizationId, skill.rows[0]?.id],
      )).rows.length,
      1,
    );
    const check = await h.checkUpdate(skill.rows[0]!.id);
    assertEquals([check.status, check.changes], ["current", []]);
  } finally {
    await h.close();
  }
});
