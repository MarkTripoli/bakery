import { z } from "zod";

/**
 * Slice A of the one-engine design (chapter 25 §15.1, O23): the kernel is
 * domain-neutral. A run needs exactly the workspaces its steps declare, which
 * may be none; work type is an organization label the kernel never branches on;
 * step defaults come from a scope profile at project level, of which a
 * repository profile is the code form.
 *
 * Nothing in this module knows what git is. The four software-delivery work
 * types stay valid labels because organizations use them today, not because the
 * kernel reads them.
 */

/** Longest accepted work type label; bounds the stored text column. */
export const WORK_TYPE_LABEL_MAX_LENGTH = 40;

/**
 * Lowercase kebab-case token. Shared by work type labels and workspace aliases
 * so both are stable identifiers rather than free display text.
 */
const LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const labelSchema = (what: string) =>
  z.string().min(1).max(WORK_TYPE_LABEL_MAX_LENGTH).regex(LABEL_PATTERN, {
    message: `A ${what} is a lowercase kebab-case token.`,
  }).describe(
    `Organization ${what} naming this kind of work or workspace, one to ${WORK_TYPE_LABEL_MAX_LENGTH} characters of lowercase letters, digits and single hyphens.`,
  );

/**
 * Work type as an organization label (O23). The kernel never branches on the
 * value: it is carried on the work item and shown to people. The four
 * software-delivery labels are defaults a pack can create, not a closed set.
 */
export function isWorkTypeLabel(value: unknown): value is string {
  return typeof value === "string" && labelSchema("work type").safeParse(value)
    .success;
}

/** Access a step asks for on a workspace mount. */
export const WORKSPACE_ACCESS = Object.freeze(["read", "write"] as const);
export type WorkspaceAccess = typeof WORKSPACE_ACCESS[number];

/**
 * One `workspace: {name, access}` declaration on a step. A name is an alias the
 * workflow uses; the workspace kind behind the alias is the pack's business.
 */
export const StepWorkspaceDeclarationSchema = z.object({
  name: labelSchema("workspace name"),
  access: z.enum(WORKSPACE_ACCESS).describe(
    "Whether the step reads the workspace only or may change it; a write mount is what makes the step a writer for the one-writer rule.",
  ),
}).strict().describe(
  "One workspace a step declares: the alias it refers to and whether the step reads or writes it.",
);
export type StepWorkspaceDeclaration = z.output<
  typeof StepWorkspaceDeclarationSchema
>;

/** Why a run needs a workspace, or does not. */
export const WORKSPACE_REQUIREMENT_REASONS = Object.freeze(
  [
    "no_step_declares_a_workspace",
    "a_step_requires_a_workspace",
  ] as const,
);
export type WorkspaceRequirementReason =
  typeof WORKSPACE_REQUIREMENT_REASONS[number];

export type WorkspaceRequirement = {
  required: boolean;
  workspaces: StepWorkspaceDeclaration[];
  reason: WorkspaceRequirementReason;
};

/**
 * What a pack knows about one step that the kernel does not. The software
 * delivery pack answers true for a step whose action or inputs touch a
 * repository; the kernel never learns why. It is called once per step the
 * traversal visits, nested ones included, and may throw to refuse a step whose
 * shape it cannot read.
 */
export type StepWorkspacePredicate = (step: Record<string, unknown>) => boolean;

export type WorkspaceRequirementOptions = {
  readonly stepRequiresWorkspace?: StepWorkspacePredicate;
};

/** Thrown when a step's workspace declaration cannot be read. */
export class WorkspaceDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceDeclarationError";
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The keys whose value is a sequence of nested steps. Mirrors the shapes the
// interpreter accepts so a workspace hidden in a branch, loop or parallel is
// still found.
const NESTED_STEP_KEYS = [
  "steps",
  "then",
  "else",
  "parallel",
] as const;

const asSequence = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : record(value) ? [value] : [];

