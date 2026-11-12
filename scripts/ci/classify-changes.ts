export type ChangeEntry = {
  status: string;
  paths: readonly string[];
};

const DOC_TEXT_EXTENSIONS = new Set([
  ".adoc",
  ".md",
  ".mdx",
  ".rdoc",
  ".rst",
  ".txt",
]);

const isAllowedDocumentationPath = (path: string): boolean => {
  if (path.includes("\0") || path.startsWith("/") || path.includes("..")) {
    return false;
  }
  if (path.startsWith("learnings/") && path.endsWith(".xml")) return true;
  if (!path.startsWith("docs/")) return false;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot > 0 && DOC_TEXT_EXTENSIONS.has(basename.slice(dot));
};

export function parseNameStatusZ(output: string): ChangeEntry[] | null {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: ChangeEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status || !/^[A-Z][0-9]*$/.test(status)) return null;
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    if (paths.length !== pathCount || paths.some((path) => !path)) return null;
    entries.push({ status, paths });
    index += pathCount;
  }
  return entries;
}

export function classifyChanges(
  entries: readonly ChangeEntry[],
): "docs" | "full" {
  if (entries.length === 0) return "full";
  return entries.every((entry) => entry.paths.every(isAllowedDocumentationPath))
    ? "docs"
    : "full";
}

export function classifyNameStatusZ(output: string): "docs" | "full" {
  const entries = parseNameStatusZ(output);
  return entries === null ? "full" : classifyChanges(entries);
}

export type AffectedPathRule = {
  /** Human-readable table row label, used by the routing tests. */
  key: string;
  /** Plain path prefixes that select this row. */
  prefixes?: readonly string[];
  /** Extra structured match for subtrees that cannot be written as one prefix. */
  pattern?: RegExp;
  /**
   * Heavy lanes selected by this row. `null` pins the row to the conservative
   * default: an unclassifiable path (infra, verification plumbing, fixtures,
   * helpers, baselines, exact root manifests) forces the full route so a
   * change to anything that feeds every lane re-proves everything instead of
   * silently skipping coverage.
   */
  lanes: readonly string[] | null;
};

/**
 * The path → heavy-lane map for main pushes. Every heavy lane key equals the
 * `lane` in scripts/ci/required-checks.json. Rules are first match per path
 * (most specific first: migrations before the apps/server subtree,
 * packages/ui/storybook before packages/ui/, baselines before the docs
 * fallback); the union across all changed paths decides the route. Fast lanes
 * are intentionally absent: admission is by changed FILE content, and the
 * fast lanes run on every non-pr event regardless. Paths with no matching
 * rule are unknown → full.
 *
 * Note on prerequisites: the e2e lane needs integration + security in the
 * graph (`needs.integration.result == 'success' &&
 * needs.security.result == 'success'`) and the paper parity shards need
 * ui_catalog/ui_quality/ui_storybook_browser, so rows that select those
 * dependents include their prerequisite lanes here too — a selected
 * dependent must never have an unselected prerequisite.
 */
