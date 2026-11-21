import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { commitArtifactVersion } from "../../apps/server/src/modules/knowledge/persistence.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { ScopedOrganizationBlobStore } from "../../apps/server/src/modules/catalog/blob-store.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import {
  collectBlob,
  sweepCollectableBlobs,
} from "../../apps/server/src/modules/knowledge/collect-blob.ts";
import type { OrganizationBlobStore } from "../../apps/server/src/modules/catalog/storage-port.ts";
import type { SkillObjectStore } from "../../apps/server/src/modules/catalog/storage-port.ts";

/**
 * An in-memory object store, keyed the way the real one is.
 *
 * The key shape is the point: `organizations/{org}/blobs/sha256/{digest}`. A
 * test that keyed by anything else would not notice a store that put one
 * organization's bytes where another organization reads.
 */
function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  const key = (organizationId: string, sha256: string) =>
    `organizations/${organizationId}/blobs/sha256/${sha256}`;
  const store: OrganizationBlobStore = {
    putIfAbsent(organizationId, sha256, content) {
      const address = key(organizationId, sha256);
      if (!objects.has(address)) objects.set(address, content);
      return Promise.resolve();
    },
    read(organizationId, sha256, expectedSize) {
      const found = objects.get(key(organizationId, sha256));
      if (!found) return Promise.reject(new Error("missing object"));
      assertEquals(found.byteLength, expectedSize);
      return Promise.resolve(found);
    },
    stat(organizationId, sha256) {
      const found = objects.get(key(organizationId, sha256));
      return Promise.resolve(
        found === undefined ? null : { sizeBytes: found.byteLength },
      );
    },
    recover() {
      return Promise.resolve();
    },
  };
  return { store, objects, key };
}

/** An artifact with one inline version, ready to publish a second. */
async function seedArtifact(fixture: WorkerFixture) {
  const applicationId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1::uuid, $2, $1::text, 'Blob version')`,
    [applicationId, fixture.organizationId],
  );
  const conversation = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.conversations
       (organization_id, application_id, title, created_by)
     values ($1, $2, 'blob version', $3) returning id`,
    [fixture.organizationId, applicationId, fixture.principalId],
  );
  const task = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.tasks
       (organization_id, application_id, conversation_id, title, task_type,
        status, created_by)
     values ($1, $2, $3, 'blob version', 'feature', 'completed', $4)
     returning id`,
    [
      fixture.organizationId,
      applicationId,
      conversation.rows[0].id,
      fixture.principalId,
    ],
  );
  const taskId = task.rows[0].id;
  const artifact = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifacts
       (organization_id, task_id, artifact_type, name)
     values ($1, $2, 'plan', 'Blob version') returning id`,
    [fixture.organizationId, taskId],
  );
  const artifactId = artifact.rows[0].id;
  const first = new TextEncoder().encode("first version");
  const firstDigest = await sha256Bytes(first);
  const version = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifact_versions
       (organization_id, artifact_id, task_id, revision, author_id, metadata,
        content, sha256, size_bytes, media_type, retention_class)
     values ($1, $2, $3, 1, $4, '{}'::jsonb, $5, $6, $7, 'text/plain',
             'transient')
     returning id`,
    [
      fixture.organizationId,
      artifactId,
      taskId,
      fixture.principalId,
      first,
      firstDigest,
      first.byteLength,
    ],
  );
  const versionId = version.rows[0].id;
  await fixture.pgDatabase.query(
    `update bakery.artifacts
        set current_version_id = $1, revision = 2
      where organization_id = $2 and id = $3`,
    [versionId, fixture.organizationId, artifactId],
  );
  return { taskId, artifactId, versionId };
}

/**
 * Publishes one document onto the artifact's current version.
 *
 * The parent is read from the artifact rather than assumed: a second
 * publication in the same test would otherwise claim the revision the first
 * one already took, and the unique index would refuse it for a reason that has
 * nothing to do with what the test is about.
 *
 * `mediaType` is a parameter because a kind's rules judge the declared type:
 * a helper that always said `text/plain` would make a markdown-only kind refuse
 * the very document a test meant to be accepted.
 */
async function publish(
  fixture: WorkerFixture,
  seeded: { taskId: string; artifactId: string; versionId: string },
  content: Uint8Array,
  options: {
    readonly blobStore?: OrganizationBlobStore;
    readonly mediaType?: string;
  } = {},
) {
  const current = await fixture.pgDatabase.query<{
    revision: number;
    version: number;
    current_version_id: string;
  }>(
    `select revision, version, current_version_id from bakery.artifacts
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, seeded.artifactId],
  );
  const parent = current.rows[0];
  return await withPgTransaction(
    fixture.pgDatabase,
    async (transaction) =>
      await commitArtifactVersion(transaction, {
        ...(options.blobStore ? { blobStore: options.blobStore } : {}),
        scope: {
          organizationId: fixture.organizationId,
          taskId: seeded.taskId,
          applicationId: crypto.randomUUID(),
          repositoryId: null,
          conversationId: null,
        },
        parent: {
          id: seeded.artifactId,
          revision: parent.revision,
          version: parent.version,
          currentVersionId: parent.current_version_id,
        },
        version: {
          parentVersionId: `"${parent.current_version_id}"`,
          runStepId: null,
          authorId: fixture.principalId,
          subjectHeadSha: null,
          subjectBaseSha: null,
          stepKey: null,
          metadata: {},
          content,
          sha256: await sha256Bytes(content),
          mediaType: options.mediaType ?? "text/plain",
        },
        promotion: { kind: "human" },
      }),
  );
}

