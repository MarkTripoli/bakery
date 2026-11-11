import { assert, assertEquals } from "@std/assert";
import {
  classifyRepositoryRuleImpact,
  codePointLength,
  evaluateRuleSample,
  type HeaderOptions,
  validateConventionalHeader,
} from "../../packages/contracts/src/repository-rule-preview.ts";
import {
  type EffectiveRepositoryRuleEntry,
  type OrganizationRepositoryRules,
  type RepositoryRuleOverrides,
  resolveRepositoryRuleEntries,
} from "../../packages/contracts/src/repository-rules.ts";
import {
  acquirePreviewSlot,
  mapPreviewDatabaseError,
  parseOverrideSummaries,
  PREVIEW_MAX_GLOBAL,
  PREVIEW_MAX_PER_ORGANIZATION,
  PREVIEW_MAX_PER_PRINCIPAL,
} from "../../apps/server/src/modules/repository-rules/previews.ts";
import { writeStatementsOf } from "../helpers/sql-write-detector.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  commitsEntry,
  titleEntry,
} from "../helpers/repository-rule-entries.ts";

const options: HeaderOptions = {
  types: ["feat", "fix", "chore"],
  scope: "optional",
  maxSubjectLength: 20,
};
const codes = (header: string, overrides: Partial<HeaderOptions> = {}) =>
  validateConventionalHeader(header, { ...options, ...overrides }).map((
    finding,
  ) => finding.code);

Deno.test("conventional header table: valid headers produce no findings", () => {
  for (
    const header of [
      "feat: add thing",
      "fix(api): handle null",
      "chore!: drop node 18",
      "feat(core)!: rename option",
      "fix(a-b_c.d): x",
      "feat: " + "x".repeat(20),
      "feat: " + "é".repeat(20),
      "feat: " + "😀".repeat(20),
      "feat: ünïcode ✓",
    ]
  ) assertEquals(codes(header), [], header);
});

Deno.test("conventional header table: each defect has its own code", () => {
  const table: Array<[string, string[]]> = [
    ["", ["header_empty"]],
    ["   ", ["header_empty"]],
    ["add thing", ["separator_missing"]],
    [": subject", ["type_missing"]],
    ["(core): subject", ["type_missing"]],
    ["!: subject", ["type_missing"]],
    ["Feat: add thing", ["type_uppercase"]],
    ["FEAT: add thing", ["type_uppercase"]],
    ["feat_x: add thing", ["type_invalid_characters"]],
    ["fe at: add thing", ["type_invalid_characters"]],
    ["docs: add thing", ["type_not_allowed"]],
    ["feat(: add thing", ["scope_malformed"]],
    ["feat(): add thing", ["scope_malformed"]],
    ["feat(a b): add thing", ["scope_malformed"]],
    ["feat((a)): add thing", ["scope_malformed"]],
    ["feat(a: add thing", ["scope_malformed"]],
    ["feat:add thing", ["space_after_colon_missing"]],
    ["feat:", ["subject_empty"]],
    ["feat: ", ["subject_empty"]],
    ["feat:   ", ["subject_empty"]],
    ["feat:  two spaces", ["subject_leading_space"]],
    ["feat(core) : add thing", ["separator_missing"]],
    ["feat!(core): add thing", ["separator_missing"]],
    ["feat: " + "x".repeat(21), ["subject_too_long"]],
    ["feat: " + "😀".repeat(21), ["subject_too_long"]],
  ];
  for (const [header, expected] of table) {
    assertEquals(codes(header), expected, JSON.stringify(header));
  }
});

Deno.test("subject length boundary is inclusive and counts code points", () => {
  for (const max of [20, 72, 200]) {
    assertEquals(
      codes("feat: " + "x".repeat(max), { maxSubjectLength: max }),
      [],
    );
    assertEquals(
      codes("feat: " + "x".repeat(max + 1), { maxSubjectLength: max }),
      ["subject_too_long"],
    );
  }
  assertEquals(codePointLength("a😀b"), 3);
  assertEquals(codePointLength(""), 0);
});

