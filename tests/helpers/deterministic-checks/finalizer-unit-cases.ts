import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { planChecks } from "../../../apps/worker/src/check-runner.ts";
import {
  enforceWorkerFixedPolicy,
  NativeExecutorError,
} from "../../../apps/worker/src/executor.ts";
import type { JobAssignment } from "../../../apps/worker/src/types.ts";
import {
  CHECK_OBSERVATION_MAX_ITEMS,
  deriveCheckVerdict,
} from "../../../packages/contracts/src/check-evidence.ts";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  type AdmittedRepositoryProfile,
  enforceRepositoryFixedPolicy,
} from "../../../packages/persistence/src/repository-admission.ts";
import {
  boundRuleEntries,
  deriveCheckPins,
} from "../../../apps/server/src/modules/delivery/check-pins.ts";
import {
  expectedVerdict,
  parseCheckReport,
  verifyCheckReport,
} from "../../../apps/server/src/modules/delivery/check-report.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import {
  AMBIGUOUS_SCENARIO,
  COHERENCE_FORGERIES,
  ECHO_FORGERIES,
  EVIDENCE_FORGERIES,
  type Forgery,
  MAGIC,
  RULE_SCENARIO,
  SELECTION_FORGERIES,
} from "./finalizer-forgeries.ts";
import {
  type CheckCommand,
  DEFAULT_COMMANDS,
  type EvidenceRef,
  type ExecutionContext,
  fixedPolicyContext,
  observationFor,
  type Outcome,
  type PolicyOptions,
  reportFrom,
} from "./finalizer-policy.ts";
import { magicRuleEntry } from "./identity-fixture.ts";
import { BASE_SHA, HEAD_SHA } from "./observations.ts";

/**
 * Pure cases for the `quality.check` finalizer: the pins derived from a job's
 * stored input, the report verification, and the admission rules both sides
 * share. The same forged reports the security lane posts through the route
 * are replayed here against `verifyCheckReport`, so a drift between the two
 * layers fails in the fast lane first.
 */

const WINDOW_MS = 3_600_000;
const IDENTITY = {
  organizationId: crypto.randomUUID(),
  applicationId: crypto.randomUUID(),
  repositoryId: crypto.randomUUID(),
  id: crypto.randomUUID(),
  revision: 2,
};

async function jobInput(
  options: PolicyOptions = {},
  checks?: string[],
  revision = HEAD_SHA,
) {
  const commands = options.commands ?? DEFAULT_COMMANDS;
  return {
    repositoryId: IDENTITY.repositoryId,
    revision,
    checks: checks ?? commands.map(({ id }) => id),
    repositoryProfile: await fixedPolicyContext(IDENTITY, options),
  };
}

async function fakeEvidence(): Promise<EvidenceRef> {
  return {
    artifactId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    sha256: await sha256Hex(crypto.randomUUID()),
  };
}

async function honestReport(
  options: PolicyOptions,
  outcomes: Record<string, Outcome> = {},
) {
  const pins = await deriveCheckPins(await jobInput(options));
  const observations = [];
  for (const pin of pins.commands) {
    observations.push(
      observationFor(
        pin,
        outcomes[pin.checkId] ?? "pass",
        await fakeEvidence(),
      ),
    );
  }
  return { pins, report: reportFrom(pins, observations) };
}

function rejectionOf(work: () => void) {
  try {
    work();
  } catch (error) {
    assert(error instanceof StandardError, String(error));
    return { code: error.code, reason: error.params?.reason };
  }
  return null;
}

const verify = (
  report: unknown,
  pins: Awaited<ReturnType<typeof deriveCheckPins>>,
  window = WINDOW_MS,
) => verifyCheckReport(parseCheckReport(report), pins, window);

function assertForgeriesRefused(cases: readonly Forgery[]) {
  return async () => {
    for (const entry of cases) {
      const options = entry.options ?? {};
      const { pins, report } = await honestReport(
        options,
        entry.outcomes ?? {},
      );
      const forged = entry.forge({ report });
      const refusal = rejectionOf(() => verify(forged, pins));
      assertEquals(
        [refusal?.code, refusal?.reason],
        [entry.expected.code, entry.expected.reason],
        entry.name,
      );
    }
  };
}

