import { assert, assertEquals, assertExists } from "@std/assert";
import {
  cleanupDraftFixture,
  type DraftFixture,
  draftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";
import { authTestOrigin, signSessionCookie } from "../helpers/auth.ts";
import {
  connectWebSocket,
  type WebSocketHandshakeFailure,
  type WebSocketNext,
  type WsClient,
} from "../helpers/ws-client.ts";
import type { CollaborationSocketLimits } from "../../apps/server/src/modules/knowledge/collaboration-socket.ts";

type Frame = Record<string, unknown> & { type: string };
type Member = {
  providerUserId: string;
  principalId: string;
  sessionToken: string;
  cookie: string;
  displayName: string;
};

type Harness = {
  fixture: DraftFixture;
  draftId: string;
  url: (organizationId?: string) => URL;
  owner: Member;
  extra: Member[];
  clients: Set<WsClient>;
  server: Deno.HttpServer;
};

async function addMember(
  fixture: DraftFixture,
  organizationId: string,
  displayName: string,
): Promise<Member> {
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();
  const now = new Date();
  const db = fixture.pgDatabase;
  await db.query(
    `insert into public."user" (id,name,email,"emailVerified","createdAt","updatedAt")
     values ($1,$2,$3,true,$4,$4)`,
    [providerUserId, displayName, `collab-${providerUserId}@example.test`, now],
  );
  await db.query(
    `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
     values ($1,$2,$3,'human')`,
    [principalId, providerUserId, displayName],
  );
  if (organizationId === fixture.ids.organizationId) {
    await db.query(
      `insert into public.member (id,"organizationId","userId",role,status,"createdAt","joinedAt","updatedAt")
       values ($1,$2,$3,'developer','active',$4,$4,$4)`,
      [crypto.randomUUID(), organizationId, providerUserId, now],
    );
    await db.query(
      `insert into bakery.organization_memberships (id,organization_id,principal_id,role,status,joined_at,created_at,updated_at,version)
       values ($1,$2,$3,'developer','active',$4,$4,$4,1)`,
      [crypto.randomUUID(), organizationId, principalId, now],
    );
  }
  await db.query(
    `insert into public.session (id,token,"userId","expiresAt","createdAt","updatedAt")
     values ($1,$2,$3,$4,$5,$5)`,
    [
      crypto.randomUUID(),
      sessionToken,
      providerUserId,
      new Date(Date.now() + 3_600_000),
      now,
    ],
  );
  return {
    providerUserId,
    principalId,
    sessionToken,
    cookie: await signSessionCookie(
      sessionToken,
      fixture.config.auth!.secret,
    ),
    displayName,
  };
}

async function openHarness(
  limits: Partial<CollaborationSocketLimits> = {},
  upgradeWebSocket?: (
    request: Request,
    options: Deno.UpgradeWebSocketOptions,
  ) => Deno.WebSocketUpgrade,
): Promise<Harness> {
  const fixture = await openDraftFixture("alpha target omega", {
    collaborationSocket: { limits, upgradeWebSocket },
  });
  const opened = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
    { method: "POST" },
  ));
  assertEquals(opened.status, 201, await opened.clone().text());
  const draftId = (await responseJson(opened) as { id: string }).id;
  const owner: Member = {
    providerUserId: fixture.ids.providerUserId,
    principalId: fixture.ids.principalId,
    sessionToken: "",
    cookie: fixture.cookie,
    displayName: "Draft Developer",
  };
  let resolvePort: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, (request) => fixture.app.fetch(request));
  const port = await listening;
  return {
    fixture,
    draftId,
    owner,
    extra: [],
    clients: new Set(),
    server,
    url: (organizationId = fixture.ids.organizationId) => {
      const url = new URL(`ws://127.0.0.1:${port}/v1/collaboration`);
      url.searchParams.set("organizationId", organizationId);
      return url;
    },
  };
}

async function connect(
  harness: Harness,
  member: Member,
  options: { organizationId?: string; origin?: string | null } = {},
): Promise<WsClient | WebSocketHandshakeFailure> {
  const headers = new Headers({ Cookie: member.cookie });
  if (options.origin !== null) {
    headers.set("Origin", options.origin ?? authTestOrigin);
  }
  const client = await connectWebSocket(harness.url(options.organizationId), {
    headers,
  });
  if ("send" in client) harness.clients.add(client);
  return client;
}

