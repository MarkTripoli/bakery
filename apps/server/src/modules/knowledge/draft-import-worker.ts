import {
  applyDraftEditCandidate,
  createDraftSliceCandidate,
  createInitialDraftCandidate,
  DRAFT_LIMITS,
  DraftCandidateError,
} from "./drafts.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_PROTOCOL_BYTES = DRAFT_LIMITS.stateBytes * 2 +
  DRAFT_LIMITS.bodyBytes + DRAFT_LIMITS.replacementBytes * 2 +
  DRAFT_LIMITS.metadataBytes + 64;

type Frame = Uint8Array;

function encodeFrames(frames: readonly Uint8Array[]): Uint8Array {
  const length = frames.reduce((total, frame) => total + 4 + frame.length, 0);
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, false);
    offset += 4;
    output.set(frame, offset);
    offset += frame.length;
  }
  return output;
}

function decodeFrames(value: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  let offset = 0;
  while (offset < value.length) {
    if (offset + 4 > value.length) throw new Error("PROTOCOL_HEADER_TRUNCATED");
    const length = view.getUint32(offset, false);
    offset += 4;
    if (offset + length > value.length) {
      throw new Error("PROTOCOL_FRAME_TRUNCATED");
    }
    frames.push(value.slice(offset, offset + length));
    offset += length;
  }
  return frames;
}

async function readAllBounded(): Promise<Uint8Array> {
  const reader = Deno.stdin.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > MAX_PROTOCOL_BYTES) {
        throw new Error("PROTOCOL_INPUT_OVERFLOW");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const value = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.length;
  }
  return value;
}

function metadata(frame: Uint8Array): Record<string, unknown> {
  if (frame.length === 0 || frame.length > DRAFT_LIMITS.metadataBytes) {
    throw new Error("PROTOCOL_METADATA_SIZE_INVALID");
  }
  const parsed = JSON.parse(decoder.decode(frame));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PROTOCOL_METADATA_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function text(frame: Uint8Array, limit: number, label: string): string {
  if (frame.length > limit) throw new Error(`${label}_FRAME_TOO_LARGE`);
  return decoder.decode(frame);
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string {
  const result = value[field];
  if (typeof result !== "string") throw new Error(`METADATA_${field}_INVALID`);
  return result;
}

function numberField(
  value: Record<string, unknown>,
  field: string,
): number {
  const result = value[field];
  if (!Number.isSafeInteger(result)) {
    throw new Error(`METADATA_${field}_INVALID`);
  }
  return result as number;
}

async function execute(frames: readonly Frame[]): Promise<Uint8Array[]> {
  if (frames.length === 0) throw new Error("PROTOCOL_METADATA_MISSING");
  const meta = metadata(frames[0]);
  switch (meta.operation) {
    case "initialize": {
      if (frames.length !== 2) throw new Error("PROTOCOL_FRAME_COUNT_INVALID");
      const candidate = await createInitialDraftCandidate(
        text(frames[1], DRAFT_LIMITS.bodyBytes, "BODY"),
      );
      return [
        encoder.encode(JSON.stringify({
          ok: true,
          operation: "initialize",
          textDigest: candidate.textDigest,
          updateDigest: candidate.updateDigest,
        })),
        candidate.state,
        candidate.update,
        candidate.frontiers,
        encoder.encode(candidate.text),
      ];
    }
    case "edit": {
      if (frames.length !== 5) throw new Error("PROTOCOL_FRAME_COUNT_INVALID");
      const expectedText = text(
        frames[3],
        DRAFT_LIMITS.replacementBytes,
        "EXPECTED_TEXT",
      );
      const replacement = text(
        frames[4],
        DRAFT_LIMITS.replacementBytes,
        "REPLACEMENT",
      );
      const candidate = await applyDraftEditCandidate(frames[2], frames[1], {
        mutationId: stringField(meta, "mutationId"),
        startCursor: stringField(meta, "startCursor"),
        endCursor: stringField(meta, "endCursor"),
        expectedText,
        expectedDigest: stringField(meta, "expectedDigest"),
        replacement,
      });
      return [
        encoder.encode(JSON.stringify({
          ok: true,
          operation: "edit",
          textDigest: candidate.textDigest,
          updateDigest: candidate.updateDigest,
        })),
        candidate.state,
        candidate.update,
        candidate.frontiers,
        encoder.encode(candidate.text),
      ];
    }
    case "slice": {
      if (frames.length !== 2) throw new Error("PROTOCOL_FRAME_COUNT_INVALID");
      const candidate = await createDraftSliceCandidate(
        frames[1],
        numberField(meta, "startUtf16"),
        numberField(meta, "endUtf16"),
      );
      return [
        encoder.encode(JSON.stringify({
          ok: true,
          operation: "slice",
          textDigest: candidate.textDigest,
          startCursor: candidate.startCursor,
          endCursor: candidate.endCursor,
        })),
        encoder.encode(candidate.text),
      ];
    }
    default:
      throw new Error("PROTOCOL_OPERATION_INVALID");
  }
}

async function main(): Promise<void> {
  await Deno.stdout.write(encoder.encode("READY\n"));
  let output: Uint8Array[];
  try {
    output = await execute(decodeFrames(await readAllBounded()));
  } catch (error) {
    const candidate = error instanceof DraftCandidateError;
    output = [encoder.encode(JSON.stringify({
      ok: false,
      kind: candidate ? error.kind : "protocol",
      message: error instanceof Error ? error.message.slice(0, 256) : "error",
    }))];
  }
  if (output[0].length > DRAFT_LIMITS.metadataBytes) {
    throw new Error("PROTOCOL_OUTPUT_METADATA_OVERFLOW");
  }
  await Deno.stdout.write(encodeFrames(output));
}

if (import.meta.main) await main();

export { decodeFrames, encodeFrames, execute as executeDraftWorkerFrames };
