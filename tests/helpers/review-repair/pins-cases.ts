import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import {
  commandSubjects,
  deriveCheckPins,
  deriveProfilePins,
} from "../../../apps/server/src/modules/delivery/check-pins.ts";
import {
  deriveReviewPins,
  REVIEW_POLICY_MISSING_REASON,
} from "../../../apps/server/src/modules/delivery/review-pins.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import {
  AMBIGUOUS_SCENARIO,
  RULE_SCENARIO,
} from "../deterministic-checks/finalizer-forgeries.ts";
import {
  DEFAULT_COMMANDS,
  fixedPolicyContext,
  type PolicyOptions,
} from "../deterministic-checks/finalizer-policy.ts";
import { BASE_SHA, HEAD_SHA } from "../deterministic-checks/observations.ts";

/**
 * Cases for the pins of a `review.independent` job. The review job carries the
 * same pinned repository profile as a check job, so its pins are derived from
 * the same stored input and checked against an independent computation. The
 * factored profile helper is also proved to leave `deriveCheckPins` as it was:
 * both derivations agree on everything they share.
 */

const IDENTITY = {
  organizationId: crypto.randomUUID(),
  applicationId: crypto.randomUUID(),
  repositoryId: crypto.randomUUID(),
  id: crypto.randomUUID(),
  revision: 2,
};

const sha = (value: unknown) => sha256Hex(canonicalJson(value));

/** A stored `review.independent` job input around a fixed-policy profile. */
async function reviewInput(options: PolicyOptions = {}, revision = HEAD_SHA) {
  return {
    repositoryId: IDENTITY.repositoryId,
    revision,
    evidence: [crypto.randomUUID()],
    repositoryProfile: await fixedPolicyContext(IDENTITY, options),
  };
}

/** The same profile as a `quality.check` input selecting every command. */
async function checkInput(options: PolicyOptions = {}) {
  const input = await reviewInput(options);
  const commands = options.commands ?? DEFAULT_COMMANDS;
  return {
    repositoryId: input.repositoryId,
    revision: input.revision,
    checks: commands.map(({ id }) => id),
    repositoryProfile: input.repositoryProfile,
  };
}

async function reasonOf(work: () => Promise<unknown>): Promise<unknown> {
  const error = await assertRejects(work, StandardError);
  assertEquals(error.code, "VALIDATION_FAILED");
  return error.params?.reason;
}

