import { BakeryException } from "@bakery/contracts/exceptions";
import type { PoolClient } from "pg";
import { z } from "zod";

export const MigrationOwner = Object.freeze(
  {
    Bakery: "bakery",
    BetterAuth: "better-auth",
  } as const,
);
export type MigrationOwner =
  (typeof MigrationOwner)[keyof typeof MigrationOwner];
export type MigrationSource = { owner: MigrationOwner; root: URL };
export type Migration = {
  owner: MigrationOwner;
  version: string;
  sql: string;
  checksum: string;
};

export const AppliedMigrationSchema = z.object({
  version: z.string().regex(/^\d{4}_[a-z0-9_]+$/).describe(
    "Immutable migration version read from the database ledger.",
  ),
  checksum: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "Lowercase SHA-256 checksum recorded when the migration was applied.",
  ),
}).strict().describe(
  "Validated migration-ledger row used to enforce append-only history.",
);
export type AppliedMigration = z.infer<typeof AppliedMigrationSchema>;

export type ProviderMigrationPreparation = (
  client: PoolClient,
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
) => Promise<void>;

export const MIGRATION_LOCK_NAME = "bakery:migrations";
export const MigrationMode = Object.freeze(
  {
    Transactional: "transactional",
    NonTransactional: "non-transactional",
  } as const,
);
export type MigrationMode = (typeof MigrationMode)[keyof typeof MigrationMode];
const MIGRATION_MODE_PREFIX = "-- bakery:migration-mode: ";

export const bakeryPlatformMigrationSource: MigrationSource = {
  owner: MigrationOwner.Bakery,
  root: new URL("./migrations/", import.meta.url),
};

export class MigrationOwnershipError extends BakeryException {
  constructor(
    readonly expectedOwner: MigrationOwner,
    readonly actualOwner: string,
    readonly version?: string,
  ) {
    super(
      `MIGRATION_OWNER_MISMATCH:${expectedOwner}:${actualOwner}${
        version ? `:${version}` : ""
      }`,
    );
    this.name = "MigrationOwnershipError";
  }
}

export async function checksumSql(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sql),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function assertMigrationOwner(owner: string): asserts owner is MigrationOwner {
  if (!Object.values(MigrationOwner).includes(owner as MigrationOwner)) {
    throw new MigrationOwnershipError(MigrationOwner.Bakery, owner);
  }
}

export async function loadMigrations(
  source: MigrationSource,
): Promise<Migration[]> {
  assertMigrationOwner(source.owner);
  const result: Migration[] = [];
  for await (const entry of Deno.readDir(source.root)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const version = entry.name.slice(0, -4);
    if (!/^\d{4}_[a-z0-9_]+$/.test(version)) {
      throw new Error("MIGRATION_NAME_INVALID");
    }
    const sql = await Deno.readTextFile(new URL(entry.name, source.root));
    result.push({
      owner: source.owner,
      version,
      sql,
      checksum: await checksumSql(sql),
    });
  }
  return result.sort((a, b) => a.version.localeCompare(b.version));
}

export function migrationMode(sql: string): MigrationMode {
  const firstLine = sql.split("\n", 1)[0];
  if (!firstLine.startsWith(MIGRATION_MODE_PREFIX)) {
    return MigrationMode.Transactional;
  }
  const mode = firstLine.slice(MIGRATION_MODE_PREFIX.length);
  switch (mode) {
    case MigrationMode.Transactional:
    case MigrationMode.NonTransactional:
      return mode;
    default:
      throw new Error(`MIGRATION_MODE_INVALID:${mode}`);
  }
}

export async function validateMigrations(
  migrations: readonly Migration[],
  owner: MigrationOwner,
): Promise<Migration[]> {
  const available = migrations.map((migration) => ({ ...migration }));
  const seen = new Set<string>();
  for (const migration of available) {
    if (migration.owner !== owner) {
      throw new MigrationOwnershipError(
        owner,
        migration.owner,
        migration.version,
      );
    }
    if (
      !/^\d{4}_[a-z0-9_]+$/.test(migration.version) ||
      seen.has(migration.version)
    ) throw new Error("MIGRATION_NAME_INVALID");
    seen.add(migration.version);
    migrationMode(migration.sql);
    if (
      !/^[0-9a-f]{64}$/.test(migration.checksum) ||
      migration.checksum !== await checksumSql(migration.sql)
    ) throw new Error(`MIGRATION_CHECKSUM_INVALID:${migration.version}`);
  }
  return available.sort((a, b) => a.version.localeCompare(b.version));
}

export function assertCompleteHistory(
  applied: readonly AppliedMigration[],
  available: readonly Migration[],
): void {
  const versions = new Set(available.map((migration) => migration.version));
  if (applied.some((row) => !versions.has(row.version))) {
    throw new Error("MIGRATION_REMOVED_FROM_HISTORY");
  }
}
