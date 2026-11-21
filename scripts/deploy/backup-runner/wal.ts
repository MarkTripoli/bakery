import { PutObjectCommand } from "@aws-sdk/client-s3";
import { join } from "node:path";
import type { Connection } from "./offsite.ts";
import { backupTimestamp } from "./retention.ts";

/**
 * Continuous WAL shipping for "Restore to any minute" (issue #80, P1b).
 *
 * Postgres archives every finished WAL segment into the host spool
 * (infra/production/compose.yaml). Each runner pass, when the switch is on and
 * an off-site destination is set, every spooled file is age-encrypted to the
 * operator's public recipient, uploaded under `<prefix>wal/`, and only then
 * removed from the spool, oldest first, so a failure part way leaves the rest
 * for the next pass and nothing is lost. When the switch is off the spool is
 * only pruned: archiving is always on, and the files would otherwise fill the
 * disk. The server never sees WAL bytes or a key; it is told the window.
 */

export const WAL_SPOOL = "/var/lib/bakery/wal-spool";

/** Segment, timeline history and backup label files Postgres archives. */
const ARCHIVED =
  /^[0-9A-F]{24}(\.[0-9A-F]{8}\.backup)?$|^[0-9A-F]{8}\.history$/;

export type SpoolFile = { readonly name: string; readonly modifiedAt: Date };

export type WalShipDeps = {
  readonly spool: string;
  /** True when Restore to any minute is on. */
  readonly enabled: boolean;
  /** The off-site connection, or null when no destination is set. */
  readonly connection: Connection | null;
  /** age-encrypts one spooled file to the operator's public recipient. */
  readonly encrypt: (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Reports the window the destination now holds. */
  readonly report: (window: {
    latestArchivedAt: string;
    earliestBaseBackupAt: string;
    latestSegment: string;
  }) => Promise<void>;
  /** Start of the oldest kept base backup, or null when there is none. */
  readonly earliestBaseBackupAt: Date | null;
  readonly signal?: AbortSignal;
};

export type WalShipOutcome = {
  readonly shipped: number;
  readonly pruned: number;
  readonly reported: boolean;
};

/** The spool's archived files, oldest first by name (WAL order). */
export async function listSpool(spool: string): Promise<SpoolFile[]> {
  const files: SpoolFile[] = [];
  for await (const entry of Deno.readDir(spool)) {
    if (!entry.isFile || !ARCHIVED.test(entry.name)) continue;
    const info = await Deno.stat(join(spool, entry.name));
    files.push({ name: entry.name, modifiedAt: info.mtime ?? new Date(0) });
  }
  return files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** The object key a spooled file is kept under. */
export function walKey(prefix: string, name: string): string {
  return `${prefix}wal/${name}.age`;
}

/**
 * One pass over the spool. Ships (or, when off or with no destination, only
 * prunes) and reports the window when something was shipped and a base backup
 * exists to start from. A file is removed only after its upload succeeded.
 */
export async function shipWal(deps: WalShipDeps): Promise<WalShipOutcome> {
  const files = await listSpool(deps.spool);
  if (!deps.enabled || deps.connection === null) {
    for (const file of files) await Deno.remove(join(deps.spool, file.name));
    return { shipped: 0, pruned: files.length, reported: false };
  }
  const { client, destination } = deps.connection;
  let latest: SpoolFile | null = null;
  let shipped = 0;
  for (const file of files) {
    deps.signal?.throwIfAborted();
    const path = join(deps.spool, file.name);
    const body = await deps.encrypt(path, deps.signal);
    await client.send(
      new PutObjectCommand({
        Bucket: destination.bucket,
        Key: walKey(destination.prefix, file.name),
        Body: body,
      }),
      { abortSignal: deps.signal },
    );
    await Deno.remove(path);
    shipped += 1;
    if (/^[0-9A-F]{24}$/.test(file.name)) latest = file;
  }
  if (latest === null || deps.earliestBaseBackupAt === null) {
    return { shipped, pruned: 0, reported: false };
  }
  await deps.report({
    latestArchivedAt: latest.modifiedAt.toISOString(),
    earliestBaseBackupAt: deps.earliestBaseBackupAt.toISOString(),
    latestSegment: latest.name,
  });
  return { shipped, pruned: 0, reported: true };
}

/** The base backup file a set holds when Restore to any minute was on. */
export const BASE_BACKUP_FILE = "base.tar.age";

/**
 * Start of the oldest local backup set that holds a base backup: the earliest
 * minute a restore can go back to. Set names carry their start time.
 */
export async function earliestBaseBackup(root: string): Promise<Date | null> {
  let earliest: Date | null = null;
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory) continue;
      const at = backupTimestamp(entry.name);
      if (at === null) continue;
      try {
        await Deno.stat(join(root, entry.name, BASE_BACKUP_FILE));
      } catch {
        continue;
      }
      if (earliest === null || at < earliest) earliest = at;
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  return earliest;
}
