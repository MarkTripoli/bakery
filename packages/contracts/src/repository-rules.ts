import { z } from "zod";
import { canonicalJson, sha256Hex } from "./workflow-compiler/canonical.ts";

/** The only rule keys the first repository-rules slice supports. */
export const REPOSITORY_RULE_KEYS = Object.freeze(
  [
    "commits.semantic",
    "changeRequest.semanticTitle",
    "changeRequest.description",
    "code.magicNumbers",
    "code.magicStrings",
  ] as const,
);
export type RepositoryRuleKey = typeof REPOSITORY_RULE_KEYS[number];

export function isRepositoryRuleKey(
  value: unknown,
): value is RepositoryRuleKey {
  return typeof value === "string" &&
    (REPOSITORY_RULE_KEYS as readonly string[]).includes(value);
}

/** Enforcement modes shared with fixed-policy decisions. */
export const REPOSITORY_RULE_MODES = Object.freeze(
  ["guide", "warn", "require"] as const,
);
export type RepositoryRuleMode = typeof REPOSITORY_RULE_MODES[number];

/** Where an effective entry came from. */
export const REPOSITORY_RULE_PROVENANCE = Object.freeze(
  [
    "inherited",
    "repository_override",
    "repository_only",
    "locked_by_organization",
  ] as const,
);
export type RepositoryRuleProvenance =
  typeof REPOSITORY_RULE_PROVENANCE[number];

const MAX_ENTRIES = REPOSITORY_RULE_KEYS.length;

const RuleKeySchema = z.enum(REPOSITORY_RULE_KEYS).describe(
  "Stable repository rule key naming one built-in rule preset.",
);
const RuleModeSchema = z.enum(REPOSITORY_RULE_MODES).describe(
  "Guide supplies context, warn retains nonblocking findings, and require blocks failed or unavailable evidence.",
);
const EnabledSchema = z.boolean().describe(
  "Whether the rule is active; a disabled entry is distinct from an absent one.",
);
/**
 * Free text must survive PostgreSQL jsonb storage: NUL and lone surrogates
 * parse as JSON strings but jsonb rejects them, so refuse them up front.
 */
const UNPAIRED_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export const freeText = (schema: z.ZodString) =>
  schema.refine(
    (value) => !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value),
    {
      message: "Text must not contain NUL or unpaired surrogate characters.",
    },
  );

const ExplanationSchema = freeText(
  z.string().min(1).max(500).describe(
    "Explanation text of one to 500 characters.",
  ),
).optional().describe(
  "Optional human explanation of intent; guidance text only, never a claim of deterministic enforcement.",
);
const RevisionSchema = z.number().int().positive().describe(
  "Positive published organization revision; the empty baseline is a null or absent organization, and the effective projection reports revision 0.",
);

const TypeListSchema = z.array(
  z.string().min(1).max(32).regex(/^[a-z][a-z0-9-]*$/).describe(
    "One lowercase Conventional Commits type token.",
  ),
).min(1).max(32).describe(
  "Allowed Conventional Commits types; replaced whole, never merged.",
);
const ScopeRequirementSchema = z.enum(["optional", "required"]).describe(
  "Whether a parenthesized scope is optional or required.",
);
const SubjectLengthSchema = z.number().int().min(20).max(200).describe(
  "Maximum subject length in characters.",
);
const PathListSchema = z.array(
  freeText(
    z.string().min(1).max(200).describe("One repository path glob."),
  ),
).max(32).describe("Repository path globs excluded from the check.");
const CheckBindingSchema = z.union([
  z.string().min(1).max(100).regex(/^[a-z][a-z0-9._-]*$/).describe(
    "Fixed policy command id bound to this rule.",
  ),
  z.null().describe("No checker is bound to this rule."),
]).describe(
  "Fixed policy command id bound to this rule, or null when no checker is bound.",
);

const CommitsSemanticOptionsSchema = z.object({
  types: TypeListSchema,
  scope: ScopeRequirementSchema,
  maxSubjectLength: SubjectLengthSchema,
  range: z.enum(["all_commits", "final_squash_commit"]).describe(
    "Whether every introduced commit or only the final squash commit is validated.",
  ),
  mergeAndRevertCommits: z.enum(["validate", "exempt"]).describe(
    "Whether merge and revert commits are validated or exempt.",
  ),
}).strict().describe("Bounded options for semantic commit messages.");