Deno.test("a version written with a store names a blob and carries no bytes", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const { store, objects, key } = memoryStore();
    const content = new TextEncoder().encode("stored in the object store");
    const digest = await sha256Bytes(content);

    const published = await publish(fixture, seeded, content, {
      blobStore: store,
    });

    const row = await fixture.pgDatabase.query<{
      content: Uint8Array | null;
      blob_id: string | null;
      sha256: string;
    }>(
      `select content, blob_id, sha256 from bakery.artifact_versions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );
    assertEquals(row.rows[0].content, null);
    assertEquals(row.rows[0].blob_id !== null, true);
    assertEquals(row.rows[0].sha256, digest);
    // The bytes are under the digest address, in this organization's segment.
    assertEquals(objects.get(key(fixture.organizationId, digest)), content);
  });
});

Deno.test("a version written without a store keeps its bytes inline", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const content = new TextEncoder().encode("stored inline as before");

    const published = await publish(fixture, seeded, content);

    const row = await fixture.pgDatabase.query<{
      content: Uint8Array | null;
      blob_id: string | null;
    }>(
      `select content, blob_id from bakery.artifact_versions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );
    assertEquals(row.rows[0].blob_id, null);
    // The driver hands back a Buffer; compare the bytes, not the container.
    assertEquals(Array.from(row.rows[0].content ?? []), Array.from(content));
  });
});

Deno.test("a version whose bytes do not match its digest is refused before anything is written", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const { store, objects } = memoryStore();
    const content = new TextEncoder().encode("the real bytes");
    const lie = await sha256Bytes(new TextEncoder().encode("other bytes"));

    const refused = await assertRejects(
      () =>
        withPgTransaction(
          fixture.pgDatabase,
          async (transaction) =>
            await commitArtifactVersion(transaction, {
              blobStore: store,
              scope: {
                organizationId: fixture.organizationId,
                taskId: seeded.taskId,
                applicationId: crypto.randomUUID(),
                repositoryId: null,
                conversationId: null,
              },
              parent: {
                id: seeded.artifactId,
                revision: 2,
                version: 1,
                currentVersionId: seeded.versionId,
              },
              version: {
                parentVersionId: `"${seeded.versionId}"`,
                runStepId: null,
                authorId: fixture.principalId,
                subjectHeadSha: null,
                subjectBaseSha: null,
                stepKey: null,
                metadata: {},
                content,
                sha256: lie,
                mediaType: "text/plain",
              },
              promotion: { kind: "human" },
            }),
        ),
      StandardError,
    );
    assertEquals((refused as StandardError).code, "INTERNAL");
    // Nothing reached the store: the check runs before the put, so a refused
    // version cannot leave bytes at an address a later honest write resolves to.
    assertEquals(objects.size, 0);
  });
});

