import { assertEquals, assertRejects } from "@std/assert";
import { openInstallationFixture } from "../helpers/installation-settings.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";

const DAY = 86_400_000;

async function seedAudit(
  f: Awaited<ReturnType<typeof openInstallationFixture>>,
  resourceId: string,
  ageDays: number,
  organizationId: string | null = f.organizationId,
) {
  const result = await f.pgDatabase.query<{ id: string }>(
    `insert into bakery.audit_events (organization_id, operation, resource_type,
       resource_id, outcome, request_id, trace_id, created_at)
     values ($1, 'purge.test', 'purge_test', $2, 'succeeded', 'r', 't', $3)
     returning id`,
    [organizationId, resourceId, new Date(Date.now() - ageDays * DAY)],
  );
  return result.rows[0]!.id;
}

Deno.test("purge_audit_events deletes only expired, unreferenced rows of one organization within max_rows", async () => {
  const f = await openInstallationFixture();
  const admin = openPgDatabase(
    readTestDatabaseConfig(Deno.env.toObject(), { requireAdmin: true })
      .adminDatabaseUrl,
  );
  const evidenceId = crypto.randomUUID();
  let otherOrganizationId: string | undefined;
  try {
    const old1 = await seedAudit(f, "old-1", 400);
    const old2 = await seedAudit(f, "old-2", 399);
    const old3 = await seedAudit(f, "old-3", 398);
    const fresh = await seedAudit(f, "fresh", 1);
    const referenced = await seedAudit(f, "referenced", 500);
    const installation = await seedAudit(f, "old-install", 500, null);
    // Another organization's equally old row must survive a purge of the first.
    otherOrganizationId = crypto.randomUUID();
    await f.pgDatabase.query(
      `insert into bakery.organizations (id, name, slug, created_at, updated_at)
       values ($1, 'Purge other', $2, now(), now())`,
      [otherOrganizationId, `purge-other-${otherOrganizationId.slice(0, 8)}`],
    );
    const otherOrganization = await seedAudit(
      f,
      "other-org",
      500,
      otherOrganizationId,
    );
    // Evidence rows chain to jobs and reservations; the superuser seeds a bare
    // row so the purge predicate is the only thing under test.
    const client = await admin.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query(
        `insert into bakery.budget_release_evidence (id, organization_id,
           installation_reservation_id, job_id, attempt_id, effect_id, kind,
           digest, observed_at, source_event_id)
         values ($1, $2, gen_random_uuid(), gen_random_uuid(),
           gen_random_uuid(), 'e', 'k', 'd', now(), $3)`,
        [evidenceId, f.organizationId, referenced],
      );
      await client.query("commit");
    } finally {
      client.release();
    }
    const before = new Date(Date.now() - 31 * DAY);
    const app = f.runtimePgDatabase;

    await assertRejects(() =>
      app.query("delete from bakery.audit_events where id = $1", [fresh])
    );

    // The function refuses a cutoff newer than 30 days whatever the caller asks.
    const tooRecent = await app.query<{ purged: number }>(
      "select bakery.purge_audit_events($1, $2, 100) as purged",
      [f.organizationId, new Date(Date.now() - 5 * DAY)],
    );
    assertEquals(tooRecent.rows[0]!.purged, 0);

    const bounded = await app.query<{ purged: number }>(
      "select bakery.purge_audit_events($1, $2, 2) as purged",
      [f.organizationId, before],
    );
    assertEquals(bounded.rows[0]!.purged, 2);
    const rest = await app.query<{ purged: number }>(
      "select bakery.purge_audit_events($1, $2, 100) as purged",
      [f.organizationId, before],
    );
    assertEquals(rest.rows[0]!.purged, 1);

    const left = await f.pgDatabase.query<{ id: string }>(
      "select id from bakery.audit_events where id = any($1::uuid[])",
      [[old1, old2, old3, fresh, referenced, installation, otherOrganization]],
    );
    assertEquals(
      new Set(left.rows.map((row) => row.id)),
      new Set([fresh, referenced, installation, otherOrganization]),
    );
    const none = await app.query<{ purged: number }>(
      "select bakery.purge_audit_events($1, $2, 0) as purged",
      [f.organizationId, before],
    );
    assertEquals(none.rows[0]!.purged, 0);
    assertEquals(left.rows.length, 4);
  } finally {
    await f.pgDatabase.query(
      "delete from bakery.budget_release_evidence where id = $1",
      [evidenceId],
    );
    await f.pgDatabase.query(
      "delete from bakery.audit_events where operation = 'purge.test'",
    );
    if (otherOrganizationId) {
      await f.pgDatabase.query(
        "delete from bakery.organizations where id = $1",
        [otherOrganizationId],
      );
    }
    await closePgDatabase(admin);
    await f.finish();
  }
});