const SemanticTitleOptionsSchema = z.object({
  types: TypeListSchema,
  scope: ScopeRequirementSchema,
  maxSubjectLength: SubjectLengthSchema,
}).strict().describe(
  "Bounded options for pull or merge request titles, not task names.",
);

const DescriptionOptionsSchema = z.object({
  template: freeText(
    z.string().max(8000).describe(
      "Markdown template for the change request description.",
    ),
  ),
  requiredSections: z.array(
    freeText(
      z.string().min(1).max(100).describe(
        "One required section heading.",
      ),
    ),
  ).max(16).describe(
    "Headings that must contain non-template content; replaced whole.",
  ),
  writingGuidance: freeText(
    z.string().max(2000).describe("Guidance text of up to 2000 characters."),
  ).optional().describe(
    "Optional writing guidance kept as review evidence, not parser enforcement.",
  ),
}).strict().describe("Bounded options for change request descriptions.");

const MagicNumbersOptionsSchema = z.object({
  checkBinding: CheckBindingSchema,
  allowedNumbers: z.array(
    z.number().finite().describe("One numeric literal that is always allowed."),
  ).max(32).describe("Numeric literal allowlist; replaced whole."),
  excludedPaths: PathListSchema,
}).strict().describe("Bounded options for unexplained numeric literals.");

const MagicStringsOptionsSchema = z.object({
  checkBinding: CheckBindingSchema,
  allowedLiterals: z.array(
    freeText(
      z.string().min(1).max(200).describe(
        "One string literal that is always allowed.",
      ),
    ),
  ).max(32).describe("String literal exception list; replaced whole."),
  excludedPaths: PathListSchema,
}).strict().describe("Bounded options for repeated domain string literals.");

const ruleBody = <K extends RepositoryRuleKey, O extends z.ZodType>(
  key: K,
  options: O,
) => ({
  ruleKey: z.literal(key).describe("Rule key selecting the options shape."),
  enabled: EnabledSchema,
  mode: RuleModeSchema,
  options,
  explanation: ExplanationSchema,
});

const OPTION_SCHEMAS = {
  "commits.semantic": CommitsSemanticOptionsSchema,
  "changeRequest.semanticTitle": SemanticTitleOptionsSchema,
  "changeRequest.description": DescriptionOptionsSchema,
  "code.magicNumbers": MagicNumbersOptionsSchema,
  "code.magicStrings": MagicStringsOptionsSchema,
} as const;

const lockedField = z.boolean().describe(
  "When true repositories cannot replace or disable this entry.",
);

export const OrganizationRepositoryRuleEntrySchema = z.discriminatedUnion(
  "ruleKey",
  [
    z.object({
      ...ruleBody("commits.semantic", OPTION_SCHEMAS["commits.semantic"]),
      locked: lockedField,
    }).strict().describe("Organization entry for semantic commits."),
    z.object({
      ...ruleBody(
        "changeRequest.semanticTitle",
        OPTION_SCHEMAS["changeRequest.semanticTitle"],
      ),
      locked: lockedField,
    }).strict().describe("Organization entry for semantic request titles."),
    z.object({
      ...ruleBody(
        "changeRequest.description",
        OPTION_SCHEMAS["changeRequest.description"],
      ),
      locked: lockedField,
    }).strict().describe("Organization entry for request descriptions."),
    z.object({
      ...ruleBody("code.magicNumbers", OPTION_SCHEMAS["code.magicNumbers"]),
      locked: lockedField,
    }).strict().describe("Organization entry for magic numbers."),
    z.object({
      ...ruleBody("code.magicStrings", OPTION_SCHEMAS["code.magicStrings"]),
      locked: lockedField,
    }).strict().describe("Organization entry for magic strings."),
  ],
).describe("One organization rule entry, including its lock flag.");