Deno.test("scope requirement is reported alongside other findings", () => {
  assertEquals(codes("feat: add", { scope: "required" }), ["scope_required"]);
  assertEquals(codes("feat(core): add", { scope: "required" }), []);
  assertEquals(
    codes("feat: " + "x".repeat(21), { scope: "required" }),
    ["scope_required", "subject_too_long"],
  );
});

Deno.test("adversarial input stays linear and bounded", () => {
  const started = performance.now();
  const hostile = [
    "(".repeat(200_000),
    "feat(" + "(".repeat(200_000),
    "feat" + "!".repeat(200_000) + ":",
    "a".repeat(1_000_000),
    "feat: " + " ".repeat(1_000_000) + "x",
    ("feat(" + "a".repeat(1000) + "):").repeat(500),
    "\u0000".repeat(100_000),
    "\ud800".repeat(100_000),
  ];
  for (const input of hostile) validateConventionalHeader(input, options);
  const elapsed = performance.now() - started;
  assert(elapsed < 2000, `took ${elapsed}ms`);
  // The same hostile text through the sample evaluator is capped by the
  // schema limits first, then by the evaluator's own slices.
  const entry = {
    ...commitsEntry(false),
    provenance: "inherited",
    organizationRevision: 1,
  } as unknown as EffectiveRepositoryRuleEntry;
  const results = evaluateRuleSample([entry], {
    commitMessages: Array(100).fill("(".repeat(1_000_000)),
  });
  assert(
    results[0].evaluated <= 20,
    "at most twenty messages are evaluated",
  );
});

function effective(
  entries: unknown[],
  overrides: RepositoryRuleOverrides = { entries: [] },
) {
  return resolveRepositoryRuleEntries(
    { revision: 1, entries } as OrganizationRepositoryRules,
    overrides,
  ).entries;
}

const commitsOn = (extra: Record<string, unknown> = {}, optionsExtra = {}) => ({
  ...commitsEntry(false),
  mode: "require",
  options: { ...commitsEntry(false).options, ...optionsExtra },
  ...extra,
});

Deno.test("commit rule: range changes only which messages apply", () => {
  const messages = ["bad message", "feat: fine one", "fix: fine two"];
  const all = evaluateRuleSample(effective([commitsOn()]), {
    commitMessages: messages,
  })[0];
  assertEquals(all.status, "fail");
  assertEquals(all.appliesTo, "all_commits");
  assertEquals(all.evaluated, 3);
  assertEquals(all.findings.map(({ code }) => code), ["separator_missing"]);
  assert(all.findings[0].message.endsWith("(commit 1)"));
  const squash = evaluateRuleSample(
    effective([commitsOn({}, { range: "final_squash_commit" })]),
    { commitMessages: messages },
  )[0];
  assertEquals(squash.status, "pass");
  assertEquals(squash.appliesTo, "final_squash_commit");
  assertEquals(squash.evaluated, 1);
  const squashBad = evaluateRuleSample(
    effective([commitsOn({}, { range: "final_squash_commit" })]),
    { commitMessages: ["feat: ok", "nope"] },
  )[0];
  assertEquals(squashBad.status, "fail");
});

Deno.test("commit rule: only the first line is validated", () => {
  const result = evaluateRuleSample(effective([commitsOn()]), {
    commitMessages: [
      "feat: subject\n\nbody that is not a header",
      "fix: x\r\nmore",
    ],
  })[0];
  assertEquals(result.status, "pass");
  const bad = evaluateRuleSample(effective([commitsOn()]), {
    commitMessages: ["\nfeat: header is the empty first line"],
  })[0];
  assertEquals(bad.status, "fail");
  assertEquals(bad.findings[0].code, "header_empty");
});

