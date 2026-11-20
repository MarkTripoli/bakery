import { assert, assertEquals } from "@std/assert";
import { EventEmitter } from "node:events";
import {
  EGRESS_REFUSED,
  endpointHostIsRefused,
  guardedLookup,
  type ResolvedAddress,
} from "../../apps/server/src/modules/execution/provider-egress.ts";
import {
  classifyProbe,
  createProviderProbeWorkflow,
  httpsProbeTransport,
  nextProbeAt,
  parseRetryAfter,
  PROBE_OPENS_INCIDENTS,
  PROVIDER_PROBE_CRON,
} from "../../apps/server/src/modules/execution/provider-probe.ts";
import { captureFunction } from "../helpers/ticket-admission/automation-fixtures.ts";

/**
 * The provider probe without a database or a network (#26 slice 3).
 *
 * What these pin: the incident vocabulary a response maps to (and the ones a
 * credential-less probe must never report), the backoff schedule, and the egress
 * rule: a name that resolves to a non-public address is refused at the connect,
 * not trusted because its text looked public.
 */

const NOW = new Date("2026-11-19T12:00:00.000Z");
const WATERMARK = "probe:1";
const fixedRandom = (value: number) => () => value;

// -- classification ---------------------------------------------------------

Deno.test("a response is classified into the incident vocabulary", () => {
  const classify = (
    result: Parameters<typeof classifyProbe>[0],
  ) => classifyProbe(result, WATERMARK, NOW);
  const failureOf = (result: Parameters<typeof classifyProbe>[0]) => {
    const classified = classify(result);
    assertEquals(classified.kind, "outcome");
    if (
      classified.kind !== "outcome" || classified.outcome.kind !== "failure"
    ) {
      throw new Error("expected a failure");
    }
    return classified.outcome;
  };
  assertEquals(failureOf({ kind: "timeout" }).reason, "timeout");
  assertEquals(failureOf({ kind: "timeout" }).severity, "outage");
  assertEquals(
    failureOf({ kind: "network_error" }).reason,
    "transport_failure",
  );
  for (const status of [500, 502, 503, 504, 599]) {
    const outcome = failureOf({ kind: "response", status, retryAfter: null });
    assertEquals(outcome.reason, "provider_error", String(status));
    assertEquals(outcome.severity, "outage");
  }
  const limited = failureOf({ kind: "response", status: 429, retryAfter: "7" });
  assertEquals(limited.reason, "rate_limited");
  assertEquals(limited.severity, "degraded");
  assertEquals(classify({ kind: "refused" }), { kind: "refused" });
});

Deno.test("an answer below 500 is reachable and nothing more, and never a credential or quota verdict", () => {
  // 401 and 403 are the normal answers to an unauthenticated read; 404 is a
  // provider with no route at its base. None of them says anything about a
  // credential, so none may become `credential_invalid` or `quota_exhausted`.
  for (const status of [200, 204, 400, 401, 402, 403, 404, 418]) {
    const classified = classifyProbe(
      { kind: "response", status, retryAfter: null },
      WATERMARK,
      NOW,
    );
    assertEquals(classified.kind, "outcome", String(status));
    if (classified.kind === "outcome") {
      assertEquals(classified.outcome.kind, "reachable", String(status));
    }
  }
});

Deno.test("a redirect is its own outcome and proves nothing", () => {
  // The probe follows none, so it cannot say the real endpoint is up (not
  // reachable) and the host did answer (not a failure). Every 3xx, including the
  // ones that look harmless (304) and the ones that preserve the method (307, 308).
  for (const status of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
    const classified = classifyProbe(
      { kind: "response", status, retryAfter: "30" },
      WATERMARK,
      NOW,
    );
    assertEquals(
      classified,
      {
        kind: "outcome",
        outcome: { kind: "redirected", evidenceWatermark: WATERMARK },
        // A redirect is not a slowdown: Retry-After is not honoured on it.
        retryAfterMs: null,
      },
      String(status),
    );
  }
  // The edges: 299 is still an answer, and 400 is still reachable.
  for (const status of [299, 400]) {
    const classified = classifyProbe(
      { kind: "response", status, retryAfter: null },
      WATERMARK,
      NOW,
    );
    assert(
      classified.kind === "outcome" && classified.outcome.kind === "reachable",
      String(status),
    );
  }
});

Deno.test("a redirected probe is looked at again on the steady interval", () => {
  const delay = nextProbeAt(
    { kind: "redirected", evidenceWatermark: WATERMARK },
    3,
    null,
    NOW,
    fixedRandom(0.5),
  ).getTime() - NOW.getTime();
  assertEquals(delay, 300_000);
});

Deno.test("the watermark names the evidence and is carried through unchanged", () => {
  const classified = classifyProbe({ kind: "timeout" }, "probe:abc", NOW);
  assert(classified.kind === "outcome");
  assertEquals(classified.outcome.evidenceWatermark, "probe:abc");
});

// -- Retry-After ------------------------------------------------------------

