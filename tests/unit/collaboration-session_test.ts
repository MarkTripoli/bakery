import { assert, assertEquals } from "@std/assert";
import { LoroDoc } from "loro-crdt/base64";
import {
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "../../apps/web/src/collaboration/binary-frame.ts";
import {
  CollaborationSession,
  insertedBetween,
  type SocketLike,
} from "../../apps/web/src/collaboration/session.ts";
import {
  type Participant,
  peopleOf,
} from "../../apps/web/src/collaboration/people.ts";

const DRAFT = "11111111-1111-4111-8111-111111111111";
const ROOM = { kind: "draft", id: DRAFT };

/** The client's own JSON frames: only the fields the tests read. */
type SentFrame = {
  type: string;
  requestId?: string;
  room?: unknown;
  state?: { typing: boolean };
};

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 1;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  json(): SentFrame[] {
    return this.sent.filter((frame) => typeof frame === "string").map((frame) =>
      JSON.parse(frame as string)
    );
  }
  binary() {
    return this.sent.filter((frame) => typeof frame !== "string").map((frame) =>
      decodeBinaryFrame(frame as Uint8Array)
    );
  }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  receiveBinary(bytes: Uint8Array) {
    this.onmessage?.({
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ),
    });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

type Timer = { at: number; callback: () => void; id: number };

function harness(
  options: { storage?: Storage | null; random?: () => number } = {},
) {
  const sockets: FakeSocket[] = [];
  let clock = 1_000_000;
  let counter = 0;
  const timers: Timer[] = [];
  const uuid = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  };
  const session = new CollaborationSession({
    draftId: DRAFT,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => clock,
    uuid,
    random: options.random ?? (() => 0.5),
    setTimer: (callback, ms) => {
      const timer = { at: clock + ms, callback, id: ++counter };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as Timer);
      if (index >= 0) timers.splice(index, 1);
    },
    storage: options.storage ?? null,
  });
  const advance = (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((timer) =>
        timer.at <= clock
      ).sort((a, b) => a.at - b.at)[0];
      if (!due) {
        return;
      }
      timers.splice(timers.indexOf(due), 1);
      due.callback();
    }
  };
  return { session, sockets, advance, timers, uuid, now: () => clock };
}

/** A server's own document with some text, as a snapshot frame. */
function serverSnapshot(text: string, epoch = 1) {
  const doc = new LoroDoc();
  doc.getText("body").insert(0, text);
  doc.commit();
  return {
    doc,
    frame: encodeBinaryFrame({
      kind: BinaryFrameKind.ServerSnapshot,
      epoch,
      draftId: DRAFT,
      mutationId: "00000000-0000-0000-0000-000000000000",
      sequence: 1n,
      payload: doc.export({ mode: "snapshot" }),
    }),
  };
}

/** Walks hello -> join -> joined -> sync -> synced + snapshot on the latest socket. */
function connect(h: ReturnType<typeof harness>, text = "Hello", epoch = 1) {
  h.session.start();
  const socket = h.sockets[h.sockets.length - 1];
  socket.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  const join = socket.json().find((frame) => frame.type === "join")!;
  socket.receive({
    type: "joined",
    requestId: join.requestId,
    room: ROOM,
    participants: [],
  });
  const sync = socket.json().find((frame) => frame.type === "sync")!;
  socket.receive({
    type: "synced",
    requestId: sync.requestId,
    room: ROOM,
    epoch,
    serverSequence: "1",
    checkpointId: "88888888-8888-4888-8888-888888888888",
    byteLength: 10,
  });
  const snapshot = serverSnapshot(text, epoch);
  socket.receiveBinary(snapshot.frame);
  return { socket, ...snapshot };
}

function type(h: ReturnType<typeof harness>, text: string, at = 0) {
  const body = h.session.document.getText("body");
  body.insert(at, text);
  h.session.document.commit();
}

Deno.test("joins, syncs and ends up read-write with the server's text", () => {
  const h = harness();
  h.session.start();
  assertEquals(h.session.getSnapshot().connection, "connecting");
  assert(h.session.getSnapshot().readOnly);
  const { socket } = connect(h, "Hello world");
  assertEquals(socket.binaryType, "arraybuffer");
  const [join, sync] = socket.json();
  assertEquals(join.type, "join");
  assertEquals(join.room, ROOM);
  assertEquals(sync.type, "sync");
  const snapshot = h.session.getSnapshot();
  assertEquals(snapshot.connection, "online");
  assertEquals(snapshot.syncing, false);
  assertEquals(snapshot.readOnly, false);
  assertEquals(snapshot.saveState, "saved");
  assertEquals(h.session.document.getText("body").toString(), "Hello world");
});

