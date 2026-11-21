import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assertRetained,
  retentionFixture,
} from "../helpers/artifact-retention.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import {
  findCachedExtract,
  storeCachedExtract,
} from "../../apps/server/src/modules/knowledge/extract-cache.ts";
import { CONTEXT_EXTRACTOR_VERSION } from "../../apps/server/src/modules/knowledge/context-projection.ts";
import { statfs } from "node:fs/promises";
import { StandardError } from "../../packages/contracts/src/http.ts";

Deno.test("expired current pointer on terminal task remains discoverable as a tombstone", async () => {
  const fixture = await retentionFixture();
  try {
    const current = () =>
      fixture.pgDatabase.query(
        "select a.current_version_id,t.status from bakery.artifacts a join bakery.tasks t on t.id=a.task_id where a.id=$1",
        [fixture.artifactId],
      );
    assertEquals((await current()).rows[0], {
      current_version_id: fixture.versionId,
      status: "completed",
    });
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      true,
    );
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      false,
    );
    assertEquals((await current()).rows[0], {
      current_version_id: fixture.versionId,
      status: "completed",
    });
    for (const suffix of ["content", "extract"]) {
      const response = await fixture.request(
        `/v1/artifact-versions/${fixture.versionId}/${suffix}`,
      );
      assertEquals(response.status, 410);
      assertEquals((await response.json()).code, "ARTIFACT_CONTENT_EXPIRED");
    }
    assertEquals(
      (await fixture.request(`/v1/artifacts/${fixture.artifactId}`)).status,
      200,
    );
    assertEquals(
      (await fixture.request(`/v1/artifacts/${fixture.artifactId}/versions`))
        .status,
      200,
    );
    const rows = await fixture.pgDatabase.query(
      "select sha256,size_bytes,purge_policy,content from bakery.artifact_versions where id=$1",
      [fixture.versionId],
    );
    assertEquals(rows.rows[0], {
      sha256: fixture.sha256,
      size_bytes: fixture.content.length,
      purge_policy: "retention-v1",
      content: null,
    });
    const audit = await fixture.pgDatabase.query(
      "select id from bakery.audit_events where resource_id=$1 and operation='artifactVersions.collect'",
      [fixture.versionId],
    );
    assertEquals(audit.rowCount, 1);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("pin CAS rejects stale updates and unpin warns without deleting", async () => {
  const fixture = await retentionFixture();
  try {
    const path = `/v1/artifacts/${fixture.artifactId}`;
    assertEquals((await fixture.request(path, { pinned: true })).status, 428);
    const pinned = await fixture.request(path, { pinned: true, version: 1 });
    assertEquals(pinned.status, 200);
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      false,
    );
    assertEquals(
      (await fixture.request(path, { pinned: false, version: 1 })).status,
      412,
    );
    const unpinned = await fixture.request(path, { pinned: false, version: 2 });
    assertEquals(unpinned.status, 200);
    assertEquals((await unpinned.json()).unpinEligible, true);
    await assertRetained(fixture);
  } finally {
    await fixture.closeRetention();
  }
});

