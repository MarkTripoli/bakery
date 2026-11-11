import { z } from "zod";
import {
  REPOSITORY_RULE_MODES,
  RepositoryRuleOverridesSchema,
} from "./repository-rules.ts";

export const REPOSITORY_FIXED_POLICY_ACTION_EFFECTS = Object.freeze(
  {
    "rpi.design": "artifact_only",
    "harness.implement": "repository_revision",
    "harness.repair": "repository_revision",
    "quality.check": "evidence_only",
    "review.independent": "review_evidence",
    "agent.freeform": "artifact_only",
    "mcp.discover": "projection_only",
    "task.brief": "artifact_only",
  } as const,
);

const policyId = z.string().min(1).max(100).regex(/^[a-z][a-z0-9._-]*$/)
  .describe("Stable fixed-policy command identity.");
const policyDigest = z.string().regex(/^[0-9a-f]{64}$/).describe(
  "Lowercase SHA-256 digest of canonical trusted checker configuration.",
);
const repositoryActionName = z.string().min(1).max(100).regex(
  /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/,
).describe("Registered action name selected by a repository profile.");
const immutableAgentVersionId = z.uuid().describe(
  "Exact immutable agent-version identifier selected for an action.",
);
const RepositoryAgentBindingsSchema = z.record(
  repositoryActionName,
  immutableAgentVersionId,
).refine((bindings) => Object.keys(bindings).length <= 17, {
  message: "Repository profiles may bind at most 17 actions.",
}).describe(
  "Optional bounded action-to-immutable-agent-version selector map.",
);

export const RepositoryPolicyEffectSchema = z.enum([
  "artifact_only",
  "repository_revision",
  "evidence_only",
  "review_evidence",
  "projection_only",
]).describe(
  "Finite effect class an admitted fixed-workflow action may produce.",
);

