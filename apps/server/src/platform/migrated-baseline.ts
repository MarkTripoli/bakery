import type { Database } from "./database.ts";
import {
  assertDestructiveResetAllowed,
  PROVIDER_TABLES,
  type TestDatabaseResetOptions,
} from "./migrate.ts";
import { MIGRATION_LOCK_NAME } from "./migration-definition.ts";

/**
 * A fully migrated test database costs minutes to rebuild: dropping the schema
 * and applying every migration for each fixture bloats the shared catalog until
 * autovacuum has to truncate it under an exclusive lock, and the test that is
 * resetting then times out. A test reset therefore migrates once and restores
 * that state afterwards: the first fixture in a database captures the migrated
 * rows in `bakery_baseline`, and later resets truncate the data tables and put
 * those rows back. Every test still starts from the same migrated state; a
 * baseline that no longer matches the database (a different migration ledger or
 * set of tables) is refused and the caller falls back to the full reset.
 */
export const BASELINE_SCHEMA = "bakery_baseline";

type TableRef = { readonly schema: string; readonly name: string };

const LEDGER_TABLES = new Set([
  "bakery.schema_migrations",
  "bakery.data_migrations",
  "public.better_auth_schema_migrations",
]);

const identifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;
const qualified = (table: TableRef): string =>
  `${identifier(table.schema)}.${identifier(table.name)}`;
const key = (table: TableRef): string => `${table.schema}.${table.name}`;

type Queryable = Pick<Database, "unsafe">;

async function dataTables(db: Queryable): Promise<TableRef[]> {
  const provider = PROVIDER_TABLES.map((name) => `'${name}'`).join(", ");
  return await db.unsafe<TableRef[]>(`
    select namespace.nspname as schema, relation.relname as name
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where relation.relkind in ('r', 'p') and not relation.relispartition
      and (namespace.nspname = 'bakery'
        or (namespace.nspname = 'public' and relation.relname in (${provider})))
    order by namespace.nspname, relation.relname`);
}

/** A fingerprint of the three migration ledgers: any applied migration changes it. */
async function ledgerFingerprint(db: Queryable): Promise<string> {
  const present = (await db.unsafe<{ name: string }[]>(`
    select name from (values
      ('bakery.schema_migrations'), ('bakery.data_migrations'),
      ('public.better_auth_schema_migrations')) as ledger(name)
    where to_regclass(name) is not null order by name`)).map((row) => row.name);
  if (present.length === 0) return "";
  const parts = present.map((name) =>
    `select '${name}:' || version_or_row as entry from (
       select to_jsonb(ledger_row)::text as version_or_row from ${name} as ledger_row) as rows`
  );
  const rows = await db.unsafe<{ digest: string }[]>(`
    select md5(coalesce(string_agg(entry, ',' order by entry), '')) as digest
    from (${parts.join(" union all ")}) as entries`);
  return rows[0]?.digest ?? "";
}

async function columnsOf(db: Queryable, table: TableRef): Promise<string> {
  const rows = await db.unsafe<{ name: string }[]>(`
    select attribute.attname as name from pg_attribute as attribute
    where attribute.attrelid = '${qualified(table)}'::regclass
      and attribute.attnum > 0 and not attribute.attisdropped
      and attribute.attgenerated = '' order by attribute.attnum`);
  return rows.map((row) => identifier(row.name)).join(", ");
}

/**
 * Records the migrated state of the database as the baseline later resets
 * restore. Call it right after a full reset and migration, before any test data.
 */