Deno.test("sends each local change under its own mutation id, and Saving appears only after 500 ms", () => {
  const h = harness();
  const { socket } = connect(h);
  type(h, "A");
  type(h, "B", 1);
  const updates = socket.binary();
  assertEquals(updates.length, 2);
  assertEquals(updates[0].kind, BinaryFrameKind.ClientUpdate);
  assertEquals(updates[0].sequence, 0n);
  assertEquals(updates[0].draftId, DRAFT);
  assertEquals(updates[0].epoch, 1);
  assert(updates[0].mutationId !== updates[1].mutationId);
  assertEquals(h.session.getSnapshot().pendingCount, 2);
  assertEquals(h.session.getSnapshot().saveState, "saved");
  h.advance(499);
  assertEquals(h.session.getSnapshot().saveState, "saved");
  h.advance(1);
  assertEquals(h.session.getSnapshot().saveState, "sending");
  socket.receive({
    type: "ack",
    room: ROOM,
    mutationId: updates[0].mutationId,
    receipt: null,
  });
  assertEquals(h.session.getSnapshot().pendingCount, 1);
  socket.receive({
    type: "ack",
    room: ROOM,
    mutationId: updates[1].mutationId,
    receipt: null,
  });
  assertEquals(h.session.getSnapshot().pendingCount, 0);
  assertEquals(h.session.getSnapshot().saveState, "saved");
});

Deno.test("a change acknowledged before 500 ms never shows Saving", () => {
  const h = harness();
  const { socket } = connect(h);
  type(h, "A");
  const [update] = socket.binary();
  h.advance(200);
  socket.receive({
    type: "ack",
    room: ROOM,
    mutationId: update.mutationId,
    receipt: null,
  });
  h.advance(1000);
  assertEquals(h.session.getSnapshot().saveState, "saved");
});

Deno.test("remote updates land in the document without becoming local changes", () => {
  const h = harness();
  const { socket, doc } = connect(h, "Hello");
  doc.getText("body").insert(5, " there");
  doc.commit();
  socket.receiveBinary(encodeBinaryFrame({
    kind: BinaryFrameKind.ServerUpdate,
    epoch: 1,
    draftId: DRAFT,
    mutationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    sequence: 2n,
    payload: doc.export({ mode: "update" }),
  }));
  assertEquals(h.session.document.getText("body").toString(), "Hello there");
  assertEquals(socket.binary().length, 0);
  assertEquals(h.session.getSnapshot().pendingCount, 0);
});

Deno.test("losing the connection shows Not saved, keeps typing, and resends the same mutation after reconnecting", () => {
  const h = harness();
  const first = connect(h).socket;
  type(h, "A");
  const [sentBefore] = first.binary();
  first.drop();
  assertEquals(h.session.getSnapshot().connection, "offline");
  assertEquals(h.session.getSnapshot().saveState, "offline");
  type(h, "B", 1);
  assertEquals(h.session.getSnapshot().pendingCount, 2);
  // Backoff: the first retry comes after about a second.
  h.advance(999);
  assertEquals(h.sockets.length, 1);
  h.advance(1);
  assertEquals(h.sockets.length, 2);
  const second = h.sockets[1];
  second.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  assertEquals(h.session.getSnapshot().saveState, "catching-up");
  assertEquals(
    second.binary().length,
    0,
    "nothing is sent before the text has synced",
  );
  const join = second.json().find((frame) => frame.type === "join")!;
  second.receive({
    type: "joined",
    requestId: join.requestId,
    room: ROOM,
    participants: [],
  });
  const sync = second.json().find((frame) => frame.type === "sync")!;
  second.receive({
    type: "synced",
    requestId: sync.requestId,
    room: ROOM,
    epoch: 1,
    serverSequence: "1",
    checkpointId: "88888888-8888-4888-8888-888888888888",
    byteLength: 1,
  });
  second.receiveBinary(serverSnapshot("").frame);
  const resent = second.binary();
  assertEquals(resent.length, 2);
  assertEquals(resent[0].mutationId, sentBefore.mutationId);
  assertEquals(resent[0].payload, sentBefore.payload);
});

