import { z } from "zod";

export const OUTPUT_LIMITS = Object.freeze({
  parts: 100,
  partBytes: 16_000,
  batchBytes: 32_000,
  displayBytes: 8 * 1024 * 1024,
  statusBytes: 16 * 1024,
});

/** Independent read budgets; writer envelopes and /v1/events budgets stay unchanged. */
export const OUTPUT_READER_LIMITS = Object.freeze({
  defaultBatches: 32,
  maxBatches: 64,
  defaultPageBytes: 128 * 1024,
  maxPageBytes: 256 * 1024,
});
export const OUTPUT_CHANNELS = [
  "assistant",
  "stdout",
  "stderr",
  "status",
] as const;
export const OUTPUT_CAPTURE_STATES = [
  "capturing",
  "complete",
  "truncated",
  "interrupted",
] as const;
export const OUTPUT_REASONS = [
  "clean-end",
  "text-limit",
  "source-lost",
  "lease-lost",
  "producer-replaced",
] as const;
export const outputUuidSchema = z.string().uuid().refine((value) =>
  value === value.toLowerCase()
).describe(
  "Canonical UUID identifying a server-owned stream or an immutable producer item.",
);
export const outputSequenceSchema = z.string().regex(/^[1-9][0-9]*$/).refine(
  (value) => BigInt(value) < 9223372036854775807n,
  "Sequence must leave room for the next bigint handoff.",
).describe(
  "Positive canonical decimal sequence or generation, bounded below bigint exhaustion.",
);
export const outputCaptureSchema = z.enum(OUTPUT_CAPTURE_STATES).describe(
  "Capture evidence independent of workflow success and transcript publication; loss cannot later become complete.",
);
export const outputReasonSchema = z.union([
  z.enum(OUTPUT_REASONS).describe(
    "Bounded producer loss or final close reason.",
  ),
  z.null().describe("No capture loss or close has been reported."),
]).describe(
  "Bounded capture disposition reason; null only while no loss or close has been reported.",
);
function describedStrictObject<T extends z.ZodRawShape>(shape: T) {
  const schema = z.object(shape).strict().describe(
    "Closed output record whose named fields define its complete persistence or wire contract.",
  );
  // Retain Zod's strict-object inferred fields, not an impossible never index signature.
  return schema.catchall(
    z.never().describe(
      "Unknown output fields are rejected; they cannot introduce authority or hidden bytes.",
    ),
  ) as typeof schema;
}
export const OutputPartSchema = describedStrictObject({
  itemId: outputUuidSchema,
  channel: z.enum(OUTPUT_CHANNELS).describe(
    "Inert display channel; status consumes the separate final-marker reserve.",
  ),
  text: z.string().min(1).refine((value) =>
    new TextEncoder().encode(value).byteLength <= OUTPUT_LIMITS.partBytes
  ).describe(
    "Already sanitized inert text, at most 16000 UTF-8 bytes; raw credentials or decoder carry must never be submitted.",
  ),
}).describe(
  "One sanitized, generation-owned display item, ordered within its immutable batch.",
);
export const OutputBatchSchema = describedStrictObject({
  sessionId: outputUuidSchema,
  writerGeneration: outputSequenceSchema,
  batchId: outputUuidSchema,
  sequence: outputSequenceSchema,
  parts: z.array(OutputPartSchema).min(1).max(OUTPUT_LIMITS.parts).describe(
    "Ordered sanitized items, 1 through 100; IDs cannot repeat within a batch.",
  ),
  capture: z.enum(["capturing", "truncated", "interrupted"]).describe(
    "Producer's current capture evidence; final completeness is recorded only by explicit logical close.",
  ),
  reason: outputReasonSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "SHA-256 of canonical UTF-8 batch envelope excluding this digest, verified by the server.",
  ),
}).refine((batch) =>
  new TextEncoder().encode(JSON.stringify(batch)).byteLength <=
    OUTPUT_LIMITS.batchBytes
).refine((batch) =>
  new Set(batch.parts.map((part) => part.itemId)).size === batch.parts.length
).refine((batch) =>
  batch.capture === "capturing"
    ? batch.reason === null
    : batch.capture === "truncated"
    ? batch.reason === "text-limit"
    : batch.reason === "source-lost" || batch.reason === "lease-lost" ||
      batch.reason === "producer-replaced"
).describe(
  "Immutable bounded output batch; sequence is global to the logical stream, not the per-attempt journal.",
);
export type OutputBatch = z.infer<typeof OutputBatchSchema>;
export type OutputPart = z.infer<typeof OutputPartSchema>;

export const OutputProducerSchema = describedStrictObject({
  organizationId: outputUuidSchema,
  attemptId: outputUuidSchema,
  jobId: outputUuidSchema,
  workerHostId: outputUuidSchema,
  workerSessionId: outputUuidSchema,
  workerSessionGeneration: outputSequenceSchema,
  fence: outputSequenceSchema,
}).describe(
  "Authenticated current attempt tuple constructed only after worker lease/session/fence authorization, never from caller scope.",
);
export type OutputProducer = z.infer<typeof OutputProducerSchema>;

export function canonicalOutputJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalOutputJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalOutputJson(object[key])}`
      ).join(",")
    }}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("OUTPUT_JSON_INVALID");
  return result;
}
export async function outputDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalOutputJson(value));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
