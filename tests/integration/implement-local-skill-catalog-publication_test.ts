import { assertEquals, assertRejects } from "@std/assert";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import {
  deriveSkillVersionId,
  skillObjectKey,
} from "../../apps/server/src/modules/catalog/identity.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  validateSkillFilePersistence,
  validateSkillVersionPersistence,
} from "../../apps/server/src/modules/catalog/publication.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
  signSessionCookie,
} from "../helpers/auth.ts";
import { resolveAgentSkillBindings } from "../../apps/server/src/modules/catalog/agent-skill-bindings.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";

type Skill = {
  id: string;
  sourceId: string;
  slug: string;
  name: string;
  activeVersionId: string | null;
  activeRevision: number | null;
  enabled: boolean;
  scope: "global" | "organization" | "personal";
  ownerPrincipalId: string | null;
  copiedFromSkillId: string | null;
  copiedFromVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type SkillSource = {
  id: string;
  sourceType: string;
  locator: string;
  publisher: string | null;
  license: string | null;
  lastCheckedAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
};

Deno.test("authenticated skills.create persists an exact tenant-local identity", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `skill-catalog-${suffix}@example.test`;
  const password = `SkillCatalog-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, {
      email,
      displayName: "Skill Catalog Admin",
      password,
    });
    const scope = await fixture.pgDatabase.query<{
      organizationId: string;
      principalId: string;
    }>(
      `select membership.organization_id as "organizationId",
              membership.principal_id as "principalId"
         from bakery.organization_memberships as membership
         join bakery.principals as principal
           on principal.id = membership.principal_id
         join public."user" as provider_user
           on provider_user.id = principal.provider_user_id
        where provider_user.email = $1`,
      [email],
    );
    const { organizationId, principalId } = scope.rows[0];
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
    const create = () =>
      fixture.app.fetch(authRequest(
        "/v1/skills",
        { slug: "release-notes", name: "Release notes" },
        {
          cookie,
          headers: {
            "Bakery-Organization-Id": organizationId,
            "Idempotency-Key": "create-release-notes",
          },
        },
      ));
    const unauthenticated = await fixture.app.fetch(authRequest(
      "/v1/skills",
      { slug: "denied", name: "Denied" },
      {
        headers: {
          "Bakery-Organization-Id": organizationId,
          "Idempotency-Key": "unauthenticated-skill",
        },
      },
    ));
    assertEquals(unauthenticated.status, 401);

    const createdResponse = await create();
    assertEquals(
      createdResponse.status,
      201,
      await createdResponse.clone().text(),
    );
    const created = await createdResponse.json() as Skill;
    assertEquals(created, {
      id: created.id,
      sourceId: created.sourceId,
      slug: "release-notes",
      name: "Release notes",
      activeVersionId: null,
      activeRevision: null,
      enabled: true,
      scope: "organization",
      ownerPrincipalId: null,
      copiedFromSkillId: null,
      copiedFromVersionId: null,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      version: 1,
    });

    const replay = await create();
    assertEquals(replay.status, 201);
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals(await replay.json(), created);

    const sourceResponse = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skill-sources/${created.sourceId}`, {
        headers,
      }),
    );
    assertEquals(sourceResponse.status, 200);
    const source = await sourceResponse.json() as SkillSource;
    assertEquals(source, {
      id: created.sourceId,
      sourceType: "local_bundle",
      locator: `bakery://organizations/${organizationId}/skills/${created.id}`,
      publisher: null,
      license: null,
      lastCheckedAt: null,
      enabled: true,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      version: 1,
    });
    const sourceUpdateResponse = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skill-sources/${created.sourceId}`, {
        method: "PATCH",
        headers: {
          ...headers,
          "content-type": "application/json",
          "Idempotency-Key": "disable-release-notes-source",
          "If-Match": '"1"',
          origin: authTestOrigin,
        },
        body: JSON.stringify({ name: "Release notes source", enabled: false }),
      }),
    );
    assertEquals(
      sourceUpdateResponse.status,
      200,
      await sourceUpdateResponse.clone().text(),
    );
    const updatedSource = await sourceUpdateResponse.json() as SkillSource;
    assertEquals(updatedSource, {
      ...source,
      enabled: false,
      updatedAt: updatedSource.updatedAt,
      version: 2,
    });

    const skillsList = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills`, { headers }),
    );
    assertEquals(skillsList.status, 200);
    assertEquals(await skillsList.json(), {
      items: [created],
      nextCursor: null,
    });
    const sourcesList = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skill-sources`, { headers }),
    );
    assertEquals(sourcesList.status, 200);
    assertEquals(await sourcesList.json(), {
      items: [updatedSource],
      nextCursor: null,
    });

    const updatedResponse = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${created.id}`, {
        method: "PATCH",
        headers: {
          ...headers,
          "content-type": "application/json",
          "Idempotency-Key": "rename-release-notes",
          "If-Match": '"1"',
          origin: authTestOrigin,
        },
        body: JSON.stringify({ name: "Release notes writer", enabled: false }),
      }),
    );
    assertEquals(
      updatedResponse.status,
      200,
      await updatedResponse.clone().text(),
    );
    const updated = await updatedResponse.json() as Skill;
    assertEquals(updated.name, "Release notes writer");
    assertEquals(updated.enabled, false);
    assertEquals(updated.version, 2);

    const foreign = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${created.id}`, {
        headers: {
          cookie,
          "Bakery-Organization-Id": crypto.randomUUID(),
        },
      }),
    );
    assertEquals(foreign.status, 404);

    const facts = await fixture.pgDatabase.query<{
      skills: number;
      sources: number;
      events: number;
      audits: number;
      sourceEvents: number;
      sourceAudits: number;
      replays: number;
    }>(
      `select
         (select count(*)::int from bakery.skills
           where organization_id = $1::uuid and id = $2::uuid) as skills,
         (select count(*)::int from bakery.skill_sources
           where organization_id = $1::uuid and id = $3::uuid) as sources,
         (select count(*)::int from bakery.domain_events
           where organization_id = $1::uuid and aggregate_id = $2::uuid) as events,
         (select count(*)::int from bakery.audit_events
           where organization_id = $1::uuid and resource_id = $2::text) as audits,
         (select count(*)::int from bakery.domain_events
           where organization_id = $1::uuid and aggregate_id = $3::uuid) as "sourceEvents",
         (select count(*)::int from bakery.audit_events
           where organization_id = $1::uuid and resource_id = $3::text) as "sourceAudits",
         (select count(*)::int from bakery.idempotency_records
           where organization_id = $1::uuid and operation = 'skills.create') as replays`,
      [organizationId, created.id, created.sourceId],
    );
    assertEquals(facts.rows[0], {
      skills: 1,
      sources: 1,
      events: 2,
      audits: 2,
      sourceEvents: 1,
      sourceAudits: 1,
      replays: 1,
    });

    const secondResponse = await fixture.app.fetch(authRequest(
      "/v1/skills",
      { slug: "incident-summary", name: "Incident summary" },
      {
        cookie,
        headers: {
          "Bakery-Organization-Id": organizationId,
          "Idempotency-Key": "create-incident-summary",
        },
      },
    ));
    assertEquals(
      secondResponse.status,
      201,
      await secondResponse.clone().text(),
    );
    const second = await secondResponse.json() as Skill;
    const manifest = JSON.stringify({ schemaVersion: 1, files: [] });
    const insertVersion = async (
      skillId: string,
      revision: number,
      status: string,
      digest: string,
      entryPath = "SKILL.md",
      manifestJson = manifest,
    ) => {
      const versionId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.skill_versions (
           id, organization_id, skill_id, revision, source_revision, digest,
           entry_path, manifest, status, created_by
         ) values ($1, $2, $3, $4, $5, $5, $6, $7::jsonb, $8, $9)`,
        [
          versionId,
          organizationId,
          skillId,
          revision,
          digest,
          entryPath,
          manifestJson,
          status,
          principalId,
        ],
      );
      return versionId;
    };
    const digest = (value: number) => value.toString(16).padStart(64, "0");

    const draftVersionId = await insertVersion(
      created.id,
      1,
      "draft",
      digest(1),
    );
    const publishedVersionId = await insertVersion(
      created.id,
      2,
      "published",
      digest(2),
    );
    const retiredVersionId = await insertVersion(
      created.id,
      3,
      "retired",
      digest(3),
    );
    const foreignVersionId = await insertVersion(
      second.id,
      1,
      "published",
      digest(4),
    );
    assertEquals(
      [draftVersionId, publishedVersionId, retiredVersionId].every(Boolean),
      true,
    );

    await fixture.pgDatabase.query(
      `update bakery.skills set active_version_id = $1
        where organization_id = $2 and id = $3`,
      [publishedVersionId, organizationId, created.id],
    );
    await assertRejects(
      () =>
        fixture.pgDatabase.query(
          `update bakery.skills set active_version_id = $1
            where organization_id = $2 and id = $3`,
          [foreignVersionId, organizationId, created.id],
        ),
      Error,
      "skills_active_version_fk",
    );

    const fileDigest = digest(20);
    const objectKey = (versionId: string, sha256: string) =>
      `organizations/${organizationId}/skill-versions/${versionId}/sha256/${sha256}`;
    await fixture.pgDatabase.query(
      `insert into bakery.skill_files (
         organization_id, skill_version_id, path, media_type, object_key,
         size_bytes, sha256, is_executable
       ) values ($1, $2, 'SKILL.md', 'text/markdown', $3, 10485760, $4, false)`,
      [
        organizationId,
        publishedVersionId,
        objectKey(publishedVersionId, fileDigest),
        fileDigest,
      ],
    );

    const boundaryVersion = (overrides: Record<string, unknown> = {}) =>
      validateSkillVersionPersistence({
        id: publishedVersionId,
        organizationId,
        skillId: created.id,
        revision: 10,
        sourceRevision: digest(10),
        digest: digest(10),
        entryPath: "SKILL.md",
        manifest: { schemaVersion: 1 },
        status: "published",
        createdBy: principalId,
        ...overrides,
      });
    for (
      const overrides of [
        { status: "invalid" },
        { digest: "A".repeat(64) },
        { entryPath: `a${"b".repeat(500)}` },
        { entryPath: "../SKILL.md" },
        { manifest: { payload: "x".repeat(262144) } },
      ]
    ) {
      await assertRejects(() =>
        Promise.resolve().then(() => boundaryVersion(overrides))
      );
    }
    const boundaryFile = (overrides: Record<string, unknown> = {}) =>
      validateSkillFilePersistence({
        organizationId,
        skillVersionId: publishedVersionId,
        path: "references/file.md",
        mediaType: "text/markdown",
        objectKey: objectKey(publishedVersionId, fileDigest),
        sizeBytes: 1,
        sha256: fileDigest,
        isExecutable: false,
        ...overrides,
      });
    for (
      const overrides of [
        { path: `a${"b".repeat(500)}` },
        { sizeBytes: -1 },
        { sizeBytes: 10485761 },
        { sha256: "A".repeat(64) },
        { objectKey: "wrong/key" },
      ]
    ) {
      await assertRejects(() =>
        Promise.resolve().then(() => boundaryFile(overrides))
      );
    }

    const metadata = await fixture.pgDatabase.query<{
      statuses: string[];
      activeVersionId: string;
      fileSize: number;
    }>(
      `select
         array_agg(status order by revision) filter (
           where skill_id = $1
         ) as statuses,
         (select active_version_id from bakery.skills where id = $1)
           as "activeVersionId",
         (select size_bytes from bakery.skill_files
           where skill_version_id = $2 and path = 'SKILL.md') as "fileSize"
       from bakery.skill_versions
       where organization_id = $3`,
      [created.id, publishedVersionId, organizationId],
    );
    assertEquals(metadata.rows[0], {
      statuses: ["draft", "published", "retired"],
      activeVersionId: publishedVersionId,
      fileSize: 10485760,
    });
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

