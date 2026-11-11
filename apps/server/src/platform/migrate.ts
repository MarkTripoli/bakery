import type { Database } from "./database.ts";
import {
  type AppliedMigration,
  AppliedMigrationSchema,
  assertCompleteHistory,
  type Migration,
  MIGRATION_LOCK_NAME,
  MigrationMode,
  migrationMode,
  MigrationOwner,
  validateMigrations,
} from "./migration-definition.ts";
import {
  ensureApplicationRole,
  ensureMigrationLedgerSafety,
} from "./migration-safety.ts";

export {
  bakeryPlatformMigrationSource,
  checksumSql,
  loadMigrations,
  MigrationOwner,
  MigrationOwnershipError,
} from "./migration-definition.ts";
export type {
  Migration,
  MigrationSource,
  ProviderMigrationPreparation,
} from "./migration-definition.ts";
export { migrateProvider } from "./migrate-provider.ts";

type ReservedDatabase = Awaited<ReturnType<Database["reserve"]>>;
const MIGRATION_LOCK_TIMEOUT = "5s";
const MIGRATION_STATEMENT_TIMEOUT = "30s";

async function withReservedTransaction<T>(
  connection: ReservedDatabase,
  operation: (transaction: ReservedDatabase) => Promise<T>,
): Promise<T> {
  await connection.unsafe("begin");
  try {
    const result = await operation(connection);
    await connection.unsafe("commit");
    return result;
  } catch (error) {
    await connection.unsafe("rollback");
    throw error;
  }
}

export function assertMigrationAppendOrder(
  version: string,
  latest: string | undefined,
): void {
  if (latest && version <= latest) {
    throw new Error(`MIGRATION_ORDER_VIOLATION:${version}`);
  }
}

