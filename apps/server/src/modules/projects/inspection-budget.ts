import { REPOSITORY_INSPECTION_LIMITS as LIMITS } from "@bakery/config";
import { canonicalJson } from "../../platform/canonical-json.ts";

/** Hard cap on the encoded inspection job input. */
export const INSPECTION_INPUT_BYTES_MAX = 100_000;
/** Room left in the report for the receipt and bounded host inventory. */
export const INSPECTION_REPORT_RESERVE_BYTES = 8192;
/** Room left in the report for one worst-case result per server check. */
export const INSPECTION_CHECK_RESERVE_BYTES = 512;

/**
 * Whether an inspection job input of `inputBytes` encoded bytes with
 * `checkCount` server checks can still be reported within the independent
 * report cap. Onboarding and profile publication share this one rule.
 */
export function inspectionInputWithinBudget(
  inputBytes: number,
  checkCount: number,
  reportBytesMax: number = LIMITS.reportBytes,
): boolean {
  return inputBytes <= INSPECTION_INPUT_BYTES_MAX &&
    inputBytes + INSPECTION_REPORT_RESERVE_BYTES +
          checkCount * INSPECTION_CHECK_RESERVE_BYTES <= reportBytesMax;
}

/**
 * The server accepts a worker result of at most this many bytes
 * (`EVENT_PAYLOAD_MAX_BYTES` in execution/shared.ts, `WORKER_RESULT_MAX_BYTES`
 * in the worker), and the inspection report repeats the whole job input. That
 * is tighter than the 64 KiB report limit onboarding checks, so publication
 * bounds against this value: a config that fits here can finish inspection.
 * A unit test pins it to the worker constant.
 */
export const INSPECTION_RESULT_BYTES_MAX = 32_000;

export function encodedByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---- Publish-time reservation -------------------------------------------
//
// Onboarding copies the profile config into a larger job input and counts the
// per-check report room. Publication cannot know the source-derived checks, so
// it reserves what onboarding is certain to add plus an explicit allowance.
// The numbers below are schema bounds pinned by unit tests against the
// schemas (`RepositoryInspectionCheckPolicySchema` max checks and
// `RepositoryInspectionPathSchema` max path length), not guesses.

/** Maximum checks the check policy schema admits. */
export const INSPECTION_MAX_CHECKS = 64;
/** Checks onboarding always emits: source integrity plus one per tool. */
export const INSPECTION_FIXED_CHECKS = 4;
/** Maximum encoded path length the path schema admits (ASCII in practice). */
export const INSPECTION_MAX_PATH_LENGTH = 512;
/**
 * Policy: source-derived checks the publish bound leaves room for. A
 * repository whose manifests derive more can still need a smaller config to
 * onboard (64 maximal checks cannot be reported even with no overrides: their
 * report room alone is 32,768 bytes, the whole result limit).
 */
export const INSPECTION_DERIVED_CHECK_ALLOWANCE = 4;

const UUID = "00000000-0000-4000-8000-000000000000";
const HEX64 = "0".repeat(64);

/** Largest check the derivation can emit for one command: one maximal path. */
function maximalDerivedCheck() {
  return {
    id: "manifest.1023.check.63",
    template: "node.syntax.v1",
    tool: "node",
    paths: ["a".repeat(INSPECTION_MAX_PATH_LENGTH)],
    required: true,
  };
}

function fixedCheck(index: number) {
  return {
    id: index === 0
      ? "source.integrity"
      : `tool.${["git", "deno", "node"][index - 1]}`,
    template: index === 0 ? "source.integrity.v1" : "tool.version.v1",
    tool: index === 0 ? null : ["git", "deno", "node"][index - 1],
    paths: [] as string[],
    required: true,
  };
}

/**
 * Bytes onboarding adds to the profile config in the encoded job input at
 * the schema maximum for every fixed field, the fixed checks, the tools, the
 * trusted-checker block and `INSPECTION_DERIVED_CHECK_ALLOWANCE` maximal
 * derived checks.
 */
export const INSPECTION_PUBLISH_OVERHEAD_BYTES = encodedByteLength(
  canonicalJson({
    inspectionId: UUID,
    jobId: UUID,
    organizationId: UUID,
    applicationId: UUID,
    repositoryId: UUID,
    baseline: {
      profileId: UUID,
      revision: 2_147_483_647,
      digest: HEX64,
      repositoryVersion: 2_147_483_647,
      defaultBranch: "字".repeat(255),
    },
    profile: {
      id: UUID,
      revision: 2_147_483_647,
      digest: HEX64,
      config: {
        checkPolicy: {
          schemaVersion: 1,
          platform: "linux",
          tools: ["git", "deno", "node"].map((tool) => ({
            tool,
            required: true,
          })),
          checks: [
            ...Array.from(
              { length: INSPECTION_FIXED_CHECKS },
              (_, i) => fixedCheck(i),
            ),
            ...Array.from(
              { length: INSPECTION_DERIVED_CHECK_ALLOWANCE },
              maximalDerivedCheck,
            ),
          ],
        },
        fixedPolicy: {
          trustedChecker: {
            kind: "repository-inspection",
            configDigest: HEX64,
          },
        },
      },
    },
    source: {
      mappingRevision: "x".repeat(128),
      mappingDigest: HEX64,
      baseSha: HEX64,
      manifestDigest: HEX64,
      envelopeDigest: HEX64,
      envelopeBytes: 8 * 1024 * 1024,
      decodedBytes: 4 * 1024 * 1024,
      entryCount: 1024,
    },
  }),
);

/** Check count the publish bound charges report room for. */
export const INSPECTION_PUBLISH_CHECK_COUNT = INSPECTION_FIXED_CHECKS +
  INSPECTION_DERIVED_CHECK_ALLOWANCE;

/**
 * Publish-time bound for a profile config of `configBytes` canonical bytes:
 * the config plus the reserved onboarding overhead must fit the same rule
 * onboarding applies.
 */
export function profileConfigFitsInspectionBudget(
  configBytes: number,
): boolean {
  return inspectionInputWithinBudget(
    configBytes + INSPECTION_PUBLISH_OVERHEAD_BYTES,
    INSPECTION_PUBLISH_CHECK_COUNT,
    Math.min(LIMITS.reportBytes, INSPECTION_RESULT_BYTES_MAX),
  );
}

/** Largest config size (canonical bytes) the publish bound accepts. */
export function maxPublishableConfigBytes(): number {
  let bytes = 0;
  while (profileConfigFitsInspectionBudget(bytes + 1)) bytes++;
  return bytes;
}
