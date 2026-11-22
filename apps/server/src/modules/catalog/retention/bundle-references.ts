import type { PgTransactionClient } from "@bakery/persistence";

/**
 * Every reference that can keep a plugin bundle's bytes alive, with the
 * protection class collection reads.
 *
 * The artifact collector has the same table for artifact versions
 * (`knowledge/retention/references.ts`), and its rail asserts that no foreign
 * key to `artifact_versions` reaches a migration unclassified. This is the
 * plugin half of that arrangement: without it a bundle is bytes in the object
 * store that no policy names, which is what "retained state follows policy"
 * was missing for #15.
 *
 * Protection classes, matching the artifact vocabulary:
 *
 * - `active` — the reference keeps the bytes until it is gone. An install is
 *   the whole reason a bundle exists, and a disabled install may be re-enabled,
 *   so a disabled row still pins its version.
 * - `none` — the reference is a pointer that dies with the version and never
 *   keeps bytes alive on its own.
 */
export const pluginBundleReferences = [
  {
    kind: "active-install",
    table: "plugin_installs",
    constraint: "plugin_installs_package_version_fk",
    protection: "active",
    async protects(
      transaction: PgTransactionClient,
      organizationId: string,
      versionId: string,
    ): Promise<boolean> {
      // An uninstalled row is finished: reactivating it is refused, so it
      // cannot want the bytes back and must not pin them. Every other status
      // can still reach the archive - staged, enabled and disabled all install
      // or re-enable the same version.
      const result = await transaction.query(
        `select 1 from bakery.plugin_installs
         where organization_id = $1 and plugin_version_id = $2
           and status <> 'uninstalled'
         limit 1`,
        [organizationId, versionId],
      );
      return result.rows.length > 0;
    },
  },
  {
    kind: "install-snapshot",
    table: "plugin_install_snapshots",
    constraint: "plugin_install_snapshots_version_fk",
    protection: "active",
    async protects(
      transaction: PgTransactionClient,
      organizationId: string,
      versionId: string,
    ): Promise<boolean> {
      // A snapshot is the way back to the version it was taken from: a rollback
      // restores its state and pins that version again, which needs the bytes.
      // An uninstalled install cannot be moved, so its snapshot no longer wants
      // them.
      const result = await transaction.query(
        `select 1
           from bakery.plugin_install_snapshots s
           join bakery.plugin_installs i
             on i.organization_id = s.organization_id
            and i.id = s.plugin_install_id
          where s.organization_id = $1 and s.from_plugin_version_id = $2
            and i.status <> 'uninstalled'
          limit 1`,
        [organizationId, versionId],
      );
      return result.rows.length > 0;
    },
  },
] as const;

/** Tables whose rows can never keep a bundle alive, named so a reader sees them. */
export const pluginBundleNeutralReferences = [
  {
    kind: "install-grant",
    table: "plugin_install_grants",
    constraint: "plugin_install_grants_install_fk",
    protection: "none",
    note:
      "A grant dies with its install (`on delete cascade`), so an install that no longer exists cannot leave a grant behind that names its version.",
  },
  {
    kind: "install-state",
    table: "plugin_state",
    constraint: "plugin_state_install_fk",
    protection: "none",
    note:
      "State rows reference the install, never the version, so retained state cannot outlive the bytes by pointing at them.",
  },
  {
    kind: "install-snapshot-state",
    table: "plugin_install_snapshot_state",
    constraint: "plugin_install_snapshot_state_snapshot_fk",
    protection: "none",
    note:
      "Snapshot state rows reference their snapshot, which carries the version; they never name a version themselves.",
  },
] as const;

/** Whether collection must keep this version's bytes for a reference that names it. */
export async function hasProtectedPluginBundleReference(
  transaction: PgTransactionClient,
  organizationId: string,
  versionId: string,
): Promise<boolean> {
  for (const entry of pluginBundleReferences) {
    if (await entry.protects(transaction, organizationId, versionId)) {
      return true;
    }
  }
  return false;
}

/** Whether a foreign key to `plugin_versions` is classified, either way. */
export function isClassifiedPluginVersionForeignKey(
  table: string,
  constraint: string,
): boolean {
  return [...pluginBundleReferences, ...pluginBundleNeutralReferences].some(
    (entry) => entry.table === table && entry.constraint === constraint,
  );
}

/** The protection class collection reads for a classified reference. */
export function pluginBundleProtection(
  table: string,
  constraint: string,
): "active" | "none" | null {
  const entry = [...pluginBundleReferences, ...pluginBundleNeutralReferences]
    .find((candidate) =>
      candidate.table === table && candidate.constraint === constraint
    );
  return entry?.protection ?? null;
}