for (
  const kind of [
    "active-task",
    "unexpired",
    "draft-base",
    "run-snapshot",
    "step-input",
    "step-output",
    "job-input",
    "job-checkpoint",
  ] as const
) {
  Deno.test(`collection protects ${kind}`, async () => {
    const fixture = await retentionFixture();
    try {
      const db = fixture.pgDatabase;
      const reference = JSON.stringify({
        artifactId: fixture.artifactId,
        versionId: fixture.versionId,
        sha256: fixture.sha256,
      });
      switch (kind) {
        case "active-task":
          await db.query(
            "update bakery.tasks set status='active' where id=$1",
            [fixture.job.taskId],
          );
          break;
        case "unexpired":
          await db.query(
            "update bakery.artifact_versions set expires_at=now()+interval '1 day' where id=$1",
            [fixture.versionId],
          );
          break;
        case "draft-base":
          await db.query(
            "insert into bakery.artifact_drafts(organization_id,artifact_id,task_id,epoch,base_version_id,status) values($1,$2,$3,1,$4,'active')",
            [
              fixture.organizationId,
              fixture.artifactId,
              fixture.job.taskId,
              fixture.versionId,
            ],
          );
          break;
        case "run-snapshot":
          await db.query(
            "update bakery.workflow_runs set status='active',snapshot=$2 where id=$1",
            [fixture.job.runId, reference],
          );
          break;
        case "step-input":
          await db.query(
            "update bakery.run_steps set status='active',input=$2 where id=$1",
            [fixture.job.runStepId, reference],
          );
          break;
        case "step-output":
          await db.query(
            "update bakery.run_steps set status='active',output=$2 where id=$1",
            [fixture.job.runStepId, reference],
          );
          break;
        case "job-input":
          await db.query(
            "update bakery.jobs set status='queued',input=$2 where id=$1",
            [fixture.job.jobId, reference],
          );
          break;
        case "job-checkpoint":
          await db.query(
            "update bakery.jobs set status='queued',current_checkpoints=$2 where id=$1",
            [fixture.job.jobId, reference],
          );
          break;
      }
      assertEquals(await collectArtifactVersion(db, fixture.versionId), false);
      await assertRetained(fixture);
    } finally {
      await fixture.closeRetention();
    }
  });
}

Deno.test("unknown reference tables fail closed", async () => {
  const fixture = await retentionFixture();
  try {
    await fixture.pgDatabase.query(
      "create table bakery.retention_unknown_test(version_id uuid references bakery.artifact_versions(id))",
    );
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      false,
    );
    await assertRetained(fixture);
  } finally {
    await fixture.pgDatabase.query(
      "drop table if exists bakery.retention_unknown_test",
    );
    await fixture.closeRetention();
  }
});

Deno.test("capacity pauses publication with retry hint while reads and maintenance stay available", async () => {
  const previousDirectory = Deno.env.get("BAKERY_ARTIFACT_DATA_DIRECTORY");
  const previousWarn = Deno.env.get("BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT");
  const previousPause = Deno.env.get("BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT");
  const fixture = await retentionFixture();
  try {
    Deno.env.set("BAKERY_ARTIFACT_DATA_DIRECTORY", Deno.cwd());
    Deno.env.set("BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT", "0.000001");
    Deno.env.set("BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT", "0.000002");
    const error = await assertRejects(() => fixture.publish(), StandardError);
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
    assertEquals(error.params?.retryAfterSeconds, 60);
    const storage = await fixture.request("/v1/artifact-storage");
    assertEquals(storage.status, 200);
    const projection = await storage.json();
    assertEquals(projection.state, "paused");
    assertEquals(projection.retainedBytes, fixture.content.length);
    assertEquals(
      (await fixture.request(
        `/v1/artifact-versions/${fixture.versionId}/content`,
      )).status,
      200,
    );
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      true,
    );
  } finally {
    if (previousDirectory === undefined) {
      Deno.env.delete("BAKERY_ARTIFACT_DATA_DIRECTORY");
    } else Deno.env.set("BAKERY_ARTIFACT_DATA_DIRECTORY", previousDirectory);
    if (previousWarn === undefined) {
      Deno.env.delete("BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT");
    } else Deno.env.set("BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT", previousWarn);
    if (previousPause === undefined) {
      Deno.env.delete("BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT");
    } else {Deno.env.set(
        "BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT",
        previousPause,
      );}
    await fixture.closeRetention();
  }
});

