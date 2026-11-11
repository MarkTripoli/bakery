import { z } from "zod";

/**
 * Gate refusal codes: a policy answer about the grant, resource or approval.
 * A pre-send error with one of these is terminal for the effect; every other
 * pre-send StandardError (SERVICE_UNAVAILABLE, RATE_LIMITED, INTERNAL) is a
 * transient host fault and stays retryable.
 */
export const GATE_REFUSAL_CODES: readonly string[] = [
  "AUTH_FORBIDDEN",
  "RESOURCE_NOT_FOUND",
  "STATE_CONFLICT",
  "PRECONDITION_FAILED",
  "UNPROCESSABLE",
];

/**
 * Failure class the broker attaches to an error it throws, so the effect
 * executor can tell a request that never left the host (`not_sent`) or an
 * authoritative provider refusal (`rejected`) from an unknown outcome.
 * An error with no class means the outcome is unknown (timeout, 5xx, 408,
 * transport, unparseable response) and the executor must treat it as uncertain.
 */
export const ProviderFailureClassSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("not_sent").describe(
      "The request was refused or failed inside the host before any provider I/O started.",
    ),
    retryable: z.boolean().describe(
      "True when the same effect may be claimed again later because the cause was transient.",
    ),
  }).describe(
    "Failure that happened inside the host before any provider I/O; the provider saw nothing.",
  ),
  z.strictObject({
    kind: z.literal("rejected").describe(
      "The provider answered with an authoritative refusal, so the write did not happen.",
    ),
    retryable: z.boolean().describe(
      "True when the refusal is a rate limit that clears with time; false when the request itself is refused.",
    ),
    retryAfterSeconds: z.number().int().min(1).max(3600).describe(
      "Bounded delay in seconds the provider asked the caller to wait before retrying.",
    ).optional().describe(
      "Bounded delay in seconds the provider asked the caller to wait before retrying, when it said so.",
    ),
  }).describe(
    "Authoritative provider refusal such as a rate limit or a rejected request; the write did not happen.",
  ),
]).describe(
  "Outcome class of a failed provider write: never sent, or authoritatively rejected; absence of a class means unknown.",
);

/** Failure class attached to a thrown provider error. */
export type ProviderFailureClass = z.infer<typeof ProviderFailureClassSchema>;

const marks = new WeakMap<object, ProviderFailureClass>();

/** Attaches a failure class to an error object and returns it. Non-objects cannot be marked and stay unknown. */
export function markProviderFailure<T>(
  error: T,
  failureClass: ProviderFailureClass,
): T {
  if (typeof error === "object" && error !== null) {
    marks.set(error, ProviderFailureClassSchema.parse(failureClass));
  }
  return error;
}

/** Returns the class marked on an error, or undefined when the outcome is unknown. */
export function providerFailureClass(
  error: unknown,
): ProviderFailureClass | undefined {
  return typeof error === "object" && error !== null
    ? marks.get(error)
    : undefined;
}
