import { assertEquals } from "@std/assert";
import {
  changedKeys,
  effectiveEntries,
  rebaseDraft,
  type RulesDraft,
  sameEntry,
} from "../../apps/web/src/pages/repository-rules/draft.ts";
import type { RuleEntry } from "../../apps/web/src/pages/repository-rules/presentation.ts";

const entry = (value: Record<string, unknown>) => value as unknown as RuleEntry;
const semantic = (mode: string) =>
  entry({
    ruleKey: "commits.semantic",
    enabled: true,
    mode,
    locked: true,
    options: {
      types: ["feat", "fix"],
      scope: "optional",
      maxSubjectLength: 72,
      range: "all_commits",
      mergeAndRevertCommits: "exempt",
    },
  });
const strings = (enabled: boolean) =>
  entry({
    ruleKey: "code.magicStrings",
    enabled,
    mode: "warn",
    locked: false,
    options: { checkBinding: null, allowedLiterals: [], excludedPaths: [] },
  });

/** The published rules of a revision: Semantic commits and Magic strings. */
const revision = (semanticMode: string, stringsEnabled = false) => [
  semantic(semanticMode),
  strings(stringsEnabled),
];

/** A draft made on revision 3, where Semantic commits is Require, that sets it to Warn. */
function draftOnRevision3(): RulesDraft {
  return {
    baseRevision: 3,
    baseEntries: revision("require"),
    edited: { "commits.semantic": semantic("warn") },
    conflicts: [],
    staleRevision: null,
  };
}

Deno.test("a rule changed in both places becomes a conflict on the first newer revision", () => {
  const rebased = rebaseDraft(draftOnRevision3(), 4, revision("guide"));
  assertEquals(rebased?.conflicts, ["commits.semantic"]);
  assertEquals(rebased?.baseRevision, 4);
  assertEquals(rebased?.staleRevision, 4);
  // The edit is kept as it was made.
  assertEquals(rebased?.edited["commits.semantic"], semantic("warn"));
});

Deno.test("an undecided conflict stays when a second newer revision leaves the rule as the first one had it", () => {
  const first = rebaseDraft(draftOnRevision3(), 4, revision("guide"))!;
  // Revision 5 touches only Magic strings: Semantic commits is still Guide.
  const second = rebaseDraft(first, 5, revision("guide", true))!;
  assertEquals(second.conflicts, ["commits.semantic"]);
  assertEquals(second.baseRevision, 5);
  assertEquals(second.edited["commits.semantic"], semantic("warn"));
});

Deno.test("an undecided conflict stays when a second newer revision changes the rule again", () => {
  const first = rebaseDraft(draftOnRevision3(), 4, revision("guide"))!;
  const second = rebaseDraft(first, 5, revision("require"))!;
  assertEquals(second.conflicts, ["commits.semantic"]);
});

Deno.test("an edit that says what the newer revision says is dropped, conflict or not", () => {
  // Revision 4 now says Warn too: nothing is left to publish.
  assertEquals(rebaseDraft(draftOnRevision3(), 4, revision("warn")), null);
  // The same after a conflict was raised: revision 5 settles it.
  const first = rebaseDraft(draftOnRevision3(), 4, revision("guide"))!;
  assertEquals(rebaseDraft(first, 5, revision("warn")), null);
});

Deno.test("with no conflict pending, a newer revision that changes another rule only carries the edit over", () => {
  const rebased = rebaseDraft(
    draftOnRevision3(),
    4,
    revision("require", true),
  )!;
  assertEquals(rebased.conflicts, []);
  assertEquals(rebased.edited["commits.semantic"], semantic("warn"));
  assertEquals(rebased.baseEntries, revision("require", true));
});

Deno.test("a conflict that was decided with Keep mine does not come back on the next revision", () => {
  const first = rebaseDraft(draftOnRevision3(), 4, revision("guide"))!;
  // Keep mine: the page removes the key from the conflicts and keeps the edit.
  const decided: RulesDraft = { ...first, conflicts: [] };
  const second = rebaseDraft(decided, 5, revision("guide", true))!;
  assertEquals(second.conflicts, []);
  assertEquals(second.edited["commits.semantic"], semantic("warn"));
});

Deno.test("an undecided conflict stays when the newer revision removes the rule", () => {
  const first = rebaseDraft(draftOnRevision3(), 4, revision("guide"))!;
  const second = rebaseDraft(first, 5, [strings(false)])!;
  assertEquals(second.conflicts, ["commits.semantic"]);
});

Deno.test("only the rules the draft actually changes count as changed, and the effective rules layer the draft over the published ones", () => {
  const published = revision("require");
  const draft = draftOnRevision3();
  assertEquals(changedKeys(published, draft), ["commits.semantic"]);
  assertEquals(changedKeys(published, null), []);
  // An edit equal to the published entry is not a change.
  assertEquals(
    changedKeys(published, {
      ...draft,
      edited: { "commits.semantic": semantic("require") },
    }),
    [],
  );
  assertEquals(effectiveEntries(published, draft).map((e) => e.mode), [
    "warn",
    "warn",
  ]);
  assertEquals(sameEntry(semantic("warn"), semantic("warn")), true);
  assertEquals(sameEntry(semantic("warn"), semantic("guide")), false);
});
