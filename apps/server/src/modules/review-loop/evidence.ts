/**
 * What the review loop needs to know about the evidence a pack requires before
 * work may proceed. A pack decides what its requirements are (the software
 * delivery pack requires repository checks); the loop only reads how strictly
 * each is enforced, what its latest evidence says, and whether it blocks.
 */

/** How strictly a requirement is enforced: `require` blocks, `warn` keeps findings, `guide` is ignored. */
export const REQUIREMENT_MODES = Object.freeze(
  ["guide", "warn", "require"] as const,
);
export type RequirementMode = typeof REQUIREMENT_MODES[number];

/**
 * - `passed`: a fresh, coherent pass.
 * - `failed`: the newest evidence says the check ran and did not pass.
 * - `unavailable`: the newest evidence says the check could not be observed (or
 *   was canceled, or contradicts itself).
 * - `stale`: the newest evidence is a pass for something that has since
 *   changed. Only a pass can be stale.
 * - `missing`: there is no concluded evidence.
 * - `not_blocking`: the requirement is guidance only and was not consulted.
 */
export const REQUIREMENT_STATUSES = Object.freeze(
  [
    "passed",
    "failed",
    "unavailable",
    "stale",
    "missing",
    "not_blocking",
  ] as const,
);
export type RequirementStatus = typeof REQUIREMENT_STATUSES[number];

/** One requirement the loop judges: a stable id and how strictly it is enforced. */
export type EvidenceRequirement = {
  readonly checkId: string;
  readonly mode: RequirementMode;
};

/** The verdict on one requirement. */
export type EvidenceEvaluation = {
  readonly requirement: EvidenceRequirement;
  readonly status: RequirementStatus;
  /** Why the pack gave this status, in the pack's own vocabulary. */
  readonly reason: string;
  /** True when this requirement keeps the work blocked. */
  readonly blocking: boolean;
  /** The evidence row the status came from, or null when there was none. */
  readonly rowId: string | null;
  /** What changed since the evidence was recorded; empty unless stale. */
  readonly changed: readonly string[];
};

/** The pack's verdict on every requirement of one candidate. */
export type EvidenceVerdict = {
  /** True when any `require` requirement is not a fresh pass, and always when there are none. */
  readonly blocked: boolean;
  /** `policy_missing` when the pack named no requirement at all; null otherwise. */
  readonly reason: "policy_missing" | null;
  readonly evaluations: readonly EvidenceEvaluation[];
};
