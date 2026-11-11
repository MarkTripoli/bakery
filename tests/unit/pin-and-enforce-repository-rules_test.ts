import { assert, assertEquals, assertRejects } from "@std/assert";
import { organizationEntries } from "../helpers/pinned-rules.ts";
import {
  EXECUTION_JOB_INPUT_BYTES_MAX,
  ORGANIZATION_RULES_MAX_BYTES,
  OrganizationRepositoryRulesSchema,
  organizationRulesBytes,
  type PinnedRepositoryRules,
  PinnedRepositoryRulesSchema,
  pinRepositoryRules,
  RepositoryRuleOverridesSchema,
  repositoryRuleStageRequirements,
  repositoryRuleStageViolations,
  type RepositoryRuleWorkflowStage,
  resolveRepositoryRules,
  STEP_OUTPUT_ALLOWANCE_BYTES,
  verifyPinnedRepositoryRules,
} from "../../packages/contracts/src/repository-rules.ts";
import { RepositoryExecutionContextSchema } from "../../packages/contracts/src/repository-inspection.ts";
import { maxPublishableConfigBytes } from "../../apps/server/src/modules/projects/inspection-budget.ts";
import { repositoryRuleWorkflowStages } from "../../apps/server/src/modules/workflows/rule-guard.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import {
  enforceWorkerFixedPolicy,
  NativeExecutorError,
} from "../../apps/worker/src/executor.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  allRuleEntries,
  baseProfileConfig,
  titleEntry,
} from "../helpers/repository-rule-entries.ts";

// SHA-256 of {"entries":[],"organizationRevision":0}, written out as a vector so
// a changed canonical form or digest input cannot silently move the baseline.
const EMPTY_BASELINE_DIGEST =
  "29b63ecc492e00756b31919bc5c780cca04a908684a519265743512a08406a1d";

/** An organization entry without its lock flag: a repository override. */
function asOverride(entry: Record<string, unknown>) {
  const { locked: _locked, ...rest } = entry;
  return rest;
}

const profile = { id: crypto.randomUUID(), revision: 4 };

function numbersEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ruleKey: "code.magicNumbers",
    enabled: true,
    mode: "require",
    options: {
      checkBinding: "magic.numbers",
      allowedNumbers: [0],
      excludedPaths: [],
    },
    locked: false,
    ...overrides,
  };
}

async function pinOf(
  organization: { revision: number; entries: unknown[] } | null,
  overrides: unknown[] = [],
): Promise<PinnedRepositoryRules> {
  return pinRepositoryRules(
    await resolveRepositoryRules(
      organization === null
        ? null
        : OrganizationRepositoryRulesSchema.parse(organization),
      RepositoryRuleOverridesSchema.parse({ entries: overrides }),
    ),
    profile,
  );
}

Deno.test("empty baseline pins revision zero, no entries and the vector digest", async () => {
  const pinned = await pinOf(null);
  assertEquals(pinned, {
    organizationRevision: 0,
    profileId: profile.id,
    profileRevision: 4,
    entries: [],
    digest: EMPTY_BASELINE_DIGEST,
  });
  assertEquals(await verifyPinnedRepositoryRules(pinned), true);
  // An organization revision with no entries is not the empty baseline.
  const published = await pinOf({ revision: 2, entries: [] });
  assertEquals(published.organizationRevision, 2);
  assert(published.digest !== EMPTY_BASELINE_DIGEST);
});

Deno.test("pin freezes organization revision, provenance and the resolver digest", async () => {
  const pinned = await pinOf({ revision: 3, entries: allRuleEntries() }, [
    asOverride(titleEntry(90)),
  ]);
  const resolved = await resolveRepositoryRules(
    OrganizationRepositoryRulesSchema.parse({
      revision: 3,
      entries: allRuleEntries(),
    }),
    RepositoryRuleOverridesSchema.parse({
      entries: [asOverride(titleEntry(90))],
    }),
  );
  assertEquals(pinned.digest, resolved.digest);
  assertEquals(pinned.organizationRevision, 3);
  assertEquals(
    pinned.entries.map(({ ruleKey, provenance }) => [ruleKey, provenance]),
    [
      ["commits.semantic", "locked_by_organization"],
      ["changeRequest.semanticTitle", "repository_override"],
      ["changeRequest.description", "inherited"],
      ["code.magicNumbers", "inherited"],
      ["code.magicStrings", "locked_by_organization"],
    ],
  );
  // Superseded overrides are history, never part of the pin.
  assertEquals("supersededOverrides" in pinned, false);
});