export const RepositoryRuleOverrideEntrySchema = z.discriminatedUnion(
  "ruleKey",
  [
    z.object(ruleBody("commits.semantic", OPTION_SCHEMAS["commits.semantic"]))
      .strict().describe("Repository override for semantic commits."),
    z.object(
      ruleBody(
        "changeRequest.semanticTitle",
        OPTION_SCHEMAS["changeRequest.semanticTitle"],
      ),
    ).strict().describe("Repository override for semantic request titles."),
    z.object(
      ruleBody(
        "changeRequest.description",
        OPTION_SCHEMAS["changeRequest.description"],
      ),
    ).strict().describe("Repository override for request descriptions."),
    z.object(
      ruleBody("code.magicNumbers", OPTION_SCHEMAS["code.magicNumbers"]),
    ).strict().describe("Repository override for magic numbers."),
    z.object(
      ruleBody("code.magicStrings", OPTION_SCHEMAS["code.magicStrings"]),
    ).strict().describe("Repository override for magic strings."),
  ],
).describe(
  "One explicit repository entry; a disabled entry differs from no entry.",
);

function uniqueKeys(
  entries: readonly { ruleKey: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.ruleKey)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "ruleKey"],
        message: "Duplicate rule key.",
      });
    }
    seen.add(entry.ruleKey);
  });
}

export const OrganizationRepositoryRulesSchema = z.object({
  revision: RevisionSchema,
  entries: z.array(OrganizationRepositoryRuleEntrySchema).max(MAX_ENTRIES)
    .describe("Organization entries with at most one per rule key."),
}).strict().superRefine((value, context) => uniqueKeys(value.entries, context))
  .describe("Published organization rules baseline at one revision.");

export const RepositoryRuleOverridesSchema = z.object({
  entries: z.array(RepositoryRuleOverrideEntrySchema).max(MAX_ENTRIES)
    .describe("Repository entries with at most one per rule key."),
}).strict().superRefine((value, context) => uniqueKeys(value.entries, context))
  .describe("Explicit repository rule entries kept in the profile.");

const RulesDigestSchema = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase SHA-256 of canonical effective entries and source revisions.",
);

const EffectiveEntryBase = {
  provenance: z.enum(REPOSITORY_RULE_PROVENANCE).describe(
    "Inherited, repository override, repository only, or locked by organization.",
  ),
  organizationRevision: z.union([
    z.number().int().positive().describe(
      "Published organization revision the entry came from.",
    ),
    z.null().describe("No organization entry applies to this rule."),
  ]).describe(
    "Source organization revision, or null when no organization entry applies.",
  ),
};

export const EffectiveRepositoryRuleEntrySchema = z.discriminatedUnion(
  "ruleKey",
  [
    z.object({
      ...ruleBody("commits.semantic", OPTION_SCHEMAS["commits.semantic"]),
      ...EffectiveEntryBase,
    }).strict().describe("Effective semantic commits entry."),
    z.object({
      ...ruleBody(
        "changeRequest.semanticTitle",
        OPTION_SCHEMAS["changeRequest.semanticTitle"],
      ),
      ...EffectiveEntryBase,
    }).strict().describe("Effective semantic request title entry."),
    z.object({
      ...ruleBody(
        "changeRequest.description",
        OPTION_SCHEMAS["changeRequest.description"],
      ),
      ...EffectiveEntryBase,
    }).strict().describe("Effective request description entry."),
    z.object({
      ...ruleBody("code.magicNumbers", OPTION_SCHEMAS["code.magicNumbers"]),
      ...EffectiveEntryBase,
    }).strict().describe("Effective magic numbers entry."),
    z.object({
      ...ruleBody("code.magicStrings", OPTION_SCHEMAS["code.magicStrings"]),
      ...EffectiveEntryBase,
    }).strict().describe("Effective magic strings entry."),
  ],
).describe("One resolved rule entry with provenance and source revision.");

export const SupersededRepositoryRuleOverrideSchema = z.object({
  ruleKey: RuleKeySchema,
  reason: z.literal("locked_by_organization").describe(
    "Why the saved override is inactive.",
  ),
  override: RepositoryRuleOverrideEntrySchema,
}).strict().describe(
  "Saved override kept for history but inactive under an organization lock.",
);

export const EffectiveRepositoryRulesSchema = z.object({
  organizationRevision: z.number().int().nonnegative().describe(
    "Organization revision resolved against; zero means the empty baseline.",
  ),
  entries: z.array(EffectiveRepositoryRuleEntrySchema).max(MAX_ENTRIES)
    .describe("Effective entries in canonical rule-key order."),
  supersededOverrides: z.array(SupersededRepositoryRuleOverrideSchema)
    .max(MAX_ENTRIES).describe(
      "Overrides inactive under a lock; excluded from the digest.",
    ),
  digest: RulesDigestSchema,
}).strict().describe("Resolved repository rules with provenance and digest.");

