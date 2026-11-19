import { assertEquals, assertNotEquals } from "@std/assert";
import {
  commitsEntry,
  titleEntry,
} from "../helpers/repository-rule-entries.ts";
import {
  apiCall,
  expectJson,
  presetBudgetEnv,
  seedPresetRepository,
} from "../helpers/fixed-coding-preset.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { publishOrganizationRules } from "../helpers/pinned-rules.ts";
import {
  BASE_SHA,
  HEAD_SHA,
} from "../helpers/deterministic-checks/observations.ts";
import { RepositoryExecutionContextSchema } from "../../packages/contracts/src/repository-inspection.ts";
import { pinEffectiveRepositoryRules } from "../../apps/server/src/modules/repository-rules/pinned.ts";
import { deriveCheckPins } from "../../apps/server/src/modules/delivery/check-pins.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";

/**
 * #65 AC1: the Rules page's "Rules fingerprint" (the effective-rules read's
 * `digest`) is the policyDigest a check of a run admitted under the same
 * rules records. The run side is the real admission pin
 * (`pinEffectiveRepositoryRules`) frozen into an execution context with
 * hand-computed fixed-policy digests, then the real recorder derivation
 * (`deriveCheckPins`), so the read is compared with an independent path.
 */

const digestOf = async (value: unknown) =>
  await sha256Hex(canonicalJson(value));

const CHECK_POLICY = {
  schemaVersion: 1,
  platform: "linux",
  tools: [{ tool: "git", required: true }],
  checks: [{
    id: "source.integrity",
    template: "source.integrity.v1",
    tool: null,
    paths: [],
    required: true,
  }],
};

async function fixedPolicyProfile() {
  const fixedPolicy = {
    schemaVersion: 1,
    commands: [{ id: "unit", argv: ["pnpm", "test:unit"] }],
    allowedEffects: ["evidence_only"],
    lockedConfiguration: { branches: true, worktree: true, checker: true },
    decisions: [{ commandId: "unit", mode: "require" }],
    trustedChecker: {
      kind: "repository-inspection",
      configDigest: await digestOf(CHECK_POLICY),
    },
  };
  return { schemaVersion: 2, checkPolicy: CHECK_POLICY, fixedPolicy };
}

Deno.test("#65 AC1: the rules fingerprint equals the policyDigest a run records, before and after a rules edit", () =>
  withWorkerFixture(async (fixture) => {
    const profileExtra = await fixedPolicyProfile();
    const repository = await seedPresetRepository(fixture.pgDatabase, fixture, {
      profileExtra,
    });
    const { schemaVersion, ...policyParts } = profileExtra;
    const config = {
      schemaVersion,
      workflow: { kind: "fixed" },
      branches: { base: "main", allowedPatterns: ["feature/*"] },
      worktree: { root: ".bakery/worktrees" },
      ...policyParts,
    };
    assertEquals(await digestOf(config), repository.profileDigest);

    // What a check of a run admitted now records as its policyDigest.
    const recordedDigest = async () => {
      const pin = await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          pinEffectiveRepositoryRules(transaction, fixture.organizationId, {
            repositoryId: repository.repositoryId,
            id: repository.profileId,
            revision: 1,
            digest: repository.profileDigest,
            repositoryRules: undefined,
          }),
      );
      const repositoryProfile = RepositoryExecutionContextSchema.parse({
        organizationId: fixture.organizationId,
        applicationId: repository.applicationId,
        repositoryId: repository.repositoryId,
        id: repository.profileId,
        revision: 1,
        digest: repository.profileDigest,
        config,
        observationId: crypto.randomUUID(),
        observationDigest: "a".repeat(64),
        baseSha: BASE_SHA,
        fixedPolicyDigest: await digestOf(profileExtra.fixedPolicy),
        trustedCheckerConfigDigest:
          profileExtra.fixedPolicy.trustedChecker.configDigest,
        repositoryRules: pin,
      });
      return (await deriveCheckPins({
        repositoryProfile,
        revision: HEAD_SHA,
        checks: ["unit"],
      })).policyDigest;
    };
    const readRules = async () => (await expectJson<
      { digest: string; hasFixedPolicy?: boolean }
    >(
      await apiCall(
        fixture,
        fixture,
        "GET",
        `/v1/repositories/${repository.repositoryId}/rules`,
      ),
      200,
    ));

    await publishOrganizationRules(fixture, fixture, 0, [commitsEntry(true)]);
    const before = await recordedDigest();
    const rulesBefore = await readRules();
    assertEquals(rulesBefore.digest, before);
    assertEquals(rulesBefore.hasFixedPolicy, true);

    // A rules edit moves both the read and a newly admitted run, together.
    await publishOrganizationRules(fixture, fixture, 1, [
      commitsEntry(true),
      titleEntry(),
    ]);
    const after = await recordedDigest();
    assertNotEquals(after, before);
    const rulesAfter = await readRules();
    assertEquals(rulesAfter.digest, after);
    assertEquals(rulesAfter.hasFixedPolicy, true);

    // A preview of the current rules carries the same fingerprint.
    const preview = await expectJson<{ effective: { digest: string } }>(
      await apiCall(
        fixture,
        fixture,
        "POST",
        `/v1/repositories/${repository.repositoryId}/rule-previews`,
        { body: { overrides: { entries: [] } } },
      ),
      200,
    );
    assertEquals(preview.effective.digest, after);

    // A profile without a fixed policy admits runs that record no check.
    const plain = await seedPresetRepository(fixture.pgDatabase, fixture, {});
    const plainRules = await expectJson<{ hasFixedPolicy?: boolean }>(
      await apiCall(
        fixture,
        fixture,
        "GET",
        `/v1/repositories/${plain.repositoryId}/rules`,
      ),
      200,
    );
    assertEquals(plainRules.hasFixedPolicy, false);
  }, { env: presetBudgetEnv }));
