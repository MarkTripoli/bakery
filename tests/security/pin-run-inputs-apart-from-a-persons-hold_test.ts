import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assertRetained,
  retentionFixture,
} from "../helpers/artifact-retention.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { collectArtifactVersion } from "../../apps/server/src/modules/knowledge/retention/collector.ts";

/**
 * A run pin and a person's hold are two different facts and must stay two
 * different rows. These tests fix the separation as behaviour rather than as
 * schema, because sharing a flag is the mistake that would make them
 * indistinguishable the moment either one is cleared.
 */
function pin(
  fixture: Awaited<ReturnType<typeof retentionFixture>>,
): Promise<unknown> {
  return fixture.pgDatabase.query(
    `insert into bakery.run_input_pins
       (organization_id,run_id,artifact_id,artifact_version_id,sha256,size_bytes)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      fixture.organizationId,
      fixture.job.runId,
      fixture.artifactId,
      fixture.versionId,
      fixture.sha256,
      fixture.content.length,
    ],
  );
}

async function runStatus(
  fixture: Awaited<ReturnType<typeof retentionFixture>>,
  status: string,
): Promise<void> {
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs set status = $2 where id = $1`,
    [fixture.job.runId, status],
  );
}

Deno.test("a run pin outlives a person unpinning the artifact", async () => {
  const fixture = await retentionFixture();
  try {
    await runStatus(fixture, "running");
    await pin(fixture);
    // The person releases their hold...
    await fixture.pgDatabase.query(
      `update bakery.artifacts set pinned_at = null where id = $1`,
      [fixture.artifactId],
    );
    // ...and the run still holds its input.
    await assertRetained(fixture);
    const rows = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_input_pins
        where organization_id = $1 and run_id = $2`,
      [fixture.organizationId, fixture.job.runId],
    );
    assertEquals(rows.rows[0]?.n, "1");
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a person's hold survives the run ending", async () => {
  const fixture = await retentionFixture();
  try {
    await fixture.pgDatabase.query(
      `update bakery.artifacts set pinned_at = now() where id = $1`,
      [fixture.artifactId],
    );
    await runStatus(fixture, "completed");
    await assertRetained(fixture);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("retention spares a version a live run pinned", async () => {
  const fixture = await retentionFixture();
  try {
    await runStatus(fixture, "running");
    await pin(fixture);
    // The version is expired by its retention class; only the pin keeps it.
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions set expires_at = now() - interval '1 day'
        where id = $1`,
      [fixture.versionId],
    );
    const collected = await collectArtifactVersion(
      fixture.pgDatabase,
      fixture.versionId,
    );
    assertEquals(
      collected,
      false,
      "a run-pinned version must not be collected",
    );
    await assertRetained(fixture);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a run pin is released when the run ends, so collection can proceed", async () => {
  const fixture = await retentionFixture();
  try {
    await runStatus(fixture, "running");
    await pin(fixture);
    await runStatus(fixture, "completed");
    await fixture.pgDatabase.query(
      `update bakery.artifact_versions set expires_at = now() - interval '1 day'
        where id = $1`,
      [fixture.versionId],
    );
    const collected = await collectArtifactVersion(
      fixture.pgDatabase,
      fixture.versionId,
    );
    assertEquals(collected, true, "an ended run must stop pinning its inputs");
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a served pin cannot be rewritten after admission", async () => {
  const fixture = await retentionFixture();
  try {
    await runStatus(fixture, "running");
    await pin(fixture);
    // The runtime role holds select and insert only, so a served digest cannot
    // drift under the run that is reading it. The grants are the invariant: a
    // denied statement's driver error class varies, the privilege does not.
    const grants = await fixture.pgDatabase.query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'bakery' and table_name = 'run_input_pins'
          and grantee = 'bakery_app'
        order by privilege_type`,
    );
    assertEquals(
      grants.rows.map((row) => row.privilege_type),
      ["INSERT", "SELECT"],
    );
    // And the attempt is genuinely refused, whatever error class it surfaces.
    for (
      const sql of [
        `update bakery.run_input_pins set sha256 = $2 where artifact_version_id = $1`,
        `delete from bakery.run_input_pins where artifact_version_id = $1`,
      ]
    ) {
      await assertRejects(() =>
        fixture.runtimePgDatabase.query(sql, [
          fixture.versionId,
          // A different digest, so the update is a real change if allowed.
          "b".repeat(64),
        ])
      );
    }
    const unchanged = await fixture.pgDatabase.query<{ sha256: string }>(
      `select sha256 from bakery.run_input_pins where artifact_version_id = $1`,
      [fixture.versionId],
    );
    assertEquals(unchanged.rows[0]?.sha256, fixture.sha256);
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a pin is scoped to its run: another run cannot see or reuse it", async () => {
  const fixture = await retentionFixture();
  try {
    await runStatus(fixture, "running");
    await pin(fixture);
    // A second run of the same task is a different context, so the pin keyed to
    // the first run is not returned for it.
    const other = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_input_pins
        where organization_id = $1 and run_id = $2`,
      [fixture.organizationId, crypto.randomUUID()],
    );
    assertEquals(other.rows[0]?.n, "0");
    // And the unique key is per run and version, not global.
    await fixture.pgDatabase.query(
      `insert into bakery.run_input_pins
         (organization_id,run_id,artifact_id,artifact_version_id,sha256,size_bytes)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        fixture.organizationId,
        fixture.job.runId,
        fixture.artifactId,
        fixture.versionId,
        fixture.sha256,
        fixture.content.length,
      ],
    ).catch(() => undefined);
    const deduped = await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_input_pins
        where organization_id = $1 and run_id = $2`,
      [fixture.organizationId, fixture.job.runId],
    );
    assertEquals(deduped.rows[0]?.n, "1");
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("a pin cannot point at another organization's version", async () => {
  const fixture = await retentionFixture();
  try {
    await runStatus(fixture, "running");
    const error = await assertRejects(
      () =>
        fixture.pgDatabase.query(
          `insert into bakery.run_input_pins
             (organization_id,run_id,artifact_id,artifact_version_id,sha256,size_bytes)
           values ($1,$2,$3,$4,$5,$6)`,
          [
            crypto.randomUUID(),
            fixture.job.runId,
            fixture.artifactId,
            fixture.versionId,
            fixture.sha256,
            fixture.content.length,
          ],
        ),
    );
    assert(error instanceof Error);
    assertEquals(Reflect.get(error, "code"), "23503");
  } finally {
    await fixture.closeRetention();
  }
});

Deno.test("the pin carries the digest the version had, not a recomputed one", async () => {
  const fixture = await retentionFixture();
  try {
    await runStatus(fixture, "running");
    await pin(fixture);
    const row = await fixture.pgDatabase.query<
      { pin_sha256: string; version_sha256: string; size_bytes: number }
    >(
      `select p.sha256 as pin_sha256, v.sha256 as version_sha256,
              p.size_bytes
         from bakery.run_input_pins p
         join bakery.artifact_versions v
           on v.organization_id = p.organization_id
          and v.id = p.artifact_version_id
        where p.organization_id = $1 and p.run_id = $2`,
      [fixture.organizationId, fixture.job.runId],
    );
    const pinned = row.rows[0];
    assert(pinned);
    assertEquals(pinned.pin_sha256, pinned.version_sha256);
    assertEquals(pinned.pin_sha256, await sha256Bytes(fixture.content));
    assertEquals(Number(pinned.size_bytes), fixture.content.length);
  } finally {
    await fixture.closeRetention();
  }
});
