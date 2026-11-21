import { assert, assertEquals } from "@std/assert";
import { LoroDoc } from "loro-crdt";
import { DRAFT_LIMITS } from "../../apps/server/src/modules/knowledge/drafts.ts";
import {
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "../../apps/server/src/modules/knowledge/collaboration-socket.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  addGuest,
  callAs,
  chatOnlyRole,
  type Guest,
  removeGuests,
  secondDocument,
} from "../helpers/artifact-grant-fixture.ts";
import {
  cleanupDraftFixture,
  type DraftFixture,
  draftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";
import {
  connectWebSocket,
  type WebSocketHandshakeFailure,
  type WebSocketNext,
  type WsClient,
} from "../helpers/ws-client.ts";

/**
 * #73 edit slice: a document grant at level edit works THAT document's draft
 * and nothing else, over the REST routes and over the live collaboration socket.
 * The people are guests whose role reads no document, so the grant is the only
 * thing that opens one. Each case is the boundary a mutation of the grant
 * lookups would cross: another document's draft, a lower level, a revoked
 * grant, a peer whose access ended while the room stayed open.
 */

const ok = (status: number) => status >= 200 && status < 300;
const refused = (status: number) => status === 403 || status === 404;

type DraftView = {
  id: string;
  epoch: number;
  checkpointId: string;
  textDigest: string;
};
type SliceView = {
  checkpointId: string;
  startCursor: unknown;
  endCursor: unknown;
  text: string;
  textDigest: string;
};

Deno.test("an edit grant works one document's draft over REST and nothing beyond it", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  const guests: Guest[] = [];
  try {
    const owner = { cookie: fixture.cookie };
    const roleId = await chatOnlyRole(fixture);
    const editor = await addGuest(fixture, "Ed Editor", roleId);
    const reader = await addGuest(fixture, "Rae Reader", roleId);
    guests.push(editor, reader);
    const A = fixture.ids.artifactId;
    const B = await secondDocument(fixture);

    const openDraft = async (artifactId: string) => {
      const response = await callAs(
        fixture,
        owner,
        `/v1/artifacts/${artifactId}/drafts`,
        "POST",
      );
      assert(ok(response.status), `owner opens a draft: ${response.text}`);
      return response.json as DraftView;
    };
    const draftA = await openDraft(A);
    const draftB = await openDraft(B.artifactId);
    const sliceOf = (who: { cookie: string }, draft: DraftView) =>
      callAs(
        fixture,
        who,
        `/v1/drafts/${draft.id}/slice?checkpointId=${draft.checkpointId}&startUtf16=0&endUtf16=5`,
      );
    const editBody = (draft: DraftView, slice: SliceView, text: string) => ({
      epoch: draft.epoch,
      sourceCheckpointId: slice.checkpointId,
      startCursor: slice.startCursor,
      endCursor: slice.endCursor,
      expectedText: slice.text,
      expectedDigest: slice.textDigest,
      replacement: text,
      mutationId: crypto.randomUUID(),
    });
    const commentBody = (draft: DraftView, slice: SliceView, text: string) => ({
      body: text,
      epoch: draft.epoch,
      startCursor: slice.startCursor,
      endCursor: slice.endCursor,
      quote: slice.text,
      mutationId: crypto.randomUUID(),
    });

    // The owner leaves one suggestion and one comment on each document.
    const prepare = async (draft: DraftView) => {
      const slice = (await sliceOf(owner, draft)).json as SliceView;
      const suggestion = await callAs(
        fixture,
        owner,
        `/v1/drafts/${draft.id}/suggestions`,
        "POST",
        editBody(draft, slice, "ZZ"),
      );
      assert(ok(suggestion.status), `owner suggestion: ${suggestion.text}`);
      const comment = await callAs(
        fixture,
        owner,
        `/v1/drafts/${draft.id}/comments`,
        "POST",
        commentBody(draft, slice, "owner comment"),
      );
      assert(ok(comment.status), `owner comment: ${comment.text}`);
      const made = comment.json as { id: string; version?: number };
      return {
        slice,
        suggestionId: (suggestion.json as { id: string }).id,
        commentId: made.id,
        commentVersion: made.version ?? 1,
      };
    };
    const preparedA = await prepare(draftA);
    const preparedB = await prepare(draftB);

    const grant = async (who: Guest, level: "edit" | "read_comment") => {
      const response = await callAs(
        fixture,
        owner,
        `/v1/artifacts/${A}/access`,
        "POST",
        { principalId: who.principalId, level },
      );
      assert(ok(response.status), `grant ${level}: ${response.text}`);
    };
    await grant(editor, "edit");
    await grant(reader, "read_comment");

    // Every draft read and write the design names, as one person on one draft.
    const matrix = async (
      who: { cookie: string },
      draft: DraftView,
      prepared: typeof preparedA,
      artifactId: string,
      label: string,
      expected: "allowed" | "refused",
    ) => {
      const check = (route: string, status: number) =>
        assert(
          expected === "allowed" ? ok(status) : refused(status),
          `${label}: ${route} answered ${status}, expected ${expected}`,
        );
      check(
        "drafts.get",
        (await callAs(fixture, who, `/v1/drafts/${draft.id}`)).status,
      );
      check("draftSlices.get", (await sliceOf(who, draft)).status);
      check(
        "draftCheckpoints.get",
        (await callAs(
          fixture,
          who,
          `/v1/drafts/${draft.id}/checkpoints/${draft.checkpointId}`,
        )).status,
      );
      check(
        "draftSuggestions.list",
        (await callAs(fixture, who, `/v1/drafts/${draft.id}/suggestions`))
          .status,
      );
      check(
        "draftComments.list",
        (await callAs(fixture, who, `/v1/drafts/${draft.id}/comments`)).status,
      );
      check(
        "draftComments.create",
        (await callAs(
          fixture,
          who,
          `/v1/drafts/${draft.id}/comments`,
          "POST",
          commentBody(draft, prepared.slice, "grantee comment"),
        )).status,
      );
      check(
        "draftSuggestions.create",
        (await callAs(
          fixture,
          who,
          `/v1/drafts/${draft.id}/suggestions`,
          "POST",
          editBody(draft, prepared.slice, "YY"),
        )).status,
      );
      check(
        "drafts.open",
        (await callAs(
          fixture,
          who,
          `/v1/artifacts/${artifactId}/drafts`,
          "POST",
        ))
          .status,
      );
    };
    await matrix(
      editor,
      draftA,
      preparedA,
      A,
      "edit grant on its document",
      "allowed",
    );
    await matrix(
      editor,
      draftB,
      preparedB,
      B.artifactId,
      "edit grant on another document",
      "refused",
    );
    await matrix(
      reader,
      draftA,
      preparedA,
      A,
      "read_comment grant on its document",
      "refused",
    );

    // The writes that need more set-up: edit, publish, decide a suggestion, roll over.
    const sliceA = (await sliceOf(editor, draftA)).json as SliceView;
    const currentA = (await callAs(fixture, editor, `/v1/drafts/${draftA.id}`))
      .json as DraftView;
    const edited = await callAs(
      fixture,
      editor,
      `/v1/drafts/${draftA.id}/edits`,
      "POST",
      editBody(
        currentA,
        (await sliceOf(editor, currentA)).json as SliceView,
        "ZEDIT",
      ),
    );
    assert(
      ok(edited.status),
      `the grantee edits its document's draft: ${edited.text}`,
    );
    const afterEdit = (await callAs(fixture, editor, `/v1/drafts/${draftA.id}`))
      .json as DraftView;
    const published = await callAs(
      fixture,
      editor,
      `/v1/drafts/${draftA.id}/publications`,
      "POST",
      {
        checkpointId: afterEdit.checkpointId,
        textDigest: afterEdit.textDigest,
      },
    );
    assert(ok(published.status), `the grantee publishes: ${published.text}`);
    const publication = await callAs(
      fixture,
      editor,
      `/v1/drafts/${draftA.id}/publications/${afterEdit.checkpointId}`,
    );
    assert(
      ok(publication.status),
      `the grantee reads the publication: ${publication.text}`,
    );
    assert(
      refused(
        (await callAs(
          fixture,
          editor,
          `/v1/drafts/${draftB.id}/publications/${draftB.checkpointId}`,
        )).status,
      ),
      "the grantee read another document's publication",
    );
    const rejected = await callAs(
      fixture,
      editor,
      `/v1/drafts/${draftA.id}/suggestions/${preparedA.suggestionId}/reject`,
      "POST",
    );
    assert(
      ok(rejected.status),
      `the grantee decides a suggestion: ${rejected.text}`,
    );
    // A comment is its author's to change: the owner's comment is refused to a grantee.
    const updated = await callAs(
      fixture,
      editor,
      `/v1/drafts/${draftA.id}/comments/${preparedA.commentId}`,
      "PATCH",
      { body: "edited by the grantee" },
      { "if-match": `"${preparedA.commentVersion}"` },
    );
    assertEquals(updated.status, 403, "a grantee changed the owner's comment");
    // A comment of its own is the grantee's to change.
    const nowA = (await callAs(fixture, editor, `/v1/drafts/${draftA.id}`))
      .json as DraftView;
    const own = await callAs(
      fixture,
      editor,
      `/v1/drafts/${draftA.id}/comments`,
      "POST",
      commentBody(
        nowA,
        (await sliceOf(editor, nowA)).json as SliceView,
        "mine",
      ),
    );
    assert(ok(own.status), `the grantee comments: ${own.text}`);
    const ownComment = own.json as { id: string; version?: number };
    const ownUpdate = await callAs(
      fixture,
      editor,
      `/v1/drafts/${draftA.id}/comments/${ownComment.id}`,
      "PATCH",
      { body: "mine, edited" },
      { "if-match": `"${ownComment.version ?? 1}"` },
    );
    assert(
      ok(ownUpdate.status),
      `the grantee edits its own comment: ${ownUpdate.text}`,
    );
    assert(
      refused(
        (await callAs(
          fixture,
          reader,
          `/v1/drafts/${draftA.id}/rollover`,
          "POST",
          { epoch: afterEdit.epoch, checkpointId: afterEdit.checkpointId },
        )).status,
      ),
      "a read_comment grantee rolled the draft over",
    );
    const rolled = await callAs(
      fixture,
      editor,
      `/v1/drafts/${draftA.id}/rollover`,
      "POST",
      { epoch: afterEdit.epoch, checkpointId: afterEdit.checkpointId },
    );
    assert(
      ok(rolled.status),
      `the grantee rolls the draft over: ${rolled.text}`,
    );

    // Cross-document: the grantee names its own draft in the path and the OTHER
    // document's suggestion, comment, checkpoint or publication id.
    const cross = async (
      name: string,
      path: string,
      method: "GET" | "POST" | "PATCH",
      body?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const response = await callAs(fixture, editor, path, method, body, extra);
      assert(
        refused(response.status) || [400, 409, 422].includes(response.status),
        `cross-document ${name} answered ${response.status}: ${response.text}`,
      );
    };
    await cross(
      "accept another document's suggestion",
      `/v1/drafts/${draftA.id}/suggestions/${preparedB.suggestionId}/accept`,
      "POST",
    );
    await cross(
      "reject another document's suggestion",
      `/v1/drafts/${draftA.id}/suggestions/${preparedB.suggestionId}/reject`,
      "POST",
    );
    await cross(
      "update another document's comment",
      `/v1/drafts/${draftA.id}/comments/${preparedB.commentId}`,
      "PATCH",
      { body: "hijacked" },
      { "if-match": `"${preparedB.commentVersion}"` },
    );
    await cross(
      "read another document's checkpoint",
      `/v1/drafts/${draftA.id}/checkpoints/${draftB.checkpointId}`,
      "GET",
    );
    await cross(
      "read another document's publication",
      `/v1/drafts/${draftA.id}/publications/${draftB.checkpointId}`,
      "GET",
    );
    const suggestionsB = await callAs(
      fixture,
      owner,
      `/v1/drafts/${draftB.id}/suggestions`,
    );
    const commentsB = await callAs(
      fixture,
      owner,
      `/v1/drafts/${draftB.id}/comments`,
    );
    assert(
      !/"status":"(accepted|rejected)"/.test(suggestionsB.text),
      "another document's suggestion was decided through this draft",
    );
    assert(
      !commentsB.text.includes("hijacked"),
      "another document's comment was changed through this draft",
    );

    // Nothing else: the other document, the task, sharing.
    const denied = async (
      name: string,
      path: string,
      method: "GET" | "POST" = "GET",
      body?: unknown,
    ) => {
      const response = await callAs(fixture, editor, path, method, body);
      assert(
        refused(response.status),
        `${name} must be refused to an edit grantee, answered ${response.status}`,
      );
    };
    await denied("the other document", `/v1/artifacts/${B.artifactId}`);
    await denied("the task", `/v1/tasks/${fixture.ids.taskId}`);
    await denied(
      "sharing the document",
      `/v1/artifacts/${A}/access`,
      "POST",
      { principalId: reader.principalId, level: "edit" },
    );

    // Lowering the level cuts access at once.
    const lowered = await callAs(
      fixture,
      owner,
      `/v1/artifacts/${A}/access`,
      "POST",
      { principalId: editor.principalId, level: "read_comment" },
    );
    assert(ok(lowered.status), `the owner lowers the grant: ${lowered.text}`);
    assert(
      refused(
        (await callAs(
          fixture,
          editor,
          `/v1/drafts/${draftA.id}/comments`,
          "POST",
          commentBody(currentA, sliceA, "after lowering"),
        )).status,
      ),
      "a lowered grantee still writes to the draft",
    );
    assert(
      refused(
        (await callAs(fixture, editor, `/v1/drafts/${draftA.id}`)).status,
      ),
      "a lowered grantee still reads the draft",
    );
  } finally {
    try {
      await cleanupDraftFixture(fixture);
      await removeGuests(fixture, guests);
    } finally {
      await fixture.close();
    }
  }
});

