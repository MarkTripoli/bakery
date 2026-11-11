import {
  canonicalJson,
} from "../../apps/server/src/platform/canonical-json.ts";
import { RepositoryProfileConfigSchema } from "../../packages/contracts/src/repository-profile-config.ts";

// Database-free organization rule entry builders shared by contract and lane tests.
export function commitsEntry(locked = true) {
  return {
    ruleKey: "commits.semantic",
    enabled: true,
    mode: "require",
    options: {
      types: ["feat", "fix"],
      scope: "optional",
      maxSubjectLength: 72,
      range: "all_commits",
      mergeAndRevertCommits: "exempt",
    },
    locked,
  };
}

export function titleEntry(maxSubjectLength = 72) {
  return {
    ruleKey: "changeRequest.semanticTitle",
    enabled: true,
    mode: "warn",
    options: {
      types: ["feat", "fix", "chore"],
      scope: "required",
      maxSubjectLength,
    },
    explanation: "Titles follow Conventional Commits.",
    locked: false,
  };
}

/** One valid organization entry for each of the five supported rule keys. */
export function allRuleEntries() {
  return [
    commitsEntry(true),
    titleEntry(),
    {
      ruleKey: "changeRequest.description",
      enabled: true,
      mode: "guide",
      options: {
        template: "## Summary\n\n## Verification\n",
        requiredSections: ["Summary", "Verification"],
        writingGuidance: "Say what changed and why.",
      },
      locked: false,
    },
    {
      ruleKey: "code.magicNumbers",
      enabled: true,
      mode: "warn",
      options: {
        checkBinding: null,
        allowedNumbers: [0, 1, -1],
        excludedPaths: ["**/*.test.ts"],
      },
      locked: false,
    },
    {
      ruleKey: "code.magicStrings",
      enabled: false,
      mode: "guide",
      options: {
        checkBinding: "magic-strings.check",
        allowedLiterals: ["utf-8"],
        excludedPaths: [],
      },
      locked: true,
    },
  ];
}

/** Base v1 profile config; callers spread `repositoryRules` over it. */
export const baseProfileConfig = Object.freeze({
  schemaVersion: 1 as const,
  workflow: { kind: "fixed" as const },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
});

/**
 * Override entries of tunable encoded size: constant 3-byte-character ballast
 * plus `fillerChars` more spread over excluded paths of at most 200 chars.
 */
export function ballastRules(fillerChars: number) {
  const paths: string[] = [];
  for (let left = fillerChars; left > 0; left -= 200) {
    paths.push("径".repeat(Math.min(200, left)));
  }
  return [{
    ruleKey: "changeRequest.description",
    enabled: true,
    mode: "guide",
    options: {
      template: "述".repeat(3000),
      requiredSections: [] as string[],
    },
  }, {
    ruleKey: "code.magicNumbers",
    enabled: true,
    mode: "guide",
    options: {
      checkBinding: null,
      allowedNumbers: [] as number[],
      excludedPaths: paths,
    },
  }];
}

/** Canonical encoded bytes of a base profile config carrying these rules. */
export function configBytesWithRules(entries: unknown[]): number {
  const parsed = RepositoryProfileConfigSchema.parse({
    ...baseProfileConfig,
    repositoryRules: { entries },
  });
  return new TextEncoder().encode(canonicalJson(parsed)).length;
}

/** Largest filler for which the config still fits the publish bound. */
export function maxFillerChars(ceiling: number): number {
  let filler = 0;
  while (configBytesWithRules(ballastRules(filler + 1)) <= ceiling) filler++;
  return filler;
}
