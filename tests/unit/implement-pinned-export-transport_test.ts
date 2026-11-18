import { assertEquals } from "@std/assert";
import { pinnedLookup } from "../../apps/server/src/modules/integrations/event-export-transport.ts";

/**
 * The security property of the outbound transport (#21, AC3).
 *
 * The dispatch path judges a set of addresses and hands them to the transport.
 * That is only worth anything if the transport connects to those addresses, so
 * the lookup is overridden to answer from the checked list and nothing else. A
 * fallback to a resolver here would be the DNS rebinding hole in one line: the
 * check would judge one address and the socket would go to another.
 */

type LookupAnswer = { addresses: string[]; error: Error | null };

function lookup(
  addresses: readonly string[],
  options: { all?: boolean } | number,
): LookupAnswer {
  const answer: LookupAnswer = { addresses: [], error: null };
  pinnedLookup(addresses)(
    "receiver.example.test",
    options,
    (...args: unknown[]) => {
      const [error, address, family] = args;
      if (error) {
        answer.error = error as Error;
        return;
      }
      if (Array.isArray(address)) {
        answer.addresses = address.map((entry: { address: string }) =>
          entry.address
        );
        return;
      }
      answer.addresses = [String(address)];
      assertEquals(family === 4 || family === 6, true);
    },
  );
  return answer;
}

Deno.test("the lookup answers from the checked addresses", () => {
  assertEquals(lookup(["93.184.216.34"], {}).addresses, ["93.184.216.34"]);
});

Deno.test("the lookup answers every checked address when asked for all", () => {
  assertEquals(
    lookup(["93.184.216.34", "93.184.216.35"], { all: true })
      .addresses,
    ["93.184.216.34", "93.184.216.35"],
  );
});

Deno.test("the lookup never answers an address that was not checked", () => {
  const answer = lookup(["10.0.0.1"], {});
  // Even a private address is answered here: refusing it is the judge's job, and
  // this function's job is only to never substitute its own answer. What it must
  // not do is invent a public address for a host it was told not to reach.
  assertEquals(answer.addresses, ["10.0.0.1"]);
  assertEquals(answer.error, null);
});

Deno.test("an empty checked set fails the connection instead of resolving", () => {
  const answer = lookup([], {});
  assertEquals(answer.addresses, []);
  assertEquals(answer.error instanceof Error, true);
});

Deno.test("the lookup reports the family of an ipv6 address", () => {
  let family: number | undefined;
  pinnedLookup(["2606:2800:220:1:248:1893:25c8:1946"])(
    "receiver.example.test",
    {},
    (...args: unknown[]) => {
      family = args[2] as number;
    },
  );
  assertEquals(family, 6);
});