// ---- the live collaboration socket ----

// An update is acknowledged only after its isolated worker starts and finishes.
const ACK_WAIT_MS = DRAFT_LIMITS.workerStartupMs +
  DRAFT_LIMITS.workerRuntimeMs +
  2_000;

type Frame = Record<string, unknown> & { type: string };

type Harness = {
  fixture: DraftFixture;
  draftId: string;
  url: URL;
  clients: Set<WsClient>;
  /** Presence heartbeats started by keepPresent; cleared on close. */
  heartbeats: ReturnType<typeof setInterval>[];
  guests: Guest[];
  server: Deno.HttpServer;
};

async function openHarness(): Promise<Harness> {
  const fixture = await openDraftFixture("alpha target omega", {
    collaborationSocket: {},
  });
  const opened = await fixture.app.fetch(draftRequest(
    fixture,
    `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
    { method: "POST" },
  ));
  assertEquals(opened.status, 201, await opened.clone().text());
  const draftId = (await responseJson(opened) as { id: string }).id;
  let resolvePort: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, (request) => fixture.app.fetch(request));
  const port = await listening;
  const url = new URL(`ws://127.0.0.1:${port}/v1/collaboration`);
  url.searchParams.set("organizationId", fixture.ids.organizationId);
  return {
    fixture,
    draftId,
    url,
    clients: new Set(),
    heartbeats: [],
    guests: [],
    server,
  };
}

async function closeHarness(harness: Harness) {
  for (const timer of harness.heartbeats) clearInterval(timer);
  for (const client of harness.clients) await client.close().catch(() => {});
  await harness.server.shutdown();
  try {
    // Deleting the organization first cascades every draft and update, so a
    // late commit fails on its missing draft and no row references a guest.
    await cleanupDraftFixture(harness.fixture);
    await removeGuests(harness.fixture, harness.guests);
  } finally {
    await harness.fixture.close();
  }
}

async function connect(
  harness: Harness,
  who: { cookie: string },
): Promise<WsClient | WebSocketHandshakeFailure> {
  const client = await connectWebSocket(harness.url, {
    headers: new Headers({ Cookie: who.cookie, Origin: authTestOrigin }),
  });
  if ("send" in client) harness.clients.add(client);
  return client;
}

async function nextFrame(client: WsClient, timeoutMs = 3_000): Promise<Frame> {
  const value: WebSocketNext = await client.next(timeoutMs);
  if (typeof value !== "string") {
    throw new Error(`socket closed ${value.code} ${value.reason}`);
  }
  return JSON.parse(value) as Frame;
}

async function open(harness: Harness, who: { cookie: string }) {
  const client = await connect(harness, who);
  assert("send" in client, JSON.stringify(client));
  assertEquals((await nextFrame(client)).type, "hello");
  return client;
}

/** The next frame of `type`; a refusal while waiting for an ack is the answer. */
async function until(
  client: WsClient,
  type: string,
  timeoutMs = 3_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`no ${type} frame within ${timeoutMs} ms`);
    // Binary frames (a relayed edit) are not what is waited for: skip them.
    const value = await client.nextMessage(left);
    if (typeof value === "object" && "binary" in value) continue;
    if (typeof value !== "string") {
      throw new Error(`socket closed ${value.code} ${value.reason}`);
    }
    const frame = JSON.parse(value) as Frame;
    if (frame.type === type) return frame;
    if (
      type === "ack" &&
      (frame.type === "problem" || frame.type === "resync_required")
    ) throw new Error(`expected ack, got ${JSON.stringify(frame)}`);
  }
}