export async function captureMigratedBaseline(db: Database): Promise<void> {
  await db.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK_NAME}::text, 0))`;
    await transaction.unsafe(
      `drop schema if exists ${BASELINE_SCHEMA} cascade`,
    );
    await transaction.unsafe(`create schema ${BASELINE_SCHEMA}`);
    await transaction.unsafe(`
      create table ${BASELINE_SCHEMA}.tables (
        schema_name text not null, table_name text not null,
        is_ledger boolean not null, copy_name text, columns text,
        primary key (schema_name, table_name))`);
    await transaction.unsafe(`
      create table ${BASELINE_SCHEMA}.meta (ledger_fingerprint text not null)`);
    let copies = 0;
    for (const table of await dataTables(transaction)) {
      const ledger = LEDGER_TABLES.has(key(table));
      let copyName: string | null = null;
      let columns: string | null = null;
      if (!ledger) {
        columns = await columnsOf(transaction, table);
        const [{ present }] = await transaction.unsafe<{ present: boolean }[]>(
          `select exists (select 1 from ${qualified(table)}) as present`,
        );
        if (present) {
          copyName = `copy_${copies++}`;
          await transaction.unsafe(
            `create table ${BASELINE_SCHEMA}.${copyName} as select ${columns} from ${
              qualified(table)
            }`,
          );
        }
      }
      await transaction.unsafe(
        `insert into ${BASELINE_SCHEMA}.tables values ($1, $2, $3, $4, $5)`,
        [table.schema, table.name, ledger, copyName, columns],
      );
    }
    await transaction.unsafe(
      `insert into ${BASELINE_SCHEMA}.meta values ($1)`,
      [
        await ledgerFingerprint(transaction),
      ],
    );
  });
}

type BaselineTable = {
  schema_name: string;
  table_name: string;
  is_ledger: boolean;
  copy_name: string | null;
  columns: string | null;
};

/** Seed tables in an order where every row's referenced rows are already back. */
async function insertionOrder(
  db: Queryable,
  tables: readonly BaselineTable[],
): Promise<BaselineTable[]> {
  const edges = await db.unsafe<{ child: string; parent: string }[]>(`
    select child_namespace.nspname || '.' || child.relname as child,
           parent_namespace.nspname || '.' || parent.relname as parent
    from pg_constraint as constraint_row
    join pg_class as child on child.oid = constraint_row.conrelid
    join pg_namespace as child_namespace on child_namespace.oid = child.relnamespace
    join pg_class as parent on parent.oid = constraint_row.confrelid
    join pg_namespace as parent_namespace on parent_namespace.oid = parent.relnamespace
    where constraint_row.contype = 'f'`);
  const wanted = new Set(
    tables.map((table) => `${table.schema_name}.${table.table_name}`),
  );
  const parents = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.child === edge.parent) continue;
    if (!wanted.has(edge.child) || !wanted.has(edge.parent)) continue;
    parents.set(
      edge.child,
      (parents.get(edge.child) ?? new Set()).add(edge.parent),
    );
  }
  const ordered: BaselineTable[] = [];
  const done = new Set<string>();
  let remaining = [...tables];
  while (remaining.length > 0) {
    const ready = remaining.filter((table) =>
      [...(parents.get(`${table.schema_name}.${table.table_name}`) ?? [])]
        .every((parent) => done.has(parent))
    );
    if (ready.length === 0) throw new Error("BASELINE_FOREIGN_KEY_CYCLE");
    for (const table of ready) {
      ordered.push(table);
      done.add(`${table.schema_name}.${table.table_name}`);
    }
    remaining = remaining.filter((table) => !ready.includes(table));
  }
  return ordered;
}

/**
 * Puts the database back to the captured migrated state without dropping or
 * migrating anything. Returns false, having changed nothing, when there is no
 * baseline or it no longer matches the database; the caller then does the full
 * reset and migration.
 */
export async function restoreMigratedBaseline(
  db: Database,
  options: TestDatabaseResetOptions,
): Promise<boolean> {
  await assertDestructiveResetAllowed(db, options);
  const [{ present }] = await db.unsafe<{ present: boolean }[]>(
    `select to_regclass('${BASELINE_SCHEMA}.meta') is not null as present`,
  );
  if (!present) return false;
  return await db.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK_NAME}::text, 0))`;
    const [meta] = await transaction.unsafe<{ ledger_fingerprint: string }[]>(
      `select ledger_fingerprint from ${BASELINE_SCHEMA}.meta`,
    );
    if (meta?.ledger_fingerprint !== await ledgerFingerprint(transaction)) {
      return false;
    }
    const baseline = await transaction.unsafe<BaselineTable[]>(
      `select schema_name, table_name, is_ledger, copy_name, columns from ${BASELINE_SCHEMA}.tables`,
    );
    const current = await dataTables(transaction);
    const known = new Set(
      baseline.map((row) => `${row.schema_name}.${row.table_name}`),
    );
    if (
      current.length !== baseline.length ||
      current.some((table) => !known.has(key(table)))
    ) return false;
    const emptied = current.filter((table) => !LEDGER_TABLES.has(key(table)));
    if (emptied.length > 0) {
      // `restart identity` also returns every sequence a data table owns to its
      // start, which is the migrated state: the schema has no sequence that a
      // table does not own, so none is restored separately.
      await transaction.unsafe(
        `truncate table ${
          emptied.map(qualified).join(", ")
        } restart identity cascade`,
      );
    }
    const seeded = baseline.filter((row) => row.copy_name !== null);
    for (const table of await insertionOrder(transaction, seeded)) {
      const target = qualified({
        schema: table.schema_name,
        name: table.table_name,
      });
      await transaction.unsafe(
        `insert into ${target} (${table.columns}) overriding system value
         select ${table.columns} from ${BASELINE_SCHEMA}.${table.copy_name}`,
      );
    }
    return true;
  });
}