Deno.test("verification fails for every edit of a frozen rule or its digest", async () => {
  const pinned = await pinOf({ revision: 3, entries: allRuleEntries() });
  assertEquals(await verifyPinnedRepositoryRules(pinned), true);
  const edits: Array<(p: PinnedRepositoryRules) => PinnedRepositoryRules> = [
    (p) => ({
      ...p,
      entries: p.entries.map((entry, index) =>
        index === 0 ? { ...entry, mode: "guide" as const } : entry
      ),
    }),
    (p) => ({
      ...p,
      entries: p.entries.map((entry, index) =>
        index === 1 ? { ...entry, enabled: !entry.enabled } : entry
      ),
    }),
    (p) => ({ ...p, entries: p.entries.slice(1) }),
    (p) => ({ ...p, organizationRevision: p.organizationRevision + 1 }),
    (p) => ({ ...p, digest: EMPTY_BASELINE_DIGEST }),
    (p) => ({
      ...p,
      entries: p.entries.map((entry, index) =>
        index === 2
          ? { ...entry, provenance: "repository_only" as const }
          : entry
      ),
    }),
  ];
  for (const [index, edit] of edits.entries()) {
    assertEquals(
      await verifyPinnedRepositoryRules(edit(pinned)),
      false,
      `edit ${index}`,
    );
  }
  // The profile identity is not covered by the digest; the context refine owns it.
  assertEquals(
    await verifyPinnedRepositoryRules({ ...pinned, profileRevision: 99 }),
    true,
  );
});

Deno.test("pinned schema rejects duplicate keys, wrong order and contradictory provenance", async () => {
  const pinned = await pinOf({ revision: 3, entries: allRuleEntries() }, [
    asOverride(numbersEntry()),
  ]);
  assertEquals(PinnedRepositoryRulesSchema.safeParse(pinned).success, true);
  const [first, second, ...rest] = pinned.entries;
  assertEquals(
    PinnedRepositoryRulesSchema.safeParse({
      ...pinned,
      entries: [second, first, ...rest],
    }).success,
    false,
    "canonical order",
  );
  assertEquals(
    PinnedRepositoryRulesSchema.safeParse({
      ...pinned,
      entries: [first, first, ...rest],
    }).success,
    false,
    "duplicate key",
  );
  assertEquals(
    PinnedRepositoryRulesSchema.safeParse({
      ...pinned,
      entries: [
        { ...first, organizationRevision: 1 },
        ...pinned.entries.slice(1),
      ],
    }).success,
    false,
    "source revision differs from the pinned organization revision",
  );
  const repositoryOnly = await pinOf(null, [
    asOverride(numbersEntry()),
  ]);
  assertEquals(repositoryOnly.entries[0].provenance, "repository_only");
  assertEquals(
    PinnedRepositoryRulesSchema.safeParse({
      ...repositoryOnly,
      entries: [{ ...repositoryOnly.entries[0], organizationRevision: 1 }],
    }).success,
    false,
    "repository_only cannot name an organization revision",
  );
  assertEquals(
    PinnedRepositoryRulesSchema.safeParse({
      ...repositoryOnly,
      entries: [{ ...repositoryOnly.entries[0], provenance: "inherited" }],
    }).success,
    false,
    "inherited needs a nonzero organization revision",
  );
  assertEquals(
    PinnedRepositoryRulesSchema.safeParse({ ...pinned, extra: true }).success,
    false,
  );
  assertEquals(
    PinnedRepositoryRulesSchema.safeParse({ ...pinned, digest: "ABC" }).success,
    false,
  );
});

async function context(
  rules?: PinnedRepositoryRules,
  overrides: Record<string, unknown> = {},
) {
  const config = { ...baseProfileConfig };
  return {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    id: profile.id,
    revision: profile.revision,
    digest: await sha256Hex(canonicalJson(config)),
    config,
    observationId: null,
    observationDigest: null,
    baseSha: null,
    ...(rules === undefined ? {} : { repositoryRules: rules }),
    ...overrides,
  };
}

