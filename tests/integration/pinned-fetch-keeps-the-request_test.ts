import { assert, assertEquals } from "@std/assert";
import { request as httpRequest } from "node:http";
import type { request as httpsRequest } from "node:https";
import {
  allowAnyAddress,
  createPinnedFetch,
  otlpProvider,
} from "../../apps/server/src/platform/telemetry-destinations/index.ts";

/**
 * The pinned fetch must send exactly the request it was given: the same path
 * and query, the same Host and headers, the same body. Only the address it dials
 * is chosen by the lookup. A real receiver on loopback proves it; the request is
 * sent over plain http so no certificate is needed, and the lookup returns the
 * vetted loopback address the way the guarded lookup returns a checked one.
 */

type Seen = {
  method: string;
  target: string;
  host: string | null;
  authorization: string | null;
  contentLength: string | null;
  body: string;
};

function receiver(answer: () => string) {
  const seen: Seen[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        target: url.pathname + url.search,
        host: request.headers.get("host"),
        authorization: request.headers.get("authorization"),
        contentLength: request.headers.get("content-length"),
        body: await request.text(),
      });
      return new Response(answer(), { status: 200 });
    },
  );
  return { seen, port: server.addr.port, close: () => server.shutdown() };
}

/** The https request options sent as http, to the address the lookup returns. */
const overHttp =
  ((options: Record<string, unknown>, onResponse: never) =>
    httpRequest(
      { ...options, protocol: "http:" },
      onResponse,
    )) as unknown as typeof httpsRequest;

/** Answers the way a checked lookup does: an array when the connection asks for all. */
const vettedLoopback = (dialed: string[]) =>
(
  hostname: string,
  options: { all?: boolean },
  callback: (error: Error | null, address: unknown, family?: number) => void,
) => {
  dialed.push(hostname);
  if (options.all === true) {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  } else callback(null, "127.0.0.1", 4);
};

Deno.test("a pinned send keeps the path, query, Host, headers and body, and dials only the lookup's address", async () => {
  const hook = receiver(() => "ok");
  const dialed: string[] = [];
  try {
    const pinned = createPinnedFetch({
      lookup: vettedLoopback(dialed) as never,
      request: overHttp,
    });
    const response = await pinned(
      `https://collector.example.test:${hook.port}/v1/traces?signal=spans&x=1`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: "Bearer canary",
          "content-type": "application/json",
        },
        body: '{"resourceSpans":[]}',
      },
    );
    assertEquals([response.status, await response.text()], [200, "ok"]);
    assertEquals(hook.seen.length, 1);
    const [seen] = hook.seen;
    assertEquals(seen.method, "POST");
    assertEquals(seen.target, "/v1/traces?signal=spans&x=1");
    assertEquals(seen.host, `collector.example.test:${hook.port}`);
    assertEquals(seen.authorization, "Bearer canary");
    assertEquals(seen.body, '{"resourceSpans":[]}');
    assertEquals(seen.contentLength, "20");
    assertEquals(
      dialed,
      ["collector.example.test"],
      "resolved once, by the lookup",
    );
  } finally {
    await hook.close();
  }
});

Deno.test("the OTLP test send reaches /v1/traces through the pinned fetch", async () => {
  const hook = receiver(() => "{}");
  const dialed: string[] = [];
  try {
    const outcome = await otlpProvider.probe(
      {
        address: `https://collector.example.test:${hook.port}`,
        headerName: "Authorization",
        headerValue: "Bearer canary",
      },
      {
        fetch: createPinnedFetch({
          lookup: vettedLoopback(dialed) as never,
          request: overHttp,
        }),
        addressPolicy: allowAnyAddress,
      },
      AbortSignal.timeout(5_000),
    );
    assertEquals([outcome.ok, outcome.status], [true, 200]);
    assertEquals(hook.seen.map((s) => s.target), ["/v1/traces"]);
    assertEquals(hook.seen[0].authorization, "Bearer canary");
    assertEquals(hook.seen[0].host, `collector.example.test:${hook.port}`);
  } finally {
    await hook.close();
  }
});

Deno.test("a long answer is cut at the cap and the send still succeeds", async () => {
  const hook = receiver(() => "x".repeat(200_000));
  try {
    const pinned = createPinnedFetch({
      lookup: vettedLoopback([]) as never,
      request: overHttp,
      maxBodyBytes: 1_000,
    });
    const response = await pinned(
      `https://collector.example.test:${hook.port}/`,
      {
        method: "POST",
        body: "{}",
      },
    );
    assertEquals(response.status, 200);
    const text = await response.text();
    assert(
      text.length >= 1 && text.length <= 1_000 + 64 * 1024,
      String(text.length),
    );
    assert(text.length < 200_000, "the whole answer was buffered");
  } finally {
    await hook.close();
  }
});
