// A worker whose start outlasts the work budget and also a systemd backstop
// sized from the work term alone (3 s), as a very slow cold start does.
// Nothing has been read from the parent yet, so the delay is not the
// client's. After READY it is the real worker.
import {
  decodeFrames,
  encodeFrames,
  executeDraftWorkerFrames,
} from "../../../apps/server/src/modules/knowledge/draft-import-worker.ts";

await new Promise((resolve) => setTimeout(resolve, 3_000));
await Deno.stdout.write(new TextEncoder().encode("READY\n"));
const input = new Uint8Array(
  await new Response(Deno.stdin.readable).arrayBuffer(),
);
const output = await executeDraftWorkerFrames(decodeFrames(input));
await Deno.stdout.write(encodeFrames(output));