Deno.test("a version never ends up with two homes for its bytes", async () => {
  const store = objectStore();
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const content = new TextEncoder().encode("one home only");
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    ) as { id: string };

    // The write path sets exactly one of the two columns. There is no CHECK
    // constraint behind this - the PostgreSQL boundary rail refuses them in new
    // migrations - so this test is the thing that would fail if the write path
    // ever set both, and it is the only thing that would.
    const row = await fixture.pgDatabase.query<{
      content: Uint8Array | null;
      blob_id: string | null;
    }>(
      `select content, blob_id from bakery.artifact_versions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );
    const homes = [row.rows[0].content, row.rows[0].blob_id].filter(
      (home) => home !== null,
    );
    assertEquals(homes.length, 1);
  }, { skillFileStore: store });
});

/**
 * The shipped object-store adapter, in memory.
 *
 * The read path goes through `ScopedOrganizationBlobStore`, so the assertion
 * that matters is that a version written through the real adapter reads back
 * through the real adapter - a stub on either side would prove nothing about
 * the key the server actually builds.
 */
function objectStore(): SkillObjectStore & {
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async putIfAbsent(objectKey, content, expectedSha256) {
      if (await sha256Bytes(content) !== expectedSha256) {
        throw new Error("SKILL_FILE_DIGEST_MISMATCH");
      }
      if (!objects.has(objectKey)) objects.set(objectKey, content.slice());
    },
    async read(objectKey, expectedSha256, expectedSize) {
      const found = objects.get(objectKey);
      if (!found) throw new Error("SKILL_FILE_NOT_FOUND");
      if (found.byteLength !== expectedSize) {
        throw new Error("SKILL_FILE_SIZE_MISMATCH");
      }
      if (await sha256Bytes(found) !== expectedSha256) {
        throw new Error("SKILL_FILE_DIGEST_MISMATCH");
      }
      return found;
    },
    async recover(objectKey, expectedSha256, expectedSize) {
      const found = objects.get(objectKey);
      if (!found) throw new Error("SKILL_FILE_NOT_FOUND");
      if (found.byteLength !== expectedSize) {
        throw new Error("SKILL_FILE_SIZE_MISMATCH");
      }
      if (await sha256Bytes(found) !== expectedSha256) {
        throw new Error("SKILL_FILE_DIGEST_MISMATCH");
      }
    },
    stat(objectKey: string) {
      const found = objects.get(objectKey);
      return Promise.resolve(
        found === undefined ? null : { sizeBytes: found.byteLength },
      );
    },
    delete(objectKey) {
      return Promise.resolve(objects.delete(objectKey));
    },
    async *list() {
      for (const [objectKey, content] of objects) {
        yield {
          objectKey,
          sha256: await sha256Bytes(content),
          sizeBytes: content.byteLength,
        };
      }
    },
  };
}

Deno.test("a blob-backed version serves its bytes through the content route", async () => {
  const store = objectStore();
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const content = new TextEncoder().encode("served from the object store");
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    ) as { id: string };

    const response = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${published.id}/content`,
        {
          headers: {
            cookie: fixture.adminCookie,
            "bakery-organization-id": fixture.organizationId,
          },
        },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      Array.from(content),
    );
  }, { skillFileStore: store });
});

Deno.test("a range over a blob-backed version is served under the ceiling", async () => {
  const store = objectStore();
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const content = new TextEncoder().encode("0123456789abcdef");
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    ) as { id: string };

    const response = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${published.id}/content`,
        {
          headers: {
            cookie: fixture.adminCookie,
            "bakery-organization-id": fixture.organizationId,
            range: "bytes=4-7",
          },
        },
      ),
    );
    assertEquals(response.status, 206);
    assertEquals(
      new TextDecoder().decode(await response.arrayBuffer()),
      "4567",
    );
  }, { skillFileStore: store });
});

Deno.test("a range over a blob-backed version above the ceiling is refused, not attempted", async () => {
  const store = objectStore();
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    // One byte over the 8 MiB ceiling the read path states.
    const content = new Uint8Array(8 * 1024 * 1024 + 1);
    content[0] = 7;
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    ) as { id: string };

    const response = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${published.id}/content`,
        {
          headers: {
            cookie: fixture.adminCookie,
            "bakery-organization-id": fixture.organizationId,
            range: "bytes=0-0",
          },
        },
      ),
    );
    // Refused with a typed code rather than read whole: the point of the
    // ceiling is that the server does not discover the size by running out of
    // memory.
    assertEquals(response.status, 416);
    assertEquals((await response.json()).code, "RANGE_NOT_SATISFIABLE");
  }, { skillFileStore: store });
});