async function open(harness: Harness, member: Member): Promise<WsClient> {
  const client = await connect(harness, member);
  assert("send" in client, JSON.stringify(client));
  const hello = await nextFrame(client);
  assertEquals(hello.type, "hello");
  assertEquals(hello.presenceTtlSeconds !== undefined, true);
  return client;
}

async function nextFrame(client: WsClient, timeoutMs = 3_000): Promise<Frame> {
  const value: WebSocketNext = await client.next(timeoutMs);
  if (typeof value !== "string") {
    throw new Error(`socket closed ${value.code} ${value.reason}`);
  }
  return JSON.parse(value) as Frame;
}

/** Next frame of `type`, skipping others; fails on close or timeout. */
async function until(
  client: WsClient,
  type: string,
  timeoutMs = 3_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`no ${type} frame`);
    const frame = await nextFrame(client, left);
    if (frame.type === type) return frame;
  }
}

/** Frames received within `ms`; stops early on close. */
async function drain(client: WsClient, ms: number): Promise<{
  frames: Frame[];
  closed?: { code: number; reason: string };
}> {
  const frames: Frame[] = [];
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { frames };
    let value: WebSocketNext;
    try {
      value = await client.next(left);
    } catch {
      return { frames };
    }
    if (typeof value !== "string") return { frames, closed: value };
    frames.push(JSON.parse(value) as Frame);
  }
}

function room(harness: Harness, id = harness.draftId) {
  return { kind: "draft", id };
}

async function join(client: WsClient, harness: Harness, id?: string) {
  const requestId = crypto.randomUUID();
  await client.send(JSON.stringify({
    type: "join",
    requestId,
    room: room(harness, id),
  }));
  return requestId;
}

function presence(harness: Harness, state: Record<string, unknown>) {
  return JSON.stringify({
    type: "presence.update",
    requestId: crypto.randomUUID(),
    room: room(harness),
    state: { activity: "active", typing: false, cursor: null, ...state },
  });
}

async function closeHarness(harness: Harness) {
  for (const client of harness.clients) {
    await client.close().catch(() => {});
  }
  await harness.server.shutdown();
  for (const member of harness.extra) {
    const db = harness.fixture.pgDatabase;
    await db.query('delete from public.session where "userId"=$1', [
      member.providerUserId,
    ]);
    await db.query(
      "delete from bakery.organization_memberships where principal_id=$1",
      [member.principalId],
    );
    await db.query('delete from public.member where "userId"=$1', [
      member.providerUserId,
    ]);
    await db.query("delete from bakery.principals where id=$1", [
      member.principalId,
    ]);
    await db.query('delete from public."user" where id=$1', [
      member.providerUserId,
    ]);
  }
  try {
    await cleanupDraftFixture(harness.fixture);
  } finally {
    await harness.fixture.close();
  }
}