/**
 * The effective rules a run froze at admission. Profile identity repeats the
 * execution context's so the pin is self-describing; supersededOverrides stay
 * out because they are history, never part of the digest.
 */
export const PinnedRepositoryRulesSchema = z.object({
  organizationRevision: z.number().int().nonnegative().describe(
    "Organization revision resolved against at admission; zero means the empty baseline.",
  ),
  profileId: z.uuid().describe(
    "Pinned repository profile whose overrides were resolved.",
  ),
  profileRevision: z.number().int().positive().describe(
    "Pinned repository profile revision whose overrides were resolved.",
  ),
  entries: z.array(EffectiveRepositoryRuleEntrySchema).max(MAX_ENTRIES)
    .describe("Effective entries with provenance in canonical rule-key order."),
  digest: RulesDigestSchema,
}).strict().superRefine((value, context) => {
  uniqueKeys(value.entries, context);
  let previous = -1;
  value.entries.forEach((entry, index) => {
    const position = REPOSITORY_RULE_KEYS.indexOf(entry.ruleKey);
    if (position <= previous) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "ruleKey"],
        message: "Entries must follow canonical rule-key order.",
      });
    }
    previous = position;
    const sourced = entry.provenance !== "repository_only";
    if (
      sourced
        ? entry.organizationRevision !== value.organizationRevision ||
          value.organizationRevision === 0
        : entry.organizationRevision !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "organizationRevision"],
        message: "Entry source revision contradicts its provenance.",
      });
    }
  });
}).describe(
  "Immutable effective repository rules frozen into one run snapshot and carried by every job of that run.",
);

export type OrganizationRepositoryRuleEntry = z.output<
  typeof OrganizationRepositoryRuleEntrySchema
>;
export type OrganizationRepositoryRules = z.output<
  typeof OrganizationRepositoryRulesSchema
>;
export type RepositoryRuleOverrideEntry = z.output<
  typeof RepositoryRuleOverrideEntrySchema
>;
export type RepositoryRuleOverrides = z.output<
  typeof RepositoryRuleOverridesSchema
>;
export type EffectiveRepositoryRuleEntry = z.output<
  typeof EffectiveRepositoryRuleEntrySchema
>;
export type SupersededRepositoryRuleOverride = z.output<
  typeof SupersededRepositoryRuleOverrideSchema
>;
export type EffectiveRepositoryRules = z.output<
  typeof EffectiveRepositoryRulesSchema
>;
export type PinnedRepositoryRules = z.output<
  typeof PinnedRepositoryRulesSchema
>;
export type EffectiveRepositoryRulesBody = Omit<
  EffectiveRepositoryRules,
  "digest"
>;

export type RepositoryRuleLockConflict = {
  readonly ruleKey: RepositoryRuleKey;
  readonly reason: "replaces_locked_rule" | "disables_locked_rule";
};
export type RepositoryRuleOverrideValidation =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly conflicts: readonly RepositoryRuleLockConflict[];
  };

function orderIndex(key: RepositoryRuleKey): number {
  return REPOSITORY_RULE_KEYS.indexOf(key);
}

function lockedKeys(
  organization: OrganizationRepositoryRules | null | undefined,
): Set<RepositoryRuleKey> {
  return new Set(
    (organization?.entries ?? []).filter((entry) => entry.locked).map((
      entry,
    ) => entry.ruleKey),
  );
}

/**
 * Rejects overrides that replace or disable a locked organization entry.
 * Only lock conflicts return the typed result; malformed input (unknown or
 * duplicate rule keys, bad options) throws a ZodError.
 */
export function validateRepositoryRuleOverrides(
  organizationInput: OrganizationRepositoryRules | null | undefined,
  overridesInput: RepositoryRuleOverrides,
): RepositoryRuleOverrideValidation {
  const organization = organizationInput == null
    ? null
    : OrganizationRepositoryRulesSchema.parse(organizationInput);
  const overrides = RepositoryRuleOverridesSchema.parse(overridesInput);
  const locked = lockedKeys(organization);
  const conflicts = overrides.entries
    .filter((entry) => locked.has(entry.ruleKey))
    .map((entry): RepositoryRuleLockConflict => ({
      ruleKey: entry.ruleKey,
      reason: entry.enabled ? "replaces_locked_rule" : "disables_locked_rule",
    }))
    .sort((a, b) => orderIndex(a.ruleKey) - orderIndex(b.ruleKey));
  return conflicts.length === 0 ? { ok: true } : { ok: false, conflicts };
}