Deno.test("commit rule: merge and revert commits follow the option", () => {
  const merge = 'Merge branch "main" into feature';
  const revert = 'Revert "feat: add thing"';
  const exempt = evaluateRuleSample(effective([commitsOn()]), {
    commitMessages: [merge, revert, "feat: ok"],
  })[0];
  assertEquals(exempt.status, "pass");
  assertEquals(exempt.evaluated, 1);
  assertEquals(
    exempt.findings.map(({ code }) => code),
    ["merge_or_revert_exempt", "merge_or_revert_exempt"],
  );
  const onlyExempt = evaluateRuleSample(effective([commitsOn()]), {
    commitMessages: [merge],
  })[0];
  assertEquals(onlyExempt.status, "not_evaluated");
  const validated = evaluateRuleSample(
    effective([commitsOn({}, { mergeAndRevertCommits: "validate" })]),
    { commitMessages: [merge, revert] },
  )[0];
  assertEquals(validated.status, "fail");
  assertEquals(validated.evaluated, 2);
});

Deno.test("rules that cannot be evaluated never report a pass", () => {
  const base = effective([
    commitsOn(),
    { ...titleEntry(), enabled: false },
    {
      ruleKey: "code.magicNumbers",
      enabled: true,
      mode: "require",
      options: { checkBinding: null, allowedNumbers: [], excludedPaths: [] },
      locked: false,
    },
  ]);
  const none = evaluateRuleSample(base, {});
  assertEquals(
    none.map(({ ruleKey, status }) => [ruleKey, status]),
    [
      ["commits.semantic", "not_evaluated"],
      ["changeRequest.semanticTitle", "not_evaluated"],
      ["changeRequest.description", "not_evaluated"],
      ["code.magicNumbers", "not_evaluated"],
      ["code.magicStrings", "not_evaluated"],
    ],
  );
  assertEquals(none[0].findings[0].code, "sample_not_provided");
  assertEquals(none[1].findings[0].code, "rule_disabled");
  assertEquals(none[1].mode, "warn");
  assertEquals(none[2].findings[0].code, "rule_absent");
  assertEquals(none[2].mode, null);
  assertEquals(
    none[3].findings[0].code,
    "needs_language_aware_checker",
  );
  assertEquals(none[4].findings[0].code, "rule_absent");
  assert(none.every(({ status }) => status !== "pass"));
});

Deno.test("title rule: same grammar, single line only", () => {
  const entries = effective([{ ...titleEntry(30), mode: "require" }]);
  const run = (title: string) =>
    evaluateRuleSample(entries, { pullRequestTitle: title })[1];
  assertEquals(run("feat(core): add a thing").status, "pass");
  assertEquals(run("feat: add a thing").findings[0].code, "scope_required");
  assertEquals(
    run("feat(core): " + "x".repeat(31)).findings[0].code,
    "subject_too_long",
  );
  assertEquals(run("feat(core): " + "x".repeat(30)).status, "pass");
  assertEquals(
    run("feat(core): ok\nsecond line").findings[0].code,
    "title_multiline",
  );
  assertEquals(run("").status, "fail");
  assertEquals(run("").appliesTo, "pull_request_title");
});

const descriptionEntry = (template: string, requiredSections: string[]) => ({
  ruleKey: "changeRequest.description",
  enabled: true,
  mode: "require",
  options: { template, requiredSections },
  locked: false,
});
const TEMPLATE =
  "## Summary\n<!-- Say what changed -->\n\n## Verification\n- [ ] tests\n\n### Notes\nfill me in\n";
const describe = (
  description: string,
  sections = ["Summary", "Verification"],
) =>
  evaluateRuleSample(effective([descriptionEntry(TEMPLATE, sections)]), {
    pullRequestDescription: description,
  })[2];

Deno.test("description rule: required sections need non-template content", () => {
  assertEquals(
    describe("## Summary\nAdds the preview.\n\n## Verification\nRan the lane.")
      .status,
    "pass",
  );
  // Missing heading.
  const missing = describe("## Summary\nAdds the preview.");
  assertEquals(missing.status, "fail");
  assertEquals(missing.findings.map(({ code }) => code), ["section_missing"]);
  // Empty body.
  assertEquals(
    describe("## Summary\n\n## Verification\nRan the lane.").findings.map((
      { code },
    ) => code),
    ["section_empty"],
  );
  // Whitespace and bare list markup only.
  assertEquals(
    describe("## Summary\n   \n-\n*\n>\n## Verification\nok").status,
    "fail",
  );
  // The template's own comment and checkbox do not count.
  assertEquals(
    describe(
      "## Summary\n<!-- Say what changed -->\n\n## Verification\n- [ ] tests\n",
    ).findings.map(({ code }) => code),
    ["section_empty", "section_empty"],
  );
  // A checked template checkbox is still the template's own line... except
  // that ticking it is content only when the text differs from the template.
  assertEquals(
    describe("## Summary\nx\n## Verification\n- [x] tests").status,
    "fail",
  );
  assertEquals(
    describe("## Summary\nx\n## Verification\n- [x] tests\nAlso ran e2e")
      .status,
    "pass",
  );
});

