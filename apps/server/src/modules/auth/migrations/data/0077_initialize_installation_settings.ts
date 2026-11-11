import {
  InstallationSettingsSchema,
  OrganizationCreationPolicy,
  RegistrationMode,
} from "@bakery/contracts/installation-settings";
import {
  type DataMigration,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";

export const initializeInstallationSettings: DataMigration = {
  version: "0077_initialize_installation_settings",
  source: new URL(import.meta.url),
  async run(connection, options): Promise<boolean> {
    return await runDataMigrationBatch(connection, async (transaction) => {
      await transaction`
        insert into bakery.installation_settings (
          id, registration_mode, organization_creation_policy, version,
          updated_by_principal_id, updated_at
        ) values (
          true, ${RegistrationMode.Invitation},
          ${OrganizationCreationPolicy.InstallationAdministrators}, 1,
          null, ${new Date()}
        ) on conflict (id) do nothing
      `;
      const rows = await transaction<{
        id: boolean;
        registrationMode: unknown;
        organizationCreationPolicy: unknown;
        version: unknown;
        updatedByPrincipalId: unknown;
        updatedAt: Date;
      }[]>`
        select id, registration_mode as "registrationMode",
          organization_creation_policy as "organizationCreationPolicy",
          version, updated_by_principal_id as "updatedByPrincipalId",
          updated_at as "updatedAt"
        from bakery.installation_settings order by id for update
      `;
      if (rows.length !== 1 || rows[0].id !== true) {
        throw new Error("INSTALLATION_SETTINGS_SINGLETON_INVALID");
      }
      const { id: _id, ...stored } = rows[0];
      InstallationSettingsSchema.parse({
        ...stored,
        updatedAt: stored.updatedAt.toISOString(),
      });
      return true;
    }, options.beforeCommit);
  },
};