function base64(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(result);
}

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

Deno.test("authenticated local skill publication stores deterministic metadata and bytes", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-277-skill-root-" });
  const fixture = await openAuthFixture({ skillFileRoot: root });
  const suffix = crypto.randomUUID();
  const email = `skill-publication-${suffix}@example.test`;
  const password = `SkillPublication-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Skill Publication Admin", password });
    const scope = await fixture.pgDatabase.query<{ organizationId: string }>(
      `select membership.organization_id as "organizationId"
         from bakery.organization_memberships as membership
         join bakery.principals as principal on principal.id = membership.principal_id
         join public."user" as provider_user on provider_user.id = principal.provider_user_id
        where provider_user.email = $1`,
      [email],
    );
    const organizationId = scope.rows[0].organizationId;
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    const cookie = sessionCookie(signIn);
    const headers = {
      cookie,
      origin: authTestOrigin,
      "Bakery-Organization-Id": organizationId,
    };
    const create = await fixture.app.fetch(authRequest(
      "/v1/skills",
      { slug: "published-skill", name: "Published skill" },
      {
        cookie,
        headers: { ...headers, "Idempotency-Key": "create-published-skill" },
      },
    ));
    assertEquals(create.status, 201, await create.clone().text());
    const skill = await create.json() as Skill;
    const content = new TextEncoder().encode("# Published skill\\n");
    const fileSha256 = await sha256(content);
    const manifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: content.byteLength,
        sha256: fileSha256,
        isExecutable: false,
      }, {
        path: "references/copy.md",
        mediaType: "text/markdown",
        sizeBytes: content.byteLength,
        sha256: fileSha256,
        isExecutable: false,
      }],
    };
    const upload = {
      revision: 1,
      digest: await sha256(canonicalJson(manifest)),
      entryPath: "SKILL.md",
      manifest,
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        isExecutable: false,
        contentBase64: base64(content),
      }, {
        path: "references/copy.md",
        mediaType: "text/markdown",
        isExecutable: false,
        contentBase64: base64(content),
      }],
    };
    const publishRequest = () =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/skills/${skill.id}/versions`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "Idempotency-Key": "publish-v1",
          },
          body: JSON.stringify(upload),
        }),
      );
    const publishedResponse = await publishRequest();
    assertEquals(
      publishedResponse.status,
      201,
      await publishedResponse.clone().text(),
    );
    const published = await publishedResponse.json() as {
      id: string;
      digest: string;
      activeVersionId?: string;
    };
    assertEquals(published.digest, upload.digest);
    const expectedId = await deriveSkillVersionId({
      organizationId,
      skillId: skill.id,
      revision: 1,
      digest: upload.digest,
    });
    assertEquals(published.id, expectedId);
    // The skill carries the revision of its active version: the number people read as its version.
    const publishedSkill = await (await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}`, { headers }),
    )).json() as Skill;
    assertEquals(
      [publishedSkill.activeVersionId, publishedSkill.activeRevision],
      [published.id, 1],
    );
    const listed = await (await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills`, { headers }),
    )).json() as { items: Skill[] };
    assertEquals(
      listed.items.find((item) => item.id === skill.id)?.activeRevision,
      1,
    );
    const replay = await publishRequest();
    assertEquals(replay.status, 201);
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    const file = await fixture.pgDatabase.query<
      { path: string; objectKey: string; activeVersionId: string }
    >(
      `select files.path, files.object_key as "objectKey",
              skills.active_version_id as "activeVersionId"
         from bakery.skill_files as files
         join bakery.skills as skills on skills.id = $2 and skills.organization_id = $1
        where files.organization_id = $1 and files.skill_version_id = $3
        order by files.path`,
      [organizationId, skill.id, published.id],
    );
    assertEquals(file.rows.length, 2);
    assertEquals(file.rows.map(({ path }) => path), [
      "SKILL.md",
      "references/copy.md",
    ]);
    assertEquals(file.rows[0].activeVersionId, published.id);
    assertEquals(file.rows[1].activeVersionId, published.id);
    assertEquals(file.rows[0].objectKey, file.rows[1].objectKey);
    assertEquals(
      file.rows[0].objectKey,
      skillObjectKey(organizationId, published.id, fileSha256),
    );
    assertEquals(
      await Deno.readFile(`${root}/${file.rows[0].objectKey}`),
      content,
    );

    const largeContent = new Uint8Array(1_100_000).fill(65);
    const largeSha256 = await sha256(largeContent);
    const largeManifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: largeContent.byteLength,
        sha256: largeSha256,
        isExecutable: false,
      }],
    };
    const largeUpload = {
      revision: 2,
      digest: await sha256(canonicalJson(largeManifest)),
      entryPath: "SKILL.md",
      manifest: largeManifest,
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        isExecutable: false,
        contentBase64: base64(largeContent),
      }],
    };
    const largeResponse = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}/versions`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "Idempotency-Key": "publish-v2-large",
        },
        body: JSON.stringify(largeUpload),
      }),
    );
    assertEquals(
      largeResponse.status,
      201,
      await largeResponse.clone().text(),
    );
    const largeVersion = await largeResponse.json() as { id: string };
    const largeObjectKey = skillObjectKey(
      organizationId,
      largeVersion.id,
      largeSha256,
    );
    assertEquals(
      await new SkillFileStore(root).read(
        largeObjectKey,
        largeSha256,
        largeContent.byteLength,
      ),
      largeContent,
    );
    // A later published revision moves the number with the active version.
    const activeNow = await fixture.pgDatabase.query<{ revision: number }>(
      `select version.revision from bakery.skills as skill
         join bakery.skill_versions as version
           on version.id = skill.active_version_id
        where skill.id = $1`,
      [skill.id],
    );
    const afterLarge = await (await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}`, { headers }),
    )).json() as Skill;
    assertEquals(afterLarge.activeRevision, activeNow.rows[0].revision);
    const tooLargeResponse = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}/versions`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "Idempotency-Key": "publish-too-large",
        },
        body: new Uint8Array(15 * 1024 * 1024 + 1),
      }),
    );
    assertEquals(
      tooLargeResponse.status,
      413,
      await tooLargeResponse.clone().text(),
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

async function localPublicationUpload(
  content: Uint8Array,
  license = "MIT",
) {
  const fileSha256 = await sha256(content);
  const manifest = {
    schemaVersion: 1,
    license,
    entryPath: "SKILL.md",
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown",
      sizeBytes: content.byteLength,
      sha256: fileSha256,
      isExecutable: false,
    }],
  };
  return {
    revision: 1,
    digest: await sha256(canonicalJson(manifest)),
    entryPath: "SKILL.md",
    manifest,
    files: [{
      path: "SKILL.md",
      mediaType: "text/markdown",
      isExecutable: false,
      contentBase64: base64(content),
    }],
  };
}

Deno.test("publication releases its transaction before storage and rechecks revoked authority and replay", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-277-staged-root-" });
  const realStore = new SkillFileStore(root);
  const fixtureRef: {
    current?: Awaited<ReturnType<typeof openAuthFixture>>;
  } = {};
  let principalId = "";
  let revokeAtFirstStorage = false;
  let revoked = false;
  let storageCalls = 0;
  const openTransactions: number[] = [];
  const beforeStorage = async () => {
    storageCalls += 1;
    const currentFixture = fixtureRef.current;
    if (!currentFixture) throw new Error("PUBLICATION_FIXTURE_MISSING");
    const transactions = await currentFixture.pgDatabase.query<
      { count: number }
    >(
      `select count(*)::int as count
         from pg_stat_activity
        where datname = current_database()
          and usename = 'bakery_app'
          and state like '%transaction%'`,
    );
    openTransactions.push(transactions.rows[0].count);
    if (revokeAtFirstStorage && !revoked) {
      revoked = true;
      await currentFixture.pgDatabase.query(
        `update bakery.principals set disabled_at = current_timestamp
          where id = $1`,
        [principalId],
      );
    }
  };
  const instrumentedStore = {
    async recover(key: string, digest: string, size: number) {
      await beforeStorage();
      return await realStore.recover(key, digest, size);
    },
    async putIfAbsent(key: string, content: Uint8Array, digest: string) {
      await beforeStorage();
      return await realStore.putIfAbsent(key, content, digest);
    },
    async read(key: string, digest: string, size: number) {
      await beforeStorage();
      return await realStore.read(key, digest, size);
    },
    stat: (key: string) => realStore.stat(key),
  };
  const fixture = await openAuthFixture({
    skillFileRoot: root,
    skillFileStore: instrumentedStore,
  });
  fixtureRef.current = fixture;
  const suffix = crypto.randomUUID();
  const email = `skill-staged-${suffix}@example.test`;
  const password = `SkillStaged-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Skill Staged Admin", password });
    const scope = await fixture.pgDatabase.query<{
      organizationId: string;
      principalId: string;
    }>(
      `select membership.organization_id as "organizationId",
              membership.principal_id as "principalId"
         from bakery.organization_memberships as membership
         join bakery.principals as principal on principal.id = membership.principal_id
         join public."user" as provider_user on provider_user.id = principal.provider_user_id
        where provider_user.email = $1`,
      [email],
    );
    const { organizationId } = scope.rows[0];
    principalId = scope.rows[0].principalId;
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    const cookie = sessionCookie(signIn);
    const headers = {
      cookie,
      origin: authTestOrigin,
      "Bakery-Organization-Id": organizationId,
    };
    const create = await fixture.app.fetch(authRequest(
      "/v1/skills",
      { slug: "staged-publication", name: "Staged publication" },
      {
        cookie,
        headers: {
          ...headers,
          "Idempotency-Key": "create-staged-publication",
        },
      },
    ));
    assertEquals(create.status, 201, await create.clone().text());
    const skill = await create.json() as Skill;
    const upload = await localPublicationUpload(
      new TextEncoder().encode("# Staged publication\n"),
    );
    const publish = () =>
      fixture!.app.fetch(
        new Request(`${authTestOrigin}/v1/skills/${skill.id}/versions`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "Idempotency-Key": "publish-staged-v1",
          },
          body: JSON.stringify(upload),
        }),
      );

    revokeAtFirstStorage = true;
    const denied = await publish();
    assertEquals(denied.status, 403, await denied.clone().text());
    assertEquals(
      (await denied.json() as { code: string }).code,
      "AUTH_FORBIDDEN",
    );
    const deniedFacts = await fixture.pgDatabase.query<{
      versions: number;
      files: number;
      idempotency: number;
    }>(
      `select
         (select count(*)::int from bakery.skill_versions
           where organization_id = $1 and skill_id = $2) as versions,
         (select count(*)::int from bakery.skill_files
           where organization_id = $1) as files,
         (select count(*)::int from bakery.idempotency_records
           where organization_id = $1
             and operation = 'skillVersions.create'
             and key = 'publish-staged-v1') as idempotency`,
      [organizationId, skill.id],
    );
    assertEquals(deniedFacts.rows[0], {
      versions: 0,
      files: 0,
      idempotency: 0,
    });
    assertEquals(openTransactions.every((count) => count === 0), true);

    await fixture.pgDatabase.query(
      `update bakery.principals set disabled_at = null where id = $1`,
      [principalId],
    );
    revokeAtFirstStorage = false;
    const published = await publish();
    assertEquals(published.status, 201, await published.clone().text());
    const callsAfterPublish = storageCalls;
    const replay = await publish();
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals(storageCalls, callsAfterPublish);
    const committed = await fixture.pgDatabase.query<{
      versions: number;
      files: number;
      events: number;
      audits: number;
      idempotency: number;
    }>(
      `select
         (select count(*)::int from bakery.skill_versions
           where organization_id = $1 and skill_id = $2) as versions,
         (select count(*)::int from bakery.skill_files
           where organization_id = $1) as files,
         (select count(*)::int from bakery.domain_events
           where organization_id = $1 and event_type = 'skill.version_created') as events,
         (select count(*)::int from bakery.audit_events
           where organization_id = $1
             and operation = 'skillVersions.create') as audits,
         (select count(*)::int from bakery.idempotency_records
           where organization_id = $1
             and operation = 'skillVersions.create'
             and key = 'publish-staged-v1') as idempotency`,
      [organizationId, skill.id],
    );
    assertEquals(committed.rows[0], {
      versions: 1,
      files: 1,
      events: 1,
      audits: 1,
      idempotency: 1,
    });
  } finally {
    if (principalId) {
      await fixture.pgDatabase.query(
        `update bakery.principals set disabled_at = null where id = $1`,
        [principalId],
      ).catch(() => undefined);
    }
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("publication locks and rechecks source license before metadata commit", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-277-license-root-" });
  const realStore = new SkillFileStore(root);
  const fixtureRef: {
    current?: Awaited<ReturnType<typeof openAuthFixture>>;
  } = {};
  let sourceId = "";
  let changed = false;
  const racingStore = {
    async recover(key: string, digest: string, size: number) {
      if (!changed) {
        changed = true;
        const currentFixture = fixtureRef.current;
        if (!currentFixture) throw new Error("PUBLICATION_FIXTURE_MISSING");
        await currentFixture.pgDatabase.query(
          `update bakery.skill_sources set license = 'Apache-2.0'
            where id = $1`,
          [sourceId],
        );
      }
      return await realStore.recover(key, digest, size);
    },
    putIfAbsent: realStore.putIfAbsent.bind(realStore),
    read: realStore.read.bind(realStore),
    stat: realStore.stat.bind(realStore),
  };
  const fixture = await openAuthFixture({
    skillFileRoot: root,
    skillFileStore: racingStore,
  });
  fixtureRef.current = fixture;
  const suffix = crypto.randomUUID();
  const email = `skill-license-${suffix}@example.test`;
  const password = `SkillLicense-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Skill License Admin", password });
    const scope = await fixture.pgDatabase.query<{ organizationId: string }>(
      `select membership.organization_id as "organizationId"
         from bakery.organization_memberships as membership
         join bakery.principals as principal on principal.id = membership.principal_id
         join public."user" as provider_user on provider_user.id = principal.provider_user_id
        where provider_user.email = $1`,
      [email],
    );
    const organizationId = scope.rows[0].organizationId;
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    const cookie = sessionCookie(signIn);
    const headers = {
      cookie,
      origin: authTestOrigin,
      "Bakery-Organization-Id": organizationId,
    };
    const create = await fixture.app.fetch(authRequest(
      "/v1/skills",
      { slug: "license-race", name: "License race" },
      {
        cookie,
        headers: { ...headers, "Idempotency-Key": "create-license-race" },
      },
    ));
    assertEquals(create.status, 201, await create.clone().text());
    const skill = await create.json() as Skill;
    sourceId = skill.sourceId;
    const upload = await localPublicationUpload(
      new TextEncoder().encode("# License race\n"),
    );
    const response = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}/versions`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "Idempotency-Key": "publish-license-race",
        },
        body: JSON.stringify(upload),
      }),
    );
    assertEquals(response.status, 409, await response.clone().text());
    assertEquals(
      (await response.json() as { code: string }).code,
      "STATE_CONFLICT",
    );
    const facts = await fixture.pgDatabase.query<{
      license: string;
      activeVersionId: string | null;
      versions: number;
      files: number;
      idempotency: number;
    }>(
      `select source.license,
              skill.active_version_id as "activeVersionId",
              (select count(*)::int from bakery.skill_versions
                where organization_id = $1 and skill_id = $2) as versions,
              (select count(*)::int from bakery.skill_files
                where organization_id = $1) as files,
              (select count(*)::int from bakery.idempotency_records
                where organization_id = $1
                  and operation = 'skillVersions.create'
                  and key = 'publish-license-race') as idempotency
         from bakery.skills as skill
         join bakery.skill_sources as source
           on source.organization_id = skill.organization_id
          and source.id = skill.source_id
        where skill.organization_id = $1 and skill.id = $2`,
      [organizationId, skill.id],
    );
    assertEquals(facts.rows[0], {
      license: "Apache-2.0",
      activeVersionId: null,
      versions: 0,
      files: 0,
      idempotency: 0,
    });
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a personal skill is visible to its owner alone and never reaches an agent", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `personal-skill-a-${suffix}@example.test`;
  const otherEmail = `personal-skill-b-${suffix}@example.test`;
  const password = `PersonalSkill-${suffix}`;
  try {
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Skill Owner", password });
    const scope = await fixture.pgDatabase.query<{
      organizationId: string;
      principalId: string;
    }>(
      `select membership.organization_id as "organizationId",
              membership.principal_id as "principalId"
         from bakery.organization_memberships as membership
         join bakery.principals as principal
           on principal.id = membership.principal_id
         join public."user" as provider_user
           on provider_user.id = principal.provider_user_id
        where provider_user.email = $1`,
      [email],
    );
    const { organizationId, principalId } = scope.rows[0];
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    assertEquals(signIn.status, 200);
    const ownerCookie = sessionCookie(signIn);

    // A second member of the same organization: a Developer, not an Admin.
    const otherUserId = crypto.randomUUID();
    const otherPrincipalId = crypto.randomUUID();
    const otherToken = `personal-skill-${crypto.randomUUID()}`;
    const now = new Date();
    await fixture.pgDatabase.query(
      `insert into public."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       ) values ($1, 'Other Member', $2, true, $3, $3)`,
      [otherUserId, otherEmail, now],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
         id, provider_user_id, display_name, principal_type
       ) values ($1, $2, 'Other Member', 'human')`,
      [otherPrincipalId, otherUserId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at,
         created_at, updated_at, version
       ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
      [crypto.randomUUID(), organizationId, otherPrincipalId, now],
    );
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        otherToken,
        otherUserId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    const otherCookie = await signSessionCookie(
      otherToken,
      fixture.config.auth!.secret,
    );

    const create = (
      cookie: string,
      body: Record<string, unknown>,
      key: string,
    ) =>
      fixture.app.fetch(authRequest("/v1/skills", body, {
        cookie,
        headers: {
          "Bakery-Organization-Id": organizationId,
          "Idempotency-Key": key,
        },
      }));
    const read = (cookie: string, path: string) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          headers: { cookie, "Bakery-Organization-Id": organizationId },
        }),
      );

    const personalResponse = await create(
      ownerCookie,
      { slug: "private-notes", name: "Private notes", scope: "personal" },
      "create-private-notes",
    );
    assertEquals(
      personalResponse.status,
      201,
      await personalResponse.clone().text(),
    );
    const personal = await personalResponse.json() as Skill;
    assertEquals(personal.scope, "personal");
    assertEquals(personal.ownerPrincipalId, principalId);
    const sharedResponse = await create(
      ownerCookie,
      { slug: "shared-notes", name: "Shared notes" },
      "create-shared-notes",
    );
    assertEquals(sharedResponse.status, 201);
    const shared = await sharedResponse.json() as Skill;
    assertEquals(shared.scope, "organization");
    assertEquals(shared.ownerPrincipalId, null);

    // The owner sees both; the other member sees the shared skill only.
    const ownerList = await (await read(ownerCookie, "/v1/skills")).json() as {
      items: Skill[];
    };
    assertEquals(ownerList.items.map((item) => item.slug).sort(), [
      "private-notes",
      "shared-notes",
    ]);
    const otherList = await (await read(otherCookie, "/v1/skills")).json() as {
      items: Skill[];
    };
    assertEquals(otherList.items.map((item) => item.slug), ["shared-notes"]);
    assertEquals(
      (await read(ownerCookie, `/v1/skills/${personal.id}`)).status,
      200,
    );
    assertEquals(
      (await read(otherCookie, `/v1/skills/${personal.id}`)).status,
      404,
    );
    assertEquals(
      (await read(otherCookie, `/v1/skills/${shared.id}`)).status,
      200,
    );

    // Another member cannot change it, and cannot tell it exists.
    const foreignPatch = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${personal.id}`, {
        method: "PATCH",
        headers: {
          cookie: otherCookie,
          "Bakery-Organization-Id": organizationId,
          "content-type": "application/json",
          "Idempotency-Key": "foreign-rename",
          "If-Match": '"1"',
          origin: authTestOrigin,
        },
        body: JSON.stringify({ name: "Taken over" }),
      }),
    );
    assertEquals(foreignPatch.status, 404);

    // The same personal slug under two owners is allowed and reveals nothing.
    const otherPersonal = await create(
      otherCookie,
      { slug: "private-notes", name: "Other private notes", scope: "personal" },
      "other-private-notes",
    );
    assertEquals(
      otherPersonal.status,
      201,
      await otherPersonal.clone().text(),
    );
    // A Developer may keep a personal skill but not add an organization one,
    // and an Admin cannot act on somebody else's personal skill.
    const developerOrganization = await create(
      otherCookie,
      { slug: "developer-shared", name: "Developer shared" },
      "developer-organization-skill",
    );
    assertEquals(developerOrganization.status, 403);
    const otherPersonalSkill = await otherPersonal.json() as Skill;
    const adminPatch = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${otherPersonalSkill.id}`, {
        method: "PATCH",
        headers: {
          cookie: ownerCookie,
          "Bakery-Organization-Id": organizationId,
          "content-type": "application/json",
          "Idempotency-Key": "admin-rename-personal",
          "If-Match": '"1"',
          origin: authTestOrigin,
        },
        body: JSON.stringify({ name: "Renamed by an admin" }),
      }),
    );
    assertEquals(adminPatch.status, 404);
    // A skill that comes with Bakery is never created through the API.
    const globalResponse = await create(
      ownerCookie,
      { slug: "from-bakery", name: "From Bakery", scope: "global" },
      "create-global",
    );
    assertEquals(globalResponse.status, 403);

    // An agent is shared by the organization: it can carry the organization
    // skill and never the personal one, and the refusal is the one an absent
    // skill gets.
    const versionIds = {
      shared: `00000000-0000-8000-8000-${crypto.randomUUID().slice(-12)}`,
      personal: `00000000-0000-8000-8000-${crypto.randomUUID().slice(-12)}`,
    };
    for (
      const [skillId, versionId] of [
        [shared.id, versionIds.shared],
        [personal.id, versionIds.personal],
      ] as const
    ) {
      await fixture.pgDatabase.query(
        `insert into bakery.skill_versions (
           id, organization_id, skill_id, revision, source_revision, digest,
           entry_path, manifest, status, created_by
         ) values ($1, $2, $3, 1, 'rev-1', $4, 'SKILL.md', '{}'::jsonb,
                   'published', $5)`,
        [
          versionId,
          organizationId,
          skillId,
          `sha256:${"a".repeat(64)}`,
          principalId,
        ],
      );
    }
    const pins = await withPgTransaction(
      fixture.pgDatabase,
      (transaction) =>
        resolveAgentSkillBindings(transaction, organizationId, {
          notes: versionIds.shared,
        }),
    );
    assertEquals(pins.map((pin) => pin.versionId), [versionIds.shared]);
    const refused = await assertRejects(() =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          resolveAgentSkillBindings(transaction, organizationId, {
            notes: versionIds.personal,
          }),
      )
    );
    const absent = await assertRejects(() =>
      withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          resolveAgentSkillBindings(transaction, organizationId, {
            notes: `00000000-0000-8000-8000-${crypto.randomUUID().slice(-12)}`,
          }),
      )
    );
    assertEquals(
      JSON.stringify((refused as { params?: unknown }).params),
      JSON.stringify((absent as { params?: unknown }).params),
    );
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email, otherEmail]);
    await fixture.close();
  }
});
