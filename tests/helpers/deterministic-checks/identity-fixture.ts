import type {
  CandidateIdentity,
  CheckRunEvidence,
} from "../../../apps/server/src/modules/delivery/identity.ts";
import type { MetadataCheckRow } from "../../../apps/server/src/modules/delivery/metadata-checks.ts";
import type {
  CandidateMetadataReader,
  CandidateMetadataRef,
  CandidateMetadataSnapshot,
} from "../../../apps/server/src/modules/delivery/metadata-reader.ts";
import {
  OrganizationRepositoryRulesSchema,
  resolveRepositoryRules,
} from "../../../packages/contracts/src/repository-rules.ts";
import { BASE_SHA, HEAD_SHA } from "./observations.ts";

/**
 * Builders for the freshness, verdict and metadata cases. A digest is a
 * zero-padded counter, so two different numbers are two different digests and
 * every part of an identity can be changed on its own.
 */

/** A distinct, well-formed SHA-256 hex digest for `n`. */
export function digest(n: number): string {
  return n.toString(16).padStart(64, "0");
}

export const SUBJECT_UNIT = "command:unit";
export const SUBJECT_TITLE = "rule:changeRequest.semanticTitle";
export const SUBJECT_BODY = "rule:changeRequest.description";
export const SUBJECT_COMMITS = "rule:commits.semantic";

/** The candidate as it stands; every other fixture row is recorded against it. */
export function currentIdentity(
  overrides: Partial<CandidateIdentity> = {},
): CandidateIdentity {
  return {
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    profileDigest: digest(1),
    checkerDigest: digest(2),
    subjects: {
      [SUBJECT_UNIT]: digest(3),
      [SUBJECT_TITLE]: digest(4),
      [SUBJECT_BODY]: digest(5),
      [SUBJECT_COMMITS]: digest(6),
      "command:lint": digest(11),
    },
    titleDigest: digest(7),
    bodyDigest: digest(8),
    mergeMessageDigest: digest(9),
    commitSelectionDigest: digest(10),
    ...overrides,
  };
}

let rowNumber = 0;

/** A passed, fresh row; override fields to model any other recorded outcome. */
export function evidence(
  overrides: Partial<CheckRunEvidence> = {},
): CheckRunEvidence {
  rowNumber++;
  return {
    id: crypto.randomUUID(),
    checkId: "unit",
    kind: "command",
    ruleKey: null,
    result: "passed",
    reason: "verified",
    createdAt: new Date(Date.UTC(2026, 9, 31, 12, 0, 0, rowNumber))
      .toISOString(),
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    profileDigest: digest(1),
    subjectDigest: digest(3),
    checkerDigest: digest(2),
    titleDigest: null,
    bodyDigest: null,
    mergeMessageDigest: null,
    commitSelectionDigest: null,
    ...overrides,
  };
}

/** A fresh row for each kind of check, bound to the parts that kind uses. */
export const rowFor = {
  command: (overrides: Partial<CheckRunEvidence> = {}) => evidence(overrides),
  commits: (overrides: Partial<CheckRunEvidence> = {}) =>
    evidence({
      checkId: "commits.semantic",
      kind: "commits",
      ruleKey: "commits.semantic",
      profileDigest: null,
      checkerDigest: null,
      subjectDigest: digest(6),
      commitSelectionDigest: digest(10),
      ...overrides,
    }),
  title: (overrides: Partial<CheckRunEvidence> = {}) =>
    evidence({
      checkId: "changeRequest.semanticTitle",
      kind: "title",
      ruleKey: "changeRequest.semanticTitle",
      profileDigest: null,
      checkerDigest: null,
      subjectDigest: digest(4),
      titleDigest: digest(7),
      ...overrides,
    }),
  description: (overrides: Partial<CheckRunEvidence> = {}) =>
    evidence({
      checkId: "changeRequest.description",
      kind: "description",
      ruleKey: "changeRequest.description",
      profileDigest: null,
      checkerDigest: null,
      subjectDigest: digest(5),
      bodyDigest: digest(8),
      ...overrides,
    }),
  mergeMessage: (overrides: Partial<CheckRunEvidence> = {}) =>
    evidence({
      checkId: "commits.semantic",
      kind: "merge_message",
      ruleKey: "commits.semantic",
      profileDigest: null,
      checkerDigest: null,
      subjectDigest: digest(6),
      mergeMessageDigest: digest(9),
      ...overrides,
    }),
};

