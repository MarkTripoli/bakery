/**
 * B2 neutral-zone ratchet (docs/technical-design/09-integrations.md 12.8).
 *
 * B1 guards which module a file may import. B2 guards the other half of the same
 * problem: a "neutral" file that names a specific provider in its own text. A
 * comment saying "GitHub" is fine; an identifier, a string literal or an i18n
 * key saying `github` inside generic code is the coupling that makes a second
 * provider a rewrite.
 *
 * The count is a ratchet against
 * `docs/technical-design/integration-baselines/provider-literals.json`: a slice
 * that removes a mention lowers a line, a slice that adds one fails, and a line
 * with nothing left to count must be deleted. At zero the ledger file goes away
 * and the rule becomes strict.
 *
 * Usage:
 *   deno run --allow-read --allow-write scripts/check-provider-literals.ts
 *   deno run --allow-read --allow-write scripts/check-provider-literals.ts --write-baseline
 */
import { extname, join, relative } from "node:path";

export const LITERAL_LEDGER_PATH =
  "docs/technical-design/integration-baselines/provider-literals.json";

const ROOT = new URL("..", import.meta.url).pathname;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".next"]);

/**
 * The neutral zones from the design: generic core, generic work code, generic
 * contracts, the integrations pages minus their provider folder, the Issue
 * pages, and the string catalog outside the per-provider namespace.
 *
 * Each zone is a predicate rather than a glob because most of them are "this
 * directory, except one child", and a glob would have to be read carefully to
 * see that.
 */
export const NEUTRAL_ZONES: ReadonlyArray<
  { id: string; matches: (path: string) => boolean }
> = [
  {
    id: "integrations-core",
    // The generic core, minus the files still awaiting their lift (they are
    // provider code living in a neutral folder, which B1 tracks separately).
    matches: (path) =>
      path.startsWith("apps/server/src/modules/integrations/") &&
      !isProviderPendingFile(path),
  },
  {
    id: "work-tickets",
    matches: (path) =>
      path.startsWith("apps/server/src/modules/work/ticket-") ||
      path === "apps/server/src/modules/work/coordination-plan.ts",
  },
  {
    id: "projects",
    matches: (path) => path.startsWith("apps/server/src/modules/projects/"),
  },
  {
    id: "contracts",
    matches: (path) =>
      [
        "packages/contracts/src/ticket-admission.ts",
        "packages/contracts/src/integrations.ts",
        "packages/contracts/src/implemented-actions.ts",
      ].includes(path),
  },
  {
    id: "web-integrations",
    matches: (path) =>
      path.startsWith("apps/web/src/pages/integrations/") &&
      !path.startsWith("apps/web/src/pages/integrations/providers/"),
  },
  {
    id: "string-catalog",
    // The catalog is flat with dotted keys, so the namespace test happens per
    // key path in jsonHits rather than by path prefix here.
    matches: (path) => path === "packages/i18n/locales/en.json",
  },
  {
    id: "web-issues",
    matches: (path) =>
      /^apps\/web\/src\/pages\/(?:Issue[^/]*|issue-[^/]*)\.tsx?$/.test(path),
  },
];

/**
 * Files exempt from the integrations-core zone: they hold provider code that the
 * lift slices move out. Kept in step with the B1 list by the rail test, so the two
 * cannot drift into disagreeing about what "neutral" means.
 */
export const PROVIDER_PENDING_FILES = Object.freeze([
  "apps/server/src/modules/integrations/callbacks.ts",
  "apps/server/src/modules/integrations/github-app-key.ts",
  "apps/server/src/modules/integrations/github-app.ts",
  "apps/server/src/modules/integrations/github-transport.ts",
  "apps/server/src/modules/integrations/intake-body.ts",
  "apps/server/src/modules/integrations/slack-identity-attempts.ts",
  "apps/server/src/modules/integrations/slack-identity-links.ts",
  "apps/server/src/modules/integrations/slack-identity.ts",
  "apps/server/src/modules/integrations/slack-scope.ts",
  "apps/server/src/modules/integrations/registry.ts",
  "apps/server/src/modules/integrations/providers/",
]);