const sha = (value: unknown) => sha256Hex(canonicalJson(value));

function admittedProfile(context: ExecutionContext): AdmittedRepositoryProfile {
  return {
    repositoryProfileId: context.id,
    repositoryProfileRevision: context.revision,
    repositoryProfileDigest: context.digest,
    observationId: context.observationId,
    observationDigest: context.observationDigest,
    baseSha: context.baseSha,
    config: context.config,
  };
}

/** The server and the worker admission of `quality.check` input, patched per case. */
function admissions(
  profile: AdmittedRepositoryProfile,
  input: Record<string, unknown>,
) {
  return {
    admit: (patch: Record<string, unknown>) => {
      enforceRepositoryFixedPolicy(profile, "quality.check", {
        ...input,
        ...patch,
      });
    },
    workerAdmit: (patch: Record<string, unknown>) =>
      enforceWorkerFixedPolicy({
        action: "quality.check",
        input: { ...input, ...patch },
      } as unknown as JobAssignment),
  };
}

export function registerFinalizerUnitCases(): void {
  Deno.test("pins derive from the stored job exactly as an independent computation does", async () => {
    const plain = await deriveCheckPins(await jobInput({}, ["unit", "format"]));
    const context = (await jobInput()).repositoryProfile;
    const fixedPolicy = (context.config as {
      fixedPolicy: { commands: Array<{ id: string; argv: string[] }> };
    }).fixedPolicy;
    assertEquals(plain.headSha, HEAD_SHA);
    assertEquals(plain.baseSha, BASE_SHA);
    assertEquals(plain.profileDigest, context.digest);
    assertEquals(plain.checkerDigest, context.trustedCheckerConfigDigest);
    assertEquals(plain.checks, ["unit", "format"]);
    assertEquals(
      plain.policyDigest,
      await sha({
        fixedPolicyDigest: context.fixedPolicyDigest,
        trustedCheckerConfigDigest: context.trustedCheckerConfigDigest,
        entriesDigest: await sha([]),
      }),
    );
    assertEquals(
      plain.commands.map((pin) => pin.subjectDigest),
      await Promise.all(
        ["unit", "format"].map((id) =>
          sha({
            command: {
              id,
              argv: fixedPolicy.commands.find((command) => command.id === id)!
                .argv,
            },
            ruleEntryDigest: null,
          })
        ),
      ),
    );

    // A bound rule enters the command's subject and the policy digest; its
    // provenance and organization revision do not.
    const bound = await deriveCheckPins(
      await jobInput({ ...RULE_SCENARIO, rulesRevision: 5 }),
    );
    const entry = (await jobInput({ ...RULE_SCENARIO })).repositoryProfile
      .repositoryRules!.entries[0]!;
    const {
      provenance: _provenance,
      organizationRevision: _revision,
      ...rule
    } = entry as Record<string, unknown>;
    const numbers = bound.commands.at(-1)!;
    assertEquals(numbers.ruleKey, "code.magicNumbers");
    assertEquals(
      numbers.subjectDigest,
      await sha({
        command: { id: "magic.numbers", argv: ["deno", "lint"] },
        ruleEntryDigest: await sha(rule),
      }),
    );
    const sameEntries = await deriveCheckPins(
      await jobInput({ ...RULE_SCENARIO, rulesRevision: 9 }),
    );
    assertEquals(sameEntries.policyDigest, bound.policyDigest);
    assertEquals(
      sameEntries.commands.map((pin) => pin.subjectDigest),
      bound.commands.map((pin) => pin.subjectDigest),
    );
    assert(bound.policyDigest !== plain.policyDigest);
  });

  Deno.test("pins refuse every job input admission would not have produced", async () => {
    const good = await jobInput();
    const withContext = (patch: Record<string, unknown>) => ({
      ...good,
      repositoryProfile: { ...good.repositoryProfile, ...patch },
    });
    const withRules = await jobInput(RULE_SCENARIO);
    const refusals: Array<[string, unknown]> = [
      ["not an object", "input"],
      ["an array", []],
      ["no profile", { ...good, repositoryProfile: undefined }],
      ["a null profile", { ...good, repositoryProfile: null }],
      [
        "a profile digest that differs",
        withContext({ digest: "d".repeat(64) }),
      ],
      [
        "a fixed policy digest that differs",
        withContext({ fixedPolicyDigest: "d".repeat(64) }),
      ],
      [
        "a trusted checker digest that differs",
        withContext({ trustedCheckerConfigDigest: "d".repeat(64) }),
      ],
      ["no inspected base", withContext({ baseSha: null })],
      [
        "pinned rules edited",
        {
          ...withRules,
          repositoryProfile: {
            ...withRules.repositoryProfile,
            repositoryRules: {
              ...withRules.repositoryProfile.repositoryRules,
              entries: withRules.repositoryProfile.repositoryRules!.entries.map(
                (
                  entry,
                ) => ({ ...entry, mode: "guide" }),
              ),
            },
          },
        },
      ],
      ["a branch name", { ...good, revision: "main" }],
      ["an upper-case revision", { ...good, revision: "A".repeat(40) }],
      ["a short revision", { ...good, revision: "1".repeat(39) }],
      ["a long revision", { ...good, revision: "1".repeat(41) }],
      ["no revision", { ...good, revision: undefined }],
      ["no checks", { ...good, checks: [] }],
      ["checks that are not strings", { ...good, checks: [1] }],
      ["a repeated check", { ...good, checks: ["unit", "unit"] }],
      ["a check outside the policy", { ...good, checks: ["unit", "deploy"] }],
    ];
    for (const [name, input] of refusals) {
      const error = await assertRejects(
        () => deriveCheckPins(input),
        StandardError,
        undefined,
        name,
      );
      assertEquals(
        [error.code, error.params?.reason],
        ["VALIDATION_FAILED", "check_policy_missing"],
        name,
      );
    }
    // The strict-v1 profile a fixture can claim carries no fixed policy.
    const v1 = {
      ...good,
      repositoryProfile: {
        ...IDENTITY,
        digest: "a".repeat(64),
        config: {
          schemaVersion: 1,
          workflow: { kind: "fixed" },
          branches: { base: "main", allowedPatterns: ["feature/*"] },
          worktree: { root: ".bakery/worktrees" },
        },
        observationId: null,
        observationDigest: null,
        baseSha: null,
      },
    };
    await assertRejects(() => deriveCheckPins(v1), StandardError);
  });

  Deno.test("the worker and the server agree on which rule binds a command", async () => {
    const cases: Array<[string, PolicyOptions]> = [
      ["no rule", {}],
      ["one rule", RULE_SCENARIO],
      ["two rules", AMBIGUOUS_SCENARIO],
      [
        "a disabled rule",
        {
          commands: MAGIC,
          rules: [
            magicRuleEntry(
              "code.magicNumbers",
              "magic.numbers",
              "require",
              false,
            ),
          ],
        },
      ],
      [
        "an unbound rule",
        { commands: MAGIC, rules: [magicRuleEntry("code.magicNumbers", null)] },
      ],
      [
        "a rule bound to another command",
        {
          commands: MAGIC,
          rules: [magicRuleEntry("code.magicStrings", "unit")],
        },
      ],
    ];
    for (const [name, options] of cases) {
      const input = await jobInput(options);
      const pins = await deriveCheckPins(input);
      const context = input.repositoryProfile;
      const policy = (context.config as {
        fixedPolicy: Parameters<typeof planChecks>[0];
      }).fixedPolicy;
      const plan = planChecks(policy, context.repositoryRules, input.checks);
      assertEquals(
        pins.commands.map((pin) => [pin.checkId, pin.ruleKey, pin.ambiguous]),
        plan.map((planned) => [
          planned.checkId,
          planned.ruleKey,
          planned.unavailable === "rule_binding_ambiguous",
        ]),
        name,
      );
      for (const pin of pins.commands) {
        assertEquals(
          boundRuleEntries(context.repositoryRules?.entries ?? [], pin.checkId)
            .length > 1,
          pin.ambiguous,
          name,
        );
      }
    }
  });

  Deno.test("an honest report passes verification for every outcome a command can have", async () => {
    const outcomes: Outcome[] = [
      "pass",
      "fail",
      "signal",
      "deadline",
      "output_limit",
      "tool_missing",
      "skipped",
    ];
    for (const outcome of outcomes) {
      const { pins, report } = await honestReport({}, { unit: outcome });
      verify(report, pins);
    }
    const bound = await honestReport(RULE_SCENARIO, {
      "magic.numbers": "unsupported_checker",
    });
    verify(bound.report, bound.pins);
    const ambiguous = await honestReport(AMBIGUOUS_SCENARIO, {
      "magic.shared": "ambiguous",
    });
    verify(ambiguous.report, ambiguous.pins);
  });

  Deno.test("an unreachable revision is the reason of every command, one with two bound rules included", async () => {
    const scenarios: Array<[string, PolicyOptions]> = [
      ["no rule", {}],
      ["one bound rule", RULE_SCENARIO],
      ["two bound rules", AMBIGUOUS_SCENARIO],
    ];
    for (const [name, options] of scenarios) {
      const commands = options.commands ?? DEFAULT_COMMANDS;
      const unreachable = Object.fromEntries(
        commands.map(({ id }) => [id, "revision_unavailable" as const]),
      );
      const { pins, report } = await honestReport(options, unreachable);
      assertEquals(
        report.observations.map(({ reason }) => reason),
        commands.map(() => "revision_unavailable"),
        name,
      );
      // The rule key stays the pin's, which is null for the command two rules
      // bind: the unreachable revision replaces only the reason.
      assertEquals(
        report.observations.map(({ ruleKey }) => ruleKey),
        pins.commands.map(({ ruleKey }) => ruleKey),
        name,
      );
      verify(report, pins);
      assertEquals(report.allRequired, false, name);
    }

    // The ambiguity stays visible when the revision is reachable, and it is
    // then the only reason the ambiguous command can have: the others in the
    // report ran, so an unreachable revision here contradicts them.
    const reachable = await honestReport(AMBIGUOUS_SCENARIO, {
      "magic.shared": "ambiguous",
    });
    verify(reachable.report, reachable.pins);
    for (const reason of ["revision_unavailable", "tool_missing", "skipped"]) {
      const forged = {
        ...reachable.report,
        observations: reachable.report.observations.map((observation) =>
          observation.checkId === "magic.shared"
            ? { ...observation, reason }
            : observation
        ),
      };
      assertEquals(
        rejectionOf(() => verify(forged, reachable.pins)),
        { code: "VALIDATION_FAILED", reason: "check_output_mismatch" },
        reason,
      );
    }
  });

  Deno.test(
    "echoed verdicts and foreign identities fail verification",
    assertForgeriesRefused(ECHO_FORGERIES),
  );
  Deno.test(
    "evidence the report itself contradicts fails verification",
    assertForgeriesRefused(EVIDENCE_FORGERIES),
  );
  Deno.test(
    "a report that does not name exactly the selected commands fails verification",
    assertForgeriesRefused(SELECTION_FORGERIES),
  );
  Deno.test(
    "observations no process or missing tool can produce fail verification",
    assertForgeriesRefused(COHERENCE_FORGERIES),
  );

  Deno.test("the attempt window bounds the sum of the reported durations", async () => {
    const { pins, report } = await honestReport({});
    const total = report.observations.reduce(
      (sum, { durationMs }) => sum + durationMs,
      0,
    );
    verify(report, pins, total);
    for (const window of [total - 1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      assertEquals(
        rejectionOf(() => verify(report, pins, window))?.reason,
        "check_output_mismatch",
        String(window),
      );
    }
  });

  Deno.test("an empty or missing decision list is a missing policy, never an all-passed delivery", () => {
    // The helper the finalizer wraps answers "all required passed" for no
    // decisions and no observations; the guard exists so that answer is never
    // taken for a verdict.
    assertEquals(deriveCheckVerdict([], []).allRequired, true);
    const observations = [{
      checkRunId: crypto.randomUUID(),
      checkId: "unit",
      result: "passed" as const,
    }];
    for (const decisions of [[], undefined, null]) {
      const refusal = rejectionOf(() =>
        expectedVerdict(observations, decisions)
      );
      assertEquals(
        [refusal?.code, refusal?.reason],
        ["VALIDATION_FAILED", "check_policy_missing"],
      );
    }
    assertEquals(
      expectedVerdict(observations, [{ commandId: "unit", mode: "require" }])
        .allRequired,
      true,
    );
  });

  Deno.test("fixed-policy admission requires one exact commit and each command once, on both sides", async () => {
    const input = await jobInput();
    const context = input.repositoryProfile;
    const profile = admittedProfile(context);
    const { admit, workerAdmit } = admissions(profile, input);
    // The accepted shapes.
    admit({});
    await workerAdmit({});
    admit({ checks: ["unit"] });
    await workerAdmit({ checks: ["unit"] });
    const refused: Array<[string, Record<string, unknown>]> = [
      ["a branch name", { revision: "main" }],
      ["an upper-case commit", { revision: "A".repeat(40) }],
      ["a short commit", { revision: "1".repeat(39) }],
      ["a long commit", { revision: "1".repeat(41) }],
      ["a missing revision", { revision: undefined }],
      ["a non-string revision", { revision: 1 }],
      ["a repeated command", { checks: ["unit", "unit"] }],
      ["a repeated warn command", { checks: ["unit", "lint", "lint"] }],
    ];
    for (const [name, patch] of refused) {
      assertThrows(() => admit(patch), StandardError, undefined, name);
      await assertRejects(
        () => workerAdmit(patch),
        NativeExecutorError,
        "FIXED_REPOSITORY_POLICY_REJECTED",
        name,
      );
    }
    // A profile without a fixed policy keeps its old behaviour: no commit rule.
    const { fixedPolicy: _policy, ...unfixed } = context.config as Record<
      string,
      unknown
    >;
    enforceRepositoryFixedPolicy(
      {
        ...profile,
        config: unfixed as unknown as AdmittedRepositoryProfile["config"],
      },
      "quality.check",
      { checks: ["anything"], revision: "main" },
    );
  });

  Deno.test("a fixed policy cannot name more commands than a report can carry, so a selection needs no count cap", async () => {
    // Admission checks no count of its own: every selected id is a distinct
    // command of the policy, so the policy bound is the selection bound.
    const commandsOf = (count: number): CheckCommand[] =>
      Array.from({ length: count }, (_, index) => ({
        id: `command-${index}`,
        argv: ["true"],
        mode: index === 0 ? "require" : "guide",
      }));
    const full = await jobInput({
      commands: commandsOf(CHECK_OBSERVATION_MAX_ITEMS),
    });
    assertEquals(full.checks.length, CHECK_OBSERVATION_MAX_ITEMS);
    // Selecting every command of the largest policy is admitted on both
    // sides and derives one pin each.
    const { admit, workerAdmit } = admissions(
      admittedProfile(full.repositoryProfile),
      full,
    );
    admit({});
    await workerAdmit({});
    const pins = await deriveCheckPins(full);
    assertEquals(pins.commands.length, CHECK_OBSERVATION_MAX_ITEMS);

    // One command more is not a policy at all, so there is no 33-command
    // selection for admission to count.
    let refused: unknown;
    try {
      await fixedPolicyContext(IDENTITY, {
        commands: commandsOf(CHECK_OBSERVATION_MAX_ITEMS + 1),
      });
    } catch (error) {
      refused = error;
    }
    const issues = (refused as {
      issues?: Array<{ code: string; path: PropertyKey[] }>;
    } | undefined)?.issues ?? [];
    assert(
      issues.some(({ code, path }) =>
        code === "too_big" && path.includes("commands")
      ),
      `a policy of ${CHECK_OBSERVATION_MAX_ITEMS + 1} commands was accepted`,
    );
  });
}
