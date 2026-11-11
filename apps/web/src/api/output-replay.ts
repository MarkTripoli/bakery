import type { OutputSocketServerFrame } from "@bakery/contracts/client";
import type { OutputBatch } from "@bakery/contracts/output";

export const OUTPUT_WINDOW_BYTES = 1024 * 1024;
export type OutputReplay = Readonly<{
  streamId: string;
  sequence: string;
  cursor: string | null;
  batches: readonly OutputBatch[];
  bytes: number;
  windowed: boolean;
  reset: boolean;
  gap: boolean;
}>;

export function emptyOutputReplay(streamId: string): OutputReplay {
  return {
    streamId,
    sequence: "0",
    cursor: null,
    batches: [],
    bytes: 0,
    windowed: false,
    reset: false,
    gap: false,
  };
}

/** Only a contiguous applied prefix can accept the server's opaque cursor. */
export function applyOutputFrame(
  state: OutputReplay,
  frame: OutputSocketServerFrame,
): OutputReplay {
  if (frame.streamId !== state.streamId || state.reset || state.gap) {
    return state;
  }
  if (frame.type === "output.reset_required") return { ...state, reset: true };
  if (frame.type === "output.cursor") return { ...state, cursor: frame.cursor };
  const batch = frame.batch;
  if (batch.sessionId !== state.streamId) return { ...state, gap: true };
  if (BigInt(batch.sequence) <= BigInt(state.sequence)) return state;
  if (BigInt(batch.sequence) !== BigInt(state.sequence) + 1n) {
    return { ...state, gap: true };
  }
  const batches = [...state.batches, batch];
  let bytes = state.bytes +
    new TextEncoder().encode(JSON.stringify(batch)).byteLength;
  let windowed = state.windowed;
  while (bytes > OUTPUT_WINDOW_BYTES && batches.length > 1) {
    const removed = batches.shift();
    bytes -= new TextEncoder().encode(JSON.stringify(removed)).byteLength;
    windowed = true;
  }
  return { ...state, sequence: batch.sequence, batches, bytes, windowed };
}
