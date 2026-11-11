import { assertEquals } from "@std/assert";
import {
  HarnessKillTracker,
  pumpHarnessOutput,
} from "../../apps/worker/src/harness-common.ts";
import type {
  NativeOutputChannel,
  NativeOutputSink,
} from "../../apps/worker/src/native-output.ts";

/** Records sink calls; only write and sourceLost matter to the pump. */
function recordingSink() {
  const events: string[] = [];
  const sink = {
    write: (channel: NativeOutputChannel) => {
      events.push(`write:${channel}`);
      return Promise.resolve();
    },
    sourceLost: (channel: NativeOutputChannel, reason?: string) => {
      events.push(`lost:${channel}:${reason}`);
      return Promise.resolve();
    },
  } as unknown as NativeOutputSink;
  return { sink, events };
}

/** A stream whose EOF the test releases explicitly, after any kill. */
function gatedStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  return {
    stream,
    emit: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    eof: () => controller.close(),
  };
}

Deno.test("leader exited, then group sweep, then EOF: capture is not source-lost", async () => {
  const kills = new HarnessKillTracker();
  const { sink, events } = recordingSink();
  const source = gatedStream();
  const pump = pumpHarnessOutput(
    source.stream,
    "stdout",
    sink,
    kills.cutLiveLeader,
    undefined,
  );
  source.emit("tail");
  kills.markExited();
  assertEquals(kills.markKilled(), true); // post-exit sweep
  source.eof(); // EOF is read only after the sweep
  await pump;
  assertEquals(events, ["write:stdout"]);
});

Deno.test("group kill of a live leader still reports source-lost", async () => {
  const kills = new HarnessKillTracker();
  const { sink, events } = recordingSink();
  const source = gatedStream();
  const pump = pumpHarnessOutput(
    source.stream,
    "stdout",
    sink,
    kills.cutLiveLeader,
    undefined,
  );
  source.emit("partial");
  kills.markKilled(); // leader has not exited
  kills.markExited(); // exiting later does not undo the cut
  source.eof();
  await pump;
  assertEquals(events, ["write:stdout", "lost:stdout:kill"]);
});

Deno.test("only the first kill decides", () => {
  const kills = new HarnessKillTracker();
  kills.markKilled();
  kills.markExited();
  assertEquals(kills.markKilled(), false);
  assertEquals(kills.cutLiveLeader(), true);
});
