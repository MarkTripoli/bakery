import { assert, assertEquals } from "@std/assert";
import {
  cleanupDraftFixture,
  draftRequest,
  openDraftFixture,
  responseJson,
} from "../helpers/draft-fixture.ts";
import { authTestOrigin } from "../helpers/auth.ts";
import {
  CollaborationSession,
  type SessionSnapshot,
  type SocketLike,
} from "../../apps/web/src/collaboration/session.ts";

// The browser session from apps/web against the server's real
// /v1/collaboration socket, database and isolated import workers: what the
// fake-socket unit tests (collaboration-session_test.ts) cannot show.

const WAIT_MS = 20_000;

function waitFor(
  session: CollaborationSession,
  label: string,
  done: (snapshot: SessionSnapshot) => boolean,
): Promise<SessionSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `timed out waiting for ${label}: ${
            JSON.stringify(session.getSnapshot())
          }`,
        ),
      );
    }, WAIT_MS);
    const check = () => {
      const snapshot = session.getSnapshot();
      if (!done(snapshot)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    };
    const unsubscribe = session.subscribe(check);
    check();
  });
}

Deno.test("the web session syncs, saves, shares and refuses against the real server", async () => {
  const fixture = await openDraftFixture("alpha target omega");
  let resolvePort: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, (request) => fixture.app.fetch(request));
  const port = await listening;
  const sessions: CollaborationSession[] = [];
  try {
    const opened = await fixture.app.fetch(draftRequest(
      fixture,
      `/v1/artifacts/${fixture.ids.artifactId}/drafts`,
      { method: "POST" },
    ));
    assertEquals(opened.status, 201, await opened.clone().text());
    const draftId = (await responseJson(opened) as { id: string }).id;
    const url = new URL(`ws://127.0.0.1:${port}/v1/collaboration`);
    url.searchParams.set("organizationId", fixture.ids.organizationId);
    const start = () => {
      const session = new CollaborationSession({
        draftId,
        createSocket: () =>
          new WebSocket(url, {
            headers: { Cookie: fixture.cookie, Origin: authTestOrigin },
          } as never) as unknown as SocketLike,
      });
      sessions.push(session);
      session.start();
      return session;
    };

    // 1. Joins and ends up with the draft's text, writable.
    const writer = start();
    await waitFor(
      writer,
      "the first sync",
      (s) => s.connection === "online" && !s.syncing,
    );
    assertEquals(
      writer.document.getText("body").toString(),
      "alpha target omega",
    );
    assertEquals(writer.getSnapshot().saveState, "saved");

    // 2. A typed change is acknowledged by the server.
    const body = writer.document.getText("body");
    body.insert(body.length, " plus typed");
    writer.document.commit();
    assertEquals(writer.getSnapshot().pendingCount, 1);
    await waitFor(writer, "the acknowledgement", (s) => s.pendingCount === 0);
    assertEquals(writer.getSnapshot().refused.length, 0);

    // 3. A second person joining later gets the saved text from the server.
    const reader = start();
    await waitFor(
      reader,
      "the second sync",
      (s) => s.connection === "online" && !s.syncing,
    );
    assertEquals(
      reader.document.getText("body").toString(),
      "alpha target omega plus typed",
    );
    assertEquals(
      new Set(reader.getSnapshot().participants.map((p) => p.principalId)).size,
      1,
      "two tabs of one principal count as one person",
    );

    // 4. A live change reaches the other tab.
    const writerBody = writer.document.getText("body");
    writerBody.insert(0, "Live: ");
    writer.document.commit();
    await waitFor(
      reader,
      "the live update",
      () =>
        reader.document.getText("body").toString().startsWith("Live: alpha"),
    );

    // 5. A change the server refuses (a second shared root) keeps the typed
    // text for the sheet and rebuilds the document from the server's.
    const before = reader.getSnapshot().documentVersion;
    const readerBody = reader.document.getText("body");
    readerBody.insert(readerBody.length, " never saved");
    reader.document.getText("extra").insert(0, "not allowed");
    reader.document.commit();
    const refused = await waitFor(
      reader,
      "the refusal",
      (s) => s.refused.length > 0 && !s.syncing,
    );
    assertEquals(refused.refused[0].text.includes("never saved"), true);
    assert(refused.documentVersion > before);
    assertEquals(refused.saveState, "refused");
    assertEquals(
      reader.document.getText("body").toString().includes("never saved"),
      false,
      "the server's text, not the refused one",
    );
  } finally {
    for (const session of sessions) session.destroy();
    await server.shutdown();
    try {
      await cleanupDraftFixture(fixture);
    } finally {
      await fixture.close();
    }
  }
});