export const AFFECTED_LANES_TABLE: readonly AffectedPathRule[] = [
  {
    key: "apps/server/src/modules/*/migrations/",
    pattern: /^apps\/server\/src\/modules\/[^/]+\/migrations\//,
    lanes: ["integration_tests", "recovery_tests", "e2e_tests"],
  },
  {
    key: "contract catalog sources (same scope as packages/contracts)",
    prefixes: [
      "docs/technical-design/api-catalog.json",
      "docs/technical-design/data-model.json",
      "docs/technical-design/transport-schemas.json",
    ],
    lanes: [
      "contract_description_gate",
      "contract_description_gate_b",
      "contract_description_gate_c",
      "integration_tests",
      "security_tests",
      "recovery_tests",
      "e2e_tests",
    ],
  },
  {
    key: "infrastructure and plumbing (conservative default: full)",
    prefixes: [
      "tests/fixtures/",
      "tests/helpers/",
      "scripts/",
      ".github/",
      "infra/",
      "packages/config/",
      "packages/ui/storybook",
      "docs/technical-design/ui-baselines/",
      "deno.lock",
      "deno.json",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ],
    lanes: null,
  },
  {
    key: "apps/server/",
    prefixes: ["apps/server/"],
    lanes: [
      "integration_tests",
      "security_tests",
      "recovery_tests",
      "e2e_tests",
      "browser_tests",
      "ui_web_browser",
      "ui_web_browser_b",
      "ui_web_browser_c",
      "ui_web_browser_d",
    ],
  },
  {
    key: "apps/worker/",
    prefixes: ["apps/worker/"],
    lanes: [
      "integration_tests",
      "security_tests",
      "recovery_tests",
      "e2e_tests",
      "native_worker",
    ],
  },
  {
    key: "apps/web/",
    prefixes: ["apps/web/"],
    lanes: [
      "browser_tests",
      "ui_web_browser",
      "ui_web_browser_b",
      "ui_web_browser_c",
      "ui_web_browser_d",
      "ui_catalog",
      "ui_quality",
      "ui_architecture",
      "ui_storybook_browser",
      "ui_paper_runtime",
      "ui_paper_entitlements",
      "ui_paper_artifacts",
    ],
  },
  {
    key: "packages/ui/",
    prefixes: ["packages/ui/"],
    lanes: [
      "ui_catalog",
      "ui_quality",
      "ui_architecture",
      "ui_storybook_browser",
      "ui_paper_runtime",
      "ui_paper_entitlements",
      "ui_paper_artifacts",
    ],
  },
  {
    key: "packages/contracts/",
    prefixes: ["packages/contracts/"],
    lanes: [
      "contract_description_gate",
      "contract_description_gate_b",
      "contract_description_gate_c",
      "integration_tests",
      "security_tests",
      "e2e_tests",
    ],
  },
  {
    key: "packages/integration-sdk/",
    prefixes: ["packages/integration-sdk/"],
    lanes: [
      "contract_description_gate",
      "contract_description_gate_b",
      "contract_description_gate_c",
      "integration_tests",
      "security_tests",
      "recovery_tests",
      "e2e_tests",
      "browser_tests",
      "ui_web_browser",
      "ui_web_browser_b",
      "ui_web_browser_c",
      "ui_web_browser_d",
    ],
  },
  {
    key: "packages/persistence/",
    prefixes: ["packages/persistence/"],
    lanes: ["integration_tests", "security_tests", "recovery_tests"],
  },
  {
    key: "packages/i18n/",
    prefixes: ["packages/i18n/"],
    lanes: [
      "browser_tests",
      "ui_web_browser",
      "ui_web_browser_b",
      "ui_web_browser_c",
      "ui_web_browser_d",
    ],
  },
  {
    // Zero-dependency installer core. Its tests are unit tests, and the fast
    // lanes run on every change, so no heavy lane is selected.
    key: "packages/worker-bootstrap/",
    prefixes: ["packages/worker-bootstrap/"],
    lanes: [],
  },
  {
    key: "tests/browser/",
    prefixes: ["tests/browser/"],
    lanes: ["browser_tests"],
  },
  {
    key: "tests/integration/",
    prefixes: ["tests/integration/"],
    lanes: ["integration_tests"],
  },
  {
    key: "tests/security/",
    prefixes: ["tests/security/"],
    lanes: ["security_tests"],
  },
  {
    key: "tests/recovery/",
    prefixes: ["tests/recovery/"],
    lanes: ["recovery_tests"],
  },
  {
    key: "tests/e2e/",
    prefixes: ["tests/e2e/"],
    lanes: ["e2e_tests", "integration_tests", "security_tests"],
  },
  {
    key: "tests/native/",
    prefixes: ["tests/native/"],
    lanes: ["native_worker"],
  },
  {
    key: "tests/contract/",
    prefixes: ["tests/contract/"],
    lanes: [
      "contract_description_gate",
      "contract_description_gate_b",
      "contract_description_gate_c",
    ],
  },
  {
    key: "tests/rails/",
    prefixes: ["tests/rails/"],
    lanes: ["rails"],
  },
  {
    key: "tests/provider/",
    prefixes: ["tests/provider/"],
    lanes: [],
  },
  {
    key: "tests/unit/",
    prefixes: ["tests/unit/"],
    lanes: [],
  },
  {
    key: "tests/compatibility/",
    prefixes: ["tests/compatibility/"],
    lanes: ["integration_tests"],
  },
  {
    key: "tests/connected/",
    prefixes: ["tests/connected/"],
    lanes: [
      "e2e_tests",
      "browser_tests",
      "ui_web_browser",
      "ui_web_browser_b",
      "ui_web_browser_c",
      "ui_web_browser_d",
      "integration_tests",
      "security_tests",
    ],
  },
  {
    key: "tests/r2/",
    prefixes: ["tests/r2/"],
    lanes: ["integration_tests", "recovery_tests"],
  },
];