Deno.test("a blob-backed version is collectable, and collection clears both homes", async () => {
  const store = objectStore();
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const content = new TextEncoder().encode("expired and blob-backed");
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    ) as { id: string };
    // Terminal task plus a past expiry is what makes a version eligible.
    await fixture.pgDatabase.query(
      `update bakery.tasks set status = 'completed'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, seeded.taskId],
    );
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions
          set retention_class = 'transient', expires_at = now() - interval '1 hour'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );

    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, published.id),
      true,
    );

    const row = await fixture.pgDatabase.query<{
      content: Uint8Array | null;
      blob_id: string | null;
      purged_at: Date | null;
    }>(
      `select content, blob_id, purged_at from bakery.artifact_versions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );
    // Both homes cleared. Leaving blob_id set would leave a purged version
    // still naming bytes, and the blob row would never be collectable because
    // nothing would know it was unreferenced.
    assertEquals(row.rows[0].content, null);
    assertEquals(row.rows[0].blob_id, null);
    assertEquals(row.rows[0].purged_at !== null, true);
  }, { skillFileStore: store });
});

Deno.test("a purged version reads as purged, not as a broken blob version", async () => {
  const store = objectStore();
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const content = new TextEncoder().encode("purged after being blob-backed");
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    ) as { id: string };
    // The purged shape: no home for the bytes, and purged_at set. This is a
    // third legitimate state, not a malformed row - retention produces it.
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions
          set content = null, blob_id = null, purged_at = now()
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );

    const response = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${published.id}/content`,
        {
          headers: {
            cookie: fixture.adminCookie,
            "bakery-organization-id": fixture.organizationId,
          },
        },
      ),
    );
    // Exactly what a purged inline version answers today. A blob-backed version
    // that was later purged must not answer differently from one that was never
    // blob-backed: the client is told the bytes are gone, not that the server
    // is confused.
    assertEquals(response.status, 410);
    assertEquals((await response.json()).code, "ARTIFACT_CONTENT_EXPIRED");
  }, { skillFileStore: store });
});

Deno.test("a version with no home and no purge is refused by the read branch itself", async () => {
  const store = objectStore();
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const content = new TextEncoder().encode("neither home, not purged");
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    ) as { id: string };
    // Both homes null and purged_at null. Retention never produces this, so it
    // is synthetic - and it is exactly the state the read branch exists for. A
    // test that sets purged_at never reaches the branch, because the metadata
    // load refuses a purged version first; that test would pass with the branch
    // deleted, which is the defect this one replaces.
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions
          set content = null, blob_id = null, purged_at = null
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );

    const response = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${published.id}/content`,
        {
          headers: {
            cookie: fixture.adminCookie,
            "bakery-organization-id": fixture.organizationId,
          },
        },
      ),
    );
    // The branch's own refusal. Serving empty bytes here would turn a row whose
    // bytes cannot be read into a successful download of nothing.
    assertEquals(response.status, 410);
    assertEquals((await response.json()).code, "ARTIFACT_CONTENT_EXPIRED");
  }, { skillFileStore: store });
});

