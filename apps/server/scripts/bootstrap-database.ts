/**
 * Idempotent privileged database bootstrap.
 *
 * Runs as a PostgreSQL superuser before `migrate`. It creates or repairs the
 * roles `bakery` (migration owner), `bakery_app` (runtime) and `inngest`, and
 * the databases `bakery` and `inngest`, with the same attributes as
 * `infra/production/001-roles.sh`.
 *
 * Passwords never leave this process in plaintext: each one is turned into a
 * client-computed SCRAM-SHA-256 verifier and only the verifier is sent, so a
 * failed statement that PostgreSQL writes to its log carries no plaintext.
 * Output is one JSON line without secrets or verifiers.
 */
import {
  closeDatabase,
  type Database,
  openDatabase,
} from "@bakery/persistence";

export const BOOTSTRAP_EVENT = "bakery.database.bootstrap.v1";
export const MINIMUM_SERVER_VERSION_NUM = 150000;
export const SCRAM_ITERATIONS = 4096;
const MAXIMUM_STORED_ITERATIONS = 100_000;
const BOOTSTRAP_LOCK_NAME = "bakery_database_bootstrap_v1";
const SALT_BYTES = 16;
const NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const URI_SAFE_PASSWORD = /^[A-Za-z0-9._~-]+$/;

export class BootstrapError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "BootstrapError";
    this.code = code;
  }
}

export interface BootstrapNames {
  readonly owner: string;
  readonly app: string;
  readonly inngest: string;
  readonly applicationDatabase: string;
  readonly inngestDatabase: string;
}

export const DEFAULT_BOOTSTRAP_NAMES: BootstrapNames = {
  owner: "bakery",
  app: "bakery_app",
  inngest: "inngest",
  applicationDatabase: "bakery",
  inngestDatabase: "inngest",
};

export interface BootstrapPasswords {
  readonly owner: string;
  readonly app: string;
  readonly inngest: string;
}

export function assertUriSafePassword(value: string | undefined): string {
  if (value === undefined || !URI_SAFE_PASSWORD.test(value)) {
    throw new BootstrapError("PASSWORD_MUST_BE_URI_SAFE");
  }
  return value;
}

function assertNames(names: BootstrapNames): void {
  const all = Object.values(names);
  if (!all.every((name) => NAME_PATTERN.test(name))) {
    throw new BootstrapError("BOOTSTRAP_NAME_INVALID");
  }
  if (new Set([names.owner, names.app, names.inngest]).size !== 3) {
    throw new BootstrapError("BOOTSTRAP_ROLE_NAMES_NOT_DISTINCT");
  }
}

// ---------------------------------------------------------------------------
// SCRAM-SHA-256 verifiers (RFC 5802 / RFC 7677, PostgreSQL storage format)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function hmac(
  key: Uint8Array<ArrayBuffer>,
  message: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(message)),
  );
}

export interface ScramKeys {
  readonly storedKey: string;
  readonly serverKey: string;
}

export async function deriveScramKeys(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<ScramKeys> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const salted = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      material,
      256,
    ),
  );
  const clientKey = await hmac(salted, "Client Key");
  const storedKey = new Uint8Array(
    await crypto.subtle.digest("SHA-256", clientKey),
  );
  const serverKey = await hmac(salted, "Server Key");
  return { storedKey: toBase64(storedKey), serverKey: toBase64(serverKey) };
}