/** A recorded row as the evaluator would read it back from the table. */
export function asEvidence(
  row: MetadataCheckRow,
  overrides: Partial<CheckRunEvidence> = {},
): CheckRunEvidence {
  rowNumber++;
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(Date.UTC(2026, 9, 31, 12, 0, 0, rowNumber))
      .toISOString(),
    ...row,
    ...overrides,
  };
}

/** A well-formed trusted snapshot that satisfies the default rule entries. */
export function goodSnapshot(
  overrides: Partial<CandidateMetadataSnapshot> = {},
): CandidateMetadataSnapshot {
  return {
    commitMessages: ["feat(delivery): add check rows", "fix: keep order"],
    title: "feat(delivery): add check rows",
    body:
      "## Summary\nRecords check rows for the candidate.\n\n## Verification\nRan the unit lane.\n",
    mergeMessage: "feat(delivery): add check rows",
    ...overrides,
  };
}

/** What a fixture reader was asked, so a case can prove the candidate it read. */
export type FixtureReader = CandidateMetadataReader & {
  readonly refs: CandidateMetadataRef[];
};

/**
 * A reader over fixed data. A `null` source models a provider that has nothing
 * for the candidate; an `Error` source models a provider call that throws.
 */
export function fixtureMetadataReader(
  source: unknown,
): FixtureReader {
  const refs: CandidateMetadataRef[] = [];
  return {
    refs,
    read(ref) {
      refs.push(ref);
      if (source instanceof Error) return Promise.reject(source);
      return Promise.resolve(source as CandidateMetadataSnapshot | null);
    },
  };
}

type RuleEntry = Record<string, unknown>;

/**
 * Resolves organization entries to the effective entries a run pins. The
 * revision is a parameter so a case can bump it without touching an entry.
 */
export async function effectiveEntries(entries: RuleEntry[], revision = 1) {
  const organization = OrganizationRepositoryRulesSchema.parse({
    revision,
    entries,
  });
  return (await resolveRepositoryRules(organization, { entries: [] })).entries;
}

export function descriptionEntry(
  options: Partial<{ template: string; requiredSections: string[] }> = {},
  mode = "require",
): RuleEntry {
  return {
    ruleKey: "changeRequest.description",
    enabled: true,
    mode,
    options: {
      template: "## Summary\n\n## Verification\n",
      requiredSections: ["Summary", "Verification"],
      ...options,
    },
    locked: false,
  };
}

export function commitRangeEntry(
  range: "all_commits" | "final_squash_commit",
  mode = "require",
  mergeAndRevertCommits: "validate" | "exempt" = "exempt",
): RuleEntry {
  return {
    ruleKey: "commits.semantic",
    enabled: true,
    mode,
    options: {
      types: ["feat", "fix"],
      scope: "optional",
      maxSubjectLength: 72,
      range,
      mergeAndRevertCommits,
    },
    locked: false,
  };
}

export function titleRuleEntry(mode = "require"): RuleEntry {
  return {
    ruleKey: "changeRequest.semanticTitle",
    enabled: true,
    mode,
    options: {
      types: ["feat", "fix"],
      scope: "optional",
      maxSubjectLength: 72,
    },
    locked: false,
  };
}

export function magicRuleEntry(
  ruleKey: "code.magicNumbers" | "code.magicStrings",
  checkBinding: string | null,
  mode = "require",
  enabled = true,
): RuleEntry {
  return {
    ruleKey,
    enabled,
    mode,
    options: ruleKey === "code.magicNumbers"
      ? { checkBinding, allowedNumbers: [0, 1], excludedPaths: [] }
      : { checkBinding, allowedLiterals: [], excludedPaths: [] },
    locked: false,
  };
}
