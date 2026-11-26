import { assert, assertEquals } from "@std/assert";
import {
  authTestOrigin,
  authTestSecret,
  cleanupAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import { commentFixture } from "../helpers/artifact-comments.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { resolveOrganizationActor } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { authorizeDraftAccess } from "../../apps/server/src/modules/auth/adapters/artifact-grants-postgres.ts";

/**
 * #73 revision 3: direct access to one document, through the real routes, the
 * real authority runner and real Postgres. A person whose role cannot read
 * documents is given access by hand or by a mention, reads and comments on that
 * one document and nothing else, cannot reshare, and loses it on revoke.
 */

type Person = { principalId: string; email: string; cookie: string };
type Grant = {
  id: string;
  artifactId: string;
  principalId: string;
  level: string;
  version: number;
  revokedAt: string | null;
  /** The comment that gave the access; null when it was given by hand. */
  sourceCommentId: string | null;
};

Deno.test("a document grant opens that document, comments and nothing else", async (t) => {
  const f = await commentFixture();
  const db = f.pgDatabase;
  const emails: string[] = [];
  const now = new Date();
  const tag = crypto.randomUUID().slice(0, 8);

  const person = async (
    name: string,
    role: string,
    customRoleId: string | null = null,
  ): Promise<Person> => {
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const email = `${name.toLowerCase()}-${tag}@example.test`;
    emails.push(email);
    await db.query(
      `insert into public."user" (id,name,email,"emailVerified","createdAt","updatedAt")
       values ($1,$2,$3,true,$4,$4)`,
      [userId, name, email, now],
    );
    await db.query(
      `insert into bakery.principals (id,provider_user_id,display_name,principal_type)
       values ($1,$2,$3,'human')`,
      [principalId, userId, `${name} ${tag}`],
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
      email,
      cookie: await signSessionCookie(token, authTestSecret),
    };
  };

  const as = async (
    who: Person,
    path: string,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      ifMatch?: number;
    } = {},
  ) => {
    const method = options.method ?? "GET";
    const headers = new Headers({
      cookie: who.cookie,
      "Bakery-Organization-Id": f.organizationId,
    });
    if (method === "POST") {
      headers.set("origin", authTestOrigin);
      headers.set("content-type", "application/json");
      headers.set("idempotency-key", crypto.randomUUID());
      if (options.ifMatch !== undefined) {
        headers.set("if-match", `"${options.ifMatch}"`);
      }
    }
    return await f.app.fetch(
      new Request(`${authTestOrigin}${path}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(options.body) } : {}),
      }),
    );
  };
  const json = async <T>(response: Response, status: number): Promise<T> => {
    const text = await response.text();
    assertEquals(response.status, status, text);
    return JSON.parse(text) as T;
  };
  const assertDenied = (code: number) =>
    assert(code === 403 || code === 404, `denied, got ${code}`);
  const status = async (response: Response): Promise<number> => {
    await response.body?.cancel();
    return response.status;
  };

  try {
    // The fixture's own developer wrote the first version: the author.
    const writer: Person = {
      principalId: f.principalId,
      email: "",
      cookie: await (async () => {
        const row = await db.query<{ token: string }>(
          `select s.token from public.session as s
             join bakery.principals as p on p.provider_user_id = s."userId"
            where p.id = $1`,
          [f.principalId],
        );
        return await signSessionCookie(row.rows[0]!.token, authTestSecret);
      })(),
    };
    const dev2 = await person("Dee Dev", "developer");
    // A member whose role holds nothing on documents: a guest with a custom
    // role that only reads conversations.
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
    const ana = await person("Ana Chat", "guest", roleId);
    const cy = await person("Cy Chat", "guest", roleId);
    const guest = await person("Gus Guest", "guest");
    const artifact = f.artifactId;
    const version = f.versionId;
    // The shared comment fixture names its artifact type "document", which the
    // Artifact contract does not list; a plan reads back cleanly.
    await db.query(
      "update bakery.artifacts set artifact_type = 'plan' where id = $1",
      [artifact],
    );

    await t.step(
      "a viewer cannot read the document before access",
      async () => {
        assertDenied(
          await status(await as(ana, `/v1/artifacts/${artifact}`)),
        );
        assertDenied(
          await status(
            await as(ana, `/v1/artifact-versions/${version}/comments?limit=5`),
          ),
        );
      },
    );

    await t.step(
      "sharers lists the author first, then others who may share",
      async () => {
        const page = await json<{
          items: { principalId: string; displayName: string }[];
        }>(await as(writer, `/v1/artifacts/${artifact}/access/sharers`), 200);
        assertEquals(page.items.map((item) => item.principalId), [
          writer.principalId,
          dev2.principalId,
        ]);
      },
    );

    let grant!: Grant;
    await t.step(
      "grant needs sharing authority and is idempotent",
      async () => {
        assertDenied(
          await status(
            await as(ana, `/v1/artifacts/${artifact}/access`, {
              method: "POST",
              body: { principalId: cy.principalId },
            }),
          ),
        );
        assertEquals(
          await status(
            await as(writer, `/v1/artifacts/${artifact}/access`, {
              method: "POST",
              body: { principalId: guest.principalId },
            }),
          ),
          422,
        );
        // Someone whose role already reads and comments has nothing to be given.
        const redundant = await as(writer, `/v1/artifacts/${artifact}/access`, {
          method: "POST",
          body: { principalId: dev2.principalId },
        });
        const redundantText = await redundant.text();
        assertEquals(redundant.status, 422, redundantText);
        assert(redundantText.includes("already_has_access"), redundantText);
        grant = await json<Grant>(
          await as(writer, `/v1/artifacts/${artifact}/access`, {
            method: "POST",
            body: { principalId: ana.principalId },
          }),
          200,
        );
        assertEquals(grant.level, "read_comment");
        assertEquals(grant.version, 1);
        const again = await json<Grant>(
          await as(writer, `/v1/artifacts/${artifact}/access`, {
            method: "POST",
            body: { principalId: ana.principalId },
          }),
          200,
        );
        assertEquals([again.id, again.version], [grant.id, 1]);
        grant = again;
        assertEquals([grant.level, grant.version], ["read_comment", 1]);
      },
    );

    await t.step(
      "the grant opens the document and its comments only",
      async () => {
        const taskTitle = `Task only its team may name ${crypto.randomUUID()}`;
        await db.query("update bakery.tasks set title = $1 where id = $2", [
          taskTitle,
          f.taskId,
        ]);
        const read = await as(ana, `/v1/artifacts/${artifact}`);
        const opened = await json<{ taskTitle?: string }>(read.clone(), 200);
        assertEquals(opened.taskTitle, undefined);
        const byTaskReader = await json<{ taskTitle?: string }>(
          await as(writer, `/v1/artifacts/${artifact}`),
          200,
        );
        assertEquals(byTaskReader.taskTitle, taskTitle);
        assert(!JSON.stringify(opened).includes(taskTitle));
        const versions = await json<
          { items: { authorId: string; authorName?: string | null }[] }
        >(
          await as(ana, `/v1/artifacts/${artifact}/versions?limit=5`),
          200,
        );
        const publishers =
          (await db.query<{ id: string; display_name: string }>(
            "select id, display_name from bakery.principals where id = any($1)",
            [versions.items.map((item) => item.authorId)],
          )).rows;
        for (const item of versions.items) {
          assertEquals(
            item.authorName,
            publishers.find((p: { id: string }) => p.id === item.authorId)
              ?.display_name,
          );
        }
        assertEquals(read.status, 200, await read.text());
        assertEquals(
          await status(
            await as(ana, `/v1/artifacts/${artifact}/versions?limit=5`),
          ),
          200,
        );
        assertEquals(
          await status(
            await as(ana, `/v1/artifact-versions/${version}/comments?limit=5`),
          ),
          200,
        );
        const posted = await as(
          ana,
          `/v1/artifact-versions/${version}/comments`,
          { method: "POST", body: { body: "Looks right to me." } },
        );
        assertEquals(posted.status, 201, await posted.text());
        const listed = await json<
          { items: { authorId: string; authorName?: string | null }[] }
        >(
          await as(ana, `/v1/artifact-versions/${version}/comments?limit=50`),
          200,
        );
        const names = (await db.query<{ id: string; display_name: string }>(
          "select id, display_name from bakery.principals where id = any($1)",
          [listed.items.map((item) => item.authorId)],
        )).rows;
        assert(listed.items.length > 0);
        for (const item of listed.items) {
          assertEquals(
            item.authorName,
            names.find((n: { id: string }) => n.id === item.authorId)
              ?.display_name,
          );
        }
        const outsider = await person("Zed", "member");
        for (
          const path of [
            `/v1/artifacts/${artifact}`,
            `/v1/artifacts/${artifact}/versions?limit=50`,
            `/v1/artifact-versions/${version}/comments?limit=50`,
          ]
        ) {
          const text = await (await as(ana, path)).text();
          assert(!text.includes(outsider.principalId), path);
          assert(!text.includes(`Zed ${tag}`), path);
        }
        // Not the task, not publishing, not resharing, not the grant list's writes.
        assertDenied(await status(await as(ana, `/v1/tasks/${f.taskId}`)));
        // The editor is closed at read_comment and open at edit: opening a draft
        // gets past authority (this fixture has no draft isolation, so it then
        // answers 503), and revoking the access closes it again.
        const openDraft = () =>
          as(ana, `/v1/artifacts/${artifact}/drafts`, {
            method: "POST",
            body: {},
          });
        assertDenied(await status(await openDraft()));
        await json<Grant>(
          await as(writer, `/v1/artifacts/${artifact}/access`, {
            method: "POST",
            body: { principalId: ana.principalId, level: "edit" },
          }),
          200,
        );
        const editing = await status(await openDraft());
        assert(
          editing !== 403 && editing !== 404 && editing !== 405,
          `edit level reaches the editor, got ${editing}`,
        );
        grant = await json<Grant>(
          await as(writer, `/v1/artifacts/${artifact}/access`, {
            method: "POST",
            body: { principalId: ana.principalId, level: "read_comment" },
          }),
          200,
        );
        assertEquals([grant.level], ["read_comment"]);
        assertDenied(await status(await openDraft()));
        assertDenied(
          await status(
            await as(ana, `/v1/artifacts/${artifact}/access`, {
              method: "POST",
              body: { principalId: cy.principalId },
            }),
          ),
        );
        const list = await json<{ items: Grant[] }>(
          await as(ana, `/v1/artifacts/${artifact}/access`),
          200,
        );
        assertEquals(list.items.map((item) => item.principalId), [
          ana.principalId,
        ]);
      },
    );

    await t.step(
      "the collaboration socket's check follows the grant, by draft and level",
      async () => {
        // The editor check above may already have opened this document's one
        // draft; take it, or make it.
        await db.query(
          `insert into bakery.artifact_drafts
             (organization_id, artifact_id, task_id, epoch, status)
           values ($1, $2, $3, 1, 'active')
           on conflict (organization_id, artifact_id) do nothing`,
          [f.organizationId, artifact, f.taskId],
        );
        const draftId = (await db.query<{ id: string }>(
          "select id from bakery.artifact_drafts where organization_id = $1 and artifact_id = $2",
          [f.organizationId, artifact],
        )).rows[0]!.id;
        const allowed = async (
          who: Person,
          id: string | null,
          permission: "draft:read" | "draft:write",
        ) =>
          await withPgTransaction(db, async (transaction) => {
            const actor = await resolveOrganizationActor(
              transaction,
              who.principalId as never,
              f.organizationId as never,
            );
            try {
              await authorizeDraftAccess(transaction, actor, permission, {
                action: "drafts.edit",
              }, id);
              return true;
            } catch {
              return false;
            }
          });
        // Ana holds read_comment: the editor stays closed, for a room and to connect.
        assertEquals(await allowed(ana, draftId, "draft:read"), false);
        assertEquals(await allowed(ana, null, "draft:read"), false);
        await json<Grant>(
          await as(writer, `/v1/artifacts/${artifact}/access`, {
            method: "POST",
            body: { principalId: ana.principalId, level: "edit" },
          }),
          200,
        );
        assertEquals(await allowed(ana, draftId, "draft:read"), true);
        assertEquals(await allowed(ana, draftId, "draft:write"), true);
        assertEquals(await allowed(ana, null, "draft:read"), true);
        // Another draft, and someone with no grant, are refused.
        assertEquals(
          await allowed(ana, crypto.randomUUID(), "draft:write"),
          false,
        );
        assertEquals(await allowed(cy, draftId, "draft:write"), false);
        assertEquals(await allowed(cy, null, "draft:read"), false);
        await json<Grant>(
          await as(writer, `/v1/artifacts/${artifact}/access`, {
            method: "POST",
            body: { principalId: ana.principalId, level: "read_comment" },
          }),
          200,
        );
        assertEquals(await allowed(ana, draftId, "draft:write"), false);
        await db.query("delete from bakery.artifact_drafts where id = $1", [
          draftId,
        ]);
      },
    );

    await t.step(
      "a mention gives access only when the writer asks and may share",
      async () => {
        const candidates = await json<{
          items: {
            principalId: string;
            hasAccess: boolean;
            gainsAccessOnSend: boolean;
          }[];
        }>(
          await as(
            writer,
            `/v1/artifact-versions/${version}/mention-candidates?query=${tag}&limit=25`,
          ),
          200,
        );
        const cyRow = candidates.items.find((row) =>
          row.principalId === cy.principalId
        );
        assertEquals(
          [cyRow?.hasAccess, cyRow?.gainsAccessOnSend],
          [false, true],
        );
        const anaRow = candidates.items.find((row) =>
          row.principalId === ana.principalId
        );
        assertEquals([anaRow?.hasAccess], [true]);

        const refused = await as(
          writer,
          `/v1/artifact-versions/${version}/comments`,
          {
            method: "POST",
            body: { body: "Cy, please look", mentions: [cy.principalId] },
          },
        );
        assertEquals(refused.status, 422, await refused.text());
        // A grantee may mention, but cannot give access to someone new.
        const forbidden = await as(
          ana,
          `/v1/artifact-versions/${version}/comments`,
          {
            method: "POST",
            body: {
              body: "Cy, please look",
              mentions: [cy.principalId],
              accessLevel: "read_comment",
            },
          },
        );
        const forbiddenText = await forbidden.text();
        assertEquals(forbidden.status, 422, forbiddenText);
        assert(
          forbiddenText.includes("mention_share_forbidden"),
          forbiddenText,
        );
        const none = await db.query<{ count: number }>(
          `select count(*)::int as count from bakery.artifact_access_grants
          where organization_id = $1 and principal_id = $2`,
          [f.organizationId, cy.principalId],
        );
        assertEquals(none.rows[0]?.count, 0);

        const posted = await json<{ id: string }>(
          await as(
            writer,
            `/v1/artifact-versions/${version}/comments`,
            {
              method: "POST",
              body: {
                body: "Cy, please look",
                mentions: [cy.principalId],
                accessLevel: "read_comment",
              },
            },
          ),
          201,
        );
        const given = await json<{ items: Grant[] }>(
          await as(writer, `/v1/artifacts/${artifact}/access`),
          200,
        );
        const cyGrant = given.items.find((item) =>
          item.principalId === cy.principalId
        );
        assert(cyGrant, "the mention gave Cy a grant");
        // The comment that gave the access is the grant's source.
        assertEquals(cyGrant.sourceCommentId, posted.id);
        // Changing the level by hand keeps that source, so Cy stays "added by a
        // mention" in People added, which lists and counts by it (#870).
        const regrant = (level: string) =>
          as(writer, `/v1/artifacts/${artifact}/access`, {
            method: "POST",
            body: { principalId: cy.principalId, level },
          });
        const raised = await json<Grant>(await regrant("edit"), 200);
        assertEquals([raised.level, raised.sourceCommentId], [
          "edit",
          posted.id,
        ]);
        const lowered = await json<Grant>(await regrant("read_comment"), 200);
        assertEquals([lowered.level, lowered.sourceCommentId], [
          "read_comment",
          posted.id,
        ]);
        const relisted = await json<{ items: Grant[] }>(
          await as(writer, `/v1/artifacts/${artifact}/access`),
          200,
        );
        assertEquals(
          relisted.items.find((item) => item.principalId === cy.principalId)
            ?.sourceCommentId,
          posted.id,
        );
        // The inbox item opens the document at the comment, not the task page.
        const inbox = await json<{
          items: { id: string; kind: string }[];
        }>(await as(cy, "/v1/notifications"), 200);
        const item = inbox.items.find((row) => row.kind === "comment_mention");
        assert(item, "Cy has a comment mention in the inbox");
        const target = await json<
          {
            status: string;
            targetKind: string;
            path: string;
            anchor: string | null;
            sharedByName?: string;
            sharedAt?: string;
          }
        >(await as(cy, `/v1/notifications/${item.id}/target`), 200);
        const { sharedAt, ...route } = target;
        assert(sharedAt !== undefined, "the target says when it was shared");
        assertEquals(route, {
          status: "available",
          targetKind: "comment",
          path:
            `/shared/documents/${artifact}?version=${version}&comment=${posted.id}`,
          anchor: `comment:${posted.id}`,
          sharedByName: "Comments",
        });
        // A plain comment notification for the same person and document is not a
        // mention: it must survive the Undo.
        const someEvent = (await db.query<{ id: string }>(
          "select id from bakery.domain_events where organization_id = $1 limit 1",
          [f.organizationId],
        )).rows[0]!.id;
        await db.query(
          `insert into bakery.notifications
           (organization_id, recipient_id, kind, target_kind, target_id,
            source_event_id, source_version)
         values ($1, $2, 'comment', 'comment', $3, $4, 2)`,
          [f.organizationId, cy.principalId, posted.id, someEvent],
        );
        // Undo: revoking withdraws the unread mention and ends the access.
        const stale = await as(
          writer,
          `/v1/artifacts/${artifact}/access/revoke`,
          {
            method: "POST",
            ifMatch: lowered.version + 1,
            body: { principalId: cy.principalId },
          },
        );
        assertEquals(await status(stale), 412);
        const revoked = await json<Grant>(
          await as(writer, `/v1/artifacts/${artifact}/access/revoke`, {
            method: "POST",
            ifMatch: lowered.version,
            body: { principalId: cy.principalId },
          }),
          200,
        );
        assert(revoked.revokedAt !== null);
        const after = await json<{ items: { id: string; kind: string }[] }>(
          await as(cy, "/v1/notifications"),
          200,
        );
        assertEquals(after.items.map((row) => row.kind), ["comment"]);
        assertDenied(
          await status(await as(cy, `/v1/artifacts/${artifact}`)),
        );
        // Granting again by hand after the revoke starts fresh: no comment gave
        // this access, so Cy is not "added by a mention" any more.
        const again = await json<Grant>(await regrant("read_comment"), 200);
        assertEquals([again.sourceCommentId, again.revokedAt], [null, null]);
        const ended = await json<Grant>(
          await as(writer, `/v1/artifacts/${artifact}/access/revoke`, {
            method: "POST",
            ifMatch: again.version,
            body: { principalId: cy.principalId },
          }),
          200,
        );
        assert(ended.revokedAt !== null);
        assertDenied(
          await status(await as(cy, `/v1/artifacts/${artifact}`)),
        );
      },
    );

    await t.step(
      "a grantee whose role holds artifact:share still cannot reshare",
      async () => {
        // The role alone would allow sharing; a person acting on a grant never may.
        const sharerRole = crypto.randomUUID();
        await db.query(
          `insert into bakery.organization_roles
             (id, organization_id, key, name, permissions, created_by_principal_id)
           values ($1, $2, 'sharer-only', 'Sharer only', $3::text[], $4)`,
          [
            sharerRole,
            f.organizationId,
            ["artifact:share", "notification:read"],
            f.principalId,
          ],
        );
        const dan = await person("Dan Share", "guest", sharerRole);
        const eve = await person("Eve Chat", "guest", roleId);
        await json<Grant>(
          await as(writer, `/v1/artifacts/${artifact}/access`, {
            method: "POST",
            body: { principalId: dan.principalId },
          }),
          200,
        );
        const refused = await as(
          dan,
          `/v1/artifact-versions/${version}/comments`,
          {
            method: "POST",
            body: {
              body: "Eve, please look",
              mentions: [eve.principalId],
              accessLevel: "read_comment",
            },
          },
        );
        const refusedText = await refused.text();
        assertEquals(refused.status, 422, refusedText);
        assert(refusedText.includes("mention_share_forbidden"), refusedText);
        const none = await db.query<{ count: number }>(
          `select count(*)::int as count from bakery.artifact_access_grants
            where organization_id = $1 and principal_id = $2`,
          [f.organizationId, eve.principalId],
        );
        assertEquals(none.rows[0]?.count, 0);
      },
    );
  } finally {
    await db.query(
      "delete from bakery.artifact_access_grants where organization_id = $1",
      [f.organizationId],
    );
    await db.query(
      "delete from bakery.notifications where organization_id = $1",
      [f.organizationId],
    );
    await db.query(
      "delete from bakery.artifact_comment_mentions where organization_id = $1",
      [f.organizationId],
    );
    await db.query(
      "delete from bakery.artifact_comments where organization_id = $1",
      [f.organizationId],
    );
    await cleanupAuthFixture(db, emails);
    await db.query(
      "delete from bakery.organization_roles where organization_id = $1",
      [f.organizationId],
    );
    await f.cleanup();
  }
});
