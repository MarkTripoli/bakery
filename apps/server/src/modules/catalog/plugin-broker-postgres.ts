import type { PgDatabase } from "../../platform/database.ts";
import type {
  InstallAuthority,
  InstallAuthorityPort,
} from "./plugin-broker.ts";

type Reader = Pick<PgDatabase, "query">;

/**
 * The broker's view of an install, read from the tables that own it on every
 * call (#29). Nothing is cached here: `disabled` and `uninstalled` already
 * delete the install's grants in the same transaction, so a read after that
 * transaction commits sees no authority at all.
 */
export function createPostgresInstallAuthority(
  database: Reader,
): InstallAuthorityPort {
  return {
    async load(organizationId, installId): Promise<InstallAuthority | null> {
      const installs = await database.query<{ status: string }>(
        `select status from bakery.plugin_installs
          where organization_id = $1 and id = $2`,
        [organizationId, installId],
      );
      const row = installs.rows[0];
      if (row === undefined) return null;
      if (
        row.status !== "enabled" && row.status !== "disabled" &&
        row.status !== "uninstalled"
      ) return null;
      const grants = await database.query<{ capability: string }>(
        `select capability from bakery.plugin_install_grants
          where organization_id = $1 and plugin_install_id = $2`,
        [organizationId, installId],
      );
      return {
        status: row.status,
        grants: grants.rows.map((grant) => grant.capability),
      };
    },
  };
}
