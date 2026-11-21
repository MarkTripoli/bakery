/**
 * #447: the Admin purge of a record-area file (chapter 25 section 17.5). The
 * request is queued as the runtime role; the owner-privileged job clears every
 * version's bytes, overriding pins, and leaves the entry as a tombstone. Also:
 * the purge is idempotent, Admin only, 404 across organizations, a record
 * folder is refused, and the runtime role still cannot clear artifact bytes.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  closeWorkerOrganization,
  createWorkerScope,
  seedEligibleJob,
} from "../helpers/worker-execution.ts";
import { readTestDatabaseConfig } from "@bakery/config";
import { ADMIN_PURGE_POLICY } from "../../apps/server/src/modules/knowledge/storage-record-purge.ts";
import { runStoragePurgesTask } from "../../apps/server/src/platform/storage-purges-task.ts";

const urls = () => readTestDatabaseConfig();

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

function purge(fixture: Fixture, id: string, organizationId?: string) {
  return Promise.resolve(fixture.app.fetch(
    new Request(
      fixture.config.publicBaseUrl + "/v1/storage/entries/" + id + "/purge",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": organizationId ?? fixture.organizationId,
          Cookie: fixture.adminCookie,
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    ),
  ));
}

async function status(response: Response): Promise<[number, Json]> {
  return [response.status, JSON.parse(await response.text()) as Json];
}

const hex = () =>
  (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "").slice(0, 64);

function setRole(fixture: Fixture, role: string) {
  return fixture.pgDatabase.query(
    "update bakery.organization_memberships set role = $3 where organization_id = $1 and principal_id = $2",
    [fixture.organizationId, fixture.principalId, role],
  );
}

/** A pinned artifact with two versions, filed in a record folder. */
async function recordFile(fixture: Fixture, organizationId: string) {
  const db = fixture.pgDatabase;
  const job = await seedEligibleJob(db, organizationId, fixture.principalId);
  const artifact = (await db.query<{ id: string }>(
    "insert into bakery.artifacts (organization_id, task_id, artifact_type, name, pinned_at) values ($1, $2, 'plan', 'leak.md', now()) returning id",
    [organizationId, job.taskId],
  )).rows[0].id;
  const versions: string[] = [];
  for (const revision of [1, 2]) {
    versions.push(
      (await db.query<{ id: string }>(
        "insert into bakery.artifact_versions (organization_id, artifact_id, task_id, author_id, revision, content, sha256, size_bytes, media_type) values ($1, $2, $3, $4, $5, $6, $7, 3, 'text/markdown') returning id",
        [
          organizationId,
          artifact,
          job.taskId,
          fixture.principalId,
          revision,
          new Uint8Array([1, 2, 3]),
          hex(),
        ],
      )).rows[0].id,
    );
  }
  const folder = (await db.query<{ id: string }>(
    "insert into bakery.storage_entries (organization_id, parent_id, name, name_key, kind, policy) values ($1, null, $2, $2, 'folder', 'record') returning id",
    [organizationId, "records-" + crypto.randomUUID().slice(0, 8)],
  )).rows[0].id;
  const file = (await db.query<{ id: string }>(
    "insert into bakery.storage_entries (organization_id, parent_id, name, name_key, kind, policy, artifact_id) values ($1, $2, 'leak.md', 'leak.md', 'file', 'record', $3) returning id",
    [organizationId, folder, artifact],
  )).rows[0].id;
  return { artifact, versions, folder, file };
}