export async function migrate(
  db: Database,
  migrations: readonly Migration[],
  options: {
    readonly through?: string;
    readonly manageApplicationConnect?: boolean;
  } = {},
): Promise<void> {
  const available = await validateMigrations(migrations, MigrationOwner.Bakery);
  const connection = await db.reserve();
  let lockAcquired = false;
  try {
    await connection`select set_config('lock_timeout', ${MIGRATION_LOCK_TIMEOUT}, false)`;
    await connection`select pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_NAME}::text, 0))`;
    lockAcquired = true;
    const applied = await withReservedTransaction(
      connection,
      async (transaction) => {
        const queryRows = <T extends Record<string, unknown>>(
          sql: string,
        ): Promise<readonly T[]> => transaction.unsafe<T[]>(sql);
        await ensureApplicationRole(queryRows);
        if (options.manageApplicationConnect !== false) {
          await transaction.unsafe(`
            do $grant_connect$
            begin
              execute format(
                'grant connect on database %I to bakery_app',
                current_database()
              );
            end
            $grant_connect$;
          `);
        }
        await transaction`create schema if not exists bakery`;
        await transaction`create table if not exists bakery.schema_migrations (version text primary key, checksum text not null, applied_at timestamptz not null default now())`;
        await ensureMigrationLedgerSafety(queryRows);
        const appliedRows = await transaction<AppliedMigration[]>`
        select version, checksum from bakery.schema_migrations
      `;
        const applied = appliedRows.map((row) =>
          AppliedMigrationSchema.parse(row)
        );
        assertCompleteHistory(applied, available);
        return applied;
      },
    );
    if (
      options.through !== undefined &&
      !available.some(({ version }) => version === options.through)
    ) {
      throw new Error(`MIGRATION_BOUNDARY_UNKNOWN:${options.through}`);
    }
    const known = new Map(applied.map((row) => [row.version, row.checksum]));
    const latest = applied.map((row) => row.version).sort().at(-1);
    for (const migration of available) {
      if (
        options.through !== undefined &&
        migration.version > options.through
      ) break;
      const checksum = known.get(migration.version);
      if (checksum && checksum !== migration.checksum) {
        throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migration.version}`);
      }
      if (checksum) continue;
      assertMigrationAppendOrder(migration.version, latest);
      const mode = migrationMode(migration.sql);
      if (mode === MigrationMode.Transactional) {
        await withReservedTransaction(connection, async (transaction) => {
          await transaction`select set_config('lock_timeout', ${MIGRATION_LOCK_TIMEOUT}, true)`;
          await transaction`select set_config('statement_timeout', ${MIGRATION_STATEMENT_TIMEOUT}, true)`;
          await transaction.unsafe(migration.sql);
          await transaction`insert into bakery.schema_migrations (version, checksum) values (${migration.version}, ${migration.checksum})`;
        });
        continue;
      }
      await applyNonTransactionalMigration(connection, migration);
      await connection`
        insert into bakery.schema_migrations (version, checksum)
        values (${migration.version}, ${migration.checksum})
      `;
    }
    await withReservedTransaction(connection, async (transaction) => {
      await transaction`grant usage on schema bakery to bakery_app`;
      await transaction`revoke insert, update, delete, truncate on bakery.schema_migrations from bakery_app`;
    });
  } finally {
    try {
      if (lockAcquired) {
        await connection`
          select pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_NAME}::text, 0))
        `;
      }
    } finally {
      try {
        await connection`reset lock_timeout`;
      } finally {
        await connection.release();
      }
    }
  }
}

async function applyNonTransactionalMigration(
  connection: ReservedDatabase,
  migration: Migration,
): Promise<void> {
  const statements = migration.sql.split(";").map((statement) =>
    statement.trim()
  )
    .filter((statement) => statement.length > 0);
  await connection`select set_config('statement_timeout', ${MIGRATION_STATEMENT_TIMEOUT}, false)`;
  try {
    for (const statement of statements) await connection.unsafe(statement);
    const indexNames = [...migration.sql.matchAll(
      /create\s+(?:unique\s+)?index\s+concurrently\s+([a-z0-9_]+)/gi,
    )].map((match) => match[1]).filter((name) => name !== undefined);
    for (const indexName of indexNames) {
      const rows = await connection<{ valid: boolean }[]>`
        select index.indisvalid as valid
        from pg_class as relation
        join pg_namespace as namespace on namespace.oid = relation.relnamespace
        join pg_index as index on index.indexrelid = relation.oid
        where namespace.nspname = 'bakery' and relation.relname = ${indexName}
      `;
      if (rows.length !== 1 || rows[0]?.valid !== true) {
        throw new Error(`MIGRATION_INDEX_POSTCONDITION_FAILED:${indexName}`);
      }
    }
  } finally {
    await connection`reset statement_timeout`;
  }
}

/** True for a bare loopback host address; null/empty (unix socket) passes. */
export function isLoopbackServerAddress(
  address: string | null | undefined,
): boolean {
  if (!address) return true;
  return address === "127.0.0.1" || address === "::1";
}

/**
 * The address the server accepted this connection on. host() strips the prefix
 * length that inet::text appends ("127.0.0.1/32"); null for a unix socket.
 */
export async function readServerAddress(
  db: Database,
): Promise<string | null | undefined> {
  const server = await db`select host(inet_server_addr()) as address`;
  return server[0]?.address;
}

export async function resetTestDatabase(
  db: Database,
  options: {
    targetUrl: string;
    confirmation?: string;
    allowRemote?: boolean;
  },
): Promise<void> {
  if (options.confirmation !== "RESET_BAKERY_TEST_DATABASE") {
    throw new Error("DESTRUCTIVE_RESET_REQUIRES_CONFIRMATION");
  }
  const target = new URL(options.targetUrl);
  const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];
  if (!loopbackHosts.includes(target.hostname) && !options.allowRemote) {
    throw new Error("DESTRUCTIVE_RESET_REQUIRES_LOOPBACK");
  }
  if (
    !isLoopbackServerAddress(await readServerAddress(db)) &&
    !options.allowRemote
  ) throw new Error("DESTRUCTIVE_RESET_REQUIRES_LOOPBACK");
  await db.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK_NAME}::text, 0))`;
    await transaction`drop table if exists
      public.session,
      public.account,
      public.verification,
      public.member,
      public.invitation,
      public.organization,
      public."twoFactor",
      public."rateLimit",
      public.passkey,
      public."ssoProvider",
      public.jwks,
      public."oauthClientAssertion",
      public."oauthAccessToken",
      public."oauthRefreshToken",
      public."oauthConsent",
      public."oauthClientResource",
      public."oauthResource",
      public."oauthClient",
      public."scimGroupMember",
      public."scimGroup",
      public."scimProjectionGrant",
      public."scimUser",
      public."scimSubject",
      public."scimIdentityTombstone",
      public."scimConnectionBinding",
      public."user",
      public.better_auth_schema_migrations
      cascade`;
    await transaction`drop schema if exists bakery cascade`;
  });
}
