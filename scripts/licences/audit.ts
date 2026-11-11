/**
 * Offline dependency-licence audit for the pnpm + Deno workspace.
 *
 *   --write  scan installed packages, classify, write the sanitized report.
 *   --check  no network, no write: prove the report still covers the lockfiles
 *            and that no entry is outside the licence policy.
 *
 * Policy lives in scripts/licences/policy.json. This tool never decides a
 * licence question: anything outside `allow` needs a policy entry the owner
 * approved (`exceptions`) or flagged (`pendingOwnerDecision`).
 */
import { z } from "zod";

export type Ecosystem = "pnpm" | "deno-npm" | "jsr";
export type Status =
  | "allowed"
  | "exception"
  | "pendingOwnerDecision"
  | "unresolved";
export type Resolution = "package.json" | "override" | "family";

const ECOSYSTEMS: readonly Ecosystem[] = ["pnpm", "deno-npm", "jsr"];
const STATUSES: readonly Status[] = [
  "allowed",
  "exception",
  "pendingOwnerDecision",
  "unresolved",
];

const NonEmptyText = z.string().min(1).describe(
  "Text that must contain at least one character.",
);
const KeyText = z.string().describe(
  "Key of a record, such as an ecosystem, status or licence name.",
);
const Count = z.number().int().nonnegative().describe(
  "Whole number of items, zero or more.",
);

const PolicyEntrySchema = z.object({
  name: z.string().min(1).optional().describe(
    "Exact package name this policy entry covers. Set exactly one of name or namePrefix.",
  ),
  namePrefix: z.string().min(1).optional().describe(
    "Package-name prefix this policy entry covers, for platform-binary families. Set exactly one of name or namePrefix.",
  ),
  versions: z.array(NonEmptyText).min(1).describe(
    "Exact versions covered. A version outside this list is not covered and falls back to unresolved.",
  ),
  licence: z.string().min(1).describe(
    "Licence expression exactly as recorded in the report. A different expression is not covered.",
  ),
  reason: z.string().min(1).describe(
    "One-line factual note: the owner decision for an exception, or what the owner still has to decide.",
  ),
}).refine(
  (entry) => (entry.name === undefined) !== (entry.namePrefix === undefined),
  {
    message: "set exactly one of name or namePrefix",
  },
).describe(
  "A policy bucket entry for one package (or family) at exact versions.",
);

export const PolicySchema = z.object({
  allow: z.array(NonEmptyText).describe(
    "SPDX identifiers accepted without review. OR expressions pass when one option is listed, AND expressions when every term is listed.",
  ),
  exceptions: z.array(PolicyEntrySchema).describe(
    "Owner-decided exceptions to the allow list. Only the owner adds entries here.",
  ),
  pendingOwnerDecision: z.array(PolicyEntrySchema).describe(
    "Non-allowed licences found by the scan that wait for an owner decision. They pass the gate and are printed on every run.",
  ),
  families: z.array(
    z.object({
      prefix: z.string().min(1).describe(
        "Package-name prefix of platform-optional packages that this machine cannot scan.",
      ),
      reference: z.string().min(1).describe(
        "Name of a scanned package that ships under the same licence. Its single resolved licence is reused.",
      ),
      note: z.string().min(1).describe(
        "Why the family shares the reference licence.",
      ),
    }).describe(
      "Maps uninstalled platform packages to the licence of a scanned sibling.",
    ),
  ).describe(
    "Explicit family mappings; the only way a package that is not installed gets a licence from a sibling.",
  ),
  npmOverrides: z.array(
    z.object({
      name: z.string().min(1).describe("npm package name."),
      versions: z.array(NonEmptyText).min(1).describe(
        "Exact versions the override covers.",
      ),
      licence: z.string().min(1).describe(
        "SPDX licence expression published by the package.",
      ),
      source: z.string().url().describe(
        "Public URL of the upstream licence declaration that was reviewed.",
      ),
    }).describe(
      "Reviewed licence for an npm package that no offline source describes.",
    ),
  ).describe(
    "Reviewed licences for npm packages that are neither installed nor cached on the scan host.",
  ),
  jsrOverrides: z.array(
    z.object({
      name: z.string().min(1).describe("JSR package name including scope."),
      version: z.string().min(1).describe(
        "Exact JSR version the override covers.",
      ),
      licence: z.string().min(1).describe(
        "SPDX licence expression published by the package.",
      ),
      source: z.string().url().describe(
        "Public URL of the upstream licence declaration that was reviewed.",
      ),
    }).describe("Reviewed licence for one JSR package version."),
  ).describe(
    "Reviewed licences for JSR packages; JSR has no offline licence metadata in the Deno cache.",
  ),
}).describe(
  "Dependency licence policy: allow list, owner buckets, family mappings and reviewed overrides.",
);
export type Policy = z.infer<typeof PolicySchema>;