Deno.test("a comment anchored on a blob-backed version resolves its bytes through the store", async () => {
  const store = objectStore();
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const content = new TextEncoder().encode("line one\nline two\nline three");
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    ) as { id: string };

    // Anchoring decodes the version's bytes to place the anchor. A blob-backed
    // version has no inline content, so without the store resolution in
    // loadVersion this is refused as if the version were purged.
    const response = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${published.id}/comments`,
        {
          method: "POST",
          headers: {
            cookie: fixture.adminCookie,
            "bakery-organization-id": fixture.organizationId,
            "content-type": "application/json",
            origin: fixture.config.publicBaseUrl,
            "idempotency-key": crypto.randomUUID(),
            "if-match": '"2"',
          },
          body: JSON.stringify({
            body: "Anchored on a blob-backed version",
            anchor: {
              kind: "text",
              startLine: 1,
              endLine: 1,
              quote: "line one",
            },
          }),
        },
      ),
    );
    assertEquals(response.status, 201);
    const comment = await response.json();
    assertEquals(comment.anchor.kind, "text");
    // The comment references the version, so fixture teardown cannot delete the
    // version until the comment is gone.
    await fixture.pgDatabase.query(
      "delete from bakery.artifact_comments where organization_id = $1",
      [fixture.organizationId],
    );
  }, { skillFileStore: store });
});

Deno.test("a range of exactly the ceiling is served, one byte over is refused", async () => {
  const store = objectStore();
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    // Exactly the ceiling: the bound is `>`, not `>=`, and a test that only
    // checks one byte over would pass with an off-by-one that refuses a legal
    // request.
    const atCeiling = new Uint8Array(8 * 1024 * 1024);
    atCeiling[0] = 1;
    const served = await publish(
      fixture,
      seeded,
      atCeiling,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    ) as { id: string };

    const ok = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/artifact-versions/${served.id}/content`,
        {
          headers: {
            cookie: fixture.adminCookie,
            "bakery-organization-id": fixture.organizationId,
            range: "bytes=0-0",
          },
        },
      ),
    );
    assertEquals(ok.status, 206);
    assertEquals(new Uint8Array(await ok.arrayBuffer()).byteLength, 1);
  }, { skillFileStore: store });
});

// ---------------------------------------------------------------------------
// The publication door, and collection of the blobs it validates.
//
// Everything below shares the fixture above for one reason: the door and the
// collector are two answers to the same question - "which bytes is this
// artifact's document, and may they go" - and a test that seeded them
// differently could pass while the real pair disagreed.
// ---------------------------------------------------------------------------

/** Publishes a kind version for `key` and returns its id. */
async function seedKind(
  fixture: WorkerFixture,
  key: string,
  definition: Record<string, unknown>,
): Promise<string> {
  const kind = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifact_kinds (organization_id, key, created_by)
     values ($1, $2, $3) returning id`,
    [fixture.organizationId, key, fixture.principalId],
  );
  const version = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.artifact_kind_versions
       (organization_id, kind_id, revision, definition, digest, created_by)
     values ($1, $2, 1, $3, $4, $5) returning id`,
    [
      fixture.organizationId,
      kind.rows[0].id,
      JSON.stringify(definition),
      "digest-1",
      fixture.principalId,
    ],
  );
  return version.rows[0].id;
}

/** An artifact seeded by `seedArtifact` is type `plan`; a kind keyed `plan` governs it. */
const markdownOnly = {
  key: "plan",
  name: "Plan",
  description: "What a piece of work will do.",
  text: true,
  facts: [],
  rules: [{
    type: "mediaType",
    severity: "require",
    options: { mediaTypes: ["text/markdown"] },
  }],
};

