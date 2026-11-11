import {
  closeWorkerScope,
  createWorkerScope,
} from "../helpers/worker-execution.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assertRetained,
  retentionFixture,
} from "../helpers/artifact-retention.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

Deno.test("runtime cannot clear content, set purge state, or invoke owner collector", async () => {
  const fixture = await retentionFixture();
  try {
    for (
      const sql of [
        "update bakery.artifact_versions set content=null where id=$1",
        "update bakery.artifact_versions set purged_at=now() where id=$1",
      ]
    ) {
      const error = await assertRejects(() =>
        fixture.runtimePgDatabase.query(sql, [fixture.versionId])
      );
      assert(error instanceof Error);
      assertEquals(Reflect.get(error, "code"), "42501");
    }
    const denied = await assertRejects(
      () =>
        collectArtifactVersion(fixture.runtimePgDatabase, fixture.versionId),
      StandardError,
    );
    assertEquals(denied.code, "AUTH_FORBIDDEN");
    await assertRetained(fixture);
  } finally {
    await fixture.closeRetention();
  }
});
Deno.test("developer cannot pin artifacts or read installation capacity", async () => {
  const fixture = await retentionFixture();
  try {
    await fixture.pgDatabase.query(
      "update bakery.organization_memberships set role='developer' where organization_id=$1 and principal_id=$2",
      [fixture.organizationId, fixture.principalId],
    );
    assertEquals(
      (await fixture.request(`/v1/artifacts/${fixture.artifactId}`, {
        pinned: true,
        version: 1,
      })).status,
      403,
    );
    assertEquals((await fixture.request("/v1/artifact-storage")).status, 404);
    const row = await fixture.pgDatabase.query(
      "select pinned_at from bakery.artifacts where id=$1",
      [fixture.artifactId],
    );
    assertEquals(row.rows[0].pinned_at, null);
  } finally {
    await fixture.closeRetention();
  }
});
Deno.test("cross-tenant pin never changes artifact", async () => {
  const fixture = await retentionFixture();
  const other = await createWorkerScope(fixture, "retention-foreign", fixture);
  try {
    const response = await fixture.request(
      `/v1/artifacts/${fixture.artifactId}`,
      { pinned: true, version: 1, organizationId: other.organizationId },
    );
    assertEquals(response.status, 404);
    assertEquals((await response.json()).code, "RESOURCE_NOT_FOUND");
    const row = await fixture.pgDatabase.query(
      "select pinned_at from bakery.artifacts where id=$1",
      [fixture.artifactId],
    );
    assertEquals(row.rows[0].pinned_at, null);
    await assertRetained(fixture);
  } finally {
    await closeWorkerScope(fixture, other);
    await fixture.closeRetention();
  }
});