Deno.test("Retry-After is read as seconds or a date, capped, and ignored when unusable", () => {
  assertEquals(parseRetryAfter("7", NOW), 7_000);
  assertEquals(parseRetryAfter(" 120 ", NOW), 120_000);
  assertEquals(parseRetryAfter("0", NOW), 0);
  assertEquals(
    parseRetryAfter("Thu, 19 Nov 2026 12:01:00 GMT", NOW),
    60_000,
  );
  // A provider cannot park a route for a day.
  assertEquals(parseRetryAfter("86400", NOW), 3_600_000);
  assertEquals(parseRetryAfter(null, NOW), null);
  assertEquals(parseRetryAfter("soon", NOW), null);
  assertEquals(parseRetryAfter("-5", NOW), null);
  // A date in the past is not a wait.
  assertEquals(parseRetryAfter("Thu, 19 Nov 2026 11:00:00 GMT", NOW), null);
});

// -- backoff ----------------------------------------------------------------

const failure = {
  kind: "failure" as const,
  reason: "timeout" as const,
  severity: "outage" as const,
  evidenceWatermark: WATERMARK,
};

Deno.test("a failure backs off 30 s doubling to a 5 minute ceiling", () => {
  // random 0.5 is the middle of the jitter band: exactly the base.
  const seconds = (failures: number) =>
    (nextProbeAt(failure, failures, null, NOW, fixedRandom(0.5)).getTime() -
      NOW.getTime()) / 1000;
  assertEquals(
    [1, 2, 3, 4, 5, 6, 20].map(seconds),
    [30, 60, 120, 240, 300, 300, 300],
  );
});

Deno.test("jitter stays within plus or minus 20 percent of the base", () => {
  const at = (random: number) =>
    nextProbeAt(failure, 1, null, NOW, fixedRandom(random)).getTime() -
    NOW.getTime();
  assertEquals(at(0), 24_000);
  assertEquals(at(1), 36_000);
});

Deno.test("a failure is never rescheduled sooner than the provider's Retry-After, and never past the ceiling", () => {
  const delay = (retryAfterMs: number | null, failures = 1) =>
    nextProbeAt(failure, failures, retryAfterMs, NOW, fixedRandom(0.5))
      .getTime() - NOW.getTime();
  assertEquals(delay(90_000), 90_000);
  assertEquals(delay(5_000), 30_000);
  assertEquals(delay(10_000_000), 3_600_000);
});

Deno.test("a reachable route is looked at again on a steady interval", () => {
  const delay = nextProbeAt(
    { kind: "reachable", evidenceWatermark: WATERMARK },
    0,
    null,
    NOW,
    fixedRandom(0.5),
  ).getTime() - NOW.getTime();
  assertEquals(delay, 300_000);
});

// -- the egress guard (the ruling's refusal tests) ---------------------------

function resolverOf(...addresses: string[]) {
  return (_hostname: string): Promise<ResolvedAddress[]> =>
    Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );
}

function lookupResult(
  lookup: ReturnType<typeof guardedLookup>,
  all: boolean,
) {
  return new Promise<
    { error: Error | null; address: unknown; family?: number }
  >(
    (resolve) =>
      lookup(
        "provider.example",
        { all },
        (error, address, family) => resolve({ error, address, family }),
      ),
  );
}

Deno.test("a name that resolves to a non-public address is refused at the connect", async () => {
  for (
    const address of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "192.168.0.10",
      "::1",
      "fd00::5",
      "::ffff:7f00:1",
    ]
  ) {
    for (const all of [false, true]) {
      const { error } = await lookupResult(
        guardedLookup(resolverOf(address)),
        all,
      );
      assertEquals(
        (error as { code?: string } | null)?.code,
        EGRESS_REFUSED,
        `${address} all=${all}`,
      );
    }
  }
});

Deno.test("a mixed answer is refused whole, because the connection may use any of it", async () => {
  const { error } = await lookupResult(
    guardedLookup(resolverOf("8.8.8.8", "10.0.0.1")),
    true,
  );
  assertEquals((error as { code?: string } | null)?.code, EGRESS_REFUSED);
  const ordering = await lookupResult(
    guardedLookup(resolverOf("10.0.0.1", "8.8.8.8")),
    false,
  );
  assertEquals(
    (ordering.error as { code?: string } | null)?.code,
    EGRESS_REFUSED,
  );
});

Deno.test("an empty answer and a resolver failure are refused, not connected", async () => {
  const empty = await lookupResult(guardedLookup(resolverOf()), false);
  assertEquals((empty.error as { code?: string } | null)?.code, EGRESS_REFUSED);
  const failed = await lookupResult(
    guardedLookup(() => Promise.reject(new Error("servfail"))),
    false,
  );
  assertEquals(failed.error?.message, "servfail");
});

Deno.test("an all-public answer is handed to the connection in the shape it asked for", async () => {
  const one = await lookupResult(guardedLookup(resolverOf("8.8.8.8")), false);
  assertEquals(one.error, null);
  assertEquals(one.address, "8.8.8.8");
  assertEquals(one.family, 4);
  const many = await lookupResult(
    guardedLookup(resolverOf("8.8.8.8", "2606:4700:4700::1111")),
    true,
  );
  assertEquals((many.address as unknown[]).length, 2);
});

