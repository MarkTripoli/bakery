/**
 * B1 import boundaries for the modular integrations architecture
 * (docs/technical-design/09-integrations.md section 12.8).
 *
 * This is the mechanical half of "a provider is an addition, not a rewrite".
 * Package exports alone enforce nothing, because a relative path walks straight
 * past them (`apps/worker` already reaches into `packages/contracts/src`), so the
 * boundary has to be read out of the source text itself.
 *
 * A ledger regression - a novel violation, a grown count, or a stale row - is a
 * non-zero exit. That is the only shape in which the ratchet means anything: the
 * comparison and the ledger can both be correct while nothing consumes them, and
 * a stale row is exactly the direction that silently re-admits coupling a later
 * slice removed. `--report-only` prints the same report and always exits 0 for a
 * person reading it by hand; no script or workflow uses it.
 *
 * Report-only was the design's starting mode through slices 1-4; the rows below
 * shrink one slice at a time and the rails never relax.
 *
 * Violations are counted per (rule, path) and compared against
 * `docs/technical-design/integration-baselines/boundaries.json`, so a slice that
 * fixes a file lowers its number and the ledger may only ever shrink. A ledger
 * entry that names a file with no remaining violations is itself a failure: a
 * ledger that can quietly over-count stops being a record of the truth.
 *
 * Usage:
 *   deno run --allow-read --allow-write scripts/check-integration-boundaries.ts
 *   deno run --allow-read --allow-write scripts/check-integration-boundaries.ts --report-only
 *   deno run --allow-read --allow-write scripts/check-integration-boundaries.ts --write-baseline
 */
import { extname, join, relative, resolve } from "node:path";

export const BOUNDARY_LEDGER_PATH =
  "docs/technical-design/integration-baselines/boundaries.json";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_ROOTS = ["apps", "packages"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".next"]);

/**
 * Directories whose imports are judged. A package that does not exist yet has no
 * violations, which is the right answer: the rail starts clean for new providers.
 */
/**
 * Prefix match that tolerates a trailing slash in the prefix.
 *
 * Written once because getting it wrong is silent: `startsWith("apps/web/")`
 * plus an extra separator matches nothing, and a zone rule that matches nothing
 * reports a clean tree no matter what the tree contains.
 */
const hasPrefix = (path: string, prefix: string) => {
  const base = prefix.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
};

const isWebZone = (path: string) =>
  hasPrefix(path, "apps/web/") || hasPrefix(path, "packages/ui/") ||
  isProviderWebZone(path);

const isProviderWebZone = (path: string) =>
  /^packages\/integration-[^/]+\/src\/web\//.test(path);

const isProviderPackage = (path: string) =>
  /^packages\/integration-[^/]+\//.test(path) && !isSdkPackage(path);

const isSdkPackage = (path: string) =>
  hasPrefix(path, "packages/integration-sdk");

/** The slug of a provider package, or undefined outside one. */
export function providerSlug(path: string): string | undefined {
  return /^packages\/integration-([^/]+)\//.exec(path)?.[1];
}

export const SERVER_REGISTRY =
  "apps/server/src/modules/integrations/registry.ts";
export const WEB_REGISTRY = "apps/web/src/integrations/registry.ts";

/**
 * Files that still hold provider code inside the generic core (section 12.6's
 * "provider-pending" list). They are exempt from the driver-tier bans until their
 * lift slice, and the list may only shrink: a new file here is a regression,
 * which the rails catch because the list is explicit rather than a pattern.
 */
export const PROVIDER_PENDING = Object.freeze([
  "apps/server/src/modules/integrations/callbacks.ts",
  "apps/server/src/modules/integrations/github-app-key.ts",
  "apps/server/src/modules/integrations/github-app.ts",
  "apps/server/src/modules/integrations/github-transport.ts",
  "apps/server/src/modules/integrations/intake-body.ts",
  "apps/server/src/modules/integrations/slack-identity-attempts.ts",
  "apps/server/src/modules/integrations/slack-identity-links.ts",
  "apps/server/src/modules/integrations/slack-identity.ts",
  "apps/server/src/modules/integrations/slack-scope.ts",
  "apps/server/src/modules/catalog/integration-providers/github.ts",
]);

