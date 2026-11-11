import {
  type InstallationSettings,
  InstallationSettingsSchema,
  type InstallationSettingsUpdate,
  InstallationSettingsUpdateSchema,
} from "@bakery/contracts/installation-settings";
import { principalId, PrincipalType } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../../platform/database.ts";
import { createInstallationSettingsReader } from "../application/installation-settings.ts";
import type { AuthenticatedSubject } from "../application/identity.ts";

type SettingsRow = {
  id: boolean;
  registrationMode: string;
  organizationCreationPolicy: string;
  version: number;
  updatedByPrincipalId: string | null;
  updatedAt: Date;
};

export async function readInstallationSettings(
  database: Pick<PgTransactionClient, "query">,
  lock?: "share" | "update",
): Promise<InstallationSettings> {
  const result = await database.query<SettingsRow>(
    `select id, registration_mode as "registrationMode",
      organization_creation_policy as "organizationCreationPolicy",
      version, updated_by_principal_id as "updatedByPrincipalId",
      updated_at as "updatedAt"
    from bakery.installation_settings order by id ${
      lock === "update" ? "for update" : lock === "share" ? "for share" : ""
    }`,
  );
  if (result.rows.length !== 1 || result.rows[0].id !== true) {
    throw new Error("INSTALLATION_SETTINGS_SINGLETON_INVALID");
  }
  const { id: _id, ...row } = result.rows[0];
  return InstallationSettingsSchema.parse({
    ...row,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function createPostgresInstallationSettingsReader(database: PgDatabase) {
  return createInstallationSettingsReader(() =>
    readInstallationSettings(database)
  );
}

export async function lockInstallationPrincipals(
  transaction: PgTransactionClient,
  ids: readonly string[],
): Promise<void> {
  const ordered = [...new Set(ids.map(principalId))].sort();
  await transaction.query(
    `select id from bakery.principals where id = any($1::uuid[])
     order by id for update`,
    [ordered],
  );
  await transaction.query(
    `select principal_id from bakery.installation_administrators
     where principal_id = any($1::uuid[]) order by principal_id for update`,
    [ordered],
  );
}

export async function updateInstallationSettings(
  transaction: PgTransactionClient,
  input: InstallationSettingsUpdate,
  expectedVersion: number,
  updater: string | null,
): Promise<InstallationSettings> {
  const values = InstallationSettingsUpdateSchema.parse(input);
  const current = await readInstallationSettings(transaction, "update");
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  const updated = await transaction.query(
    `update bakery.installation_settings
     set registration_mode = $1, organization_creation_policy = $2,
       version = version + 1, updated_by_principal_id = $3, updated_at = $4
     where id = true and version = $5 returning id`,
    [
      values.registrationMode,
      values.organizationCreationPolicy,
      updater,
      new Date(),
      expectedVersion,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  return await readInstallationSettings(transaction);
}

export async function requireLiveInstallationAdministrator(
  transaction: PgTransactionClient,
  subject: AuthenticatedSubject,
): Promise<void> {
  const result = await transaction.query(
    `select administrator.principal_id
     from bakery.installation_administrators as administrator
     join bakery.principals as principal on principal.id = administrator.principal_id
     where principal.id = $1 and principal.principal_type = $2
       and principal.disabled_at is null and administrator.revoked_at is null`,
    [subject.principalId, PrincipalType.Human],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}
