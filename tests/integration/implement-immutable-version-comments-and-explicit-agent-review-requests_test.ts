import { assert, assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  commentFixture,
  readCommentPage,
} from "../helpers/artifact-comments.ts";

Deno.test("reply mutation defeats stale resolution; pages and placement retain original anchors", async () => {
  const f = await commentFixture();
  try {
    const root = await f.create("review", {
      anchor: { kind: "text", startLine: 2, endLine: 2, quote: "évidence" },
    });
    const reply = await f.create("new feedback", { rootId: root.id });
    const stale = await f.request(`/v1/artifact-comments/${root.id}`, {
      method: "PATCH",
      version: root.version,
      body: { resolved: true },
    });
    assertEquals(stale.status, 412);
    const another = await f.create("second root");
    const page = await readCommentPage(
      await f.request(
        `/v1/artifact-versions/${f.versionId}/comments?limit=1`,
      ),
    );
    assertEquals(page.items.map((c) => c.id), [root.id]);
    assert(page.nextCursor);
    const next = await readCommentPage(
      await f.request(
        `/v1/artifact-versions/${f.versionId}/comments?limit=1&cursor=${
          encodeURIComponent(page.nextCursor)
        }`,
      ),
    );
    assertEquals(next.items.map((c) => c.id), [another.id]);
    assertEquals(next.nextCursor, null);
    const replies = await readCommentPage(
      await f.request(
        `/v1/artifact-versions/${f.versionId}/comments?rootId=${root.id}`,
      ),
    );
    assertEquals(replies.items.map((c) => c.id), [reply.id]);
    const newer = await f.addVersion("changed");
    const across = await readCommentPage(
      await f.request(
        `/v1/artifacts/${f.artifactId}/comments?viewVersionId=${newer}`,
      ),
    );
    assertEquals(across.items[0]?.placement?.status, "outdated");
    assertEquals(across.items[0]?.anchor, root.anchor);
    assertEquals(across.items[0]?.artifactVersionId, f.versionId);
    const resolve = await f.request(`/v1/artifact-comments/${root.id}`, {
      method: "PATCH",
      version: 2,
      body: { resolved: true },
    });
    assertEquals(resolve.status, 200);
  } finally {
    await f.cleanup();
  }
});

Deno.test("explicit send captures one immutable thread and queues exactly one turn across replay", async () => {
  const f = await commentFixture();
  try {
    const root = await f.create("root evidence");
    const reply = await f.create("reply evidence", { rootId: root.id });
    const body = {
      body: "Review these",
      clientMessageId: crypto.randomUUID(),
      intent: "agent_request",
      commentRefs: [{ commentId: root.id, expectedVersion: 2 }],
    };
    const path = `/v1/conversations/${f.conversationId}/messages`;
    const response = await f.request(path, { method: "POST", body });
    assertEquals(response.status, 201);
    const message = contractSchemas.Message.parse(await response.json());
    assertEquals(message.commentContext?.comments.map((c) => c.body), [
      "root evidence",
      "reply evidence",
    ]);
    const edit = await f.request(`/v1/artifact-comments/${reply.id}`, {
      method: "PATCH",
      version: 1,
      body: { body: "edited" },
    });
    assertEquals(edit.status, 200);
    const replay = await f.request(path, { method: "POST", body });
    assertEquals(replay.status, 201);
    assertEquals(
      contractSchemas.Message.parse(await replay.json()).commentContext,
      message.commentContext,
    );
    const counts = await f.pgDatabase.query<
      { messages: number; turns: number }
    >(
      `select
      (select count(*)::int from bakery.messages where conversation_id=$1) messages,
      (select count(*)::int from bakery.conversation_turns where conversation_id=$1) turns`,
      [f.conversationId],
    );
    assertEquals(counts.rows[0], { messages: 1, turns: 1 });
    const stale = await f.request(path, {
      method: "POST",
      body: { ...body, clientMessageId: crypto.randomUUID() },
    });
    assertEquals(stale.status, 412);
  } finally {
    await f.cleanup();
  }
});

Deno.test("a queued reply wins the artifact lock before concurrent stale resolution", async () => {
  const f = await commentFixture();
  const blocker = await f.runtimePgDatabase.connect();
  const pending: Promise<Response>[] = [];
  try {
    const root = await f.create("root");
    await blocker.query("begin");
    await blocker.query(
      "select id from bakery.artifacts where id=$1 for update",
      [f.artifactId],
    );
    const waitFor = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const observed = await f.runtimePgDatabase.query<{ count: number }>(
          `select count(*)::int from pg_stat_activity
          where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'
          and query like '%select a.id from bakery.artifacts a%'`,
        );
        if ((observed.rows[0]?.count ?? 0) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("COMMENT_LOCK_WAITER_MISSING");
    };
    pending.push(
      f.request(`/v1/artifact-versions/${f.versionId}/comments`, {
        method: "POST",
        body: { body: "concurrent feedback", rootId: root.id },
      }),
    );
    await waitFor(1);
    pending.push(
      f.request(`/v1/artifact-comments/${root.id}`, {
        method: "PATCH",
        version: 1,
        body: { resolved: true },
      }),
    );
    await waitFor(2);
    await blocker.query("commit");
    const results = await Promise.all(pending);
    assertEquals(results.map((response) => response.status), [201, 412]);
    const page = await readCommentPage(
      await f.request(`/v1/artifact-versions/${f.versionId}/comments`),
    );
    assertEquals(page.items[0]?.status, "open");
    assertEquals(page.items[0]?.version, 2);
  } finally {
    await blocker.query("rollback");
    blocker.release();
    await Promise.allSettled(pending);
    await f.cleanup();
  }
});

Deno.test("oversized selected feedback rolls back the entire send", async () => {
  const f = await commentFixture();
  try {
    const roots = [];
    for (let index = 0; index < 4; index++) {
      roots.push(await f.create("é".repeat(5120)));
    }
    const response = await f.request(
      `/v1/conversations/${f.conversationId}/messages`,
      {
        method: "POST",
        body: {
          body: "Review",
          clientMessageId: crypto.randomUUID(),
          intent: "agent_request",
          commentRefs: roots.map((root) => ({
            commentId: root.id,
            expectedVersion: root.version,
          })),
        },
      },
    );
    assertEquals(response.status, 413);
    const counts = await f.pgDatabase.query<
      { messages: number; turns: number }
    >(
      `select
      (select count(*)::int from bakery.messages where conversation_id=$1) messages,
      (select count(*)::int from bakery.conversation_turns where conversation_id=$1) turns`,
      [f.conversationId],
    );
    assertEquals(counts.rows[0], { messages: 0, turns: 0 });
  } finally {
    await f.cleanup();
  }
});

Deno.test("discussion messages cannot capture selected feedback", async () => {
  const f = await commentFixture();
  try {
    const root = await f.create("feedback");
    const response = await f.request(
      `/v1/conversations/${f.conversationId}/messages`,
      {
        method: "POST",
        body: {
          body: "Discuss",
          clientMessageId: crypto.randomUUID(),
          intent: "discussion",
          commentRefs: [{ commentId: root.id, expectedVersion: 1 }],
        },
      },
    );
    assertEquals(response.status, 422);
    const counts = await f.pgDatabase.query<{ count: number }>(
      "select count(*)::int from bakery.messages where conversation_id=$1",
      [f.conversationId],
    );
    assertEquals(counts.rows[0]?.count, 0);
  } finally {
    await f.cleanup();
  }
});