Deno.test("an endpoint written as a non-public address, or with credentials or plain http, is refused before any lookup", () => {
  for (
    const endpoint of [
      "https://127.0.0.1/v1",
      "https://[::1]/v1",
      "https://169.254.169.254/latest",
      "https://[::ffff:7f00:1]/v1",
      "http://api.provider.example/v1",
      "https://user:pass@api.provider.example/v1",
      "not a url",
    ]
  ) {
    assertEquals(endpointHostIsRefused(endpoint), true, endpoint);
  }
  assertEquals(endpointHostIsRefused("https://api.provider.example/v1"), false);
  assertEquals(endpointHostIsRefused("https://8.8.8.8/v1"), false);
});

Deno.test("the transport refuses a private literal and a rebinding name without connecting", async () => {
  let requests = 0;
  const countingRequest = (() => {
    requests += 1;
    throw new Error("a connection must not be attempted");
  }) as never;
  // A short deadline, so a regression that lets a literal through fails fast with a
  // message instead of leaving the default ten-second timer running; and the call is
  // caught, so an attempted connection reads as a failed assertion, not a hang.
  const literal = httpsProbeTransport({
    request: countingRequest,
    deadlineMs: 100,
  });
  const attempt = async (url: string) => {
    try {
      return await literal(url);
    } catch (error) {
      return { attempted: String(error) };
    }
  };
  assertEquals(
    await attempt("https://10.0.0.1/v1"),
    { kind: "refused" },
    "a private IPv4 literal must be refused before any request is made",
  );
  assertEquals(
    await attempt("https://[::1]/v1"),
    { kind: "refused" },
    "a private IPv6 literal must be refused before any request is made",
  );
  assertEquals(requests, 0, "no connection may be attempted for a literal");

  // A name whose answer is private goes through the real request path, where the
  // guarded lookup refuses it before a socket is opened.
  const named = httpsProbeTransport({
    lookup: guardedLookup(resolverOf("10.0.0.1")),
    deadlineMs: 2_000,
  });
  assertEquals(await named("https://rebind.provider.example/v1"), {
    kind: "refused",
  });
});

Deno.test("the transport times out a name that never resolves instead of hanging", async () => {
  const stalled = httpsProbeTransport({
    lookup: () => {},
    deadlineMs: 50,
  });
  assertEquals(await stalled("https://slow.provider.example/v1"), {
    kind: "timeout",
  });
});

// -- what the transport sends -------------------------------------------------

function fakeRequest(
  response: { statusCode: number; headers: Record<string, string> },
) {
  const sent: { options: Record<string, unknown>; destroyed: boolean }[] = [];
  const request = ((
    options: Record<string, unknown>,
    callback: (res: unknown) => void,
  ) => {
    const record = { options, destroyed: false };
    sent.push(record);
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      callback({
        ...response,
        destroy: () => {
          record.destroyed = true;
        },
      });
    };
    return req;
  }) as never;
  return { request, sent };
}

Deno.test("the probe sends one credential-less GET, follows no redirect and never reads the body", async () => {
  const { request, sent } = fakeRequest({
    statusCode: 302,
    headers: { location: "https://169.254.169.254/latest" },
  });
  const result = await httpsProbeTransport({ request })(
    "https://api.provider.example/v1/models",
  );
  // A redirect is an answer, not an instruction: it is reported, not followed.
  assertEquals(result, { kind: "response", status: 302, retryAfter: null });
  assertEquals(sent.length, 1);
  const options = sent[0]!.options;
  assertEquals(options.method, "GET");
  assertEquals(options.path, "/v1/models");
  assertEquals(options.hostname, "api.provider.example");
  const headers = Object.keys(options.headers as object).map((name) =>
    name.toLowerCase()
  );
  assert(!headers.includes("authorization"));
  assert(!headers.includes("cookie"));
  assert(!headers.includes("x-api-key"));
  // The response is destroyed unread, so nothing is buffered.
  assertEquals(sent[0]!.destroyed, true);
});

Deno.test("Retry-After is carried from the response", async () => {
  const { request } = fakeRequest({
    statusCode: 429,
    headers: { "retry-after": "12" },
  });
  assertEquals(
    await httpsProbeTransport({ request })("https://api.provider.example/v1"),
    { kind: "response", status: 429, retryAfter: "12" },
  );
});

// -- the function -------------------------------------------------------------

Deno.test("the probe runs every minute, one run at a time, and is one step", () => {
  const captured = captureFunction((client) =>
    createProviderProbeWorkflow({ client, database: {} as never })
  );
  assertEquals(captured.config.triggers, [{ cron: PROVIDER_PROBE_CRON }]);
  assertEquals(PROVIDER_PROBE_CRON, "* * * * *");
  assertEquals(captured.config.concurrency, [{ limit: 1 }]);
});

Deno.test("the probe opens incidents now that a completed attempt closes them", () => {
  // Ruling on #26: an incident nothing can close would permanently remove a route
  // after a transient outage. #70 added the closer (a completed attempt is
  // inference_proven, attempt-route-evidence.ts), so failures open incidents.
  assertEquals(PROBE_OPENS_INCIDENTS, true);
});