Deno.test("members join a draft room with server-derived identities and relay only validated presence", async () => {
  const harness = await openHarness();
  try {
    const second = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Second Person",
    );
    harness.extra.push(second);
    const a = await open(harness, harness.owner);
    const aJoin = await join(a, harness);
    const aJoined = await until(a, "joined");
    assertEquals(aJoined.requestId, aJoin);
    const aParticipants = aJoined.participants as Record<string, unknown>[];
    assertEquals(aParticipants.length, 1);
    assertEquals(aParticipants[0]!.principalId, harness.owner.principalId);

    const b = await open(harness, second);
    await join(b, harness);
    const bJoined = await until(b, "joined");
    const ids = (bJoined.participants as { principalId: string }[])
      .map((p) => p.principalId).sort();
    assertEquals(ids, [harness.owner.principalId, second.principalId].sort());
    const arrived = await until(a, "presence");
    const arrivedPresence = arrived.presence as Record<string, unknown>;
    assertEquals(arrivedPresence.principalId, second.principalId);
    assertEquals(arrivedPresence.displayName, "Second Person");
    assertEquals(arrivedPresence.principalType, "human");

    // A presence frame that claims another identity is refused and not relayed.
    await b.send(JSON.stringify({
      type: "presence.update",
      requestId: crypto.randomUUID(),
      room: room(harness),
      state: { activity: "active", typing: true, cursor: null },
      principalId: harness.owner.principalId,
      displayName: "Draft Developer",
    }));
    const refused = await until(b, "problem");
    assertEquals(
      (refused.problem as { code: string }).code,
      "MALFORMED_REQUEST",
    );
    const leaked = await drain(a, 400);
    assertEquals(leaked.frames.filter((f) => f.type === "presence"), []);

    // A valid hint is relayed with the server's identity and receipt time.
    await b.send(presence(harness, {
      typing: true,
      cursor: { anchor: "AQID", head: "AQIE" },
    }));
    const relayed = (await until(a, "presence")).presence as {
      principalId: string;
      state: { typing: boolean; cursor: { head: string } };
      receivedAt: string;
    };
    assertEquals(relayed.principalId, second.principalId);
    assertEquals(relayed.state.typing, true);
    assertEquals(relayed.state.cursor.head, "AQIE");
    assert(Math.abs(Date.parse(relayed.receivedAt) - Date.now()) < 10_000);

    // Leaving and closing both remove the participant for the others.
    await b.send(JSON.stringify({
      type: "leave",
      requestId: crypto.randomUUID(),
      room: room(harness),
    }));
    assertEquals((await until(b, "left")).type, "left");
    const left = await until(a, "presence.removed");
    assertEquals(left.reason, "left");
    await join(b, harness);
    await until(b, "joined");
    await until(a, "presence");
    await b.close();
    harness.clients.delete(b);
    assertEquals((await until(a, "presence.removed")).reason, "closed");
  } finally {
    await closeHarness(harness);
  }
});

Deno.test("only permitted participants join: foreign organizations, unknown drafts and bad origins are refused", async () => {
  const harness = await openHarness();
  try {
    const outsider = await addMember(
      harness.fixture,
      crypto.randomUUID(),
      "Outsider",
    );
    harness.extra.push(outsider);
    // Not a member of the draft's organization: refused before upgrade.
    const refused = await connect(harness, outsider);
    assert(!("send" in refused));
    assert(
      refused.status === 403 || refused.status === 404,
      `status ${refused.status}`,
    );
    // No session: refused before upgrade.
    const anonymous = await connect(harness, {
      ...harness.owner,
      cookie: "",
    });
    assert(!("send" in anonymous));
    assertEquals(anonymous.status, 401);
    // A foreign Origin is refused before upgrade.
    const foreign = await connect(harness, harness.owner, {
      origin: "https://evil.example",
    });
    assert(!("send" in foreign));
    assertEquals(foreign.status, 403);

    // A member cannot join a draft that does not exist in the organization.
    const a = await open(harness, harness.owner);
    const requestId = await join(a, harness, crypto.randomUUID());
    const problem = await until(a, "problem");
    assertEquals(problem.requestId, requestId);
    assertEquals(
      (problem.problem as { code: string }).code,
      "RESOURCE_NOT_FOUND",
    );
    // Presence for a room never joined is refused.
    await a.send(presence(harness, {}));
    assertEquals(
      ((await until(a, "problem")).problem as { code: string }).code,
      "RESOURCE_NOT_FOUND",
    );
  } finally {
    await closeHarness(harness);
  }
});

Deno.test("presence expires after its TTL and lost sessions or access are removed at the next check", async () => {
  const harness = await openHarness({
    presenceTtlSeconds: 1,
    sweepMilliseconds: 200,
  });
  try {
    const second = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Second Person",
    );
    const third = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Third Person",
    );
    harness.extra.push(second, third);
    const a = await open(harness, harness.owner);
    await join(a, harness);
    await until(a, "joined");
    // The observer keeps its own presence fresh, as a client heartbeat does.
    const keepAlive = setInterval(() => {
      a.send(presence(harness, {})).catch(() => {});
    }, 250);
    try {
      await observeExpiryAndRevocation(harness, a, second, third);
    } finally {
      clearInterval(keepAlive);
    }
  } finally {
    await closeHarness(harness);
  }
});

