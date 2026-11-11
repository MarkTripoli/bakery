import type { PgDatabase } from "@bakery/persistence";
export {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
  withPgTransaction,
} from "@bakery/persistence";
export type {
  Database,
  PgDatabase,
  PgTransactionClient,
} from "@bakery/persistence";

export async function assertApplicationDatabase(
  database: PgDatabase,
): Promise<void> {
  const result = await database.query<{
    databaseOwner: string;
    sessionUser: string;
    currentUser: string;
    isSuperuser: boolean;
    canCreateDbRole: boolean;
    canReplicate: boolean;
    canCreateDb: boolean;
    canCreateRole: boolean;
    canBypassRls: boolean;
    hasMembership: boolean;
    canCreatePublicSchema: boolean;
    canCreateBakerySchema: boolean;
    ownsSchema: boolean;
    ownsObject: boolean;
    migrationLedgerDmlUnsafe: boolean;
    dataMigrationLedgerDmlUnsafe: boolean;
    providerMigrationLedgerDmlUnsafe: boolean;
    ledgerOwnerUnsafe: boolean;
  }>(`
    with recursive inherited_roles(oid) as (
      select oid
      from pg_roles
      where rolname = 'bakery_app'
      union
      select membership.roleid
      from pg_auth_members as membership
      join inherited_roles as child on child.oid = membership.member
    ), target_schemas as (
      select oid, nspname, nspowner
      from pg_namespace
      where nspname in ('public', 'bakery')
    )
    select datdba::regrole::text as "databaseOwner",
      session_user as "sessionUser", current_user as "currentUser",
      role.rolsuper as "isSuperuser", role.rolcreatedb as "canCreateDbRole",
      role.rolreplication as "canReplicate",
      role.rolcreaterole as "canCreateRole", role.rolbypassrls as "canBypassRls",
      exists (
        select 1
        from inherited_roles
        where oid <> (select oid from pg_roles where rolname = 'bakery_app')
      ) as "hasMembership",
      has_database_privilege('bakery_app', current_database(), 'CREATE') as "canCreateDb",
      coalesce((
        select has_schema_privilege('bakery_app', oid, 'CREATE')
        from target_schemas
        where nspname = 'public'
      ), false) as "canCreatePublicSchema",
      coalesce((
        select has_schema_privilege('bakery_app', oid, 'CREATE')
        from target_schemas
        where nspname = 'bakery'
      ), false) as "canCreateBakerySchema",
      exists (
        select 1
        from target_schemas
        join pg_roles as owner on owner.oid = target_schemas.nspowner
        where owner.rolname = 'bakery_app'
      ) as "ownsSchema",
      exists (
        select 1
        from pg_class
        join pg_roles as owner on owner.oid = pg_class.relowner
        where owner.rolname = 'bakery_app'
      ) as "ownsObject",
      exists (
        select 1
        from (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as requested(privilege)
        where coalesce(has_table_privilege(
          'bakery_app',
          (
            select ledger.oid
            from pg_class as ledger
            join pg_namespace as schema on schema.oid = ledger.relnamespace
            where schema.nspname = 'bakery'
              and ledger.relname = 'schema_migrations'
          ),
          privilege
        ), false) or coalesce(has_any_column_privilege(
          'bakery_app',
          (
            select ledger.oid
            from pg_class as ledger
            join pg_namespace as schema on schema.oid = ledger.relnamespace
            where schema.nspname = 'bakery'
              and ledger.relname = 'schema_migrations'
          ),
          'INSERT,UPDATE'
        ), false)
      ) as "migrationLedgerDmlUnsafe",
      exists (
        select 1
        from (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as requested(privilege)
        where coalesce(has_table_privilege(
          'bakery_app',
          (
            select ledger.oid
            from pg_class as ledger
            join pg_namespace as schema on schema.oid = ledger.relnamespace
            where schema.nspname = 'bakery'
              and ledger.relname = 'data_migrations'
          ),
          privilege
        ), false) or coalesce(has_any_column_privilege(
          'bakery_app',
          (
            select ledger.oid
            from pg_class as ledger
            join pg_namespace as schema on schema.oid = ledger.relnamespace
            where schema.nspname = 'bakery'
              and ledger.relname = 'data_migrations'
          ),
          'INSERT,UPDATE'
        ), false)
      ) as "dataMigrationLedgerDmlUnsafe",
      exists (
        select 1
        from (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as requested(privilege)
        where coalesce(has_table_privilege(
          'bakery_app',
          (
            select ledger.oid
            from pg_class as ledger
            join pg_namespace as schema on schema.oid = ledger.relnamespace
            where schema.nspname = 'public'
              and ledger.relname = 'better_auth_schema_migrations'
          ),
          privilege
        ), false) or coalesce(has_any_column_privilege(
          'bakery_app',
          (
            select ledger.oid
            from pg_class as ledger
            join pg_namespace as schema on schema.oid = ledger.relnamespace
            where schema.nspname = 'public'
              and ledger.relname = 'better_auth_schema_migrations'
          ),
          'INSERT,UPDATE'
        ), false)
      ) as "providerMigrationLedgerDmlUnsafe",
      exists (
        select 1
        from pg_class as ledger
        join pg_namespace as schema on schema.oid = ledger.relnamespace
        join pg_roles as owner on owner.oid = ledger.relowner
        where (schema.nspname, ledger.relname) in (
          ('bakery', 'schema_migrations'),
          ('bakery', 'data_migrations'),
          ('public', 'better_auth_schema_migrations')
        ) and owner.rolname <> 'bakery'
      ) as "ledgerOwnerUnsafe"
    from pg_database
    join pg_roles as role on role.rolname = current_user
    where datname = current_database()
  `);
  const row = result.rows[0];
  if (
    result.rowCount !== 1 ||
    !row ||
    row.databaseOwner !== "bakery" ||
    row.sessionUser !== "bakery_app" ||
    row.currentUser !== "bakery_app" ||
    row.isSuperuser ||
    row.canCreateDbRole ||
    row.canReplicate ||
    row.canCreateDb ||
    row.canCreateRole ||
    row.canBypassRls ||
    row.hasMembership ||
    row.canCreatePublicSchema ||
    row.canCreateBakerySchema ||
    row.ownsSchema ||
    row.ownsObject ||
    row.migrationLedgerDmlUnsafe ||
    row.dataMigrationLedgerDmlUnsafe ||
    row.providerMigrationLedgerDmlUnsafe ||
    row.ledgerOwnerUnsafe
  ) {
    throw new Error("BAKERY_APP_DATABASE_ROLE_UNSAFE");
  }
  const contract = await database.query<{ nullable: "NO" | "YES" }>(`
    select is_nullable as nullable
    from information_schema.columns
    where table_schema = 'bakery'
      and table_name = 'domain_events'
      and column_name = 'organization_sequence'
  `);
  if (
    contract.rowCount !== 1 ||
    contract.rows[0]?.nullable !== "NO"
  ) {
    throw new Error("EVENT_CLOCK_MIGRATION_INCOMPLETE");
  }
  const incomplete = await database.query<{ incomplete: boolean }>(`
    select exists (
      select 1 from bakery.domain_events
      where organization_sequence is null
    ) as incomplete
  `);
  if (incomplete.rows[0]?.incomplete !== false) {
    throw new Error("EVENT_CLOCK_MIGRATION_INCOMPLETE");
  }
}
