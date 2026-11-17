/**
 * Admission cannot resolve a step input that reads an earlier step's output, so
 * it measures such a step from its literal input plus a fixed allowance for the
 * identifiers that reference stands for (`run-command.ts`, the `refuse` calls
 * that add `stepOutputAllowance`).
 *
 * The allowance is a number, so this measures it as one: a literal input that
 * fits only because the allowance is reserved for it, one byte more that does
 * not, and a delta that is exactly the constant. A test that only asserted "the
 * referenced version fits more" would pass with any delta at all and could
 * drift from the constant unnoticed.
 */
import { assert, assertEquals } from "@std/assert";
import {
  EXECUTION_JOB_INPUT_BYTES_MAX,
  STEP_OUTPUT_ALLOWANCE_BYTES,
} from "@bakery/contracts/repository-rules";
import { executionJobInputFitsTransport } from "@bakery/persistence/repository-admission";

/** Canonical bytes of a job input, the unit the ceiling is measured in. */
function measuredBytes(input: unknown): number {
  return new TextEncoder().encode(JSON.stringify(input)).length;
}

/** A job input of exactly `bytes` bytes, as admission builds it. */
function inputOf(bytes: number): { payload: string } {
  const overhead = measuredBytes({ payload: "" });
  return { payload: "x".repeat(bytes - overhead) };
}

/** The same input with the allowance admission reserves for a reference. */
function withAllowance(input: unknown): unknown {
  return {
    ...(input as Record<string, unknown>),
    stepOutputAllowance: "x".repeat(STEP_OUTPUT_ALLOWANCE_BYTES),
  };
}

Deno.test("the step-output allowance is the budget it was chosen as", () => {
  // Pinned as a literal on purpose. Every other assertion here imports the
  // constant, so they stay true if it drifts - this one is what makes a change
  // to the budget a deliberate act that updates the test, rather than a silent
  // redefinition of what "fits" means.
  assertEquals(STEP_OUTPUT_ALLOWANCE_BYTES, 2_048);
  assertEquals(EXECUTION_JOB_INPUT_BYTES_MAX, 100_000);
});

Deno.test("the step-output allowance is exactly what lets a referencing step fit", () => {
  // The allowance is reserved, so the largest literal that fits is the ceiling
  // less the allowance and the bytes its own key costs - and one byte more is
  // refused.
  const keyBytes = measuredBytes({ payload: "", stepOutputAllowance: "" }) -
    measuredBytes({ payload: "" });
  const largest = EXECUTION_JOB_INPUT_BYTES_MAX - STEP_OUTPUT_ALLOWANCE_BYTES -
    keyBytes;
  const fits = inputOf(largest);
  assertEquals(measuredBytes(fits), largest);
  assertEquals(executionJobInputFitsTransport(withAllowance(fits)), true);

  const oneMore = inputOf(largest + 1);
  assertEquals(measuredBytes(oneMore), largest + 1);
  assertEquals(executionJobInputFitsTransport(withAllowance(oneMore)), false);

  // Without the reservation the same input would have fitted, so the refusal
  // above is the allowance and not the ceiling.
  assert(
    executionJobInputFitsTransport(oneMore),
    "the input must fit without the allowance, or this measures the ceiling",
  );
});

Deno.test("the allowance buys exactly the constant, not merely more", () => {
  // A step that resolved its input carries the identifier as bytes; a step that
  // could not carries the allowance instead. The difference between the two
  // measurements is the constant itself.
  const unresolved = { planArtifact: "$step.brief.artifact.versionId" };
  const difference = measuredBytes(withAllowance(unresolved)) -
    measuredBytes({ ...unresolved, stepOutputAllowance: "" });
  assertEquals(difference, STEP_OUTPUT_ALLOWANCE_BYTES);

  // And the allowance exceeds a resolved identifier, or a referencing step
  // would be measured as cheaper than the step it reads.
  const resolved = { planArtifact: "0".repeat(36) };
  assert(
    measuredBytes(withAllowance(unresolved)) > measuredBytes(resolved),
    "the allowance must exceed a resolved identifier",
  );
});
