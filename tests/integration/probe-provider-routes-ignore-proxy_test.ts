import { assert, assertEquals } from "@std/assert";
import { guardedLookup } from "../../apps/server/src/modules/execution/provider-egress.ts";
import { httpsProbeTransport } from "../../apps/server/src/modules/execution/provider-probe.ts";

/**
 * The probe does not route through a proxy (#26 slice 3).
 *
 * A proxy resolves names itself, so a request sent through one would skip the
 * guarded lookup, and an administrator-typed endpoint could reach an internal
 * address that way. This needs a loopback listener, so it lives in the lane that
 * has network access; it needs no database.
 */

Deno.test("an HTTPS_PROXY in the environment is not used: the guarded lookup still resolves the name", async () => {
  // A proxy would resolve names itself and skip `guardedLookup`, so an
  // administrator-typed endpoint could reach an internal address through it. The
  // listener below stands in for such a proxy: if the probe used it, it would
  // receive a connection, and the lookup below would never be asked.
  const proxy = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  let proxied = 0;
  const accepting = (async () => {
    try {
      for await (const connection of proxy) {
        proxied += 1;
        connection.close();
      }
    } catch {
      // The listener was closed.
    }
  })();
  const port = (proxy.addr as Deno.NetAddr).port;
  const saved = new Map<string, string | undefined>();
  const names = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
  for (const name of names) {
    saved.set(name, Deno.env.get(name));
    Deno.env.delete(name);
  }
  Deno.env.set("HTTPS_PROXY", `http://127.0.0.1:${port}`);
  Deno.env.set("https_proxy", `http://127.0.0.1:${port}`);
  Deno.env.set("HTTP_PROXY", `http://127.0.0.1:${port}`);
  try {
    let lookups = 0;
    const transport = httpsProbeTransport({
      deadlineMs: 2_000,
      lookup: guardedLookup((_hostname) => {
        lookups += 1;
        return Promise.resolve([{ address: "10.0.0.1", family: 4 }]);
      }),
    });
    assertEquals(await transport("https://api.provider.example/v1"), {
      kind: "refused",
    });
    // The name went through our lookup, and nothing reached the proxy.
    assert(lookups > 0, "the guarded lookup was not consulted");
    assertEquals(proxied, 0);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    proxy.close();
    await accepting;
  }
});
