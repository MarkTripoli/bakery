import { assert, assertEquals, assertThrows } from "@std/assert";
import type { TelemetryRecord } from "@bakery/config/telemetry";
import type { ExportSink } from "@bakery/config/telemetry-export";
import {
  allowAnyAddress,
  type ConfiguredDestination,
  createDestinationFanout,
  createProviderRegistry,
  createPublicHttpsPolicy,
  MEASUREMENT_KINDS,
  measurementsOf,
  otlpProvider,
  type TelemetryProvider,
} from "../../apps/server/src/platform/telemetry-destinations/index.ts";

const usage: TelemetryRecord = {
  kind: "event",
  name: "usage.settled",
  time: 1,
  attributes: {},
};
const completed: TelemetryRecord = {
  kind: "event",
  name: "job.completed",
  time: 2,
  attributes: { outcome: "completed" },
};
const sample: TelemetryRecord = {
  kind: "metrics",
  time: 3,
  samples: [{
    name: "bakery_queue_age_seconds",
    kind: "gauge",
    value: 4,
    labels: {},
  }],
};
const unknown: TelemetryRecord = {
  kind: "event",
  name: "something.else",
  time: 4,
  attributes: {},
};

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fast = {
  capacity: 5,
  batchSize: 5,
  sendTimeoutMs: 100,
  maxAttempts: 1,
  retryDelayMs: 1,
  intervalMs: 1,
};

/** An adapter whose sink is whatever the test says. */
function fakeProvider(
  kind: string,
  sink: ExportSink<TelemetryRecord>,
): TelemetryProvider {
  return {
    descriptor: {
      kind,
      label: kind,
      fields: [],
      measurements: ["cost", "durations", "results", "skills", "health"],
      unavailableReasons: {},
    },
    secretBoundFields: [],
    validate: () => Promise.resolve({}),
    createSink: () => sink,
    probe: () =>
      Promise.resolve({ ok: true, status: 200, reason: null, answer: null }),
  };
}

const dependencies = { fetch, addressPolicy: allowAnyAddress };

function destination(
  id: string,
  kind: string,
  extra: Partial<ConfiguredDestination> = {},
): ConfiguredDestination {
  return {
    id,
    kind,
    name: id,
    enabled: true,
    measurements: ["cost", "durations", "results", "health"],
    values: {},
    ...extra,
  };
}

Deno.test("a registry refuses two adapters for one kind and lists them in order", () => {
  const a = fakeProvider("a", () => {});
  const b = fakeProvider("b", () => {});
  assertThrows(() => createProviderRegistry([a, a]), Error, "DUPLICATE_KIND");
  const registry = createProviderRegistry([a, b]);
  assertEquals(registry.list().map((p) => p.descriptor.kind), ["a", "b"]);
  assertEquals(registry.get("b"), b);
  assertEquals(registry.get("c"), undefined);
});

Deno.test("every record the server emits maps to the kinds it carries, and an unmapped one to none", () => {
  // usage.settled carries token counts, which is the usage span under an
  // attempt; no record holds an amount in money or a duration yet, so cost and
  // durations are still not sent.
  assertEquals(measurementsOf(usage), ["results"]);
  assertEquals(measurementsOf(completed), ["results"]);
  assertEquals(measurementsOf(sample), ["health"]);
  assertEquals(measurementsOf(unknown), []);
});

Deno.test("the public address rule refuses http, credentials, local names and private networks", async () => {
  const policy = createPublicHttpsPolicy((host) =>
    Promise.resolve(
      host === "internal.example.test" ? ["10.0.0.5"] : ["93.184.216.34"],
    )
  );
  const refused = [
    "http://collector.example.test",
    "https://user:secret@collector.example.test",
    "https://localhost:4318",
    "https://127.0.0.1",
    "https://192.168.1.10",
    "https://[::1]",
    "https://169.254.169.254",
    "https://internal.example.test",
    "not a url",
  ];
  for (const address of refused) {
    assertEquals((await policy(address)).ok, false, address);
  }
  assertEquals((await policy("https://collector.example.test/otlp")).ok, true);
});

