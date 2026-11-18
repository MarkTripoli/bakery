import { assert, assertEquals } from "@std/assert";
import {
  buildLiteralLedger,
  CATALOG_PATH,
  collectLiteralHits,
  compareLiterals,
  LITERAL_LEDGER_PATH,
  literalHits,
  literalKey,
  NEUTRAL_ZONES,
  PROVIDER_PENDING_FILES,
  zoneFor,
} from "../../scripts/check-provider-literals.ts";
import { PROVIDER_PENDING } from "../../scripts/check-integration-boundaries.ts";

const root = new URL("../..", import.meta.url).pathname;

Deno.test("every neutral zone is recognised and a provider package is not", () => {
  const zones: Array<[string, string]> = [
    ["apps/server/src/modules/integrations/actions.ts", "integrations-core"],
    ["apps/server/src/modules/work/ticket-store.ts", "work-tickets"],
    ["apps/server/src/modules/work/coordination-plan.ts", "work-tickets"],
    ["apps/server/src/modules/projects/repository-binding.ts", "projects"],
    ["packages/contracts/src/ticket-admission.ts", "contracts"],
    ["packages/contracts/src/integrations.ts", "contracts"],
    ["packages/contracts/src/implemented-actions.ts", "contracts"],
    ["apps/web/src/pages/integrations/ListPage.tsx", "web-integrations"],
    ["apps/web/src/pages/IssueDetail.tsx", "web-issues"],
  ];
  for (const [path, zone] of zones) {
    assertEquals(zoneFor(path), zone, path);
  }
  // The per-provider folder and the provider packages are NOT neutral: they are
  // where provider names live on purpose.
  for (
    const path of [
      "apps/web/src/pages/integrations/providers/github/Panel.tsx",
      "packages/integration-github/src/server/tickets.ts",
    ]
  ) {
    assertEquals(zoneFor(path), undefined, path);
  }
});

Deno.test("a provider-pending file is exempt from the core zone, nothing else is", () => {
  for (const path of PROVIDER_PENDING) {
    assertEquals(zoneFor(path), undefined, `${path} must be exempt`);
  }
  // One path away from the pending list is still neutral, so the exemption is
  // about the file and not about the folder.
  assert(zoneFor("apps/server/src/modules/integrations/github-like.ts"));
});

Deno.test("the two rails agree on which files are provider-pending", () => {
  // B1 and B2 describe the same exemption from opposite directions (imports and
  // text). If they disagreed, one would report a file the other had already
  // declared lifted.
  const b2 = new Set(
    PROVIDER_PENDING_FILES.filter((path) => !path.endsWith("/")),
  );
  for (const path of PROVIDER_PENDING) {
    if (
      path === "apps/server/src/modules/catalog/integration-providers/github.ts"
    ) {
      continue; // lives outside the integrations core; B2's zones never see it
    }
    assert(b2.has(path), `${path} is pending in B1 but not exempt in B2`);
  }
});

Deno.test("each token is counted where the design says it counts", () => {
  const path = "apps/server/src/modules/integrations/actions.ts";
  const hits = (source: string) =>
    literalHits(path, source).map((hit) => hit.token);
  assertEquals(hits('const provider = "github";'), ["github"]);
  // api.github.com contains "github", so both tokens are recorded: the host is
  // the sharper fact and the substring is what the ledger counts.
  assertEquals(hits('const x = "api.github.com";'), [
    "github",
    "api.github.com",
  ]);
  assertEquals(hits('const host = "x-hub-signature";'), ["x-hub-signature"]);
  // A type annotation and its value are two mentions; each is a place the
  // provider is named, so both count.
  assertEquals(hits('const kind: "gitlab" = "gitlab";'), ["gitlab", "gitlab"]);
  assertEquals(hits('const t = "JIRA";'), ["jira"]);
  // The import specifier and the imported binding are two mentions on one line,
  // which is why the ledger counts occurrences rather than lines.
  assertEquals(hits('import { Octokit } from "octokit";'), [
    "octokit",
    "octokit",
  ]);
});

Deno.test("a comment explaining a provider decision is not coupling", () => {
  const path = "apps/server/src/modules/integrations/actions.ts";
  assertEquals(
    literalHits(
      path,
      [
        "// GitHub is one provider; Linear and Jira come later.",
        "/* octokit was removed when the broker became transport-injected */",
        "export const provider = genericProvider;",
      ].join("\n"),
    ),
    [],
  );
});

