import { effectivePolicyDigest } from "@bakery/contracts/check-evidence";
import type { EffectiveRepositoryRuleEntry } from "@bakery/contracts/repository-rules";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";

/** The part of a fixed policy its pins are derived from. */
type FixedPolicyLike = {
  readonly trustedChecker: { readonly configDigest: string };
};

/**
 * The fixed-policy pins run admission freezes into a run snapshot: the
 * canonical digest of the fixed policy and its trusted checker digest. The
 * effective-rules read derives the same pins from the same profile config, so
 * the two never compute them differently.
 */
export async function fixedPolicyPins(fixedPolicy: FixedPolicyLike): Promise<{
  fixedPolicyDigest: string;
  trustedCheckerConfigDigest: string;
}> {
  return {
    fixedPolicyDigest: await sha256Hex(canonicalJson(fixedPolicy)),
    trustedCheckerConfigDigest: fixedPolicy.trustedChecker.configDigest,
  };
}

/**
 * The rules fingerprint of a profile and its effective entries: exactly the
 * `policyDigest` a check of a run admitted under them records, because it is
 * the same `effectivePolicyDigest` over the same admission pins. A profile with
 * no fixed policy admits runs that record no check, so its pins are the digest
 * of an absent policy; that value matches no recorded check.
 */
export async function rulesPolicyDigest(
  fixedPolicy: FixedPolicyLike | undefined,
  entries: readonly EffectiveRepositoryRuleEntry[],
): Promise<string> {
  const absent = await sha256Hex(canonicalJson(null));
  const pins = fixedPolicy === undefined
    ? { fixedPolicyDigest: absent, trustedCheckerConfigDigest: absent }
    : await fixedPolicyPins(fixedPolicy);
  return await effectivePolicyDigest({ ...pins, entries });
}
