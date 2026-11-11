import { StandardError } from "@bakery/contracts/http";
import {
  type CheckPins,
  type CommandPin,
  deriveProfilePins,
  pinCommand,
} from "./check-pins.ts";

/**
 * The pins a `review.independent` job was admitted under, recomputed from the
 * job's own input. The review job carries the same pinned repository profile
 * as a check job, so the head, base and policy a review report must echo come
 * from the stored input and never from the report.
 */

/** `VALIDATION_FAILED` reason when the review job carries no usable policy. */
export const REVIEW_POLICY_MISSING_REASON = "review_policy_missing";

export type ReviewPins = {
  /** Commit under review: the job's 40-hex revision. */
  readonly headSha: string;
  /** Inspected base commit of the pinned profile. */
  readonly baseSha: string;
  /** Digest of the effective policy: fixed policy, checker and rule entries. */
  readonly policyDigest: string;
  /** Digest of the pinned repository profile. */
  readonly profileDigest: string;
  /** Digest of the trusted checker configuration. */
  readonly checkerDigest: string;
  /** One pin per fixed policy command, selected or not, in policy order. */
  readonly commands: readonly CommandPin[];
  /** Every decision of the fixed policy. */
  readonly decisions: CheckPins["decisions"];
};

/**
 * Derives the pins of one `review.independent` job from its stored input.
 * Throws `VALIDATION_FAILED` with reason `review_policy_missing` when the input
 * holds no profile with a fixed policy, when its pins disagree with their own
 * digests, or when its revision is not a full lowercase commit id. A command
 * with no decision fails closed the same way: a review is judged against every
 * fixed command, so the policy has to cover them all.
 */
export async function deriveReviewPins(jobInput: unknown): Promise<ReviewPins> {
  const profile = await deriveProfilePins(
    jobInput,
    REVIEW_POLICY_MISSING_REASON,
  );
  const modeById = new Map(
    profile.decisions.map((decision) => [decision.commandId, decision.mode]),
  );
  const commands: CommandPin[] = [];
  for (const command of profile.policyCommands) {
    const mode = modeById.get(command.id);
    if (mode === undefined) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: REVIEW_POLICY_MISSING_REASON },
      });
    }
    commands.push(await pinCommand(command, mode, profile.entries));
  }
  return {
    headSha: profile.headSha,
    baseSha: profile.baseSha,
    policyDigest: profile.policyDigest,
    profileDigest: profile.profileDigest,
    checkerDigest: profile.checkerDigest,
    commands,
    decisions: profile.decisions,
  };
}
