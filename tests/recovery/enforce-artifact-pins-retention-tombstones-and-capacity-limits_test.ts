import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assertRetained,
  retentionFixture,
} from "../helpers/artifact-retention.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import { lockRetainedArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/references.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

Deno.test("pin wins collection race under two connections", async () => {
  const fixture = await retentionFixture();
  const pin = await fixture.runtimePgDatabase.connect();
  let collecting: Promise<boolean> | undefined;
  try {
    await pin.query("begin");
    await pin.query("select id from bakery.artifacts where id=$1 for update", [
      fixture.artifactId,
    ]);
    await pin.query(
      "update bakery.artifacts set pinned_at=now(),pinned_by=$2 where id=$1",
      [fixture.artifactId, fixture.principalId],
    );
    collecting = collectArtifactVersion(fixture.pgDatabase, fixture.versionId);
    const backend = await pin.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      const blockers = await fixture.pgDatabase.query(
        "select 1 from pg_stat_activity where $1::integer=any(pg_blocking_pids(pid))",
        [backend.rows[0].pid],
      );
      if (blockers.rowCount) {
        waiting = true;
        break;
      }
    }
    assert(
      waiting,
      "Collector must reach the held parent lock before pin commits",
    );
    await pin.query("commit");
    assertEquals(await collecting, false);
    await assertRetained(fixture);
  } finally {
    await pin.query("rollback");
    pin.release();
    await collecting;
    await fixture.closeRetention();
  }
});

Deno.test("draft writer inserts after collector waits without deadlock and protects bytes", async () => {
  const fixture = await retentionFixture();
  const reference = await fixture.runtimePgDatabase.connect();
  let collecting: Promise<boolean> | undefined;
  try {
    await reference.query("begin");
    await lockRetainedArtifactVersion(
      reference,
      fixture.organizationId,
      fixture.artifactId,
      fixture.versionId,
    );
    collecting = collectArtifactVersion(fixture.pgDatabase, fixture.versionId);
    const backend = await reference.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      const blockers = await fixture.pgDatabase.query(
        "select 1 from pg_stat_activity where $1::integer=any(pg_blocking_pids(pid))",
        [backend.rows[0].pid],
      );
      if (blockers.rowCount) {
        waiting = true;
        break;
      }
    }
    assert(waiting);
    await reference.query(
      "insert into bakery.artifact_drafts(organization_id,artifact_id,task_id,epoch,base_version_id,status) values($1,$2,$3,1,$4,'active')",
      [
        fixture.organizationId,
        fixture.artifactId,
        fixture.job.taskId,
        fixture.versionId,
      ],
    );
    await reference.query("commit");
    assertEquals(await collecting, false);
    await assertRetained(fixture);
    await fixture.pgDatabase.query(
      "update bakery.artifact_drafts set status='closed' where artifact_id=$1",
      [fixture.artifactId],
    );
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      true,
    );
    const error = await assertRejects(
      () =>
        withPgTransaction(
          fixture.runtimePgDatabase,
          (tx) =>
            lockRetainedArtifactVersion(
              tx,
              fixture.organizationId,
              fixture.artifactId,
              fixture.versionId,
            ),
        ),
      StandardError,
    );
    assertEquals(error.code, "ARTIFACT_CONTENT_EXPIRED");
    const draft = await fixture.pgDatabase.query(
      "select base_version_id from bakery.artifact_drafts where artifact_id=$1",
      [fixture.artifactId],
    );
    assertEquals(draft.rows[0].base_version_id, fixture.versionId);
  } finally {
    await reference.query("rollback");
    reference.release();
    await collecting;
    await fixture.closeRetention();
  }
});

Deno.test("audit failure rolls back byte collection", async () => {
  const fixture = await retentionFixture();
  try {
    await fixture.pgDatabase.query(
      "alter table bakery.audit_events rename to retention_unavailable_audit",
    );
    try {
      await assertRejects(() =>
        collectArtifactVersion(fixture.pgDatabase, fixture.versionId)
      );
      await assertRetained(fixture);
    } finally {
      await fixture.pgDatabase.query(
        "alter table bakery.retention_unavailable_audit rename to audit_events",
      );
    }
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("collector lock timeout is retryable and leaves bytes intact", async () => {
  const fixture = await retentionFixture();
  const writer = await fixture.runtimePgDatabase.connect();
  try {
    await writer.query("begin");
    await writer.query(
      "select id from bakery.artifacts where id=$1 for update",
      [fixture.artifactId],
    );
    const error = await assertRejects(
      () => collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      StandardError,
    );
    assertEquals(error.code, "DEPENDENCY_UNAVAILABLE");
    assertEquals(error.params?.retryAfterSeconds, 60);
    await assertRetained(fixture);
    await writer.query("commit");
    assertEquals(
      await collectArtifactVersion(fixture.pgDatabase, fixture.versionId),
      true,
    );
  } finally {
    await writer.query("rollback");
    writer.release();
    await fixture.closeRetention();
  }
});
