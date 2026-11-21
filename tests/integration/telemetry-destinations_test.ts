import { assert, assertEquals } from "@std/assert";
import { createServerTelemetry } from "../../apps/server/src/platform/telemetry.ts";
import {
  allowAnyAddress,
  createDestinationFanout,
  createProviderRegistry,
  otlpProvider,
} from "../../apps/server/src/platform/telemetry-destinations/index.ts";
import { createDestinationLoader } from "../../apps/server/src/modules/monitoring/destination-loader.ts";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";

/**
 * Telemetry destinations against a real database and a real HTTP receiver that
 * stands in for an OpenTelemetry collector. No hosted service is involved.
 *
 * What only this can show: the sign-in header is sealed and never comes back, a
 * saved destination really receives what the server emits and only the kinds it
 * was told to, a refusing destination reads as failing with its own answer while
 * another destination is unaffected, and a change is picked up by the running
 * fan-out.
 */

type Body = Record<string, unknown>;
type Seen = { path: string; authorization: string | null; body: string };

const TOKEN = "otlp_canary_token_9d3f71a2c4";

function receiver(status: () => number) {
  const seen: Seen[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      // Only POSTs are the test's traffic. A host that probes new localhost ports
      // (mini1 does) sends empty GETs to "/", which must not count as a delivery.
      if (request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return new Response("{}", { status: status() });
    },
  );
  return {
    seen,
    address: `http://127.0.0.1:${server.addr.port}`,
    close: () => server.shutdown(),
  };
}

