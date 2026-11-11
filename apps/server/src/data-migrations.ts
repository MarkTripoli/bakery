import type { DataMigration } from "./platform/data-migrate.ts";
import { authDataMigrations } from "./modules/auth/migrations.ts";
import { workDataMigrations } from "./modules/work/migrations.ts";

/**
 * Every module's data migrations. `bakery.data_migrations` is one global ledger
 * with one global version order, so a caller passing only some modules' lists
 * fails with DATA_MIGRATION_REMOVED_FROM_HISTORY or
 * DATA_MIGRATION_ORDER_VIOLATION. Every caller uses this list.
 */
export const bakeryDataMigrations: readonly DataMigration[] = Object.freeze(
  [...workDataMigrations, ...authDataMigrations].sort((left, right) =>
    left.version.localeCompare(right.version)
  ),
);
