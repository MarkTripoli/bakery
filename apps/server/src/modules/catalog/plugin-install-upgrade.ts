import type { PgTransactionClient } from "../../platform/database.ts";
import type {
  PluginInstallCapability,
  PluginManifest,
} from "@bakery/contracts/plugin-sdk";

/**
 * Moving an install to another version (#34, B14.03).
 *
 * Three questions decide whether a move may happen, and each one defaults to
 * "no": does the new version ask for authority the install was never given,
 * can the new version read the state the install already holds, and, for a
 * rollback, is the state it would restore the state that version left behind.
 * Every function here answers one of them, or keeps the copy of state that makes
 * a rollback possible. None of them decides alone: the caller refuses the move
 * on the first "no" and writes nothing but the note saying why.
 */

/**
 * The capabilities a version asks for that the pinned one did not.
 *
 * Only an addition is a question. Dropping a capability narrows the install and
 * needs nobody's consent; an addition would hand a new version authority that
 * the person who installed the old one never saw, which is exactly what an
 * upgrade must not do on its own.
 */
export function addedCapabilities(
  pinned: PluginManifest,
  next: PluginManifest,
): PluginInstallCapability[] {
  const held = new Set<string>(pinned.requestedCapabilities);
  return next.requestedCapabilities.filter((capability) =>
    !held.has(capability)
  );
}

/**
 * Whether the capabilities a caller approved are exactly the ones added.
 *
 * Exactly, not "at least": an approval is for what the person was shown. One
 * that names something the version does not ask for, or leaves out something it
 * does, is an approval of a different upgrade.
 */
export function approvalMatches(
  added: readonly string[],
  approved: readonly string[],
): boolean {
  return added.length === approved.length &&
    added.every((capability) => approved.includes(capability));
}

/** The oldest and newest schema version among a set of saved state rows. */
export type StateSchemaRange = Readonly<{ min: number; max: number }>;

/**
 * Whether a version's reader can make sense of state saved at these schemas.
 *
 * No state at all is always readable. Otherwise every row must sit between the
 * oldest schema the version reads as saved and the schema it writes: a row older
 * than that was never promised readable, and a row newer than that was written
 * by a version this one does not know, which is what an unsafe downgrade is.
 */
export function stateReadableBy(
  range: StateSchemaRange | null,
  manifest: Pick<PluginManifest, "stateCompatibleFrom" | "stateSchemaVersion">,
): boolean {
  if (range === null) return true;
  return range.min >= manifest.stateCompatibleFrom &&
    range.max <= manifest.stateSchemaVersion;
}

/** The schema range of the state an install holds now, or null when it holds none. */
export async function liveStateRange(
  transaction: PgTransactionClient,
  organizationId: string,
  installId: string,
): Promise<StateSchemaRange | null> {
  const result = await transaction.query<
    { min: number | null; max: number | null }
  >(
    `select min(schema_version)::int as min, max(schema_version)::int as max
       from bakery.plugin_state
      where organization_id = $1 and plugin_install_id = $2`,
    [organizationId, installId],
  );
  const row = result.rows[0];
  return row === undefined || row.min === null || row.max === null
    ? null
    : { min: row.min, max: row.max };
}

/** The copy of state an install keeps from before its last move. */
export type StateSnapshot = Readonly<{
  id: string;
  fromVersionId: string;
  range: StateSchemaRange | null;
  rows: readonly SnapshotRow[];
}>;

type SnapshotRow = Readonly<{
  owner_principal_id: string | null;
  namespace: string;
  key: string;
  schema_version: number;
  value: unknown;
}>;

/**
 * The snapshot an install holds, read under the install's lock, or null.
 *
 * The rows come with it: a snapshot is at most the state cap in rows, and a
 * restore needs all of them, so reading them once avoids a second query that
 * could see a different snapshot.
 */
