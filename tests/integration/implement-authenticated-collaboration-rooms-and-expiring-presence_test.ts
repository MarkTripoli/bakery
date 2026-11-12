import { DRAFT_LIMITS } from "../../apps/server/src/modules/knowledge/drafts.ts";
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
import {
  BinaryFrameKind,
  type CollaborationSocketLimits,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "../../apps/server/src/modules/knowledge/collaboration-socket.ts";
import { LoroDoc } from "loro-crdt";

// An update is acknowledged only after its isolated worker starts and
// finishes. The product allows start-up workerStartupMs and the work
// workerRuntimeMs; an ack wait shorter than that budget fails a slow-but-
// healthy update on a busy host. Two seconds more cover the commit.
const ACK_WAIT_MS = DRAFT_LIMITS.workerStartupMs +
  DRAFT_LIMITS.workerRuntimeMs + 2_000;
// With two writers in one room, the second's prepared candidate can be stale
// once the first commits; the server re-prepares it, each attempt another
// isolated worker, up to DRAFT_LIMITS.staleAttempts times.
const CONTENDED_ACK_WAIT_MS = DRAFT_LIMITS.staleAttempts *
    (DRAFT_LIMITS.workerStartupMs + DRAFT_LIMITS.workerRuntimeMs) +
  2_000;

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
  /** Presence heartbeats started by keepPresent; cleared on close. */
  heartbeats: ReturnType<typeof setInterval>[];
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
    heartbeats: [],
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
    if (left <= 0) throw new Error(`no ${type} frame within ${timeoutMs} ms`);
    let frame: Frame;
    try {
      frame = await nextFrame(client, left);
    } catch (error) {
      // Name the frame the test was waiting for: a bare read timeout does
      // not say which step stalled.
      throw new Error(`waiting for ${type}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (frame.type === type) return frame;
    // Waiting for an ack, a refusal is the answer: report it, don't wait out
    // the window (the problem says why, e.g. a worker that timed out).
    if (
      type === "ack" &&
      (frame.type === "problem" || frame.type === "resync_required")
    ) {
      throw new Error(`expected ack, got ${JSON.stringify(frame)}`);
    }
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

/**
 * Keeps a joined client present, as a real client's heartbeat does. A test
 * that runs longer than the presence TTL on a busy host would otherwise see
 * its sender expire out of the room, and its next update refused as not
 * found. Tests about expiry leave their subjects silent instead.
 */
function keepPresent(harness: Harness, client: WsClient): void {
  harness.heartbeats.push(setInterval(() => {
    client.send(presence(harness, {})).catch(() => {});
  }, 1_000));
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
  for (const timer of harness.heartbeats) clearInterval(timer);
  for (const client of harness.clients) {
    await client.close().catch(() => {});
  }
  await harness.server.shutdown();
  // Closing a socket does not stop an admission already running on the
  // server, so a late update may still commit. Deleting the organization
  // first cascades every draft, update and receipt (and makes a straggling
  // commit fail on its missing draft), so no row references a member below.
  try {
    await cleanupDraftFixture(harness.fixture);
    const db = harness.fixture.pgDatabase;
    for (const member of harness.extra) {
      await db.query('delete from public.session where "userId"=$1', [
        member.providerUserId,
      ]);
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
    // c keeps its presence fresh, so only the revocation can remove it: a
    // silent c could expire first on a busy host, and "expired" (also true)
    // would then pre-empt the "revoked" this step is about.
    const cKeepAlive = setInterval(() => {
      c.send(presence(harness, {})).catch(() => {});
    }, 250);
    await harness.fixture.pgDatabase.query(
      "delete from public.session where token=$1",
      [third.sessionToken],
    );
    const ended = await drain(c, 2_000).finally(() =>
      clearInterval(cKeepAlive)
    );
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
    // As for c above: b stays fresh so only the lost membership removes it.
    const bKeepAlive = setInterval(() => {
      b.send(presence(harness, {})).catch(() => {});
    }, 250);
    let problem: Frame;
    try {
      await harness.fixture.pgDatabase.query(
        "delete from bakery.organization_memberships where principal_id=$1",
        [second.principalId],
      );
      for (;;) {
        const frame = await until(a, "presence.removed", 3_000);
        if (frame.reason === "revoked") break;
      }
      problem = await until(b, "problem", 3_000);
    } finally {
      clearInterval(bKeepAlive);
    }
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

const ZERO = "00000000-0000-0000-0000-000000000000";

/** Next text frame of `type`, collecting any binary messages on the way. */
async function untilWithBinary(
  client: WsClient,
  type: string,
  binaries: Uint8Array[],
  timeoutMs = 5_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`no ${type} frame`);
    let value: Awaited<ReturnType<WsClient["nextMessage"]>>;
    try {
      value = await client.nextMessage(left);
    } catch (error) {
      throw new Error(`waiting for ${type}: ${(error as Error).message}`, {
        cause: error,
      });
    }
    if (typeof value === "object" && "binary" in value) {
      binaries.push(value.binary);
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`socket closed ${value.code} ${value.reason}`);
    }
    const frame = JSON.parse(value) as Frame;
    if (frame.type === type) return frame;
    // Waiting for an ack, a refusal is the answer: report it, don't time out.
    if (
      type === "ack" &&
      (frame.type === "problem" || frame.type === "resync_required")
    ) {
      throw new Error(`expected ack, got ${JSON.stringify(frame)}`);
    }
  }
}

async function nextBinary(client: WsClient, timeoutMs = 5_000) {
  const value = await client.nextMessage(timeoutMs);
  assert(typeof value === "object" && "binary" in value, JSON.stringify(value));
  return decodeBinaryFrame(value.binary);
}

/** Joins, syncs and returns a local document holding the committed state. */
async function joinAndSync(client: WsClient, harness: Harness) {
  await join(client, harness);
  await until(client, "joined");
  await client.send(JSON.stringify({
    type: "sync",
    requestId: crypto.randomUUID(),
    room: room(harness),
  }));
  const synced = await until(client, "synced");
  const snapshot = await nextBinary(client);
  assertEquals(snapshot.kind, BinaryFrameKind.ServerSnapshot);
  assertEquals(snapshot.payload.length, synced.byteLength);
  const doc = new LoroDoc();
  doc.import(snapshot.payload);
  return { doc, epoch: synced.epoch as number, synced };
}

/** A local edit exported as one update from the version before it. */
function localEdit(doc: LoroDoc, at: number, text: string): Uint8Array {
  const from = doc.version();
  doc.getText("body").insert(at, text);
  doc.commit();
  return doc.export({ mode: "update", from });
}

function updateFrame(
  harness: Harness,
  epoch: number,
  mutationId: string,
  payload: Uint8Array,
) {
  return encodeBinaryFrame({
    kind: BinaryFrameKind.ClientUpdate,
    epoch,
    draftId: harness.draftId,
    mutationId,
    sequence: 0n,
    payload,
  });
}

async function committedText(harness: Harness) {
  const read = await harness.fixture.app.fetch(draftRequest(
    harness.fixture,
    `/v1/drafts/${harness.draftId}`,
  ));
  assertEquals(read.status, 200);
  return (await responseJson(read) as { text: string; serverSequence: string });
}

async function receiptCount(harness: Harness) {
  const rows = await harness.fixture.pgDatabase.query<{ count: number }>(
    "select count(*)::int as count from bakery.artifact_draft_receipts where draft_id=$1",
    [harness.draftId],
  );
  return rows.rows[0]!.count;
}

Deno.test("an update is acknowledged only after its receipt commits, then relayed to joined peers and replayed exactly", async () => {
  const harness = await openHarness();
  try {
    const second = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Second Person",
    );
    const watcher = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Not Joined",
    );
    harness.extra.push(second, watcher);
    const a = await open(harness, harness.owner);
    const synced = await joinAndSync(a, harness);
    keepPresent(harness, a);
    assertEquals(synced.doc.getText("body").toString(), "alpha target omega");
    const b = await open(harness, second);
    const bState = await joinAndSync(b, harness);
    keepPresent(harness, b);
    const outside = await open(harness, watcher);

    const mutationId = crypto.randomUUID();
    const update = localEdit(synced.doc, 0, "Hello ");
    await a.sendRaw(
      0x2,
      updateFrame(harness, synced.epoch, mutationId, update),
    );
    const ack = await until(a, "ack", ACK_WAIT_MS);
    const receipt = ack.receipt as { serverSequence: string; actorId: string };
    assertEquals(ack.mutationId, mutationId);
    assertEquals(receipt.serverSequence, "1");
    assertEquals(receipt.actorId, harness.owner.principalId);
    const committed = await committedText(harness);
    assertEquals(committed.text, "Hello alpha target omega");

    // The joined peer receives the committed bytes and converges.
    const relayedFrame = await until(b, "committed");
    assertEquals(relayedFrame.mutationId, mutationId);
    const relayed = await nextBinary(b);
    assertEquals(relayed.kind, BinaryFrameKind.ServerUpdate);
    assertEquals(relayed.sequence, 1n);
    bState.doc.import(relayed.payload);
    assertEquals(bState.doc.getText("body").toString(), committed.text);
    // A member who never joined the room receives no draft bytes.
    const leaked = await outside.nextMessage(500).catch(() => undefined);
    assertEquals(leaked, undefined);

    // The same mutation and bytes replay the exact receipt; nothing new commits.
    await a.sendRaw(
      0x2,
      updateFrame(harness, synced.epoch, mutationId, update),
    );
    assertEquals((await until(a, "ack", ACK_WAIT_MS)).receipt, ack.receipt);
    // The same mutation id with different bytes is refused.
    const other = localEdit(new LoroDoc(), 0, "x");
    await a.sendRaw(0x2, updateFrame(harness, synced.epoch, mutationId, other));
    assertEquals(
      ((await until(a, "problem")).problem as { code: string }).code,
      "IDEMPOTENCY_PAYLOAD_MISMATCH",
    );
    // Already-committed bytes under a new id add nothing and save nothing.
    await a.sendRaw(
      0x2,
      updateFrame(harness, synced.epoch, crypto.randomUUID(), update),
    );
    assertEquals((await until(a, "ack", ACK_WAIT_MS)).receipt, null);
    assertEquals(await receiptCount(harness), 1);
  } finally {
    await closeHarness(harness);
  }
});

Deno.test("hostile updates are refused before anything is saved or relayed", async () => {
  const harness = await openHarness();
  try {
    const second = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Second Person",
    );
    harness.extra.push(second);
    const a = await open(harness, harness.owner);
    const { doc, epoch } = await joinAndSync(a, harness);
    const b = await open(harness, second);
    await joinAndSync(b, harness);

    // Declared length does not match the payload.
    const good = localEdit(doc.fork(), 0, "x");
    const truncated = updateFrame(harness, epoch, crypto.randomUUID(), good)
      .slice(0, -1);
    await a.sendRaw(0x2, truncated);
    assertEquals(
      ((await until(a, "problem")).problem as { code: string }).code,
      "MALFORMED_REQUEST",
    );
    // Pending dependencies: the second of two updates without the first.
    const fork = doc.fork();
    localEdit(fork, 0, "first ");
    const dependent = localEdit(fork, 0, "second ");
    await a.sendRaw(
      0x2,
      updateFrame(harness, epoch, crypto.randomUUID(), dependent),
    );
    assertEquals((await until(a, "resync_required")).reason, "rejected");
    // An extra shared root is not a plain-text draft.
    const rooted = doc.fork();
    const from = rooted.version();
    rooted.getMap("extra").set("k", "v");
    rooted.commit();
    await a.sendRaw(
      0x2,
      updateFrame(
        harness,
        epoch,
        crypto.randomUUID(),
        rooted.export({ mode: "update", from }),
      ),
    );
    assertEquals((await until(a, "resync_required")).reason, "rejected");
    // Garbage bytes.
    await a.sendRaw(
      0x2,
      updateFrame(
        harness,
        epoch,
        crypto.randomUUID(),
        new Uint8Array([1, 2, 3]),
      ),
    );
    assertEquals((await until(a, "resync_required")).reason, "rejected");
    // An oversized update.
    await a.sendRaw(
      0x2,
      updateFrame(harness, epoch, crypto.randomUUID(), new Uint8Array(65_537)),
    );
    assertEquals(
      ((await until(a, "problem")).problem as { code: string }).code,
      "BODY_TOO_LARGE",
    );
    // Another epoch must resynchronize.
    await a.sendRaw(
      0x2,
      updateFrame(harness, epoch + 1, crypto.randomUUID(), good),
    );
    assertEquals((await until(a, "resync_required")).reason, "epoch");
    // An update for a room that was never joined.
    await a.sendRaw(
      0x2,
      encodeBinaryFrame({
        kind: BinaryFrameKind.ClientUpdate,
        epoch,
        draftId: crypto.randomUUID(),
        mutationId: crypto.randomUUID(),
        sequence: 0n,
        payload: good,
      }),
    );
    assertEquals(
      ((await until(a, "problem")).problem as { code: string }).code,
      "RESOURCE_NOT_FOUND",
    );
    // A server-kind frame from a client.
    await a.sendRaw(
      0x2,
      encodeBinaryFrame({
        kind: BinaryFrameKind.ServerUpdate,
        epoch,
        draftId: harness.draftId,
        mutationId: ZERO,
        sequence: 5n,
        payload: good,
      }),
    );
    assertEquals(
      ((await until(a, "problem")).problem as { code: string }).code,
      "MALFORMED_REQUEST",
    );

    assertEquals(await receiptCount(harness), 0);
    assertEquals((await committedText(harness)).text, "alpha target omega");
    const relayed = await b.nextMessage(500).catch(() => undefined);
    assertEquals(relayed, undefined);
  } finally {
    await closeHarness(harness);
  }
});

Deno.test("concurrent updates from two clients serialize, converge and match the committed text", async () => {
  const harness = await openHarness();
  try {
    const second = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Second Person",
    );
    harness.extra.push(second);
    const a = await open(harness, harness.owner);
    const aState = await joinAndSync(a, harness);
    keepPresent(harness, a);
    const b = await open(harness, second);
    const bState = await joinAndSync(b, harness);
    keepPresent(harness, b);

    const aId = crypto.randomUUID();
    const bId = crypto.randomUUID();
    const aUpdate = localEdit(aState.doc, 0, "A:");
    const bUpdate = localEdit(
      bState.doc,
      bState.doc.getText("body").length,
      ":B",
    );
    await Promise.all([
      a.sendRaw(0x2, updateFrame(harness, aState.epoch, aId, aUpdate)),
      b.sendRaw(0x2, updateFrame(harness, bState.epoch, bId, bUpdate)),
    ]);
    const aBinaries: Uint8Array[] = [];
    const bBinaries: Uint8Array[] = [];
    const aAck = await untilWithBinary(
      a,
      "ack",
      aBinaries,
      CONTENDED_ACK_WAIT_MS,
    );
    const bAck = await untilWithBinary(
      b,
      "ack",
      bBinaries,
      CONTENDED_ACK_WAIT_MS,
    );
    const sequences = [aAck, bAck].map((ack) =>
      (ack.receipt as { serverSequence: string }).serverSequence
    ).sort();
    assertEquals(sequences, ["1", "2"]);

    // Each side applies the other's relayed bytes.
    const drain = async (client: WsClient, binaries: Uint8Array[]) => {
      while (binaries.length === 0) {
        const value = await client.nextMessage(3_000);
        if (typeof value === "object" && "binary" in value) {
          binaries.push(value.binary);
        }
      }
      return decodeBinaryFrame(binaries[0]!).payload;
    };
    aState.doc.import(await drain(a, aBinaries));
    bState.doc.import(await drain(b, bBinaries));
    const committed = await committedText(harness);
    assertEquals(committed.serverSequence, "2");
    assertEquals(committed.text, "A:alpha target omega:B");
    assertEquals(aState.doc.getText("body").toString(), committed.text);
    assertEquals(bState.doc.getText("body").toString(), committed.text);
  } finally {
    await closeHarness(harness);
  }
});

Deno.test("concurrent upgrades from one principal cannot exceed the connection cap", async () => {
  const harness = await openHarness({ maxConnectionsPerPrincipal: 4 });
  try {
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () => connect(harness, harness.owner)),
    );
    const upgraded = attempts.filter((value) => "send" in value);
    const refused = attempts.filter((value) => !("send" in value));
    assertEquals(upgraded.length, 4);
    for (const failure of refused) {
      assertEquals((failure as { status: number }).status, 429);
    }
    // Closing one frees exactly one slot.
    const first = upgraded[0] as WsClient;
    await first.close();
    harness.clients.delete(first);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const again = await connect(harness, harness.owner);
    assert("send" in again, JSON.stringify(again));
    const over = await connect(harness, harness.owner);
    assert(!("send" in over));
    assertEquals(over.status, 429);
  } finally {
    await closeHarness(harness);
  }
});

Deno.test("a peer revoked between sweeps receives no draft bytes (AC1)", async () => {
  // The sweep is held far away, so only the relay-time check can stop it.
  const harness = await openHarness({ sweepMilliseconds: 600_000 });
  try {
    const second = await addMember(
      harness.fixture,
      harness.fixture.ids.organizationId,
      "Revoked Person",
    );
    harness.extra.push(second);
    const a = await open(harness, harness.owner);
    const aState = await joinAndSync(a, harness);
    keepPresent(harness, a);
    const b = await open(harness, second);
    await joinAndSync(b, harness);
    await harness.fixture.pgDatabase.query(
      "delete from public.session where token=$1",
      [second.sessionToken],
    );
    await a.sendRaw(
      0x2,
      updateFrame(
        harness,
        aState.epoch,
        crypto.randomUUID(),
        localEdit(aState.doc, 0, "secret "),
      ),
    );
    assertEquals((await until(a, "ack", ACK_WAIT_MS)).type, "ack");
    const binaries: Uint8Array[] = [];
    let closed: { code: number; reason: string } | undefined;
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const value = await b.nextMessage(deadline - Date.now()).catch(() =>
        undefined
      );
      if (value === undefined) break;
      if (typeof value === "object" && "binary" in value) {
        binaries.push(value.binary);
      } else if (typeof value === "object" && "code" in value) {
        closed = value;
        break;
      }
    }
    assertEquals(binaries.length, 0);
    assertExists(closed);
    assertEquals(closed.code, 1008);
  } finally {
    await closeHarness(harness);
  }
});

Deno.test("frames queued behind a slow join are bounded and the connection is closed (AC3)", async () => {
  // The rate limit is set out of reach so only the pending-frame cap applies.
  const harness = await openHarness({
    inboundFramesPerSecond: 10_000,
    maxPendingFrames: 4,
  });
  try {
    const a = await open(harness, harness.owner);
    // One join waits on the database while a burst queues behind it.
    await a.sendMany([
      JSON.stringify({
        type: "join",
        requestId: crypto.randomUUID(),
        room: room(harness),
      }),
      ...Array.from(
        { length: 40 },
        () => JSON.stringify({ type: "ping", requestId: crypto.randomUUID() }),
      ),
    ]);
    const result = await drain(a, 3_000);
    // The refusal arrives before the queue drains; the close frame itself
    // can be lost to a TCP reset after a burst, so assert on what the client
    // can always observe: the problem, no handled backlog, then silence.
    const problems = result.frames.filter((f) => f.type === "problem");
    assertEquals(problems.length, 1);
    assertEquals(
      (problems[0]!.problem as { code: string }).code,
      "RATE_LIMITED",
    );
    assertEquals(result.frames.filter((f) => f.type === "ping").length, 0);
    if (result.closed) assertEquals(result.closed.code, 1008);
    const after = await a.next(500).catch(() => undefined);
    assert(
      after === undefined || (typeof after === "object" && "code" in after),
      `frame after refusal: ${JSON.stringify(after)}`,
    );
  } finally {
    await closeHarness(harness);
  }
});

// Smoke test for back-to-back updates with many joined peers. It passes with
// the relay inside or outside the admission section on a fast local database,
// so it does not by itself prove the ordering fix; see PR #140 round 1 notes.
Deno.test("back-to-back updates with twenty joined peers are all acknowledged", async () => {
  const harness = await openHarness({ maxConnectionsPerPrincipal: 32 });
  try {
    const a = await open(harness, harness.owner);
    const aState = await joinAndSync(a, harness);
    keepPresent(harness, a);
    // Twenty other connections of members join the room.
    const peers: WsClient[] = [];
    for (let index = 0; index < 4; index += 1) {
      const member = await addMember(
        harness.fixture,
        harness.fixture.ids.organizationId,
        `Peer ${index}`,
      );
      harness.extra.push(member);
      for (let tab = 0; tab < 5; tab += 1) {
        const peer = await open(harness, member);
        await join(peer, harness);
        await until(peer, "joined");
        peers.push(peer);
      }
    }
    // Twelve updates back to back; every one is acknowledged in time.
    const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
    for (const [index, id] of ids.entries()) {
      await a.sendRaw(
        0x2,
        updateFrame(
          harness,
          aState.epoch,
          id,
          localEdit(aState.doc, 0, `${index}`),
        ),
      );
    }
    const acked = new Set<string>();
    const binaries: Uint8Array[] = [];
    // The updates commit one after another, each in its own isolated worker
    // that the product allows ACK_WAIT_MS to start, run and commit; a fixed
    // window shorter than that fails a healthy but busy host.
    const deadline = Date.now() + ids.length * ACK_WAIT_MS;
    while (acked.size < ids.length && Date.now() < deadline) {
      const ack = await untilWithBinary(
        a,
        "ack",
        binaries,
        deadline - Date.now(),
      );
      acked.add(ack.mutationId as string);
    }
    assertEquals(acked.size, ids.length);
    const committed = await committedText(harness);
    assertEquals(committed.serverSequence, "12");
  } finally {
    await closeHarness(harness);
  }
});
