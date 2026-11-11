import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assertEquals } from "@std/assert";
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
import { workBakeryMigrationSource } from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import {
  readTestDatabaseConfig,
  readTestDatabaseResetOptions,
} from "../../packages/config/src/env.ts";

const { databaseUrl } = readTestDatabaseConfig(Deno.env.toObject(), {
  requireAdmin: true,
});
const SCHEMA_MIGRATION = "0071_organization_default_locale_optional";

Deno.test("legacy default organization locales are cleared once by a versioned data migration", async () => {
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
    const migrations = [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ];
    await migrate(
      owner,
      migrations.filter(({ version }) => version < SCHEMA_MIGRATION),
    );
    const now = new Date();
    const legacyDefault = crypto.randomUUID();
    const legacyChoice = crypto.randomUUID();
    for (const id of [legacyDefault, legacyChoice]) {
      await owner`
        insert into bakery.organizations (
          id, name, slug, metadata, created_at, updated_at, version
        ) values (
          ${id}, 'Locale Org', ${`locale-${id}`}, '{}'::jsonb, ${now}, ${now}, 1
        )`;
    }
    await owner`update bakery.organizations set default_locale = 'fr'
      where id = ${legacyChoice}`;

    await migrate(owner, migrations);
    const locales = async () =>
      Object.fromEntries(
        (await owner<{ id: string; locale: string | null }[]>`
          select id, default_locale as locale from bakery.organizations
          where id in ${owner([legacyDefault, legacyChoice])}`)
          .map(({ id, locale }) => [id, locale]),
      );

    // The schema migration only relaxes the column; it never rewrites rows.
    assertEquals(await locales(), {
      [legacyDefault]: "en",
      [legacyChoice]: "fr",
    });

    await migrateData(owner, bakeryDataMigrations, { untilComplete: true });
    assertEquals(await locales(), {
      [legacyDefault]: null,
      [legacyChoice]: "fr",
    });

    // An Admin choosing "en" afterwards is a choice, and the ledger keeps a
    // second run from clearing it.
    await owner`update bakery.organizations set default_locale = 'en'
      where id = ${legacyDefault}`;
    await migrateData(owner, bakeryDataMigrations, { untilComplete: true });
    assertEquals((await locales())[legacyDefault], "en");
  } finally {
    await closePgDatabase(provider);
    await closeDatabase(owner);
  }
});
