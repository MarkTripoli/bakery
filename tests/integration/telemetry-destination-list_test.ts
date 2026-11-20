import { assert, assertEquals } from "@std/assert";
import type { DestinationFanout } from "../../apps/server/src/platform/telemetry-destinations/index.ts";
import {
  allowAnyAddress,
  createProviderRegistry,
  otlpProvider,
} from "../../apps/server/src/platform/telemetry-destinations/index.ts";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";

/**
 * The Monitoring list against a real database: the page window, the search and
 * the filters, the order (failing, then dropping data, then by name), a cursor
 * that survives a removal and refuses other filters, one destination by id and
 * a destination's drop reports. The runtime state is a fan-out stand-in that
 * reports what the test says, since state lives in memory, not in the table.
 */

type Destination = {
  id: string;
  name: string;
  state: string;
  kind: string;
  provider: string;
};
type Page = {
  destinations: Destination[];
  nextCursor: string | null;
  total: number;
  destinationLimit: number;
  stateCounts: Record<string, number>;
  kinds: { kind: string }[];
  measurements: { kind: string }[];
  providers: {
    key: string;
    name: string;
    description: string;
    kind: string;
    prefill: Record<string, string>;
  }[];
};

const NAMES = [
  ...Array.from(
    { length: 30 },
    (_, n) => `Alpha ${String(n).padStart(2, "0")}`,
  ),
  ...Array.from({ length: 28 }, (_, n) => `beta ${String(n).padStart(2, "0")}`),
  "Zulu",
  "failing one",
];

