import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  assertApplicationDatabase,
  closeDatabase,
  closePgDatabase,
  type Database,
  openDatabase,
  openPgDatabase,
  type PgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
  resetTestDatabase,
} from "../../apps/server/src/platform/migrate.ts";
import {
  type DataMigration,
  migrateData,
  withApplicationDatabaseDrain,
} from "../../apps/server/src/platform/data-migrate.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
} from "../../apps/server/src/modules/auth/migrations.ts";
import {
  EVENT_CLOCK_CONTRACT_VERSION,
  EVENT_CLOCK_DATA_BOUNDARY,
  EVENT_CLOCK_SCHEMA_BOUNDARY,
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

const { databaseUrl, appDatabaseUrl } = readTestDatabaseConfig(
  Deno.env.toObject(),
  { requireAdmin: true },
);

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

async function resetAndMigrate(
  database: Database,
  providerDatabase: PgDatabase,
  migrations: Awaited<ReturnType<typeof loadBakeryMigrations>>,
): Promise<void> {
  await resetTestDatabase(database, {
    targetUrl: databaseUrl,
    ...readTestDatabaseResetOptions(),
  });
  await migrateProvider(
    providerDatabase,
    await loadMigrations(betterAuthMigrationSource),
  );
  await migrate(database, migrations);
}

Deno.test("outbox online migrations preserve populated delivery state", async () => {
  const database = openDatabase(databaseUrl);
  const providerDatabase = openPgDatabase(databaseUrl);
  try {
    const migrations = await loadBakeryMigrations();
    const preDispatch = migrations.filter(({ version }) => version < "0009");

    // Given populated outbox rows from the schema before dispatcher delivery
    await resetAndMigrate(database, providerDatabase, preDispatch);
    const organizationId = crypto.randomUUID();
    const secondOrganizationId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const updatedAt = new Date("2026-09-01T12:00:00.000Z");
    await database`
      insert into bakery.organizations (
        id, name, slug, created_at, updated_at
      ) values (
        ${organizationId}, 'Migration fixture', ${`migration-${organizationId}`},
        ${updatedAt}, ${updatedAt}
      )
    `;
    await database`
      insert into bakery.organizations (
        id, name, slug, created_at, updated_at
      ) values (
        ${secondOrganizationId}, 'Second migration fixture',
        ${`migration-${secondOrganizationId}`}, ${updatedAt}, ${updatedAt}
      )
    `;
    await database`
      insert into bakery.domain_events (
        id, organization_id, event_type, aggregate_id,
        aggregate_version, payload
      ) values (
        ${eventId}, ${organizationId}, 'run.requested', ${crypto.randomUUID()},
        1, ${database.json({ runId: crypto.randomUUID() })}
      )
    `;
    await database`
      insert into bakery.domain_events (
        organization_id, event_type, aggregate_id, aggregate_version, payload
      ) values
        (
          ${secondOrganizationId}, 'run.requested', ${crypto.randomUUID()}, 1,
          ${database.json({ runId: crypto.randomUUID() })}
        ),
        (
          ${organizationId}, 'run.requested', ${crypto.randomUUID()}, 1,
          ${database.json({ runId: crypto.randomUUID() })}
        ),
        (
          ${secondOrganizationId}, 'run.requested', ${crypto.randomUUID()}, 1,
          ${database.json({ runId: crypto.randomUUID() })}
        )
    `;
    await database`
      insert into bakery.outbox (
        organization_id, event_id, destination, delivery_key, status,
        attempt_count, lease_until, last_error, updated_at
      ) values
        (${organizationId}, ${eventId}, 'inngest', 'pending-zero', 'pending',
          0, null, null, ${updatedAt}),
        (${organizationId}, ${eventId}, 'inngest', 'pending-attempted', 'pending',
          2, null, '{"code":"RETRY"}', ${updatedAt}),
        (${organizationId}, ${eventId}, 'inngest', 'pending-invalid-error', 'pending',
          2, null, ${database.json("legacy-scalar")}, ${updatedAt}),
        (${organizationId}, ${eventId}, 'inngest', 'pending-invalid-key', 'pending',
          2, null, ${database.json({ "": "legacy" })}, ${updatedAt}),
        (${organizationId}, ${eventId}, 'inngest', 'sending-attempted', 'sending',
          1, ${updatedAt}, null, ${updatedAt}),
        (${organizationId}, ${eventId}, 'inngest', 'delivered', 'delivered',
          1, null, '{"code":"STALE"}', ${updatedAt}),
        (${organizationId}, ${eventId}, 'inngest', 'failed', 'failed',
          3, null, null, ${updatedAt})
    `;

    // When the compatible schema expands, application data migrates, and the
    // non-null contract closes only after the backfill succeeds.
    await migrate(database, migrations, {
      through: EVENT_CLOCK_SCHEMA_BOUNDARY,
    });
    await migrateData(database, bakeryDataMigrations, {
      through: EVENT_CLOCK_DATA_BOUNDARY,
    });
    await migrate(database, migrations);

    const migratedSequences = await database`
      select organization_id, organization_sequence::text as sequence
      from bakery.domain_events
      where organization_id in (${organizationId}, ${secondOrganizationId})
      order by organization_id = ${organizationId} desc, organization_sequence
    `;
    assertEquals([...migratedSequences], [
      { organization_id: organizationId, sequence: "1" },
      { organization_id: organizationId, sequence: "2" },
      { organization_id: secondOrganizationId, sequence: "1" },
      { organization_id: secondOrganizationId, sequence: "2" },
    ]);
    const migratedClocks = await database`
      select organization_id, next_seq::text
      from bakery.event_clock
      where organization_id in (${organizationId}, ${secondOrganizationId})
      order by organization_id = ${organizationId} desc
    `;
    assertEquals([...migratedClocks], [
      { organization_id: organizationId, next_seq: "3" },
      { organization_id: secondOrganizationId, next_seq: "3" },
    ]);
    // Then legacy states satisfy current invariants without losing identity
    const rows = await database`
      select delivery_key, status, attempt_count,
        replay_deadline_at, lease_until, delivered_at, engine_event_id,
        last_error->>'code' as error_code
      from bakery.outbox
      order by delivery_key
    `;
    const replayDeadline = new Date(updatedAt.getTime() + 24 * 60 * 60 * 1000);
    assertEquals([...rows], [
      {
        delivery_key: "delivered",
        status: "delivered",
        attempt_count: 1,
        replay_deadline_at: replayDeadline,
        lease_until: null,
        delivered_at: updatedAt,
        engine_event_id: "delivered",
        error_code: null,
      },
      {
        delivery_key: "failed",
        status: "failed",
        attempt_count: 3,
        replay_deadline_at: replayDeadline,
        lease_until: null,
        delivered_at: null,
        engine_event_id: null,
        error_code: "OUTBOX_LEGACY_FAILURE",
      },
      {
        delivery_key: "pending-attempted",
        status: "pending",
        attempt_count: 2,
        replay_deadline_at: replayDeadline,
        lease_until: null,
        delivered_at: null,
        engine_event_id: null,
        error_code: "RETRY",
      },
      {
        delivery_key: "pending-invalid-error",
        status: "pending",
        attempt_count: 2,
        replay_deadline_at: replayDeadline,
        lease_until: null,
        delivered_at: null,
        engine_event_id: null,
        error_code: "OUTBOX_LEGACY_FAILURE",
      },
      {
        delivery_key: "pending-invalid-key",
        status: "pending",
        attempt_count: 2,
        replay_deadline_at: replayDeadline,
        lease_until: null,
        delivered_at: null,
        engine_event_id: null,
        error_code: "OUTBOX_LEGACY_FAILURE",
      },
      {
        delivery_key: "pending-zero",
        status: "pending",
        attempt_count: 0,
        replay_deadline_at: null,
        lease_until: null,
        delivered_at: null,
        engine_event_id: null,
        error_code: null,
      },
      {
        delivery_key: "sending-attempted",
        status: "pending",
        attempt_count: 1,
        replay_deadline_at: replayDeadline,
        lease_until: null,
        delivered_at: null,
        engine_event_id: null,
        error_code: null,
      },
    ]);
    assertEquals(
      (await database`
        select convalidated as valid
        from pg_constraint
        where conname = 'outbox_organization_event_fk'
      `)[0].valid,
      true,
    );
    assertEquals(
      Number(
        (await database`
        select count(*)::int as count
        from pg_constraint
        where conname in (
          'outbox_engine_event_id_nonblank',
          'outbox_delivery_state_consistent',
          'outbox_replay_deadline_consistent'
        )
      `)[0].count,
      ),
      0,
    );
  } finally {
    await closePgDatabase(providerDatabase);
    await closeDatabase(database);
  }
});

Deno.test("event clock cutover drains writers and resumes bounded batches", async () => {
  const database = openDatabase(databaseUrl);
  const providerDatabase = openPgDatabase(databaseUrl);
  try {
    const migrations = await loadBakeryMigrations();
    const preEventClock = migrations.filter(({ version }) =>
      version < "0018_event_clock"
    );
    await resetAndMigrate(database, providerDatabase, preEventClock);
    const organizationId = crypto.randomUUID();
    await database`
      insert into bakery.organizations (id, name, slug, created_at, updated_at)
      values (
        ${organizationId}, 'Event migration fixture',
        ${`event-migration-${organizationId}`}, now(), now()
      )
    `;
    await database`
      insert into bakery.domain_events (
        organization_id, event_type, aggregate_id, aggregate_version, payload
      )
      select ${organizationId}, 'run.requested', gen_random_uuid(), value,
        jsonb_build_object('runId', gen_random_uuid())
      from generate_series(1, 200) as value
    `;

    await migrate(database, migrations, {
      through: EVENT_CLOCK_SCHEMA_BOUNDARY,
    });
    assertEquals(
      (await database`
        select to_regclass(
          'bakery.domain_events_pending_organization_sequence_idx'
        ) is not null as present
      `)[0].present,
      true,
    );

    const preContractApplication = openPgDatabase(appDatabaseUrl);
    try {
      await assertRejects(
        () => assertApplicationDatabase(preContractApplication),
        Error,
        "EVENT_CLOCK_MIGRATION_INCOMPLETE",
      );
    } finally {
      await closePgDatabase(preContractApplication);
    }

    const activeApplication = openPgDatabase(appDatabaseUrl);
    let operationRan = false;
    try {
      await activeApplication.query("select 1");
      await assertRejects(
        () =>
          withApplicationDatabaseDrain(database, () => {
            operationRan = true;
            return Promise.resolve();
          }),
        Error,
        "APPLICATION_DATABASE_DRAIN_REQUIRED",
      );
      assertEquals(operationRan, false);
    } finally {
      await closePgDatabase(activeApplication);
    }

    await assertRejects(
      () =>
        withApplicationDatabaseDrain(
          database,
          () =>
            migrateData(database, bakeryDataMigrations, {
              through: EVENT_CLOCK_DATA_BOUNDARY,
              maxBatches: 1,
            }),
        ),
      Error,
      "DATA_MIGRATION_INCOMPLETE:0019_event_clock_seed",
    );
    const partial = await database`
      select
        count(*) filter (
          where organization_sequence is not null
        )::integer as migrated,
        count(*) filter (
          where organization_sequence is null
        )::integer as remaining
      from bakery.domain_events
      where organization_id = ${organizationId}
    `;
    assertEquals(partial[0], { migrated: 100, remaining: 100 });

    await assertRejects(
      () =>
        withApplicationDatabaseDrain(
          database,
          () =>
            migrateData(database, bakeryDataMigrations, {
              through: EVENT_CLOCK_DATA_BOUNDARY,
              maxBatches: 100,
              untilComplete: true,
              deadlineMs: 0,
            }),
        ),
      Error,
      "DATA_MIGRATION_DEADLINE_EXCEEDED:0019_event_clock_seed",
    );
    const expired = await database`
      select
        count(*) filter (
          where organization_sequence is not null
        )::integer as migrated,
        count(*) filter (
          where organization_sequence is null
        )::integer as remaining,
        exists (
          select 1 from bakery.data_migrations
          where version = '0019_event_clock_seed'
        ) as recorded
      from bakery.domain_events
      where organization_id = ${organizationId}
    `;
    assertEquals(expired[0], {
      migrated: 100,
      remaining: 100,
      recorded: false,
    });

    await withApplicationDatabaseDrain(database, async () => {
      await migrateData(database, bakeryDataMigrations, {
        through: EVENT_CLOCK_DATA_BOUNDARY,
        maxBatches: 1,
        untilComplete: true,
        deadlineMs: 5_000,
      });
      // A second migrator after the data ledger commit cannot reopen old writers.
      await migrate(database, migrations, {
        through: EVENT_CLOCK_SCHEMA_BOUNDARY,
        manageApplicationConnect: false,
      });
      const concurrentApplication = openPgDatabase(appDatabaseUrl);
      try {
        await assertRejects(
          () => concurrentApplication.query("select 1"),
          Error,
          "permission denied for database",
        );
      } finally {
        await closePgDatabase(concurrentApplication);
      }
      await migrate(database, migrations, {
        manageApplicationConnect: false,
      });
    });

    const completed = await database`
      select
        (select count(*)::integer
         from bakery.domain_events
         where organization_id = ${organizationId}
           and organization_sequence is not null) as migrated,
        (select next_seq::integer
         from bakery.event_clock
         where organization_id = ${organizationId}
           and stream = 'domain_events') as next_seq,
        exists (
          select 1 from bakery.schema_migrations
          where version = ${EVENT_CLOCK_CONTRACT_VERSION}
        ) as contracted
    `;
    assertEquals(completed[0], {
      migrated: 200,
      next_seq: 201,
      contracted: true,
    });
    assertEquals(
      (await database`
        select to_regclass(
          'bakery.domain_events_pending_organization_sequence_idx'
        ) is null as removed
      `)[0].removed,
      true,
    );

    // Replay this historical phase before startup records later data versions.
    // Removing its ledger row after that cutover must fail the history guard.
    await database`
      delete from bakery.data_migrations
      where version = '0019_event_clock_seed'
    `;
    await migrateData(database, bakeryDataMigrations, {
      through: EVENT_CLOCK_DATA_BOUNDARY,
      maxBatches: 1,
    });
    const replayed = await database`
      select
        (select next_seq::integer
         from bakery.event_clock
         where organization_id = ${organizationId}
           and stream = 'domain_events') as next_seq,
        exists (
          select 1 from bakery.data_migrations
          where version = '0019_event_clock_seed'
        ) as recorded
    `;
    assertEquals(replayed[0], { next_seq: 201, recorded: true });

    let deadlineProbeRan = false;
    const deadlineProbe: DataMigration = {
      version: "9999_deadline_ledger_probe",
      source: new URL(import.meta.url),
      run: () => {
        deadlineProbeRan = true;
        return Promise.resolve(true);
      },
    };
    await database.unsafe(`
      create function bakery.delay_data_migration_ledger()
      returns trigger
      language plpgsql
      as $$
      begin
        if new.version = '9999_deadline_ledger_probe' then
          perform pg_sleep(1);
        end if;
        return new;
      end
      $$
    `);
    await database.unsafe(`
      create trigger delay_data_migration_ledger
      before insert on bakery.data_migrations
      for each row execute function bakery.delay_data_migration_ledger()
    `);
    try {
      await assertRejects(
        () =>
          migrateData(database, [
            ...bakeryDataMigrations.filter((migration) =>
              migration.version <= EVENT_CLOCK_DATA_BOUNDARY
            ),
            deadlineProbe,
          ], {
            untilComplete: true,
            deadlineMs: 500,
          }),
        Error,
        "DATA_MIGRATION_DEADLINE_EXCEEDED:9999_deadline_ledger_probe",
      );
      assertEquals(deadlineProbeRan, true);
      assertEquals(
        (await database`
          select exists (
            select 1 from bakery.data_migrations
            where version = '9999_deadline_ledger_probe'
          ) as recorded
        `)[0].recorded,
        false,
      );
    } finally {
      await database.unsafe(`
        drop trigger delay_data_migration_ledger
        on bakery.data_migrations
      `);
      await database.unsafe(`
        drop function bakery.delay_data_migration_ledger()
      `);
    }

    const connectState = async () =>
      await database<{
        publicConnect: boolean;
        applicationConnect: boolean;
      }[]>`
        select
          coalesce(bool_or(
            acl.grantee = 0 and acl.privilege_type = 'CONNECT'
          ), false) as "publicConnect",
          coalesce(bool_or(
            role.rolname = 'bakery_app' and acl.privilege_type = 'CONNECT'
          ), false) as "applicationConnect"
        from pg_database as database
        cross join lateral aclexplode(
          coalesce(database.datacl, acldefault('d', database.datdba))
        ) as acl
        left join pg_roles as role on role.oid = acl.grantee
        where database.datname = current_database()
      `;
    const preCrashConnect = (await connectState())[0];
    await database`
      insert into bakery.application_migration_drain (
        id, public_connect, application_connect
      ) values (
        'database',
        ${preCrashConnect.publicConnect},
        ${preCrashConnect.applicationConnect}
      )
    `;
    await database.unsafe(`
      do $revoke_connect$
      begin
        execute format(
          'revoke connect on database %I from public, bakery_app',
          current_database()
        );
      end
      $revoke_connect$;
    `);
    const resumed = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-net",
        "apps/server/src/tasks.ts",
        "migrate",
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      resumed.success,
      true,
      new TextDecoder().decode(resumed.stderr),
    );
    assertEquals((await connectState())[0], preCrashConnect);
    assertEquals(
      Number(
        (await database`
          select count(*)::integer as count
          from bakery.application_migration_drain
        `)[0].count,
      ),
      0,
    );

    const applicationAfterCutover = openPgDatabase(appDatabaseUrl);
    try {
      await assertApplicationDatabase(applicationAfterCutover);
    } finally {
      await closePgDatabase(applicationAfterCutover);
    }
  } finally {
    await closePgDatabase(providerDatabase);
    await closeDatabase(database);
  }
});
Deno.test("outbox constraint validation permits concurrent writes", async () => {
  const database = openDatabase(databaseUrl);
  const providerDatabase = openPgDatabase(databaseUrl);
  const applicationDatabase = openPgDatabase(appDatabaseUrl);
  const application = await applicationDatabase.connect();
  let transactionOpen = false;
  try {
    const migrations = await loadBakeryMigrations();
    const throughConstraintInstallation = migrations.filter(({ version }) =>
      version <= "0016_outbox_dispatch_constraints"
    );
    const throughConstraintValidation = migrations.filter(({ version }) =>
      version <= "0017_outbox_dispatch_constraint_validation"
    );
    await resetAndMigrate(
      database,
      providerDatabase,
      throughConstraintInstallation,
    );
    const organizationId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await database`
      insert into bakery.organizations (id, name, slug, created_at, updated_at)
      values (
        ${organizationId},
        'Concurrent validation fixture',
        ${`concurrent-validation-${organizationId}`},
        now(),
        now()
      )`;
    await database`
      insert into bakery.domain_events (
        id, organization_id, event_type, aggregate_id,
        aggregate_version, payload
      ) values (
        ${eventId}, ${organizationId}, 'run.requested', ${crypto.randomUUID()},
        1, ${database.json({ runId: crypto.randomUUID() })}
      )`;

    await application.query("begin");
    transactionOpen = true;
    await application.query(
      `insert into bakery.outbox (
         organization_id, event_id, destination, delivery_key
       ) values ($1, $2, 'inngest', $3)`,
      [organizationId, eventId, `concurrent-validation-${eventId}`],
    );

    const validation = migrate(database, throughConstraintValidation);
    const completedWithoutWaitingForWriter = await Promise.race([
      validation.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    assertEquals(completedWithoutWaitingForWriter, true);
    await application.query("commit");
    transactionOpen = false;
    await validation;
  } finally {
    if (transactionOpen) await application.query("rollback");
    application.release();
    await closePgDatabase(applicationDatabase);
    await closePgDatabase(providerDatabase);
    await closeDatabase(database);
  }
});

Deno.test("outbox claim predicates use bounded queue indexes", async () => {
  const database = openDatabase(databaseUrl);
  const providerDatabase = openPgDatabase(databaseUrl);
  try {
    const migrations = await loadBakeryMigrations();

    // Given a representative queue with a small due subset
    await resetAndMigrate(database, providerDatabase, migrations);
    await migrateData(database, bakeryDataMigrations, {
      through: EVENT_CLOCK_DATA_BOUNDARY,
    });
    const organizationId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await database`
      insert into bakery.organizations (
        id, name, slug, created_at, updated_at
      ) values (
        ${organizationId}, 'Plan fixture', ${`plan-${organizationId}`}, now(), now()
      )
    `;
    const sequence = await database`
      insert into bakery.event_clock (organization_id, stream, next_seq)
      select ${organizationId}, 'domain_events',
        coalesce(max(organization_sequence), 0) + 2
      from bakery.domain_events
      where organization_id = ${organizationId}
      on conflict (organization_id, stream) do update
        set next_seq = bakery.event_clock.next_seq + 1
      returning next_seq - 1 as value
    `;
    await database`
      insert into bakery.domain_events (
        id, organization_id, organization_sequence, event_type, aggregate_id,
        aggregate_version, payload
      ) values (
        ${eventId}, ${organizationId}, ${sequence[0].value}, 'run.requested',
        ${crypto.randomUUID()}, 1,
        ${database.json({ runId: crypto.randomUUID() })}
      )
    `;
    await database`
      insert into bakery.outbox (
        organization_id, event_id, destination, delivery_key, next_attempt_at
      )
      select ${organizationId}, ${eventId}, 'inngest', 'plan-' || value,
        case when value <= 100 then now() - interval '1 minute'
          else now() + interval '1 day' end
      from generate_series(1, 50000) as value
    `;
    await database`analyze bakery.outbox`;

    // When PostgreSQL plans pending and expired-lease claims
    const pendingPlan = await database.unsafe(`
      explain (format json, costs off)
      select id from bakery.outbox
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at, created_at, id
      limit 100
    `);
    await database`
      update bakery.outbox
      set status = 'sending', attempt_count = 1,
        replay_deadline_at = now() + interval '24 hours',
        lease_token = gen_random_uuid(),
        lease_until = case when delivery_key like 'plan-1%'
          then now() - interval '1 minute' else now() + interval '1 day' end
    `;
    await database`analyze bakery.outbox`;
    const sendingPlan = await database.unsafe(`
      explain (format json, costs off)
      select id from bakery.outbox
      where status = 'sending' and lease_until <= now()
      order by lease_until, created_at, id
      limit 100
    `);

    // Then both bounded paths use their purpose-built partial indexes
    assertStringIncludes(
      JSON.stringify(pendingPlan),
      "outbox_pending_dispatch_idx",
    );
    assertStringIncludes(
      JSON.stringify(sendingPlan),
      "outbox_sending_dispatch_idx",
    );
  } finally {
    await closePgDatabase(providerDatabase);
    await closeDatabase(database);
  }
});
