import type { CheckResult } from "../../../packages/contracts/src/check-evidence.ts";
import { CHECK_OBSERVATION_MAX_ITEMS } from "../../../packages/contracts/src/check-evidence.ts";
import transportSchemas from "../../../packages/contracts/generated/transport-schemas.ts";

/**
 * Shared builders for deterministic check tests. Phases 2 to 5 import the same
 * helpers, so an observation means the same thing in every lane.
 */

type JsonRecord = Record<string, unknown>;
type FieldBounds = { minLength?: number; maxLength?: number; max?: number };

export const SHA256_A = "a".repeat(64);
export const SHA256_B = "b".repeat(64);
export const SHA256_C = "c".repeat(64);
export const HEAD_SHA = "1".repeat(40);
export const BASE_SHA = "2".repeat(40);

/** The wire shape of one worker-reported observation. */
export type ObservationFixture = {
  checkRunId: string;
  checkId: string;
  kind: string;
  ruleKey: string | null;
  result: CheckResult;
  reason: string;
  exitCode: number | null;
  durationMs: number;
  outputDigest: string | null;
  evidence: { artifactId: string; versionId: string; sha256: string } | null;
};

/** A passed command observation; override any field to model another outcome. */
export function observation(
  overrides: Partial<ObservationFixture> = {},
): ObservationFixture {
  return {
    checkRunId: crypto.randomUUID(),
    checkId: "unit",
    kind: "command",
    ruleKey: null,
    result: "passed",
    reason: "verified",
    exitCode: 0,
    durationMs: 120,
    outputDigest: SHA256_A,
    evidence: null,
    ...overrides,
  };
}

/** A complete `CheckOutput` around the given observations. */
export function checkOutput(
  observations: readonly ObservationFixture[],
  overrides: Record<string, unknown> = {},
) {
  return {
    allRequired: observations.every(({ result }) => result === "passed"),
    checkRunIds: observations.map(({ checkRunId }) => checkRunId),
    failedCheckIds: observations.filter(({ result }) => result !== "passed")
      .map(({ checkRunId }) => checkRunId),
    observations: [...observations],
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    policyDigest: SHA256_C,
    ...overrides,
  };
}

/** `outputs.<name>` of the shipped transport schemas. */
export function transportType(name: string): JsonRecord {
  const outputs = (transportSchemas as unknown as { outputs: JsonRecord })
    .outputs;
  const definition = outputs[name];
  if (!definition || typeof definition !== "object") {
    throw new Error(`TRANSPORT_TYPE_MISSING:${name}`);
  }
  return definition as JsonRecord;
}

/** The members of an `enum(a|b|c)` field type, with a `|null` suffix removed. */
export function enumMembers(fieldType: string): string[] {
  const match = /^enum\((.*)\)(?:\|null)?$/.exec(fieldType);
  if (!match) throw new Error(`NOT_AN_ENUM:${fieldType}`);
  return match[1].split("|");
}

function longest(values: readonly string[]): string {
  return values.reduce((a, b) => b.length > a.length ? b : a);
}

/**
 * The largest value a `CheckObservation` field may hold under the shipped
 * contract: maximum-length strings and enum members, maximum integers, and a
 * full artifact reference. Reading the bounds from the contract keeps the
 * result-size test honest when a bound changes.
 */
export function worstCaseObservation(): ObservationFixture {
  const definition = transportType("CheckObservation");
  const types = definition.fieldTypes as Record<string, string>;
  const bounds = (definition.fieldBounds ?? {}) as Record<string, FieldBounds>;
  const value: JsonRecord = {};
  for (const [field, type] of Object.entries(types)) {
    const base = type.replace(/\|null$/, "");
    const bound = bounds[field] ?? {};
    if (base === "uuid") value[field] = crypto.randomUUID();
    else if (base === "sha256") value[field] = SHA256_A;
    else if (base === "ArtifactRef") {
      value[field] = {
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: SHA256_A,
      };
    } else if (base === "integer") value[field] = bound.max ?? 0;
    else if (base === "string") value[field] = "x".repeat(bound.maxLength ?? 0);
    else if (base.startsWith("enum(")) {
      value[field] = longest(enumMembers(base));
    } else throw new Error(`UNHANDLED_FIELD_TYPE:${field}:${type}`);
  }
  return value as unknown as ObservationFixture;
}

/** A `CheckOutput` carrying the most observations the contract allows. */
export function worstCaseCheckOutput() {
  const observations = Array.from(
    { length: CHECK_OBSERVATION_MAX_ITEMS },
    () => worstCaseObservation(),
  );
  return checkOutput(observations, {
    allRequired: false,
    headSha: "h".repeat(64),
    baseSha: "b".repeat(64),
    policyDigest: SHA256_C,
  });
}

/** A `WorkerResult` carrying `result` as a completed action output. */
export function completedWorkerResult(result: unknown) {
  return {
    leaseToken: "lease",
    fence: "1",
    localSeq: "1",
    status: "completed",
    result,
  };
}
