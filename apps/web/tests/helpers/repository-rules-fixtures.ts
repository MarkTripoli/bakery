import type { Locator, Page } from "@playwright/test";

/** Rule entries shared by the repository rules specs; every one passes the strict contract. */
export type RuleEntry = Record<string, unknown>;

/** The five built-in rules: two locked, one switched off. */
export const RULE_ENTRIES: RuleEntry[] = [
  {
    ruleKey: "commits.semantic",
    enabled: true,
    mode: "require",
    locked: true,
    options: {
      types: ["feat", "fix", "docs"],
      scope: "optional",
      maxSubjectLength: 72,
      range: "all_commits",
      mergeAndRevertCommits: "exempt",
    },
  },
  {
    ruleKey: "changeRequest.semanticTitle",
    enabled: true,
    mode: "require",
    locked: true,
    options: {
      types: ["feat", "fix"],
      scope: "required",
      maxSubjectLength: 72,
    },
  },
  {
    ruleKey: "changeRequest.description",
    enabled: true,
    mode: "require",
    locked: false,
    options: {
      template: "## Summary\n\n## Changes\n\n## Validation\n",
      requiredSections: ["Summary", "Changes", "Validation"],
    },
  },
  {
    ruleKey: "code.magicNumbers",
    enabled: true,
    mode: "require",
    locked: false,
    options: { checkBinding: null, allowedNumbers: [0, 1], excludedPaths: [] },
  },
  {
    ruleKey: "code.magicStrings",
    enabled: false,
    mode: "warn",
    locked: false,
    options: { checkBinding: null, allowedLiterals: [], excludedPaths: [] },
  },
];

/**
 * The organization rules as the page lays them out: a table on a wide screen,
 * a list of rows on a phone. Exactly one of them exists at a time.
 */
export function rulesRegion(page: Page): Locator {
  return page.getByRole("table", { name: "Organization rules" }).or(
    page.getByRole("list", { name: "Organization rules" }),
  );
}

/** One rule's row in whichever layout is showing. */
export function ruleRow(page: Page, name: string): Locator {
  const region = rulesRegion(page);
  return region.getByRole("row", { name }).or(
    region.getByRole("listitem").filter({ hasText: name }),
  );
}
