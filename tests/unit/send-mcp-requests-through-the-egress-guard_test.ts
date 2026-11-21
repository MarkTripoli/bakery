import { assert, assertEquals } from "@std/assert";
import { EventEmitter } from "node:events";
import { httpsMcpTransport } from "../../apps/server/src/modules/mcp/discovery-transport.ts";
import { EGRESS_REFUSED } from "../../apps/server/src/modules/execution/provider-egress.ts";

/**
 * The MCP transport without a network (#434): what it sends, how much of an answer
 * it will read, and that an address the guard refuses is refused before any request.
 * The stubbed `request` stands in for `node:https`.
 */

type Sent = { options: Record<string, unknown>; body: string | null };

/** A `node:https` request stand-in that answers from a script and records the call. */
function fakeRequest(
  respond: (
    reply: (
      status: number,
      headers: Record<string, string>,
      chunks: string[],
    ) => void,
    fail: (error: Error & { code?: string }) => void,
  ) => void,
) {
  const sent: Sent[] = [];
  const request =
    ((options: Record<string, unknown>, onResponse: (r: unknown) => void) => {
      const record: Sent = { options, body: null };
      sent.push(record);
      const req = new EventEmitter() as EventEmitter & {
        end: (body?: string) => void;
      };
      req.end = (body?: string) => {
        record.body = body ?? null;
        queueMicrotask(() =>
          respond(
            (status, headers, chunks) => {
              const response = new EventEmitter() as EventEmitter & {
                statusCode: number;
                headers: Record<string, string>;
                destroy: () => void;
              };
              response.statusCode = status;
              response.headers = headers;
              response.destroy = () => {};
              onResponse(response);
              for (const chunk of chunks) {
                response.emit(
                  "data",
                  new TextEncoder().encode(chunk),
                );
              }
              response.emit("end");
            },
            (error) => req.emit("error", error),
          )
        );
      };
      return req;
    }) as never;
  return { request, sent };
}

const ENDPOINT = "https://mcp.example.com/mcp?region=eu";
const input = (signal = AbortSignal.timeout(5000)) => ({
  endpoint: ENDPOINT,
  headers: { authorization: "Bearer t", "content-type": "application/json" },
  body: '{"jsonrpc":"2.0"}',
  signal,
});

Deno.test("it posts the body to the endpoint's path and query, through the guarded lookup, with no agent reuse", async () => {
  const lookup = (() => {}) as never;
  const { request, sent } = fakeRequest((reply) =>
    reply(
      200,
      { "content-type": "application/json", "mcp-session-id": "s-1" },
      ['{"ok":', "true}"],
    )
  );
  const result = await httpsMcpTransport({ request, lookup })(input());
  assertEquals(result.kind, "response");
  if (result.kind === "response") {
    assertEquals(result.status, 200);
    assertEquals(result.body, '{"ok":true}');
    assertEquals(result.contentType, "application/json");
    assertEquals(result.sessionId, "s-1");
  }
  const options = sent[0].options as Record<string, unknown> & {
    headers: Record<string, string>;
  };
  assertEquals(options.method, "POST");
  assertEquals(options.protocol, "https:");
  assertEquals(options.hostname, "mcp.example.com");
  assertEquals(options.port, 443);
  assertEquals(options.path, "/mcp?region=eu");
  assertEquals(options.agent, false);
  // The address is chosen and checked in the connection's own lookup.
  assert(options.lookup === lookup);
  assertEquals(options.headers.authorization, "Bearer t");
  assertEquals(options.headers["content-length"], "17");
  assertEquals(sent[0].body, '{"jsonrpc":"2.0"}');
});

Deno.test("a redirect is returned as it is, never followed", async () => {
  const { request, sent } = fakeRequest((reply) =>
    reply(302, { location: "https://elsewhere.example.com/" }, [])
  );
  const result = await httpsMcpTransport({ request })(input());
  assertEquals(result.kind === "response" && result.status, 302);
  // One request only: nothing chased the Location.
  assertEquals(sent.length, 1);
});

Deno.test("an answer past the byte cap is refused, not buffered", async () => {
  const { request } = fakeRequest((reply) =>
    reply(200, { "content-type": "application/json" }, [
      "x".repeat(600),
      "y".repeat(600),
    ])
  );
  const result = await httpsMcpTransport({ request, maxBytes: 1000 })(input());
  assertEquals(result.kind, "too_large");
  // At the cap is accepted.
  const exact = fakeRequest((reply) =>
    reply(200, { "content-type": "application/json" }, ["x".repeat(1000)])
  );
  const ok = await httpsMcpTransport({
    request: exact.request,
    maxBytes: 1000,
  })(input());
  assertEquals(ok.kind, "response");
});

Deno.test("an address the guard refuses never gets a request", async () => {
  for (
    const endpoint of [
      "https://127.0.0.1/mcp",
      "https://10.1.2.3/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/mcp",
    ]
  ) {
    const { request, sent } = fakeRequest((reply) => reply(200, {}, ["{}"]));
    const result = await httpsMcpTransport({ request })({
      ...input(),
      endpoint,
    });
    assertEquals(result.kind, "refused", endpoint);
    assertEquals(sent.length, 0, endpoint);
  }
});

Deno.test("a refused resolution, a timeout and a network error are named differently", async () => {
  const cases: [string, Error & { code?: string }, string][] = [
    [
      "a refused resolution",
      Object.assign(new Error("x"), { code: EGRESS_REFUSED }),
      "refused",
    ],
    [
      "a timed-out connect",
      Object.assign(new Error("x"), { code: "ETIMEDOUT" }),
      "timeout",
    ],
    [
      "an abort",
      Object.assign(new Error("x"), { name: "AbortError" }),
      "timeout",
    ],
    [
      "a reset",
      Object.assign(new Error("x"), { code: "ECONNRESET" }),
      "network_error",
    ],
  ];
  for (const [name, error, kind] of cases) {
    const { request } = fakeRequest((_reply, fail) => fail(error));
    const result = await httpsMcpTransport({ request })(input());
    assertEquals(result.kind, kind, name);
  }
  // The caller's deadline, already passed, is a timeout.
  const controller = new AbortController();
  controller.abort();
  const { request } = fakeRequest((_reply, fail) => fail(new Error("x")));
  assertEquals(
    (await httpsMcpTransport({ request })(input(controller.signal))).kind,
    "timeout",
  );
});
