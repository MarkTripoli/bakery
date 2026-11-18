import { assertEquals } from "@std/assert";
import {
  createPinnedHttpsTransport,
  createResponseHandler,
  outcomeFor,
  pinnedLookup,
  RESPONSE_DRAIN_LIMIT,
} from "../../apps/server/src/modules/integrations/event-export-transport.ts";

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

Deno.test("a 3xx is refused, not retried", () => {
  // The transport does not follow redirects, so a redirect is the receiver
  // answering "not here". Retrying the same request cannot change that, so it is
  // refused rather than uncertain - uncertain would retry it forever.
  assertEquals(outcomeFor(301), { kind: "refused", status: 301 });
  assertEquals(outcomeFor(302), { kind: "refused", status: 302 });
  assertEquals(outcomeFor(204), { kind: "acknowledged", status: 204 });
  assertEquals(outcomeFor(400), { kind: "refused", status: 400 });
  assertEquals(outcomeFor(500), { kind: "uncertain", reason: "server_error" });
});

Deno.test("a server that never answers cannot hold the send", async () => {
  // QA probed this: `void RESPONSE_DRAIN_LIMIT` declared a limit and enforced
  // nothing, so a receiver that never finished held send() open until the socket
  // died. The total deadline is now real, and this proves it: the listener
  // accepts the connection and then says nothing at all, so no socket idle
  // timeout can fire and only the deadline can end the attempt.
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const { port } = listener.addr as { port: number };
  const accepted: Deno.Conn[] = [];
  const accept = (async () => {
    try {
      for await (const connection of listener) accepted.push(connection);
    } catch {
      // The listener closes when the test ends.
    }
  })();

  try {
    const started = Date.now();
    const outcome = await createPinnedHttpsTransport({ timeoutMs: 1_000 }).send(
      {
        origin: `https://127.0.0.1:${port}`,
        path: "/silent",
        addresses: ["127.0.0.1"],
        raw: new Uint8Array([123, 125]),
        headers: {},
      },
    );
    const elapsed = Date.now() - started;
    assertEquals(outcome.kind, "uncertain");
    // Bounded by the deadline, not by the server deciding to answer.
    assertEquals(elapsed < 5_000, true, `took ${elapsed}ms`);
  } finally {
    for (const connection of accepted) {
      try {
        connection.close();
      } catch {
        // Already closed.
      }
    }
    listener.close();
    await accept;
  }
});

Deno.test("a receiver streaming forever is cut off at the byte cap", () => {
  // QA probed this: `void RESPONSE_DRAIN_LIMIT` declared a limit and enforced
  // nothing. The handler is now exercised directly, because the cap is the whole
  // point and a TLS server is not needed to prove it.
  const outcomes: unknown[] = [];
  let destroyed = false;
  const listeners: Record<string, ((chunk?: unknown) => void)[]> = {};
  const response = {
    statusCode: 200,
    on(event: string, listener: (chunk?: unknown) => void) {
      (listeners[event] ??= []).push(listener);
    },
    destroy() {
      destroyed = true;
    },
    resume() {},
  };
  createResponseHandler(200, (outcome) => outcomes.push(outcome))(
    response as never,
  );

  // A receiver that never ends, one chunk at a time.
  const chunk = { length: 1_024 };
  for (let sent = 0; sent < 64; sent += 1) {
    for (const listener of listeners["data"] ?? []) listener(chunk);
  }

  assertEquals(destroyed, true);
  assertEquals(outcomes, [
    { kind: "uncertain", reason: "response_too_large" },
  ]);
  // The cap is a bound, not a comment.
  assertEquals(RESPONSE_DRAIN_LIMIT > 0, true);
  assertEquals(RESPONSE_DRAIN_LIMIT <= 64 * 1024, true);
});
