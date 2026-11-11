import { assert, assertEquals } from "@std/assert";
import {
  applyOutputFrame,
  emptyOutputReplay,
  OUTPUT_WINDOW_BYTES,
} from "../../apps/web/src/api/output-replay.ts";
import type { OutputSocketServerFrame } from "../../packages/contracts/src/client.ts";
const streamId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const batch = (sequence: string, text = "line"): OutputSocketServerFrame => ({
  type: "output.batch",
  requestId,
  streamId,
  batch: {
    sessionId: streamId,
    writerGeneration: "1",
    batchId: crypto.randomUUID(),
    sequence,
    parts: [{ itemId: crypto.randomUUID(), channel: "stdout", text }],
    capture: "capturing",
    reason: null,
    digest: "a".repeat(64),
  },
});
Deno.test("output replay resumes lost cursor without duplicate lines", () => {
  let state = applyOutputFrame(emptyOutputReplay(streamId), batch("1"));
  state = applyOutputFrame(state, {
    type: "output.cursor",
    requestId,
    streamId,
    cursor: "opaque-1",
    highwater: "3",
  });
  state = applyOutputFrame(state, batch("2"));
  state = applyOutputFrame(state, batch("2"));
  assertEquals(state.batches.length, 2);
  assertEquals(state.cursor, "opaque-1");
  state = applyOutputFrame(state, batch("3"));
  assertEquals(state.sequence, "3");
});
Deno.test("output replay never acknowledges a hole or another stream", () => {
  let state = emptyOutputReplay(streamId);
  state = applyOutputFrame(state, {
    ...batch("1"),
    streamId: crypto.randomUUID(),
  });
  assertEquals(state.sequence, "0");
  state = applyOutputFrame(state, batch("2"));
  state = applyOutputFrame(state, {
    type: "output.cursor",
    requestId,
    streamId,
    cursor: "skip-hole",
    highwater: "2",
  });
  assert(state.gap);
  assertEquals(state.cursor, null);
  assertEquals(state.batches.length, 0);
});
Deno.test("expired history stops replay and cannot become complete", () => {
  let state = applyOutputFrame(emptyOutputReplay(streamId), {
    type: "output.reset_required",
    requestId,
    streamId,
    cursor: "reset",
    retainedFrom: "10",
    resumeAfter: "9",
    highwater: "20",
  });
  state = applyOutputFrame(state, batch("10"));
  assert(state.reset);
  assertEquals(state.batches.length, 0);
  assertEquals(state.cursor, null);
});
Deno.test("browser output window stays bounded without losing sequence dedupe", () => {
  let state = emptyOutputReplay(streamId);
  for (let n = 1; n <= 100; n++) {
    state = applyOutputFrame(state, batch(String(n), "x".repeat(16000)));
  }
  assert(state.windowed);
  assert(state.bytes <= OUTPUT_WINDOW_BYTES);
  const count = state.batches.length;
  state = applyOutputFrame(state, batch("1"));
  assertEquals(state.batches.length, count);
  assertEquals(state.sequence, "100");
});
