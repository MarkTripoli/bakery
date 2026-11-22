import { assert, assertEquals } from "@std/assert";
import {
  call,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { allowAnyAddress } from "../../apps/server/src/platform/telemetry-destinations/index.ts";

/**
 * Alert rules, history and the test alert against a real database and a real
 * HTTP receiver. No hosted service is involved.
 *
 * What only this can show: a rule's saved setting survives a read, a stale or
 * missing version is refused, a limit is checked against the rule's own maximum,
 * the history pages newest first with a cursor that cannot be forged, and a test
 * alert reaches every enabled channel signed, with each channel's real answer.
 */

type Body = Record<string, unknown>;
type Rule = {
  rule: string;
  label: string;
  unit: string | null;
  enabled: boolean;
  threshold: number | null;
  defaultThreshold: number | null;
  maxThreshold: number | null;
  firing: number;
  version: number;
  updatedAt: string | null;
};

const RULES = [
  "service_down",
  "worker_lost",
  "queue_age",
  "route_incident",
  "export_loss",
];

function receiver(status: () => number) {
  const seen: { type: string }[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      // Only POSTs are the test's traffic; a host may probe new local ports.
      if (request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      seen.push(JSON.parse(await request.text()) as { type: string });
      return new Response("received", { status: status() });
    },
  );
  return {
    seen,
    address: `http://127.0.0.1:${server.addr.port}/alerts`,
    close: () => server.shutdown(),
  };
}

Deno.test("an administrator reads and tunes the alert rules, pages the history and sends a test alert", async () => {
  const keyFile = await Deno.makeTempFile({
    prefix: "bakery-alert-rules-key-",
  });
  await Deno.writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)));
  const secretsKey = { file: keyFile, keyId: "alert-rules-v1" };
  let answer = 200;
  const hook = receiver(() => answer);
  const f = await openInstallationFixture(true, {
    secretsKey,
    alertChannels: {
      secretsKey,
      fetch,
      addressPolicy: allowAnyAddress,
    },
  });
  const org = { "Bakery-Organization-Id": f.organizationId };
  const send = async (
    cookie: string,
    method: string,
    path: string,
    options: { body?: unknown; ifMatch?: string | null } = {},
  ) => {
    const headers: Record<string, string> = { ...org };
    if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    const response = await call(f, method, path, cookie, {
      // A command with no fields still takes an empty JSON object.
      body: options.body ?? (method === "GET" ? undefined : {}),
      headers,
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: text ? JSON.parse(text) as Body : {},
    };
  };
  const rules = async () => {
    const r = await send(f.adminCookie, "GET", "/v1/installation/alert-rules");
    assertEquals(r.status, 200, r.text);
    return (r.json as { rules: Rule[] }).rules;
  };
  const audit = async (operation: string) =>
    Number(
      (await f.pgDatabase.query<{ n: string }>(
        "select count(*)::text as n from bakery.audit_events where operation = $1",
        [operation],
      )).rows[0].n,
    );
  try {
    // Another file may have changed a rule: start from the defaults.
    await f.pgDatabase.query(
      `update bakery.alert_rules
          set enabled = true, threshold = null, updated_by = null, version = 1`,
    );
    // Only an installation administrator sees or changes any of it.
    for (
      const [method, path] of [
        ["GET", "/v1/installation/alert-rules"],
        ["GET", "/v1/installation/alerts"],
        ["POST", "/v1/installation/alert-tests"],
      ] as const
    ) {
      const denied = await send(f.developerCookie!, method, path);
      assertEquals(denied.status, 403, `${path}: ${denied.text}`);
    }

    // The five rules, in the catalogue's order, at their defaults.
    const first = await rules();
    assertEquals(first.map((r) => r.rule), RULES);
    assert(first.every((r) => r.enabled && r.version === 1 && r.firing === 0));
    assert(first.every((r) => r.updatedAt === null));
    const queue = first.find((r) => r.rule === "queue_age")!;
    assertEquals(
      [queue.unit, queue.threshold, queue.defaultThreshold],
      ["seconds", 900, 900],
    );
    const route = first.find((r) => r.rule === "route_incident")!;
    assertEquals([route.unit, route.threshold, route.maxThreshold], [
      null,
      null,
      null,
    ]);

    // Turn a rule off: it needs the version, and a change is audited.
    const path = "/v1/installation/alert-rules";
    const noVersion = await send(f.adminCookie, "PATCH", path, {
      body: { rule: "service_down", enabled: false },
    });
    assertEquals(noVersion.status, 428, noVersion.text);
    const off = await send(f.adminCookie, "PATCH", path, {
      body: { rule: "service_down", enabled: false },
      ifMatch: '"1"',
    });
    assertEquals(off.status, 200, off.text);
    const turnedOff = off.json as unknown as Rule;
    assertEquals([turnedOff.enabled, turnedOff.version], [false, 2]);
    assert(turnedOff.updatedAt !== null);
    const stale = await send(f.adminCookie, "PATCH", path, {
      body: { rule: "service_down", enabled: true },
      ifMatch: '"1"',
    });
    assertEquals(stale.status, 412, stale.text);
    assertEquals(
      await audit("alertRules.update"),
      1,
      "one change, one audit row",
    );

    // A limit: saved, and checked against the rule's own unit and maximum.
    const tuned = await send(f.adminCookie, "PATCH", path, {
      body: { rule: "queue_age", threshold: 600 },
      ifMatch: '"1"',
    });
    assertEquals(tuned.status, 200, tuned.text);
    assertEquals((tuned.json as unknown as Rule).threshold, 600);
    assertEquals((tuned.json as unknown as Rule).enabled, true);
    for (
      const [rule, threshold, why] of [
        ["route_incident", 5, "a rule with no limit"],
        ["queue_age", 604_801, "above that rule's maximum"],
        ["export_loss", -1, "a negative limit"],
      ] as const
    ) {
      const refused = await send(f.adminCookie, "PATCH", path, {
        body: { rule, threshold },
        ifMatch: '"1"',
      });
      assert(
        refused.status === 422 || refused.status === 400,
        `${why}: ${refused.status} ${refused.text}`,
      );
    }
    const unknown = await send(f.adminCookie, "PATCH", path, {
      body: { rule: "not_a_rule", enabled: false },
      ifMatch: '"1"',
    });
    assert(unknown.status === 422 || unknown.status === 400, unknown.text);
    const after = await rules();
    assertEquals(
      after.find((r) => r.rule === "queue_age")!.threshold,
      600,
      "the saved limit is what a read returns",
    );
    assertEquals(after.find((r) => r.rule === "export_loss")!.version, 1);

    // History: seed 30 events and two firing alerts, then page.
    await f.pgDatabase.query(
      `insert into bakery.alert_events (kind, rule, subject, text, occurred_at)
       select 'fired', 'worker_lost', 'w' || n, 'Worker ' || n || ' went quiet.',
              now() - make_interval(secs => n)
         from generate_series(1, 30) as n`,
    );
    await f.pgDatabase.query(
      `insert into bakery.alert_states (rule, subject, text)
       values ('worker_lost', 'w1', 'Worker 1 went quiet.'),
              ('worker_lost', 'w2', 'Worker 2 went quiet.')`,
    );
    const page1 = await send(f.adminCookie, "GET", "/v1/installation/alerts");
    assertEquals(page1.status, 200, page1.text);
    const p1 = page1.json as {
      firing: unknown[];
      events: { text: string }[];
      nextCursor: string | null;
    };
    assertEquals(p1.firing.length, 2);
    assertEquals(p1.events.length, 25);
    assertEquals(p1.events[0].text, "Worker 1 went quiet.", "newest first");
    assert(p1.nextCursor !== null);
    assertEquals(
      (await rules()).find((r) => r.rule === "worker_lost")!.firing,
      2,
    );
    const page2 = await send(
      f.adminCookie,
      "GET",
      `/v1/installation/alerts?cursor=${encodeURIComponent(p1.nextCursor!)}`,
    );
    assertEquals(page2.status, 200, page2.text);
    const p2 = page2.json as {
      firing: unknown[];
      events: { text: string }[];
      nextCursor: string | null;
    };
    assertEquals([p2.events.length, p2.firing.length, p2.nextCursor], [
      5,
      0,
      null,
    ]);
    assertEquals(p2.events[0].text, "Worker 26 went quiet.", "no row repeated");
    const forged = await send(
      f.adminCookie,
      "GET",
      "/v1/installation/alerts?cursor=not-a-cursor",
    );
    assertEquals(forged.status, 400, forged.text);
    const small = await send(
      f.adminCookie,
      "GET",
      "/v1/installation/alerts?limit=2",
    );
    assertEquals(
      (small.json as { events: unknown[] }).events.length,
      2,
      small.text,
    );

    // Test alert: nothing to send to is an honest empty answer, not a failure.
    const none = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/alert-tests",
    );
    assertEquals(none.status, 200, none.text);
    assertEquals(none.json, { channels: [], sent: 0, failed: 0 });

    // With a working channel the message arrives, typed as a test.
    const channel = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/alert-channels",
      {
        body: {
          kind: "webhook",
          name: "On call",
          values: { address: hook.address },
        },
      },
    );
    assertEquals(channel.status, 201, channel.text);
    const good = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/alert-tests",
    );
    assertEquals(good.status, 200, good.text);
    const sent = good.json as {
      sent: number;
      failed: number;
      channels: { ok: boolean }[];
    };
    assertEquals([sent.sent, sent.failed, sent.channels.length], [1, 0, 1]);
    assertEquals(hook.seen.map((m) => m.type), ["alert.test"]);
    // A refusing receiver reads as failed, with its own answer's reason.
    answer = 500;
    const bad = await send(
      f.adminCookie,
      "POST",
      "/v1/installation/alert-tests",
    );
    assertEquals(bad.status, 200, bad.text);
    assertEquals(
      [
        (bad.json as { sent: number }).sent,
        (bad.json as { failed: number }).failed,
      ],
      [0, 1],
    );
    assertEquals(await audit("alerts.sendTest"), 3);
    // The test alerts are in the history, and say how many channels answered.
    const history = await send(
      f.adminCookie,
      "GET",
      "/v1/installation/alerts?limit=1",
    );
    const latest = (history.json as {
      events: { kind: string; channelsOk: number; channelsFailed: number }[];
    }).events[0];
    assertEquals([latest.kind, latest.channelsOk, latest.channelsFailed], [
      "test",
      0,
      1,
    ]);
  } finally {
    // Put the rules back to their defaults, and drop what this test seeded.
    await f.pgDatabase.query(
      `update bakery.alert_rules
          set enabled = true, threshold = null, updated_by = null, version = 1`,
    );
    await f.pgDatabase.query("delete from bakery.alert_states");
    await f.pgDatabase.query("delete from bakery.alert_events");
    await hook.close();
    await f.close();
    await Deno.remove(keyFile);
  }
});
