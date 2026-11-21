/**
 * The cutoff of a backup and the census of effects that could still reach a
 * provider at that moment (issue #64 slice C, also #49).
 *
 * Pure rules with no database and no network, shared by the server (which takes
 * the census), the host runner and backup tooling (which carry it into the
 * manifest) and the restore side (which decides what an effect's unknown
 * outcome means). Nothing here reads or reveals an effect's arguments, target
 * or result: the census is counts by status and by operation name, plus a
 * digest of the effect ids.
 */

/**
 * The effect statuses whose outcome is not settled: `prepared` (committed
 * locally, may or may not have been sent), `submitted` (sent, answer unknown)
 * and `uncertain` (the answer was lost). `confirmed` and `failed` are settled.
 * This is the same set the live-effect index in migration 0127 covers.
 */
export const LIVE_EFFECT_STATUSES = [
  "prepared",
  "submitted",
  "uncertain",
] as const;
export type LiveEffectStatus = (typeof LIVE_EFFECT_STATUSES)[number];

const LIVE: ReadonlySet<string> = new Set(LIVE_EFFECT_STATUSES);

/** An effect as the census and the restore side see it: no arguments, no target. */
export type EffectRow = {
  readonly id: string;
  readonly status: string;
  readonly operation: string;
};

/** An effect row read back from a restored database. */
export type RestoredEffectRow = EffectRow & { readonly updatedAt: Date };

export type OperationCount = {
  readonly operation: string;
  readonly count: number;
};

export type Census = {
  readonly total: number;
  readonly prepared: number;
  readonly submitted: number;
  readonly uncertain: number;
  /** Counts by operation name, sorted by name. Names outside the code-defined shape count as `other`. */
  readonly byOperation: readonly OperationCount[];
  /** SHA-256 hex of the sorted effect ids, one per line; the digest of no effects is of the empty text. */
  readonly digest: string;
};

/** How an operation name is allowed to look in the census. Anything else is `other`. */
const OPERATION_NAME = /^[a-z][a-z0-9_.-]{0,79}$/;

/**
 * The name an operation is counted under. Operation names are fixed words the
 * code defines (never user data), but the census still refuses to carry
 * anything that does not look like one, so a stray value cannot leak through.
 */
export function operationKey(operation: string): string {
  return OPERATION_NAME.test(operation) ? operation : "other";
}

export function isLiveEffectStatus(status: string): boolean {
  return LIVE.has(status);
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** SHA-256 hex of the ids sorted ascending and joined by a newline. */
export async function effectsDigest(ids: readonly string[]): Promise<string> {
  const sorted = [...ids].sort();
  return hex(
    await crypto.subtle.digest("SHA-256", encoder.encode(sorted.join("\n"))),
  );
}

/**
 * The census of the live effects among `rows`. Settled effects are ignored, so
 * a long history of confirmed effects never shows in it.
 */
export async function censusOf(rows: readonly EffectRow[]): Promise<Census> {
  const live = rows.filter((row) => LIVE.has(row.status));
  const byStatus: Record<LiveEffectStatus, number> = {
    prepared: 0,
    submitted: 0,
    uncertain: 0,
  };
  const byOperation = new Map<string, number>();
  for (const row of live) {
    byStatus[row.status as LiveEffectStatus]++;
    const key = operationKey(row.operation);
    byOperation.set(key, (byOperation.get(key) ?? 0) + 1);
  }
  return {
    total: live.length,
    prepared: byStatus.prepared,
    submitted: byStatus.submitted,
    uncertain: byStatus.uncertain,
    byOperation: [...byOperation.entries()]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([operation, count]) => ({ operation, count })),
    digest: await effectsDigest(live.map((row) => row.id)),
  };
}

