/**
 * Which finished backups the runner may delete. A backup set is a directory
 * named `<UTC timestamp>-<uuid>` (the name backup.sh gives it), kept locally
 * under /var/lib/bakery/backups and, when an off-site copy is configured, under
 * `<prefix><name>/` in the bucket. Anything whose name does not match is not a
 * backup set and is never touched.
 */

const NAME =
  /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC time in a backup set's name, or null when it is not one. */
export function backupTimestamp(name: string): Date | null {
  const match = NAME.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(
    Number,
  );
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(time);
  // A calendar impossibility (month 13, 31 February) must not parse as a date.
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day || date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
  ) return null;
  return date;
}

export function isBackupName(name: string): boolean {
  return backupTimestamp(name) !== null;
}

/**
 * The names to delete. A set expires only when it is strictly older than
 * `daysToKeep` days, is not protected (the set just taken), and is not the
 * newest COMPLETE set there is: the last good backup is never pruned, however
 * old. A set that declared itself incomplete (`incomplete`, see INCOMPLETE.json)
 * is never "the newest": it cannot shield an older complete set, is not
 * protected by being the latest directory, and is pruned by age like any other.
 * A `daysToKeep` that is not a positive whole number keeps everything, so a bad
 * setting can never turn into a delete-all.
 */
export function selectExpired(input: {
  readonly names: readonly string[];
  readonly now: Date;
  readonly daysToKeep: number;
  readonly protect: ReadonlySet<string>;
  readonly incomplete?: ReadonlySet<string>;
}): string[] {
  if (!Number.isInteger(input.daysToKeep) || input.daysToKeep < 1) return [];
  const incomplete = input.incomplete ?? new Set<string>();
  const sets = input.names
    .map((name) => ({ name, at: backupTimestamp(name) }))
    .filter((entry): entry is { name: string; at: Date } => entry.at !== null);
  if (sets.length === 0) return [];
  const complete = sets.filter((entry) => !incomplete.has(entry.name));
  const newest = complete.length === 0
    ? null
    : complete.reduce((a, b) => (b.at > a.at ? b : a)).name;
  const cutoff = input.now.getTime() - input.daysToKeep * DAY_MS;
  return sets
    .filter((entry) =>
      entry.at.getTime() < cutoff && entry.name !== newest &&
      !input.protect.has(entry.name)
    )
    .map((entry) => entry.name)
    .sort();
}