Deno.test("retention sweep reopens the write gate and clears the warning after storage pressure clears", async () => {
  const previousDirectory = Deno.env.get("BAKERY_ARTIFACT_DATA_DIRECTORY");
  const previousWarn = Deno.env.get("BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT");
  const previousPause = Deno.env.get("BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT");
  const fixture = await retentionFixture();
  try {
    const usedPercent = async () => {
      const stats = await statfs(Deno.cwd());
      return (stats.blocks - stats.bavail) / stats.blocks * 100;
    };
    // Drive the monitored filesystem into the write-pause state the same way
    // the pause test does: thresholds far below real usage.
    Deno.env.set("BAKERY_ARTIFACT_DATA_DIRECTORY", Deno.cwd());
    Deno.env.set("BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT", "0.000001");
    Deno.env.set("BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT", "0.000002");
    const error = await assertRejects(() => fixture.publish(), StandardError);
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
    assertEquals(error.params?.retryAfterSeconds, 60);
    assertEquals(
      (await (await fixture.request("/v1/artifact-storage")).json()).state,
      "paused",
    );

    // Clear the pressure the way production does: the retention maintenance
    // path tombstones the expired version and reclaims its bytes. Capacity
    // thresholds are configuration, not state, so the reclaimed-disk
    // condition is expressed by relaxing them relative to live measurements.
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      true,
    );
    assertEquals(
      (await (await fixture.request("/v1/artifact-storage")).json())
        .retainedBytes,
      0,
    );
    assertEquals(
      (await fixture.request(
        `/v1/artifact-versions/${fixture.versionId}/content`,
      ))
        .status,
      410,
    );
    const used = await usedPercent();
    Deno.env.set("BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT", `${used}`);
    Deno.env.set("BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT", `${used + 2}`);
    const warning = await (await fixture.request("/v1/artifact-storage"))
      .json();
    assertEquals(warning.state, "warning");
    const written = await fixture.publish();
    const writtenId = String(written.id);
    Deno.env.set(
      "BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT",
      `${used + 1}`,
    );
    const projection = await (await fixture.request("/v1/artifact-storage"))
      .json();
    assertEquals(projection.state, "normal");
    assertEquals(projection.retainedBytes, fixture.content.length);

    // The post-restore pin/write flow succeeds with exact accounting and a
    // pinned current version stays protected against collection.
    const path = `/v1/artifacts/${fixture.artifactId}`;
    assertEquals((await fixture.request(path, { pinned: true })).status, 428);
    assertEquals(
      (await fixture.request(path, { pinned: true, version: 1 })).status,
      412,
    );
    assertEquals(
      (await fixture.request(path, { pinned: true, version: 2 })).status,
      200,
    );
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, writtenId),
      false,
    );
    const pinnedProjection = await (
      await fixture.request("/v1/artifact-storage")
    ).json();
    assertEquals(pinnedProjection.retainedBytes, fixture.content.length);
    assertEquals(pinnedProjection.pinnedBytes, fixture.content.length);
    assertEquals(
      (await fixture.request(path, { pinned: false, version: 2 })).status,
      412,
    );
    assertEquals(
      (await fixture.request(path, { pinned: false, version: 3 })).status,
      200,
    );
    const stored = await fixture.pgDatabase.query(
      "select content is not null and purged_at is null as present from bakery.artifact_versions where id=$1",
      [written.id],
    );
    assertEquals(stored.rows[0].present, true);
  } finally {
    if (previousDirectory === undefined) {
      Deno.env.delete("BAKERY_ARTIFACT_DATA_DIRECTORY");
    } else Deno.env.set("BAKERY_ARTIFACT_DATA_DIRECTORY", previousDirectory);
    if (previousWarn === undefined) {
      Deno.env.delete("BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT");
    } else Deno.env.set("BAKERY_ARTIFACT_CAPACITY_WARN_PERCENT", previousWarn);
    if (previousPause === undefined) {
      Deno.env.delete("BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT");
    } else {
      Deno.env.set(
        "BAKERY_ARTIFACT_CAPACITY_PAUSE_PERCENT",
        previousPause,
      );
    }
    await fixture.closeRetention();
  }
});

