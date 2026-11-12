import { assert, assertEquals } from "@std/assert";
import { authTestOrigin, openAuthFixture } from "../helpers/auth.ts";
import {
  type CollaborationWorld,
  collect,
  connectCollaboration,
  seedCollaborationWorld,
  untilFrame,
} from "../helpers/collaboration-world.ts";
import type { WsClient } from "../helpers/ws-client.ts";

type Harness = {
  fixture: Awaited<ReturnType<typeof openAuthFixture>>;
  server: Deno.HttpServer;
  base: string;
  worlds: CollaborationWorld[];
  clients: WsClient[];
};

async function openHarness(): Promise<Harness> {
  const fixture = await openAuthFixture();
  let resolvePort: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, (request) => fixture.app.fetch(request));
  return {
    fixture,
    server,
    base: `http://127.0.0.1:${await listening}`,
    worlds: [],
    clients: [],
  };
}

async function world(harness: Harness): Promise<CollaborationWorld> {
  const created = await seedCollaborationWorld(
    (sql, params) => harness.fixture.pgDatabase.query(sql, params),
    harness.fixture.config.auth!.secret,
    { label: "collab-sec" },
  );
  harness.worlds.push(created);
  return created;
}

async function openDraft(
  harness: Harness,
  target: CollaborationWorld,
): Promise<string> {
  const response = await harness.fixture.app.fetch(
    new Request(
      `${authTestOrigin}/v1/artifacts/${target.artifactId}/drafts`,
      {
        method: "POST",
        headers: {
          cookie: target.members[0]!.cookie,
          origin: authTestOrigin,
          "Bakery-Organization-Id": target.organizationId,
        },
      },
    ),
  );
  assertEquals(response.status, 201, await response.clone().text());
  return (await response.json() as { id: string }).id;
}

async function connect(
  harness: Harness,
  organizationId: string,
  cookie: string | null,
  headers: Record<string, string> = {},
) {
  const client = await connectCollaboration(
    harness.base,
    organizationId,
    cookie,
    { origin: authTestOrigin, headers },
  );
  if ("send" in client) harness.clients.push(client);
  return client;
}

async function close(harness: Harness) {
  for (const client of harness.clients) await client.close().catch(() => {});
  await harness.server.shutdown();
  for (const created of harness.worlds) await created.cleanup();
  await harness.fixture.close();
}

Deno.test("a member of another organization cannot join or sync a draft by id", async () => {
  const harness = await openHarness();
  try {
    const victim = await world(harness);
    const attacker = await world(harness);
    const draftId = await openDraft(harness, victim);
    const client = await connect(
      harness,
      attacker.organizationId,
      attacker.members[0]!.cookie,
    );
    assert("send" in client, JSON.stringify(client));
    await untilFrame(client, "hello");
    for (const type of ["join", "sync"]) {
      await client.send(JSON.stringify({
        type,
        requestId: crypto.randomUUID(),
        room: { kind: "draft", id: draftId },
      }));
      const problem = await untilFrame(client, "problem");
      assertEquals(
        (problem.problem as { code: string }).code,
        "RESOURCE_NOT_FOUND",
        type,
      );
    }
    // Naming the victim's organization on the upgrade is refused outright.
    const crossed = await connect(
      harness,
      victim.organizationId,
      attacker.members[0]!.cookie,
    );
    assert(!("send" in crossed));
    assert([403, 404].includes(crossed.status), String(crossed.status));
    const received = await collect(client, 500);
    assertEquals(received.binaries, 0);
  } finally {
    await close(harness);
  }
});

Deno.test("only an assured browser session opens the socket: no bearer token, no pending second factor", async () => {
  const harness = await openHarness();
  try {
    const target = await world(harness);
    const member = target.members[0]!;
    // A bearer access token is not a browser session.
    const bearer = await connect(harness, target.organizationId, null, {
      Authorization: "Bearer bkr_pat_not_a_session_token_000000000000",
    });
    assert(!("send" in bearer));
    assertEquals(bearer.status, 401);
    // A session waiting for its second factor is refused before upgrade.
    await harness.fixture.pgDatabase.query(
      'update public."user" set "twoFactorEnabled"=true where id=$1',
      [member.providerUserId],
    );
    const pending = await connect(
      harness,
      target.organizationId,
      member.cookie,
    );
    assert(!("send" in pending));
    assert([401, 403].includes(pending.status), String(pending.status));
    // Once the factor is verified the same session upgrades.
    await harness.fixture.pgDatabase.query(
      'update public.session set "factorVerifiedAt"=now() where token=$1',
      [member.sessionToken],
    );
    const verified = await connect(
      harness,
      target.organizationId,
      member.cookie,
    );
    assert("send" in verified, JSON.stringify(verified));
  } finally {
    await close(harness);
  }
});

Deno.test("refusals never echo client input back", async () => {
  const harness = await openHarness();
  try {
    const target = await world(harness);
    const client = await connect(
      harness,
      target.organizationId,
      target.members[0]!.cookie,
    );
    assert("send" in client);
    await untilFrame(client, "hello");
    const marker = "SECRET-sk_live_0123456789abcdef";
    await client.send(JSON.stringify({
      type: "presence.update",
      requestId: crypto.randomUUID(),
      room: { kind: "draft", id: crypto.randomUUID() },
      state: { activity: "active", typing: false, cursor: null },
      principalId: marker,
    }));
    await client.send(`{"type":"join","note":"${marker}"`);
    const received = await collect(client, 1_000);
    assert(received.frames.length >= 2, JSON.stringify(received.frames));
    for (const frame of received.frames) {
      assertEquals(JSON.stringify(frame).includes(marker), false);
    }
  } finally {
    await close(harness);
  }
});
