import { assert } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  authTestOrigin,
  authTestSecret,
  cleanupAuthFixture,
  openAuthFixture,
  signSessionCookie,
} from "./auth.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";

export async function commentFixture() {
  const fixture = await openAuthFixture();
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const email = `comments-${userId}@example.test`;
  const token = crypto.randomUUID();
  const now = new Date();
  const db = fixture.pgDatabase;
  try {
    await db.query(
      `insert into public."user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,'Comments',$2,true,$3,$3)`,
      [userId, email, now],
    );
    await db.query(
      `insert into bakery.principals (id,provider_user_id,display_name,principal_type) values ($1,$2,'Comments','human')`,
      [principalId, userId],
    );
    await db.query(
      `insert into bakery.organizations (id,name,slug,created_at,updated_at) values ($1,'Comments',$2,now(),now())`,
      [organizationId, organizationId],
    );
    await db.query(
      `insert into bakery.organization_memberships (id,organization_id,principal_id,role,status,joined_at,created_at,updated_at) values ($1,$2,$3,'developer','active',$4,$4,$4)`,
      [crypto.randomUUID(), organizationId, principalId, now],
    );
    await db.query(
      `insert into public.session (id,token,"userId","expiresAt","createdAt","updatedAt") values ($1,$2,$3,$4,$5,$5)`,
      [
        crypto.randomUUID(),
        token,
        userId,
        new Date(now.getTime() + 3600000),
        now,
      ],
    );
    await db.query(
      `insert into bakery.applications (id,organization_id,slug,name) values ($1::uuid,$2,$1::text,'Comments')`,
      [applicationId, organizationId],
    );
    await db.query(
      `insert into bakery.conversations (id,organization_id,application_id,title,created_by) values ($1,$2,$3,'Comments',$4)`,
      [conversationId, organizationId, applicationId, principalId],
    );
    await db.query(
      `insert into bakery.tasks (id,organization_id,application_id,conversation_id,title,task_type,created_by) values ($1,$2,$3,$4,'Comments','feature',$5)`,
      [taskId, organizationId, applicationId, conversationId, principalId],
    );
    await db.query(
      `insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name) values ($1,$2,$3,'document','Comments')`,
      [artifactId, organizationId, taskId],
    );
    const cookie = await signSessionCookie(token, authTestSecret);
    let revision = 0;
    const addVersion = async (text: string) => {
      const id = crypto.randomUUID();
      const content = new TextEncoder().encode(text);
      await db.query(
        `insert into bakery.artifact_versions (id,organization_id,artifact_id,task_id,author_id,revision,content,sha256,size_bytes,media_type)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'text/plain')`,
        [
          id,
          organizationId,
          artifactId,
          taskId,
          principalId,
          ++revision,
          content,
          await sha256Bytes(content),
          content.length,
        ],
      );
      return id;
    };
    const versionId = await addVersion("first\névidence\nlast");
    const request = async (
      path: string,
      options: {
        method?: string;
        body?: unknown;
        version?: number;
        key?: string;
        organization?: string;
      } = {},
    ) => {
      const method = options.method ?? "GET";
      const headers = new Headers({
        cookie,
        "Bakery-Organization-Id": options.organization ?? organizationId,
      });
      if (method !== "GET") {
        headers.set("origin", authTestOrigin);
        headers.set("content-type", "application/json");
        headers.set("idempotency-key", options.key ?? crypto.randomUUID());
        if (options.version !== undefined) {
          headers.set("if-match", `"${options.version}"`);
        }
      }
      return await fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        }),
      );
    };
    const create = async (
      body: string,
      extra: Record<string, unknown> = {},
    ) => {
      const response = await request(
        `/v1/artifact-versions/${versionId}/comments`,
        { method: "POST", body: { body, ...extra } },
      );
      if (response.status !== 201 && response.status !== 200) {
        throw new Error(
          `COMMENT_CREATE_${response.status}: ${await response.text()}`,
        );
      }
      return contractSchemas.ArtifactComment.parse(await response.json());
    };
    return {
      ...fixture,
      organizationId,
      principalId,
      conversationId,
      artifactId,
      versionId,
      taskId,
      addVersion,
      request,
      create,
      async cleanup() {
        try {
          await db.query(
            `delete from bakery.artifact_comments where organization_id=$1`,
            [organizationId],
          );
          await cleanupAuthFixture(db, [email]);
        } finally {
          await fixture.close();
        }
      },
    };
  } catch (error) {
    try {
      await db.query(
        "delete from bakery.artifact_comments where organization_id=$1",
        [organizationId],
      );
      await cleanupAuthFixture(db, [email]);
    } finally {
      await fixture.close();
    }
    throw error;
  }
}

export async function readCommentPage(response: Response) {
  const page = contractSchemas["Page<ArtifactComment>"].parse(
    await response.json(),
  );
  assert(page !== null && typeof page === "object" && !Array.isArray(page));
  assert(Array.isArray(page.items));
  assert(page.nextCursor === null || typeof page.nextCursor === "string");
  return {
    items: page.items.map((item) =>
      contractSchemas.ArtifactComment.parse(item)
    ),
    nextCursor: page.nextCursor,
  };
}