export function registerPinsCases(): void {
  Deno.test("review pins derive from the stored job exactly as an independent computation does", async () => {
    const input = await reviewInput();
    const pins = await deriveReviewPins(input);
    const context = input.repositoryProfile;
    const fixedPolicy = (context.config as {
      fixedPolicy: { commands: Array<{ id: string; argv: string[] }> };
    }).fixedPolicy;
    assertEquals(pins.headSha, HEAD_SHA);
    assertEquals(pins.baseSha, BASE_SHA);
    assertEquals(pins.profileDigest, context.digest);
    assertEquals(pins.checkerDigest, context.trustedCheckerConfigDigest);
    assertEquals(
      pins.policyDigest,
      await sha({
        fixedPolicyDigest: context.fixedPolicyDigest,
        trustedCheckerConfigDigest: context.trustedCheckerConfigDigest,
        entriesDigest: await sha([]),
      }),
    );
    // Every fixed command is pinned, selected or not, in policy order.
    assertEquals(
      pins.commands.map(({ checkId, mode }) => [checkId, mode]),
      DEFAULT_COMMANDS.map(({ id, mode }) => [id, mode]),
    );
    assertEquals(
      pins.commands.map(({ argv }) => argv),
      fixedPolicy.commands.map(({ argv }) => argv),
    );
    assertEquals(
      pins.commands.map(({ subjectDigest }) => subjectDigest),
      await Promise.all(
        fixedPolicy.commands.map(({ id, argv }) =>
          sha({ command: { id, argv }, ruleEntryDigest: null })
        ),
      ),
    );
    for (const command of pins.commands) {
      assertEquals(command.ruleKey, null);
      assertEquals(command.ambiguous, false);
    }
    assertEquals(
      pins.decisions,
      DEFAULT_COMMANDS.map(({ id, mode }) => ({ commandId: id, mode })),
    );
  });

  Deno.test("a bound rule enters the command's pin and the policy digest, as for a check", async () => {
    const plain = await deriveReviewPins(await reviewInput());
    const bound = await deriveReviewPins(await reviewInput(RULE_SCENARIO));
    const numbers = bound.commands.find(({ checkId }) =>
      checkId === "magic.numbers"
    )!;
    assertEquals(numbers.ruleKey, "code.magicNumbers");
    assertEquals(numbers.ambiguous, false);
    assert(bound.policyDigest !== plain.policyDigest);
    const ambiguous = await deriveReviewPins(
      await reviewInput(AMBIGUOUS_SCENARIO),
    );
    const shared = ambiguous.commands.find(({ checkId }) =>
      checkId === "magic.shared"
    )!;
    assertEquals(shared.ruleKey, null);
    assertEquals(shared.ambiguous, true);
  });

  Deno.test("review pins and check pins agree on everything the two derivations share", async () => {
    const scenarios: Array<[string, PolicyOptions]> = [
      ["no rule", {}],
      ["one bound rule", RULE_SCENARIO],
      ["two rules on one command", AMBIGUOUS_SCENARIO],
    ];
    for (const [name, options] of scenarios) {
      const review = await deriveReviewPins(await reviewInput(options));
      const check = await deriveCheckPins(await checkInput(options));
      assertEquals(review.headSha, check.headSha, name);
      assertEquals(review.baseSha, check.baseSha, name);
      assertEquals(review.profileDigest, check.profileDigest, name);
      assertEquals(review.checkerDigest, check.checkerDigest, name);
      assertEquals(review.policyDigest, check.policyDigest, name);
      assertEquals(review.decisions, check.decisions, name);
      // Selecting every command, a check pins exactly what a review pins.
      assertEquals(review.commands, check.commands, name);
      assertEquals(commandSubjects(review), commandSubjects(check), name);
    }
  });

  Deno.test("a check that selects some commands pins the same objects the review pins for them", async () => {
    const review = await deriveReviewPins(await reviewInput(RULE_SCENARIO));
    const input = await checkInput(RULE_SCENARIO);
    const subset = await deriveCheckPins({
      ...input,
      checks: ["magic.numbers", "unit"],
    });
    assertEquals(subset.checks, ["magic.numbers", "unit"]);
    for (const pin of subset.commands) {
      assertEquals(
        pin,
        review.commands.find(({ checkId }) => checkId === pin.checkId),
      );
    }
    // The review pins keep every command the check left out.
    assert(review.commands.length > subset.commands.length);
  });

  Deno.test("the review pins read the profile and the revision, not the selection or the evidence", async () => {
    const input = await reviewInput();
    const { evidence: _evidence, ...withoutEvidence } = input;
    assertEquals(
      await deriveReviewPins(withoutEvidence),
      await deriveReviewPins(input),
    );
    assertEquals(
      await deriveReviewPins({ ...input, checks: ["nonsense"], extra: 1 }),
      await deriveReviewPins(input),
    );
  });

  Deno.test("review pins refuse every job input admission would not have produced", async () => {
    const good = await reviewInput();
    const withContext = (patch: Record<string, unknown>) => ({
      ...good,
      repositoryProfile: { ...good.repositoryProfile, ...patch },
    });
    const withRules = await reviewInput(RULE_SCENARIO);
    const refusals: Array<[string, unknown]> = [
      ["not an object", "input"],
      ["null", null],
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
                (entry) => ({ ...entry, mode: "guide" }),
              ),
            },
          },
        },
      ],
      ["a branch name", { ...good, revision: "main" }],
      ["an upper-case revision", { ...good, revision: "A".repeat(40) }],
      ["a short revision", { ...good, revision: "1".repeat(39) }],
      ["a long revision", { ...good, revision: "1".repeat(41) }],
      ["a revision that is a number", { ...good, revision: 1 }],
      ["no revision", { ...good, revision: undefined }],
    ];
    for (const [name, input] of refusals) {
      assertEquals(
        await reasonOf(() => deriveReviewPins(input)),
        REVIEW_POLICY_MISSING_REASON,
        name,
      );
    }
    // A strict-v1 profile carries no fixed policy at all.
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
    assertEquals(
      await reasonOf(() => deriveReviewPins(v1)),
      REVIEW_POLICY_MISSING_REASON,
    );
  });

  Deno.test("a refused input carries the caller's own reason, so a refused review and a refused check stay apart", async () => {
    const bad = { ...(await reviewInput()), revision: "main" };
    assertEquals(
      await reasonOf(() => deriveReviewPins(bad)),
      "review_policy_missing",
    );
    assertEquals(
      await reasonOf(() => deriveCheckPins({ ...bad, checks: ["unit"] })),
      "check_policy_missing",
    );
    assertEquals(
      await reasonOf(() => deriveProfilePins(bad, "custom_reason")),
      "custom_reason",
    );
  });

  Deno.test("the shared profile helper hands back the policy it verified", async () => {
    const input = await reviewInput(RULE_SCENARIO);
    const profile = await deriveProfilePins(input, "any_reason");
    assertEquals(profile.headSha, HEAD_SHA);
    assertEquals(profile.baseSha, BASE_SHA);
    assertEquals(
      profile.policyCommands.map(({ id }) => id),
      (RULE_SCENARIO.commands ?? []).map(({ id }) => id),
    );
    assertEquals(
      profile.decisions.map(({ commandId }) => commandId),
      profile.policyCommands.map(({ id }) => id),
    );
    assertEquals(profile.entries.length, 1);
    assertEquals(profile.input, input);
  });
}