const EntrySchema = z.object({
  ecosystem: z.enum(["pnpm", "deno-npm", "jsr"]).describe(
    "Which lockfile the package comes from.",
  ),
  name: z.string().min(1).describe("Package name including scope."),
  version: z.string().min(1).describe(
    "Exact locked version without peer suffix.",
  ),
  licence: z.string().min(1).describe(
    "Licence expression as published, or UNKNOWN when none was found.",
  ),
  resolution: z.enum(["package.json", "override", "family"]).describe(
    "How the licence was found: package metadata, a reviewed override, or a family mapping.",
  ),
  status: z.enum(["allowed", "exception", "pendingOwnerDecision", "unresolved"])
    .describe(
      "Policy classification at the time the report was written.",
    ),
}).describe("One locked dependency and its licence classification.");
export type Entry = z.infer<typeof EntrySchema>;

const CountsSchema = z.record(KeyText, Count)
  .describe(
    "Counts keyed by status name.",
  );

export const ReportSchema = z.object({
  format: z.literal("bakery-dependency-licences/1").describe(
    "Report format identifier.",
  ),
  lockfileSha256: z.object({
    "pnpm-lock.yaml": z.string().regex(/^[0-9a-f]{64}$/).describe(
      "sha256 of pnpm-lock.yaml when the report was built. Informational; never compared.",
    ),
    "deno.lock": z.string().regex(/^[0-9a-f]{64}$/).describe(
      "sha256 of deno.lock when the report was built. Informational; never compared.",
    ),
  }).describe(
    "Lockfile digests the report was built from. Informational only.",
  ),
  summary: z.object({
    total: z.number().int().nonnegative().describe("Number of entries."),
    byEcosystem: z.record(KeyText, Count).describe(
      "Entry count per ecosystem.",
    ),
    byStatus: CountsSchema.describe("Entry count per status."),
    byEcosystemStatus: z.record(KeyText, CountsSchema).describe(
      "Status counts per ecosystem.",
    ),
  }).describe("Counts computed from entries."),
  entries: z.array(EntrySchema).describe(
    "Every locked dependency, sorted by ecosystem, name, version.",
  ),
}).describe(
  "Sanitized dependency licence report: no paths, authors, emails or homepages.",
);
export type Report = z.infer<typeof ReportSchema>;

const PnpmScanSchema = z.record(
  KeyText,
  z.array(
    z.object({
      name: z.string().describe("Package name."),
      versions: z.array(NonEmptyText).describe("Installed versions."),
      license: z.string().optional().describe(
        "Licence string reported by pnpm.",
      ),
    }).passthrough().describe("One package row from pnpm licenses list."),
  ).describe("Rows for one licence group."),
).describe("Output of pnpm licenses list --json keyed by licence.");

export const pairKey = (name: string, version: string): string =>
  `${name}@${version}`;
export const entryKey = (
  entry: { ecosystem: Ecosystem; name: string; version: string },
): string => `${entry.ecosystem}:${pairKey(entry.name, entry.version)}`;

export type Locked = { ecosystem: Ecosystem; name: string; version: string };

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
export const sha256 = async (text: string): Promise<string> =>
  bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  );

/** name@version pairs from the `packages:` section of pnpm-lock.yaml (v9). */
export const parsePnpmLock = (text: string): Locked[] => {
  const lines = text.split("\n");
  const start = lines.indexOf("packages:");
  if (start < 0) throw new Error("pnpm-lock.yaml: no packages section");
  const found = new Map<string, Locked>();
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "snapshots:" || /^\S/.test(line)) break;
    const match = /^ {2}'?(@?[^@'\s]+)@([^'\s:]+)'?:$/.exec(line);
    if (!match) {
      if (/^ {2}\S/.test(line)) {
        throw new Error(`pnpm-lock.yaml: unparsable package key: ${line}`);
      }
      continue;
    }
    const item: Locked = {
      ecosystem: "pnpm",
      name: match[1],
      version: match[2],
    };
    found.set(entryKey(item), item);
  }
  if (found.size === 0) throw new Error("pnpm-lock.yaml: no packages parsed");
  return [...found.values()];
};