Deno.test("reconnect delay doubles to a ceiling and starts over once the server answers", () => {
  const h = harness();
  h.session.start();
  const delays: number[] = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const socket = h.sockets[h.sockets.length - 1];
    const before = h.timers.length;
    socket.drop();
    const timer = h.timers[h.timers.length - 1];
    assert(h.timers.length >= before);
    delays.push(timer.at - h.now());
    h.advance(timer.at - h.now());
  }
  assertEquals(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  const socket = h.sockets[h.sockets.length - 1];
  socket.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  socket.drop();
  assertEquals(h.timers.at(-1)!.at - h.now(), 1000);
});

Deno.test("a refused change goes to the sheet with what was typed and the document is rebuilt from the server", () => {
  const h = harness();
  const { socket } = connect(h, "Intro");
  const before = h.session.document;
  const versionBefore = h.session.getSnapshot().documentVersion;
  type(h, " and more", 5);
  const [update] = socket.binary();
  socket.receive({
    type: "resync_required",
    room: ROOM,
    mutationId: update.mutationId,
    reason: "rejected",
  });
  const snapshot = h.session.getSnapshot();
  assertEquals(snapshot.refused.length, 1);
  assertEquals(snapshot.refused[0].text, " and more");
  assertEquals(snapshot.refused[0].cause, "rejected");
  assertEquals(snapshot.pendingCount, 0);
  assertEquals(snapshot.documentVersion, versionBefore + 1);
  assert(
    h.session.document !== before,
    "a new document, so the editor rebinds",
  );
  assertEquals(snapshot.saveState, "catching-up");
  // The server's text comes back; the refusal stays shown.
  const sync = socket.json().filter((frame) => frame.type === "sync").at(-1)!;
  socket.receive({
    type: "synced",
    requestId: sync.requestId,
    room: ROOM,
    epoch: 1,
    serverSequence: "1",
    checkpointId: "88888888-8888-4888-8888-888888888888",
    byteLength: 1,
  });
  socket.receiveBinary(serverSnapshot("Intro").frame);
  assertEquals(h.session.document.getText("body").toString(), "Intro");
  assertEquals(h.session.getSnapshot().saveState, "refused");
  // Discarding the last piece clears the refusal.
  h.session.discardRefused(snapshot.refused[0].id);
  assertEquals(h.session.getSnapshot().saveState, "saved");
});

Deno.test("a stale change is caught up and sent once more; the second time it goes to the sheet", () => {
  const h = harness();
  const { socket } = connect(h, "Intro");
  type(h, "X", 5);
  const [first] = socket.binary();
  socket.receive({
    type: "resync_required",
    room: ROOM,
    mutationId: first.mutationId,
    reason: "stale",
  });
  assertEquals(h.session.getSnapshot().saveState, "catching-up");
  assertEquals(h.session.getSnapshot().refused.length, 0);
  const sync = socket.json().filter((frame) => frame.type === "sync").at(-1)!;
  socket.receive({
    type: "synced",
    requestId: sync.requestId,
    room: ROOM,
    epoch: 1,
    serverSequence: "2",
    checkpointId: "88888888-8888-4888-8888-888888888888",
    byteLength: 1,
  });
  socket.receiveBinary(serverSnapshot("Intro").frame);
  // Same document, so the same mutation is sent again.
  const again = socket.binary().at(-1)!;
  assertEquals(again.mutationId, first.mutationId);
  socket.receive({
    type: "resync_required",
    room: ROOM,
    mutationId: first.mutationId,
    reason: "stale",
  });
  assertEquals(h.session.getSnapshot().refused.map((piece) => piece.text), [
    "X",
  ]);
  assertEquals(h.session.getSnapshot().refused[0].cause, "stale");
});