function isProviderPendingFile(path: string): boolean {
  return PROVIDER_PENDING_FILES.some((pending) =>
    pending.endsWith("/") ? path.startsWith(pending) : path === pending
  );
}

/**
 * The tokens the design names. `linear` is the awkward one: it is an English word
 * a neutral file may legitimately use ("linear time"), so it only counts as an
 * identifier segment, a quoted string or a dotted prefix.
 */
const PLAIN_TOKENS = [
  "github",
  "gitlab",
  "jira",
  "octokit",
  "x-hub-signature",
] as const;
const API_HOST = "api.github.com";
const LINEAR_TOKEN =
  /(?:^|[^A-Za-z0-9_$])linear(?=[."'`])|\blinear[A-Z_$]|[A-Za-z0-9_$]Linear\b|["'`]linear["'`]/i;

export type LiteralHit = { token: string; path: string };

/** Strip block and line comments so prose explaining a decision is not counted. */
export function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match) => blank(match));
}

export function zoneFor(path: string): string | undefined {
  return NEUTRAL_ZONES.find((zone) => zone.matches(path))?.id;
}

/** Provider mentions in one file's text, ignoring comments. */
export function literalHits(path: string, source: string): LiteralHit[] {
  if (extname(path) === ".json") return jsonHits(path, source);
  const code = stripComments(source);
  const lower = code.toLowerCase();
  const hits: LiteralHit[] = [];
  for (const token of PLAIN_TOKENS) {
    let index = lower.indexOf(token);
    while (index !== -1) {
      hits.push({ token, path });
      index = lower.indexOf(token, index + token.length);
    }
  }
  let host = lower.indexOf(API_HOST);
  while (host !== -1) {
    hits.push({ token: API_HOST, path });
    host = lower.indexOf(API_HOST, host + API_HOST.length);
  }
  if (LINEAR_TOKEN.test(code)) hits.push({ token: "linear", path });
  return hits;
}

/**
 * A JSON catalog counts keys, not values: the key path is the identifier an
 * application code path would use, and a translated value is just prose.
 */
function jsonHits(path: string, source: string): LiteralHit[] {
  const hits: LiteralHit[] = [];
  /**
   * Only keys are judged, never values: a translation is prose a person reads,
   * while a key is the identifier application code reaches for. The catalog is
   * flat with dotted keys, so the full key path is the segment to test.
   */
  const judgeKey = (keyPath: string) => {
    // integrations.<slug>.* is the one place per-provider strings may live.
    if (/^integrations\.[^.]+(\.|$)/.test(keyPath)) return;
    const lower = keyPath.toLowerCase();
    for (const token of PLAIN_TOKENS) {
      if (lower.includes(token)) hits.push({ token, path });
    }
    if (/[a-z]linear(?=[A-Z.]|$)|^linear[.]|[.]linear[.]/.test(keyPath)) {
      hits.push({ token: "linear", path });
    }
  };
  const visit = (value: unknown, prefix: string) => {
    if (value === null || typeof value !== "object") return;
    for (
      const [key, child] of Object.entries(value as Record<string, unknown>)
    ) {
      const keyPath = prefix ? `${prefix}.${key}` : key;
      judgeKey(keyPath);
      visit(child, keyPath);
    }
  };
  try {
    visit(JSON.parse(source), "");
  } catch {
    return [];
  }
  return hits;
}

async function* walk(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await Array.fromAsync(Deno.readDir(directory));
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(path);
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      yield path;
    }
  }
}

/** Where the string catalog lives; it is scanned as JSON, not as source. */
export const CATALOG_PATH = "packages/i18n/locales/en.json";

export async function collectLiteralHits(): Promise<LiteralHit[]> {
  const hits: LiteralHit[] = [];
  for (const root of ["apps", "packages"]) {
    for await (const file of walk(join(ROOT, root))) {
      const path = relative(ROOT, file).replaceAll("\\", "/");
      if (zoneFor(path) === undefined) continue;
      hits.push(...literalHits(path, await Deno.readTextFile(file)));
    }
  }
  for (const catalog of [CATALOG_PATH]) {
    const text = await Deno.readTextFile(join(ROOT, catalog)).catch(() => null);
    if (text === null) continue;
    // The catalog is its own neutral zone: everything outside
    // integrations.<slug>.* must stay provider-free.
    hits.push(...jsonHits(catalog, text));
  }
  return hits;
}

export type LiteralLedger = {
  schemaVersion: 1;
  description: string;
  counts: Record<string, number>;
};

export const literalKey = (hit: LiteralHit) => `${hit.path}\t${hit.token}`;

export function buildLiteralLedger(hits: readonly LiteralHit[]): LiteralLedger {
  const counts: Record<string, number> = {};
  for (const hit of hits) {
    const key = literalKey(hit);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return {
    schemaVersion: 1,
    description: [
      "B2 provider-literal debt in neutral zones (chapter 09 section 12.8),",
      "one row per file and token. This ledger may only shrink; when it reaches",
      "zero the file is deleted and the rule becomes strict.",
    ].join(" "),
    counts,
  };
}

export type LiteralComparison = {
  novel: LiteralHit[];
  grown: Array<{ key: string; actual: number; allowed: number }>;
  stale: string[];
};

export function compareLiterals(
  hits: readonly LiteralHit[],
  ledger: LiteralLedger,
): LiteralComparison {
  const totals = new Map<string, number>();
  for (const hit of hits) {
    const key = literalKey(hit);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const novel: LiteralHit[] = [];
  const grown: Array<{ key: string; actual: number; allowed: number }> = [];
  const seen = new Map<string, number>();
  for (const hit of hits) {
    const key = literalKey(hit);
    const allowed = ledger.counts[key] ?? 0;
    const position = (seen.get(key) ?? 0) + 1;
    seen.set(key, position);
    if (allowed === 0) novel.push(hit);
    else if (position > allowed && !grown.some((row) => row.key === key)) {
      grown.push({ key, actual: totals.get(key) ?? 0, allowed });
    }
  }
  const reported = new Set(grown.map((row) => row.key));
  const stale = Object.keys(ledger.counts).filter((key) =>
    !totals.has(key) && !reported.has(key)
  );
  return { novel, grown, stale };
}

export function formatLiteralReport(
  comparison: LiteralComparison,
  total: number,
): string {
  const clean = comparison.novel.length === 0 &&
    comparison.grown.length === 0 &&
    comparison.stale.length === 0;
  if (clean) {
    return `B2 provider literals: ${total} recorded mention(s), no regression.`;
  }
  const lines: string[] = [];
  for (const hit of comparison.novel) {
    lines.push(
      `B2 new provider mention ${hit.path}: "${hit.token}" in a neutral zone; take it through the provider package instead`,
    );
  }
  for (const row of comparison.grown) {
    const [path, token] = row.key.split("\t");
    lines.push(
      `B2 ${path}: "${token}" appears ${row.actual} times, ledger allows ${row.allowed}`,
    );
  }
  for (const key of comparison.stale) {
    const [path, token] = key.split("\t");
    lines.push(
      `B2 ${path}: ledger records "${token}" but it is gone; remove the line`,
    );
  }
  return lines.join("\n");
}

async function readLedger(): Promise<LiteralLedger> {
  const text = await Deno.readTextFile(join(ROOT, LITERAL_LEDGER_PATH)).catch(
    () => null,
  );
  if (text === null) {
    return { schemaVersion: 1, description: "", counts: {} };
  }
  return JSON.parse(text) as LiteralLedger;
}

if (import.meta.main) {
  const args = new Set(Deno.args);
  const hits = await collectLiteralHits();
  if (args.has("--write-baseline")) {
    const ledger = buildLiteralLedger(hits);
    const path = join(ROOT, LITERAL_LEDGER_PATH);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(
      `B2 provider literals: wrote ${
        Object.keys(ledger.counts).length
      } ledger row(s)`,
    );
    Deno.exit(0);
  }
  const comparison = compareLiterals(hits, await readLedger());
  console.log(formatLiteralReport(comparison, hits.length));
  const failed = comparison.novel.length > 0 || comparison.grown.length > 0 ||
    comparison.stale.length > 0;
  if (args.has("--strict") && failed) Deno.exit(1);
  Deno.exit(0);
}
