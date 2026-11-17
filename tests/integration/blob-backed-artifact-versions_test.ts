import { assertEquals, assertRejects } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { commitArtifactVersion } from "../../apps/server/src/modules/knowledge/persistence.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { ScopedOrganizationBlobStore } from "../../apps/server/src/modules/catalog/blob-store.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
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

function publish(
  fixture: WorkerFixture,
  seeded: { taskId: string; artifactId: string; versionId: string },
  content: Uint8Array,
  blobStore?: OrganizationBlobStore,
) {
  return withPgTransaction(
    fixture.pgDatabase,
    async (transaction) =>
      await commitArtifactVersion(transaction, {
        ...(blobStore ? { blobStore } : {}),
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
          sha256: await sha256Bytes(content),
          mediaType: "text/plain",
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

    const published = await publish(fixture, seeded, content, store);

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
      new ScopedOrganizationBlobStore(store),
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
      new ScopedOrganizationBlobStore(store),
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
      new ScopedOrganizationBlobStore(store),
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
      new ScopedOrganizationBlobStore(store),
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
      new ScopedOrganizationBlobStore(store),
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
      new ScopedOrganizationBlobStore(store),
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