/** npm and jsr name@version pairs from a deno.lock v5 file. */
export const parseDenoLock = (text: string): Locked[] => {
  const lock = JSON.parse(text) as {
    version?: string;
    npm?: Record<string, unknown>;
    jsr?: Record<string, unknown>;
  };
  if (lock.version !== "5") {
    throw new Error(`deno.lock: unsupported version ${lock.version}`);
  }
  const found = new Map<string, Locked>();
  for (const key of Object.keys(lock.npm ?? {})) {
    const match = /^(@?[^@]+)@([^_]+)/.exec(key);
    if (!match) throw new Error(`deno.lock: unparsable npm key ${key}`);
    const item: Locked = {
      ecosystem: "deno-npm",
      name: match[1],
      version: match[2],
    };
    found.set(entryKey(item), item);
  }
  for (const key of Object.keys(lock.jsr ?? {})) {
    const match = /^(@?[^@]+)@(.+)$/.exec(key);
    if (!match) throw new Error(`deno.lock: unparsable jsr key ${key}`);
    const item: Locked = {
      ecosystem: "jsr",
      name: match[1],
      version: match[2],
    };
    found.set(entryKey(item), item);
  }
  return [...found.values()];
};

type Node = { op: "id"; id: string } | { op: "and" | "or"; items: Node[] };

/** Parses an SPDX expression. Returns null when it is not well formed. */
export const parseSpdx = (expression: string): Node | null => {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const factor = (): Node | null => {
    const token = tokens[position++];
    if (
      token === undefined || token === ")" || token === "AND" || token === "OR"
    ) return null;
    if (token === "(") {
      const inner = orExpr();
      if (inner === null || tokens[position++] !== ")") return null;
      return inner;
    }
    let id = token;
    while (peek() === "WITH") {
      position += 1;
      const exception = tokens[position++];
      if (exception === undefined) return null;
      id = `${id} WITH ${exception}`;
    }
    return { op: "id", id };
  };
  const andExpr = (): Node | null => {
    const first = factor();
    if (first === null) return null;
    const items = [first];
    while (peek() === "AND") {
      position += 1;
      const next = factor();
      if (next === null) return null;
      items.push(next);
    }
    return items.length === 1 ? first : { op: "and", items };
  };
  const orExpr = (): Node | null => {
    const first = andExpr();
    if (first === null) return null;
    const items = [first];
    while (peek() === "OR") {
      position += 1;
      const next = andExpr();
      if (next === null) return null;
      items.push(next);
    }
    return items.length === 1 ? first : { op: "or", items };
  };
  const tree = orExpr();
  return tree !== null && position === tokens.length ? tree : null;
};

export const isAllowedExpression = (
  expression: string,
  allow: readonly string[],
): boolean => {
  const tree = parseSpdx(expression);
  if (tree === null) return false;
  const allowed = new Set(allow);
  const test = (node: Node): boolean =>
    node.op === "id"
      ? allowed.has(node.id)
      : node.op === "and"
      ? node.items.every(test)
      : node.items.some(test);
  return test(tree);
};

type PolicyEntry = z.infer<typeof PolicyEntrySchema>;
const findPolicyEntry = (
  bucket: readonly PolicyEntry[],
  item: { name: string; version: string; licence: string },
): PolicyEntry | undefined =>
  bucket.find((candidate) =>
    candidate.licence === item.licence &&
    candidate.versions.includes(item.version) &&
    (candidate.name !== undefined
      ? candidate.name === item.name
      : item.name.startsWith(candidate.namePrefix ?? "\0"))
  );

export const classify = (
  item: { name: string; version: string; licence: string },
  policy: Policy,
): { status: Status; reason?: string } => {
  if (isAllowedExpression(item.licence, policy.allow)) {
    return { status: "allowed" };
  }
  const exception = findPolicyEntry(policy.exceptions, item);
  if (exception) return { status: "exception", reason: exception.reason };
  const pending = findPolicyEntry(policy.pendingOwnerDecision, item);
  if (pending) {
    return { status: "pendingOwnerDecision", reason: pending.reason };
  }
  return { status: "unresolved" };
};

export const pendingLine = (
  item: { name: string; version: string; licence: string },
  reason: string,
): string =>
  `PENDING OWNER DECISION: ${
    pairKey(item.name, item.version)
  } ${item.licence} (${reason})`;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortEntries = (entries: Entry[]): Entry[] =>
  [...entries].sort((a, b) =>
    compare(a.ecosystem, b.ecosystem) || compare(a.name, b.name) ||
    compare(a.version, b.version)
  );