Deno.test("description rule: headings are case-insensitive, nested levels belong to the parent, fences hide headings", () => {
  assertEquals(
    describe("## summary\nx\n## VERIFICATION\ny").status,
    "pass",
  );
  assertEquals(
    describe("## Summary\n### Details\nnested text\n## Verification\ny")
      .status,
    "pass",
  );
  assertEquals(
    describe("## Summary\ntext\n```\n## Verification\n```\n").findings.map((
      { code },
    ) => code),
    ["section_missing"],
  );
  assertEquals(
    describe("## Summary ##\ntext\n## Verification\ny").status,
    "pass",
  );
  assertEquals(describe("####### Summary\ntext", ["Summary"]).status, "fail");
  assertEquals(describe("##Summary\ntext", ["Summary"]).status, "fail");
  // Unclosed comment drops the rest of the section.
  assertEquals(
    describe("## Summary\n<!-- never closed\nlooks like text", ["Summary"])
      .status,
    "fail",
  );
});

Deno.test("description rule: no required sections passes and the sample is capped", () => {
  assertEquals(describe("anything", []).status, "pass");
  const big = describe("## Summary\n" + "word ".repeat(2_000_000), ["Summary"]);
  assertEquals(big.status, "pass");
});

Deno.test("findings never echo sample text", () => {
  const secret = "SECRET-TOKEN-1234";
  const results = evaluateRuleSample(
    effective([
      commitsOn(),
      { ...titleEntry(), mode: "require" },
      descriptionEntry(TEMPLATE, ["Summary"]),
    ]),
    {
      commitMessages: [secret, `feat(${secret}): ${secret}`],
      pullRequestTitle: secret,
      pullRequestDescription: `## Other\n${secret}`,
    },
  );
  assert(!JSON.stringify(results).includes(secret));
});

function org(entries: unknown[], revision = 1): OrganizationRepositoryRules {
  return { revision, entries } as OrganizationRepositoryRules;
}
const magic = (binding: string | null, mode = "require", enabled = true) => ({
  ruleKey: "code.magicNumbers",
  enabled,
  mode,
  options: { checkBinding: binding, allowedNumbers: [], excludedPaths: [] },
  locked: false,
});
const overrideOfCommits: RepositoryRuleOverrides = {
  entries: [{
    ruleKey: "commits.semantic",
    enabled: true,
    mode: "warn",
    options: commitsEntry(false).options,
  }] as RepositoryRuleOverrides["entries"],
};
const overrideOfTitle: RepositoryRuleOverrides = {
  entries: [{
    ruleKey: "changeRequest.semanticTitle",
    enabled: true,
    mode: "warn",
    options: titleEntry().options,
  }] as RepositoryRuleOverrides["entries"],
};