Deno.test("the Monitoring list pages, searches, filters and orders destinations, and one reads by id", async () => {
  const runtime = new Map<string, unknown>();
  const reports = new Map<
    string,
    { id: number; at: number; reason: string; count: number }[]
  >();
  const fanout = {
    send: () => {},
    configure: () => {},
    states: () => runtime,
    drops: (id: string) => reports.get(id) ?? [],
    close: () => Promise.resolve(),
  } as unknown as DestinationFanout;
  const registry = createProviderRegistry([otlpProvider]);
  const f = await openInstallationFixture(true, {
    telemetryDestinations: {
      registry,
      fanout,
      providerDependencies: { fetch, addressPolicy: allowAnyAddress },
      secretsKey: undefined,
    },
  });
  const get = async (path: string, cookie = f.adminCookie) => {
    const response = await call(f, "GET", path, cookie, {
      headers: { "Bakery-Organization-Id": f.organizationId },
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: text ? JSON.parse(text) : {},
    };
  };
  const list = async (query = "") => {
    const r = await get(`/v1/installation/telemetry-destinations${query}`);
    assertEquals(r.status, 200, r.text);
    return r.json as Page;
  };
  try {
    await f.pgDatabase.query("delete from bakery.telemetry_destinations");
    for (const name of NAMES) {
      await f.pgDatabase.query(
        `insert into bakery.telemetry_destinations (id, kind, provider, name, measurements, enabled)
         values (gen_random_uuid(), 'otlp', $3, $1, array['health'], $2)`,
        [name, name !== "Zulu", name.startsWith("beta") ? "honeycomb" : null],
      );
    }
    const ids = new Map(
      (await f.pgDatabase.query<{ id: string; name: string }>(
        "select id, name from bakery.telemetry_destinations",
      )).rows.map((row) => [row.name, row.id]),
    );
    const live = (name: string, state: string, dropped = 0) =>
      runtime.set(ids.get(name)!, {
        id: ids.get(name)!,
        state,
        lastAcceptedAt: null,
        lastAnswer: null,
        dropped,
        droppedSince: dropped > 0 ? Date.UTC(2026, 10, 20, 12) : null,
      });
    live("failing one", "failing");
    live("beta 05", "dropping_data", 7);
    live("Alpha 03", "working");

    // The first page: failing, then dropping data, then the rest by name with
    // case ignored ("beta" sits between "Alpha" and "Zulu").
    const first = await list();
    assertEquals(first.destinations.length, 25);
    assertEquals(first.destinationLimit, 200);
    assertEquals(first.total, 60);
    assertEquals(first.destinations.slice(0, 2).map((d) => d.name), [
      "failing one",
      "beta 05",
    ]);
    assertEquals(first.destinations[2].name, "Alpha 00");
    assert(first.nextCursor !== null);
    assertEquals(first.stateCounts, {
      all: 60,
      working: 1,
      not_tested_yet: 56,
      failing: 1,
      dropping_data: 1,
      off: 1,
    });
    assertEquals(first.kinds.map((k) => k.kind), ["otlp"]);
    // The chooser's providers, with the Honeycomb address and header filled in.
    assertEquals(first.providers.map((p) => p.key), [
      "opentelemetry",
      "grafana",
      "datadog",
      "honeycomb",
      "sentry",
    ]);
    assert(first.providers.every((p) => p.kind === "otlp" && p.description));
    assertEquals(
      first.providers.find((p) => p.key === "honeycomb")!.prefill,
      { address: "https://api.honeycomb.io", headerName: "x-honeycomb-team" },
    );
    // A row saved with no provider reads as its kind's default.
    assertEquals(first.destinations[2].provider, "opentelemetry");
    assertEquals(first.destinations[1].provider, "honeycomb");
    assertEquals(first.measurements.length, 6);

    // Paging by cursor visits every destination once, in the same order.
    const seen: string[] = first.destinations.map((d) => d.name);
    let cursor: string | null = first.nextCursor;
    let pages = 1;
    while (cursor !== null) {
      const next = await list(`?cursor=${encodeURIComponent(cursor)}`);
      seen.push(...next.destinations.map((d) => d.name));
      cursor = next.nextCursor;
      pages += 1;
    }
    assertEquals(pages, 3);
    assertEquals(seen.length, 60);
    assertEquals(new Set(seen).size, 60);
    const lowered = seen.slice(2).filter((n) => n !== "Zulu").map((n) =>
      n.toLowerCase()
    );
    assertEquals(seen.at(-1), "Zulu");
    assertEquals(
      lowered.slice(0, 29),
      [...lowered.slice(0, 29)].sort(),
    );

    // A cursor goes on after the last row seen even when that row is removed.
    const short = await list("?limit=10");
    const last = short.destinations.at(-1)!;
    await f.pgDatabase.query(
      "delete from bakery.telemetry_destinations where id = $1",
      [last.id],
    );
    const after = await list(
      `?limit=10&cursor=${encodeURIComponent(short.nextCursor!)}`,
    );
    assertEquals(after.destinations.length, 10);
    assert(!after.destinations.some((d) => d.id === last.id));
    assert(
      !after.destinations.some((d) =>
        short.destinations.some((s) => s.id === d.id)
      ),
    );
    await f.pgDatabase.query(
      `insert into bakery.telemetry_destinations (id, kind, name, measurements)
       values ($1, 'otlp', $2, array['health'])`,
      [last.id, last.name],
    );

    // Search ignores case; state and kind narrow; counts ignore the filters.
    const search = await list("?search=BETA%200");
    assertEquals(search.total, 10);
    assert(search.destinations.every((d) => /^beta 0/i.test(d.name)));
    assertEquals(search.stateCounts.all, 60);
    const failing = await list("?state=failing");
    assertEquals(failing.destinations.map((d) => d.name), ["failing one"]);
    assertEquals(failing.nextCursor, null);
    assertEquals((await list("?state=off")).total, 1);
    assertEquals((await list("?kind=otlp&state=dropping_data")).total, 1);
    assertEquals((await list("?kind=nothing")).total, 0);
    assertEquals((await list("?provider=honeycomb")).total, 28);
    assertEquals((await list("?provider=opentelemetry")).total, 32);
    assertEquals((await list("?provider=grafana")).total, 0);
    assertEquals((await list("?search=zzz")).destinations, []);

    // A cursor is good only for the filters it was made with; bad windows and
    // values are refused.
    const cursorFor = (await list("?limit=5")).nextCursor!;
    assertEquals(
      (await get(
        `/v1/installation/telemetry-destinations?search=beta&cursor=${
          encodeURIComponent(cursorFor)
        }`,
      )).status,
      400,
    );
    for (const bad of ["limit=0", "limit=101", "state=sleeping", "offset=5"]) {
      const refused = await get(
        `/v1/installation/telemetry-destinations?${bad}`,
      );
      assert(
        refused.status === 400 || refused.status === 422,
        `${bad}: ${refused.status} ${refused.text}`,
      );
    }

    // One destination by id, with its kind and the measurement list.
    const one = await get(
      `/v1/installation/telemetry-destinations/${ids.get("failing one")}`,
    );
    assertEquals(one.status, 200, one.text);
    assertEquals(one.json.destination.name, "failing one");
    assertEquals(one.json.destination.state, "failing");
    assertEquals(one.json.kind.kind, "otlp");
    assertEquals(one.json.destination.provider, "opentelemetry");
    assertEquals(one.json.provider.key, "opentelemetry");
    const honey = await get(
      `/v1/installation/telemetry-destinations/${ids.get("beta 05")}`,
    );
    assertEquals(honey.json.destination.provider, "honeycomb");
    assertEquals(honey.json.provider.name, "Honeycomb");
    assertEquals(one.json.measurements.length, 6);
    assertEquals(
      (await get(
        `/v1/installation/telemetry-destinations/${crypto.randomUUID()}`,
      )).status,
      404,
    );
    assertEquals(
      (await get(
        `/v1/installation/telemetry-destinations/${ids.get("Zulu")}`,
        f.developerCookie!,
      )).status,
      403,
    );

    // A destination is added for a provider; one the list does not offer is refused.
    const make = async (name: string, provider?: string) => {
      const response = await call(
        f,
        "POST",
        "/v1/installation/telemetry-destinations",
        f.adminCookie,
        {
          body: {
            kind: "otlp",
            name,
            ...(provider === undefined ? {} : { provider }),
            measurements: ["health"],
            values: { address: "https://collector.example.test" },
          },
          headers: {
            "Bakery-Organization-Id": f.organizationId,
            "Idempotency-Key": crypto.randomUUID(),
          },
        },
      );
      const text = await response.text();
      return {
        status: response.status,
        text,
        json: text ? JSON.parse(text) : {},
      };
    };
    const grafana = await make("Grafana prod", "grafana");
    assertEquals(grafana.status, 201, grafana.text);
    assertEquals(grafana.json.provider, "grafana");
    const plain = await make("Collector prod");
    assertEquals(plain.status, 201, plain.text);
    assertEquals(plain.json.provider, "opentelemetry");
    const unknown = await make("Elsewhere", "splunk");
    assertEquals(unknown.status, 422, unknown.text);
    assert(unknown.text.includes("provider"));
    assertEquals(
      (await list("?provider=grafana")).destinations.map((d) => d.name),
      ["Grafana prod"],
    );
    // A provider is a label fixed when the destination is added.
    const stored = await f.pgDatabase.query<{ provider: string }>(
      "select provider from bakery.telemetry_destinations where id = $1",
      [grafana.json.id],
    );
    assertEquals(stored.rows[0].provider, "grafana");

    // The drop reports, newest first, a page at a time.
    const beta = ids.get("beta 05")!;
    reports.set(
      beta,
      [1, 2, 3, 4, 5].map((id) => ({
        id,
        at: Date.UTC(2026, 10, 20, 12, id),
        reason: id % 2 === 0 ? "send_failed" : "queue_full",
        count: id * 10,
      })),
    );
    const base = `/v1/installation/telemetry-destinations/${beta}/dropped`;
    const page1 = await get(`${base}?limit=2`);
    assertEquals(page1.status, 200, page1.text);
    assertEquals(page1.json.items.map((i: { id: number }) => i.id), [5, 4]);
    assertEquals(page1.json.items[0].reason, "queue_full");
    assertEquals(page1.json.items[0].count, 50);
    assertEquals(page1.json.droppedTotal, 7);
    assertEquals(page1.json.droppedSince, "2026-11-20T12:00:00.000Z");
    const page2 = await get(
      `${base}?limit=2&cursor=${encodeURIComponent(page1.json.nextCursor)}`,
    );
    assertEquals(page2.json.items.map((i: { id: number }) => i.id), [3, 2]);
    const page3 = await get(
      `${base}?limit=2&cursor=${encodeURIComponent(page2.json.nextCursor)}`,
    );
    assertEquals(page3.json.items.map((i: { id: number }) => i.id), [1]);
    assertEquals(page3.json.nextCursor, null);
    const none = await get(
      `/v1/installation/telemetry-destinations/${ids.get("Zulu")}/dropped`,
    );
    assertEquals(none.json.items, []);
    assertEquals(none.json.droppedTotal, 0);
    assertEquals(none.json.droppedSince, null);
    assertEquals(
      (await get(
        `/v1/installation/telemetry-destinations/${crypto.randomUUID()}/dropped`,
      )).status,
      404,
    );
  } finally {
    await f.pgDatabase.query("delete from bakery.telemetry_destinations");
    await f.finish();
  }
});