function withoutLock(
  entry: OrganizationRepositoryRuleEntry,
): RepositoryRuleOverrideEntry {
  const { locked: _locked, ...rest } = entry;
  return rest as RepositoryRuleOverrideEntry;
}

/**
 * Pure synchronous resolution. A locked organization entry always wins and
 * its override is reported as superseded; resolution never throws on a lock
 * conflict, so saved overrides reactivate when a later revision drops the lock.
 * Malformed input (unknown or duplicate rule keys) throws a ZodError.
 */
export function resolveRepositoryRuleEntries(
  organizationInput: OrganizationRepositoryRules | null | undefined,
  overridesInput: RepositoryRuleOverrides,
): EffectiveRepositoryRulesBody {
  const organization = organizationInput == null
    ? null
    : OrganizationRepositoryRulesSchema.parse(organizationInput);
  const overrides = RepositoryRuleOverridesSchema.parse(overridesInput);
  const revision = organization?.revision ?? 0;
  const orgByKey = new Map(
    (organization?.entries ?? []).map((entry) => [entry.ruleKey, entry]),
  );
  const overrideByKey = new Map(
    overrides.entries.map((entry) => [entry.ruleKey, entry]),
  );
  const entries: EffectiveRepositoryRuleEntry[] = [];
  const supersededOverrides: SupersededRepositoryRuleOverride[] = [];
  for (const key of REPOSITORY_RULE_KEYS) {
    const org = orgByKey.get(key);
    const override = overrideByKey.get(key);
    if (org?.locked) {
      if (override) {
        supersededOverrides.push({
          ruleKey: key,
          reason: "locked_by_organization",
          override,
        });
      }
      entries.push({
        ...withoutLock(org),
        provenance: "locked_by_organization",
        organizationRevision: revision,
      } as EffectiveRepositoryRuleEntry);
    } else if (override) {
      entries.push({
        ...override,
        provenance: org ? "repository_override" : "repository_only",
        organizationRevision: org ? revision : null,
      } as EffectiveRepositoryRuleEntry);
    } else if (org) {
      entries.push({
        ...withoutLock(org),
        provenance: "inherited",
        organizationRevision: revision,
      } as EffectiveRepositoryRuleEntry);
    }
  }
  return { organizationRevision: revision, entries, supersededOverrides };
}

/** Digest of effective entries and source revisions; superseded overrides excluded. */
export function repositoryRulesDigest(
  body: Pick<EffectiveRepositoryRulesBody, "organizationRevision" | "entries">,
): Promise<string> {
  return sha256Hex(canonicalJson({
    organizationRevision: body.organizationRevision,
    entries: body.entries,
  }));
}

/** Resolves entries and digest; malformed input throws a ZodError. */
export async function resolveRepositoryRules(
  organization: OrganizationRepositoryRules | null | undefined,
  overrides: RepositoryRuleOverrides,
): Promise<EffectiveRepositoryRules> {
  const body = resolveRepositoryRuleEntries(organization, overrides);
  return { ...body, digest: await repositoryRulesDigest(body) };
}

/**
 * Pins resolved rules for one profile. The pin carries no more than the
 * digest covers plus the profile identity, so verification is a recomputation.
 */
export function pinRepositoryRules(
  resolved: EffectiveRepositoryRules,
  profile: { readonly id: string; readonly revision: number },
): PinnedRepositoryRules {
  return PinnedRepositoryRulesSchema.parse({
    organizationRevision: resolved.organizationRevision,
    profileId: profile.id,
    profileRevision: profile.revision,
    entries: resolved.entries,
    digest: resolved.digest,
  });
}

/**
 * True only when the pinned digest equals the digest of the pinned entries and
 * organization revision. Any edit to a frozen rule, mode, option or source
 * revision breaks it; a caller treats false as a rejected execution.
 */
export async function verifyPinnedRepositoryRules(
  pinned: PinnedRepositoryRules,
): Promise<boolean> {
  return await repositoryRulesDigest(pinned) === pinned.digest;
}

/** One built-in command a `require` rule needs a workflow stage to run. */
export type RepositoryRuleStageRequirement = {
  readonly ruleKey: RepositoryRuleKey;
  readonly commandId: string;
};