Deno.test("a new epoch shows who published and moves unsent text to the sheet", () => {
  const h = harness();
  const { socket } = connect(h, "Intro");
  type(h, "late", 5);
  socket.receive({
    type: "published",
    room: ROOM,
    publication: {
      draftId: DRAFT,
      epoch: 1,
      checkpointId: "88888888-8888-4888-8888-888888888888",
      serverSequence: "3",
      textDigest: "a".repeat(64),
      artifactId: "22222222-2222-4222-8222-222222222222",
      artifactVersionId: "33333333-3333-4333-8333-333333333333",
      versionNumber: 4,
      sha256: "b".repeat(64),
      publishedById: "44444444-4444-4444-8444-444444444444",
      publishedByName: "Ana Reyes",
      actorKind: "person",
      publishedAt: "2026-11-18T00:00:00.000Z",
    },
  });
  socket.receive({
    type: "resync_required",
    room: ROOM,
    mutationId: null,
    reason: "epoch",
  });
  const snapshot = h.session.getSnapshot();
  assertEquals(snapshot.banner, {
    kind: "published",
    name: "Ana Reyes",
    versionNumber: 4,
  });
  assertEquals(snapshot.refused.map((piece) => [piece.text, piece.cause]), [[
    "late",
    "epoch",
  ]]);
  assertEquals(snapshot.pendingCount, 0);
});

Deno.test("an epoch with no publication says the draft was replaced", () => {
  const h = harness();
  const { socket } = connect(h);
  socket.receive({
    type: "resync_required",
    room: ROOM,
    mutationId: null,
    reason: "epoch",
  });
  assertEquals(h.session.getSnapshot().banner, { kind: "replaced" });
});

Deno.test("losing access ends the session: read-only, unsent text kept, no reconnecting", () => {
  const h = harness();
  const { socket } = connect(h);
  type(h, "mine");
  socket.receive({
    type: "problem",
    requestId: null,
    problem: {
      type: "https://bakery.dev/problems/auth_forbidden",
      title: "Forbidden",
      status: 403,
      detail: "d",
      code: "AUTH_FORBIDDEN",
      requestId: "11111111-1111-4111-8111-111111111111",
      retryable: false,
    },
  });
  const snapshot = h.session.getSnapshot();
  assertEquals(snapshot.connection, "ended");
  assert(snapshot.readOnly);
  assertEquals(snapshot.banner, { kind: "revoked" });
  assertEquals(snapshot.refused.map((piece) => [piece.text, piece.cause]), [[
    "mine",
    "revoked",
  ]]);
  assertEquals(h.timers.filter((timer) => timer.at > h.now()).length, 0);
  type(h, "more");
  assertEquals(
    h.session.getSnapshot().pendingCount,
    0,
    "nothing more is queued once access is gone",
  );
});

Deno.test("a server problem that is not a verdict reconnects instead of ending", () => {
  const h = harness();
  const { socket } = connect(h);
  socket.receive({
    type: "problem",
    requestId: null,
    problem: {
      type: "https://bakery.dev/problems/dependency_unavailable",
      title: "Busy",
      status: 503,
      detail: "d",
      code: "DEPENDENCY_UNAVAILABLE",
      requestId: "11111111-1111-4111-8111-111111111111",
      retryable: true,
    },
  });
  assertEquals(socket.closed?.code, 1011);
  socket.drop(1011);
  assertEquals(h.session.getSnapshot().connection, "offline");
  h.advance(1000);
  assertEquals(h.sockets.length, 2);
});

Deno.test("unsent pieces survive a reload when a store is given, until they are discarded", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } as unknown as Storage;
  const h = harness({ storage });
  const { socket } = connect(h, "Intro");
  type(h, "typed", 5);
  const [update] = socket.binary();
  socket.receive({
    type: "resync_required",
    room: ROOM,
    mutationId: update.mutationId,
    reason: "rejected",
  });
  assertEquals(store.size, 1);
  const reloaded = harness({ storage });
  assertEquals(
    reloaded.session.getSnapshot().refused.map((piece) => piece.text),
    ["typed"],
  );
  reloaded.session.discardRefused(reloaded.session.getSnapshot().refused[0].id);
  assertEquals(store.size, 0);
});

Deno.test("leaving with text the server has not acknowledged keeps it for the next visit; acknowledged text is not kept", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } as unknown as Storage;
  const h = harness({ storage });
  const { socket } = connect(h, "Intro");
  type(h, "sent", 5);
  const [first] = socket.binary();
  socket.receive({
    type: "ack",
    room: ROOM,
    mutationId: first.mutationId,
    receipt: null,
  });
  // Offline: this one is never acknowledged.
  socket.drop();
  type(h, " unsent", 9);
  assertEquals(h.session.getSnapshot().pendingCount, 1);
  h.session.destroy();
  assertEquals(store.size, 1);
  const returned = harness({ storage });
  const kept = returned.session.getSnapshot().refused;
  assertEquals(kept.map((piece) => [piece.text, piece.cause]), [[
    " unsent",
    "closed",
  ]]);
  // Leaving a second time changes nothing.
  h.session.destroy();
  assertEquals(store.size, 1);
});

