import { assert, assertEquals, assertRejects } from "@std/assert";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import type { request as httpsRequest } from "node:https";
import {
  ADDRESS_REFUSED_REASON,
  createGuardedLookup,
  createPinnedFetch,
  createPublicHttpsPolicy,
  isAddressRefusal,
  otlpProvider,
  readAnswer,
} from "../../apps/server/src/platform/telemetry-destinations/index.ts";
import {
  type AlertMessage,
  sendSignedWebhook,
} from "../../apps/server/src/platform/alerts/webhook.ts";

/**
 * A name can answer a public address to the check and a private one to the
 * connection (DNS rebinding). The send must dial only an address it checked.
 */

const message: AlertMessage = {
  id: "7a1f6f5e-8c4e-4b8b-9f43-1d8f3d6f6f10",
  type: "alert.test",
  text: "A test message.",
  sentAt: 1_800_000_000,
};
const ADDRESS = "https://hooks.example.test/alerts";

/** A resolver that answers the given lists in turn, then the last one for ever. */
function answers(...lists: string[][]) {
  let calls = 0;
  const resolve = (_host: string): Promise<readonly string[]> =>
    Promise.resolve(lists[Math.min(calls++, lists.length - 1)]);
  return { resolve, calls: () => calls };
}

/** A `node:https` request that dials through the lookup it is given, and records where. */
function dialer(reply: { chunk?: () => Buffer; status?: number } = {}) {
  const dialed: string[] = [];
  const destroyed = { count: 0 };
  const request = ((
    options: {
      hostname: string;
      lookup: (
        host: string,
        options: object,
        callback: (error: Error | null, address: string) => void,
      ) => void;
    },
    onResponse: (response: EventEmitter) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      options.lookup(
        options.hostname,
        {},
        (error: Error | null, address: string) => {
          if (error) {
            req.emit("error", error);
            return;
          }
          dialed.push(address);
          const res = Object.assign(new EventEmitter(), {
            statusCode: reply.status ?? 200,
            statusMessage: "",
            headers: {},
            destroy: () => {
              destroyed.count += 1;
              res.emit("close");
            },
          });
          onResponse(res);
          queueMicrotask(() => {
            const chunks = reply.chunk === undefined ? 1 : 20;
            for (let i = 0; i < chunks && destroyed.count === 0; i++) {
              res.emit("data", (reply.chunk ?? (() => Buffer.from("ok")))());
            }
            if (destroyed.count === 0) res.emit("end");
          });
        },
      );
    };
    return req;
  }) as unknown as typeof httpsRequest;
  return { request, dialed, destroyed };
}

const send = (
  fetcher: typeof fetch,
  resolve: (h: string) => Promise<readonly string[]>,
) =>
  sendSignedWebhook({
    address: ADDRESS,
    secret: "whsec_test",
    message,
    fetch: fetcher,
    addressPolicy: createPublicHttpsPolicy(resolve),
    signal: AbortSignal.timeout(2_000),
  });

Deno.test("a name that answers public to the check and private to the connection is refused and never dialled", async () => {
  const dns = answers(["93.184.216.34"], ["169.254.169.254"]);
  const net = dialer();
  const fetcher = createPinnedFetch({
    lookup: createGuardedLookup(dns.resolve),
    request: net.request,
  });
  const outcome = await send(fetcher, dns.resolve);
  assertEquals(outcome, {
    ok: false,
    status: null,
    reason: ADDRESS_REFUSED_REASON,
    answer: null,
  });
  assertEquals(dns.calls(), 2, "the check and the connection each asked once");
  assertEquals(net.dialed, [], "no connection was made to the private address");
});

Deno.test("the connection dials the address that was checked, not a second answer", async () => {
  const dns = answers(["93.184.216.34"]);
  const net = dialer();
  const fetcher = createPinnedFetch({
    lookup: createGuardedLookup(dns.resolve),
    request: net.request,
  });
  const outcome = await send(fetcher, dns.resolve);
  assertEquals([outcome.ok, outcome.answer], [true, "ok"]);
  assertEquals(net.dialed, ["93.184.216.34"]);
});

Deno.test("the guarded lookup refuses a private, loopback, metadata or mixed answer and hands back only vetted addresses", async () => {
  const ask = (list: string[], all = false) =>
    new Promise<{ error: Error | null; value: unknown }>((resolve) =>
      createGuardedLookup(answers(list).resolve)(
        "x.example.test",
        { all },
        ((error: Error | null, value: unknown) =>
          resolve({ error, value })) as never,
      )
    );
  for (
    const bad of [["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["::1"], [
      "93.184.216.34",
      "10.0.0.5",
    ], []]
  ) {
    const got = await ask(bad);
    assert(isAddressRefusal(got.error), JSON.stringify(bad));
  }
  const good = await ask(["93.184.216.34", "2606:4700:4700::1111"], true);
  assertEquals(good.error, null);
  assertEquals(good.value, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
});

Deno.test("the real node:https path refuses a rebound name before it connects", async () => {
  const fetcher = createPinnedFetch({
    lookup: createGuardedLookup(answers(["127.0.0.1"]).resolve),
  });
  const error = await assertRejects(() =>
    fetcher("https://rebind.example.test/", { method: "POST", body: "{}" })
  );
  assert(isAddressRefusal(error));
  // An address literal never asks the lookup, so it is checked on its own.
  assert(
    isAddressRefusal(
      await assertRejects(() =>
        fetcher("https://127.0.0.1/", { method: "POST" })
      ),
    ),
  );
  assert(
    isAddressRefusal(
      await assertRejects(() => fetcher("http://hooks.example.test/")),
    ),
  );
});

Deno.test("a receiver that keeps sending is cut off at the cap, not buffered", async () => {
  const net = dialer({ chunk: () => Buffer.alloc(4096, "a") });
  const fetcher = createPinnedFetch({
    lookup: createGuardedLookup(answers(["93.184.216.34"]).resolve),
    request: net.request,
    maxBodyBytes: 5000,
  });
  const response = await fetcher(ADDRESS, { method: "POST", body: "{}" });
  assertEquals((await response.text()).length, 5000);
  assertEquals(net.destroyed.count, 1, "the connection was dropped");
});

Deno.test("an answer is read up to the cap and the stream is cancelled", async () => {
  let cancelled = false;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new TextEncoder().encode("x".repeat(100)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const text = await readAnswer(new Response(body), 300);
  assertEquals(text.length, 300);
  assert(cancelled, "the rest of the stream was not read");
  assert(pulled < 10, "pulled " + pulled);
  assertEquals(await readAnswer(new Response(null), 300), "");
});

Deno.test("the OTLP test reads a rebound name as a refusal too", async () => {
  const dns = answers(["93.184.216.34"], ["10.0.0.7"]);
  const net = dialer();
  const outcome = await otlpProvider.probe(
    { address: "https://collector.example.test" },
    {
      fetch: createPinnedFetch({
        lookup: createGuardedLookup(dns.resolve),
        request: net.request,
      }),
      addressPolicy: createPublicHttpsPolicy(dns.resolve),
    },
    AbortSignal.timeout(2_000),
  );
  assertEquals([outcome.ok, outcome.reason], [false, ADDRESS_REFUSED_REASON]);
  assertEquals(net.dialed, []);
});