Deno.test("classification: inherited, overridden, newly_locked and their edges", () => {
  const open = org([commitsEntry(false), titleEntry()]);
  const lockedCommits = org([commitsEntry(true), titleEntry()], 2);
  const lockedTitle = org([commitsEntry(false), {
    ...titleEntry(),
    locked: true,
  }], 2);
  const none = { entries: [] } as RepositoryRuleOverrides;
  const status = (
    current: OrganizationRepositoryRules | null,
    draft: OrganizationRepositoryRules,
    overrides: RepositoryRuleOverrides | null | undefined,
  ) => classifyRepositoryRuleImpact(current, draft, overrides, []).status;

  assertEquals(status(open, lockedCommits, none), "inherited");
  assertEquals(status(open, lockedCommits, null), "inherited");
  assertEquals(status(open, lockedCommits, undefined), "inherited");
  assertEquals(status(open, lockedCommits, overrideOfTitle), "overridden");
  // A lock newly introduced over an effective override.
  assertEquals(status(open, lockedCommits, overrideOfCommits), "newly_locked");
  // newly_locked wins over overridden.
  assertEquals(
    status(open, lockedCommits, {
      entries: [...overrideOfCommits.entries, ...overrideOfTitle.entries],
    }),
    "newly_locked",
  );
  // Already locked before: the override was never effective, so not newly.
  const already = classifyRepositoryRuleImpact(
    lockedCommits,
    org([commitsEntry(true), titleEntry()], 3),
    overrideOfCommits,
    [],
  );
  assertEquals(already.status, "inherited");
  assertEquals(already.supersededRules, ["commits.semantic"]);
  // Lock dropped: the saved override reactivates.
  assertEquals(
    status(
      lockedCommits,
      org([commitsEntry(false), titleEntry()], 3),
      overrideOfCommits,
    ),
    "overridden",
  );
  // Moving a lock from one rule to another.
  assertEquals(
    status(lockedCommits, lockedTitle, overrideOfTitle),
    "newly_locked",
  );
  assertEquals(
    status(lockedCommits, lockedTitle, overrideOfCommits),
    "overridden",
  );
  // No published revision yet: nothing was superseded before.
  assertEquals(status(null, lockedCommits, overrideOfCommits), "newly_locked");
  // Repository-only rule (no organization entry) stays overridden.
  assertEquals(
    status(open, org([titleEntry()], 2), overrideOfCommits),
    "overridden",
  );
});

Deno.test("classification: unsupported needs an enabled require rule with no matching command", () => {
  const unsupported = (
    entry: unknown,
    commands: string[] = [],
    overrides?: RepositoryRuleOverrides,
  ) =>
    classifyRepositoryRuleImpact(null, org([entry]), overrides, commands)
      .unsupported;
  assertEquals(unsupported(magic(null)), true);
  assertEquals(unsupported(magic("magic.check")), true);
  assertEquals(unsupported(magic("magic.check"), ["other"]), true);
  assertEquals(unsupported(magic("magic.check"), ["magic.check"]), false);
  assertEquals(unsupported(magic("magic.check"), ["x", "magic.check"]), false);
  // Mode and enabled matter.
  assertEquals(unsupported(magic(null, "warn")), false);
  assertEquals(unsupported(magic(null, "guide")), false);
  assertEquals(unsupported(magic(null, "require", false)), false);
  // Bakery-native validators are never unsupported, even in require mode.
  assertEquals(unsupported({ ...commitsEntry(false), mode: "require" }), false);
  assertEquals(unsupported({ ...titleEntry(), mode: "require" }), false);
  // A string rule behaves like the number rule.
  assertEquals(
    unsupported({
      ruleKey: "code.magicStrings",
      enabled: true,
      mode: "require",
      options: { checkBinding: null, allowedLiterals: [], excludedPaths: [] },
      locked: false,
    }),
    true,
  );
  // The repository's own enabled require override is judged too.
  const weaker = {
    entries: [{
      ruleKey: "code.magicNumbers",
      enabled: true,
      mode: "warn",
      options: { checkBinding: null, allowedNumbers: [], excludedPaths: [] },
    }],
  } as RepositoryRuleOverrides;
  assertEquals(unsupported(magic(null), [], weaker), false);
  const stronger = {
    entries: [{
      ruleKey: "code.magicNumbers",
      enabled: true,
      mode: "require",
      options: { checkBinding: "bound", allowedNumbers: [], excludedPaths: [] },
    }],
  } as RepositoryRuleOverrides;
  assertEquals(unsupported(magic(null, "warn"), [], stronger), true);
  assertEquals(unsupported(magic(null, "warn"), ["bound"], stronger), false);
});

