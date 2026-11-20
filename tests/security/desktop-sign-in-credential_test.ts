import { assert, assertEquals, assertExists } from "@std/assert";
import {
  type InstallationFixture,
  openInstallationFixture,
} from "../helpers/installation-settings.ts";
import { call } from "../helpers/account-settings.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import {
  cleanupDraftFixture,
  openDraftFixture,
} from "../helpers/draft-fixture.ts";
import { connectWebSocket } from "../helpers/ws-client.ts";
import type {
  WebSocketHandshakeFailure,
  WsClient,
} from "../helpers/ws-client.ts";
import {
  bearerGet,
  cleanupDesktopSignIns,
  exchangeDesktopSignIn,
  signInDesktop,
} from "../helpers/desktop-sign-in.ts";

async function withFixture(run: (f: InstallationFixture) => Promise<void>) {
  const f = await openInstallationFixture();
  try {
    await run(f);
  } finally {
    await cleanupDesktopSignIns(f);
    await f.finish();
  }
}

function isClient(
  value: WsClient | WebSocketHandshakeFailure,
): value is WsClient {
  return "send" in value;
}

async function problemCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

Deno.test("a desktop credential is denied in an organization its person does not belong to", async () => {
  await withFixture(async (f) => {
    const created = await call(f, "POST", "/v1/organizations", f.adminCookie, {
      body: {
        name: "Other Bakery",
        slug: `other-${crypto.randomUUID().slice(0, 8)}`,
      },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    assertEquals(created.status, 201, await created.clone().text());
    const other = (await created.json()) as { id: string };
    const issued = await signInDesktop(f, f.developerCookie);

    const own = await f.app.fetch(
      bearerGet(`/v1/organizations/${f.organizationId}`, issued.credential, {
        "Bakery-Organization-Id": f.organizationId,
      }),
    );
    assertEquals(own.status, 200, await own.clone().text());
    const foreign = await f.app.fetch(
      bearerGet(`/v1/organizations/${other.id}`, issued.credential, {
        "Bakery-Organization-Id": other.id,
      }),
    );
    assert(
      foreign.status === 403 || foreign.status === 404,
      `expected denial, got ${foreign.status}`,
    );
    assert(!(await foreign.text()).includes("Other Bakery"));
  });
});

Deno.test("a revoked desktop sign-in is refused by the page API", async () => {
  await withFixture(async (f) => {
    const issued = await signInDesktop(f, f.developerCookie);
    assertEquals(
      (await f.app.fetch(bearerGet("/v1/me", issued.credential))).status,
      200,
    );
    const revoked = await call(
      f,
      "DELETE",
      `/v1/me/sessions/${issued.sessionId}`,
      f.developerCookie,
    );
    assertEquals(revoked.status, 200, await revoked.clone().text());
    const after = await f.app.fetch(bearerGet("/v1/me", issued.credential));
    assertEquals(after.status, 401);
    assertEquals(await problemCode(after), "AUTH_INVALID");
    const browser = await call(f, "GET", "/v1/me", f.developerCookie);
    assertEquals(browser.status, 200);
  });
});

Deno.test("forged, malformed and expired desktop credentials are refused", async () => {
  await withFixture(async (f) => {
    const forged = await f.app.fetch(
      bearerGet("/v1/me", `bkd_${"A".repeat(43)}`),
    );
    assertEquals(forged.status, 401);
    const malformed = await f.app.fetch(bearerGet("/v1/me", "bkd_short"));
    assertEquals(malformed.status, 401);
    assertEquals(await problemCode(malformed), "AUTH_INVALID");
    const issued = await signInDesktop(f, f.developerCookie);
    await f.pgDatabase.query(
      `update public.session set "expiresAt" = now() - interval '1 second' where id = $1`,
      [issued.sessionId],
    );
    const expired = await f.app.fetch(bearerGet("/v1/me", issued.credential));
    assertEquals(expired.status, 401);
    assertEquals(await problemCode(expired), "AUTH_EXPIRED");
  });
});

Deno.test("live updates accept a desktop credential and close when it is revoked", async () => {
  // Re-authorization runs on the heartbeat and on each subscribed tick, as for
  // a cookie session: a short heartbeat and a subscription make it prompt.
  const f = await openSocketFixture({
    eventsSocket: { limits: { heartbeatMs: 25 } },
  });
  let client: WsClient | undefined;
  try {
    const issued = await signInDesktop(f, f.cookie);
    const connected = await f.connect({
      origin: null,
      headers: { authorization: `Bearer ${issued.credential}` },
    });
    assert(isClient(connected), JSON.stringify(connected));
    client = connected;
    const hello = await client.next(2_500);
    assertEquals(typeof hello, "string");
    assertEquals(f.assertFrame(hello as string).type, "hello");
    await client.send(JSON.stringify({
      type: "subscribe",
      requestId: crypto.randomUUID(),
      scopes: [{ type: "task", id: f.taskId }],
      after: null,
    }));
    const subscribed = await client.next(2_500);
    assertEquals(typeof subscribed, "string");
    assertEquals(f.assertFrame(subscribed as string).type, "cursor");

    const deleted = await f.pgDatabase.query(
      "delete from public.session where id = $1",
      [issued.sessionId],
    );
    assertEquals(deleted.rowCount, 1);
    await f.insertDomainEvent({ eventType: "tasks.updated" });
    let close: { code: number; reason: string } | undefined;
    const frames: string[] = [];
    for (let index = 0; index < 8 && !close; index++) {
      const next = await client.next(2_500);
      if (typeof next === "string") frames.push(next);
      else close = next;
    }
    assertExists(close);
    assertEquals(close.code, 1008);
    assert(!frames.some((frame) => f.assertFrame(frame).type === "events"));

    const again = await f.connect({
      origin: null,
      headers: { authorization: `Bearer ${issued.credential}` },
    });
    assert(!isClient(again), "a revoked credential cannot open a socket");
    assertEquals(again.status, 401);
  } finally {
    await client?.close();
    await cleanupDesktopSignIns(f);
    await cleanupAuthFixture(f.pgDatabase, [f.email]);
    await f.close();
  }
});

Deno.test("a web-view socket carries the desktop credential as a subprotocol, from the app's own origin", async () => {
  const f = await openSocketFixture();
  let client: WsClient | undefined;
  try {
    const issued = await signInDesktop(f, f.cookie);
    const carrier = {
      origin: "tauri://localhost",
      headers: {
        "sec-websocket-protocol": "bakery.desktop, bakery.credential." +
          issued.credential,
      },
    };
    const connected = await f.connect(carrier);
    assert(isClient(connected), JSON.stringify(connected));
    client = connected;
    // The server selects the desktop protocol and never echoes the credential.
    assertEquals(
      client.protocol,
      "bakery.desktop",
    );
    const hello = await client.next(2_500);
    assertEquals(typeof hello, "string");
    assertEquals(f.assertFrame(hello as string).type, "hello");
    await client.close();
    client = undefined;

    // A malformed carried value is no credential: the origin guard refuses
    // it as it refuses a malformed Authorization header from that origin.
    const malformed = await f.connect({
      origin: "tauri://localhost",
      headers: {
        "sec-websocket-protocol": "bakery.desktop, bakery.credential.bkd_short",
      },
    });
    assert(!isClient(malformed), "a malformed credential opened a socket");
    assertEquals(malformed.status, 403);

    const deleted = await f.pgDatabase.query(
      "delete from public.session where id = $1",
      [issued.sessionId],
    );
    assertEquals(deleted.rowCount, 1);
    const revoked = await f.connect(carrier);
    assert(!isClient(revoked), "a revoked credential cannot open a socket");
    assertEquals(revoked.status, 401);
  } finally {
    await client?.close();
    await cleanupDesktopSignIns(f);
    await cleanupAuthFixture(f.pgDatabase, [f.email]);
    await f.close();
  }
});

Deno.test("the collaboration socket accepts the carrier from any origin, never echoes it, and refuses it once revoked", async () => {
  const fixture = await openDraftFixture("alpha target omega", {
    collaborationSocket: { limits: {} },
  });
  let resolvePort: (p: number) => void = () => {};
  const listening = new Promise<number>((r) => resolvePort = r);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, (request) => fixture.app.fetch(request));
  const port = await listening;
  const url = new URL("ws://127.0.0.1:" + port + "/v1/collaboration");
  url.searchParams.set("organizationId", fixture.ids.organizationId);
  let client: WsClient | undefined;
  try {
    const issued = await signInDesktop(fixture, fixture.cookie);
    const headers = new Headers({
      Origin: "https://evil.example",
      "sec-websocket-protocol": "bakery.desktop, bakery.credential." +
        issued.credential,
    });
    const c = await connectWebSocket(url, { headers });
    assert(isClient(c), "collab carrier refused: " + JSON.stringify(c));
    client = c;
    assertEquals(c.protocol, "bakery.desktop");
    const hello = await c.next(3_000);
    assertEquals(typeof hello, "string");
    assertEquals(
      (JSON.parse(hello as string) as { type: string }).type,
      "hello",
    );
    await c.close();
    client = undefined;
    const bad = await connectWebSocket(url, {
      headers: new Headers({
        Origin: "https://evil.example",
        "sec-websocket-protocol": "bakery.desktop, bakery.credential.bkd_short",
      }),
    });
    assert(!isClient(bad), "malformed credential opened collab socket");
    await fixture.pgDatabase.query("delete from public.session where id = $1", [
      issued.sessionId,
    ]);
    const revoked = await connectWebSocket(url, { headers });
    assert(!isClient(revoked), "revoked credential opened collab socket");
    assertEquals(revoked.status, 401);
  } finally {
    await client?.close().catch(() => {});
    await server.shutdown();
    await cleanupDesktopSignIns(fixture);
    await cleanupDraftFixture(fixture);
    await fixture.close();
  }
});

Deno.test("a plain request never authenticates with the carrier, even with upgrade headers", async () => {
  await withFixture(async (f) => {
    const issued = await signInDesktop(f, f.developerCookie);
    const response = await f.app.fetch(
      new Request("http://127.0.0.1:8788/v1/me", {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-protocol": "bakery.desktop, bakery.credential." +
            issued.credential,
        },
      }),
    );
    assertEquals(response.status, 401, await response.text());
  });
});