Deno.test("execution context carries pinned rules only for its own profile", async () => {
  const pinned = await pinOf(null);
  assertEquals(
    RepositoryExecutionContextSchema.safeParse(await context()).success,
    true,
    "snapshots admitted before pinning stay readable",
  );
  assertEquals(
    RepositoryExecutionContextSchema.safeParse(await context(pinned)).success,
    true,
  );
  assertEquals(
    RepositoryExecutionContextSchema.safeParse(
      await context({ ...pinned, profileId: crypto.randomUUID() }),
    ).success,
    false,
    "another profile id",
  );
  assertEquals(
    RepositoryExecutionContextSchema.safeParse(
      await context({ ...pinned, profileRevision: 5 }),
    ).success,
    false,
    "another profile revision",
  );
  assertEquals(
    RepositoryExecutionContextSchema.safeParse(
      await context(pinned, { repositoryRules: { ...pinned, extra: 1 } }),
    ).success,
    false,
  );
});

Deno.test("only enabled require rules bound to a command need a stage", () => {
  const rule = (extra: Record<string, unknown>) =>
    repositoryRuleStageRequirements({
      entries: organizationEntries([numbersEntry(extra)]),
    });
  assertEquals(rule({}), [{
    ruleKey: "code.magicNumbers",
    commandId: "magic.numbers",
  }]);
  assertEquals(rule({ mode: "warn" }), []);
  assertEquals(rule({ mode: "guide" }), []);
  assertEquals(rule({ enabled: false }), []);
  assertEquals(
    rule({
      options: { checkBinding: null, allowedNumbers: [], excludedPaths: [] },
    }),
    [],
  );
  // Rules without a checker binding never bind a stage.
  assertEquals(
    repositoryRuleStageRequirements({
      entries: organizationEntries([{ ...titleEntry(), mode: "require" }]),
    }),
    [],
  );
  assertEquals(repositoryRuleStageRequirements(null), []);
  assertEquals(
    repositoryRuleStageRequirements({ entries: [] }),
    [],
  );
  // Requirements follow canonical rule-key order whatever the stored order.
  const both = repositoryRuleStageRequirements({
    entries: organizationEntries([
      {
        ruleKey: "code.magicStrings",
        enabled: true,
        mode: "require",
        options: {
          checkBinding: "magic.strings",
          allowedLiterals: [],
          excludedPaths: [],
        },
        locked: false,
      },
      numbersEntry(),
    ]),
  });
  assertEquals(both.map(({ ruleKey }) => ruleKey), [
    "code.magicNumbers",
    "code.magicStrings",
  ]);
});

const check = (...ids: string[]): RepositoryRuleWorkflowStage => ({
  checks: ids,
  producesRevision: false,
});
const implement: RepositoryRuleWorkflowStage = {
  checks: [],
  producesRevision: true,
};
const other: RepositoryRuleWorkflowStage = {
  checks: [],
  producesRevision: false,
};
const needsNumbers = [{
  ruleKey: "code.magicNumbers" as const,
  commandId: "magic.numbers",
}];

Deno.test("a required check must exist and run after the last revision-producing stage", () => {
  assertEquals(
    repositoryRuleStageViolations(needsNumbers, [
      implement,
      check("magic.numbers"),
    ]),
    [],
  );
  assertEquals(
    repositoryRuleStageViolations(needsNumbers, [implement, other]),
    [
      { ...needsNumbers[0], reason: "stage_missing" },
    ],
  );
  // No revision-producing stage: nothing to check, so the workflow is not
  // bound (noop, freeform and cloud-only workflows).
  assertEquals(repositoryRuleStageViolations(needsNumbers, []), []);
  assertEquals(repositoryRuleStageViolations(needsNumbers, [other]), []);
  // Reordered ahead of the implementation it must validate.
  assertEquals(
    repositoryRuleStageViolations(needsNumbers, [
      check("magic.numbers"),
      implement,
    ]),
    [
      { ...needsNumbers[0], reason: "stage_before_revision" },
    ],
  );
  // A repair after the only check leaves the final revision unchecked.
  assertEquals(
    repositoryRuleStageViolations(needsNumbers, [
      implement,
      check("magic.numbers"),
      implement,
    ]),
    [{ ...needsNumbers[0], reason: "stage_before_revision" }],
  );
  // Checking again after the last repair satisfies it.
  assertEquals(
    repositoryRuleStageViolations(needsNumbers, [
      implement,
      check("magic.numbers"),
      implement,
      check("magic.numbers"),
    ]),
    [],
  );
  // Without any revision-producing stage the check is not required at all.
  assertEquals(
    repositoryRuleStageViolations(needsNumbers, [
      other,
      check("magic.numbers"),
    ]),
    [],
  );
  assertEquals(
    repositoryRuleStageViolations(needsNumbers, [
      check("magic.numbers"),
      other,
    ]),
    [],
  );
  // A different command does not satisfy the rule; extra commands do not hurt.
  assertEquals(
    repositoryRuleStageViolations(needsNumbers, [implement, check("lint")]),
    [
      { ...needsNumbers[0], reason: "stage_missing" },
    ],
  );
  assertEquals(
    repositoryRuleStageViolations(needsNumbers, [
      implement,
      check("lint", "magic.numbers"),
    ]),
    [],
  );
  assertEquals(repositoryRuleStageViolations([], [implement]), []);
  // Every unsatisfied requirement is reported, in requirement order.
  const two = [
    ...needsNumbers,
    { ruleKey: "code.magicStrings" as const, commandId: "magic.strings" },
  ];
  assertEquals(
    repositoryRuleStageViolations(two, [implement]).map(({ ruleKey }) =>
      ruleKey
    ),
    ["code.magicNumbers", "code.magicStrings"],
  );
});