/** A cutoff as the manifest and the server's record carry it. */
export type Cutoff = {
  /** UTC instant, ISO 8601 with milliseconds. */
  readonly at: string;
  /**
   * `database`: the database clock at the moment the installation was quiet,
   * taken by the runner's cutoff request. `host-clock`: the host's clock when
   * the script started, for a backup no runner took. Weaker: it proves no
   * quiet moment and carries no census.
   */
  readonly source: "database" | "host-clock";
  /** The census at that moment; present exactly when the source is the database. */
  readonly effects: Census | null;
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const DIGEST = /^[0-9a-f]{64}$/;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

/** Narrows an unknown JSON value to a census, or says why it is not one. */
export function parseCensus(value: unknown): Census | string {
  if (value === null || typeof value !== "object") {
    return "the effects census is not an object";
  }
  const c = value as Record<string, unknown>;
  for (const field of ["total", "prepared", "submitted", "uncertain"]) {
    if (!isCount(c[field])) return `the effects census has a bad ${field}`;
  }
  if (
    (c.prepared as number) + (c.submitted as number) +
        (c.uncertain as number) !==
      c.total
  ) return "the effects census statuses do not add up to its total";
  if (typeof c.digest !== "string" || !DIGEST.test(c.digest)) {
    return "the effects census digest is malformed";
  }
  if (!Array.isArray(c.byOperation)) {
    return "the effects census has no operation counts";
  }
  let sum = 0;
  let last = "";
  for (const raw of c.byOperation) {
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry?.operation !== "string" ||
      !(OPERATION_NAME.test(entry.operation) || entry.operation === "other") ||
      !isCount(entry.count) || entry.count === 0
    ) return "an operation count in the effects census is malformed";
    if (entry.operation <= last) {
      return "the operation counts are not sorted and unique";
    }
    last = entry.operation;
    sum += entry.count;
  }
  if (sum !== c.total) {
    return "the operation counts do not add up to the census total";
  }
  return value as Census;
}

/**
 * Narrows an unknown JSON value to a cutoff, or says why it is not one. A
 * database cutoff carries a census; a host-clock cutoff carries none.
 */
export function parseCutoff(value: unknown): Cutoff | string {
  if (value === null || typeof value !== "object") {
    return "the cutoff is missing";
  }
  const c = value as Record<string, unknown>;
  if (typeof c.at !== "string" || !ISO.test(c.at) || isNaN(Date.parse(c.at))) {
    return "the cutoff time is malformed";
  }
  if (c.source === "database") {
    if (c.effects === null || c.effects === undefined) {
      return "a database cutoff must carry its effects census";
    }
    const census = parseCensus(c.effects);
    if (typeof census === "string") return census;
    return { at: c.at, source: "database", effects: census };
  }
  if (c.source === "host-clock") {
    if (c.effects !== null && c.effects !== undefined) {
      return "a host-clock cutoff cannot carry an effects census";
    }
    return { at: c.at, source: "host-clock", effects: null };
  }
  return "the cutoff source is not database or host-clock";
}

/**
 * The effects of a RESTORED database that a restore must treat as having an
 * unknown outcome (slice E blocks them; nothing here restores anything).
 *
 * `block` holds every effect still `prepared`, `submitted` or `uncertain` in
 * the restored data: it was unsettled at the cutoff, so the provider may have
 * acted on it after the backup, and replaying it could do the work twice. An
 * effect settled at the cutoff (`confirmed`, `failed`) is known.
 *
 * `anomalies` holds any effect changed AFTER the cutoff. In a dump taken while
 * the installation was quiet there are none; one means the dump did not
 * describe the cutoff and cannot be trusted to.
 */
export function unknownOutcomeEffects(
  cutoffAt: string,
  restored: readonly RestoredEffectRow[],
): {
  readonly block: readonly string[];
  readonly anomalies: readonly string[];
} {
  const cutoff = Date.parse(cutoffAt);
  if (isNaN(cutoff)) throw new Error("CUTOFF_TIME_INVALID");
  const block: string[] = [];
  const anomalies: string[] = [];
  for (const row of restored) {
    if (LIVE.has(row.status)) block.push(row.id);
    if (row.updatedAt.getTime() > cutoff) anomalies.push(row.id);
  }
  return { block: block.sort(), anomalies: anomalies.sort() };
}

export type CensusMismatch = {
  readonly field: string;
  readonly recorded: string | number;
  readonly found: string | number;
};

/**
 * Compares the census a backup recorded with the effects of a restored (or
 * freshly dumped) database. Empty means the dump matches its own cutoff.
 */
export async function compareCensus(
  recorded: Census,
  restored: readonly EffectRow[],
): Promise<readonly CensusMismatch[]> {
  const found = await censusOf(restored);
  const out: CensusMismatch[] = [];
  const pairs: [string, string | number, string | number][] = [
    ["total", recorded.total, found.total],
    ["prepared", recorded.prepared, found.prepared],
    ["submitted", recorded.submitted, found.submitted],
    ["uncertain", recorded.uncertain, found.uncertain],
    ["digest", recorded.digest, found.digest],
  ];
  for (const [field, was, now] of pairs) {
    if (was !== now) out.push({ field, recorded: was, found: now });
  }
  const left = JSON.stringify(recorded.byOperation);
  const right = JSON.stringify(found.byOperation);
  if (left !== right) {
    out.push({ field: "byOperation", recorded: left, found: right });
  }
  return out;
}
