import { assertEquals } from "@std/assert";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
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

Deno.test("migration lock timeout does not leak into pooled sessions", async () => {
  const database = openDatabase(databaseUrl, 1);
  const providerDatabase = openPgDatabase(databaseUrl);
  const readLockTimeout = async (): Promise<string> => {
    const connection = await database.reserve();
    try {
      const rows = await connection.unsafe<{ lock_timeout: string }[]>(
        "show lock_timeout",
      );
      return rows[0]?.lock_timeout ?? "";
    } finally {
      await connection.release();
    }
  };
  try {
    await resetTestDatabase(database, {
      targetUrl: databaseUrl,
      ...readTestDatabaseResetOptions(),
    });
    await migrateProvider(
      providerDatabase,
      await loadMigrations(betterAuthMigrationSource),
    );
    const migrations = await loadBakeryMigrations();
    const originalLockTimeout = await readLockTimeout();

    await migrate(database, migrations);
    await migrate(database, migrations);

    assertEquals(await readLockTimeout(), originalLockTimeout);
  } finally {
    await closePgDatabase(providerDatabase);
    await closeDatabase(database);
  }
});
