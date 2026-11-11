import { MigrationOwner } from "./migration-definition.ts";

export type RoleSafetyQuery = <T extends Record<string, unknown>>(
  sql: string,
) => Promise<readonly T[]>;

export async function ensureApplicationRole(
  query: RoleSafetyQuery,
): Promise<void> {
  const exists = await query(
    "select 1 from pg_roles where rolname = 'bakery_app'",
  );
  if (exists.length === 0) {
    throw new Error("BAKERY_APP_ROLE_MISSING_RUN_PRIVILEGED_BOOTSTRAP");
  }
  const safe = await query(
    "select 1 from pg_roles where rolname = 'bakery_app' and not rolsuper and not rolcreatedb and not rolcreaterole and not rolbypassrls and not rolreplication",
  );
  if (safe.length === 0) throw new Error("BAKERY_APP_ROLE_UNSAFE");
  const memberships = await query(
    "select 1 from pg_auth_members m join pg_roles member on member.oid = m.member where member.rolname = 'bakery_app'",
  );
  if (memberships.length > 0) {
    throw new Error("BAKERY_APP_ROLE_MEMBERSHIP_UNSAFE");
  }
  const database = await query<{
    sessionUser: string;
    currentUser: string;
    database: string;
    owner: string;
    can_create: boolean;
  }>(`
    select session_user as "sessionUser",
      current_user as "currentUser",
      current_database() as database,
      datdba::regrole::text as owner,
      has_database_privilege('bakery_app', current_database(), 'CREATE') as can_create
    from pg_database
    where datname = current_database()
  `);
  if (
    database.length !== 1 ||
    database.some((row) => row.owner !== MigrationOwner.Bakery)
  ) {
    throw new Error("BAKERY_DATABASE_OWNER_UNSAFE");
  }
  if (
    database.some((row) =>
      row.sessionUser !== row.owner || row.currentUser !== row.owner
    )
  ) {
    throw new Error("MIGRATION_SESSION_OWNER_UNSAFE");
  }
  if (database.some((row) => row.can_create)) {
    throw new Error("BAKERY_APP_DATABASE_CREATE_UNSAFE");
  }
  const owned = await query(
    "select 1 from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = 'bakery_app' limit 1",
  );
  if (owned.length > 0) throw new Error("BAKERY_APP_ROLE_OWNS_OBJECT");
  const schema = await query<{ owner: string; can_create: boolean }>(`
    select n.nspowner::regrole::text as owner,
      has_schema_privilege('bakery_app', n.oid, 'CREATE') as can_create
    from pg_namespace n
    where n.nspname = 'bakery'
  `);
  if (schema.some((row) => row.owner === "bakery_app")) {
    throw new Error("BAKERY_APP_ROLE_OWNS_SCHEMA");
  }
  if (schema.some((row) => row.can_create)) {
    throw new Error("BAKERY_APP_SCHEMA_CREATE_UNSAFE");
  }
}

export async function ensureMigrationLedgerSafety(
  query: RoleSafetyQuery,
): Promise<void> {
  await ensureLedgerSafety(
    query,
    "bakery.schema_migrations",
    "SCHEMA_MIGRATIONS_DML_UNSAFE",
  );
}

export async function ensureDataMigrationLedgerSafety(
  query: RoleSafetyQuery,
): Promise<void> {
  await ensureLedgerSafety(
    query,
    "bakery.data_migrations",
    "DATA_MIGRATIONS_DML_UNSAFE",
  );
}

export async function ensureLedgerSafety(
  query: RoleSafetyQuery,
  table: string,
  errorCode: string,
): Promise<void> {
  const unsafe = await query<{ grantee: string; privilege: string }>(`
    with ledger as (
      select relation.relowner, relation.relacl
      from pg_class as relation
      where relation.oid = '${table}'::regclass
    ), unsafe as (
      select coalesce(grantee.rolname, 'public') as grantee,
        privilege.privilege_type as privilege
      from ledger
      cross join lateral unnest(
        coalesce(ledger.relacl, acldefault('r', ledger.relowner))
      ) as acl(acl_item)
      cross join lateral aclexplode(array[acl.acl_item]) as privilege
      left join pg_roles as grantee on grantee.oid = privilege.grantee
      where privilege.grantee <> ledger.relowner
        and privilege.privilege_type in (
          'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'
        )
      union
      select coalesce(grantee.rolname, 'public') as grantee,
        privilege.privilege_type as privilege
      from ledger
      join pg_attribute as attribute
        on attribute.attrelid = '${table}'::regclass
        and attribute.attnum > 0 and not attribute.attisdropped
      cross join lateral unnest(attribute.attacl) as acl(acl_item)
      cross join lateral aclexplode(array[acl.acl_item]) as privilege
      left join pg_roles as grantee on grantee.oid = privilege.grantee
      where privilege.grantee <> ledger.relowner
        and privilege.privilege_type in ('INSERT', 'UPDATE')
      union
      select owner.rolname as grantee, 'OWNER' as privilege
      from ledger
      join pg_roles as owner on owner.oid = ledger.relowner
      where owner.rolname <> '${MigrationOwner.Bakery}'
    )
    select grantee, privilege
    from unsafe
    order by grantee, privilege
  `);
  if (unsafe.length > 0) {
    throw new Error(
      `${errorCode}:${
        unsafe.map((row) => `${row.grantee}:${row.privilege}`).join(",")
      }`,
    );
  }
}