/** Everything received within `ms`: frames, the count of binary frames, a close. */
async function collect(client: WsClient, ms: number) {
  const frames: Frame[] = [];
  let binaries = 0;
  let closed: { code: number; reason: string } | undefined;
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let value;
    try {
      value = await client.nextMessage(left);
    } catch {
      break;
    }
    if (typeof value === "object" && "binary" in value) binaries++;
    else if (typeof value !== "string") {
      closed = value;
      break;
    } else frames.push(JSON.parse(value) as Frame);
  }
  return { frames, binaries, closed };
}

const room = (id: string) => ({ kind: "draft", id });

async function join(client: WsClient, id: string) {
  await client.send(JSON.stringify({
    type: "join",
    requestId: crypto.randomUUID(),
    room: room(id),
  }));
}

/** Keeps a joined client present, as a real client's heartbeat does. */
function keepPresent(harness: Harness, client: WsClient): void {
  harness.heartbeats.push(setInterval(() => {
    client.send(JSON.stringify({
      type: "presence.update",
      requestId: crypto.randomUUID(),
      room: room(harness.draftId),
      state: { activity: "active", typing: false, cursor: null },
    })).catch(() => {});
  }, 1_000));
}

async function joinAndSync(client: WsClient, harness: Harness) {
  await join(client, harness.draftId);
  await until(client, "joined");
  await client.send(JSON.stringify({
    type: "sync",
    requestId: crypto.randomUUID(),
    room: room(harness.draftId),
  }));
  const synced = await until(client, "synced");
  const value = await client.nextMessage(5_000);
  assert(typeof value === "object" && "binary" in value, JSON.stringify(value));
  const snapshot = decodeBinaryFrame(value.binary);
  assertEquals(snapshot.kind, BinaryFrameKind.ServerSnapshot);
  const doc = new LoroDoc();
  doc.import(snapshot.payload);
  return { doc, epoch: synced.epoch as number };
}

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
  const read = await harness.fixture.app.fetch(
    draftRequest(harness.fixture, `/v1/drafts/${harness.draftId}`),
  );
  assertEquals(read.status, 200);
  return (await responseJson(read)) as { text: string };
}