Deno.test("leaving with nothing unsent keeps nothing", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  } as unknown as Storage;
  const h = harness({ storage });
  connect(h, "Intro");
  h.session.destroy();
  assertEquals(store.size, 0);
});

Deno.test("presence: joined and later hints are kept, removals drop them, hints are coalesced", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  const join = socket.json().find((frame) => frame.type === "join")!;
  const person = (
    key: string,
    principalId: string,
    name: string,
    typing = false,
    activity = "active",
  ) => ({
    participantKey: "aaaaaaaa-aaaa-4aaa-8aaa-" +
      key.replace(/\D/g, "").padStart(12, "0"),
    principalId,
    principalType: "human",
    displayName: name,
    state: { activity, typing, cursor: null },
    receivedAt: "2026-11-18T00:00:00.000Z",
  });
  socket.receive({
    type: "joined",
    requestId: join.requestId,
    room: ROOM,
    participants: [person("1", "55555555-5555-4555-8555-555555555555", "Ana")],
  });
  socket.receive({
    type: "presence",
    room: ROOM,
    presence: person("2", "66666666-6666-4666-8666-666666666666", "Ben", true),
  });
  assertEquals(h.session.getSnapshot().participants.map((p) => p.displayName), [
    "Ana",
    "Ben",
  ]);
  socket.receive({
    type: "presence.removed",
    room: ROOM,
    participantKey: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    reason: "left",
  });
  assertEquals(h.session.getSnapshot().participants.map((p) => p.displayName), [
    "Ben",
  ]);
  // Hints: the first goes out at once, the next ones within 200 ms collapse into one.
  const state = (typing: boolean) => ({
    activity: "active" as const,
    typing,
    cursor: null,
  });
  h.session.setPresence(state(true));
  h.session.setPresence(state(false));
  h.session.setPresence(state(true));
  assertEquals(
    socket.json().filter((frame) => frame.type === "presence.update").length,
    1,
  );
  h.advance(200);
  const updates = socket.json().filter((frame) =>
    frame.type === "presence.update"
  );
  assertEquals(updates.length, 2);
  assertEquals(updates[1].state?.typing, true);
});

Deno.test("people are aggregated by principal, keeping the most active status", () => {
  const make = (
    key: string,
    principal: string,
    typing: boolean,
    activity: Participant["state"]["activity"],
  ): Participant => ({
    participantKey: key,
    principalId: principal,
    principalType: "human",
    displayName: principal,
    state: { activity, typing, cursor: null },
    receivedAt: "x",
  });
  assertEquals(
    peopleOf([
      make("1", "ana", false, "idle"),
      make("2", "ana", true, "active"),
      make("3", "ben", false, "active"),
      make("4", "cy", false, "idle"),
    ]).map((person) => [person.principalId, person.status]),
    [["ana", "typing"], ["ben", "viewing"], ["cy", "away"]],
  );
});

Deno.test("heartbeat pings on the interval the server said, and a server ping is echoed", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  h.advance(10_000);
  assertEquals(
    socket.json().filter((frame) => frame.type === "ping").length,
    1,
  );
  const requestId = "77777777-7777-4777-8777-777777777777";
  socket.receive({ type: "ping", requestId });
  assertEquals(
    socket.json().filter((frame) => frame.type === "ping").at(-1)!.requestId,
    requestId,
  );
});

Deno.test("frames that do not parse, and sockets that are no longer current, are ignored", () => {
  const h = harness();
  const first = connect(h).socket;
  first.onmessage?.({ data: "not json" });
  first.onmessage?.({ data: JSON.stringify({ type: "nonsense" }) });
  first.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
  first.drop();
  h.advance(1000);
  // A late frame from the dead socket changes nothing.
  first.receive({
    type: "resync_required",
    room: ROOM,
    mutationId: null,
    reason: "epoch",
  });
  assertEquals(h.session.getSnapshot().banner, null);
});

Deno.test("the text a change inserted is found between before and after", () => {
  assertEquals(insertedBetween("Intro", "Intro and more"), " and more");
  assertEquals(insertedBetween("Intro", "Into"), "");
  assertEquals(insertedBetween("abcd", "abXYcd"), "XY");
  assertEquals(insertedBetween("", "all"), "all");
});