const RepositoryPolicyCommandSchema = z.object({
  id: policyId,
  argv: z.array(
    z.string().min(1).max(255).refine(
      (value) =>
        [...value].every((character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
        ),
      "Command argument contains a control character.",
    ).describe(
      "One immutable command argument; argv is evidence and never shell text.",
    ),
  ).min(1).max(32).describe(
    "Exact fixed argv required by this policy command; no shell expansion.",
  ),
}).strict().describe("One immutable named repository command.");

const RepositoryPolicyDecisionSchema = z.object({
  commandId: policyId.describe(
    "Fixed command governed by this enforcement decision.",
  ),
  mode: z.enum(REPOSITORY_RULE_MODES).describe(
    "Guide supplies context, warn retains nonblocking evidence, and require blocks absent or failed evidence.",
  ),
}).strict().describe("One immutable guide, warn, or require decision.");

const RepositoryFixedPolicyCoreSchema = z.object({
  schemaVersion: z.literal(1).describe(
    "Fixed repository policy schema version.",
  ),
  commands: z.array(RepositoryPolicyCommandSchema).min(1).max(32).describe(
    "Unique fixed commands available to the repository check runner.",
  ),
  allowedEffects: z.array(RepositoryPolicyEffectSchema).min(1).max(5).describe(
    "Unique effect classes permitted for this repository profile.",
  ),
  lockedConfiguration: z.object({
    branches: z.literal(true).describe(
      "Branch boundary is immutable for this policy revision.",
    ),
    worktree: z.literal(true).describe(
      "Worktree boundary is immutable for this policy revision.",
    ),
    checker: z.literal(true).describe(
      "Trusted checker configuration cannot be supplied or weakened by a run, worker, or import.",
    ),
  }).strict().describe(
    "Configuration locks enforced by publication and every execution admission.",
  ),
  decisions: z.array(RepositoryPolicyDecisionSchema).min(1).max(32).describe(
    "Exactly one enforcement decision for each fixed command.",
  ),
}).strict().describe("Validated fields shared by draft and effective policy.");

type RepositoryFixedPolicyCore = z.output<
  typeof RepositoryFixedPolicyCoreSchema
>;

function validateRepositoryFixedPolicy(
  policy: RepositoryFixedPolicyCore,
  context: z.RefinementCtx,
): void {
  const commandIds = new Set<string>();
  policy.commands.forEach((command, index) => {
    if (commandIds.has(command.id)) {
      context.addIssue({
        code: "custom",
        path: ["commands", index, "id"],
        message: "Duplicate policy command identity.",
      });
    }
    commandIds.add(command.id);
  });
  const effects = new Set<string>();
  policy.allowedEffects.forEach((effect, index) => {
    if (effects.has(effect)) {
      context.addIssue({
        code: "custom",
        path: ["allowedEffects", index],
        message: "Duplicate allowed effect.",
      });
    }
    effects.add(effect);
  });
  const decisions = new Set<string>();
  policy.decisions.forEach((decision, index) => {
    if (!commandIds.has(decision.commandId)) {
      context.addIssue({
        code: "custom",
        path: ["decisions", index, "commandId"],
        message: "Decision references an unknown policy command.",
      });
    }
    if (decisions.has(decision.commandId)) {
      context.addIssue({
        code: "custom",
        path: ["decisions", index, "commandId"],
        message: "Duplicate policy command decision.",
      });
    }
    decisions.add(decision.commandId);
  });
  policy.commands.forEach((command, index) => {
    if (!decisions.has(command.id)) {
      context.addIssue({
        code: "custom",
        path: ["commands", index, "id"],
        message: "Every policy command requires one enforcement decision.",
      });
    }
  });
}

export const RepositoryFixedPolicyDraftSchema = RepositoryFixedPolicyCoreSchema
  .superRefine(validateRepositoryFixedPolicy)
  .describe(
    "Admin-authored fixed policy draft; trusted checker identity is server-derived after inspection.",
  );

export const RepositoryFixedPolicySchema = RepositoryFixedPolicyCoreSchema
  .extend({
    trustedChecker: z.object({
      kind: z.literal("repository-inspection").describe(
        "Server-owned checker authority; imports and workers cannot replace it.",
      ),
      configDigest: policyDigest,
    }).strict().describe(
      "Exact trusted checker configuration bound by server inspection.",
    ),
  }).strict().superRefine(validateRepositoryFixedPolicy).describe(
    "Effective immutable fixed repository policy with trusted checker digest.",
  );

const RepositoryProfileBaseConfigSchema = z.object({
  workflow: z.object({
    kind: z.literal("fixed").describe(
      "Fixed workflow; no toolchain discovery.",
    ),
  }).strict().describe("Workflow selection."),
  branches: z.object({
    base: z.string().min(1).max(255).describe(
      "Base branch; every profile publish must match the repository default branch, and activation/default-branch changes validate the match.",
    ),
    allowedPatterns: z.array(
      z.string().min(1).max(255).describe(
        "Branch name or glob a run may create or update.",
      ),
    ).min(1).max(32).describe("Allowed branch patterns."),
  }).strict().describe("Branch boundary."),
  worktree: z.object({
    root: z.string().min(1).max(255).regex(
      /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).*$/,
    ).describe(
      "Relative worktree root; no absolute path and no '..' segment.",
    ),
  }).strict().describe("Worktree boundary."),
}).strict().describe("Shared fixed-workflow repository profile fields.");

export const RepositoryProfileConfigSchema = RepositoryProfileBaseConfigSchema
  .extend({
    schemaVersion: z.literal(1).describe("Profile config schema version."),
    agentBindings: RepositoryAgentBindingsSchema.optional().describe(
      "Pinned agent selectors used only after an explicit step or workflow selector is absent.",
    ),
    fixedPolicy: RepositoryFixedPolicyDraftSchema.optional().describe(
      "Optional fixed policy draft; profiles without one retain the legacy onboarding contract.",
    ),
    repositoryRules: RepositoryRuleOverridesSchema.optional().describe(
      "Optional explicit repository rule overrides layered over the organization rules; absent means the repository follows the organization baseline and the profile digest is unchanged.",
    ),
  }).strict().describe("Version 1 fixed-workflow repository profile config.");

export type RepositoryProfileConfig = z.output<
  typeof RepositoryProfileConfigSchema
>;