export async function scramVerifier(
  password: string,
  options: {
    readonly salt?: Uint8Array<ArrayBuffer>;
    readonly iterations?: number;
  } = {},
): Promise<string> {
  const salt = options.salt ??
    crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iterations = options.iterations ?? SCRAM_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new BootstrapError("SCRAM_ITERATIONS_INVALID");
  }
  const keys = await deriveScramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${
    toBase64(salt)
  }$${keys.storedKey}:${keys.serverKey}`;
}

export interface ParsedScramVerifier extends ScramKeys {
  readonly iterations: number;
  readonly salt: string;
}

const STORED_VERIFIER =
  /^SCRAM-SHA-256\$(\d{1,9}):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/;

export function parseScramVerifier(
  stored: string | null | undefined,
): ParsedScramVerifier | null {
  if (!stored) return null;
  const match = STORED_VERIFIER.exec(stored);
  if (!match) return null;
  return {
    iterations: Number(match[1]),
    salt: match[2]!,
    storedKey: match[3]!,
    serverKey: match[4]!,
  };
}

function equalStrings(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * True when `stored` is a SCRAM-SHA-256 verifier that `password` produces with
 * the stored salt and iteration count. Anything else (null, md5, plaintext,
 * malformed, absurd iteration counts) is a mismatch.
 */
export async function scramVerifierMatches(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parsed = parseScramVerifier(stored);
  if (
    !parsed || parsed.iterations < 1 ||
    parsed.iterations > MAXIMUM_STORED_ITERATIONS
  ) return false;
  let salt: Uint8Array<ArrayBuffer>;
  try {
    salt = fromBase64(parsed.salt);
  } catch {
    return false;
  }
  const keys = await deriveScramKeys(password, salt, parsed.iterations);
  return equalStrings(keys.storedKey, parsed.storedKey) &&
    equalStrings(keys.serverKey, parsed.serverKey);
}

// ---------------------------------------------------------------------------
// Pure statement planning
// ---------------------------------------------------------------------------

export interface RoleAttributes {
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly replication: boolean;
  readonly bypassRowSecurity: boolean;
}

export const REQUIRED_ROLE_ATTRIBUTES: RoleAttributes = {
  canLogin: true,
  superuser: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  bypassRowSecurity: false,
};

const ATTRIBUTE_CLAUSES: readonly (readonly [keyof RoleAttributes, string])[] =
  [
    ["canLogin", "login"],
    ["superuser", "superuser"],
    ["createDatabase", "createdb"],
    ["createRole", "createrole"],
    ["replication", "replication"],
    ["bypassRowSecurity", "bypassrls"],
  ];

function attributeClauses(
  wanted: RoleAttributes,
  only?: RoleAttributes,
): string[] {
  const clauses: string[] = [];
  for (const [key, keyword] of ATTRIBUTE_CLAUSES) {
    if (only && only[key] === wanted[key]) continue;
    clauses.push(wanted[key] ? keyword : `no${keyword}`);
  }
  return clauses;
}

export interface RoleObservation {
  /** Present when the role exists, with its current attributes. */
  readonly attributes?: RoleAttributes;
  /** True when the stored password is the SCRAM verifier of the wanted one. */
  readonly passwordCurrent: boolean;
}

export interface DatabaseObservation {
  /** Present when the database exists. */
  readonly owner?: string;
}

export interface BootstrapObservation {
  readonly owner: RoleObservation;
  readonly app: RoleObservation;
  readonly inngest: RoleObservation;
  readonly appHasMemberships: boolean;
  readonly applicationDatabase: DatabaseObservation;
  readonly inngestDatabase: DatabaseObservation;
  readonly applicationConnectGranted: boolean;
  /** A migration drain row exists: the drain owns CONNECT until it restores it. */
  readonly drainPending: boolean;
}

export interface BootstrapStatement {
  readonly change: string;
  /** A PostgreSQL `format()` template. Identifiers and literals are `%I`/`%L`. */
  readonly text: string;
  readonly params: readonly string[];
}

export interface BootstrapPlanInput {
  readonly names: BootstrapNames;
  readonly observation: BootstrapObservation;
  /** SCRAM verifiers, never plaintext. Used only where the password is not current. */
  readonly verifiers: BootstrapPasswords;
}

function roleStatements(
  name: string,
  observation: RoleObservation,
  verifier: string,
): BootstrapStatement[] {
  if (!observation.attributes) {
    return [{
      change: `role:${name}:created`,
      text: `create role %I ${
        attributeClauses(REQUIRED_ROLE_ATTRIBUTES).join(" ")
      } password %L`,
      params: [name, verifier],
    }];
  }
  const statements: BootstrapStatement[] = [];
  const differing = attributeClauses(
    REQUIRED_ROLE_ATTRIBUTES,
    observation.attributes,
  );
  if (differing.length > 0) {
    statements.push({
      change: `role:${name}:attributes`,
      text: `alter role %I ${differing.join(" ")}`,
      params: [name],
    });
  }
  if (!observation.passwordCurrent) {
    statements.push({
      change: `role:${name}:password`,
      text: "alter role %I password %L",
      params: [name, verifier],
    });
  }
  return statements;
}

function databaseStatements(
  name: string,
  owner: string,
  observation: DatabaseObservation,
): BootstrapStatement[] {
  if (observation.owner === undefined) {
    return [{
      change: `database:${name}:created`,
      text: "create database %I owner %I",
      params: [name, owner],
    }];
  }
  if (observation.owner !== owner) {
    return [{
      change: `database:${name}:owner`,
      text: "alter database %I owner to %I",
      params: [name, owner],
    }];
  }
  return [];
}

export function buildBootstrapStatements(
  input: BootstrapPlanInput,
): BootstrapStatement[] {
  const { names, observation, verifiers } = input;
  assertNames(names);
  if (observation.appHasMemberships) {
    throw new BootstrapError("BAKERY_APP_ROLE_MEMBERSHIP_UNSAFE");
  }
  const statements = [
    ...roleStatements(names.owner, observation.owner, verifiers.owner),
    ...roleStatements(names.app, observation.app, verifiers.app),
    ...roleStatements(names.inngest, observation.inngest, verifiers.inngest),
    ...databaseStatements(
      names.applicationDatabase,
      names.owner,
      observation.applicationDatabase,
    ),
    ...databaseStatements(
      names.inngestDatabase,
      names.inngest,
      observation.inngestDatabase,
    ),
  ];
  if (!observation.applicationConnectGranted && !observation.drainPending) {
    statements.push({
      change: `database:${names.applicationDatabase}:connect:${names.app}`,
      text: "grant connect on database %I to %I",
      params: [names.applicationDatabase, names.app],
    });
  }
  return statements;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Sql = Database;

export interface BootstrapOptions {
  readonly passwords: BootstrapPasswords;
  readonly names?: BootstrapNames;
  /**
   * Opens a new superuser connection to another database of the same server.
   * The bootstrap closes it after reading the migration drain state.
   */
  readonly openDatabase: (database: string) => Sql;
}

export interface BootstrapResult {
  readonly event: typeof BOOTSTRAP_EVENT;
  readonly changes: readonly string[];
  readonly serverVersionNum: number;
}

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolpassword: string | null;
}

async function observeRole(
  row: RoleRow | undefined,
  password: string,
): Promise<RoleObservation> {
  if (!row) return { passwordCurrent: false };
  return {
    attributes: {
      canLogin: row.rolcanlogin,
      superuser: row.rolsuper,
      createDatabase: row.rolcreatedb,
      createRole: row.rolcreaterole,
      replication: row.rolreplication,
      bypassRowSecurity: row.rolbypassrls,
    },
    passwordCurrent: await scramVerifierMatches(password, row.rolpassword),
  };
}

async function observeDrain(
  databaseExists: boolean,
  openDatabase: (database: string) => Sql,
  database: string,
): Promise<boolean> {
  if (!databaseExists) return false;
  const connection = openDatabase(database);
  try {
    const table = await connection<{ present: boolean }[]>`
      select to_regclass('bakery.application_migration_drain') is not null
        as present
    `;
    if (!table[0]?.present) return false;
    const rows = await connection<{ pending: boolean }[]>`
      select exists (
        select 1 from bakery.application_migration_drain
      ) as pending
    `;
    return rows[0]?.pending ?? false;
  } finally {
    await closeDatabase(connection);
  }
}

export async function bootstrapDatabase(
  sql: Sql,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const names = options.names ?? DEFAULT_BOOTSTRAP_NAMES;
  assertNames(names);
  for (const password of Object.values(options.passwords)) {
    assertUriSafePassword(password);
  }
  const version = await sql<{ version: number }[]>`
    select current_setting('server_version_num')::integer as version
  `;
  const serverVersionNum = version[0]?.version ?? 0;
  if (serverVersionNum < MINIMUM_SERVER_VERSION_NUM) {
    throw new BootstrapError("POSTGRES_VERSION_UNSUPPORTED");
  }
  const privileged = await sql<{ rolsuper: boolean }[]>`
    select rolsuper from pg_roles where rolname = current_user
  `;
  if (!privileged[0]?.rolsuper) {
    throw new BootstrapError("BOOTSTRAP_SUPERUSER_REQUIRED");
  }
  await sql`
    select pg_advisory_lock(hashtextextended(${BOOTSTRAP_LOCK_NAME}::text, 0))
  `;
  try {
    const roleRows = await sql<RoleRow[]>`
      select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
        rolreplication, rolbypassrls, rolpassword
      from pg_authid
      where rolname in ${sql([names.owner, names.app, names.inngest])}
    `;
    const rolesByName = new Map(roleRows.map((row) => [row.rolname, row]));
    const memberships = await sql<{ present: boolean }[]>`
      select exists (
        select 1
        from pg_auth_members as membership
        join pg_roles as member on member.oid = membership.member
        where member.rolname = ${names.app}
      ) as present
    `;
    const databaseRows = await sql<{ datname: string; owner: string }[]>`
      select datname, pg_get_userbyid(datdba) as owner
      from pg_database
      where datname in ${
      sql([names.applicationDatabase, names.inngestDatabase])
    }
    `;
    const databasesByName = new Map(
      databaseRows.map((row) => [row.datname, row.owner]),
    );
    const granted = await sql<{ granted: boolean }[]>`
      select exists (
        select 1
        from pg_database as database
        cross join lateral aclexplode(
          coalesce(database.datacl, acldefault('d', database.datdba))
        ) as acl
        join pg_roles as role on role.oid = acl.grantee
        where database.datname = ${names.applicationDatabase}
          and role.rolname = ${names.app}
          and acl.privilege_type = 'CONNECT'
      ) as granted
    `;
    const drainPending = await observeDrain(
      databasesByName.has(names.applicationDatabase),
      options.openDatabase,
      names.applicationDatabase,
    );
    const verifiers: BootstrapPasswords = {
      owner: await scramVerifier(options.passwords.owner),
      app: await scramVerifier(options.passwords.app),
      inngest: await scramVerifier(options.passwords.inngest),
    };
    const statements = buildBootstrapStatements({
      names,
      verifiers,
      observation: {
        owner: await observeRole(
          rolesByName.get(names.owner),
          options.passwords.owner,
        ),
        app: await observeRole(
          rolesByName.get(names.app),
          options.passwords.app,
        ),
        inngest: await observeRole(
          rolesByName.get(names.inngest),
          options.passwords.inngest,
        ),
        appHasMemberships: memberships[0]?.present ?? false,
        applicationDatabase: {
          owner: databasesByName.get(names.applicationDatabase),
        },
        inngestDatabase: { owner: databasesByName.get(names.inngestDatabase) },
        applicationConnectGranted: granted[0]?.granted ?? false,
        drainPending,
      },
    });
    for (const statement of statements) {
      const placeholders = statement.params
        .map((_, index) => `$${index + 2}::text`)
        .join(", ");
      const formatted = await sql.unsafe<{ statement: string }[]>(
        `select format($1::text, ${placeholders}) as statement`,
        [statement.text, ...statement.params],
      );
      const text = formatted[0]?.statement;
      if (!text) throw new BootstrapError("BOOTSTRAP_STATEMENT_UNAVAILABLE");
      await sql.unsafe(text);
    }
    return {
      event: BOOTSTRAP_EVENT,
      changes: statements.map((statement) => statement.change),
      serverVersionNum,
    };
  } finally {
    await sql`
      select pg_advisory_unlock(
        hashtextextended(${BOOTSTRAP_LOCK_NAME}::text, 0)
      )
    `;
  }
}

async function main(): Promise<void> {
  const url = Deno.env.get("BAKERY_BOOTSTRAP_DATABASE_URL");
  if (!url) throw new BootstrapError("BAKERY_BOOTSTRAP_DATABASE_URL_REQUIRED");
  const passwords: BootstrapPasswords = {
    owner: assertUriSafePassword(Deno.env.get("BAKERY_OWNER_PASSWORD")),
    app: assertUriSafePassword(Deno.env.get("BAKERY_APP_PASSWORD")),
    inngest: assertUriSafePassword(
      Deno.env.get("BAKERY_INNGEST_DATABASE_PASSWORD"),
    ),
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BootstrapError("BAKERY_BOOTSTRAP_DATABASE_URL_INVALID");
  }
  const sql = openDatabase(url, 1);
  try {
    const result = await bootstrapDatabase(sql, {
      passwords,
      openDatabase: (database) => {
        const target = new URL(parsed);
        target.pathname = `/${encodeURIComponent(database)}`;
        return openDatabase(target.toString(), 1);
      },
    });
    console.log(JSON.stringify(result));
  } finally {
    await closeDatabase(sql);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof BootstrapError
      ? error.code
      : error instanceof Error
      ? `BOOTSTRAP_FAILED:${error.message}`
      : "BOOTSTRAP_FAILED";
    console.error(JSON.stringify({ event: BOOTSTRAP_EVENT, error: code }));
    Deno.exit(error instanceof BootstrapError ? 78 : 1);
  }
}
