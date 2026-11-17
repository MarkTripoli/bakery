import { assert, assertEquals } from "@std/assert";
import {
  bindLoopbackCandidate,
  isLoopbackBandPort,
  probeLoopbackPort,
} from "../fixtures/loopback-port-allocation.ts";

// The unit lane grants no `--allow-net`, so its tests inject the bind. This
// lane has net, so it proves the real path: the default bind actually opens a
// socket, and a port held by a real listener is skipped rather than returned.
Deno.test("the real bind draws a free port from the band", () => {
  const port = probeLoopbackPort();
  assert(isLoopbackBandPort(port), `drew ${port}, outside the band`);
  // The draw released the socket, so the same port binds again.
  bindLoopbackCandidate(port);
});

Deno.test("a port held by a real listener is skipped", () => {
  const held = probeLoopbackPort();
  const listener = Deno.listen({ hostname: "127.0.0.1", port: held });
  try {
    const candidates = [held, held + 1];
    const selected = probeLoopbackPort(() => candidates.shift()!, 4);
    assert(selected !== held, `returned the held port ${held}`);
    assertEquals(selected, held + 1);
  } finally {
    listener.close();
  }
});
