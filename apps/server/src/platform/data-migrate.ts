import { z } from "zod";
import type { Database } from "./database.ts";
import { checksumSql, MIGRATION_LOCK_NAME } from "./migration-definition.ts";
import {
  ensureApplicationRole,
  ensureDataMigrationLedgerSafety,
} from "./migration-safety.ts";

export type DataMigrationConnection = Awaited<
  ReturnType<Database["reserve"]>
>;

export type DataMigration = {
  readonly version: string;
  readonly source: URL;
  run(
    connection: DataMigrationConnection,
    options: {
      readonly maxBatches: number;
      readonly beforeCommit?: () => Promise<void>;
    },
  ): Promise<boolean>;
};

const AppliedDataMigrationSchema = z.object({
  version: z.string().regex(/^\d{4}_[a-z0-9_]+$/).describe(
    "Immutable application data-migration version recorded after completion.",
  ),
  checksum: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "SHA-256 checksum of the exact TypeScript migration source that completed.",
  ),
}).strict().describe(
  "Validated application data-migration ledger row.",
);

const DATA_MIGRATION_LOCK_TIMEOUT = "5s";
const DATA_MIGRATION_STATEMENT_TIMEOUT = "30s";
const DEFAULT_MAX_BATCHES = 100;
const DEFAULT_COMPLETION_DEADLINE_MS = 15 * 60 * 1_000;

async function withTransaction<T>(
  connection: DataMigrationConnection,
  operation: (transaction: DataMigrationConnection) => Promise<T>,
  beforeCommit?: () => Promise<void>,
): Promise<T> {
  await connection.unsafe("begin");
  try {
    const result = await operation(connection);
    await beforeCommit?.();
    await connection.unsafe("commit");
    return result;
  } catch (error) {
    await connection.unsafe("rollback");
    throw error;
  }
}
type ApplicationConnectState = {
  readonly publicConnect: boolean;
  readonly applicationConnect: boolean;
};

const APPLICATION_DRAIN_LOCK_NAME = "bakery_application_migration_drain_v1";

export async function hasPendingApplicationDatabaseDrain(
  database: Database,
): Promise<boolean> {
  const tableRows = await database<{ present: boolean }[]>`
    select to_regclass('bakery.application_migration_drain') is not null
      as present
  `;
  if (!tableRows[0]?.present) return false;
  const pendingRows = await database<{ pending: boolean }[]>`
    select exists (
      select 1
      from bakery.application_migration_drain
      where id = 'database'
    ) as pending
  `;
  return pendingRows[0]?.pending ?? false;
}
type CurrentDatabaseStatement =
  | "grant connect on database %I to public"
  | "grant connect on database %I to bakery_app"
  | "revoke connect on database %I from public, bakery_app";

async function executeCurrentDatabaseStatement(
  connection: DataMigrationConnection,
  template: CurrentDatabaseStatement,
): Promise<void> {
  const rows = await connection<{ statement: string }[]>`
    select format(${template}, current_database()) as statement
  `;
  const statement = rows[0]?.statement;
  if (!statement) throw new Error("APPLICATION_DATABASE_NAME_UNAVAILABLE");
  await connection.unsafe(statement);
}