async function until(check: () => boolean | Promise<boolean>, ms = 8_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

Deno.test("an administrator manages OpenTelemetry destinations that really receive measurements", async () => {
  const keyFile = await Deno.makeTempFile({ prefix: "bakery-telemetry-key-" });
  await Deno.writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  const secretsKey = { file: keyFile, keyId: "telemetry-destinations-v1" };
  const registry = createProviderRegistry([otlpProvider]);
  const fast = {
    capacity: 100,
    batchSize: 20,
    sendTimeoutMs: 2_000,
    maxAttempts: 1,
    retryDelayMs: 1,
    intervalMs: 5,
  };
  const providerDependencies = { fetch, addressPolicy: allowAnyAddress };
  const fanout = createDestinationFanout({
    registry,
    dependencies: providerDependencies,
    bounds: fast,
  });
  const refreshLoader: { current: (() => Promise<void>) | undefined } = {
    current: undefined,
  };
  let answer = 200;
  const collector = receiver(() => answer);
  const other = receiver(() => 200);
  const f = await openInstallationFixture(true, {
    secretsKey,
    telemetryDestinations: {
      registry,
      fanout,
      providerDependencies,
      secretsKey,
      refresh: () => void refreshLoader.current?.(),
    },
  });
  const loader = createDestinationLoader({
    database: f.pgDatabase,
    secretsKey,
    fanout,
  });
  refreshLoader.current = loader.refresh;
  const telemetry = createServerTelemetry({ send: fanout.send });
  const org = { "Bakery-Organization-Id": f.organizationId };
  const send = async (
    cookie: string,
    method: string,
    path: string,
    options: { body?: unknown; ifMatch?: string } = {},
  ) => {
    const headers: Record<string, string> = { ...org };
    if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    const response = await call(f, method, path, cookie, {
      body: options.body,
      headers,
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: text ? JSON.parse(text) as Body : {},
    };
  };
  const list = async () => {
    const r = await send(
      f.adminCookie,
      "GET",
      "/v1/installation/telemetry-destinations",
    );
    assertEquals(r.status, 200, r.text);
    return r.json as {
      kinds: { kind: string; fields: { name: string; secret: boolean }[] }[];
      measurements: { kind: string }[];
      destinations: Body[];
      total: number;
      destinationLimit: number;
    };
  };
  try {
    // Only an installation administrator sees any of it.
    const denied = await send(
      f.developerCookie!,
      "GET",
      "/v1/installation/telemetry-destinations",
    );
    assertEquals(denied.status, 403, denied.text);

    // The page is built from this one read: the kinds with their fields, the six
    // kinds of measurement, and no destinations yet.
    const empty = await list();
    assertEquals(empty.kinds.map((k) => k.kind), ["otlp"]);
    assertEquals(
      empty.kinds[0].fields.filter((x) => x.secret).map((x) => x.name),
      ["headerValue"],
    );
    assertEquals(empty.measurements.map((m) => m.kind), [
      "cost",
      "durations",
      "results",
      "skills",
      "health",
      "errors",
    ]);
    assertEquals(empty.destinations, []);

    // Test send reports the destination's real answer, using unsaved values.
    const values = {
      address: collector.address,
      headerName: "Authorization",
      headerValue: `Bearer ${TOKEN}`,
    };
    const tested = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destination-tests",
      {
        body: { kind: "otlp", values },
      },
    );
    assertEquals(tested.status, 200, tested.text);
    assertEquals([tested.json.ok, tested.json.status], [true, 200]);
    assertEquals(
      collector.seen[0].path,
      "/v1/traces",
      "the collector saw: " + JSON.stringify(
        collector.seen.map((s) => ({
          path: s.path,
          authorization: s.authorization,
          body: s.body.slice(0, 160),
        })),
      ),
    );
    assertEquals(collector.seen[0].authorization, `Bearer ${TOKEN}`);
    answer = 401;
    const refused = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destination-tests",
      {
        body: { kind: "otlp", values },
      },
    );
    assertEquals([refused.json.ok, refused.json.status], [false, 401]);
    answer = 200;

    // A kind that is missing a required value, or unknown, is refused by field.
    const missing = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destinations",
      {
        body: {
          kind: "otlp",
          name: "No address",
          measurements: ["results"],
          values: {},
        },
      },
    );
    assertEquals(missing.status, 422, missing.text);
    const unknownKind = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destinations",
      {
        body: {
          kind: "nope",
          name: "Nope",
          measurements: ["results"],
          values: {},
        },
      },
    );
    assertEquals(unknownKind.status, 422);
    const tooMuch = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destinations",
      {
        body: {
          kind: "otlp",
          name: "Errors",
          measurements: ["errors"],
          values: { address: collector.address },
        },
      },
    );
    assertEquals(
      tooMuch.status,
      422,
      "OpenTelemetry cannot take errors on its own",
    );

    // Create: the secret is sealed and never comes back, in the answer or the list.
    const created = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destinations",
      {
        body: {
          kind: "otlp",
          name: "Local collector",
          measurements: ["results", "health"],
          values,
        },
      },
    );
    assertEquals(created.status, 201, created.text);
    const destination = created.json as {
      id: string;
      version: number;
      settings: Record<string, string>;
      secretFieldsSet: string[];
      state: string;
    };
    assertEquals(destination.secretFieldsSet, ["headerValue"]);
    assertEquals(destination.settings, {
      address: collector.address,
      headerName: "Authorization",
    });
    assertEquals(destination.state, "not_tested_yet");
    assert(!created.text.includes(TOKEN), "the answer carried the secret");
    assert(
      !(await send(
        f.adminCookie,
        "GET",
        "/v1/installation/telemetry-destinations",
      )).text.includes(TOKEN),
    );
    const stored = await f.pgDatabase.query<{ row: string; cipher: string }>(
      `select to_jsonb(d)::text as row,
              encode(v.ciphertext, 'escape') as cipher
         from bakery.telemetry_destinations as d
         join bakery.secret_versions as v on v.secret_id = d.secret_id
        where d.id = $1`,
      [destination.id],
    );
    assert(!stored.rows[0].row.includes(TOKEN), "the row held the secret");
    assert(
      !stored.rows[0].cipher.includes(TOKEN),
      "the secret is not encrypted",
    );

    // The same name again, ignoring case, is a conflict.
    const twin = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destinations",
      {
        body: {
          kind: "otlp",
          name: "LOCAL COLLECTOR",
          measurements: ["results"],
          values: { address: other.address },
        },
      },
    );
    assertEquals(twin.status, 409, twin.text);

    // A second destination for health only, to see that kinds are filtered.
    const second = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destinations",
      {
        body: {
          kind: "otlp",
          name: "Health only",
          measurements: ["health"],
          values: { address: other.address },
        },
      },
    );
    assertEquals(second.status, 201, second.text);
    await loader.refresh();

    // What the server emits reaches the destinations by their kinds, with the
    // sign-in header, and nothing that is not allowlisted.
    telemetry.event("usage.settled", { "bakery.outcome": "completed" });
    telemetry.event("job.completed", { "bakery.outcome": "completed" });
    await until(() =>
      collector.seen.some((s) => s.body.includes("job.completed"))
    );
    // usage.settled is a results record (the usage span under an attempt, with
    // token counts), so a destination that takes results receives it...
    await until(() =>
      collector.seen.some((s) => s.body.includes("usage.settled"))
    );
    // ...and a destination that takes only health does not.
    assertEquals(
      other.seen.filter((s) => s.body.includes("usage.settled")),
      [],
      "a health-only destination got a results record",
    );
    const traces = collector.seen.filter((s) =>
      s.path === "/v1/traces" && s.body.includes("job.completed")
    );
    assert(traces.length > 0, "results never arrived");
    assert(traces.every((s) => s.authorization === `Bearer ${TOKEN}`));
    assertEquals(
      other.seen.filter((s) => s.body.includes("job.completed")),
      [],
      "a health-only destination got results",
    );
    await until(async () => {
      const d = (await list()).destinations.find((x) =>
        x.id === destination.id
      );
      return d?.state === "working";
    });

    // A destination that starts refusing reads as failing, with its own answer,
    // and the other destination is unaffected.
    answer = 500;
    telemetry.event("job.completed", { "bakery.outcome": "completed" });
    await until(async () => {
      const d = (await list()).destinations.find((x) =>
        x.id === destination.id
      );
      return d?.state === "failing" &&
        d?.lastAnswerReason === "The destination answered 500.";
    });
    answer = 200;

    // Turning it off keeps its settings and stops delivery.
    const off = await send(
      f.adminCookie,
      "PATCH",
      `/v1/installation/telemetry-destinations/${destination.id}`,
      {
        body: { enabled: false },
        ifMatch: `"${destination.version}"`,
      },
    );
    assertEquals(off.status, 200, off.text);
    assertEquals(off.json.state, "off");
    assertEquals(off.json.version, destination.version + 1);
    await loader.refresh();
    const before = collector.seen.length;
    telemetry.event("job.completed", { "bakery.outcome": "completed" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEquals(
      collector.seen.length,
      before,
      "an off destination was sent to",
    );

    // A stale version is refused; replacing the secret keeps the other settings.
    const stale = await send(
      f.adminCookie,
      "PATCH",
      `/v1/installation/telemetry-destinations/${destination.id}`,
      {
        body: { name: "Renamed" },
        ifMatch: `"${destination.version}"`,
      },
    );
    assertEquals(stale.status, 412);
    const replaced = await send(
      f.adminCookie,
      "PATCH",
      `/v1/installation/telemetry-destinations/${destination.id}`,
      {
        body: {
          enabled: true,
          values: { headerValue: "Bearer replaced_value_7c1" },
        },
        ifMatch: `"${(off.json as { version: number }).version}"`,
      },
    );
    assertEquals(replaced.status, 200, replaced.text);
    assertEquals(
      (replaced.json as { settings: Body }).settings,
      destination.settings,
    );
    assert(!replaced.text.includes("replaced_value_7c1"));
    await loader.refresh();
    telemetry.event("job.completed", { "bakery.outcome": "completed" });
    await until(() =>
      collector.seen.some((s) =>
        s.authorization === "Bearer replaced_value_7c1"
      )
    );

    // A saved sign-in header goes only to the address it was saved for. Moving
    // the address, or testing a different one, needs the value entered again.
    const afterReplace = replaced.json as { version: number };
    const seenByOther = other.seen.length;
    const moved = await send(
      f.adminCookie,
      "PATCH",
      `/v1/installation/telemetry-destinations/${destination.id}`,
      {
        body: { values: { address: other.address } },
        ifMatch: `"${afterReplace.version}"`,
      },
    );
    assertEquals(moved.status, 422, moved.text);
    assert(moved.text.includes("headerValue"), "the problem names the header");
    const renamed = await send(
      f.adminCookie,
      "PATCH",
      `/v1/installation/telemetry-destinations/${destination.id}`,
      {
        body: { values: { headerName: "X-Other" } },
        ifMatch: `"${afterReplace.version}"`,
      },
    );
    assertEquals(renamed.status, 422, renamed.text);
    const unchanged = (await list()).destinations.find((d) =>
      d.id === destination.id
    ) as { settings: Body; version: number };
    assertEquals(unchanged.settings, destination.settings);
    assertEquals(unchanged.version, afterReplace.version);
    const elsewhere = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destination-tests",
      { body: { id: destination.id, values: { address: other.address } } },
    );
    assertEquals(elsewhere.status, 422, elsewhere.text);
    assertEquals(
      other.seen.length,
      seenByOther,
      "a saved header was sent to a different address",
    );
    // With the value entered again it is allowed, and only that value is sent.
    const reentered = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/telemetry-destination-tests",
      {
        body: {
          id: destination.id,
          values: { address: other.address, headerValue: "Bearer typed_again" },
        },
      },
    );
    assertEquals(reentered.status, 200, reentered.text);
    assertEquals(
      other.seen.slice(seenByOther).map((s) => s.authorization),
      ["Bearer typed_again"],
    );

    // Removing it needs the current version and forgets it.
    const wrong = await send(
      f.adminCookie,
      "DELETE",
      `/v1/installation/telemetry-destinations/${destination.id}`,
      {
        ifMatch: `"${destination.version}"`,
      },
    );
    assertEquals(wrong.status, 412);
    const removed = await send(
      f.adminCookie,
      "DELETE",
      `/v1/installation/telemetry-destinations/${destination.id}`,
      {
        ifMatch: `"${(replaced.json as { version: number }).version}"`,
      },
    );
    assertEquals(removed.status, 204, removed.text);
    assertEquals((await list()).destinations.map((d) => d.name), [
      "Health only",
    ]);

    // At most 200 destinations, even when creates race: four at once with room
    // for two must admit exactly two. The fillers are written straight to the
    // table so the test does not make 197 requests.
    const make = (name: string) =>
      send(f.adminCookie, "POST", "/v1/installation/telemetry-destinations", {
        body: {
          kind: "otlp",
          name,
          measurements: ["health"],
          values: { address: other.address },
        },
      });
    await f.pgDatabase.query(
      `insert into bakery.telemetry_destinations (id, kind, name, measurements)
       select gen_random_uuid(), 'otlp', 'Filler ' || n, array['health']
         from generate_series(0, 196) as n`,
    );
    assertEquals((await list()).total, 198);
    const raced = await Promise.all(
      ["Race A", "Race B", "Race C", "Race D"].map(make),
    );
    assertEquals(
      raced.map((r) => r.status).sort(),
      [201, 201, 409, 409],
      "concurrent creates went past the limit",
    );
    const full = await list();
    assertEquals(full.total, 200);
    assertEquals(full.destinationLimit, 200);
  } finally {
    await telemetry.close(500);
    await fanout.close(0);
    await collector.close();
    await other.close();
    // The sealed secrets name the administrator who made them, so they go before
    // the fixture removes its principals.
    for (
      const statement of [
        "delete from bakery.telemetry_destinations",
        "update bakery.secrets set active_version_id = null where provider = 'telemetry'",
        "delete from bakery.secret_versions where secret_id in (select id from bakery.secrets where provider = 'telemetry')",
        "delete from bakery.secrets where provider = 'telemetry'",
      ]
    ) await f.pgDatabase.query(statement);
    await f.finish();
    await Deno.remove(keyFile);
  }
});
