/**
 * The `agent.freeform` action on a coding harness (#528).
 *
 * One bounded agent session answers one prompt. It has no repository: it runs in
 * an empty directory beside the step's pinned inputs, with only the read tools
 * the adapter vocabulary names, and it publishes its final answer as one
 * artifact. Four bounds stop it, and each stop is reported as a status, never
 * an exception: turns, wall-clock time, cost, and the caller's own abort.
 *
 * The CLIs do not agree on which bounds they enforce, so this module enforces
 * the ones that can be seen from outside (turns counted from the stream, time
 * from the supervisor) and each adapter passes on the ones its CLI has (cost).
 */

import { registeredWorkerActionInputSchema } from "../../../packages/contracts/src/contracts.ts";
import type { ArtifactRef } from "./client.ts";
import type { ExecutionOutcome } from "./executor.ts";
import { harnessFault, sha256Hex } from "./harness-common.ts";
import type { PublishArtifact } from "./task-brief.ts";
import type { JobAssignment } from "./types.ts";

export const FREEFORM_ACTION = "agent.freeform";

/** The registered `FreeformInput`, with its timeout read as milliseconds. */
export type FreeformRequest = Readonly<{
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
  maxCostUsd: number;
  allowedTools: readonly string[];
}>;

/** The most time one freeform session may be given, whatever the step asks. */
export const FREEFORM_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const FREEFORM_MIN_TIMEOUT_MS = 1_000;

const ISO_DURATION = /^PT(?:(\d{1,4})H)?(?:(\d{1,5})M)?(?:(\d{1,6})S)?$/;
const SHORT_DURATION = /^(\d{1,6})(s|m|h)$/;

/**
 * Reads a duration written either as ISO 8601 (`PT90S`, `PT1H30M`) or in the
 * compiler's short form (`90s`, `30m`, `2h`). Returns `null` for anything
 * else, for zero, and for a value outside one second to two hours: a bound that
 * can be read as no bound at all must be refused, not defaulted.
 */
export function parseFreeformTimeout(text: unknown): number | null {
  if (typeof text !== "string") return null;
  let ms: number | null = null;
  const iso = ISO_DURATION.exec(text);
  if (iso && (iso[1] || iso[2] || iso[3])) {
    ms = (Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 +
      Number(iso[3] ?? 0)) * 1000;
  } else {
    const short = SHORT_DURATION.exec(text);
    if (short) {
      ms = Number(short[1]) *
        { s: 1_000, m: 60_000, h: 3_600_000 }[short[2] as "s" | "m" | "h"];
    }
  }
  if (
    ms === null || ms < FREEFORM_MIN_TIMEOUT_MS || ms > FREEFORM_MAX_TIMEOUT_MS
  ) return null;
  return ms;
}

export type FreeformFaultNaming = Readonly<{ prefix: string; title: string }>;

/**
 * Reads and validates a freeform input against the registered contract. A
 * malformed input, or a timeout that is not a bounded duration, is a
 * non-retryable fault: the step never starts a session it cannot bound.
 */
export function readFreeformRequest(
  assignment: JobAssignment,
  naming: FreeformFaultNaming,
): FreeformRequest | ExecutionOutcome {
  const invalid = (detail: string) =>
    harnessFault(
      `${naming.prefix}_INPUT_INVALID`,
      detail,
      500,
      false,
      naming.title,
    );
  const raw = assignment.input;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("The freeform input was not an object.");
  }
  // The server may add its own keys (notes, profile); the contract is the
  // registered fields only.
  const registered = Object.fromEntries(
    ["prompt", "maxTurns", "timeout", "maxCostUsd", "allowedTools"].flatMap(
      (key) => key in raw ? [[key, (raw as Record<string, unknown>)[key]]] : [],
    ),
  );
  const parsed = registeredWorkerActionInputSchema(FREEFORM_ACTION)
    .safeParse(registered);
  if (!parsed.success) {
    return invalid("The freeform input did not match the freeform contract.");
  }
  const input = parsed.data as {
    prompt: string;
    maxTurns: number;
    timeout: string;
    maxCostUsd: number;
    allowedTools: string[];
  };
  const timeoutMs = parseFreeformTimeout(input.timeout);
  if (timeoutMs === null) {
    return invalid(
      "The freeform timeout is not a duration between one second and two hours.",
    );
  }
  return {
    prompt: input.prompt,
    maxTurns: input.maxTurns,
    timeoutMs,
    maxCostUsd: input.maxCostUsd,
    allowedTools: [...new Set(input.allowedTools)],
  };
}