Deno.test("a measurement a kind offers is one the server really emits", () => {
  const emitted = new Set([usage, completed, sample].flatMap((record) => [
    ...measurementsOf(record),
  ]));
  for (const kind of otlpProvider.descriptor.measurements) {
    assert(emitted.has(kind), `${kind} is offered but nothing sends it`);
  }
  // A kind that is not offered says why, so its checkbox is disabled with a reason.
  for (const kind of MEASUREMENT_KINDS) {
    if (
      (otlpProvider.descriptor.measurements as readonly string[]).includes(kind)
    ) {
      continue;
    }
    assert(
      (otlpProvider.descriptor.unavailableReasons[kind] ?? "") !== "",
      `${kind} is not offered and gives no reason`,
    );
  }
  // The promise of each unavailable kind is a number the records do not carry.
  assertEquals(
    [...otlpProvider.descriptor.measurements],
    ["results", "health"],
  );
});

Deno.test("an IPv4 address in any IPv6 spelling, and the other special ranges, are refused", async () => {
  const policy = createPublicHttpsPolicy(() =>
    Promise.resolve(["93.184.216.34"])
  );
  const refused = [
    // IPv4-mapped, dotted and hex (what the URL parser writes)
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:7f00:1]",
    "https://[::ffff:a00:1]",
    "https://[::ffff:a9fe:a9fe]",
    "https://[::FFFF:C0A8:101]",
    "https://[0:0:0:0:0:ffff:7f00:1]",
    // IPv4-compatible and the unspecified address
    "https://[::7f00:1]",
    "https://[::127.0.0.1]",
    "https://[::]",
    // NAT64 and 6to4 carrying a private IPv4 address
    "https://[64:ff9b::7f00:1]",
    "https://[64:ff9b::10.0.0.1]",
    "https://[2002:7f00:1::]",
    // unique local, link-local, multicast, documentation, Teredo
    "https://[fd00::1]",
    "https://[fe80::1]",
    "https://[ff02::1]",
    "https://[2001:db8::1]",
    "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]",
    // IPv4 special ranges
    "https://198.18.0.1",
    "https://198.19.255.254",
    "https://192.0.2.7",
    "https://198.51.100.7",
    "https://203.0.113.7",
    "https://100.64.0.1",
    "https://0.0.0.0",
  ];
  for (const address of refused) {
    assertEquals((await policy(address)).ok, false, address);
  }
  for (
    const address of [
      "https://93.184.216.34",
      "https://[::ffff:5db8:d822]",
      "https://[64:ff9b::5db8:d822]",
      "https://[2606:4700:4700::1111]",
    ]
  ) {
    assertEquals((await policy(address)).ok, true, address);
  }
});

Deno.test("a header value with a line break or control character is refused on save", async () => {
  for (
    const bad of [
      "Bearer a\r\nx-evil: 1",
      "a\nb",
      "a\u0000b",
      "a\u007fb",
      // A header carries Latin-1 only: these would save and then fail every send.
      "Bearer \u2713",
      "\u0100",
      "\u4e2d",
    ]
  ) {
    const found = await otlpProvider.validate({
      address: "https://collector.example.test",
      headerName: "Authorization",
      headerValue: bad,
    });
    assertEquals(Object.keys(found), ["headerValue"], JSON.stringify(bad));
  }
  assertEquals(
    await otlpProvider.validate({
      address: "https://collector.example.test",
      headerName: "Authorization",
      headerValue: "Bearer abc.def-123 ünï",
    }),
    {},
  );
});