Deno.test("reactivation: a dropped lock names the saved override that wakes up", () => {
  const open = org([commitsEntry(false), titleEntry()], 3);
  const locked = org([commitsEntry(true), titleEntry()], 2);
  const result = classifyRepositoryRuleImpact(
    locked,
    open,
    { entries: [...overrideOfCommits.entries, ...overrideOfTitle.entries] },
    [],
  );
  assertEquals(result.status, "overridden");
  assertEquals(result.reactivatedRules, ["commits.semantic"]);
  assertEquals(result.supersededRules, []);
  // Never locked, or still locked, or no override: nothing reactivates.
  for (
    const [from, to, overrides] of [
      [open, open, overrideOfCommits],
      [locked, locked, overrideOfCommits],
      [locked, open, { entries: [] }],
      [locked, open, overrideOfTitle],
      [open, locked, overrideOfCommits],
    ] as Array<
      [
        OrganizationRepositoryRules,
        OrganizationRepositoryRules,
        RepositoryRuleOverrides,
      ]
    >
  ) {
    assertEquals(
      classifyRepositoryRuleImpact(from, to, overrides, []).reactivatedRules,
      [],
    );
  }
});

const TICKED_TEMPLATE = "## Verification\n- [ ] tests\n";
const verification = (body: string) =>
  evaluateRuleSample(
    effective([descriptionEntry(TICKED_TEMPLATE, ["Verification"])]),
    { pullRequestDescription: body },
  )[2];

Deno.test("description rule: a tick alone is not content, in any case", () => {
  for (const tick of ["- [ ] tests", "- [x] tests", "- [X] tests"]) {
    assertEquals(
      verification(`## Verification\n${tick}`).findings.map(({ code }) => code),
      ["section_empty"],
      tick,
    );
    assertEquals(
      verification(`## Verification\n${tick}\nplus e2e`).status,
      "pass",
      tick,
    );
  }
});

Deno.test("description rule: any bullet or bare checkbox token is not content", () => {
  for (
    const marker of [
      "* [ ] tests",
      "+ [ ] tests",
      "1. [ ] tests",
      "12) [ ] tests",
      "[ ] tests",
      "[x] tests",
      "[X] tests",
      "- [X] tests",
      "> [ ] tests",
      "* [x] tests",
    ]
  ) {
    assertEquals(
      verification(`## Verification\n${marker}`).findings.map(({ code }) =>
        code
      ),
      ["section_empty"],
      marker,
    );
    assertEquals(
      verification(`## Verification\n${marker}\nreal e2e run`).status,
      "pass",
      marker,
    );
  }
  // Text that merely starts like a marker is content.
  assertEquals(verification("## Verification\n[link](x) tests").status, "pass");
  assertEquals(verification("## Verification\n2024 run").status, "pass");
});

Deno.test("description rule: comments hide headings, empty fences are not content, duplicates and setext are defined", () => {
  const sections = ["Summary"];
  const run = (body: string) => describe(body, sections);
  // A heading inside a comment is not a section.
  assertEquals(
    run("<!--\n## Summary\n-->\nstuff").findings.map(({ code }) => code),
    ["section_missing"],
  );
  // A fence with nothing inside is not content; text inside a fence is.
  assertEquals(run("## Summary\n```\n```\n").status, "fail");
  assertEquals(run("## Summary\n~~~\n~~~").status, "fail");
  assertEquals(run("## Summary\n```\nnpm test\n```").status, "pass");
  // Duplicate headings: the first one decides, the later one is ignored.
  assertEquals(run("## Summary\n\n## Summary\nreal text").status, "fail");
  assertEquals(run("## Summary\nreal text\n\n## Summary\n").status, "pass");
  // Setext headings are out of scope: they are not recognised as sections.
  assertEquals(
    run("Summary\n=======\nreal text").findings.map(({ code }) => code),
    ["section_missing"],
  );
  assertEquals(
    run("Summary\n-------\nreal text").findings.map(({ code }) => code),
    ["section_missing"],
  );
});

