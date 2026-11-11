import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
  resetTestDatabase,
} from "../../apps/server/src/platform/migrate.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
} from "../../apps/server/src/modules/auth/migrations.ts";
import {
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";
import {
  enqueueOutboxEvent,
  openOutboxTestFixture,
} from "../helpers/outbox-fixture.ts";

const { databaseUrl } = readTestDatabaseConfig(Deno.env.toObject(), {
  requireAdmin: true,
});

async function loadBakeryMigrations() {
  return [
    ...await loadMigrations(bakeryPlatformMigrationSource),
    ...await loadMigrations(authBakeryMigrationSource),
    ...await loadMigrations(workBakeryMigrationSource),
    ...await loadMigrations(projectsBakeryMigrationSource),
    ...await loadMigrations(agentsBakeryMigrationSource),
    ...await loadMigrations(repositoryRulesBakeryMigrationSource),
    ...await loadMigrations(integrationsBakeryMigrationSource),
    ...await loadMigrations(deliveryBakeryMigrationSource),
  ];
}

Deno.test("nontransactional index migrations recover wrong same-name indexes", async () => {
  const owner = openDatabase(databaseUrl);
  const provider = openPgDatabase(databaseUrl);
  try {
    await resetTestDatabase(owner, {
      targetUrl: databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
    await migrateProvider(
      provider,
      await loadMigrations(betterAuthMigrationSource),
    );
    const migrations = await loadBakeryMigrations();
    await migrate(owner, migrations.filter(({ version }) => version < "0012"));
    await owner`create index outbox_organization_event_idx on bakery.outbox (id)`;
    await owner`create index outbox_pending_dispatch_idx on bakery.outbox (id)`;
    await owner`create index outbox_sending_dispatch_idx on bakery.outbox (id)`;

    await migrate(
      owner,
      migrations.filter(({ version }) => version < "0018"),
    );

    const indexes = await owner`
      select indexname, indexdef from pg_indexes
      where schemaname = 'bakery' and indexname in (
        'outbox_organization_event_idx',
        'outbox_pending_dispatch_idx',
        'outbox_sending_dispatch_idx'
      ) order by indexname`;
    assertEquals(indexes.length, 3);
    assertStringIncludes(indexes[0].indexdef, "(organization_id, event_id)");
    assertStringIncludes(
      indexes[1].indexdef,
      "INCLUDE (attempt_count, replay_deadline_at)",
    );
    assertStringIncludes(
      indexes[2].indexdef,
      "INCLUDE (attempt_count, replay_deadline_at)",
    );

    await owner`create index tasks_organization_created_id_idx
      on bakery.tasks (id)`;
    await owner`create unique index domain_events_organization_sequence_unique_idx
      on bakery.domain_events (sequence)`;

    await migrate(owner, migrations);

    const eventClockIndexes = await owner`
      select indexname, indexdef from pg_indexes
      where schemaname = 'bakery' and indexname in (
        'tasks_organization_created_id_idx',
        'domain_events_organization_sequence_unique'
      ) order by indexname`;
    assertEquals(eventClockIndexes.length, 2);
    assertStringIncludes(
      eventClockIndexes[0].indexdef,
      "(organization_id, organization_sequence)",
    );
    assertStringIncludes(
      eventClockIndexes[1].indexdef,
      "(organization_id, created_at DESC, id DESC)",
    );
  } finally {
    await closePgDatabase(provider);
    await closeDatabase(owner);
  }
});

Deno.test("TypeScript outbox repair retries locked work before recording completion", async () => {
  const fixture = await openOutboxTestFixture();
  const { owner, appPg, organizationId } = fixture;
  const lockClient = await appPg.connect();
  try {
    await owner`delete from bakery.data_migrations
      where version in ${
      owner(bakeryDataMigrations.map((migration) => migration.version))
    }`;
    const malformedId = await enqueueOutboxEvent(
      owner,
      organizationId,
      "inngest",
    );
    const activeId = await enqueueOutboxEvent(owner, organizationId, "inngest");
    const activeToken = crypto.randomUUID();
    await owner`update bakery.outbox set lease_until = now()
      where id = ${malformedId}`;
    await owner`update bakery.outbox set status = 'sending', attempt_count = 1,
      replay_deadline_at = now() + interval '24 hours',
      lease_token = ${activeToken}, lease_until = now() + interval '1 hour'
      , last_error = ${owner.json("legacy-scalar")}
      where id = ${activeId}`;
    await lockClient.query("begin");
    await lockClient.query(
      "select id from bakery.outbox where id = $1 for update",
      [
        malformedId,
      ],
    );

    await assertRejects(
      () => migrateData(owner, bakeryDataMigrations),
      Error,
      "canceling statement due to lock timeout",
    );
    assertEquals(
      Number(
        (await owner`select count(*)::int as count
        from bakery.data_migrations
        where version = '0015_outbox_dispatch_backfill'`)[0].count,
      ),
      0,
    );
    await lockClient.query("rollback");

    await migrateData(owner, bakeryDataMigrations);

    assertEquals(
      (await owner`select status, lease_until as "leaseUntil"
        from bakery.outbox where id = ${malformedId}`)[0],
      { status: "pending", leaseUntil: null },
    );
    assertEquals(
      (await owner`select status, lease_token::text as "leaseToken",
        last_error->>'code' as "errorCode"
        from bakery.outbox where id = ${activeId}`)[0],
      {
        status: "sending",
        leaseToken: activeToken,
        errorCode: "OUTBOX_LEGACY_FAILURE",
      },
    );
    assertEquals(
      Number(
        (await owner`select count(*)::int as count
        from bakery.data_migrations
        where version = '0015_outbox_dispatch_backfill'`)[0].count,
      ),
      1,
    );
  } finally {
    await lockClient.query("rollback");
    lockClient.release();
    await fixture.close();
  }
});
