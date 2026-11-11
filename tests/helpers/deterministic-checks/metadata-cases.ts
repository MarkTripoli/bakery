import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  SAMPLE_MAX_COMMIT_MESSAGE_CHARS,
  SAMPLE_MAX_COMMIT_MESSAGES,
  SAMPLE_MAX_DESCRIPTION_CHARS,
  SAMPLE_MAX_TITLE_CHARS,
} from "../../../packages/contracts/src/repository-rule-preview.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import type { PgTransactionClient } from "../../../apps/server/src/platform/database.ts";
import {
  assessFreshness,
  boundParts,
  type CandidateIdentity,
  commandSubjectDigest,
  metadataDigests,
  subjectKey,
} from "../../../apps/server/src/modules/delivery/identity.ts";
import {
  evaluateMetadataChecks,
  type MetadataCheckRow,
  metadataRequirements,
  metadataSubjects,
  recordMetadataCheckRuns,
} from "../../../apps/server/src/modules/delivery/metadata-checks.ts";
import {
  type CandidateMetadataSnapshot,
  loadMetadataSnapshot,
} from "../../../apps/server/src/modules/delivery/metadata-reader.ts";
import {
  type CheckRequirement,
  evaluateCandidateChecks,
  mergeRequirements,
} from "../../../apps/server/src/modules/delivery/verdict.ts";
import { commitsEntry } from "../repository-rule-entries.ts";
import {
  asEvidence,
  commitRangeEntry,
  currentIdentity,
  descriptionEntry,
  digest,
  effectiveEntries,
  fixtureMetadataReader,
  goodSnapshot,
  magicRuleEntry,
  rowFor,
  titleRuleEntry,
} from "./identity-fixture.ts";
import { BASE_SHA, HEAD_SHA } from "./observations.ts";

/**
 * Metadata check cases: the existing pure validators behind the trusted
 * reader port, failing closed on everything they cannot judge.
 */

const POLICY = digest(0xabc);

const identity = {
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
  profileDigest: digest(1),
  checkerDigest: digest(2),
};

async function evaluate(
  rules: Array<Record<string, unknown>>,
  snapshot: CandidateMetadataSnapshot | null,
): Promise<MetadataCheckRow[]> {
  return await evaluateMetadataChecks({
    entries: await effectiveEntries(rules),
    snapshot,
    identity,
    policyDigest: POLICY,
  });
}

/** Result and reason of the one row a single-rule evaluation produces. */
async function outcomeOf(
  rule: Record<string, unknown>,
  snapshot: CandidateMetadataSnapshot | null,
): Promise<[string, string]> {
  const rows = await evaluate([rule], snapshot);
  assertEquals(rows.length, 1);
  return [rows[0].result, rows[0].reason];
}

const descriptionRule = (sections: string[], template = "## Summary\n\n") =>
  descriptionEntry({ template, requiredSections: sections });