/**
 * Requirements a workflow must satisfy for an organization baseline or a
 * pinned effective set: every enabled `require` entry bound to a fixed policy
 * command needs a stage that runs that command. Guide and warn entries and unbound rules never bind a
 * stage, so they cannot block a workflow.
 */
export function repositoryRuleStageRequirements(
  rules:
    | {
      readonly entries: readonly (
        | OrganizationRepositoryRuleEntry
        | EffectiveRepositoryRuleEntry
      )[];
    }
    | null
    | undefined,
): readonly RepositoryRuleStageRequirement[] {
  const requirements: RepositoryRuleStageRequirement[] = [];
  for (const entry of rules?.entries ?? []) {
    if (!entry.enabled || entry.mode !== "require") continue;
    if (!("checkBinding" in entry.options)) continue;
    const commandId = entry.options.checkBinding;
    if (commandId !== null) {
      requirements.push({ ruleKey: entry.ruleKey, commandId });
    }
  }
  return requirements.sort((a, b) =>
    orderIndex(a.ruleKey) - orderIndex(b.ruleKey)
  );
}

/**
 * Marker a stage lists in `checks` when it runs every fixed policy command of
 * the pinned profile (`checks: $delivery.checkIds`). No command id can equal
 * it, because command ids start with a lowercase letter.
 */
export const RULE_GUARD_ALL_CHECKS = "*";

/** What the guard needs to know about one workflow stage, in execution order. */
export type RepositoryRuleWorkflowStage = {
  /**
   * Fixed policy command ids this stage runs as literal checks, or
   * `RULE_GUARD_ALL_CHECKS` when it runs every command; empty otherwise.
   */
  readonly checks: readonly string[];
  /** Whether this stage can change the candidate revision. */
  readonly producesRevision: boolean;
};

export type RepositoryRuleStageViolation = {
  readonly ruleKey: RepositoryRuleKey;
  readonly commandId: string;
  readonly reason: "stage_missing" | "stage_before_revision";
};

/**
 * A workflow with a revision-producing stage needs the required check to exist
 * and to run after the last such stage, otherwise it never sees the final
 * revision. Workflows without one are not bound.
 */
export function repositoryRuleStageViolations(
  requirements: readonly RepositoryRuleStageRequirement[],
  stages: readonly RepositoryRuleWorkflowStage[],
): readonly RepositoryRuleStageViolation[] {
  const lastRevision = stages.reduce(
    (last, stage, index) => stage.producesRevision ? index : last,
    -1,
  );
  // The rule checks the candidate revision; a workflow that never changes one
  // (noop, freeform, cloud-only) has nothing to check and is not bound.
  if (lastRevision < 0) return [];
  const violations: RepositoryRuleStageViolation[] = [];
  for (const requirement of requirements) {
    const runs = stages.flatMap((stage, index) =>
      stage.checks.includes(requirement.commandId) ||
        stage.checks.includes(RULE_GUARD_ALL_CHECKS)
        ? [index]
        : []
    );
    if (runs.length === 0) {
      violations.push({ ...requirement, reason: "stage_missing" });
    } else if (!runs.some((index) => index > lastRevision)) {
      violations.push({ ...requirement, reason: "stage_before_revision" });
    }
  }
  return violations;
}

/** Encoded-size ceiling of every job input the worker transport carries. */
export const EXECUTION_JOB_INPUT_BYTES_MAX = 100_000;

/**
 * Ceiling of the canonical organization entries. A run pins the effective
 * entries (at most the organization entries plus the profile overrides, which
 * are capped near 14.6 KB) and the job input also repeats the profile config,
 * so this leaves the rest of a 100,000-byte job input at least 30,000 bytes
 * even for the worst pin. A unit test recomputes that margin.
 */
export const ORGANIZATION_RULES_MAX_BYTES = 32_000;

/**
 * Bytes reserved, when a step's job input cannot be resolved at admission, for
 * the identifiers it takes from earlier step outputs (artifact and version ids).
 */
export const STEP_OUTPUT_ALLOWANCE_BYTES = 2_048;

/** UTF-8 bytes of the canonical entries, the unit the ceiling is measured in. */
export function organizationRulesBytes(
  entries: readonly OrganizationRepositoryRuleEntry[],
): number {
  return new TextEncoder().encode(canonicalJson(entries)).length;
}