async function observeExpiryAndRevocation(
  harness: Harness,
  a: WsClient,
  second: Member,
  third: Member,
) {
  {
    // A participant that stops refreshing expires, though still connected.
    const b = await open(harness, second);
    await join(b, harness);
    await until(b, "joined");
    await until(a, "presence");
    const expired = await until(a, "presence.removed", 3_000);
    assertEquals(expired.reason, "expired");

    // Logout: the session row goes away; the next check removes and closes.
    const c = await open(harness, third);
    await join(c, harness);
    await until(c, "joined");
    await harness.fixture.pgDatabase.query(
      "delete from public.session where token=$1",
      [third.sessionToken],
    );
    const ended = await drain(c, 2_000);
    assertExists(ended.closed);
    assertEquals(ended.closed.code, 1008);
    const removedReasons: unknown[] = [];
    for (;;) {
      const frame = await until(a, "presence.removed", 2_000).catch(() =>
        undefined
      );
      if (!frame) break;
      removedReasons.push(frame.reason);
      if (frame.reason === "revoked") break;
    }
    assert(removedReasons.includes("revoked"), JSON.stringify(removedReasons));
  }
  {
    // Lost membership: the next check removes the participant from the room.
    const b = await open(harness, second);
    await join(b, harness);
    await until(b, "joined");
    await harness.fixture.pgDatabase.query(
      "delete from bakery.organization_memberships where principal_id=$1",
      [second.principalId],
    );
    for (;;) {
      const frame = await until(a, "presence.removed", 3_000);
      if (frame.reason === "revoked") break;
    }
    const problem = await until(b, "problem", 3_000);
    assert(
      ["AUTH_FORBIDDEN", "RESOURCE_NOT_FOUND"].includes(
        (problem.problem as { code: string }).code,
      ),
      JSON.stringify(problem.problem),
    );
  }
}

Deno.test("excess cursor traffic is coalesced to the rate limit and the latest state wins", async () => {
  const harness = await openHarness();
  try {
    const second = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Second Person",
    );
    harness.extra.push(second);
    const a = await open(harness, harness.owner);
    await join(a, harness);
    await until(a, "joined");
    const b = await open(harness, second);
    await join(b, harness);
    await until(b, "joined");
    await until(a, "presence");

    await b.sendMany(
      Array.from(
        { length: 30 },
        (_, index) =>
          presence(harness, {
            cursor: { anchor: "AQID", head: `H${index}` },
          }),
      ),
    );
    const received = (await drain(a, 1_800)).frames.filter((f) =>
      f.type === "presence"
    );
    assert(received.length <= 6, `relayed ${received.length} of 30`);
    const last = received.at(-1)!.presence as {
      state: { cursor: { head: string } };
    };
    assertEquals(last.state.cursor.head, "H29");
  } finally {
    await closeHarness(harness);
  }
});

Deno.test("a slow peer gets no presence past the buffer budget and is closed after the grace period", async () => {
  let slowNext = false;
  const harness = await openHarness(
    { maxBufferedBytes: 1_024, backpressureGraceMilliseconds: 300 },
    (request, options) => {
      const upgraded = Deno.upgradeWebSocket(request, options);
      if (slowNext) {
        slowNext = false;
        Object.defineProperty(upgraded.socket, "bufferedAmount", {
          get: () => 1_000_000,
        });
      }
      return upgraded;
    },
  );
  try {
    const second = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Slow Person",
    );
    harness.extra.push(second);
    const a = await open(harness, harness.owner);
    await join(a, harness);
    await until(a, "joined");
    slowNext = true;
    const slow = await open(harness, second);
    await join(slow, harness);
    await until(slow, "joined");
    await until(a, "presence");

    // The draining peer keeps sending; the slow peer receives none of it.
    for (let index = 0; index < 8; index += 1) {
      await a.send(presence(harness, { typing: index % 2 === 0 }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await drain(slow, 1_000);
    assertEquals(result.frames.filter((f) => f.type === "presence"), []);
    assertExists(result.closed);
    assertEquals(result.closed.code, 1008);
    assertEquals(result.closed.reason, "backpressure");
    // The draining twin is unaffected.
    await a.send(
      JSON.stringify({ type: "ping", requestId: crypto.randomUUID() }),
    );
    assertEquals((await until(a, "ping")).type, "ping");
  } finally {
    await closeHarness(harness);
  }
});
