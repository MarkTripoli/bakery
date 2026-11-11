import type { BetterAuthOptions } from "better-auth";
import { jwt, organization } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import {
  type Migration,
  MigrationOwner,
  type MigrationSource,
  type ProviderMigrationPreparation,
} from "../../platform/migrate.ts";
import type { PgDatabase } from "../../platform/database.ts";
import type { PoolClient } from "pg";
import { clearLegacyDefaultLocale } from "./migrations/data/0071_clear_legacy_default_locale.ts";
import { initializeInstallationSettings } from "./migrations/data/0077_initialize_installation_settings.ts";

export const betterAuthMigrationSource: MigrationSource = {
  owner: MigrationOwner.BetterAuth,
  root: new URL("./migrations/provider/", import.meta.url),
};

export const authBakeryMigrationSource: MigrationSource = {
  owner: MigrationOwner.Bakery,
  root: new URL("./migrations/bakery/", import.meta.url),
};

export const authDataMigrations = Object.freeze([
  clearLegacyDefaultLocale,
  initializeInstallationSettings,
]);

export const preserveProviderInvitationState: ProviderMigrationPreparation =
  async (
    client: PoolClient,
    migrations: readonly Migration[],
    applied: readonly { version: string; checksum: string }[],
  ) => {
    if (
      applied.some(({ version }) => version === "0003_bakery_authority_columns")
    ) return;
    if (
      !migrations.some(({ version }) =>
        version === "0003_bakery_authority_columns"
      )
    ) return;
    const invitationTable = await client.query<{ exists: boolean }>(
      "select to_regclass('public.invitation') is not null as exists",
    );
    if (!invitationTable.rows[0]?.exists) return;
    await client.query("create schema if not exists bakery");
    await client.query(`
      create table if not exists bakery.provider_invitation_migration_snapshot (
        id uuid primary key,
        organization_id uuid not null,
        email text not null,
        role text,
        status text,
        expires_at timestamptz not null,
        created_at timestamptz not null,
        inviter_provider_user_id uuid
      )
    `);
    await client.query(`
      insert into bakery.provider_invitation_migration_snapshot (
        id, organization_id, email, role, status, expires_at, created_at,
        inviter_provider_user_id
      )
      select id, "organizationId", email, role, status, "expiresAt",
        "createdAt", "inviterId"
      from public.invitation
      on conflict (id) do nothing
    `);
  };

const providerMigrationFile = new URL(
  "./migrations/provider/0001_better_auth.sql",
  import.meta.url,
);
const providerTables = [
  "user",
  "account",
  "session",
  "verification",
  "organization",
  "member",
  "invitation",
] as const;

export async function compileProviderMigration(
  database: PgDatabase,
): Promise<string> {
  const existing = await database.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[])",
    [providerTables],
  );
  if (existing.rowCount !== 0) {
    throw new Error("PROVIDER_MIGRATION_GENERATION_REQUIRES_EMPTY_DATABASE");
  }
  Deno.env.set("FORCE_COLOR", "0");
  const { getMigrations } = await import("better-auth/db/migration");
  // This schema is historical Better Auth state. Keep its plugin set pinned
  // here so removing or changing runtime organization options cannot rewrite
  // the checksum of provider/0001_better_auth.sql.
  const options: BetterAuthOptions = {
    database,
    baseURL: "http://localhost:8788",
    basePath: "/api/auth",
    secret: "migration-generation-only-secret",
    trustedOrigins: ["http://localhost:8788"],
    advanced: { database: { generateId: "uuid" } },
    plugins: [organization()],
  };
  const { compileMigrations } = await getMigrations(
    options,
  );
  return `${(await compileMigrations()).trim()}\n`;
}

export async function writeProviderMigration(
  database: PgDatabase,
): Promise<void> {
  await Deno.writeTextFile(
    providerMigrationFile,
    await compileProviderMigration(database),
  );
}

const oauthProviderMigrationFile = new URL(
  "./migrations/provider/0009_oauth_provider.sql",
  import.meta.url,
);

/**
 * SQL for the OAuth provider tables (`jwks`, `oauthClient`, `oauthResource`,
 * `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`,
 * `oauthConsent`, `oauthClientAssertion`), compiled from the pinned plugin set
 * below. Run against a database that already has provider migrations
 * `0001`..`0008` applied: the generator diffs the live schema, so only the
 * missing tables come out. The set is pinned like the `0001` one so changing
 * runtime provider options can never rewrite the checksum of `0009`.
 */
export async function compileOAuthProviderMigration(
  database: PgDatabase,
): Promise<string> {
  Deno.env.set("FORCE_COLOR", "0");
  const { getMigrations } = await import("better-auth/db/migration");
  const options: BetterAuthOptions = {
    database,
    baseURL: "http://localhost:8788",
    basePath: "/api/auth",
    secret: "migration-generation-only-secret",
    trustedOrigins: ["http://localhost:8788"],
    advanced: { database: { generateId: "uuid" } },
    plugins: [
      organization(),
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        resource: "http://localhost:8788/mcp",
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["bakery:read", "bakery:operate"],
      }),
    ],
  };
  const { compileMigrations } = await getMigrations(options);
  return `${(await compileMigrations()).trim()}\n`;
}

export async function writeOAuthProviderMigration(
  database: PgDatabase,
): Promise<void> {
  await Deno.writeTextFile(
    oauthProviderMigrationFile,
    await compileOAuthProviderMigration(database),
  );
}