Deno.test("the live socket follows the grant: connect, write, peer fan-out, downgrade, revoke and another document's draft", async () => {
  const harness = await openHarness();
  try {
    const fixture = harness.fixture;
    const owner = { cookie: fixture.cookie };
    const roleId = await chatOnlyRole(fixture);
    const reader = await addGuest(fixture, "Rae Reader", roleId);
    const first = await addGuest(fixture, "Ed Editor", roleId);
    const second = await addGuest(fixture, "Eve Editor", roleId);
    const third = await addGuest(fixture, "Fay Editor", roleId);
    harness.guests.push(reader, first, second, third);
    const A = fixture.ids.artifactId;
    const grant = async (who: Guest, level: "edit" | "read_comment") => {
      const response = await callAs(
        fixture,
        owner,
        `/v1/artifacts/${A}/access`,
        "POST",
        { principalId: who.principalId, level },
      );
      assert(ok(response.status), `grant ${level}: ${response.text}`);
    };
    const revoke = async (who: Guest) => {
      const list = await callAs(fixture, owner, `/v1/artifacts/${A}/access`);
      const row = (list.json as {
        items: { principalId: string; version: number }[];
      }).items.find((item) => item.principalId === who.principalId)!;
      const response = await callAs(
        fixture,
        owner,
        `/v1/artifacts/${A}/access/revoke`,
        "POST",
        { principalId: who.principalId },
        { "if-match": `"${row.version}"` },
      );
      assert(ok(response.status), `revoke: ${response.text}`);
    };

    // A read_comment grant holds no draft permission anywhere, so no socket.
    await grant(reader, "read_comment");
    const readOnly = await connect(harness, reader);
    assert(
      !("send" in readOnly),
      "a read_comment-only guest opened the collaboration socket",
    );

    // An editor writes and receives the owner's edits while the grant holds;
    // once it is lowered or revoked its writes are refused, the owner's later
    // edits are no longer relayed to it, and the refused write is not committed.
    const scenario = async (
      who: Guest,
      label: string,
      change: () => Promise<void>,
    ) => {
      await grant(who, "edit");
      const editor = await open(harness, who);
      const synced = await joinAndSync(editor, harness);
      keepPresent(harness, editor);
      const firstMutation = crypto.randomUUID();
      await editor.sendRaw(
        0x2,
        updateFrame(
          harness,
          synced.epoch,
          firstMutation,
          localEdit(synced.doc, 0, "A "),
        ),
      );
      assertEquals(
        (await until(editor, "ack", ACK_WAIT_MS)).mutationId,
        firstMutation,
        `${label}: the edit grantee's first update is acknowledged`,
      );
      const peer = await open(harness, { cookie: fixture.cookie });
      const peerSynced = await joinAndSync(peer, harness);
      keepPresent(harness, peer);
      await peer.sendRaw(
        0x2,
        updateFrame(
          harness,
          peerSynced.epoch,
          crypto.randomUUID(),
          localEdit(peerSynced.doc, 0, "O1 "),
        ),
      );
      await until(peer, "ack", ACK_WAIT_MS);
      assert(
        (await collect(editor, 1_500)).binaries > 0,
        `${label}: the owner's edit is relayed to the grantee while the grant holds`,
      );

      await change();

      const refusedMutation = crypto.randomUUID();
      await editor.sendRaw(
        0x2,
        updateFrame(
          harness,
          synced.epoch,
          refusedMutation,
          localEdit(synced.doc, 0, "B "),
        ),
      ).catch(() => {});
      await peer.sendRaw(
        0x2,
        updateFrame(
          harness,
          peerSynced.epoch,
          crypto.randomUUID(),
          localEdit(peerSynced.doc, 0, "O2 "),
        ),
      );
      await until(peer, "ack", ACK_WAIT_MS);
      const after = await collect(editor, 4_000);
      assert(
        !after.frames.some((frame) =>
          frame.type === "ack" && frame.mutationId === refusedMutation
        ),
        `${label}: a write was acknowledged after the grant changed`,
      );
      assertEquals(
        after.binaries,
        0,
        `${label}: the owner's later edit was still relayed to the grantee`,
      );
      assert(
        !(await committedText(harness)).text.includes("B "),
        `${label}: the refused write was committed`,
      );
    };
    await scenario(
      first,
      "downgrade to read_comment",
      () => grant(first, "read_comment"),
    );
    await scenario(second, "revoke", () => revoke(second));

    // An edit grant on this document must not open a real draft of another.
    await grant(third, "edit");
    const other = await secondDocument(fixture);
    const openedOther = await callAs(
      fixture,
      owner,
      `/v1/artifacts/${other.artifactId}/drafts`,
      "POST",
    );
    assert(
      ok(openedOther.status),
      `the owner opens the other draft: ${openedOther.text}`,
    );
    const otherDraftId = (openedOther.json as { id: string }).id;
    const guest = await open(harness, third);
    await join(guest, otherDraftId);
    const crossed = await collect(guest, 3_000);
    assert(
      !crossed.frames.some((frame) => frame.type === "joined"),
      "an edit grant on one document joined another document's draft",
    );
    // The control: the same grantee joins its own document's draft.
    await join(guest, harness.draftId);
    assert(
      (await collect(guest, 3_000)).frames.some((frame) =>
        frame.type === "joined"
      ),
      "the control: the grantee joins its own document's draft",
    );
  } finally {
    await closeHarness(harness);
  }
});