Deno.test("no credential, code or verifier reaches the logs", async () => {
  const lines: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const capture = (...values: unknown[]) => {
    lines.push(
      values.map((value) => {
        try {
          return typeof value === "string" ? value : JSON.stringify(value);
        } catch {
          return String(value);
        }
      }).join(" "),
    );
  };
  console.log =
    console.info =
    console.warn =
    console.error =
    console.debug =
      capture;
  try {
    await withFixture(async (f) => {
      const issued = await signInDesktop(f, f.developerCookie);
      await f.app.fetch(bearerGet("/v1/me", issued.credential));
      await exchangeDesktopSignIn(f, issued.id, {
        code: issued.code,
        codeVerifier: issued.verifier,
      });
      await f.app.fetch(bearerGet("/v1/me", issued.credential));
      await f.app.fetch(bearerGet("/v1/me", `${issued.credential}x`));
      const output = lines.join("\n");
      for (const secret of [issued.credential, issued.code, issued.verifier]) {
        assert(!output.includes(secret), "a desktop secret reached the logs");
      }
      const audit = await f.pgDatabase.query<{ details: unknown }>(
        "select details from bakery.audit_events where resource_id = $1",
        [issued.id],
      );
      const auditText = JSON.stringify(audit.rows);
      for (const secret of [issued.credential, issued.code, issued.verifier]) {
        assert(!auditText.includes(secret), "a desktop secret reached audit");
      }
    });
  } finally {
    Object.assign(console, original);
  }
});
