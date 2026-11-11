import { assertEquals } from "@std/assert";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import {
  deriveSkillVersionId,
  skillObjectKey,
} from "../../apps/server/src/modules/catalog/identity.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import {
  assertProblem,
  makeUpload,
  openPublicationTestContext,
  sha256,
} from "../helpers/local-skill-publication.ts";
import { authTestOrigin } from "../helpers/auth.ts";

Deno.test("clean tenant creates, publishes, and reads exact local skill bytes and metadata", async () => {
  const root = await Deno.makeTempDir({
    prefix: "bakery-277-phase3-integration-",
  });
  const realStore = new SkillFileStore(root);
  let context:
    | Awaited<ReturnType<typeof openPublicationTestContext>>
    | undefined;
  const storageOperations: string[] = [];
  const openTransactions: number[] = [];
  const observe = async (operation: string) => {
    storageOperations.push(operation);
    const result = await context!.fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count
         from pg_stat_activity
        where datname = current_database()
          and usename = 'bakery_app'
          and state like '%transaction%'`,
    );
    openTransactions.push(result.rows[0].count);
  };
  const store = {
    async recover(key: string, digest: string, size: number) {
      await observe("recover");
      return await realStore.recover(key, digest, size);
    },
    async putIfAbsent(key: string, bytes: Uint8Array, digest: string) {
      await observe("put");
      return await realStore.putIfAbsent(key, bytes, digest);
    },
    async read(key: string, digest: string, size: number) {
      await observe("read");
      return await realStore.read(key, digest, size);
    },
  };
  try {
    context = await openPublicationTestContext({ root, store });
    const skill = await context.createSkill("phase3-clean-tenant");
    assertEquals(skill.activeVersionId, null);
    assertEquals(skill.enabled, true);
    assertEquals(skill.version, 1);

    const sourceBeforeResponse = await context.fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/skill-sources/${skill.sourceId}`,
        { headers: context.headers },
      ),
    );
    assertEquals(sourceBeforeResponse.status, 200);
    const sourceBefore = await sourceBeforeResponse.json();
    assertEquals(sourceBefore, {
      id: skill.sourceId,
      sourceType: "local_bundle",
      locator:
        `bakery://organizations/${context.organizationId}/skills/${skill.id}`,
      publisher: null,
      license: null,
      lastCheckedAt: null,
      enabled: true,
      createdAt: (sourceBefore as { createdAt: string }).createdAt,
      updatedAt: (sourceBefore as { updatedAt: string }).updatedAt,
      version: 1,
    });

    const skillBytes = new TextEncoder().encode("# Phase 3 skill\n");
    const referenceBytes = new TextEncoder().encode("exact reference bytes\n");
    const upload = await makeUpload([
      { path: "SKILL.md", content: skillBytes },
      { path: "references/proof.md", content: referenceBytes },
    ]);
    const publishedResponse = await context.publish(
      skill.id,
      upload,
      "phase3-publish-v1",
    );
    assertEquals(
      publishedResponse.status,
      201,
      await publishedResponse.clone().text(),
    );
    const published = await publishedResponse.json() as {
      id: string;
      skillId: string;
      revision: number;
      sourceRevision: string;
      digest: string;
      entryPath: string;
      manifest: Record<string, unknown>;
      status: string;
      createdBy: string;
      version: number;
    };
    const expectedVersionId = await deriveSkillVersionId({
      organizationId: context.organizationId,
      skillId: skill.id,
      revision: 1,
      digest: upload.digest,
    });
    assertEquals(published.id, expectedVersionId);
    assertEquals(published.skillId, skill.id);
    assertEquals(published.revision, 1);
    assertEquals(published.sourceRevision, upload.digest);
    assertEquals(published.digest, upload.digest);
    assertEquals(published.entryPath, "SKILL.md");
    assertEquals(
      published.manifest,
      JSON.parse(canonicalJson(upload.manifest)),
    );
    assertEquals(published.status, "published");
    assertEquals(published.createdBy, context.principalId);
    assertEquals(published.version, 1);
    assertEquals(openTransactions.every((count) => count === 0), true);

    const skillAfterResponse = await context.fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}`, {
        headers: context.headers,
      }),
    );
    assertEquals(skillAfterResponse.status, 200);
    const skillAfter = await skillAfterResponse.json() as {
      activeVersionId: string;
      version: number;
    };
    assertEquals(skillAfter.activeVersionId, expectedVersionId);
    assertEquals(skillAfter.version, 2);
    const sourceAfterResponse = await context.fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/skill-sources/${skill.sourceId}`,
        { headers: context.headers },
      ),
    );
    const sourceAfter = await sourceAfterResponse.json() as {
      license: string;
      publisher: null;
      lastCheckedAt: null;
      version: number;
    };
    assertEquals(sourceAfter.license, "MIT");
    assertEquals(sourceAfter.publisher, null);
    assertEquals(sourceAfter.lastCheckedAt, null);
    assertEquals(sourceAfter.version, 2);

    const metadata = await context.fixture.pgDatabase.query<{
      path: string;
      mediaType: string;
      objectKey: string;
      sizeBytes: number;
      sha256: string;
      isExecutable: boolean;
    }>(
      `select path, media_type as "mediaType", object_key as "objectKey",
              size_bytes as "sizeBytes", sha256,
              is_executable as "isExecutable"
         from bakery.skill_files
        where organization_id = $1 and skill_version_id = $2
        order by path`,
      [context.organizationId, expectedVersionId],
    );
    assertEquals(metadata.rows.length, 2);
    for (const row of metadata.rows) {
      const expected = upload.manifest.files.find(({ path }) =>
        path === row.path
      )!;
      assertEquals(row, {
        path: expected.path,
        mediaType: expected.mediaType,
        objectKey: skillObjectKey(
          context.organizationId,
          expectedVersionId,
          expected.sha256,
        ),
        sizeBytes: expected.sizeBytes,
        sha256: expected.sha256,
        isExecutable: expected.isExecutable,
      });
      const expectedBytes = row.path === "SKILL.md"
        ? skillBytes
        : referenceBytes;
      assertEquals(
        await Deno.readFile(`${root}/${row.objectKey}`),
        expectedBytes,
      );
      assertEquals(
        await realStore.read(row.objectKey, row.sha256, row.sizeBytes),
        expectedBytes,
      );
    }

    const committed = await context.fixture.pgDatabase.query<{
      versions: number;
      files: number;
      audits: number;
      events: number;
      outbox: number;
      idempotency: number;
    }>(
      `select
         (select count(*)::int from bakery.skill_versions
           where organization_id = $1 and id = $2) as versions,
         (select count(*)::int from bakery.skill_files
           where organization_id = $1 and skill_version_id = $2) as files,
         (select count(*)::int from bakery.audit_events
           where organization_id = $1 and resource_id = $2::text
             and operation = 'skillVersions.create') as audits,
         (select count(*)::int from bakery.domain_events
           where organization_id = $1 and aggregate_id = $2
             and event_type = 'skill.version_created') as events,
         (select count(*)::int from bakery.outbox as outbox
           join bakery.domain_events as event on event.id = outbox.event_id
          where outbox.organization_id = $1 and event.aggregate_id = $2) as outbox,
         (select count(*)::int from bakery.idempotency_records
           where organization_id = $1 and operation = 'skillVersions.create'
             and key = 'phase3-publish-v1') as idempotency`,
      [context.organizationId, expectedVersionId],
    );
    assertEquals(committed.rows[0], {
      versions: 1,
      files: 2,
      audits: 1,
      events: 1,
      outbox: 1,
      idempotency: 1,
    });

    const callsBeforeReplay = storageOperations.length;
    const replay = await context.publish(skill.id, upload, "phase3-publish-v1");
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals(await replay.json(), published);
    assertEquals(storageOperations.length, callsBeforeReplay);
  } finally {
    await context?.close(true);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("publication route owns the encoded, decoded, manifest, and file-count bounds", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-277-phase3-limits-" });
  let context:
    | Awaited<ReturnType<typeof openPublicationTestContext>>
    | undefined;
  try {
    context = await openPublicationTestContext({ root });
    const skill = await context.createSkill("phase3-route-limits");
    const largeBytes = new Uint8Array(1_100_000).fill(65);
    const accepted = await makeUpload([{
      path: "SKILL.md",
      content: largeBytes,
    }]);
    const acceptedBody = JSON.stringify(accepted);
    assertEquals(acceptedBody.length > 1024 * 1024, true);
    assertEquals(acceptedBody.length < 15 * 1024 * 1024, true);
    const acceptedResponse = await context.publish(
      skill.id,
      accepted,
      "phase3-over-default-limit",
    );
    assertEquals(
      acceptedResponse.status,
      201,
      await acceptedResponse.clone().text(),
    );

    const tooLargeResponse = await context.fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/skills/${skill.id}/versions`, {
        method: "POST",
        headers: {
          ...context.headers,
          "content-type": "application/json",
          "Idempotency-Key": "phase3-encoded-too-large",
        },
        body: new Uint8Array(15 * 1024 * 1024 + 1),
      }),
    );
    await assertProblem(tooLargeResponse, 413, "BODY_TOO_LARGE");

    const decodedSkill = await context.createSkill("phase3-decoded-limit");
    const decoded = await makeUpload([{
      path: "SKILL.md",
      content: new Uint8Array(),
    }]);
    decoded.files[0].contentBase64 = "A".repeat(
      4 * Math.ceil((10 * 1024 * 1024 + 1) / 3),
    );
    decoded.manifest.files[0].sizeBytes = 10 * 1024 * 1024 + 1;
    await assertProblem(
      await context.publish(
        decodedSkill.id,
        decoded,
        "phase3-decoded-too-large",
      ),
      422,
      "UNPROCESSABLE",
    );

    const manifestSkill = await context.createSkill("phase3-manifest-limit");
    const manifest = await makeUpload(
      [{ path: "SKILL.md", content: new Uint8Array() }],
      { manifestExtra: { notes: "x".repeat(262144) } },
    );
    await assertProblem(
      await context.publish(
        manifestSkill.id,
        manifest,
        "phase3-manifest-too-large",
      ),
      400,
      "MALFORMED_REQUEST",
    );

    const countSkill = await context.createSkill("phase3-count-limit");
    const count = await makeUpload(
      Array.from({ length: 257 }, (_, index) => ({
        path: `files/${index}.md`,
        content: new Uint8Array(),
      })),
    );
    await assertProblem(
      await context.publish(countSkill.id, count, "phase3-count-too-large"),
      400,
      "MALFORMED_REQUEST",
    );

    assertEquals(await sha256(largeBytes), accepted.manifest.files[0].sha256);
  } finally {
    await context?.close(true);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("publication API rejects full Unicode case-fold path collisions", async () => {
  const root = await Deno.makeTempDir({ prefix: "bakery-277-case-fold-" });
  let context:
    | Awaited<ReturnType<typeof openPublicationTestContext>>
    | undefined;
  try {
    context = await openPublicationTestContext({ root });
    const skill = await context.createSkill("phase3-unicode-case-fold");
    const upload = await makeUpload([
      { path: "ς.md", content: new TextEncoder().encode("final sigma") },
      { path: "σ.md", content: new TextEncoder().encode("sigma") },
    ]);
    await assertProblem(
      await context.publish(skill.id, upload, "phase3-unicode-case-fold"),
      422,
      "UNPROCESSABLE",
    );
  } finally {
    await context?.close(true);
    await Deno.remove(root, { recursive: true });
  }
});
