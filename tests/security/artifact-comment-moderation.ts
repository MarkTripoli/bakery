import { assertEquals } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  commentFixture,
  readCommentPage,
} from "../helpers/artifact-comments.ts";

export async function verifyCommentModeration() {
  const author = await commentFixture();
  const admin = await commentFixture();
  try {
    await author.pgDatabase.query(
      `insert into bakery.organization_memberships
      (id,organization_id,principal_id,role,status,created_at,updated_at,joined_at)
      values ($1,$2,$3,'admin','active',now(),now(),now())`,
      [crypto.randomUUID(), author.organizationId, admin.principalId],
    );
    const root = await author.create("author body", {
      anchor: { kind: "text", startLine: 2, endLine: 2, quote: "évidence" },
    });
    const path = `/v1/artifact-comments/${root.id}`;
    const mutate = (actor: typeof author, version: number, body: unknown) =>
      actor.request(path, {
        organization: author.organizationId,
        method: "PATCH",
        version,
        body,
      });
    assertEquals(
      (await mutate(admin, 1, { body: "Admin rewrite" })).status,
      403,
    );
    const deleted = await mutate(admin, 1, { deleted: true });
    assertEquals(deleted.status, 200);
    const tombstone = contractSchemas.ArtifactComment.parse(
      await deleted.json(),
    );
    assertEquals(tombstone.body, null);
    assertEquals(tombstone.anchor, {
      kind: "text",
      startLine: 2,
      endLine: 2,
      quote: "",
    });
    for (
      const body of [{ body: "hidden edit" }, { resolved: true }, {
        resolved: false,
      }, { deleted: false, body: "restore and edit" }]
    ) {
      assertEquals((await mutate(author, 2, body)).status, 409);
    }
    assertEquals((await mutate(admin, 2, { resolved: true })).status, 409);
    assertEquals((await mutate(author, 2, { deleted: false })).status, 403);
    // Repeated deletion cannot transfer the moderator's restore authority to the author.
    assertEquals((await mutate(author, 2, { deleted: true })).status, 200);
    const stored = await author.pgDatabase.query<{ deleted_by: string }>(
      "select deleted_by from bakery.artifact_comments where id=$1",
      [root.id],
    );
    assertEquals(stored.rows[0]?.deleted_by, admin.principalId);
    assertEquals((await mutate(author, 3, { deleted: false })).status, 403);
    assertEquals((await mutate(admin, 3, { deleted: false })).status, 200);
    const restored = await readCommentPage(
      await author.request(
        `/v1/artifact-versions/${author.versionId}/comments`,
      ),
    );
    assertEquals(restored.items[0]?.body, "author body");
    assertEquals(restored.items[0]?.anchor, root.anchor);
    assertEquals((await mutate(admin, 4, { deleted: true })).status, 200);
    await author.pgDatabase.query(
      "update bakery.organization_memberships set role='developer' where organization_id=$1 and principal_id=$2",
      [author.organizationId, admin.principalId],
    );
    assertEquals((await mutate(admin, 5, { deleted: false })).status, 200);
    assertEquals((await mutate(author, 6, { deleted: true })).status, 200);
    assertEquals((await mutate(author, 7, { deleted: false })).status, 200);
    assertEquals((await mutate(author, 8, { deleted: true })).status, 200);
    assertEquals((await mutate(admin, 9, { deleted: false })).status, 403);
    await author.pgDatabase.query(
      "update bakery.organization_memberships set role='admin' where organization_id=$1 and principal_id=$2",
      [author.organizationId, admin.principalId],
    );
    assertEquals((await mutate(admin, 9, { deleted: false })).status, 200);
  } finally {
    await author.pgDatabase.query(
      "delete from bakery.organization_memberships where organization_id=$1 and principal_id=$2",
      [author.organizationId, admin.principalId],
    );
    await author.cleanup();
    await admin.cleanup();
  }
}

export async function verifyDeletedAnchorReads() {
  const f = await commentFixture();
  try {
    const root = await f.create("hidden body", {
      anchor: { kind: "text", startLine: 2, endLine: 2, quote: "évidence" },
    });
    await f.request(`/v1/artifact-comments/${root.id}`, {
      method: "PATCH",
      version: 1,
      body: { deleted: true },
    });
    const newer = await f.addVersion("prefix\nfirst\névidence\nlast");
    for (
      const path of [
        `/v1/artifact-versions/${f.versionId}/comments?viewVersionId=${f.versionId}`,
        `/v1/artifacts/${f.artifactId}/comments?viewVersionId=${newer}`,
      ]
    ) {
      const page = await readCommentPage(await f.request(path));
      assertEquals(page.items[0]?.body, null);
      assertEquals(page.items[0]?.anchor, {
        kind: "text",
        startLine: 2,
        endLine: 2,
        quote: "",
      });
      assertEquals(page.items[0]?.placement?.anchor, {
        kind: "text",
        startLine: path.includes(newer) ? 3 : 2,
        endLine: path.includes(newer) ? 3 : 2,
        quote: "",
      });
    }
    const original = await f.pgDatabase.query<{ anchor: unknown }>(
      "select anchor from bakery.artifact_comments where id=$1",
      [root.id],
    );
    assertEquals(original.rows[0]?.anchor, root.anchor);
  } finally {
    await f.cleanup();
  }
}