export const summarize = (entries: readonly Entry[]): Report["summary"] => {
  const byEcosystem: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byEcosystemStatus: Record<string, Record<string, number>> = {};
  for (const ecosystem of ECOSYSTEMS) {
    byEcosystem[ecosystem] = 0;
    byEcosystemStatus[ecosystem] = {};
    for (const status of STATUSES) byEcosystemStatus[ecosystem][status] = 0;
  }
  for (const status of STATUSES) byStatus[status] = 0;
  for (const entry of entries) {
    byEcosystem[entry.ecosystem] += 1;
    byStatus[entry.status] += 1;
    byEcosystemStatus[entry.ecosystem][entry.status] += 1;
  }
  return { total: entries.length, byEcosystem, byStatus, byEcosystemStatus };
};

export type CheckResult = {
  ok: boolean;
  failures: string[];
  pending: string[];
  notes: string[];
};

const sample = (items: readonly string[]): string =>
  items.slice(0, 10).join(", ") +
  (items.length > 10 ? `, ... (+${items.length - 10} more)` : "");

/**
 * Pure gate. `rescan` is the optional pnpm re-scan (name@version -> licence);
 * pass null when pnpm could not run offline.
 */
export const checkReport = (input: {
  report: Report;
  locked: readonly Locked[];
  policy: Policy;
  rescan: ReadonlyMap<string, string> | null;
}): CheckResult => {
  const { report, locked, policy, rescan } = input;
  const failures: string[] = [];
  const pending: string[] = [];
  const notes: string[] = [];

  const expected = new Set(locked.map(entryKey));
  const actual = new Set(report.entries.map(entryKey));
  const missing = [...expected].filter((key) => !actual.has(key)).sort();
  const extra = [...actual].filter((key) => !expected.has(key)).sort();
  if (missing.length > 0) {
    failures.push(
      `lockfile has ${missing.length} name@version not in the report: ${
        sample(missing)
      }. run: pnpm licences:audit`,
    );
  }
  if (extra.length > 0) {
    failures.push(
      `report has ${extra.length} name@version not in the lockfiles: ${
        sample(extra)
      }. run: pnpm licences:audit`,
    );
  }

  const stale: string[] = [];
  const unresolved: string[] = [];
  const recomputed: Entry[] = [];
  for (const entry of report.entries) {
    const result = classify(entry, policy);
    recomputed.push({ ...entry, status: result.status });
    if (result.status === "unresolved") {
      unresolved.push(`${pairKey(entry.name, entry.version)} ${entry.licence}`);
      continue;
    }
    if (result.status !== entry.status) {
      stale.push(pairKey(entry.name, entry.version));
    }
    if (result.status === "pendingOwnerDecision") {
      pending.push(pendingLine(entry, result.reason ?? ""));
    }
  }
  if (unresolved.length > 0) {
    failures.push(
      `${unresolved.length} dependencies have a licence outside the policy: ${
        sample(unresolved)
      }. edit scripts/licences/policy.json (owner decision) or replace the dependency`,
    );
  }
  if (stale.length > 0) {
    failures.push(
      `report statuses no longer match policy.json for ${stale.length} entries: ${
        sample(stale)
      }. run: pnpm licences:audit`,
    );
  }
  if (
    JSON.stringify(summarize(recomputed)) !== JSON.stringify(report.summary) &&
    stale.length === 0 && unresolved.length === 0
  ) {
    failures.push(
      "report summary counts do not match its entries. run: pnpm licences:audit",
    );
  }

  if (rescan === null) {
    notes.push(
      "pnpm re-scan skipped: pnpm licenses list could not run offline here; set parity and policy only",
    );
  } else {
    const drift: string[] = [];
    for (const entry of report.entries) {
      if (entry.ecosystem !== "pnpm" || entry.resolution !== "package.json") {
        continue;
      }
      const scanned = rescan.get(pairKey(entry.name, entry.version));
      if (scanned !== undefined && scanned !== entry.licence) {
        drift.push(
          `${
            pairKey(entry.name, entry.version)
          } report=${entry.licence} scan=${scanned}`,
        );
      }
    }
    if (drift.length > 0) {
      failures.push(
        `pnpm re-scan disagrees with the report for ${drift.length} entries: ${
          sample(drift)
        }. run: pnpm licences:audit`,
      );
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    pending: [...new Set(pending)],
    notes,
  };
};

// ---------------------------------------------------------------- scanning

const run = async (
  command: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
  const output = await new Deno.Command(command, {
    args,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    ok: output.success,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
};

/** name@version -> licence from `pnpm licenses list --json`; null when pnpm cannot run. */
export const scanPnpm = async (): Promise<Map<string, string> | null> => {
  try {
    const result = await run("pnpm", ["licenses", "list", "--json"], {
      npm_config_offline: "true",
    });
    if (!result.ok) return null;
    const scan = PnpmScanSchema.parse(JSON.parse(result.stdout));
    const out = new Map<string, string>();
    for (const [group, rows] of Object.entries(scan)) {
      for (const row of rows) {
        const licence = (row.license ?? group).trim();
        for (const version of row.versions) {
          out.set(pairKey(row.name, version), licence);
        }
      }
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
};

const sanitizeLicence = (value: unknown): string => {
  if (typeof value !== "string") return "UNKNOWN";
  const text = value.trim();
  // A licence field can carry a path or contact string; those never enter the report.
  if (
    text === "" ||
    /[\\]|^\/|\.\.|:\/\/|(?<![@\w/.-])[\w.+-]+@[\w-]+(\.[\w-]+)*\.[A-Za-z]{2,}/
      .test(text)
  ) return "UNKNOWN";
  return text;
};

const readDenoCachedLicence = async (
  npmCache: string,
  name: string,
  version: string,
): Promise<string | null> => {
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${npmCache}/registry.npmjs.org/${name}/${version}/package.json`,
      ),
    ) as { license?: unknown; licenses?: unknown };
    if (manifest.license !== undefined) {
      return sanitizeLicence(manifest.license);
    }
    return "UNKNOWN";
  } catch {
    return null;
  }
};

const denoNpmCache = async (): Promise<string | null> => {
  try {
    const result = await run("deno", ["info", "--json"]);
    if (!result.ok) return null;
    const info = JSON.parse(result.stdout) as { npmCache?: string };
    return typeof info.npmCache === "string" ? info.npmCache : null;
  } catch {
    return null;
  }
};

export const buildReport = async (input: {
  pnpmLockText: string;
  denoLockText: string;
  policy: Policy;
  pnpmScan: ReadonlyMap<string, string> | null;
  npmCache: string | null;
}): Promise<Report> => {
  const { policy, pnpmScan, npmCache } = input;
  const locked = [
    ...parsePnpmLock(input.pnpmLockText),
    ...parseDenoLock(input.denoLockText),
  ];
  const resolved = new Map<
    string,
    { licence: string; resolution: Resolution }
  >();
  const byName = new Map<string, Set<string>>();
  const remember = (item: Locked, licence: string, resolution: Resolution) => {
    resolved.set(entryKey(item), { licence, resolution });
    if (resolution === "package.json") {
      const set = byName.get(item.name) ?? new Set<string>();
      set.add(licence);
      byName.set(item.name, set);
    }
  };

  // 1. Installed package metadata (pnpm) and the Deno npm cache, exact versions.
  const cacheMemo = new Map<string, string | null>();
  for (const item of locked) {
    if (item.ecosystem === "jsr") continue;
    const scanned = pnpmScan?.get(pairKey(item.name, item.version));
    if (scanned !== undefined) {
      remember(item, sanitizeLicence(scanned), "package.json");
      continue;
    }
    if (npmCache !== null) {
      const memoKey = pairKey(item.name, item.version);
      if (!cacheMemo.has(memoKey)) {
        cacheMemo.set(
          memoKey,
          await readDenoCachedLicence(npmCache, item.name, item.version),
        );
      }
      const cached = cacheMemo.get(memoKey);
      if (cached !== null && cached !== undefined) {
        remember(item, cached, "package.json");
      }
    }
  }
  // 2. Reviewed overrides.
  for (const item of locked) {
    if (resolved.has(entryKey(item))) continue;
    if (item.ecosystem === "jsr") {
      const override = policy.jsrOverrides.find((o) =>
        o.name === item.name && o.version === item.version
      );
      if (override) remember(item, override.licence, "override");
    } else {
      const override = policy.npmOverrides.find((o) =>
        o.name === item.name && o.versions.includes(item.version)
      );
      if (override) remember(item, override.licence, "override");
    }
  }
  // 3. Family mappings, reusing the single licence of a scanned reference.
  for (const item of locked) {
    if (resolved.has(entryKey(item)) || item.ecosystem === "jsr") continue;
    const family = policy.families.find((f) => item.name.startsWith(f.prefix));
    const licences = family ? byName.get(family.reference) : undefined;
    if (licences && licences.size === 1) {
      resolved.set(entryKey(item), {
        licence: [...licences][0],
        resolution: "family",
      });
    }
  }

  const entries: Entry[] = locked.map((item) => {
    const found = resolved.get(entryKey(item));
    const licence = found?.licence ?? "UNKNOWN";
    return {
      ecosystem: item.ecosystem,
      name: item.name,
      version: item.version,
      licence,
      resolution: found?.resolution ?? "package.json",
      status: found
        ? classify({ ...item, licence }, policy).status
        : "unresolved",
    };
  });
  const sorted = sortEntries(entries);
  return {
    format: "bakery-dependency-licences/1",
    lockfileSha256: {
      "pnpm-lock.yaml": await sha256(input.pnpmLockText),
      "deno.lock": await sha256(input.denoLockText),
    },
    summary: summarize(sorted),
    entries: sorted,
  };
};

// -------------------------------------------------------------------- CLI

const repoRoot = decodeURIComponent(
  new URL("../../", import.meta.url).pathname,
);
export const paths = {
  policy: `${repoRoot}scripts/licences/policy.json`,
  report: `${repoRoot}scripts/licences/dependency-licences.json`,
  pnpmLock: `${repoRoot}pnpm-lock.yaml`,
  denoLock: `${repoRoot}deno.lock`,
};

export const loadPolicy = async (path = paths.policy): Promise<Policy> =>
  PolicySchema.parse(JSON.parse(await Deno.readTextFile(path)));
export const loadReport = async (path = paths.report): Promise<Report> =>
  ReportSchema.parse(JSON.parse(await Deno.readTextFile(path)));

/** Reads the repo files and runs the gate. `withRescan` also re-runs pnpm. */
export const checkRepository = async (options: {
  withRescan: boolean;
  pnpmLockPath?: string;
  denoLockPath?: string;
}): Promise<CheckResult> => {
  const pnpmLockText = await Deno.readTextFile(
    options.pnpmLockPath ?? paths.pnpmLock,
  );
  const denoLockText = await Deno.readTextFile(
    options.denoLockPath ?? paths.denoLock,
  );
  return checkReport({
    report: await loadReport(),
    locked: [...parsePnpmLock(pnpmLockText), ...parseDenoLock(denoLockText)],
    policy: await loadPolicy(),
    rescan: options.withRescan ? await scanPnpm() : null,
  });
};

const optionValue = (
  args: readonly string[],
  flag: string,
): string | undefined =>
  args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);

const main = async (): Promise<number> => {
  const args = Deno.args;
  if (args.includes("--write")) {
    const policy = await loadPolicy();
    const pnpmScan = await scanPnpm();
    if (pnpmScan === null) {
      console.error(
        "pnpm licenses list --json failed offline; run pnpm install --frozen-lockfile first",
      );
      return 1;
    }
    const report = await buildReport({
      pnpmLockText: await Deno.readTextFile(paths.pnpmLock),
      denoLockText: await Deno.readTextFile(paths.denoLock),
      policy,
      pnpmScan,
      npmCache: await denoNpmCache(),
    });
    await Deno.writeTextFile(
      paths.report,
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      `wrote scripts/licences/dependency-licences.json: ${
        JSON.stringify(report.summary.byStatus)
      } total=${report.summary.total}`,
    );
    const lines = new Set<string>();
    for (const entry of report.entries) {
      if (entry.status === "unresolved") {
        lines.add(
          `UNRESOLVED: ${pairKey(entry.name, entry.version)} ${entry.licence}`,
        );
      }
      if (entry.status === "pendingOwnerDecision") {
        lines.add(pendingLine(entry, classify(entry, policy).reason ?? ""));
      }
    }
    for (const line of lines) console.log(line);
    return report.summary.byStatus.unresolved > 0 ? 1 : 0;
  }
  if (args.includes("--check")) {
    const result = await checkRepository({
      withRescan: true,
      pnpmLockPath: optionValue(args, "--pnpm-lock"),
      denoLockPath: optionValue(args, "--deno-lock"),
    });
    for (const line of result.pending) console.log(line);
    for (const note of result.notes) console.log(`note: ${note}`);
    for (const failure of result.failures) console.error(`FAIL: ${failure}`);
    if (result.ok) console.log("dependency licences: ok");
    return result.ok ? 0 : 1;
  }
  console.error(
    "usage: audit.ts --write | --check [--pnpm-lock=path] [--deno-lock=path]",
  );
  return 2;
};

if (import.meta.main) Deno.exit(await main());