Deno.test("destroy stops timers and detaches the socket", () => {
  const h = harness();
  const { socket } = connect(h);
  type(h, "A");
  h.session.destroy();
  assertEquals(h.timers.length, 0);
  assertEquals(socket.closed?.code, 1000);
  assertEquals(socket.onmessage, null);
});
Deno.test("a silent half-open socket is dropped after two missed heartbeats and the same mutation is resent", () => {
  const h = harness();
  const first = connect(h).socket;
  type(h, "A");
  const [sent] = first.binary();
  h.advance(10_000); // first heartbeat: a ping goes out, nothing comes back
  assertEquals(first.json().filter((frame) => frame.type === "ping").length, 1);
  assertEquals(h.session.getSnapshot().connection, "online");
  h.advance(10_000); // second: twenty silent seconds
  assertEquals(h.session.getSnapshot().connection, "offline");
  assertEquals(h.session.getSnapshot().saveState, "offline");
  assertEquals(first.closed?.code, 4000);
  h.advance(1000);
  assertEquals(h.sockets.length, 2);
  const second = h.sockets[1];
  second.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  const join = second.json().find((frame) => frame.type === "join")!;
  second.receive({
    type: "joined",
    requestId: join.requestId,
    room: ROOM,
    participants: [],
  });
  const sync = second.json().find((frame) => frame.type === "sync")!;
  second.receive({
    type: "synced",
    requestId: sync.requestId,
    room: ROOM,
    epoch: 1,
    serverSequence: "1",
    checkpointId: "88888888-8888-4888-8888-888888888888",
    byteLength: 1,
  });
  second.receiveBinary(serverSnapshot("").frame);
  assertEquals(second.binary().map((frame) => frame.mutationId), [
    sent.mutationId,
  ]);
});

Deno.test("a server that answers every ping keeps the connection online", () => {
  const h = harness();
  const socket = connect(h).socket;
  for (let beat = 0; beat < 6; beat += 1) {
    h.advance(10_000);
    const ping = socket.json().filter((frame) => frame.type === "ping").at(-1)!;
    socket.receive({ type: "ping", requestId: ping.requestId });
  }
  assertEquals(h.session.getSnapshot().connection, "online");
  assertEquals(h.sockets.length, 1);
});

Deno.test("edits after a rejected one are refused with it, each kept for the sheet", () => {
  const h = harness();
  const { socket } = connect(h, "Intro");
  type(h, "one", 5);
  type(h, "two", 8);
  const [first] = socket.binary();
  socket.receive({
    type: "resync_required",
    room: ROOM,
    mutationId: first.mutationId,
    reason: "rejected",
  });
  const snapshot = h.session.getSnapshot();
  assertEquals(snapshot.pendingCount, 0);
  assertEquals(snapshot.refused.map((piece) => piece.text).sort(), [
    "one",
    "two",
  ]);
});

Deno.test("a 401 ends the session like a 403", () => {
  const h = harness();
  const { socket } = connect(h);
  socket.receive({
    type: "problem",
    requestId: null,
    problem: {
      type: "https://bakery.dev/problems/auth_required",
      title: "Sign in",
      status: 401,
      detail: "d",
      code: "AUTH_REQUIRED",
      requestId: "11111111-1111-4111-8111-111111111111",
      retryable: false,
    },
  });
  assertEquals(h.session.getSnapshot().connection, "ended");
  assertEquals(h.session.getSnapshot().banner, { kind: "revoked" });
});

Deno.test("a refused deletion is kept too: the removed text comes back as a piece", () => {
  const h = harness();
  const { socket } = connect(h, "Introduction");
  const body = h.session.document.getText("body");
  body.delete(5, 7);
  h.session.document.commit();
  const [update] = socket.binary();
  socket.receive({
    type: "resync_required",
    room: ROOM,
    mutationId: update.mutationId,
    reason: "rejected",
  });
  const [piece] = h.session.getSnapshot().refused;
  assertEquals([piece.text, piece.change], ["duction", "deleted"]);
});