Deno.test("override summaries: malformed stored shapes count as no overrides", () => {
  const good = { k: "commits.semantic", e: true, m: "warn", b: null };
  assertEquals(parseOverrideSummaries([good]), [
    {
      ruleKey: "commits.semantic",
      enabled: true,
      mode: "warn",
      checkBinding: null,
    },
  ]);
  for (
    const bad of [
      null,
      "x",
      {},
      [null],
      ["x"],
      [{ ...good, k: "nope" }],
      [{ ...good, e: "true" }],
      [{ ...good, m: "block" }],
      [{ ...good, b: 5 }],
      [{ k: "commits.semantic" }],
      [good, good],
      Array(6).fill(good),
    ]
  ) assertEquals(parseOverrideSummaries(bad), [], JSON.stringify(bad));
});

Deno.test("statement timeouts map to a typed timeout, everything else passes through", () => {
  const canceled = Object.assign(new Error("canceling statement"), {
    code: "57014",
  });
  const mapped = mapPreviewDatabaseError(canceled);
  assert(mapped instanceof StandardError);
  assertEquals((mapped as StandardError).code, "DEPENDENCY_TIMEOUT");
  const wrapped = new Error("wrapped", { cause: canceled });
  assertEquals(
    (mapPreviewDatabaseError(wrapped) as StandardError).code,
    "DEPENDENCY_TIMEOUT",
  );
  const other = Object.assign(new Error("boom"), { code: "23505" });
  assertEquals(mapPreviewDatabaseError(other), other);
  assertEquals(mapPreviewDatabaseError("text"), "text");
});

Deno.test("preview admission is per organization, per principal and per process, and releases", () => {
  const [orgA, orgB, orgC] = [1, 2, 3].map(() => crypto.randomUUID());
  const [p1, p2, p3] = [1, 2, 3].map(() => crypto.randomUUID());
  const refused = (org: string, principal: string) => {
    try {
      acquirePreviewSlot(org, principal)();
      return null;
    } catch (error) {
      return error as StandardError;
    }
  };
  assertEquals(PREVIEW_MAX_PER_ORGANIZATION, 1);
  assertEquals(PREVIEW_MAX_PER_PRINCIPAL, 1);
  assertEquals(PREVIEW_MAX_GLOBAL, 2);
  const releaseA = acquirePreviewSlot(orgA, p1);
  // Same organization, another person: refused.
  const denied = refused(orgA, p2);
  assertEquals(denied?.code, "DEPENDENCY_UNAVAILABLE");
  assertEquals(typeof denied?.params?.retryAfterSeconds, "number");
  // One person administering a second organization cannot take a second
  // process slot, so the other organization's Admin still gets one.
  assertEquals(refused(orgB, p1)?.code, "DEPENDENCY_UNAVAILABLE");
  const releaseC = acquirePreviewSlot(orgC, p3);
  // The process-wide cap protects the pool across organizations and people.
  assertEquals(refused(orgB, p2)?.code, "DEPENDENCY_UNAVAILABLE");
  releaseA();
  releaseA(); // idempotent
  const releaseB = acquirePreviewSlot(orgB, p1);
  assertEquals(refused(orgA, p2)?.code, "DEPENDENCY_UNAVAILABLE");
  releaseB();
  releaseC();
  // Everything is released and the counters are back to zero.
  assertEquals(refused(orgA, p1), null);
  assertEquals(refused(orgB, p1), null);
  const first = acquirePreviewSlot(orgA, p1);
  const second = acquirePreviewSlot(orgB, p2);
  first();
  second();
});

