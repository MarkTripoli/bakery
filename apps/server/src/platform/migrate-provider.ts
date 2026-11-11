import type { PoolClient } from "pg";
import type { PgDatabase } from "./database.ts";
import {
  type AppliedMigration,
  AppliedMigrationSchema,
  assertCompleteHistory,
  type Migration,
  MIGRATION_LOCK_NAME,
  MigrationOwner,
  type ProviderMigrationPreparation,
  validateMigrations,
} from "./migration-definition.ts";
import {
  ensureApplicationRole,
  ensureLedgerSafety,
} from "./migration-safety.ts";

async function readProviderMigrations(
  client: PoolClient,
): Promise<readonly AppliedMigration[]> {
  const result = await client.query<{ version: string; checksum: string }>(
    "select version, checksum from public.better_auth_schema_migrations",
  );
  return result.rows.map((row) => AppliedMigrationSchema.parse(row));
}

async function ensureProviderMigrationLedgerSafety(
  client: PoolClient,
): Promise<void> {
  const queryRows = async <T extends Record<string, unknown>>(sql: string) =>
    (await client.query<T>(sql)).rows;
  await ensureLedgerSafety(
    queryRows,
    "public.better_auth_schema_migrations",
    "PROVIDER_SCHEMA_MIGRATIONS_DML_UNSAFE",
  );
}

async function ensureProviderSchemaSafety(client: PoolClient): Promise<void> {
  const database = await client.query<{
    sessionUser: string;
    currentUser: string;
    owner: string;
  }>(`
    select session_user as "sessionUser", current_user as "currentUser",
      datdba::regrole::text as owner
    from pg_database
    where datname = current_database()
  `);
  if (
    database.rowCount !== 1 ||
    database.rows.some((row) => row.owner !== MigrationOwner.Bakery)
  ) {
    throw new Error("BAKERY_DATABASE_OWNER_UNSAFE");
  }
  if (
    database.rows.some((row) =>
      row.sessionUser !== row.owner || row.currentUser !== row.owner
    )
  ) {
    throw new Error("MIGRATION_SESSION_OWNER_UNSAFE");
  }
  const schema = await client.query<{ owner: string; can_create: boolean }>(`
    select nspowner::regrole::text as owner,
      has_schema_privilege('bakery_app', oid, 'CREATE') as can_create
    from pg_namespace
    where nspname = 'public'
  `);
  if (schema.rowCount !== 1 || schema.rows[0].owner === "bakery_app") {
    throw new Error("BAKERY_APP_ROLE_OWNS_PROVIDER_SCHEMA");
  }
  if (schema.rows[0].can_create) {
    throw new Error("BAKERY_APP_PROVIDER_SCHEMA_CREATE_UNSAFE");
  }
}

export async function migrateProvider(
  db: PgDatabase,
  migrations: readonly Migration[],
  options: { beforeApply?: ProviderMigrationPreparation } = {},
): Promise<void> {
  const available = await validateMigrations(
    migrations,
    MigrationOwner.BetterAuth,
  );
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [MIGRATION_LOCK_NAME],
    );
    const queryRows = async <T extends Record<string, unknown>>(sql: string) =>
      (await client.query<T>(sql)).rows;
    await ensureApplicationRole(queryRows);
    await ensureProviderSchemaSafety(client);
    await client.query("select set_config('search_path', 'public', true)");
    await client.query(
      "create table if not exists public.better_auth_schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now())",
    );
    await ensureProviderMigrationLedgerSafety(client);
    const applied = await readProviderMigrations(client);
    const known = new Map(applied.map((row) => [row.version, row.checksum]));
    assertCompleteHistory(applied, available);
    await options.beforeApply?.(client, available, applied);
    const latest = applied.map((row) => row.version).sort().at(-1);
    for (const migration of available) {
      const checksum = known.get(migration.version);
      if (checksum && checksum !== migration.checksum) {
        throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migration.version}`);
      }
      if (checksum) continue;
      if (latest && migration.version <= latest) {
        throw new Error(`MIGRATION_ORDER_VIOLATION:${migration.version}`);
      }
      await client.query(migration.sql);
      await client.query(
        "insert into public.better_auth_schema_migrations (version, checksum) values ($1, $2)",
        [migration.version, migration.checksum],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