async function assignmentWithRules(
  mutate: (rules: PinnedRepositoryRules) => PinnedRepositoryRules,
): Promise<JobAssignment> {
  const rules = mutate(
    await pinOf({ revision: 3, entries: allRuleEntries() }),
  );
  const value = await context(rules);
  return {
    action: "quality.check",
    input: { checks: ["lint"], repositoryProfile: value },
  } as unknown as JobAssignment;
}

Deno.test("worker verifies the pinned rules digest before any other policy", async () => {
  await enforceWorkerFixedPolicy(await assignmentWithRules((rules) => rules));
  const tampered: Array<
    (rules: PinnedRepositoryRules) => PinnedRepositoryRules
  > = [
    (rules) => ({
      ...rules,
      entries: rules.entries.map((entry, index) =>
        index === 0 ? { ...entry, mode: "guide" as const } : entry
      ),
    }),
    (rules) => ({ ...rules, digest: EMPTY_BASELINE_DIGEST }),
    (rules) => ({ ...rules, organizationRevision: 9 }),
    (rules) => ({ ...rules, entries: [] }),
  ];
  for (const [index, mutate] of tampered.entries()) {
    await assertRejects(
      async () =>
        await enforceWorkerFixedPolicy(await assignmentWithRules(mutate)),
      NativeExecutorError,
      "FIXED_REPOSITORY_POLICY_REJECTED",
      `tamper ${index}`,
    );
  }
  // A structurally invalid pin is rejected by the context parse.
  await assertRejects(
    async () =>
      await enforceWorkerFixedPolicy(
        await assignmentWithRules((rules) => ({
          ...rules,
          profileId: crypto.randomUUID(),
        })),
      ),
    NativeExecutorError,
    "FIXED_REPOSITORY_POLICY_REJECTED",
  );
});

Deno.test("the command match is exact: no prefix, suffix, substring or case folding", () => {
  for (
    const near of [
      "magic",
      "magic.numbers.x",
      "x.magic.numbers",
      "MAGIC.NUMBERS",
      "Magic.Numbers",
      "magic.numbers ",
    ]
  ) {
    assertEquals(
      repositoryRuleStageViolations(needsNumbers, [implement, check(near)]),
      [{ ...needsNumbers[0], reason: "stage_missing" }],
      near,
    );
  }
});

Deno.test("the stage mapping treats repair like implement and reads only literal checks", () => {
  const stages = repositoryRuleWorkflowStages([
    { action: "harness.implement", input: {} },
    { action: "harness.repair", input: {} },
    { action: "quality.check", input: { checks: ["a", "b"] } },
    { action: "quality.check", input: { checks: "$input.checks" } },
    { action: "quality.check", input: { checks: ["a", 3] } },
    { action: "quality.check", input: null },
    { action: "agent.freeform", input: { checks: ["a"] } },
    { action: "workflow.noop", input: {} },
    { action: "task.brief", input: {} },
  ]);
  assertEquals(stages, [
    { checks: [], producesRevision: true },
    { checks: [], producesRevision: true },
    { checks: ["a", "b"], producesRevision: false },
    { checks: [], producesRevision: false },
    { checks: [], producesRevision: false },
    { checks: [], producesRevision: false },
    { checks: [], producesRevision: false },
    { checks: [], producesRevision: false },
    { checks: [], producesRevision: false },
  ]);
  // implement -> check -> repair is refused; implement -> repair -> check is not.
  const need = needsNumbers;
  const run = (actions: Array<[string, unknown]>) =>
    repositoryRuleStageViolations(
      need,
      repositoryRuleWorkflowStages(
        actions.map(([action, input]) => ({ action, input })),
      ),
    );
  const checks = { checks: ["magic.numbers"] };
  assertEquals(
    run([
      ["harness.implement", {}],
      ["quality.check", checks],
      ["harness.repair", {}],
    ]),
    [{ ...need[0], reason: "stage_before_revision" }],
  );
  assertEquals(
    run([
      ["harness.implement", {}],
      ["harness.repair", {}],
      ["quality.check", checks],
    ]),
    [],
  );
  // Freeform and noop workflows are never bound.
  assertEquals(run([["workflow.noop", {}], ["agent.freeform", {}]]), []);
});

