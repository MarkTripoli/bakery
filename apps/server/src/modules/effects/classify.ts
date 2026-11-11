import { canonicalJson } from "../../platform/canonical-json.ts";
import { type EffectOutcome, MAX_EFFECT_JSON_BYTES } from "./schema.ts";

/**
 * Pure outcome table for one dispatch. It sees only what the request wrapper
 * recorded and how the handler ended. Anything it cannot prove stays
 * `uncertain`: `failed` and `retry` are allowed only when every started
 * request settled as `not_sent` or `rejected`.
 */

/** Delay before the first retry when the provider names none, in seconds. */
export const BASE_RETRY_SECONDS = 60;

/** Longest delay a retry may ask for, in seconds. */
export const MAX_RETRY_SECONDS = 3600;

/** Dispatch generations after which a retryable refusal becomes `retry_exhausted`. */
export const DEFAULT_MAX_DISPATCH_GENERATIONS = 5;

/**
 * State of one provider request the handler started.
 * `unknown` is a settled rejection that carries no failure class.
 */
export type RequestState =
  | "pending"
  | "fulfilled"
  | "not_sent"
  | "rejected"
  | "unknown";

/** One request recorded when it started, with its settlement. */
export type RequestRecord = Readonly<{
  ref: string;
  state: RequestState;
  retryable: boolean;
  retryAfterSeconds?: number;
}>;

/** How the handler call ended. */
export type HandlerEnd =
  | Readonly<{ kind: "resolved"; output: unknown }>
  | Readonly<{ kind: "threw"; timedOut: boolean }>;

/** Delay for the next retry: the provider's bounded hint, else exponential backoff from the generation. */
export function retryDelaySeconds(
  generation: number,
  retryAfterSeconds?: number,
): number {
  if (retryAfterSeconds !== undefined) {
    return Math.min(MAX_RETRY_SECONDS, Math.max(1, retryAfterSeconds));
  }
  const exponent = Math.min(20, Math.max(0, generation - 1));
  return Math.min(MAX_RETRY_SECONDS, BASE_RETRY_SECONDS * 2 ** exponent);
}

const encoder = new TextEncoder();

/**
 * The confirmed outcome for a handler result: `remoteId` when it is a bounded
 * string, `safeResult` only when it fits MAX_EFFECT_JSON_BYTES (else null).
 * Dispatch and reconcile share it, so both bound what the ledger stores.
 */
export function confirmedOutcome(
  output: unknown,
): Extract<EffectOutcome, { kind: "confirmed" }> {
  const remote = typeof output === "object" && output !== null &&
      "remoteId" in output
    ? (output as { remoteId: unknown }).remoteId
    : null;
  const remoteId = typeof remote === "string" && remote.length > 0 &&
      remote.length <= 400
    ? remote
    : null;
  let safeResult: unknown = null;
  try {
    const size = encoder.encode(canonicalJson(output)).length;
    if (size <= MAX_EFFECT_JSON_BYTES) safeResult = output ?? null;
  } catch {
    safeResult = null;
  }
  return { kind: "confirmed", remoteId, safeResult };
}

function retryOrExhaust(
  generation: number,
  maxGenerations: number,
  retryAfterSeconds?: number,
): EffectOutcome {
  if (generation >= maxGenerations) {
    return { kind: "failed", failureCode: "retry_exhausted" };
  }
  return {
    kind: "retry",
    retryAfterSeconds: retryDelaySeconds(generation, retryAfterSeconds),
  };
}

/** Maps the recorded requests and the handler end to the outcome the ledger stores. */
export function classifyDispatch(
  input: Readonly<{
    end: HandlerEnd;
    requests: readonly RequestRecord[];
    generation: number;
    maxGenerations: number;
  }>,
): EffectOutcome {
  const { end, requests, generation, maxGenerations } = input;
  // A started request that has not settled may have reached the provider.
  if (requests.some((r) => r.state === "pending")) {
    return { kind: "uncertain" };
  }
  if (end.kind === "resolved") return confirmedOutcome(end.output);
  if (end.timedOut) return { kind: "uncertain" };
  if (requests.some((r) => r.state === "fulfilled" || r.state === "unknown")) {
    return { kind: "uncertain" };
  }
  const rejected = requests.filter((r) => r.state === "rejected");
  const notSent = requests.filter((r) => r.state === "not_sent");
  if (rejected.length > 1) return { kind: "uncertain" };
  const [refusal] = rejected;
  if (refusal) {
    return refusal.retryable
      ? retryOrExhaust(generation, maxGenerations, refusal.retryAfterSeconds)
      : { kind: "failed", failureCode: "provider_rejected" };
  }
  const retryable = notSent.find((r) => r.retryable);
  if (retryable) return retryOrExhaust(generation, maxGenerations);
  return { kind: "failed", failureCode: "provider_not_sent" };
}