export async function loadSnapshot(
  transaction: PgTransactionClient,
  organizationId: string,
  installId: string,
): Promise<StateSnapshot | null> {
  const header = await transaction.query<
    { id: string; from_plugin_version_id: string }
  >(
    `select id, from_plugin_version_id
       from bakery.plugin_install_snapshots
      where organization_id = $1 and plugin_install_id = $2`,
    [organizationId, installId],
  );
  const found = header.rows[0];
  if (found === undefined) return null;
  const rows = await transaction.query<SnapshotRow>(
    `select owner_principal_id, namespace, key, schema_version, value
       from bakery.plugin_install_snapshot_state
      where organization_id = $1 and plugin_install_snapshot_id = $2`,
    [organizationId, found.id],
  );
  const versions = rows.rows.map((row) => row.schema_version);
  return {
    id: found.id,
    fromVersionId: found.from_plugin_version_id,
    range: versions.length === 0
      ? null
      : { min: Math.min(...versions), max: Math.max(...versions) },
    rows: rows.rows,
  };
}

/**
 * Replaces the install's snapshot with the state it holds right now.
 *
 * Taken as the install leaves a version, in the same transaction as the move, so
 * there is never a moment where the install has moved and the copy has not been
 * made: if the copy fails, the move does too. The older snapshot is dropped, so
 * the table holds one copy per install however many times it is updated.
 */
export async function snapshotLiveState(
  transaction: PgTransactionClient,
  organizationId: string,
  installId: string,
  leavingVersionId: string,
  leavingStateSchemaVersion: number,
): Promise<void> {
  await transaction.query(
    `delete from bakery.plugin_install_snapshots
      where organization_id = $1 and plugin_install_id = $2`,
    [organizationId, installId],
  );
  const header = await transaction.query<{ id: string }>(
    `insert into bakery.plugin_install_snapshots
       (organization_id, plugin_install_id, from_plugin_version_id,
        from_state_schema_version, state_row_count)
     select $1, $2, $3, $4, count(*)::int
       from bakery.plugin_state
      where organization_id = $1 and plugin_install_id = $2
     returning id`,
    [organizationId, installId, leavingVersionId, leavingStateSchemaVersion],
  );
  await transaction.query(
    `insert into bakery.plugin_install_snapshot_state
       (organization_id, plugin_install_snapshot_id, owner_principal_id,
        namespace, key, schema_version, value)
     select organization_id, $3, owner_principal_id, namespace, key,
            schema_version, value
       from bakery.plugin_state
      where organization_id = $1 and plugin_install_id = $2`,
    [organizationId, installId, header.rows[0].id],
  );
}

/**
 * Puts a snapshot's state back as the install's live state.
 *
 * What was saved after the snapshot is discarded; that is what the person who
 * asked for a restore asked for, and why it is a separate request field rather
 * than something a rollback does on its own.
 *
 * Every restored row gets a CAS version above any the install has issued, so a
 * writer that read the state before the restore cannot succeed against it. A
 * row's own next number is not enough: a key deleted by the restore and put back
 * by it would otherwise return to a number a stale writer already holds.
 */
export async function restoreSnapshotState(
  transaction: PgTransactionClient,
  organizationId: string,
  installId: string,
  rows: readonly SnapshotRow[],
): Promise<void> {
  const issued = await transaction.query<{ top: number | null }>(
    `select max(cas_version)::int as top
       from bakery.plugin_state
      where organization_id = $1 and plugin_install_id = $2`,
    [organizationId, installId],
  );
  const next = (issued.rows[0]?.top ?? 0) + 1;
  await transaction.query(
    `delete from bakery.plugin_state
      where organization_id = $1 and plugin_install_id = $2`,
    [organizationId, installId],
  );
  for (const row of rows) {
    await transaction.query(
      `insert into bakery.plugin_state
         (organization_id, plugin_install_id, owner_principal_id, namespace,
          key, schema_version, cas_version, value)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        organizationId,
        installId,
        row.owner_principal_id,
        row.namespace,
        row.key,
        row.schema_version,
        next,
        JSON.stringify(row.value),
      ],
    );
  }
}
