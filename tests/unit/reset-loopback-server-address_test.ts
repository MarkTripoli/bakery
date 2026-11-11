import { assert, assertEquals } from "@std/assert";
import { isLoopbackServerAddress } from "../../apps/server/src/platform/migrate.ts";

Deno.test("loopback server address accepts bare loopback and unix socket", () => {
  assert(isLoopbackServerAddress("127.0.0.1"));
  assert(isLoopbackServerAddress("::1"));
  assert(isLoopbackServerAddress(null));
  assert(isLoopbackServerAddress(undefined));
});

Deno.test("loopback server address rejects other hosts and prefixed forms", () => {
  for (
    const address of [
      "10.0.0.5",
      "172.17.0.2",
      "192.168.1.1",
      "2001:db8::1",
      "127.0.0.1/32",
      "::1/128",
    ]
  ) assertEquals(isLoopbackServerAddress(address), false, address);
});
