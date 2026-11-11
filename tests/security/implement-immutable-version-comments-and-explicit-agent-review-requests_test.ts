import {
  verifyCommentModeration,
  verifyDeletedAnchorReads,
} from "./artifact-comment-moderation.ts";
import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  commentFixture,
  readCommentPage,
} from "../helpers/artifact-comments.ts";

Deno.test("comments never enqueue turns; deleted and foreign references cannot enter new context", async () => {
  const f = await commentFixture();
  try {
    const root = await f.create("private root");
    const reply = await f.create("deleted reply", { rootId: root.id });
    const count = await f.pgDatabase.query<{ count: number }>(
      `select count(*)::int from bakery.conversation_turns where conversation_id=$1`,
      [f.conversationId],
    );
    assertEquals(count.rows[0]?.count, 0);
    const deleted = await f.request(`/v1/artifact-comments/${reply.id}`, {
      method: "PATCH",
      version: 1,
      body: { deleted: true },
    });
    assertEquals(deleted.status, 200);
    assertEquals(
      contractSchemas.ArtifactComment.parse(await deleted.json()).body,
      null,
    );
    const page = await readCommentPage(
      await f.request(
        `/v1/artifact-versions/${f.versionId}/comments?rootId=${root.id}`,
      ),
    );
    assertEquals(page.items[0]?.body, null);
    const send = (commentId: string, expectedVersion: number) =>
      f.request(`/v1/conversations/${f.conversationId}/messages`, {
        method: "POST",
        body: {
          body: "Review",
          clientMessageId: crypto.randomUUID(),
          intent: "agent_request",
          commentRefs: [{ commentId, expectedVersion }],
        },
      });
    const response = await send(root.id, 3);
    assertEquals(response.status, 201);
    const message = contractSchemas.Message.parse(await response.json());
    assertEquals(message.commentContext?.comments.map((c) => c.body), [
      "private root",
    ]);
    assertEquals((await send(reply.id, 2)).status, 404);
    assertEquals(
      (await f.request(`/v1/artifact-comments/${root.id}`, {
        method: "PATCH",
        version: 3,
        body: { deleted: true },
      })).status,
      200,
    );
    assertEquals((await send(root.id, 4)).status, 404);
    assertEquals(
      (await f.request(`/v1/artifact-versions/${f.versionId}/comments`, {
        organization: crypto.randomUUID(),
      })).status,
      404,
    );
    const restored = await f.request(`/v1/artifact-comments/${root.id}`, {
      method: "PATCH",
      version: 4,
      body: { deleted: false },
    });
    assertEquals(restored.status, 200);
    const otherConversation = crypto.randomUUID();
    await f.pgDatabase.query(
      `insert into bakery.conversations(id,organization_id,application_id,title,created_by)
      select $1,organization_id,application_id,'Other',created_by from bakery.conversations where id=$2`,
      [otherConversation, f.conversationId],
    );
    await f.pgDatabase.query(
      `update bakery.tasks set conversation_id=$1 where id=$2`,
      [otherConversation, f.taskId],
    );
    assertEquals((await send(root.id, 5)).status, 404);
  } finally {
    await f.cleanup();
  }
});

Deno.test("another tenant's real comments cannot be listed, changed or captured", async () => {
  const local = await commentFixture();
  const foreign = await commentFixture();
  try {
    const root = await foreign.create("foreign secret feedback");
    assertEquals(
      (await local.request(
        `/v1/artifact-versions/${foreign.versionId}/comments`,
      )).status,
      404,
    );
    assertEquals(
      (await local.request(`/v1/artifact-comments/${root.id}`, {
        method: "PATCH",
        version: 1,
        body: { deleted: true },
      })).status,
      404,
    );
    const response = await local.request(
      `/v1/conversations/${local.conversationId}/messages`,
      {
        method: "POST",
        body: {
          body: "Review",
          clientMessageId: crypto.randomUUID(),
          intent: "agent_request",
          commentRefs: [{ commentId: root.id, expectedVersion: 1 }],
        },
      },
    );
    assertEquals(response.status, 404);
    const persisted = await local.pgDatabase.query<{ count: number }>(
      "select count(*)::int from bakery.messages where conversation_id=$1",
      [local.conversationId],
    );
    assertEquals(persisted.rows[0]?.count, 0);
  } finally {
    await foreign.cleanup();
    await local.cleanup();
  }
});

Deno.test("nonauthors cannot edit bodies and revoked membership cannot capture feedback", async () => {
  const owner = await commentFixture();
  const member = await commentFixture();
  try {
    const root = await owner.create("author evidence");
    await owner.pgDatabase.query(
      `insert into bakery.organization_memberships
      (id,organization_id,principal_id,role,status,created_at,updated_at,joined_at)
      values ($1,$2,$3,'developer','active',now(),now(),now())`,
      [crypto.randomUUID(), owner.organizationId, member.principalId],
    );
    const edit = await member.request(`/v1/artifact-comments/${root.id}`, {
      organization: owner.organizationId,
      method: "PATCH",
      version: 1,
      body: { body: "forged edit" },
    });
    assertEquals(edit.status, 403);
    await owner.pgDatabase.query(
      "update bakery.organization_memberships set status='inactive' where organization_id=$1 and principal_id=$2",
      [owner.organizationId, member.principalId],
    );
    const send = await member.request(
      `/v1/conversations/${owner.conversationId}/messages`,
      {
        organization: owner.organizationId,
        method: "POST",
        body: {
          body: "Review",
          clientMessageId: crypto.randomUUID(),
          intent: "agent_request",
          commentRefs: [{ commentId: root.id, expectedVersion: 1 }],
        },
      },
    );
    assertEquals(send.status, 404);
  } finally {
    await owner.pgDatabase.query(
      "delete from bakery.organization_memberships where organization_id=$1 and principal_id=$2",
      [owner.organizationId, member.principalId],
    );
    await member.cleanup();
    await owner.cleanup();
  }
});

Deno.test(
  "Admin moderation preserves authorship and deletion ownership",
  verifyCommentModeration,
);
Deno.test(
  "deleted anchors redact quotes in original and mapped reads",
  verifyDeletedAnchorReads,
);
