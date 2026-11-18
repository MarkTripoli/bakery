import { assertEquals } from "@std/assert";
import {
  armDeadline,
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
  // died. The total deadline is now real.
  //
  // Driven through `armDeadline` rather than a real listener. The unit lane runs
  // with `--allow-env --allow-read` only, so `Deno.listen` throws NotCapable
  // there: a test that needs net permission fails on the lane it belongs to, and
  // a suite that only passes locally is worse than no suite. What the deadline
  // has to do is end an exchange that produces no events at all, which is exactly
  // what this exercises.
  let expired = 0;
  const started = Date.now();
  const disarm = armDeadline(30, () => {
    expired += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assertEquals(expired, 1);
  assertEquals(Date.now() - started >= 20, true);

  // And a disarmed deadline never fires, so a fast exchange is not cut off by a
  // timer it outran.
  let lateExpiries = 0;
  const disarmEarly = armDeadline(20, () => {
    lateExpiries += 1;
  });
  disarmEarly();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(lateExpiries, 0);
  disarm();
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

Deno.test("the transport refuses an empty pinned set instead of resolving", async () => {
  // The rebinding defence is that the transport answers ONLY from the addresses
  // already judged. An empty set must fail, not fall back to the system resolver:
  // a fallback would re-resolve a name the judge never saw, which is the attack.
  const transport = createPinnedHttpsTransport({ timeoutMs: 100 });
  const outcome = await transport.send({
    origin: "https://receiver.invalid",
    path: "/hook",
    addresses: [],
    raw: new TextEncoder().encode("{}"),
    headers: {},
  });
  // Refused, not uncertain: nothing left this process, so retrying cannot help
  // and `uncertain` would retry forever.
  assertEquals(outcome.kind, "refused");
});