Deno.test("pinned effective entries bind like organization entries", async () => {
  const pinned = await pinOf({ revision: 3, entries: [numbersEntry()] }, [
    asOverride(numbersEntry({ mode: "warn" })),
  ]);
  // The repository override weakens the unlocked rule to warn: nothing binds.
  assertEquals(repositoryRuleStageRequirements(pinned), []);
  const locked = await pinOf(
    { revision: 3, entries: [numbersEntry({ locked: true })] },
    [asOverride(numbersEntry({ mode: "warn" }))],
  );
  assertEquals(repositoryRuleStageRequirements(locked), [{
    ruleKey: "code.magicNumbers",
    commandId: "magic.numbers",
  }]);
  assertEquals(
    repositoryRuleStageRequirements(await pinOf(null)),
    [],
  );
});

Deno.test("the organization rules ceiling leaves the rest of the job input room", () => {
  // Worst realistic job input for a step: the profile config carrying
  // overrides at their publish cap, the pin (ceiling-sized organization
  // entries plus the same overrides, with provenance on every entry), and the
  // allowance for identifiers taken from earlier step outputs.
  const overridesCap = maxPublishableConfigBytes();
  const provenanceOverhead = 5 * 200;
  const worstPin = ORGANIZATION_RULES_MAX_BYTES + overridesCap +
    provenanceOverhead;
  const used = worstPin + overridesCap + STEP_OUTPUT_ALLOWANCE_BYTES;
  const rest = EXECUTION_JOB_INPUT_BYTES_MAX - used;
  assert(rest >= 30_000, `only ${rest} bytes left for the rest of the input`);
  assertEquals(EXECUTION_JOB_INPUT_BYTES_MAX, 100_000);
  // The cap behind the ceiling is the schema-derived publish bound, not a
  // remembered number: it must stay in the range the margin above assumes.
  assert(overridesCap > 10_000 && overridesCap < 20_000, String(overridesCap));
});

Deno.test("a conditional check stage is mapped as satisfying nothing; delivery order is not enforced", () => {
  const stages = repositoryRuleWorkflowStages([
    { action: "quality.check", input: { checks: ["a"] }, condition: "x" },
    { action: "quality.check", input: { checks: ["a"] } },
  ]);
  assertEquals(stages.map((stage) => stage.checks), [[], ["a"]]);
  // The design gives no ordering between a code check and delivery stages, so
  // a check after delivery.merge is accepted (documented in chapter 22).
  const need = [{ ruleKey: "code.magicNumbers" as const, commandId: "a" }];
  assertEquals(
    repositoryRuleStageViolations(
      need,
      repositoryRuleWorkflowStages([
        { action: "harness.implement", input: {} },
        { action: "delivery.merge", input: {} },
        { action: "quality.check", input: { checks: ["a"] } },
      ]),
    ),
    [],
  );
});

Deno.test("organization rule size is measured in UTF-8 bytes of the canonical entries", () => {
  const entry = (template: string) => ({
    ruleKey: "changeRequest.description" as const,
    enabled: true,
    mode: "guide" as const,
    options: { template, requiredSections: [] },
    locked: false,
  });
  const ascii = organizationRulesBytes([entry("a".repeat(100))]);
  const cjk = organizationRulesBytes([entry("径".repeat(100))]);
  const control = organizationRulesBytes([entry("\u0001".repeat(100))]);
  // 3 bytes per CJK character; a control character escapes to 6 bytes.
  assertEquals(cjk - ascii, 200);
  assertEquals(control - ascii, 500);
});