Deno.test("an edit made while still syncing is held until the server's text has landed", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  const join = socket.json().find((frame) => frame.type === "join")!;
  socket.receive({
    type: "joined",
    requestId: join.requestId,
    room: ROOM,
    participants: [],
  });
  type(h, "early");
  assertEquals(socket.binary().length, 0);
  assertEquals(h.session.getSnapshot().pendingCount, 1);
  const sync = socket.json().find((frame) => frame.type === "sync")!;
  socket.receive({
    type: "synced",
    requestId: sync.requestId,
    room: ROOM,
    epoch: 1,
    serverSequence: "1",
    checkpointId: "88888888-8888-4888-8888-888888888888",
    byteLength: 1,
  });
  assertEquals(
    socket.binary().length,
    0,
    "still waiting for the snapshot bytes",
  );
  socket.receiveBinary(serverSnapshot("").frame);
  assertEquals(socket.binary().length, 1);
});

Deno.test("reconnect jitter spreads the delay between 80% and 120%", () => {
  const delayAfterDrop = (random: number) => {
    const h = harness({ random: () => random });
    h.session.start();
    h.sockets[0].drop();
    const timer = h.timers.at(-1)!;
    return timer.at - h.now();
  };
  assertEquals(delayAfterDrop(0), 800);
  assertEquals(delayAfterDrop(0.5), 1000);
  assertEquals(delayAfterDrop(1), 1200);
});

Deno.test("a joined frame for another request is ignored", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  socket.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  socket.receive({
    type: "joined",
    requestId: "77777777-7777-4777-8777-777777777777",
    room: ROOM,
    participants: [],
  });
  assertEquals(
    socket.json().filter((frame) => frame.type === "sync").length,
    0,
  );
});
Deno.test("a socket that opens but never says hello is closed and retried", () => {
  const h = harness();
  h.session.start();
  const socket = h.sockets[0];
  h.advance(14_999);
  assertEquals(h.session.getSnapshot().connection, "connecting");
  h.advance(1);
  assertEquals(h.session.getSnapshot().connection, "offline");
  assertEquals(socket.closed?.code, 4000);
  h.advance(1000);
  assertEquals(h.sockets.length, 2);
});

Deno.test("a hello within the wait cancels the connect timeout", () => {
  const h = harness();
  connect(h);
  h.advance(16_000); // past the connect wait, before two silent heartbeats
  assertEquals(h.sockets.length, 1);
  assertEquals(h.session.getSnapshot().connection, "online");
});
Deno.test("a draft that was re-epoched while offline sends nothing old: unsent text goes to the sheet and the document starts again", () => {
  const h = harness();
  const first = connect(h, "Intro", 1).socket;
  first.drop();
  type(h, "offline", 5);
  const before = h.session.getSnapshot().documentVersion;
  h.advance(1000);
  const second = h.sockets[1];
  second.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  const join = second.json().find((frame) => frame.type === "join")!;
  second.receive({
    type: "joined",
    requestId: join.requestId,
    room: ROOM,
    participants: [],
  });
  const sync = second.json().find((frame) => frame.type === "sync")!;
  second.receive({
    type: "synced",
    requestId: sync.requestId,
    room: ROOM,
    epoch: 2,
    serverSequence: "1",
    checkpointId: "88888888-8888-4888-8888-888888888888",
    byteLength: 1,
  });
  second.receiveBinary(serverSnapshot("A new draft", 2).frame);
  assertEquals(second.binary().length, 0, "nothing stamped with the new epoch");
  const snapshot = h.session.getSnapshot();
  assertEquals(snapshot.refused.map((piece) => [piece.text, piece.cause]), [[
    "offline",
    "epoch",
  ]]);
  assertEquals(snapshot.banner, { kind: "replaced" });
  assertEquals(snapshot.documentVersion, before + 1);
  assertEquals(snapshot.pendingCount, 0);
  assertEquals(h.session.document.getText("body").toString(), "A new draft");
  assertEquals(snapshot.epoch, 2);
});