export function registerMetadataCases(): void {
  Deno.test("a good snapshot passes the commit, title and description rules", async () => {
    const rows = await evaluate(
      [commitsEntry(false), titleRuleEntry(), descriptionEntry()],
      goodSnapshot(),
    );
    assertEquals(
      rows.map(({ kind, result, reason }) => [kind, result, reason]),
      [
        ["commits", "passed", "verified"],
        ["title", "passed", "verified"],
        ["description", "passed", "verified"],
      ],
    );
    for (const row of rows) {
      assertEquals(row.checkId, row.ruleKey);
      assertEquals(row.policyDigest, POLICY);
      assertEquals(row.headSha, HEAD_SHA);
    }
  });

  Deno.test("a rule violation is failed and never unavailable", async () => {
    assertEquals(
      await outcomeOf(
        titleRuleEntry(),
        goodSnapshot({ title: "update stuff" }),
      ),
      ["failed", "rule_violation"],
    );
    assertEquals(
      await outcomeOf(
        commitRangeEntry("all_commits"),
        goodSnapshot({ commitMessages: ["feat: fine", "wip things"] }),
      ),
      ["failed", "rule_violation"],
    );
    assertEquals(
      await outcomeOf(
        descriptionEntry(),
        goodSnapshot({ body: "## Summary\nSomething.\n" }),
      ),
      ["failed", "rule_violation"],
    );
  });

  Deno.test("a description rule with zero required sections still refuses an empty body", async () => {
    const rule = descriptionRule([]);
    for (const body of ["", "   \n\t  ", "\r\n\r\n"]) {
      assertEquals(
        await outcomeOf(rule, goodSnapshot({ body })),
        ["failed", "description_placeholder"],
        JSON.stringify(body),
      );
    }
    // The validator alone would pass every one of these.
    assertEquals(
      await outcomeOf(rule, goodSnapshot({ body: "Fixes the thing." })),
      ["passed", "verified"],
    );
  });

  Deno.test("a body of comments or the bare template is a placeholder, with or without sections", async () => {
    const template =
      "<!-- describe the change -->\n## Summary\n\n<!-- why -->\n";
    for (const sections of [[], ["Summary"]]) {
      const rule = descriptionRule(sections, template);
      for (
        const body of [
          "<!-- nothing to see -->",
          "<!-- a -->\n\n<!-- b -->",
          "## Summary\n",
          "<!-- describe the change -->\n## Summary\n\n<!-- why -->\n",
          "## Summary\r\n\r\n<!-- other comment -->\r\n",
        ]
      ) {
        assertEquals(
          await outcomeOf(rule, goodSnapshot({ body })),
          ["failed", "description_placeholder"],
          `${sections.length} sections: ${JSON.stringify(body)}`,
        );
      }
    }
  });

  Deno.test("a body that equals the template up to whitespace is a placeholder, with or without sections", async () => {
    const template = "## Summary\n\n## Verification\n";
    const variants = [
      ["trailing spaces", "## Summary  \n\n## Verification \n"],
      ["trailing tabs", "## Summary\t\n\n## Verification\t\t\n"],
      ["extra blank lines", "## Summary\n\n\n\n## Verification\n"],
      ["blank lines at both ends", "\n\n## Summary\n\n## Verification\n\n\n"],
      ["whitespace-only lines", "## Summary\n \t \n## Verification\n   \n"],
      ["no blank line between sections", "## Summary\n## Verification\n"],
      ["no final newline", "## Summary\n\n## Verification"],
      [
        "CRLF with trailing spaces",
        "## Summary \r\n\r\n\r\n## Verification \r\n",
      ],
      ["indentation", "  ## Summary\n\n\t## Verification\n"],
      ["inner runs of spaces", "##  Summary\n\n##\tVerification\n"],
      [
        "comments between blank lines",
        "## Summary\n\n\n<!-- later -->\n\n\n## Verification  \n",
      ],
    ] as const;
    for (const sections of [[], ["Summary", "Verification"]]) {
      const rule = descriptionRule(sections, template);
      for (const [name, body] of variants) {
        assertEquals(
          await outcomeOf(rule, goodSnapshot({ body })),
          ["failed", "description_placeholder"],
          `${sections.length} sections, ${name}: ${JSON.stringify(body)}`,
        );
      }
    }
    // A template with trailing whitespace and extra blank lines is compared the
    // same way, so a clean body still equals it.
    assertEquals(
      await outcomeOf(
        descriptionRule([], "## Summary \n\n\n## Verification  \n\n"),
        goodSnapshot({ body: "## Summary\n## Verification" }),
      ),
      ["failed", "description_placeholder"],
    );
  });

  Deno.test("whitespace around real content never makes a body a placeholder", async () => {
    const rule = descriptionRule([], "## Summary\n\n## Verification\n");
    for (
      const body of [
        "## Summary  \nRecords check rows.\n\n\n## Verification \n",
        "## Summary\n\n\n## Verification\nRan the unit lane.\n\n",
        "## Summary\n\n## Verification\n\nx",
        "## Summary\n\n## Verification\n\n## Notes\n",
        "Fixes the thing.",
      ]
    ) {
      assertEquals(
        await outcomeOf(rule, goodSnapshot({ body })),
        ["passed", "verified"],
        JSON.stringify(body),
      );
    }
    // Words that look alike stay different: only whitespace is ignored.
    assertEquals(
      await outcomeOf(
        rule,
        goodSnapshot({ body: "## Sumary\n\n## Verification\n" }),
      ),
      ["passed", "verified"],
    );
  });

  Deno.test("an oversize snapshot is unavailable, never truncated and judged", async () => {
    const tooLarge: [string, string] = ["unavailable", "metadata_too_large"];
    // A body whose only required section starts past the bound would read as
    // a missing section on a truncated copy; it must not be judged at all.
    const longBody = `${
      "x".repeat(SAMPLE_MAX_DESCRIPTION_CHARS)
    }\n## Summary\nlate\n`;
    assertEquals(
      await outcomeOf(
        descriptionRule(["Summary"]),
        goodSnapshot({ body: longBody }),
      ),
      tooLarge,
    );
    assertEquals(
      await outcomeOf(
        descriptionRule([]),
        goodSnapshot({ body: "y".repeat(SAMPLE_MAX_DESCRIPTION_CHARS + 1) }),
      ),
      tooLarge,
    );
    // Exactly at the bound is judged.
    assertNotEquals(
      (await outcomeOf(
        descriptionRule([]),
        goodSnapshot({ body: "y".repeat(SAMPLE_MAX_DESCRIPTION_CHARS) }),
      ))[1],
      "metadata_too_large",
    );
    assertEquals(
      await outcomeOf(
        titleRuleEntry(),
        goodSnapshot({
          title: `feat: ${"t".repeat(SAMPLE_MAX_TITLE_CHARS)}`,
        }),
      ),
      tooLarge,
    );
    // 21 commits, the last one invalid: a copy cut at 20 would pass.
    const commits = Array.from(
      { length: SAMPLE_MAX_COMMIT_MESSAGES },
      () => "feat: fine",
    );
    assertEquals(
      await outcomeOf(
        commitRangeEntry("all_commits"),
        goodSnapshot({ commitMessages: [...commits, "not conventional"] }),
      ),
      tooLarge,
    );
    assertEquals(
      await outcomeOf(
        commitRangeEntry("all_commits"),
        goodSnapshot({ commitMessages: commits }),
      ),
      ["passed", "verified"],
    );
    assertEquals(
      await outcomeOf(
        commitRangeEntry("all_commits"),
        goodSnapshot({
          commitMessages: [
            `feat: ${"m".repeat(SAMPLE_MAX_COMMIT_MESSAGE_CHARS)}`,
          ],
        }),
      ),
      tooLarge,
    );
    assertEquals(
      await outcomeOf(
        commitRangeEntry("final_squash_commit"),
        goodSnapshot({
          mergeMessage: `feat: ${"m".repeat(SAMPLE_MAX_COMMIT_MESSAGE_CHARS)}`,
        }),
      ),
      tooLarge,
    );
  });

  Deno.test("an oversize title does not make the other rules unavailable", async () => {
    const rows = await evaluate(
      [commitsEntry(false), titleRuleEntry(), descriptionEntry()],
      goodSnapshot({ title: "t".repeat(SAMPLE_MAX_TITLE_CHARS + 1) }),
    );
    assertEquals(
      rows.map(({ kind, reason }) => [kind, reason]),
      [
        ["commits", "verified"],
        ["title", "metadata_too_large"],
        ["description", "verified"],
      ],
    );
  });

  Deno.test("a null, throwing or malformed reader yields metadata_missing for every rule", async () => {
    const ref = {
      organizationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
    };
    const readers = {
      "a null reader": fixtureMetadataReader(null),
      "a throwing reader": fixtureMetadataReader(new Error("provider down")),
      "a malformed snapshot": fixtureMetadataReader({ title: 5 }),
      "an unexpected extra field": fixtureMetadataReader({
        ...goodSnapshot(),
        injected: true,
      }),
    };
    for (const [name, reader] of Object.entries(readers)) {
      const snapshot = await loadMetadataSnapshot(reader, ref);
      assertEquals(snapshot, null, name);
      assertEquals(reader.refs, [ref], `${name} was asked about the candidate`);
      const rows = await evaluate(
        [commitsEntry(false), titleRuleEntry(), descriptionEntry()],
        snapshot,
      );
      assertEquals(rows.length, 3, name);
      for (const row of rows) {
        assertEquals([row.result, row.reason], [
          "unavailable",
          "metadata_missing",
        ], `${name}: ${row.kind}`);
        assertEquals(
          [row.titleDigest, row.bodyDigest, row.commitSelectionDigest],
          [null, null, null],
        );
      }
    }
    const good = fixtureMetadataReader(goodSnapshot());
    assertEquals(await loadMetadataSnapshot(good, ref), goodSnapshot());
  });

  Deno.test("final-squash commit rules judge the merge message alone", async () => {
    const rule = commitRangeEntry("final_squash_commit");
    // Every commit is bad, the merge message is good: the rule passes.
    const badCommits = goodSnapshot({
      commitMessages: ["wip", "more wip"],
      mergeMessage: "feat: squash it",
    });
    const rows = await evaluate([rule], badCommits);
    assertEquals(rows.length, 1);
    assertEquals(
      [rows[0].kind, rows[0].result, rows[0].reason],
      ["merge_message", "passed", "verified"],
    );
    assertEquals(rows[0].commitSelectionDigest, null);
    assertNotEquals(rows[0].mergeMessageDigest, null);
    assertEquals(
      await outcomeOf(
        rule,
        goodSnapshot({ mergeMessage: "squashed everything" }),
      ),
      ["failed", "rule_violation"],
    );
    assertEquals(
      await outcomeOf(rule, goodSnapshot({ mergeMessage: null })),
      ["unavailable", "metadata_missing"],
    );
  });

  Deno.test("all-commit rules need commits, and exempt-only commits are skipped, not passed", async () => {
    const rule = commitRangeEntry("all_commits");
    assertEquals(
      await outcomeOf(rule, goodSnapshot({ commitMessages: [] })),
      ["unavailable", "metadata_missing"],
    );
    assertEquals(
      await outcomeOf(
        rule,
        goodSnapshot({ commitMessages: ["Merge branch 'main'"] }),
      ),
      ["unavailable", "skipped"],
    );
    assertEquals(
      await outcomeOf(
        commitRangeEntry("all_commits", "require", "validate"),
        goodSnapshot({ commitMessages: ["Merge branch 'main'"] }),
      ),
      ["failed", "rule_violation"],
    );
  });

  Deno.test("a magic-value rule without a bound command is unavailable, a bound one leaves its row to the command", async () => {
    const unbound = await evaluate(
      [magicRuleEntry("code.magicNumbers", null)],
      goodSnapshot(),
    );
    assertEquals(unbound.length, 1);
    assertEquals(
      [unbound[0].kind, unbound[0].result, unbound[0].reason],
      ["command", "unavailable", "rule_unbound"],
    );
    assertEquals(unbound[0].ruleKey, "code.magicNumbers");
    // It does not need a snapshot to be known unbound.
    assertEquals(
      (await evaluate([magicRuleEntry("code.magicStrings", null)], null))[0]
        .reason,
      "rule_unbound",
    );
    // A bound rule is enforced by the command's own row, which is not recorded here.
    assertEquals(
      await evaluate(
        [magicRuleEntry("code.magicNumbers", "magic.numbers")],
        goodSnapshot(),
      ),
      [],
    );
  });

  Deno.test("disabled and absent rules produce no row", async () => {
    assertEquals(
      await evaluate(
        [
          { ...titleRuleEntry(), enabled: false },
          magicRuleEntry("code.magicStrings", null, "require", false),
        ],
        goodSnapshot(),
      ),
      [],
    );
    assertEquals(await evaluate([], goodSnapshot()), []);
    assertEquals(metadataRequirements([]), []);
  });

  Deno.test("guide and warn rules are still evaluated and recorded", async () => {
    const rows = await evaluate(
      [titleRuleEntry("guide"), descriptionRule([], "## Summary\n\n")],
      goodSnapshot({ title: "bad title" }),
    );
    assertEquals(
      rows.map(({ kind, result }) => [kind, result]),
      [["title", "failed"], ["description", "passed"]],
    );
  });

  Deno.test("a row stores exactly the parts its kind is bound to", async () => {
    const entries = [
      commitRangeEntry("all_commits"),
      titleRuleEntry(),
      descriptionEntry(),
      magicRuleEntry("code.magicNumbers", null),
    ];
    const rows = await evaluate(entries, goodSnapshot());
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
    const stored = (row: MetadataCheckRow) =>
      ([
        "baseSha",
        "profileDigest",
        "checkerDigest",
        "titleDigest",
        "bodyDigest",
        "mergeMessageDigest",
        "commitSelectionDigest",
      ] as const).filter((field) => row[field] !== null);
    assertEquals(stored(byKind.commits), ["baseSha", "commitSelectionDigest"]);
    assertEquals(stored(byKind.title), ["baseSha", "titleDigest"]);
    assertEquals(stored(byKind.description), ["baseSha", "bodyDigest"]);
    assertEquals(stored(byKind.command), [
      "baseSha",
      "profileDigest",
      "checkerDigest",
    ]);
    const digests = await metadataDigests(goodSnapshot());
    assertEquals(byKind.title.titleDigest, digests.titleDigest);
    assertEquals(byKind.description.bodyDigest, digests.bodyDigest);
    assertEquals(
      byKind.commits.commitSelectionDigest,
      digests.commitSelectionDigest,
    );
    assertEquals(
      new Set(rows.map(({ subjectDigest }) => subjectDigest)).size,
      rows.length,
      "each rule entry has its own subject digest",
    );
  });

  Deno.test("metadata digests are stable per text and differ per text and per field", async () => {
    const one = await metadataDigests(goodSnapshot());
    assertEquals(await metadataDigests(goodSnapshot()), one);
    // Equal text in two fields must not produce one digest for both.
    const same = await metadataDigests(
      goodSnapshot({ title: "same", body: "same", mergeMessage: "same" }),
    );
    assertEquals(
      new Set([same.titleDigest, same.bodyDigest, same.mergeMessageDigest])
        .size,
      3,
    );
    for (const field of ["title", "body", "mergeMessage"] as const) {
      const changed = await metadataDigests(goodSnapshot({ [field]: "other" }));
      const key = field === "title"
        ? "titleDigest"
        : field === "body"
        ? "bodyDigest"
        : "mergeMessageDigest";
      assertNotEquals(changed[key], one[key], field);
    }
    assertNotEquals(
      (await metadataDigests(goodSnapshot({ commitMessages: ["feat: x"] })))
        .commitSelectionDigest,
      one.commitSelectionDigest,
    );
    assertEquals(
      (await metadataDigests(goodSnapshot({ mergeMessage: null })))
        .mergeMessageDigest,
      null,
    );
    assertEquals(await metadataDigests(null), {
      titleDigest: null,
      bodyDigest: null,
      mergeMessageDigest: null,
      commitSelectionDigest: null,
    });
  });

  Deno.test("recorded metadata rows go stale for exactly the text that changed", async () => {
    const entries = await effectiveEntries([
      commitRangeEntry("all_commits"),
      titleRuleEntry(),
      descriptionEntry(),
    ]);
    const snapshot = goodSnapshot();
    const rows = (await evaluateMetadataChecks({
      entries,
      snapshot,
      identity,
      policyDigest: POLICY,
    })).map((row) => asEvidence(row));
    const identityFor = async (
      next: CandidateMetadataSnapshot,
      overrides: Partial<CandidateIdentity> = {},
    ) =>
      currentIdentity({
        ...(await metadataDigests(next)),
        subjects: await metadataSubjects(entries),
        ...overrides,
      });
    const requirements = metadataRequirements(entries);
    assertEquals(requirements.map(({ kind }) => kind), [
      "commits",
      "title",
      "description",
    ]);
    const statuses = (verdict: ReturnType<typeof evaluateCandidateChecks>) =>
      Object.fromEntries(
        verdict.evaluations.map((entry) => [
          entry.requirement.kind,
          entry.status,
        ]),
      );
    const fresh = evaluateCandidateChecks({
      requirements,
      rows,
      current: await identityFor(snapshot),
    });
    assertFalse(fresh.blocked);
    const cases: Array<
      [string, CandidateMetadataSnapshot, Record<string, string>]
    > = [
      [
        "title",
        goodSnapshot({ title: "feat: another title" }),
        { commits: "passed", title: "stale", description: "passed" },
      ],
      [
        "body",
        goodSnapshot({ body: `${goodSnapshot().body}\nMore.` }),
        { commits: "passed", title: "passed", description: "stale" },
      ],
      [
        "commit messages",
        goodSnapshot({ commitMessages: ["feat: only one"] }),
        { commits: "stale", title: "passed", description: "passed" },
      ],
      [
        "merge message (no metadata row is bound to it here)",
        goodSnapshot({ mergeMessage: "feat: changed squash" }),
        { commits: "passed", title: "passed", description: "passed" },
      ],
    ];
    for (const [name, next, expected] of cases) {
      const verdict = evaluateCandidateChecks({
        requirements,
        rows,
        current: await identityFor(next),
      });
      assertEquals(statuses(verdict), expected, name);
    }
    // A new head or base stales every check, the text checks included.
    for (
      const moved of [{ headSha: "7".repeat(40) }, { baseSha: "6".repeat(40) }]
    ) {
      const verdict = evaluateCandidateChecks({
        requirements,
        rows,
        current: await identityFor(snapshot, moved),
      });
      assertEquals(statuses(verdict), {
        commits: "stale",
        title: "stale",
        description: "stale",
      });
    }
  });

  Deno.test("a changed merge message stales the squash-message row and only that row", async () => {
    const entries = await effectiveEntries([
      commitRangeEntry("final_squash_commit"),
      titleRuleEntry(),
    ]);
    const rows = (await evaluateMetadataChecks({
      entries,
      snapshot: goodSnapshot(),
      identity,
      policyDigest: POLICY,
    })).map((row) => asEvidence(row));
    const next = goodSnapshot({ mergeMessage: "feat: a different squash" });
    const assessments = Object.fromEntries(
      await Promise.all(rows.map(async (row) => [
        row.kind,
        assessFreshness(
          row,
          currentIdentity({
            ...(await metadataDigests(next)),
            subjects: await metadataSubjects(entries),
          }),
        ),
      ])),
    );
    assertEquals(assessments.merge_message, {
      fresh: false,
      changed: ["merge_message"],
    });
    assertEquals(assessments.title, { fresh: true });
  });

  Deno.test("metadata requirements name the rows evaluation produces, plus the command a bound rule answers", async () => {
    const entries = await effectiveEntries([
      commitRangeEntry("final_squash_commit", "warn"),
      titleRuleEntry("guide"),
      descriptionEntry(),
      magicRuleEntry("code.magicNumbers", null),
      magicRuleEntry("code.magicStrings", "strings.check"),
    ]);
    const rows = await evaluateMetadataChecks({
      entries,
      snapshot: goodSnapshot(),
      identity,
      policyDigest: POLICY,
    });
    const requirements = metadataRequirements(entries);
    assertEquals(
      requirements.map(({ kind, checkId, mode }) => [kind, checkId, mode]),
      [
        ["merge_message", "commits.semantic", "warn"],
        ["title", "changeRequest.semanticTitle", "guide"],
        ["description", "changeRequest.description", "require"],
        ["command", "code.magicNumbers", "require"],
        // The bound rule is judged by its command's own row, not by one here.
        ["command", "strings.check", "require"],
      ],
    );
    assertEquals(
      rows.map(({ kind, checkId }) => [kind, checkId]),
      requirements.slice(0, 4).map(({ kind, checkId }) => [kind, checkId]),
    );
    // The command's subject digest covers its argv, so it comes from the pins.
    assertEquals(
      Object.keys(await metadataSubjects(entries)),
      [
        "rule:commits.semantic",
        "rule:changeRequest.semanticTitle",
        "rule:changeRequest.description",
        "command:code.magicNumbers",
      ],
    );
  });

  Deno.test("an enabled rule bound to a command makes that command a requirement with the rule's mode", async () => {
    const bound = async (
      mode: string,
      enabled = true,
      binding: string | null = "magic.numbers",
    ) =>
      metadataRequirements(
        await effectiveEntries([
          magicRuleEntry("code.magicNumbers", binding, mode, enabled),
        ]),
      );
    for (const mode of ["require", "warn", "guide"] as const) {
      assertEquals(await bound(mode), [
        { kind: "command", checkId: "magic.numbers", mode },
      ]);
    }
    // A disabled rule asks for nothing; an unbound one answers its own row.
    assertEquals(await bound("require", false), []);
    assertEquals(await bound("require", true, null), [
      { kind: "command", checkId: "code.magicNumbers", mode: "require" },
    ]);
    // Two rules bound to one command give one requirement, the stricter mode.
    const shared = async (first: string, second: string) =>
      metadataRequirements(
        await effectiveEntries([
          magicRuleEntry("code.magicNumbers", "magic.shared", first),
          magicRuleEntry("code.magicStrings", "magic.shared", second),
        ]),
      );
    for (
      const [first, second, mode] of [
        ["warn", "require", "require"],
        ["require", "warn", "require"],
        ["guide", "warn", "warn"],
        ["guide", "guide", "guide"],
      ] as const
    ) {
      assertEquals(
        await shared(first, second),
        [{ kind: "command", checkId: "magic.shared", mode }],
        `${first} then ${second}`,
      );
    }
  });

  Deno.test("merging requirements keeps one per check with the stricter mode, in first-seen order", () => {
    const req = (
      kind: CheckRequirement["kind"],
      checkId: string,
      mode: CheckRequirement["mode"],
    ): CheckRequirement => ({ kind, checkId, mode });
    const policy = [
      req("command", "unit", "require"),
      req("command", "lint", "warn"),
      req("command", "fmt", "guide"),
    ];
    const rules = [
      req("command", "lint", "require"),
      req("command", "fmt", "warn"),
      req("title", "changeRequest.semanticTitle", "guide"),
    ];
    assertEquals(mergeRequirements(policy, rules), [
      req("command", "unit", "require"),
      req("command", "lint", "require"),
      req("command", "fmt", "warn"),
      req("title", "changeRequest.semanticTitle", "guide"),
    ]);
    // Inputs are left alone and the result holds copies.
    assertEquals(policy[1].mode, "warn");
    assertEquals(rules[0].mode, "require");
    const merged = mergeRequirements(policy);
    assertEquals(merged, policy);
    assertNotEquals(merged[0], undefined);
    assert(merged[0] !== policy[0]);
    // The stricter mode wins whichever side states it.
    const modes = ["guide", "warn", "require"] as const;
    for (const [first, left] of modes.entries()) {
      for (const [second, right] of modes.entries()) {
        const [only, ...rest] = mergeRequirements(
          [req("command", "x", left)],
          [req("command", "x", right)],
        );
        assertEquals(rest, []);
        assertEquals(only.mode, modes[Math.max(first, second)]);
      }
    }
    // A command and a rule that share a name are different checks.
    assertEquals(
      mergeRequirements(
        [req("command", "commits.semantic", "require")],
        [req("merge_message", "commits.semantic", "guide")],
      ).length,
      2,
    );
    // Several lists, and nothing at all.
    assertEquals(
      mergeRequirements(
        [req("command", "a", "guide")],
        [],
        [req("command", "a", "warn")],
        [req("command", "a", "guide"), req("command", "b", "require")],
      ),
      [req("command", "a", "warn"), req("command", "b", "require")],
    );
    assertEquals(mergeRequirements(), []);
    assertEquals(mergeRequirements([], []), []);
  });

  Deno.test("the policy's command and the rule bound to it are judged once after a merge, and twice without one", async () => {
    const entries = await effectiveEntries([
      magicRuleEntry("code.magicNumbers", "pass", "require"),
      titleRuleEntry(),
    ]);
    const policy: CheckRequirement[] = [
      { kind: "command", checkId: "pass", mode: "require" },
      { kind: "command", checkId: "fail", mode: "require" },
    ];
    const ruled = metadataRequirements(entries);
    // The trap the merge removes: the command appears in both lists.
    const naive = [...policy, ...ruled];
    assertEquals(
      naive.filter(({ kind, checkId }) =>
        kind === "command" && checkId === "pass"
      ).length,
      2,
    );
    const merged = mergeRequirements(policy, ruled);
    assertEquals(
      merged.map(({ kind, checkId, mode }) => [kind, checkId, mode]),
      [
        ["command", "pass", "require"],
        ["command", "fail", "require"],
        ["title", "changeRequest.semanticTitle", "require"],
      ],
    );
    const blockedIds = (requirements: readonly CheckRequirement[]) =>
      evaluateCandidateChecks({
        requirements,
        rows: [],
        current: currentIdentity(),
      }).blockedChecks.map(({ requirement }) => requirement.checkId);
    assertEquals(blockedIds(naive).filter((id) => id === "pass").length, 2);
    assertEquals(blockedIds(merged), [
      "pass",
      "fail",
      "changeRequest.semanticTitle",
    ]);
  });

  Deno.test("a required bound rule blocks until its command row passes, a warn rule never does", async () => {
    const command = { id: "magic.numbers", argv: ["deno", "lint"] };
    const rule = async (mode: string, allowedNumbers = [0, 1]) =>
      (await effectiveEntries([
        {
          ...magicRuleEntry("code.magicNumbers", command.id, mode),
          options: {
            checkBinding: command.id,
            allowedNumbers,
            excludedPaths: [],
          },
        },
      ]))[0];
    const entry = await rule("require");
    const requirements = metadataRequirements([entry]);
    const key = subjectKey("command", command.id);
    const identityFor = async (bound: typeof entry) =>
      currentIdentity({
        subjects: { [key]: await commandSubjectDigest(command, bound) },
      });
    const row = (overrides = {}) =>
      rowFor.command({
        checkId: command.id,
        ...overrides,
      });
    const recorded = async (bound: typeof entry) =>
      row({ subjectDigest: await commandSubjectDigest(command, bound) });

    // No command row yet: the required rule is missing evidence and blocks.
    const absent = evaluateCandidateChecks({
      requirements,
      rows: [],
      current: await identityFor(entry),
    });
    assert(absent.blocked);
    assertEquals(
      absent.evaluations.map(({ status, reason }) => [status, reason]),
      [["missing", "no_row"]],
    );
    // A fresh passing row of the bound command satisfies it.
    const passing = evaluateCandidateChecks({
      requirements,
      rows: [await recorded(entry)],
      current: await identityFor(entry),
    });
    assertFalse(passing.blocked);
    assertEquals(passing.evaluations[0].status, "passed");
    // A failing, unavailable or stale row of the command blocks, each as itself.
    const failing = evaluateCandidateChecks({
      requirements,
      rows: [
        row({
          result: "failed",
          reason: "exit_nonzero",
          subjectDigest: await commandSubjectDigest(command, entry),
        }),
      ],
      current: await identityFor(entry),
    });
    assert(failing.blocked);
    assertEquals(failing.evaluations[0].status, "failed");
    const ambiguous = evaluateCandidateChecks({
      requirements,
      rows: [
        row({
          result: "unavailable",
          reason: "rule_binding_ambiguous",
          subjectDigest: await commandSubjectDigest(command, entry),
        }),
      ],
      current: await identityFor(entry),
    });
    assert(ambiguous.blocked);
    assertEquals(ambiguous.evaluations[0].status, "unavailable");
    // Editing the rule changes the command's subject and stales its row.
    const edited = await rule("require", [0, 1, 2]);
    const stale = evaluateCandidateChecks({
      requirements,
      rows: [await recorded(entry)],
      current: await identityFor(edited),
    });
    assert(stale.blocked);
    assertEquals(stale.evaluations[0].status, "stale");
    assertEquals(stale.evaluations[0].changed, ["subject"]);

    // A warn rule keeps its finding and never blocks, even with no row.
    const warnEntry = await rule("warn");
    const warnRequirements = metadataRequirements([warnEntry]);
    assertEquals(warnRequirements[0].mode, "warn");
    for (
      const rows of [[], [row({ result: "failed", reason: "exit_nonzero" })]]
    ) {
      const verdict = evaluateCandidateChecks({
        requirements: warnRequirements,
        rows,
        current: await identityFor(warnEntry),
      });
      assertFalse(verdict.blocked);
      assertFalse(verdict.evaluations[0].blocking);
    }
    // A guide rule is not consulted at all.
    const guideVerdict = evaluateCandidateChecks({
      requirements: metadataRequirements([await rule("guide")]),
      rows: [],
      current: await identityFor(entry),
    });
    assertFalse(guideVerdict.blocked);
    assertEquals(guideVerdict.evaluations[0].status, "not_blocking");
  });

  /** A transaction that records every query and answers the run step lookup. */
  function recordingTransaction(stepFound: boolean) {
    const queries: Array<[string, unknown[]]> = [];
    const transaction = {
      query: (text: string, params: unknown[]) => {
        queries.push([text, params]);
        const found = text.includes("bakery.run_steps") && stepFound;
        return Promise.resolve({
          rows: found ? [{ id: params[2] }] : [],
          rowCount: found ? 1 : 0,
        });
      },
    } as unknown as PgTransactionClient;
    const inserts = () =>
      queries.filter(([text]) =>
        text.includes("insert into bakery.check_runs")
      );
    return { transaction, queries, inserts };
  }

  const refusalReason = (error: unknown) =>
    error instanceof StandardError ? error.params?.reason : undefined;

  Deno.test("recording refuses a pass that omits a part its kind is bound to, and writes nothing", async () => {
    const rows = await evaluate(
      [
        commitRangeEntry("all_commits"),
        titleRuleEntry(),
        descriptionEntry(),
      ],
      goodSnapshot(),
    );
    const [squash] = await evaluate(
      [commitRangeEntry("final_squash_commit")],
      goodSnapshot(),
    );
    const omitted: Array<[MetadataCheckRow, keyof MetadataCheckRow]> = [];
    for (const row of [...rows, squash]) {
      assertEquals([row.result, row.reason], ["passed", "verified"]);
      const parts = boundParts(row.kind);
      const fields: Record<string, keyof MetadataCheckRow> = {
        base: "baseSha",
        profile: "profileDigest",
        checker: "checkerDigest",
        commit_selection: "commitSelectionDigest",
        title: "titleDigest",
        body: "bodyDigest",
        merge_message: "mergeMessageDigest",
      };
      for (const part of parts) {
        if (part in fields) omitted.push([row, fields[part]]);
      }
    }
    // Four kinds, each bound to the base and to its own text.
    assertEquals(omitted.length, 8);
    for (const [row, field] of omitted) {
      const { transaction, queries } = recordingTransaction(true);
      const error = await assertRejects(
        () =>
          recordMetadataCheckRuns(transaction, {
            organizationId: crypto.randomUUID(),
            runId: crypto.randomUUID(),
            rows: [{ ...row, [field]: null }],
          }),
        StandardError,
      );
      assertEquals(
        refusalReason(error),
        "check_row_invalid",
        `${row.kind} ${field}`,
      );
      assertEquals(queries.length, 0, `${row.kind} ${field}`);
    }
    // The same row with the digest in place is recorded.
    const { transaction, inserts } = recordingTransaction(true);
    await recordMetadataCheckRuns(transaction, {
      organizationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      rows: [...rows, squash],
    });
    assertEquals(inserts().length, 4);
    // A row that did not pass may record nothing: it is not a claim of success.
    const unreadable = await evaluate([titleRuleEntry()], null);
    assertEquals(unreadable[0].titleDigest, null);
    const { transaction: next, inserts: nextInserts } = recordingTransaction(
      true,
    );
    await recordMetadataCheckRuns(next, {
      organizationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      rows: unreadable,
    });
    assertEquals(nextInserts().length, 1);
  });

  Deno.test("recording refuses a kind that does not belong to the rule and a magic row that claims a result", async () => {
    const [title] = await evaluate([titleRuleEntry()], goodSnapshot());
    const [unbound] = await evaluate(
      [magicRuleEntry("code.magicNumbers", null)],
      goodSnapshot(),
    );
    assertEquals(unbound.kind, "command");
    const forged: Array<[string, MetadataCheckRow]> = [
      ["a title rule recorded as a command", { ...title, kind: "command" }],
      [
        // Every digest a description row binds is in place; only the kind is wrong.
        "a title rule recorded as a description",
        { ...title, kind: "description", bodyDigest: title.titleDigest },
      ],
      [
        "a passed magic row",
        { ...unbound, result: "passed", reason: "verified" },
      ],
      [
        "a failed magic row",
        { ...unbound, result: "failed", reason: "rule_violation" },
      ],
    ];
    for (const [name, row] of forged) {
      const { transaction, queries } = recordingTransaction(true);
      const error = await assertRejects(
        () =>
          recordMetadataCheckRuns(transaction, {
            organizationId: crypto.randomUUID(),
            runId: crypto.randomUUID(),
            rows: [row],
          }),
        StandardError,
        undefined,
        name,
      );
      assertEquals(refusalReason(error), "check_row_invalid", name);
      assertEquals(queries.length, 0, name);
    }
    // The honest unbound row is recorded.
    const { transaction, inserts } = recordingTransaction(true);
    await recordMetadataCheckRuns(transaction, {
      organizationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      rows: [unbound],
    });
    assertEquals(inserts().length, 1);
  });

  Deno.test("recording refuses two rows for one check in a call and writes none of them", async () => {
    const rows = await evaluate(
      [titleRuleEntry(), descriptionEntry()],
      goodSnapshot(),
    );
    const [title, description] = rows;
    const { transaction, queries, inserts } = recordingTransaction(true);
    const error = await assertRejects(
      () =>
        recordMetadataCheckRuns(transaction, {
          organizationId: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          // The second title row would shadow a failure with a pass.
          rows: [
            { ...title, result: "failed", reason: "rule_violation" },
            description,
            title,
          ],
        }),
      StandardError,
    );
    assertEquals(refusalReason(error), "check_row_invalid");
    assertEquals(error.params?.index, 2);
    assertEquals(queries.length, 0);
    assertEquals(inserts().length, 0);
    // Different checks, and one rule recorded as two kinds, are not duplicates.
    const [commits] = await evaluate(
      [commitRangeEntry("all_commits")],
      goodSnapshot(),
    );
    const [squash] = await evaluate(
      [commitRangeEntry("final_squash_commit")],
      goodSnapshot(),
    );
    await recordMetadataCheckRuns(transaction, {
      organizationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      rows: [title, description, commits, squash],
    });
    assertEquals(inserts().length, 4);
  });

  Deno.test("recording validates every row before the first insert, so a bad row after a good one writes nothing", async () => {
    const [title, description] = await evaluate(
      [titleRuleEntry(), descriptionEntry()],
      goodSnapshot(),
    );
    const [unbound] = await evaluate(
      [magicRuleEntry("code.magicNumbers", null)],
      goodSnapshot(),
    );
    const bad: Array<[string, MetadataCheckRow]> = [
      ["a pass that omits a part its kind is bound to", {
        ...description,
        bodyDigest: null,
      }],
      ["a kind the rule does not record", { ...description, kind: "command" }],
      ["a magic row that claims a pass", {
        ...unbound,
        result: "passed",
        reason: "verified",
      }],
      ["a second row for a check already in the call", { ...title }],
    ];
    for (const [name, row] of bad) {
      // The good row comes first: a validation that ran per row, just before
      // each insert, would already have written it.
      const { transaction, queries, inserts } = recordingTransaction(true);
      await assertRejects(
        () =>
          recordMetadataCheckRuns(transaction, {
            organizationId: crypto.randomUUID(),
            runId: crypto.randomUUID(),
            rows: [title, row],
          }),
        StandardError,
        undefined,
        name,
      );
      assertEquals(queries.length, 0, name);
      assertEquals(inserts().length, 0, name);
    }
    // Control: with the bad row repaired both rows are written.
    const { transaction, inserts } = recordingTransaction(true);
    await recordMetadataCheckRuns(transaction, {
      organizationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      rows: [title, description],
    });
    assertEquals(inserts().length, 2);
  });

  Deno.test("recording attributes rows to a run step only when the step belongs to the run", async () => {
    const [row] = await evaluate([titleRuleEntry()], goodSnapshot());
    const organizationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const runStepId = crypto.randomUUID();
    const foreign = recordingTransaction(false);
    const error = await assertRejects(
      () =>
        recordMetadataCheckRuns(foreign.transaction, {
          organizationId,
          runId,
          runStepId,
          rows: [row],
        }),
      StandardError,
    );
    assertEquals(refusalReason(error), "check_row_invalid");
    // One lookup, scoped to the organization and the run, and no insert.
    assertEquals(foreign.queries.length, 1);
    assertEquals(foreign.queries[0][1], [organizationId, runId, runStepId]);
    assertEquals(foreign.inserts().length, 0);

    const own = recordingTransaction(true);
    const ids = await recordMetadataCheckRuns(own.transaction, {
      organizationId,
      runId,
      runStepId,
      rows: [row],
    });
    assertEquals(ids.length, 1);
    assertEquals(own.inserts().length, 1);
    assert(own.inserts()[0][1].includes(runStepId));
    // No step given: no lookup, and the column stays null.
    const bare = recordingTransaction(false);
    await recordMetadataCheckRuns(bare.transaction, {
      organizationId,
      runId,
      runStepId: null,
      rows: [row],
    });
    assertEquals(bare.queries.length, 1);
    assert(bare.queries[0][0].includes("insert into bakery.check_runs"));
  });

  Deno.test("recording refuses a row whose reason does not explain its result, before any write", async () => {
    const queries: unknown[][] = [];
    const transaction = {
      query: (...args: unknown[]) => {
        queries.push(args);
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as PgTransactionClient;
    const [good] = await evaluate([titleRuleEntry()], goodSnapshot());
    const organizationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await assertRejects(() =>
      recordMetadataCheckRuns(transaction, {
        organizationId,
        runId,
        rows: [{ ...good, result: "passed", reason: "rule_violation" }],
      })
    );
    await assertRejects(() =>
      recordMetadataCheckRuns(transaction, {
        organizationId,
        runId,
        rows: [{ ...good, checkId: "unit" as never }],
      })
    );
    await assertRejects(() =>
      recordMetadataCheckRuns(transaction, {
        organizationId,
        runId,
        rows: [{ ...good, subjectDigest: "not a digest" }],
      })
    );
    assertEquals(queries.length, 0);
    const ids = await recordMetadataCheckRuns(transaction, {
      organizationId,
      runId,
      rows: [good],
    });
    assertEquals(ids.length, 1);
    assertEquals(queries.length, 1);
    assert(String(queries[0][0]).includes("insert into bakery.check_runs"));
    const values = queries[0][1] as unknown[];
    assertEquals(values.slice(0, 3), [ids[0], organizationId, runId]);
    assert(values.includes(good.subjectDigest));
  });
}