Deno.test("a kind whose key matches the artifact refuses a document its rules reject", async () => {
  await withWorkerFixture(async (fixture) => {
    await seedKind(fixture, "plan", markdownOnly);
    const seeded = await seedArtifact(fixture);

    await assertRejects(
      () =>
        publish(fixture, seeded, new TextEncoder().encode("# not markdown")),
      StandardError,
    );
    // Nothing was written: a refused publication must not leave a version that
    // a `require` rule rejected, not even one the caller cannot see.
    const versions = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.artifact_versions
        where organization_id = $1 and artifact_id = $2`,
      [fixture.organizationId, seeded.artifactId],
    );
    assertEquals(versions.rows[0].count, "1");

    // The accepted document declares the type the kind requires. Without that
    // the helper's default `text/plain` would be refused too, and the first
    // assertion above would pass for the wrong reason.
    const published = await publish(
      fixture,
      seeded,
      new TextEncoder().encode("# och aye"),
      { mediaType: "text/markdown" },
    );
    assertEquals(typeof published.id, "string");
  });
});

Deno.test("the first publication pins the kind revision, and a newer one does not judge old documents", async () => {
  await withWorkerFixture(async (fixture) => {
    const firstVersion = await seedKind(fixture, "plan", {
      ...markdownOnly,
      rules: [],
    });
    const seeded = await seedArtifact(fixture);
    const first = await publish(
      fixture,
      seeded,
      new TextEncoder().encode("plain text, first binding"),
    );
    const bound = await fixture.pgDatabase.query<{ kind_version_id: string }>(
      `select kind_version_id from bakery.artifacts
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, seeded.artifactId],
    );
    assertEquals(bound.rows[0].kind_version_id, firstVersion);

    // A stricter revision appears. The artifact is already bound, so its next
    // document is judged by the revision it was first published under - a kind
    // author cannot retroactively change what an existing document must be.
    await fixture.pgDatabase.query(
      `insert into bakery.artifact_kind_versions
         (organization_id, kind_id, revision, definition, digest, created_by)
       select organization_id, kind_id, 2, $3, 'digest-2', created_by
         from bakery.artifact_kind_versions where id = $1 and organization_id = $2`,
      [firstVersion, fixture.organizationId, JSON.stringify(markdownOnly)],
    );
    const second = await publish(
      fixture,
      seeded,
      new TextEncoder().encode("still not markdown, still allowed"),
    );
    assertNotEquals(second.id, first.id);
  });
});

Deno.test("a blob-backed version is judged on the same bytes, not on a copy read back", async () => {
  await withWorkerFixture(async (fixture) => {
    // The declared type is the one the kind requires, so the refusal below is
    // about the document's content and not about a helper's default type.
    await seedKind(fixture, "plan", {
      ...markdownOnly,
      rules: [
        ...markdownOnly.rules,
        { type: "nonEmpty", severity: "require", options: {} },
      ],
    });
    const seeded = await seedArtifact(fixture);
    const store = objectStore();
    await assertRejects(
      () =>
        publish(
          fixture,
          seeded,
          new TextEncoder().encode(""),
          {
            blobStore: new ScopedOrganizationBlobStore(store),
            mediaType: "text/markdown",
          },
        ),
      StandardError,
    );
    // The refusal comes before the put: no bytes were written for a document
    // the kind refuses, so the store cannot fill with rejected content.
    assertEquals(store.objects.size, 0);
  });
});

Deno.test("a blob no live version names is collected, and one a live version names is kept", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const skillStore = objectStore();
    const objects = skillStore.objects;

    const content = new TextEncoder().encode(
      "collectable once nothing names it",
    );
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(skillStore) },
    );
    const blobId = (
      await fixture.pgDatabase.query<{ blob_id: string }>(
        `select blob_id from bakery.artifact_versions
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, published.id],
      )
    ).rows[0].blob_id;

    // A live version names it, so collection must not touch it.
    assertEquals(
      await collectBlob(fixture.pgDatabase, skillStore, {
        organizationId: fixture.organizationId,
        blobId,
      }),
      false,
    );
    assertEquals(objects.size, 1);

    // Purging the version clears the pointer, which is what makes the blob
    // collectable: counting the purged row would pin these bytes forever.
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions
          set content = null, blob_id = null, purged_at = now()
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );
    assertEquals(
      await collectBlob(fixture.pgDatabase, skillStore, {
        organizationId: fixture.organizationId,
        blobId,
      }),
      true,
    );
    assertEquals(objects.size, 0);
    const remaining = await fixture.pgDatabase.query<{ count: string }>(
      `select count(*)::text as count from bakery.blobs
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, blobId],
    );
    assertEquals(remaining.rows[0].count, "0");
  });
});