Deno.test("a refusal the server will never accept is kept for the sheet and not resent on every reconnect", () => {
  const h = harness();
  const first = connect(h).socket;
  type(h, "too big");
  assertEquals(first.binary().length, 1);
  first.receive({
    type: "problem",
    requestId: null,
    problem: {
      type: "https://bakery.dev/problems/body_too_large",
      title: "Too large",
      status: 413,
      detail: "d",
      code: "BODY_TOO_LARGE",
      requestId: "11111111-1111-4111-8111-111111111111",
      retryable: false,
    },
  });
  assertEquals(h.session.getSnapshot().pendingCount, 0);
  assertEquals(
    h.session.getSnapshot().refused.map((piece) => [piece.text, piece.cause]),
    [["too big", "rejected"]],
  );
  first.drop(1011);
  h.advance(1000);
  const second = h.sockets[1];
  second.receive({
    type: "hello",
    protocolVersion: 1,
    connectionId: "99999999-9999-4999-8999-999999999999",
    heartbeatSeconds: 10,
    presenceTtlSeconds: 30,
  });
  const join = second.json().find((frame) => frame.type === "join")!;
  second.receive({
    type: "joined",
    requestId: join.requestId,
    room: ROOM,
    participants: [],
  });
  const sync = second.json().find((frame) => frame.type === "sync")!;
  second.receive({
    type: "synced",
    requestId: sync.requestId,
    room: ROOM,
    epoch: 1,
    serverSequence: "1",
    checkpointId: "88888888-8888-4888-8888-888888888888",
    byteLength: 1,
  });
  second.receiveBinary(serverSnapshot("").frame);
  assertEquals(
    second.binary().length,
    0,
    "the refused piece is not sent again",
  );
});

Deno.test("a mutation the server names twice in resyncs is refused, not resent forever", () => {
  const h = harness();
  const { socket } = connect(h, "Intro");
  type(h, "x", 5);
  const [update] = socket.binary();
  const resync = () =>
    socket.receive({
      type: "resync_required",
      room: ROOM,
      mutationId: update.mutationId,
      reason: "expired",
    });
  const answerSync = () => {
    const sync = socket.json().filter((frame) => frame.type === "sync").at(-1)!;
    socket.receive({
      type: "synced",
      requestId: sync.requestId,
      room: ROOM,
      epoch: 1,
      serverSequence: "1",
      checkpointId: "88888888-8888-4888-8888-888888888888",
      byteLength: 1,
    });
    socket.receiveBinary(serverSnapshot("Intro").frame);
  };
  resync();
  assertEquals(h.session.getSnapshot().refused.length, 0);
  answerSync();
  assertEquals(
    socket.binary().filter((frame) => frame.mutationId === update.mutationId)
      .length,
    2,
    "sent once more",
  );
  resync();
  assertEquals(h.session.getSnapshot().refused.map((piece) => piece.text), [
    "x",
  ]);
  answerSync();
  assertEquals(socket.binary().length, 2, "not a third time");
});

Deno.test("a non-retryable 4xx refuses every pending piece: a later edit cannot apply without the one before it", () => {
  const h = harness();
  const first = connect(h, "Intro").socket;
  type(h, "A", 5);
  type(h, "B", 6);
  assertEquals(first.binary().length, 2);
  first.receive(problemFrame(413, false));
  const snapshot = h.session.getSnapshot();
  assertEquals(snapshot.refused.map((piece) => piece.text).sort(), ["A", "B"]);
  assertEquals(snapshot.pendingCount, 0);
});

const problemFrame = (status: number, retryable: boolean) => ({
  type: "problem",
  requestId: null,
  problem: {
    type: "https://bakery.dev/problems/some_problem",
    title: "Problem",
    status,
    detail: "d",
    code: "SOME_PROBLEM",
    requestId: "11111111-1111-4111-8111-111111111111",
    retryable,
  },
});

for (
  const [status, retryable] of [[429, true], [503, true], [500, false]] as const
) {
  Deno.test(`a ${status} problem keeps what was typed: it is the server's trouble, not a refusal`, () => {
    const h = harness();
    const { socket } = connect(h, "Intro");
    type(h, "keep", 5);
    socket.receive(problemFrame(status, retryable));
    const snapshot = h.session.getSnapshot();
    assertEquals(snapshot.refused.length, 0);
    assertEquals(snapshot.pendingCount, 1);
  });
}

Deno.test("after a refused non-retryable 4xx the document is rebuilt, so the refused text is not left in the editor", () => {
  const h = harness();
  const { socket } = connect(h, "Intro");
  const before = h.session.getSnapshot().documentVersion;
  type(h, "refused", 5);
  assertEquals(h.session.document.getText("body").toString(), "Introrefused");
  socket.receive(problemFrame(413, false));
  assertEquals(h.session.getSnapshot().documentVersion, before + 1);
  assertEquals(h.session.document.getText("body").toString(), "");
});
