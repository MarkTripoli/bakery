import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readSentryConfig } from "../../packages/config/src/sentry.ts";
import { createReportedQueryClient } from "../../apps/web/src/app/query-client.ts";
import {
  browserReportingOptions,
  reportApplicationError,
} from "../../apps/web/src/telemetry.ts";

// `tests/unit` has no node_modules, so the SDK is loaded the way
// apps/web/src/telemetry.ts loads it: its ESM entry, through the realpath that
// Node keys the module cache on. A second copy would hold a second global
// client, and `reportApplicationError` would find none and report nothing.
const sdkRoot = new URL(
  "../../apps/web/node_modules/@sentry/react/",
  import.meta.url,
);
const sdkManifest = JSON.parse(
  readFileSync(new URL("package.json", sdkRoot), "utf8"),
);
const Sentry = await import(
  new URL(sdkManifest.exports["."].import.default, sdkRoot).href
);

const config = readSentryConfig(
  {
    VITE_SENTRY_ENABLED: "true",
    VITE_SENTRY_ENVIRONMENT: "preview",
    VITE_SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/123",
    VITE_SENTRY_RELEASE: "bakery@0123456789abcdef0123456789abcdef01234567",
  },
  "web",
  "production",
);
assert.equal(config.enabled, true, "the fixture must enable telemetry");

/** Everything the browser would have put on the wire, after `beforeSend`. */
const envelopes = [];
const transport = () => ({
  send: (envelope) => {
    envelopes.push(envelope);
    return Promise.resolve({ statusCode: 200 });
  },
  flush: () => Promise.resolve(true),
});

const sent = () =>
  envelopes.flatMap(([, items]) =>
    items.filter(([header]) => header.type === "event").map(([, payload]) =>
      payload
    )
  );

/** The operations sent so far, in order, then forgets them. */
async function drain() {
  await Sentry.flush(2000);
  const events = sent();
  envelopes.length = 0;
  return events;
}

// The same wiring `main.tsx` gives the application query client.
const queryClient = createReportedQueryClient((failure) =>
  reportApplicationError(failure.error, {
    source: failure.source,
    operation: failure.operation,
  })
);

// A new object per occurrence, as `toApiFailure` returns. The SDK marks every
// error object it captures and drops one it has already seen, so a failure
// shared between occurrences would be reported only the first time.
const unreachable = () => ({ kind: "network" });
const protectedKey = (operation, input = { page: 2 }) => [
  "protected",
  1,
  "org-1",
  operation,
  input,
];
const failQuery = (operation, input) =>
  queryClient.fetchQuery({
    queryKey: protectedKey(operation, input),
    queryFn: () => Promise.reject(unreachable()),
    retry: false,
  }).catch(() => {});

test("a failure reports nothing while the SDK was never initialised", async () => {
  await failQuery("health");
  assert.equal(Sentry.getClient(), undefined);
  assert.deepEqual(await drain(), []);
});

test("an unreachable API sends one event per failed query, named by its operation", async () => {
  Sentry.init({
    ...browserReportingOptions(config, new Set(["/"])),
    transport,
  });
  for (
    const operation of [
      "health",
      "installation.license.get",
      "installation.seats.get",
    ]
  ) await failQuery(operation);

  const events = await drain();
  assert.deepEqual(
    events.map((event) => event.tags["bakery.operation"]),
    ["health", "installation.license.get", "installation.seats.get"],
  );
  for (const event of events) {
    assert.equal(event.tags["bakery.source"], "query");
    assert.equal(event.environment, "preview");
    assert.equal(event.release, config.release);
  }
});

test("a failed mutation is sent with the key it declares", async () => {
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: ["connectedClients.revoke"],
    mutationFn: () => Promise.reject(unreachable()),
  });
  await mutation.execute({ clientId: "client-secret-sentinel" }).catch(
    () => {},
  );
  const [event, ...rest] = await drain();
  assert.deepEqual(rest, []);
  assert.equal(event.tags["bakery.source"], "mutation");
  assert.equal(event.tags["bakery.operation"], "connectedClients.revoke");
});

test("query inputs and mutation variables never reach the wire", async () => {
  const secret = "input-sentinel-7c1f";
  await failQuery("tasks.list", { filter: secret, page: 2 });
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: ["browserSessions.revoke"],
    mutationFn: () => Promise.reject({ kind: "network", detail: secret }),
  });
  await mutation.execute({ sessionId: secret }).catch(() => {});

  const events = await drain();
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.deepEqual(
      Object.keys(event.tags).sort(),
      ["bakery.operation", "bakery.source", "service"],
      "only the shaped attribution tags are sent",
    );
    for (const absent of ["extra", "request", "breadcrumbs", "user"]) {
      assert.equal(event[absent], undefined, `${absent} must not be sent`);
    }
  }
  assert.ok(
    !JSON.stringify(events).includes(secret),
    "no input or variable appears anywhere in the payload",
  );
});

test("an identical failure that repeats is sent once", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) await failQuery("health");
  const events = await drain();
  assert.deepEqual(
    events.map((event) => event.tags["bakery.operation"]),
    ["health"],
  );
});

test("the SDK drops an error object it already reported, so a failure must be new each time", async () => {
  // Pins what `unreachable()` and `toApiFailure` rely on: if the application
  // ever rejected with one shared failure object, every occurrence after the
  // first would vanish without a trace.
  const shared = unreachable();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    reportApplicationError(shared, { source: "query", operation: "health" });
    await Sentry.flush(2000);
  }
  assert.equal((await drain()).length, 1);
});

test("each operation owns the grouping identity it is sent under", async () => {
  await failQuery("installation.license.get");
  await failQuery("installation.seats.get");
  const events = await drain();
  // Without a fingerprint on the wire Sentry groups on the shared capture
  // site, and every data-layer failure collapses into one issue.
  assert.deepEqual(
    events.map((event) => event.fingerprint),
    [
      ["bakery", "query", "installation.license.get"],
      ["bakery", "query", "installation.seats.get"],
    ],
  );
});