const isProviderPending = (path: string) => PROVIDER_PENDING.includes(path);

/** Strip comments and string-free noise so a mention in a comment is not a violation. */
export function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match) => blank(match));
}

export type Import = { specifier: string; dynamic: boolean; typeOnly: boolean };

/**
 * Every module specifier in a file: `import`, `export ... from` and dynamic
 * `import()`. Comments are stripped first so documentation cannot trip the rail.
 */
export function importsOf(source: string): Import[] {
  const code = stripComments(source);
  const found: Import[] = [];
  const add = (specifier: string, typeOnly: boolean, dynamic: boolean) => {
    if (specifier.length > 0) found.push({ specifier, typeOnly, dynamic });
  };
  for (
    const match of code.matchAll(
      /\bimport\s+(type\s+)?(?:[^'"]*?\bfrom\s*)?["']([^"']+)["']/g,
    )
  ) add(match[2]!, match[1] !== undefined, false);
  for (
    const match of code.matchAll(
      /\bexport\s+(type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*["']([^"']+)["']/g,
    )
  ) add(match[2]!, match[1] !== undefined, false);
  for (
    const match of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)
  ) add(match[1]!, false, true);
  return found;
}

/** Resolve a relative specifier against the importing file, without the extension. */
export function resolveRelative(fromPath: string, specifier: string): string {
  const directory = fromPath.slice(0, fromPath.lastIndexOf("/"));
  const joined = resolve(ROOT, directory, specifier);
  const path = relative(ROOT, joined).replaceAll("\\", "/");
  return path.replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
}

/** The package root a file belongs to, as a repo-relative path. */
export function packageRoot(path: string): string {
  const match = /^packages\/integration-[^/]+\//.exec(path);
  return match ? match[0].slice(0, -1) : "";
}

const DRIVER_TIER_BANNED = [
  "pg",
  "postgres",
  "@bakery/persistence",
  "inngest",
  "hono",
] as const;

const isPackage = (specifier: string, name: string) =>
  specifier === name || specifier.startsWith(`${name}/`);

export type Violation = {
  rule: "b1a" | "b1b" | "b1c" | "b1d" | "b1e" | "b1f";
  path: string;
  specifier: string;
  detail: string;
};

/** (a) Web zones never reach server code. */
function webReachesServer(from: string, specifier: string): Violation | null {
  if (!isWebZone(from)) return null;
  const resolved = specifier.startsWith(".")
    ? resolveRelative(from, specifier)
    : specifier;
  const serverEntry = /^@bakery\/integration-[^/]+\/server$/.test(resolved);
  const reaches = serverEntry ||
    resolved === "@bakery/server" || resolved.startsWith("@bakery/server/") ||
    resolved.startsWith("apps/server/") ||
    /^packages\/integration-[^/]+\/src\/server\//.test(resolved);
  if (!reaches) return null;
  return {
    rule: "b1a",
    path: from,
    specifier,
    detail: "a web zone must never reach server code",
  };
}

/** (b) Only the two registries import /server and /web entries. */
function registryOnly(from: string, specifier: string): Violation | null {
  // `@bakery/integration-sdk` is the SDK every provider is written against, not a
  // provider, so its own `/web` and `/server` entries are ordinary imports. The
  // pattern excluded the SDK from `isProviderPackage` but not from here, which made
  // a provider's web module unable to import the types it exists to satisfy.
  if (/^@bakery\/integration-sdk\//.test(specifier)) return null;
  if (/^@bakery\/integration-[^/]+\/server$/.test(specifier)) {
    if (from === SERVER_REGISTRY) return null;
    return {
      rule: "b1b",
      path: from,
      specifier,
      detail: `only ${SERVER_REGISTRY} may import a provider /server entry`,
    };
  }
  if (/^@bakery\/integration-[^/]+\/web$/.test(specifier)) {
    if (from === WEB_REGISTRY) return null;
    return {
      rule: "b1b",
      path: from,
      specifier,
      detail: `only ${WEB_REGISTRY} may import a provider /web entry`,
    };
  }
  return null;
}

/** (c) No provider imports another provider. */
function crossProvider(from: string, specifier: string): Violation | null {
  const own = providerSlug(from);
  if (!own) return null;
  const target = /^@bakery\/integration-([^/]+)/.exec(specifier)?.[1];
  if (!target || target === "sdk" || target === own) return null;
  return {
    rule: "b1c",
    path: from,
    specifier,
    detail: `provider ${own} must not import provider ${target}`,
  };
}

/** (d) No relative import leaves its package root. */
function leavesPackage(from: string, specifier: string): Violation | null {
  if (!specifier.startsWith(".")) return null;
  const own = packageRoot(from);
  if (!own) return null;
  const resolved = resolveRelative(from, specifier);
  if (resolved.startsWith(`${own}/`)) return null;
  return {
    rule: "b1d",
    path: from,
    specifier,
    detail: `a relative import must not leave ${own}`,
  };
}

const SERVER_ALLOWED = [
  "@bakery/integration-sdk",
  "@bakery/integration-sdk/provider",
  "@bakery/contracts/http",
  "@bakery/contracts/integrations",
  "@bakery/contracts/ticket-admission",
  "zod",
];
const WEB_ALLOWED = [
  ...SERVER_ALLOWED,
  "@bakery/integration-sdk/web",
  "react",
  "@bakery/ui",
  "@bakery/i18n",
];
const DEFINITION_ALLOWED = [
  "zod",
  "@bakery/integration-sdk/provider",
];

/**
 * Which allowlist governs a file inside a provider package, if any.
 *
 * The SDK is not a provider package: it is the vocabulary the providers and the
 * core both speak, so it is judged by B1a/B1c only and may import the contracts
 * it describes.
 */
function allowlistFor(path: string): readonly string[] | null {
  if (!isProviderPackage(path)) return null;
  if (isProviderWebZone(path)) return WEB_ALLOWED;
  if (
    /\/(?:src\/)?(?:manifest|contracts)\//.test(path) ||
    path.endsWith("/src/manifest.ts")
  ) return DEFINITION_ALLOWED;
  if (/\/src\/server\//.test(path) || /\/src\/(?:testing)\//.test(path)) {
    return SERVER_ALLOWED;
  }
  return SERVER_ALLOWED;
}

function ownPackageAllowed(path: string, specifier: string): boolean {
  const slug = providerSlug(path);
  return slug !== undefined &&
    isPackage(specifier, `@bakery/integration-${slug}`);
}

/** (e) Provider packages import only from their allowlist plus their own package. */
function outsideAllowlist(from: string, specifier: string): Violation | null {
  const allowed = allowlistFor(from);
  if (!allowed) return null;
  if (specifier.startsWith(".")) return null;
  if (specifier.startsWith("node:")) return null;
  if (ownPackageAllowed(from, specifier)) return null;
  if (allowed.some((name) => isPackage(specifier, name))) return null;
  return {
    rule: "b1e",
    path: from,
    specifier,
    detail:
      "provider packages import only their allowlist plus their own package",
  };
}

/** (f) The driver tier reaches no environment, no driver and no bare fetch. */
function driverTierBan(from: string, specifier: string): Violation | null {
  if (!isProviderPackage(from) || isProviderPending(from)) return null;
  const banned = DRIVER_TIER_BANNED.find((name) => isPackage(specifier, name));
  if (banned) {
    return {
      rule: "b1f",
      path: from,
      specifier,
      detail: `a provider package must not import ${banned}; the host owns it`,
    };
  }
  if (specifier.startsWith("node:")) {
    return {
      rule: "b1f",
      path: from,
      specifier,
      detail: "a provider package must not import node builtins",
    };
  }
  return null;
}

const DRIVER_TIER_TEXT: ReadonlyArray<{ pattern: RegExp; detail: string }> = [
  { pattern: /\bDeno\s*\./, detail: "a provider package must not use Deno.*" },
  {
    pattern: /\bprocess\s*\.\s*env\b/,
    detail:
      "a provider package must not read process.env; the host injects ports",
  },
  {
    pattern: /(^|[^.\w])fetch\s*\(/,
    detail:
      "a provider package must not call bare fetch; the host owns transport",
  },
];

/**
 * Text-level driver-tier bans. They live beside the import check because a
 * provider that called `fetch` would be doing exactly what the import ban
 * forbids, by another route.
 */
export function driverTierTextViolations(
  path: string,
  source: string,
): Violation[] {
  if (!isProviderPackage(path) || isProviderPending(path)) return [];
  if (/\/src\/(?:manifest\.ts|contracts\/)/.test(path)) return [];
  const code = stripComments(source);
  const violations: Violation[] = [];
  for (const { pattern, detail } of DRIVER_TIER_TEXT) {
    if (pattern.test(code)) {
      violations.push({ rule: "b1f", path, specifier: "(source)", detail });
    }
  }
  return violations;
}

/** Every B1 violation in one file, given its repo-relative path and source. */
export function boundaryViolations(
  path: string,
  source: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const { specifier } of importsOf(source)) {
    for (
      const check of [
        webReachesServer,
        registryOnly,
        crossProvider,
        leavesPackage,
        outsideAllowlist,
        driverTierBan,
      ]
    ) {
      const violation = check(path, specifier);
      if (violation) violations.push(violation);
    }
  }
  violations.push(...driverTierTextViolations(path, source));
  return violations;
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

/** All violations across the scanned roots, as repo-relative paths. */
export async function collectViolations(): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const root of SCAN_ROOTS) {
    for await (const file of walk(join(ROOT, root))) {
      const path = relative(ROOT, file).replaceAll("\\", "/");
      const source = await Deno.readTextFile(file);
      violations.push(...boundaryViolations(path, source));
    }
  }
  return violations;
}

type Ledger = {
  schemaVersion: 1;
  description: string;
  counts: Record<string, number>;
};

export type LedgerComparison = {
  /** Violations not covered by the ledger: the migration regressed. */
  novel: Violation[];
  /** Ledger rows that no longer occur: the ledger must lose that line. */
  stale: string[];
  /** Ledger rows that now occur more often than allowed: also a regression. */
  exceeded: Array<{ key: string; actual: number; allowed: number }>;
};

/** The ledger key for one violation: rule plus file, so a count can shrink. */
export function ledgerKey(violation: Violation): string {
  return `${violation.rule}\t${violation.path}`;
}

export function countByKey(
  violations: readonly Violation[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    const key = ledgerKey(violation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Compare the current tree against the ledger.
 *
 * Three failures, each a distinct mistake: a novel violation means a slice added
 * coupling; an exceeded one means a slice added more of the coupling it was
 * meant to remove; a stale row means the ledger is over-counting, and an
 * over-counting ledger would let a later slice re-introduce the old coupling
 * without anyone noticing.
 */
export function compareToLedger(
  violations: readonly Violation[],
  ledger: Ledger,
): LedgerComparison {
  const actual = countByKey(violations);
  const novel: Violation[] = [];
  const exceeded: Array<{ key: string; actual: number; allowed: number }> = [];
  const seen = new Map<string, number>();
  for (const violation of violations) {
    const key = ledgerKey(violation);
    const allowed = ledger.counts[key] ?? 0;
    const position = (seen.get(key) ?? 0) + 1;
    seen.set(key, position);
    if (allowed === 0) novel.push(violation);
    else if (position > allowed) {
      exceeded.push({ key, actual: actual.get(key) ?? 0, allowed });
    }
  }
  // De-duplicate the "exceeded" rows: one report per key, not per extra hit.
  const uniqueExceeded = [
    ...new Map(exceeded.map((row) => [row.key, row])).values(),
  ];
  const reported = new Set(uniqueExceeded.map((row) => row.key));
  const stale = Object.keys(ledger.counts).filter((key) =>
    !actual.has(key) && !reported.has(key)
  );
  return { novel, stale, exceeded: uniqueExceeded };
}

export function buildLedger(violations: readonly Violation[]): Ledger {
  const counts: Record<string, number> = {};
  for (const [key, count] of countByKey(violations)) counts[key] = count;
  return {
    schemaVersion: 1,
    description:
      "B1 import-boundary debt per rule and file (chapter 09 section 12.8). This ledger may only shrink: a slice lowers its own lines, and the last slice deletes the file. `pnpm rails:integration-boundaries --write-baseline` regenerates it.",
    counts,
  };
}

export function formatReport(
  comparison: LedgerComparison,
  total: number,
): string {
  const lines: string[] = [];
  if (
    comparison.novel.length === 0 && comparison.stale.length === 0 &&
    comparison.exceeded.length === 0
  ) {
    lines.push(
      `B1 integration boundaries: ${total} recorded violation(s), no regression.`,
    );
    return lines.join("\n");
  }
  for (const violation of comparison.novel) {
    lines.push(
      `B1 ${violation.rule} new coupling ${violation.path} -> ${violation.specifier}: ${violation.detail}`,
    );
  }
  for (const row of comparison.exceeded) {
    const [rule, path] = row.key.split("\t");
    lines.push(
      `B1 ${rule} ${path}: ${row.actual} violations, ledger allows ${row.allowed}`,
    );
  }
  for (const key of comparison.stale) {
    const [rule, path] = key.split("\t");
    lines.push(
      `B1 ${rule} ${path}: ledger records debt that no longer exists; remove the line`,
    );
  }
  return lines.join("\n");
}

/**
 * The ledger text a caller supplies, or null to read the committed file.
 *
 * The rail test points the command at a planted ledger to prove the exit code,
 * and `test:rails` grants no filesystem write, so the ledger is passed as a
 * string rather than written into the tree: a test should not need write access
 * over the repository just to observe an exit status.
 */
export function ledgerFrom(
  environment: { get(name: string): string | undefined },
): Ledger | undefined {
  const inline = environment.get("BAKERY_INTEGRATION_LEDGER_JSON");
  if (inline === undefined || inline.length === 0) return undefined;
  return JSON.parse(inline) as Ledger;
}

async function readLedger(): Promise<Ledger> {
  const supplied = ledgerFrom(Deno.env);
  if (supplied !== undefined) return supplied;
  const text = await Deno.readTextFile(join(ROOT, BOUNDARY_LEDGER_PATH))
    .catch(() => null);
  if (text === null) {
    return { schemaVersion: 1, description: "", counts: {} };
  }
  return JSON.parse(text) as Ledger;
}

if (import.meta.main) {
  const args = new Set(Deno.args);
  const violations = await collectViolations();
  if (args.has("--write-baseline")) {
    const ledger = buildLedger(violations);
    const path = join(ROOT, BOUNDARY_LEDGER_PATH);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(
      `B1 integration boundaries: wrote ${
        Object.keys(ledger.counts).length
      } ledger row(s)`,
    );
    Deno.exit(0);
  }
  const comparison = compareToLedger(violations, await readLedger());
  const failed = comparison.novel.length > 0 ||
    comparison.stale.length > 0 || comparison.exceeded.length > 0;
  console.log(formatReport(comparison, violations.length));
  // Strict is the default and a regression is a non-zero exit. The reverse shape
  // - report unless `--strict`, with nothing in the repo passing `--strict` -
  // made this ratchet decorative: the comparison was right, the ledger was
  // right, and no exit code ever consumed either, so a stale line could sit
  // there while CI stayed green. `--report-only` exists for a person reading the
  // output by hand, and nothing calls it.
  if (failed && !args.has("--report-only")) Deno.exit(1);
  Deno.exit(0);
}