/** True when `value` came from {@link readFreeformRequest} as a fault. */
export function isFreeformFault(
  value: FreeformRequest | ExecutionOutcome,
): value is ExecutionOutcome {
  return "status" in value;
}

/**
 * The tools a freeform session may use. A tool the adapter does not offer is a
 * refusal that names it, not a silent drop: a step that asked for a tool the
 * harness cannot give must not run as if it had it.
 */
export function freeformTools(
  request: FreeformRequest,
  vocabulary: readonly string[],
  naming: FreeformFaultNaming,
): readonly string[] | ExecutionOutcome {
  const refused = request.allowedTools.filter((tool) =>
    !vocabulary.includes(tool)
  );
  if (refused.length > 0) {
    return harnessFault(
      `${naming.prefix}_FREEFORM_TOOL_REFUSED`,
      `This harness offers only ${
        vocabulary.join(", ")
      } to a freeform step; it was asked for ${refused.join(", ")}.`,
      500,
      false,
      naming.title,
    );
  }
  return request.allowedTools;
}

export type FreeformStatus = "completed" | "failed" | "canceled" | "timed_out";

/** Why a session stopped when it did not end on its own. */
export type FreeformStop = "max_turns" | "max_cost" | "timeout" | "canceled";

/** The registered status a stop is reported under. */
export function statusOfStop(stop: FreeformStop | undefined): FreeformStatus {
  if (stop === undefined) return "completed";
  if (stop === "timeout") return "timed_out";
  if (stop === "canceled") return "canceled";
  return "failed";
}

const encoder = new TextEncoder();
/** The largest answer kept; the rest is cut and the cut is said. */
export const FREEFORM_MAX_ANSWER_BYTES = 256 * 1024;

/** Renders what the session produced, and why it stopped when it was stopped. */
export function renderFreeformAnswer(options: {
  answer: string;
  stop: FreeformStop | undefined;
  turns: number;
  limits: Pick<FreeformRequest, "maxTurns" | "maxCostUsd"> & {
    timeoutMs: number;
  };
}): Uint8Array {
  const lines: string[] = [];
  if (options.stop !== undefined) {
    lines.push(
      `> The session was stopped before it finished: ${
        {
          max_turns: `it reached its limit of ${options.limits.maxTurns} turns`,
          max_cost: `it reached its limit of ${options.limits.maxCostUsd} USD`,
          timeout: `it reached its limit of ${options.limits.timeoutMs} ms`,
          canceled: "it was canceled",
        }[options.stop]
      } after ${options.turns} turns. What follows is what it had produced.`,
      "",
    );
  }
  lines.push(options.answer);
  let bytes = encoder.encode(lines.join("\n"));
  if (bytes.byteLength > FREEFORM_MAX_ANSWER_BYTES) {
    bytes = encoder.encode(
      new TextDecoder().decode(bytes.slice(0, FREEFORM_MAX_ANSWER_BYTES)) +
        "\n\n> The answer was cut at the size limit.",
    );
  }
  return bytes;
}

/**
 * Publishes the answer and builds the outcome. A stop is a completed outcome
 * with a non-`completed` status, so the partial answer survives as evidence;
 * only a failure to publish is a fault.
 */
export async function freeformOutcome(options: {
  assignment: JobAssignment;
  publish: PublishArtifact;
  signal: AbortSignal;
  bytes: Uint8Array;
  stop: FreeformStop | undefined;
  source: string;
  extra?: Record<string, unknown>;
}): Promise<ExecutionOutcome> {
  let artifact: ArtifactRef;
  try {
    artifact = await options.publish({
      idempotencyKey:
        `freeform:${options.assignment.jobId}:${options.assignment.fence}`,
      artifactType: "other",
      mediaType: "text/markdown",
      name:
        `freeform-${options.assignment.jobId}-${options.assignment.fence}.md`,
      bytes: options.bytes,
      metadata: { source: options.source, immutable: true },
    }, options.signal);
  } catch (error) {
    return harnessFault(
      "FREEFORM_PUBLISH_FAILED",
      `The freeform answer could not be published: ${
        error instanceof Error ? error.message : String(error)
      }`,
      502,
      true,
    );
  }
  if (artifact.sha256 !== await sha256Hex(options.bytes)) {
    return harnessFault(
      "FREEFORM_ARTIFACT_DIGEST_MISMATCH",
      "The published freeform answer digest differs from the rendered bytes.",
      500,
      false,
    );
  }
  return {
    status: "completed",
    result: {
      sessionId: options.assignment.agentSessionId!,
      artifacts: [artifact],
      status: statusOfStop(options.stop),
      ...options.extra,
    } as unknown as import("../../../packages/contracts/src/contracts.ts").JsonValue,
  };
}