Deno.test("import publication ignores submitted retention metadata", async () => {
  const fixture = await retentionFixture();
  try {
    const response = await fixture.publish();
    const stored = await fixture.pgDatabase.query(
      "select retention_class,round(extract(epoch from (expires_at-created_at))/86400)::int as days from bakery.artifact_versions where id=$1",
      [response.id],
    );
    assertEquals(stored.rows[0], { retention_class: "evidence", days: 180 });
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("legacy backfill derives expiry from publication and is idempotent", async () => {
  const { openDatabase, closeDatabase } = await import(
    "../../packages/persistence/src/postgres.ts"
  );
  const { readDatabaseConfig } = await import(
    "../../packages/config/src/env.ts"
  );
  const { artifactRetentionBackfill } = await import(
    "../../apps/server/src/modules/work/migrations/data/0074_artifact_retention.ts"
  );
  const fixture = await retentionFixture();
  const database = openDatabase(
    readDatabaseConfig(Deno.env.toObject(), "owner").url,
    1,
  );
  const connection = await database.reserve();
  try {
    await fixture.pgDatabase.query(
      "update bakery.artifact_versions set expires_at=null where id=$1",
      [fixture.versionId],
    );
    assertEquals(
      await artifactRetentionBackfill.run(connection, { maxBatches: 2 }),
      true,
    );
    assertEquals(
      await artifactRetentionBackfill.run(connection, { maxBatches: 1 }),
      true,
    );
    const row = await fixture.pgDatabase.query(
      "select retention_class, extract(epoch from (expires_at-created_at))::integer as seconds from bakery.artifact_versions where id=$1",
      [fixture.versionId],
    );
    assertEquals(row.rows[0], {
      retention_class: "evidence",
      seconds: 180 * 86400,
    });
  } finally {
    connection.release();
    await closeDatabase(database);
    await fixture.closeRetention();
  }
});

for (const configured of [false, true]) {
  Deno.test(
    configured
      ? "configured failed probe pauses publication and reports unavailable"
      : "unset probe permits publication and reports unmonitored",
    async () => {
      const previous = Deno.env.get("BAKERY_ARTIFACT_DATA_DIRECTORY");
      const fixture = await retentionFixture();
      try {
        if (configured) {
          Deno.env.set(
            "BAKERY_ARTIFACT_DATA_DIRECTORY",
            `${Deno.cwd()}/missing-capacity-${crypto.randomUUID()}`,
          );
        } else Deno.env.delete("BAKERY_ARTIFACT_DATA_DIRECTORY");
        const response = await fixture.request("/v1/artifact-storage");
        assertEquals(response.status, 200);
        const projection = await response.json();
        assertEquals(
          projection.state,
          configured ? "unavailable" : "unmonitored",
        );
        assertEquals(projection.totalBytes, 0);
        assertEquals(projection.retainedBytes, fixture.content.length);
        if (configured) {
          const error = await assertRejects(
            () => fixture.publish(),
            StandardError,
          );
          assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
          assertEquals(error.params?.retryAfterSeconds, 60);
        } else {
          const published = await fixture.publish();
          assertEquals(typeof published.id, "string");
          const stored = await fixture.pgDatabase.query(
            "select count(*)::integer as count from bakery.artifact_versions where artifact_id=$1",
            [fixture.artifactId],
          );
          assertEquals(stored.rows[0].count, 2);
        }
        assertEquals(
          (await fixture.request(
            `/v1/artifact-versions/${fixture.versionId}/content`,
          )).status,
          200,
        );
      } finally {
        if (previous === undefined) {
          Deno.env.delete("BAKERY_ARTIFACT_DATA_DIRECTORY");
        } else Deno.env.set("BAKERY_ARTIFACT_DATA_DIRECTORY", previous);
        await fixture.closeRetention();
      }
    },
  );
}

for (const text of ["published content", ""]) {
  Deno.test(`commitArtifactVersion persists non-null content for ${text ? "nonempty" : "empty"} publication`, async () => {
    const fixture = await retentionFixture();
    try {
      const bytes = new TextEncoder().encode(text);
      const published = await fixture.publish(bytes);
      const stored = await fixture.pgDatabase.query(
        "select encode(content,'escape') as content,size_bytes,purged_at from bakery.artifact_versions where id=$1",
        [published.id],
      );
      assertEquals(stored.rows[0], {
        content: text,
        size_bytes: bytes.length,
        purged_at: null,
      });
    } finally {
      await fixture.closeRetention();
    }
  });
}

Deno.test("purging a version deletes the extracts cached from its bytes", async () => {
  // The version row survives a purge as a tombstone, so the extract cache's
  // `on delete cascade` foreign key never fires: the purge has to delete the
  // cached copies itself, in the same transaction, or purged text stays
  // readable through the cache.
  const fixture = await retentionFixture();
  try {
    await fixture.pgDatabase.query(
      `insert into bakery.artifact_extracts
         (cache_key, organization_id, artifact_version_id, digest, start_byte,
          end_byte_exclusive, scope, extractor_version, media_type, text,
          text_bytes, max_bytes, has_more)
       values ('key-1',$1,$2,$3,0,10,'p1|org','bakery.text-window@1',
               'text/plain','cached copy',11,4096,false)`,
      [fixture.organizationId, fixture.versionId, "a".repeat(64)],
    );
    const cached = await fixture.pgDatabase.query(
      "select count(*)::int as n from bakery.artifact_extracts where artifact_version_id=$1",
      [fixture.versionId],
    );
    assertEquals(cached.rows[0]?.n, 1, "the fixture's extract must be there");

    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      true,
    );

    const after = await fixture.pgDatabase.query(
      "select count(*)::int as n from bakery.artifact_extracts where artifact_version_id=$1",
      [fixture.versionId],
    );
    assertEquals(after.rows[0]?.n, 0, "no cached copy outlives the purge");
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a cached extract is found only for its own scope, digest and request, in the real SQL", async () => {
  // The unit stand-in re-implements the lookup filters in TypeScript, so only a
  // real database can show the SQL keeps one caller's rows apart from another's.
  const fixture = await retentionFixture();
  try {
    const db = fixture.pgDatabase;
    const citation = {
      artifactId: fixture.artifactId,
      versionId: fixture.versionId,
      sha256: fixture.sha256,
      mediaType: "text/plain",
      location: { startByte: 0, endByteExclusive: 28 },
      extractorVersion: CONTEXT_EXTRACTOR_VERSION,
    };
    await storeCachedExtract(db, {
      organizationId: fixture.organizationId,
      scope: "p1|org",
      citation,
      text: "Immutable retention evidence",
      hasMore: false,
      maxBytes: 65536,
    });
    const ask = (
      over: Partial<Parameters<typeof findCachedExtract>[1]> = {},
    ) =>
      findCachedExtract(db, {
        organizationId: fixture.organizationId,
        versionId: fixture.versionId,
        sha256: fixture.sha256,
        startByte: 0,
        maxBytes: 65536,
        scope: "p1|org",
        ...over,
      });
    const own = await ask();
    assert(own !== null, "the storing scope finds its row");
    assertEquals(own.text, "Immutable retention evidence");
    assertEquals(own.citation.location?.endByteExclusive, 28);
    assertEquals(
      await ask({ scope: "p2|org" }),
      null,
      "another principal misses",
    );
    assertEquals(
      await ask({ scope: "p1|task:t1" }),
      null,
      "a narrower scope misses",
    );
    assertEquals(
      await ask({ sha256: "b".repeat(64) }),
      null,
      "another digest misses",
    );
    assertEquals(await ask({ startByte: 65536 }), null, "another chunk misses");
    assertEquals(
      await ask({ maxBytes: 10 }),
      null,
      "another window size misses",
    );
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a memory revision citing a version keeps its bytes", async () => {
  const fixture = await retentionFixture();
  try {
    const repositoryId = (
      await fixture.pgDatabase.query<{ id: string }>(
        `select id from bakery.repositories
          where organization_id=$1 limit 1`,
        [fixture.organizationId],
      )
    ).rows[0]?.id;
    assert(
      repositoryId,
      "the retention fixture must seed a repository to hang a memory on",
    );

    const memoryId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.memory_entries
         (id, organization_id, repository_id, topic, status)
       values ($1,$2,$3,'retention test','proposed')`,
      [memoryId, fixture.organizationId, repositoryId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.memory_revisions
         (organization_id, memory_id, revision, body,
          source_artifact_version_id, confidence, created_by)
       values ($1,$2,1,'Cited by a memory',$3,0.9,$4)`,
      [
        fixture.organizationId,
        memoryId,
        fixture.versionId,
        fixture.principalId,
      ],
    );

    // Sourced memory is only worth having if the source is still there to read,
    // so the citation holds the bytes for as long as the revision exists.
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      false,
    );
    await assertRetained(fixture);

    // Once nothing cites it, the version is collectable again: the check is a
    // citation test, not a blanket refusal to ever collect this table's rows.
    await fixture.pgDatabase.query(
      "delete from bakery.memory_revisions where memory_id=$1",
      [memoryId],
    );
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      true,
    );
  } finally {
    await fixture.closeRetention();
  }
});
