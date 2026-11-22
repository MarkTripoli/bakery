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
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import type { Migration } from "../../apps/server/src/platform/migration-definition.ts";
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

/** The migrations the server runs, in boot order: provider first, then Bakery's own. */
async function loadAllTestMigrations(): Promise<
  { provider: Migration[]; bakery: Migration[] }
> {
  return {
    provider: await loadMigrations(betterAuthMigrationSource),
    bakery: [
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
    ],
  };
}

/** Applies every provider, schema and data migration the server runs, in boot order. */
export async function migrateAllTestSchemas(
  owner: Database,
  ownerPg: PgDatabase,
): Promise<void> {
  const migrations = await loadAllTestMigrations();
  await migrateProvider(ownerPg, migrations.provider, {
    beforeApply: preserveProviderInvitationState,
  });
  await migrate(owner, migrations.bakery);
  await migrateData(owner, bakeryDataMigrations);
}

/**
 * A digest of every migration this checkout carries: the version and checksum
 * of each provider and Bakery migration, and the version of each data
 * migration. A baseline is only valid for the code that produced it, so a
 * database that outlives a pull or a branch switch sees a different digest and
 * rebuilds instead of restoring a schema the code no longer migrates to.
 * `extra` adds migrations the checkout does not have, for a test.
 */
export async function codeMigrationsDigest(
  extra: readonly Migration[] = [],
): Promise<string> {
  const migrations = await loadAllTestMigrations();
  const lines = [
    ...migrations.provider.map((m) => `provider:${m.version}:${m.checksum}`),
    ...[...migrations.bakery, ...extra].map((m) =>
      `bakery:${m.version}:${m.checksum}`
    ),
    ...bakeryDataMigrations.map((m) => `data:${m.version}`),
  ];
  return await sha256Bytes(new TextEncoder().encode(lines.join("\n")));
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
  /** The code digest the baseline must match; the checkout's own by default. */
  codeDigest?: string,
): Promise<"restored" | "rebuilt"> {
  const digest = codeDigest ?? await codeMigrationsDigest();
  if (await restoreMigratedBaseline(owner, options, digest)) return "restored";
  await resetTestDatabase(owner, options);
  await migrateAllTestSchemas(owner, ownerPg);
  await captureMigratedBaseline(owner, digest);
  return "rebuilt";
}
