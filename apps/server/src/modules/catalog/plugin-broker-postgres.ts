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
    async load(
      organizationId,
      installId,
      versionId,
    ): Promise<InstallAuthority | null> {
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
      const held = grants.rows.map((grant) => grant.capability);
      if (versionId === undefined) return { status: row.status, grants: held };
      // A job pinned to a version holds only what that version asked for, and
      // only while the install still holds it: the narrower of the two, so
      // revocation still stops it at once and a later widening never reaches it.
      // A version that is not this install's package's, or is gone, asked for
      // nothing.
      const asked = await database.query<{ manifest: unknown }>(
        `select v.manifest
           from bakery.plugin_versions v
           join bakery.plugin_installs i
             on i.organization_id = v.organization_id
            and i.plugin_package_id = v.plugin_package_id
          where v.organization_id = $1 and v.id = $2 and i.id = $3`,
        [organizationId, versionId, installId],
      );
      const requested = (asked.rows[0]?.manifest as
        | { requestedCapabilities?: unknown }
        | undefined)?.requestedCapabilities;
      const allowed = Array.isArray(requested) ? requested : [];
      return {
        status: row.status,
        grants: held.filter((capability) => allowed.includes(capability)),
      };
    },
  };
}