Deno.test("a completed upload is kept through a sweep until it expires, so the publish that follows still finds its bytes", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const store = objectStore();
    const content = new TextEncoder().encode("uploaded, not yet published");
    const digest = await sha256Bytes(content);

    // The upload completes: the blob row and the bytes exist and the session
    // names the row. No version names it yet - that is the next step, and the
    // gap between the two is the window a sweep must not act in.
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    );
    const blobId = (
      await fixture.pgDatabase.query<{ blob_id: string }>(
        `select blob_id from bakery.artifact_versions
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, published.id],
      )
    ).rows[0].blob_id;
    // Rewind to the moment before the publish: the version forgets the blob and
    // the session claims it, exactly as completion leaves things.
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions
          set content = null, blob_id = null, purged_at = now()
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );
    const session = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.blob_upload_sessions
         (organization_id, created_by_id, sha256, size_bytes, media_type,
          state, expires_at, completed_blob_id)
       values ($1, $2, $3, $4, 'text/markdown', 'completed',
               now() + interval '1 hour', $5)
       returning id`,
      [
        fixture.organizationId,
        fixture.principalId,
        digest,
        content.byteLength,
        blobId,
      ],
    );

    // A sweep in the gap keeps the bytes, and so does a direct collect: the
    // session's own expiry is the grace window, not a number invented here.
    const swept = await sweepCollectableBlobs(fixture.pgDatabase, store);
    assertEquals(swept.collected, 0);
    assertEquals(store.objects.size, 1);
    assertEquals(
      await collectBlob(fixture.pgDatabase, store, {
        organizationId: fixture.organizationId,
        blobId,
      }),
      false,
    );

    // Once the session expires it has given up its claim, and the same sweep
    // takes the bytes.
    await fixture.pgDatabase.query(
      `update bakery.blob_upload_sessions
          set expires_at = now() - interval '1 minute'
        where id = $1`,
      [session.rows[0].id],
    );
    const after = await sweepCollectableBlobs(fixture.pgDatabase, store);
    assertEquals(after.collected, 1);
    assertEquals(store.objects.size, 0);

    // The session outlives the blob it named, and it still belongs to its
    // organization. A composite `on delete set null` would have nulled
    // `organization_id` too and the delete would have been refused, so this row
    // is the difference between a collectable blob and a permanently pinned one.
    const survivor = await fixture.pgDatabase.query<{
      organization_id: string | null;
      completed_blob_id: string | null;
    }>(
      `select organization_id, completed_blob_id from bakery.blob_upload_sessions
        where id = $1`,
      [session.rows[0].id],
    );
    assertEquals(survivor.rows[0].organization_id, fixture.organizationId);
    assertEquals(survivor.rows[0].completed_blob_id, null);
  });
});

Deno.test("an upload still in flight keeps its bytes until it expires or is abandoned", async () => {
  await withWorkerFixture(async (fixture) => {
    const seeded = await seedArtifact(fixture);
    const store = objectStore();
    const content = new TextEncoder().encode("bytes an upload is assembling");
    const published = await publish(
      fixture,
      seeded,
      content,
      { blobStore: new ScopedOrganizationBlobStore(store) },
    );
    const blobId = (
      await fixture.pgDatabase.query<{ blob_id: string }>(
        `select blob_id from bakery.artifact_versions
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, published.id],
      )
    ).rows[0].blob_id;

    // No version names the blob, and the session holds only the digest it was
    // promised - so it can only be found by digest, which is why the registry
    // carries that shape of reference at all.
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions
          set content = null, blob_id = null, purged_at = now()
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, published.id],
    );
    const session = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.blob_upload_sessions
         (organization_id, created_by_id, sha256, size_bytes, media_type,
          state, expires_at)
       values ($1, $2, $3, $4, 'text/markdown', 'pending',
               now() + interval '1 hour')
       returning id`,
      [
        fixture.organizationId,
        fixture.principalId,
        await sha256Bytes(content),
        content.byteLength,
      ],
    );
    assertEquals(
      await collectBlob(fixture.pgDatabase, store, {
        organizationId: fixture.organizationId,
        blobId,
      }),
      false,
    );
    assertEquals(store.objects.size, 1);

    await fixture.pgDatabase.query(
      `update bakery.blob_upload_sessions
          set state = 'abandoned', expires_at = now() - interval '1 minute'
        where id = $1`,
      [session.rows[0].id],
    );
    assertEquals(
      await collectBlob(fixture.pgDatabase, store, {
        organizationId: fixture.organizationId,
        blobId,
      }),
      true,
    );
    assertEquals(store.objects.size, 0);
  });
});