Deno.test("the OpenTelemetry adapter validates its address and header", async () => {
  assertEquals(Object.keys(await otlpProvider.validate({})), ["address"]);
  assertEquals(
    Object.keys(
      await otlpProvider.validate({
        address: "https://c.example.test/v1/traces",
      }),
    ),
    ["address"],
  );
  assertEquals(
    await otlpProvider.validate({ address: "https://c.example.test" }),
    {},
  );
  assertEquals(
    Object.keys(
      await otlpProvider.validate({
        address: "https://c.example.test",
        headerValue: "token",
      }),
    ),
    ["headerName"],
  );
  const secrets = otlpProvider.descriptor.fields.filter((f) => f.secret);
  assertEquals(secrets.map((f) => f.name), ["headerValue"]);
});

Deno.test("the OpenTelemetry probe reports the destination's real answer and never follows a redirect", async () => {
  const seen: { url: string; redirect?: string; header?: string }[] = [];
  const answer = (status: number, body = "") =>
    ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.push({
        url: String(input),
        redirect: init?.redirect,
        header: (init?.headers as Record<string, string>)?.Authorization,
      });
      return Promise.resolve(new Response(body, { status }));
    }) as typeof fetch;
  const values = {
    address: "https://c.example.test",
    headerName: "Authorization",
    headerValue: "Bearer s3cret",
  };
  const run = (f: typeof fetch) =>
    otlpProvider.probe(
      values,
      { fetch: f, addressPolicy: allowAnyAddress },
      AbortSignal.timeout(1000),
    );

  const ok = await run(answer(200, "{}"));
  assertEquals([ok.ok, ok.status], [true, 200]);
  assertEquals(seen[0].url, "https://c.example.test/v1/traces");
  assertEquals(seen[0].redirect, "manual");
  assertEquals(seen[0].header, "Bearer s3cret");

  const denied = await run(answer(401, "bad token"));
  assertEquals([denied.ok, denied.status, denied.answer], [
    false,
    401,
    "bad token",
  ]);
  assert(denied.reason?.includes("sign-in"));

  const bounced = await run(answer(302));
  assertEquals(bounced.ok, false);
  assert(bounced.reason?.includes("redirect"));

  const down = await run(
    (() => Promise.reject(new TypeError("connect"))) as typeof fetch,
  );
  assertEquals([down.ok, down.status], [false, null]);

  const blocked = await otlpProvider.probe(
    { address: "http://c.example.test" },
    {
      fetch: answer(200),
      addressPolicy: createPublicHttpsPolicy(() =>
        Promise.resolve(["1.1.1.1"])
      ),
    },
    AbortSignal.timeout(1000),
  );
  assertEquals(blocked.ok, false);
  assertEquals(seen.length, 3, "a refused address sends nothing");
  assert(
    !JSON.stringify([ok, denied, bounced, down, blocked]).includes("s3cret"),
  );
});