Deno.test("linear only counts as an identifier, never as the English word", () => {
  const path = "apps/server/src/modules/projects/repository-binding.ts";
  const hits = (source: string) =>
    literalHits(path, source).map((hit) => hit.token);
  // Prose and comments are fine.
  assertEquals(hits("// this runs in linear time"), []);
  // A quoted "linear" is the provider slug, not the English word, so it counts.
  assertEquals(hits("const cost = 'linear';"), ["linear"]);
  // An identifier is coupling too.
  assertEquals(hits('const slug = "linear";'), ["linear"]);
  assertEquals(hits("const linearProvider = 1;"), ["linear"]);
});

Deno.test("the catalog counts keys, not translated prose", () => {
  const catalog =
    '{"settings.integrations.github.heading":"Connect GitHub","core.actions.open":"Open"}';
  assertEquals(literalHits(CATALOG_PATH, catalog).map((hit) => hit.token), [
    "github",
  ]);
  // integrations.<slug>.* is the sanctioned home for per-provider strings, so a
  // key there is not debt.
  const sanctioned =
    '{"integrations.github.heading":"Connect","integrations.github.body":"Body"}';
  assertEquals(literalHits(CATALOG_PATH, sanctioned), []);
  // A value mentioning a provider is prose, and stays clean.
  assertEquals(
    literalHits(CATALOG_PATH, '{"core.actions.open":"Open in GitHub"}'),
    [],
  );
});

Deno.test("the ledger distinguishes new, grown and stale mentions", () => {
  const path = "apps/server/src/modules/integrations/actions.ts";
  const one = literalHits(path, 'const provider = "github";');
  const ledger = buildLiteralLedger(one);
  assertEquals(compareLiterals(one, ledger), {
    novel: [],
    grown: [],
    stale: [],
  });
  const two = literalHits(path, 'const a = "github"; const b = "github";');
  const grown = compareLiterals(two, ledger);
  assertEquals(grown.grown.map((row) => row.allowed), [1]);
  const novel = literalHits(
    "apps/server/src/modules/projects/x.ts",
    'const p = "gitlab";',
  );
  assertEquals(compareLiterals(novel, ledger).novel.length, 1);
  assertEquals(compareLiterals([], ledger).stale, [literalKey(one[0]!)]);
});

Deno.test("the committed literal ledger matches the tree and may only shrink", async () => {
  const ledgerText = await Deno.readTextFile(`${root}${LITERAL_LEDGER_PATH}`);
  const ledger = JSON.parse(ledgerText) as ReturnType<
    typeof buildLiteralLedger
  >;
  assertEquals(ledger.schemaVersion, 1);
  const comparison = compareLiterals(await collectLiteralHits(), ledger);
  assertEquals(
    comparison.novel.map((hit) => literalKey(hit)),
    [],
    "a neutral file gained a provider mention; take it through the provider package",
  );
  assertEquals(comparison.grown, []);
  assertEquals(comparison.stale, []);
});

Deno.test("the recorded debt is real, not an empty ledger pretending to be clean", async () => {
  // A ledger of zero rows would make the ratchet above vacuous: it would pass
  // while measuring nothing. This pins that the neutral zones genuinely still
  // carry provider names, so a slice that clears them is visible as a shrinking
  // number rather than a silent no-op.
  const ledgerText = await Deno.readTextFile(`${root}${LITERAL_LEDGER_PATH}`);
  const ledger = JSON.parse(ledgerText) as ReturnType<
    typeof buildLiteralLedger
  >;
  const total = Object.values(ledger.counts).reduce(
    (sum, count) => sum + count,
    0,
  );
  assert(total > 0, "the ledger should still record the migration's real debt");
  const zones = new Set(
    Object.keys(ledger.counts).map((key) => zoneFor(key.split("\t")[0]!)),
  );
  assert(zones.size > 0);
  for (const zone of zones) {
    assert(
      zone !== undefined &&
        NEUTRAL_ZONES.some((candidate) => candidate.id === zone),
      `ledger names a file outside every neutral zone: ${zone}`,
    );
  }
});