/**
 * Child step sequences of the container shapes the compiler grammar uses:
 * `branch: {then, else}`, `repeat: {steps, seed: {steps}}`,
 * `forEach: {steps}` and `parallel: {branches: [{steps}]}`.
 */
function containerSequences(step: Record<string, unknown>): unknown[][] {
  const sequences: unknown[][] = [];
  const branch = step.branch;
  if (record(branch)) {
    sequences.push([...asSequence(branch.then)], [...asSequence(branch.else)]);
  }
  const repeat = step.repeat;
  if (record(repeat)) {
    sequences.push([...asSequence(repeat.steps)]);
    if (record(repeat.seed)) sequences.push([...asSequence(repeat.seed.steps)]);
  }
  const loop = step.forEach;
  if (record(loop)) sequences.push([...asSequence(loop.steps)]);
  const parallel = step.parallel;
  if (record(parallel) && Array.isArray(parallel.branches)) {
    for (const lane of parallel.branches) {
      if (record(lane)) sequences.push([...asSequence(lane.steps)]);
    }
  }
  return sequences;
}

function collectWorkspaceDeclarations(
  step: unknown,
  into: Map<string, WorkspaceAccess>,
  options: WorkspaceRequirementOptions,
): boolean {
  if (!record(step)) return false;
  let required = options.stepRequiresWorkspace?.(step) ?? false;

  const requires = step.requires;
  if (requires !== undefined) {
    if (!Array.isArray(requires)) {
      throw new WorkspaceDeclarationError(
        "A step's requires must be a list of capability names.",
      );
    }
    for (const requirement of requires) {
      if (typeof requirement !== "string") {
        throw new WorkspaceDeclarationError(
          "A step's requires must be a list of capability names.",
        );
      }
      // `git` is the software-delivery pack's capability name for "this step
      // touches a workspace". It stays a plain string here: the kernel does not
      // import the pack, it only sees a step that needs a workspace.
      if (requirement.trim() === "git") required = true;
    }
  }

  if (step.workspace !== undefined) {
    const parsed = StepWorkspaceDeclarationSchema.safeParse(step.workspace);
    if (!parsed.success) {
      throw new WorkspaceDeclarationError(
        `A step's workspace declaration is invalid: ${
          parsed.error.issues.map((issue) => issue.message).join(" ")
        }`,
      );
    }
    const previous = into.get(parsed.data.name);
    // A name mounted writable anywhere is writable: the run carries the mount
    // the writer needs, and the one-writer rule reads the access from here.
    into.set(
      parsed.data.name,
      previous === "write" || parsed.data.access === "write" ? "write" : "read",
    );
    required = true;
  }

  for (const key of NESTED_STEP_KEYS) {
    const nested = step[key];
    if (nested === undefined) continue;
    // A `parallel` object is a container with lanes, not a step: its lanes
    // are walked below with the other container shapes.
    if (key === "parallel" && !Array.isArray(nested)) continue;
    const sequence = Array.isArray(nested)
      ? nested
      : record(nested)
      ? [nested]
      : undefined;
    if (sequence === undefined) continue;
    for (const child of sequence) {
      if (collectWorkspaceDeclarations(child, into, options)) required = true;
    }
  }
  for (const sequence of containerSequences(step)) {
    for (const child of sequence) {
      if (collectWorkspaceDeclarations(child, into, options)) required = true;
    }
  }

  return required;
}

/**
 * Derives the workspace requirement from the steps (O23). A run needs exactly
 * the workspaces its steps declare. An empty answer is legitimate and common:
 * many non-code factories route tool calls and named documents only.
 *
 * Nested steps are inspected, so a workspace inside a branch, loop or parallel
 * is not missed. A declaration that cannot be read is refused rather than
 * skipped, because silently dropping it would admit a run with a mount a step
 * expects.
 *
 * A pack adds what it knows through `stepRequiresWorkspace`; the software
 * delivery pack's repository rules reach admission that way, so there is one
 * derivation rather than a kernel answer and a pack answer to reconcile.
 */