const matchAffectedRule = (path: string): AffectedPathRule | undefined =>
  AFFECTED_LANES_TABLE.find((rule) =>
    rule.pattern !== undefined && rule.pattern.test(path) ||
    (rule.prefixes ?? []).some((prefix) => path.startsWith(prefix))
  );

/**
 * Maps a push diff to the heavy lanes it affects. Returns the lane-key union
 * across all changed paths, or `null` when the path cannot be classified
 * (unknown, infra, fixtures, helpers, baselines, root manifests) and the run
 * must take the conservative `full` route. Allowed documentation paths and
 * `tests/unit` contribute no lanes; unaffected docs changes ride along under
 * the affected route. Empty diffs never reach this function (`full`).
 */
export function affectedLanes(
  entries: readonly ChangeEntry[],
): readonly string[] | null {
  if (entries.length === 0) return null;
  const lanes = new Set<string>();
  for (const entry of entries) {
    for (const path of entry.paths) {
      if (isAllowedDocumentationPath(path)) continue;
      const rule = matchAffectedRule(path);
      if (!rule || rule.lanes === null) return null;
      for (const lane of rule.lanes) lanes.add(lane);
    }
  }
  return [...lanes];
}

export type Route = "docs" | "gate" | "full" | "affected";

/**
 * A pull request runs the fast gate, never the post-merge heavy lanes: the
 * whole point of the split is that a PR gets a bounded answer in minutes while
 * the full evidence lanes run on main pushes, the nightly schedule and manual
 * dispatch. Documentation-only diffs keep their own lane on every event.
 * A main push classified as affected runs only the heavy lanes its changed
 * paths selected; an unclassifiable push runs full.
 *
 * The nightly schedule and manual dispatch are the blanket-green full route:
 * they always run every lane regardless of diff content, so issue-closure
 * evidence citing "checked-green exact-head CI" reads as the affected lanes
 * at that head plus the most recent nightly full.
 */
export function routeForEvent(
  route: Exclude<Route, "gate">,
  event: string | undefined,
): Route {
  if (route === "docs") return "docs";
  if (route === "affected") {
    if (event === "pull_request") return "gate";
    return event === "push" ? "affected" : "full";
  }
  return event === "pull_request" ? "gate" : "full";
}

async function run(): Promise<void> {
  const event = Deno.env.get("GITHUB_EVENT_NAME");
  const base = Deno.env.get("BASE_SHA");
  const head = Deno.env.get("HEAD_SHA");
  const outputPath = Deno.env.get("GITHUB_OUTPUT");
  const emit = (route: Exclude<Route, "gate">, reason: string): void => {
    const routed = routeForEvent(route, event);
    console.error(`ci routing: ${routed} (${reason})`);
    if (outputPath) {
      Deno.writeTextFileSync(outputPath, `route=${routed}\n`);
    }
  };
  const full = (reason: string): void => emit("full", reason);
  const required = (
    value: string | undefined,
    name: string,
  ): string | undefined => {
    if (!value) full(`missing ${name}`);
    return value;
  };
  if (!base || !head || !outputPath) return;
  const baseSha = required(base, "immutable base SHA") as string;
  const headSha = required(head, "immutable head SHA") as string;
  const output = required(outputPath, "GITHUB_OUTPUT") as string;
  const command = new Deno.Command("git", {
    args: [
      "diff",
      "--no-ext-diff",
      "--name-status",
      "-z",
      "--find-renames",
      baseSha,
      headSha,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    full("base-to-head diff failed");
    return;
  }
  const decoded = new TextDecoder().decode(result.stdout);
  const route = classifyNameStatusZ(decoded);
  if (route !== "full") {
    const routed = routeForEvent(route, event);
    Deno.writeTextFileSync(
      output,
      `route=${routed}\nlanes=[]\n`,
    );
    console.log(`ci routing: ${routed}`);
    return;
  }
  const classifiedRoute: Route = "affected";
  if (event !== "push") {
    full("non-push full diff");
    return;
  }
  const entries = parseNameStatusZ(decoded);
  const lanes = entries === null ? null : affectedLanes(entries);
  if (lanes === null) {
    full("unclassifiable changed path");
    return;
  }
  const routed = routeForEvent(classifiedRoute, event);
  Deno.writeTextFileSync(
    output,
    `route=${routed}\nlanes=${JSON.stringify(lanes)}\n`,
  );
  console.log(`ci routing: ${routed}`);
}

if (import.meta.main) await run();
