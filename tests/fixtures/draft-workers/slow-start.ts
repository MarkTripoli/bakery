// A worker whose start alone outlasts the work budget, as a cold Deno start
// does on a busy host: nothing has been read from the parent yet, so the
// delay is not the client's. After READY it is the real worker.
import {
  decodeFrames,
  encodeFrames,
  executeDraftWorkerFrames,
} from "../../../apps/server/src/modules/knowledge/draft-import-worker.ts";

await new Promise((resolve) => setTimeout(resolve, 1_300));
await Deno.stdout.write(new TextEncoder().encode("READY\n"));
const input = new Uint8Array(
  await new Response(Deno.stdin.readable).arrayBuffer(),
);
const output = await executeDraftWorkerFrames(decodeFrames(input));
await Deno.stdout.write(encodeFrames(output));
