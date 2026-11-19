import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import type {
  Database,
  PgDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  preserveProviderInvitationState,
} from "../../apps/server/src/modules/auth/migrations.ts";
import { workBakeryMigrationSource } from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { artifactKindsBakeryMigrationSource } from "../../apps/server/src/modules/artifact-kinds/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { mcpBakeryMigrationSource } from "../../apps/server/src/modules/mcp/migrations.ts";
import { knowledgeBakeryMigrationSource } from "../../apps/server/src/modules/knowledge/migrations.ts";
import { catalogBakeryMigrationSource } from "../../apps/server/src/modules/catalog/migrations.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
  resetTestDatabase,
  type TestDatabaseResetOptions,
} from "../../apps/server/src/platform/migrate.ts";
import {
  captureMigratedBaseline,
  restoreMigratedBaseline,
} from "../../apps/server/src/platform/migrated-baseline.ts";

/** Applies every provider, schema and data migration the server runs, in boot order. */
export async function migrateAllTestSchemas(
  owner: Database,
  ownerPg: PgDatabase,
): Promise<void> {
  await migrateProvider(
    ownerPg,
    await loadMigrations(betterAuthMigrationSource),
    { beforeApply: preserveProviderInvitationState },
  );
  await migrate(owner, [
    ...await loadMigrations(bakeryPlatformMigrationSource),
    ...await loadMigrations(authBakeryMigrationSource),
    ...await loadMigrations(workBakeryMigrationSource),
    ...await loadMigrations(projectsBakeryMigrationSource),
    ...await loadMigrations(agentsBakeryMigrationSource),
    ...await loadMigrations(repositoryRulesBakeryMigrationSource),
    ...await loadMigrations(artifactKindsBakeryMigrationSource),
    ...await loadMigrations(integrationsBakeryMigrationSource),
    ...await loadMigrations(deliveryBakeryMigrationSource),
    ...await loadMigrations(mcpBakeryMigrationSource),
    ...await loadMigrations(knowledgeBakeryMigrationSource),
    ...await loadMigrations(catalogBakeryMigrationSource),
  ]);
  await migrateData(owner, bakeryDataMigrations);
}

/**
 * Leaves the test database fully migrated and empty of test data. The first
 * call on a database drops it, migrates it and records the migrated state; later
 * calls restore that state with a truncate instead of rebuilding the schema,
 * which keeps the shared catalog from bloating over a long test lane. Tests that
 * exercise migrations themselves keep calling resetTestDatabase directly.
 */
export async function resetToMigratedBaseline(
  owner: Database,
  ownerPg: PgDatabase,
  options: TestDatabaseResetOptions,
): Promise<"restored" | "rebuilt"> {
  if (await restoreMigratedBaseline(owner, options)) return "restored";
  await resetTestDatabase(owner, options);
  await migrateAllTestSchemas(owner, ownerPg);
  await captureMigratedBaseline(owner);
  return "rebuilt";
}