Deno.test("a destination that never answers fills only its own bounded queue while another keeps receiving", async () => {
  const delivered: TelemetryRecord[] = [];
  const stuckBatches: number[] = [];
  const registry = createProviderRegistry([
    fakeProvider("fine", (batch) => {
      delivered.push(...batch);
    }),
    fakeProvider("stuck", (batch, signal) => {
      stuckBatches.push(batch.length);
      return new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }),
  ]);
  const fanout = createDestinationFanout({
    registry,
    dependencies,
    bounds: fast,
  });
  fanout.configure([destination("a", "fine"), destination("b", "stuck")]);

  // A steady stream the working destination keeps up with, in bursts of four.
  let slowest = 0;
  for (let i = 0; i < 25; i += 1) {
    const started = performance.now();
    fanout.send(
      [completed, completed, completed, completed],
      new AbortController().signal,
    );
    slowest = Math.max(slowest, performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(slowest < 50, "send never waits for a destination");

  await until(() => delivered.length === 100);
  await until(() => (fanout.states().get("b")?.dropped ?? 0) > 0);
  const states = fanout.states();
  assertEquals(states.get("a")?.state, "working");
  assert((states.get("b")?.dropped ?? 0) > 0, "the stuck queue sheds");
  assert(states.get("b")?.droppedSince !== null);
  // Nothing past the queue bound was ever held for it.
  assert(stuckBatches.every((size) => size <= fast.capacity));
  // Each loss is kept as a report: how many, when and why, never the records.
  const reports = fanout.drops("b");
  assert(reports.length > 0, "the stuck destination has drop reports");
  assertEquals(
    reports.map((report) => report.id),
    reports.map((_, index) => reports[0].id + index),
  );
  assert(reports.every((report) => report.count > 0 && report.at > 0));
  assertEquals(
    reports.reduce((sum, report) => sum + report.count, 0),
    states.get("b")?.dropped,
  );
  assertEquals(fanout.drops("a"), []);
  assertEquals(fanout.drops("nobody"), []);
  await fanout.close(0);
});

Deno.test("a destination receives only the kinds it was told to, and an off one receives nothing", async () => {
  const got: Record<string, string[]> = { results: [], health: [], off: [] };
  const registry = createProviderRegistry(
    ["results", "health", "off"].map((kind) =>
      fakeProvider(kind, (batch) => {
        for (const r of batch) {
          got[kind].push(r.kind === "event" ? r.name : "metrics");
        }
      })
    ),
  );
  const fanout = createDestinationFanout({
    registry,
    dependencies,
    bounds: fast,
  });
  fanout.configure([
    destination("c", "results", { measurements: ["results"] }),
    destination("h", "health", { measurements: ["health"] }),
    destination("o", "off", { enabled: false }),
  ]);
  fanout.send(
    [usage, completed, sample, unknown],
    new AbortController().signal,
  );
  await until(() => got.results.length === 2 && got.health.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(got.results, ["usage.settled", "job.completed"]);
  assertEquals(got.health, ["metrics"]);
  assertEquals(got.off, []);
  assertEquals(fanout.states().get("o")?.state, "off");
  await fanout.close(0);
});

Deno.test("a new adapter added to the registry receives the same signals with no change to the emitter", async () => {
  const seen: string[][] = [[], []];
  const registry = createProviderRegistry([
    fakeProvider("one", (batch) => {
      seen[0].push(
        ...batch.map((r) => (r.kind === "event" ? r.name : "metrics")),
      );
    }),
    fakeProvider("two", (batch) => {
      seen[1].push(
        ...batch.map((r) => (r.kind === "event" ? r.name : "metrics")),
      );
    }),
  ]);
  const fanout = createDestinationFanout({
    registry,
    dependencies,
    bounds: fast,
  });
  fanout.configure([destination("1", "one"), destination("2", "two")]);
  fanout.send([completed, sample], new AbortController().signal);
  await until(() => seen[0].length === 2 && seen[1].length === 2);
  assertEquals(seen[0], seen[1]);
  await fanout.close(0);
});

Deno.test("a destination's state follows what it answers, and a change is announced once", async () => {
  let refuse = true;
  const registry = createProviderRegistry([
    fakeProvider("flaky", () => {
      if (refuse) throw new Error("OTLP_DESTINATION_503");
    }),
  ]);
  const changes: string[] = [];
  const fanout = createDestinationFanout({
    registry,
    dependencies,
    bounds: fast,
    onStateChange: (state) => changes.push(state.state),
  });
  fanout.configure([destination("f", "flaky")]);
  assertEquals(fanout.states().get("f")?.state, "not_tested_yet");
  fanout.send([completed], new AbortController().signal);
  await until(() => fanout.states().get("f")?.state === "failing");
  assertEquals(
    fanout.states().get("f")?.lastAnswer?.reason,
    "The destination answered 503.",
  );
  assertEquals(fanout.states().get("f")?.lastAcceptedAt, null);
  refuse = false;
  fanout.send([completed], new AbortController().signal);
  await until(() => fanout.states().get("f")?.state === "working");
  assert((fanout.states().get("f")?.lastAcceptedAt ?? 0) > 0);
  assertEquals(changes, ["failing", "working"]);
  // A kind that is not installed is a failing destination, never a silent one.
  fanout.configure([destination("g", "gone")]);
  assertEquals(fanout.states().get("g")?.state, "failing");
  await fanout.close(0);
});