Deno.test("the write-statement detector flags every write shape and nothing else", () => {
  const writes = [
    "update bakery.repositories set name = name",
    "UPDATE bakery.repositories r SET id = r.id WHERE r.id = $1",
    "update bakery.repositories as r set id = r.id",
    "update only bakery.repositories set id = id",
    "with moved as (update t set a = 1 returning *) select * from moved",
    "with x as (select 1) insert into t select * from x",
    "insert into bakery.audit_events values (1)",
    "delete from bakery.repositories",
    "merge into t using s on t.id = s.id when matched then update set a = 1",
    "truncate bakery.outbox",
    "copy t from stdin",
    "lock bakery.repositories",
    "lock table bakery.repositories in share mode",
    "select * from t for update",
    "select * from t for share",
    "select * from t for key share",
    "select * from t for no key update",
    "select pg_advisory_xact_lock(1)",
    "select pg_try_advisory_lock(1)",
    "select nextval('s')",
    "select setval('s', 1)",
    "select 1;\nupdate\n  t\n  r\nset a = 1",
    "create table t (a int)",
    "alter table t add column b int",
  ];
  for (const sql of writes) {
    assertEquals(writeStatementsOf([sql]), [sql], sql);
  }
  const reads = [
    "select r.id, r.updated_at, r.deleted_flag from bakery.repositories r",
    "select 'update' as kind, \"lock\" from t",
    "-- update t set a = 1\nselect 1",
    "/* delete from t */ select 1",
    "select set_config('statement_timeout', $1, true)",
    "show statement_timeout",
    "select locked, copy_table, nextvalue from t",
    "with page as (select r.id from bakery.repositories r where r.organization_id = $1 order by r.id limit $3) select * from page",
    "begin",
    "rollback",
  ];
  for (const sql of reads) assertEquals(writeStatementsOf([sql]), [], sql);
});

Deno.test("the write-statement detector reads quotes and comments in one pass", () => {
  const flagged = [
    "select '--'; update t set a = 1",
    "select E'a\\'b'; update t set a = 1",
    "select e'x\\'y', 1; delete from t",
    "select $$x$$; delete from t",
    "select $tag$ it's $tag$; insert into t values (1)",
    'select "a--b"; update t set a = 1',
    "select 'it''s'; update t set a = 1",
    "/* a /* nested */ still comment */ update t set a = 1",
    "select 1 /* c */; lock t",
    "call bakery.do_it()",
    "do $$ begin perform 1; end $$",
    "select id into scratch from t",
    "select a, b\ninto new_table\nfrom t",
    "refresh materialized view bakery.v",
    "REFRESH   MATERIALIZED\nVIEW v",
  ];
  for (const sql of flagged) assertEquals(writeStatementsOf([sql]), [sql], sql);
  const clean = [
    "select 'update t set a = 1'",
    "select E'update \\' delete from t'",
    "select $$ delete from t $$",
    "select $x$ lock $x$",
    'select "update", "do" from t',
    "-- delete from t\nselect 1",
    "/* a /* update t set a = 1 */ delete from t */ select 1",
    "select 'it''s update'",
    "select 'call', 'do', 'refresh materialized view', 'select into'",
    "select a from t where b in (select c from d)",
    "select into_col, redo, calls from t",
    "select $1, $2::text from t where a = $3",
    "select a$b from t",
  ];
  for (const sql of clean) assertEquals(writeStatementsOf([sql]), [], sql);
});

Deno.test("the write-statement detector pins its identifier guards, unicode tags and extra verbs", () => {
  const flagged = [
    // `$` inside an identifier never opens a dollar quote: the write stays visible.
    "select a$x$; update t set a = 1",
    "select col$tag$ from t; delete from t",
    "select é$x$; update t set a = 1",
    "select naïveE'x\\'; update t set a = 1; select 'y'",
    // `E` inside an identifier is not a string prefix: the backslash is literal.
    "select name'a\\'; update t set a = 1; select 'x'",
    "select valueE'x\\'; update t set a = 1; select 'y'",
    // Unicode tags still delimit their string; the write after it is seen.
    "select $é$ ' $é$; delete from t",
    "select $ünï_1$ x $ünï_1$; update t set a = 1",
    "execute stmt",
    "notify channel",
    "reindex table t",
    "analyze t",
    "analyse t",
  ];
  for (const sql of flagged) assertEquals(writeStatementsOf([sql]), [sql], sql);
  const clean = [
    "select $é$ update t set a = 1 $é$",
    "select $ünï_1$ delete from t $ünï_1$",
    "select E'update \\' delete from t'",
    "select e'x\\'y'",
    "select 'execute', 'notify', 'reindex', 'analyze'",
    "select executed, notified, reindexed, analyzed from t",
  ];
  for (const sql of clean) assertEquals(writeStatementsOf([sql]), [], sql);
});