async function readApplicationConnectState(
  connection: DataMigrationConnection,
): Promise<ApplicationConnectState> {
  const rows = await connection<ApplicationConnectState[]>`
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
  const state = rows[0];
  if (!state) throw new Error("APPLICATION_DATABASE_ACL_UNAVAILABLE");
  return state;
}

async function restoreApplicationConnect(
  connection: DataMigrationConnection,
): Promise<void> {
  await withTransaction(connection, async (transaction) => {
    const rows = await transaction<ApplicationConnectState[]>`
      select public_connect as "publicConnect",
        application_connect as "applicationConnect"
      from bakery.application_migration_drain
      where id = 'database'
      for update
    `;
    const state = rows[0];
    if (!state) return;
    if (state.publicConnect) {
      await executeCurrentDatabaseStatement(
        transaction,
        "grant connect on database %I to public",
      );
    }
    if (state.applicationConnect) {
      await executeCurrentDatabaseStatement(
        transaction,
        "grant connect on database %I to bakery_app",
      );
    }
    await transaction`
      delete from bakery.application_migration_drain where id = 'database'
    `;
  });
}

export async function withApplicationDatabaseDrain<T>(
  database: Database,
  operation: () => Promise<T>,
): Promise<T> {
  const connection = await database.reserve();
  let lockAcquired = false;
  let drainActive = false;
  try {
    await connection`
      select pg_advisory_lock(
        hashtextextended(${APPLICATION_DRAIN_LOCK_NAME}::text, 0)
      )
    `;
    lockAcquired = true;
    const existing = await connection<ApplicationConnectState[]>`
      select public_connect as "publicConnect",
        application_connect as "applicationConnect"
      from bakery.application_migration_drain
      where id = 'database'
    `;
    if (existing.length === 0) {
      const state = await readApplicationConnectState(connection);
      await withTransaction(connection, async (transaction) => {
        await transaction`
          insert into bakery.application_migration_drain (
            id, public_connect, application_connect
          ) values ('database', ${state.publicConnect}, ${state.applicationConnect})
        `;
        await executeCurrentDatabaseStatement(
          transaction,
          "revoke connect on database %I from public, bakery_app",
        );
      });
    } else {
      await executeCurrentDatabaseStatement(
        connection,
        "revoke connect on database %I from public, bakery_app",
      );
    }
    drainActive = true;
    const activeRows = await connection<{ active: number }[]>`
      select count(*)::integer as active
      from pg_stat_activity
      where datname = current_database() and usename = 'bakery_app'
    `;
    if ((activeRows[0]?.active ?? 0) !== 0) {
      throw new Error("APPLICATION_DATABASE_DRAIN_REQUIRED");
    }
    return await operation();
  } finally {
    try {
      if (drainActive) await restoreApplicationConnect(connection);
    } finally {
      try {
        if (lockAcquired) {
          await connection`
            select pg_advisory_unlock(
              hashtextextended(${APPLICATION_DRAIN_LOCK_NAME}::text, 0)
            )
          `;
        }
      } finally {
        await connection.release();
      }
    }
  }
}

async function checksumSource(source: URL): Promise<string> {
  return await checksumSql(await Deno.readTextFile(source));
}

export async function migrateData(
  database: Database,
  migrations: readonly DataMigration[],
  options: {
    readonly maxBatches?: number;
    readonly untilComplete?: boolean;
    readonly deadlineMs?: number;
    readonly through?: string;
  } = {},
): Promise<void> {
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new Error("DATA_MIGRATION_BATCH_LIMIT_INVALID");
  }
  const deadlineMs = options.deadlineMs ?? DEFAULT_COMPLETION_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
    throw new Error("DATA_MIGRATION_DEADLINE_INVALID");
  }
  const deadline = performance.now() + deadlineMs;
  const available = await Promise.all(
    migrations.map(async (migration) => ({
      ...migration,
      checksum: await checksumSource(migration.source),
    })),
  );
  available.sort((left, right) => left.version.localeCompare(right.version));
  const versions = new Set<string>();
  for (const migration of available) {
    if (
      !/^\d{4}_[a-z0-9_]+$/.test(migration.version) ||
      versions.has(migration.version)
    ) throw new Error("DATA_MIGRATION_NAME_INVALID");
    versions.add(migration.version);
  }
  if (options.through !== undefined && !versions.has(options.through)) {
    throw new Error("DATA_MIGRATION_BOUNDARY_INVALID");
  }

  const connection = await database.reserve();
  let lockAcquired = false;
  try {
    await connection`select set_config('lock_timeout', ${DATA_MIGRATION_LOCK_TIMEOUT}, false)`;
    await connection`select pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_NAME}::text, 0))`;
    lockAcquired = true;
    const queryRows = <T extends Record<string, unknown>>(
      sql: string,
    ): Promise<readonly T[]> => connection.unsafe<T[]>(sql);
    await ensureApplicationRole(queryRows);
    await ensureDataMigrationLedgerSafety(queryRows);
    const applied = (await connection`
      select version, checksum from bakery.data_migrations order by version
    `).map((row) => AppliedDataMigrationSchema.parse(row));
    if (applied.some(({ version }) => !versions.has(version))) {
      throw new Error("DATA_MIGRATION_REMOVED_FROM_HISTORY");
    }
    const known = new Map(applied.map((row) => [row.version, row.checksum]));
    const latest = applied.at(-1)?.version;
    for (const migration of available) {
      const checksum = known.get(migration.version);
      if (checksum && checksum !== migration.checksum) {
        throw new Error(
          `DATA_MIGRATION_CHECKSUM_MISMATCH:${migration.version}`,
        );
      }
      if (checksum) continue;
      if (
        options.through !== undefined && migration.version > options.through
      ) continue;
      if (latest && migration.version <= latest) {
        throw new Error(`DATA_MIGRATION_ORDER_VIOLATION:${migration.version}`);
      }
      await connection`select set_config('statement_timeout', ${DATA_MIGRATION_STATEMENT_TIMEOUT}, false)`;
      const enforceCompletionDeadline = async (): Promise<void> => {
        if (!options.untilComplete) return;
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          throw new Error(
            `DATA_MIGRATION_DEADLINE_EXCEEDED:${migration.version}`,
          );
        }
        const statementTimeoutMs = Math.max(
          1,
          Math.min(30_000, Math.ceil(remainingMs)),
        );
        await connection`select set_config(
          'statement_timeout',
          ${`${statementTimeoutMs}ms`},
          false
        )`;
        if (performance.now() >= deadline) {
          throw new Error(
            `DATA_MIGRATION_DEADLINE_EXCEEDED:${migration.version}`,
          );
        }
      };
      while (true) {
        await enforceCompletionDeadline();
        let complete: boolean;
        try {
          complete = await migration.run(connection, {
            maxBatches: options.untilComplete ? 1 : maxBatches,
            beforeCommit: options.untilComplete
              ? enforceCompletionDeadline
              : undefined,
          });
        } catch (error) {
          if (options.untilComplete && performance.now() >= deadline) {
            throw new Error(
              `DATA_MIGRATION_DEADLINE_EXCEEDED:${migration.version}`,
              { cause: error },
            );
          }
          throw error;
        }
        if (options.untilComplete && performance.now() >= deadline) {
          throw new Error(
            `DATA_MIGRATION_DEADLINE_EXCEEDED:${migration.version}`,
          );
        }
        if (complete) break;
        if (!options.untilComplete) {
          throw new Error(`DATA_MIGRATION_INCOMPLETE:${migration.version}`);
        }
      }
      try {
        await enforceCompletionDeadline();
        await withTransaction(
          connection,
          async (transaction) => {
            await enforceCompletionDeadline();
            await transaction`
              insert into bakery.data_migrations (
                version, checksum, completed_at
              )
              values (${migration.version}, ${migration.checksum}, now())
            `;
          },
          enforceCompletionDeadline,
        );
      } catch (error) {
        if (options.untilComplete && performance.now() >= deadline) {
          throw new Error(
            `DATA_MIGRATION_DEADLINE_EXCEEDED:${migration.version}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
  } finally {
    try {
      await connection`reset statement_timeout`;
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
}

export async function runDataMigrationBatch<T>(
  connection: DataMigrationConnection,
  operation: (transaction: DataMigrationConnection) => Promise<T>,
  beforeCommit?: () => Promise<void>,
): Promise<T> {
  return await withTransaction(connection, operation, beforeCommit);
}
