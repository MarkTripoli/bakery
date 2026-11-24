import { assert, assertEquals } from "@std/assert";
import {
  authTestOrigin,
  authTestSecret,
  cleanupAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import { commentFixture } from "../helpers/artifact-comments.ts";
import { sha256Bytes } from "../../apps/server/src/modules/knowledge/bytes.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import {
  resolveDestinationSummary,
  resolveNotificationTarget,
} from "../../apps/server/src/modules/work/notifications-target.ts";
import type { NotificationRow } from "../../apps/server/src/modules/work/notifications-postgres.ts";

type Person = { principalId: string; cookie: string };

Deno.test("a grant-only reader lands on the shared page and nowhere else", async (t) => {
  const f = await commentFixture();
  const db = f.pgDatabase;
  const emails: string[] = [];
  const now = new Date();
  const tag = crypto.randomUUID().slice(0, 8);
  const otherOrganization = crypto.randomUUID();
  const otherConversation = crypto.randomUUID();
  const otherArtifact = crypto.randomUUID();
  const otherVersion = crypto.randomUUID();

  const person = async (
    name: string,
    role: string,
    customRoleId: string | null = null,
  ): Promise<Person> => {
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const email = `${name.toLowerCase().replace(" ", "-")}-${tag}@example.test`;
    emails.push(email);
    await db.query(
      `insert into public."user" (id,name,email,"emailVerified","createdAt","updatedAt")
       values ($1,$2,$3,true,$4,$4)`,
      [userId, name, email, now],
    );
    await db.query(
      `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
       values ($1,$2,$3,'human')`,
      [principalId, userId, name],
    );
    await db.query(
      `insert into bakery.organization_memberships
         (id,organization_id,principal_id,role,status,joined_at,created_at,updated_at,custom_role_id)
       values ($1,$2,$3,$4,'active',$5,$5,$5,$6)`,
      [
        crypto.randomUUID(),
        f.organizationId,
        principalId,
        role,
        now,
        customRoleId,
      ],
    );
    const token = crypto.randomUUID();
    await db.query(
      `insert into public.session (id,token,"userId","expiresAt","createdAt","updatedAt")
       values ($1,$2,$3,$4,$5,$5)`,
      [
        crypto.randomUUID(),
        token,
        userId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    return {
      principalId,
      cookie: await signSessionCookie(token, authTestSecret),
    };
  };

  const get = async (who: Person, path: string): Promise<number> => {
    const response = await f.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        headers: {
          cookie: who.cookie,
          "Bakery-Organization-Id": f.organizationId,
        },
      }),
    );
    await response.body?.cancel();
    return response.status;
  };

  const row = (
    targetKind: string,
    targetId: string,
    taskId: string | null = f.taskId,
  ) => ({
    targetKind,
    targetId,
    targetAnchor: null,
    taskId,
    runId: null,
  });

  const resolve = (
    who: Person,
    target: ReturnType<typeof row>,
    organizationId = f.organizationId,
  ) =>
    withPgTransaction(
      db,
      (transaction) =>
        resolveNotificationTarget(transaction, {
          organizationId,
          recipientId: who.principalId,
        }, target),
    );

  const withoutTime = (
    value: Record<string, unknown>,
  ): Record<string, unknown> => {
    const { sharedAt, ...rest } = value;
    return { ...rest, hasSharedAt: sharedAt !== undefined };
  };

  const comment = async (versionId: string) =>
    (await db.query<{ id: string }>(
      `insert into bakery.artifact_comments
         (organization_id, artifact_version_id, author_id, body)
       values ($1, $2, $3, 'Please read') returning id`,
      [f.organizationId, versionId, f.principalId],
    )).rows[0]!.id;

  const message = async (conversationId: string, sequence: number) =>
    (await db.query<{ id: string }>(
      `insert into bakery.messages (
         organization_id, conversation_id, author_id, message_type, body,
         client_message_id, sequence, intent
       ) values ($1, $2, $3, 'user', 'Have a look', gen_random_uuid()::text,
         $4, 'discussion') returning id`,
      [f.organizationId, conversationId, f.principalId, sequence],
    )).rows[0]!.id;

  try {
    await db.query(
      "update bakery.artifacts set artifact_type = 'plan', name = 'Refund policy' where id = $1",
      [f.artifactId],
    );
    await db.query(
      "update bakery.conversations set title = 'Refund thread' where id = $1",
      [f.conversationId],
    );
    const roleId = crypto.randomUUID();
    await db.query(
      `insert into bakery.organization_roles
         (id, organization_id, key, name, permissions, created_by_principal_id)
       values ($1, $2, 'chat-only', 'Chat only', $3::text[], $4)`,
      [
        roleId,
        f.organizationId,
        ["conversation:read", "notification:read"],
        f.principalId,
      ],
    );
    const ben = await person("Ben Grant", "guest", roleId);
    const dee = await person("Dee Dev", "developer");

    const secondVersion = await f.addVersion("second draft");
    const content = new TextEncoder().encode("bravo secret text");
    await db.query(
      `insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
       values ($1, $2, $3, 'plan', 'Other doc')`,
      [otherArtifact, f.organizationId, f.taskId],
    );
    await db.query(
      `insert into bakery.artifact_versions
         (id, organization_id, artifact_id, task_id, author_id, revision, content, sha256, size_bytes, media_type)
       values ($1, $2, $3, $4, $5, 1, $6, $7, $8, 'text/plain')`,
      [
        otherVersion,
        f.organizationId,
        otherArtifact,
        f.taskId,
        f.principalId,
        content,
        await sha256Bytes(content),
        content.length,
      ],
    );
    await db.query(
      `insert into bakery.conversations (id, organization_id, title, created_by)
       select $1, organization_id, 'Other thread', $3 from bakery.conversations where id = $2`,
      [otherConversation, f.conversationId, f.principalId],
    );
    await db.query(
      `insert into bakery.organizations (id, name, slug, created_at, updated_at)
       values ($1::uuid, 'Elsewhere', $1::text, now(), now())`,
      [otherOrganization],
    );

    const sharedComment = await comment(f.versionId);
    const otherComment = await comment(otherVersion);
    const sharedMessage = await message(f.conversationId, 1);
    const otherMessage = await message(otherConversation, 1);
    await db.query(
      `insert into bakery.artifact_access_grants
         (organization_id, artifact_id, principal_id, level, granted_by)
       values ($1, $2, $3, 'read_comment', $4)`,
      [f.organizationId, f.artifactId, ben.principalId, f.principalId],
    );
    await db.query(
      `insert into bakery.conversation_access_grants
         (organization_id, conversation_id, principal_id, granted_by)
       values ($1, $2, $3, $4)`,
      [f.organizationId, f.conversationId, ben.principalId, f.principalId],
    );

    await t.step("a document grant lands on the shared document", async () => {
      assertEquals(
        withoutTime(await resolve(ben, row("comment", sharedComment))),
        {
          status: "available",
          targetKind: "comment",
          path:
            `/shared/documents/${f.artifactId}?version=${f.versionId}&comment=${sharedComment}`,
          anchor: `comment:${sharedComment}`,
          viaGrant: true,
          sharedByName: "Comments",
          hasSharedAt: true,
        },
      );
      assertEquals(
        withoutTime(await resolve(ben, row("document_version", secondVersion))),
        {
          status: "available",
          targetKind: "document_version",
          path: `/shared/documents/${f.artifactId}?version=${secondVersion}`,
          anchor: "version:2",
          viaGrant: true,
          sharedByName: "Comments",
          hasSharedAt: true,
        },
      );
    });

    await t.step(
      "a conversation grant lands on the shared conversation",
      async () => {
        assertEquals(
          withoutTime(
            await resolve(ben, row("conversation_message", sharedMessage)),
          ),
          {
            status: "available",
            targetKind: "conversation_message",
            path:
              `/shared/conversations/${f.conversationId}?message=${sharedMessage}`,
            anchor: `message:${sharedMessage}`,
            viaGrant: true,
            sharedByName: "Comments",
            hasSharedAt: true,
          },
        );
      },
    );

    await t.step(
      "the grant never reaches another document, conversation or organization",
      async () => {
        for (
          const target of [
            row("comment", otherComment),
            row("document_version", otherVersion),
            row("conversation_message", otherMessage),
          ]
        ) {
          assertEquals(await resolve(ben, target), {
            status: "unavailable",
            targetKind: target.targetKind as never,
            path: null,
            anchor: null,
            reason: "no_longer_shared",
          });
        }
        for (
          const target of [
            row("comment", sharedComment),
            row("document_version", f.versionId),
            row("conversation_message", sharedMessage),
          ]
        ) {
          assertEquals(
            await resolve(ben, target, otherOrganization),
            {
              status: "unavailable",
              targetKind: target.targetKind as never,
              path: null,
              anchor: null,
              reason: "gone",
            },
          );
        }
      },
    );

    await t.step(
      "a reader who can open the task keeps the task route",
      async () => {
        assertEquals(await resolve(dee, row("comment", sharedComment)), {
          status: "available",
          targetKind: "comment",
          path: `/tasks/${f.taskId}/artifacts/${f.artifactId}`,
          anchor: `comment:${sharedComment}`,
        });
        assertEquals(
          await resolve(dee, row("conversation_message", sharedMessage)),
          {
            status: "available",
            targetKind: "conversation_message",
            path: `/tasks/${f.taskId}`,
            anchor: null,
          },
        );
      },
    );

    await t.step(
      "the inbox title is the shared thing's own name, never the task's",
      async () => {
        const title = (targetKind: string, targetId: string) =>
          withPgTransaction(
            db,
            (transaction) =>
              resolveDestinationSummary(transaction, {
                organizationId: f.organizationId,
                recipientId: ben.principalId,
              }, row(targetKind, targetId) as unknown as NotificationRow),
          );
        assertEquals(await title("comment", sharedComment), {
          title: "Refund policy",
          available: true,
        });
        assertEquals(await title("conversation_message", sharedMessage), {
          title: "Refund thread",
          available: true,
        });
        assertEquals(await title("comment", otherComment), {
          title: null,
          available: false,
        });
      },
    );

    await t.step(
      "the grant alone reads the document, its versions and comments, and no other",
      async () => {
        assertEquals(await get(ben, `/v1/artifacts/${f.artifactId}`), 200);
        assertEquals(
          await get(ben, `/v1/artifacts/${f.artifactId}/versions?limit=5`),
          200,
        );
        assertEquals(
          await get(
            ben,
            `/v1/artifact-versions/${secondVersion}/comments?limit=5`,
          ),
          200,
        );
        for (
          const path of [
            `/v1/artifacts/${otherArtifact}`,
            `/v1/artifacts/${otherArtifact}/versions?limit=5`,
            `/v1/artifact-versions/${otherVersion}/comments?limit=5`,
            `/v1/tasks/${f.taskId}`,
          ]
        ) {
          const code = await get(ben, path);
          assert(code === 403 || code === 404, `${path} denied, got ${code}`);
        }
      },
    );

    await t.step(
      "a deleted comment opens the document without it",
      async () => {
        await db.query(
          "update bakery.artifact_comments set deleted_at = now() where id = $1",
          [sharedComment],
        );
        assertEquals(
          withoutTime(await resolve(ben, row("comment", sharedComment))),
          {
            status: "part_unavailable",
            targetKind: "comment",
            path: `/shared/documents/${f.artifactId}?version=${f.versionId}`,
            anchor: null,
            viaGrant: true,
            sharedByName: "Comments",
            hasSharedAt: true,
          },
        );
      },
    );

    await t.step(
      "a revoked grant says no longer shared and names who shared it",
      async () => {
        await db.query(
          `update bakery.artifact_access_grants set revoked_at = now(), revoked_by = $2
          where organization_id = $1 and principal_id = $3`,
          [f.organizationId, f.principalId, ben.principalId],
        );
        await db.query(
          `update bakery.conversation_access_grants set revoked_at = now(), revoked_by = $2
          where organization_id = $1 and principal_id = $3`,
          [f.organizationId, f.principalId, ben.principalId],
        );
        for (
          const target of [
            row("document_version", f.versionId),
            row("conversation_message", sharedMessage),
          ]
        ) {
          assertEquals(withoutTime(await resolve(ben, target)), {
            status: "unavailable",
            targetKind: target.targetKind as never,
            path: null,
            anchor: null,
            reason: "no_longer_shared",
            sharedByName: "Comments",
            hasSharedAt: true,
          });
        }
        assertEquals(
          await get(ben, `/v1/artifacts/${f.artifactId}`) >= 403,
          true,
        );
      },
    );

    await t.step(
      "a deleted target is gone, and an unknown one is unknown",
      async () => {
        assertEquals(
          await resolve(ben, row("comment", crypto.randomUUID())),
          {
            status: "unavailable",
            targetKind: "comment",
            path: null,
            anchor: null,
            reason: "gone",
          },
        );
        assertEquals(
          await resolve(
            dee,
            row("run", crypto.randomUUID(), crypto.randomUUID()),
          ),
          {
            status: "unavailable",
            targetKind: "run",
            path: null,
            anchor: null,
            reason: "gone",
          },
        );
        assertEquals(
          await resolve(dee, row("retired_kind", crypto.randomUUID())),
          {
            status: "unavailable",
            targetKind: "comment",
            path: null,
            anchor: null,
            reason: "unknown",
          },
        );
      },
    );
  } finally {
    await db.query(
      "delete from bakery.artifact_access_grants where organization_id = $1",
      [f.organizationId],
    );
    await db.query(
      "delete from bakery.conversation_access_grants where organization_id = $1",
      [f.organizationId],
    );
    await db.query(
      "delete from bakery.artifact_comments where organization_id = $1",
      [f.organizationId],
    );
    await db.query("delete from bakery.messages where organization_id = $1", [
      f.organizationId,
    ]);
    await db.query("delete from bakery.artifact_versions where id = $1", [
      otherVersion,
    ]);
    await db.query("delete from bakery.artifacts where id = $1", [
      otherArtifact,
    ]);
    await db.query("delete from bakery.conversations where id = $1", [
      otherConversation,
    ]);
    await db.query("delete from bakery.organizations where id = $1", [
      otherOrganization,
    ]);
    await cleanupAuthFixture(db, emails);
    await db.query(
      "delete from bakery.organization_roles where organization_id = $1",
      [f.organizationId],
    );
    await f.cleanup();
  }
});