Deno.test("a record-area file purge is queued, then the owner job clears every version", () =>
  withWorkerFixture(async (fixture) => {
    await setRole(fixture, "admin");
    const record = await recordFile(fixture, fixture.organizationId);

    // A developer may not purge.
    await setRole(fixture, "developer");
    try {
      assertEquals(
        (await status(await purge(fixture, record.file)))[0],
        403,
      );
    } finally {
      await setRole(fixture, "admin");
    }

    // A record folder stays refused.
    const [folderStatus, folderBody] = await status(
      await purge(fixture, record.folder),
    );
    assertEquals([folderStatus, folderBody.code, folderBody.reason], [
      409,
      "STORAGE_AREA_REFUSED",
      "record_area",
    ]);

    // Queued twice: one request, nothing cleared yet; the second call says
    // it was already requested.
    for (const already of [false, true]) {
      const [code, body] = await status(await purge(fixture, record.file));
      assertEquals(
        [code, body.status, body.alreadyRequested, body.entriesRemoved],
        [200, "queued", already, 0],
      );
    }
    // deletionRequestedAt reads this pending request (project() in
    // storage-working-areas.ts); no route projects a record file today.
    const requests = await fixture.pgDatabase.query<{ id: string }>(
      "select id from bakery.storage_purge_requests where organization_id = $1 and entry_id = $2",
      [fixture.organizationId, record.file],
    );
    assertEquals(requests.rows.length, 1);
    const untouched = await fixture.pgDatabase.query(
      "select 1 from bakery.artifact_versions where artifact_id = $1 and purged_at is null and content is not null",
      [record.artifact],
    );
    assertEquals(untouched.rows.length, 2);
    const audits = await fixture.pgDatabase.query<{ details: Json }>(
      "select details from bakery.audit_events where organization_id = $1 and operation = 'storageEntries.purge' and resource_id = $2 order by id",
      [fixture.organizationId, record.file],
    );
    assertEquals(audits.rows.map((row) => row.details.requested), [
      true,
      true,
    ]);

    // The runtime role cannot complete it: the task fails closed.
    await assertRejects(() => runStoragePurgesTask(urls().appDatabaseUrl));

    // The owner job overrides the pin and clears both versions.
    const done = await runStoragePurgesTask(urls().databaseUrl);
    assert(done.completed >= 1);
    const versions = await fixture.pgDatabase.query<{
      content: Uint8Array | null;
      blob_id: string | null;
      purged: boolean;
      purge_policy: string;
    }>(
      "select content, blob_id, purged_at is not null as purged, purge_policy from bakery.artifact_versions where artifact_id = $1 order by revision",
      [record.artifact],
    );
    assertEquals(
      versions.rows.map((row) => [
        row.content,
        row.blob_id,
        row.purged,
        row.purge_policy,
      ]),
      [
        [null, null, true, ADMIN_PURGE_POLICY],
        [null, null, true, ADMIN_PURGE_POLICY],
      ],
    );
    const tomb = await fixture.pgDatabase.query<{ purged: boolean }>(
      "select purged_at is not null as purged from bakery.storage_entries where id = $1",
      [record.file],
    );
    assertEquals(tomb.rows[0].purged, true);
    const completed = await fixture.pgDatabase.query<{ done: boolean }>(
      "select completed_at is not null as done from bakery.storage_purge_requests where id = $1",
      [requests.rows[0].id],
    );
    assertEquals(completed.rows[0].done, true);
    const completion = await fixture.pgDatabase.query<{ details: Json }>(
      "select details from bakery.audit_events where organization_id = $1 and operation = 'storageEntries.purge' and resource_id = $2 and details->>'completed' = 'true'",
      [fixture.organizationId, record.file],
    );
    assertEquals(completion.rows[0]?.details.versionsPurged, 2);

    // Purged: a later purge finds nothing, and a rerun completes nothing more.
    assertEquals((await status(await purge(fixture, record.file)))[0], 404);
    assertEquals(
      (await runStoragePurgesTask(urls().databaseUrl)).versionsPurged,
      0,
    );
  }));

Deno.test("a record-area purge in another organization is 404, and runtime still cannot clear bytes", () =>
  withWorkerFixture(async (fixture) => {
    await setRole(fixture, "admin");
    const other = await createWorkerScope(fixture, "purge-447", fixture);
    try {
      const theirs = await recordFile(fixture, other.organizationId);
      const [code, body] = await status(await purge(fixture, theirs.file));
      assertEquals([code, body.code], [404, "RESOURCE_NOT_FOUND"]);
      const queued = await fixture.pgDatabase.query(
        "select 1 from bakery.storage_purge_requests where entry_id = $1",
        [theirs.file],
      );
      assertEquals(queued.rows.length, 0);
      for (
        const sql of [
          "update bakery.artifact_versions set content = null where id = $1",
          "update bakery.artifact_versions set blob_id = null where id = $1",
          "update bakery.artifact_versions set purged_at = now() where id = $1",
          "update bakery.artifact_versions set purge_policy = 'admin-purge' where id = $1",
          "update bakery.storage_purge_requests set completed_at = now() where entry_id = $1",
        ]
      ) {
        await assertRejects(() =>
          fixture.runtimePgDatabase.query(sql, [
            sql.includes("storage_purge_requests")
              ? theirs.file
              : theirs.versions[0],
          ])
        );
      }
    } finally {
      await closeWorkerOrganization(fixture.pgDatabase, other.organizationId);
    }
  }));