export function deriveWorkspaceRequirement(
  steps: readonly unknown[],
  options: WorkspaceRequirementOptions = {},
): WorkspaceRequirement {
  const declared = new Map<string, WorkspaceAccess>();
  let required = false;
  for (const step of steps) {
    if (collectWorkspaceDeclarations(step, declared, options)) required = true;
  }
  const workspaces = [...declared.entries()]
    .map(([name, access]) => ({ name, access }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    required,
    workspaces,
    reason: required
      ? "a_step_requires_a_workspace"
      : "no_step_declares_a_workspace",
  };
}

/**
 * One check command a scope profile supplies as a step default. Ids are stable
 * so a run's evidence can be attributed to the command that produced it.
 */
export const ScopeProfileCheckCommandSchema = z.object({
  id: labelSchema("check id"),
  command: z.string().min(1).max(2000).describe(
    "Shell command text the check runs; policy belongs to the profile, so the kernel never interprets it.",
  ),
}).strict().describe(
  "One check command a project's scope profile supplies to steps as a default.",
);
export type ScopeProfileCheckCommand = z.output<
  typeof ScopeProfileCheckCommandSchema
>;

/**
 * A published project scope profile. A repository profile is this same shape
 * with the code fields filled in, which is why the kernel can carry the scope
 * without knowing about repositories.
 */
export const ScopeProfileSchema = z.object({
  revision: z.number().int().min(0).describe(
    "Published revision of the profile; 0 is the empty baseline every project starts from.",
  ),
  digest: z.string().regex(/^[a-f0-9]{64}$/).describe(
    "SHA-256 hex of the canonical profile content, so a run can pin exactly the defaults it used.",
  ),
  checkCommands: z.array(ScopeProfileCheckCommandSchema).max(64).describe(
    "Check commands offered to steps as defaults, in profile order.",
  ),
  rules: z.array(
    z.unknown().describe(
      "One rule entry the profile publishes; the rule library, not the kernel, gives it meaning.",
    ),
  ).describe(
    "Rule entries the profile supplies; their shape belongs to the rule library, not the kernel.",
  ),
}).strict().describe(
  "One published project scope profile: the step defaults a run inherits.",
);
export type ScopeProfile = z.output<typeof ScopeProfileSchema>;

export type ScopeProfileResolutionInput = {
  organizationId: string;
  applicationId: string | null;
  profile:
    | (ScopeProfile & { applicationId?: string })
    | null;
};

export type ScopeProfileDefaults = {
  revision: number;
  digest: string;
  checkCommands: ScopeProfileCheckCommand[];
  rules: unknown[];
};

/** Thrown when a scope profile cannot be used for the project asking for it. */
export class ScopeProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeProfileError";
  }
}

/**
 * Resolves the defaults a run inherits from its project's scope profile.
 *
 * An absent profile resolves to the empty baseline rather than an error: a
 * project starts with no published defaults, and a run must still be admitted
 * without them. A profile belonging to another project is refused, because
 * defaults are project authority and must not cross a project boundary.
 */
export function resolveScopeProfileDefaults(
  input: ScopeProfileResolutionInput,
): ScopeProfileDefaults {
  if (input.profile === null) {
    return { revision: 0, digest: "", checkCommands: [], rules: [] };
  }
  // The owner is checked below, not by the content schema: a stored profile
  // names its project, and that key is not part of the published content.
  const { applicationId: owner, ...content } = input.profile;
  const parsed = ScopeProfileSchema.safeParse(content);
  if (!parsed.success) {
    throw new ScopeProfileError(
      `The project's scope profile is invalid: ${
        parsed.error.issues.map((issue) => issue.message).join(" ")
      }`,
    );
  }
  if (owner !== undefined && owner !== input.applicationId) {
    throw new ScopeProfileError(
      "A scope profile may only supply defaults to the project that published it.",
    );
  }
  return {
    revision: parsed.data.revision,
    digest: parsed.data.digest,
    checkCommands: parsed.data.checkCommands,
    rules: parsed.data.rules,
  };
}
