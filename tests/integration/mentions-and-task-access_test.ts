import { assert, assertEquals } from "@std/assert";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { createConversationRegistry } from "../../apps/server/src/modules/conversation/index.ts";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";

/**
 * #73: mentions that share one conversation and per-conversation access,
 * through the real routes, the real authority runner and real Postgres. The
 * inbox signal and mark-all-read undo are main's, proven in
 * notification-inbox-signal-and-undo_test.ts.
 */

type Fixture = Awaited<ReturnType<typeof openAuthFixture>>;
type Candidate = {
  principalId: string;
  displayName: string;
  hasAccess: boolean;
  gainsAccessOnSend: boolean;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type Person = { principalId: string; userId: string | null; cookie: string };

async function call(
  fixture: Fixture,
  cookie: string,
  organizationId: string,
  path: string,
  options: {
    method?: "GET" | "POST";
    key?: string;
    ifMatch?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers({
    cookie,
    "Bakery-Organization-Id": organizationId,
  });
  if (method === "POST") {
    headers.set("origin", authTestOrigin);
    headers.set("content-type", "application/json");
    headers.set("Idempotency-Key", options.key ?? crypto.randomUUID());
  }
  if (options.ifMatch) headers.set("If-Match", options.ifMatch);
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as T;
}

async function count(
  fixture: Fixture,
  sql: string,
  values: unknown[],
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ count: number }>(
    `select count(*)::int as count ${sql}`,
    values,
  );
  return result.rows[0]?.count ?? 0;
}

Deno.test("mentions share one conversation atomically and only with authority", async (t) => {
  const fixture = await openAuthFixture();
  const appPg = openPgDatabase(readTestDatabaseConfig().appDatabaseUrl);
  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  const now = new Date();
  const users: string[] = [];
  const principals: string[] = [];
  const tag = crypto.randomUUID().slice(0, 8);

  const human = async (
    name: string,
    memberships: { org: string; role: string; status?: string }[],
    options: { disabled?: boolean } = {},
  ): Promise<Person> => {
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    users.push(userId);
    principals.push(principalId);
    await fixture.pgDatabase.query(
      `insert into public."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       ) values ($1, $2, $3, true, $4, $4)`,
      [
        userId,
        name,
        `${name.toLowerCase().replaceAll(" ", ".")}-${tag}@example.test`,
        now,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
         id, provider_user_id, display_name, principal_type, disabled_at
       ) values ($1, $2, $3, 'human', $4)`,
      [principalId, userId, `${name} ${tag}`, options.disabled ? now : null],
    );
    for (const membership of memberships) {
      await fixture.pgDatabase.query(
        `insert into bakery.organization_memberships (
           id, organization_id, principal_id, role, status, joined_at,
           created_at, updated_at, version
         ) values ($1, $2, $3, $4, $5, $6, $6, $6, 1)`,
        [
          crypto.randomUUID(),
          membership.org,
          principalId,
          membership.role,
          membership.status ?? "active",
          now,
        ],
      );
    }
    const token = `mention-${crypto.randomUUID()}`;
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
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
      userId,
      cookie: await signSessionCookie(token, fixture.config.auth!.secret),
    };
  };

  let cleanupError: unknown;
  try {
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
         id, name, slug, metadata, created_at, updated_at, version
       ) values ($1, 'Mention Org', $2, '{}'::jsonb, $3, $3, 1),
                ($4, 'Other Mention Org', $5, '{}'::jsonb, $3, $3, 1)`,
      [orgA, `mention-${orgA}`, now, orgB, `mention-${orgB}`],
    );
    const writer = await human("Wren Writer", [{
      org: orgA,
      role: "developer",
    }]);
    const dev = await human("Dana Dev", [{ org: orgA, role: "developer" }]);
    const viewer = await human("Vic Viewer", [{ org: orgA, role: "viewer" }]);
    const viewer2 = await human("Val Viewer", [{ org: orgA, role: "viewer" }]);
    const disabled = await human("Dis Abled", [{
      org: orgA,
      role: "developer",
    }], {
      disabled: true,
    });
    const removed = await human("Rem Oved", [
      { org: orgA, role: "developer", status: "inactive" },
    ]);
    const outsider = await human("Otto Outsider", [{
      org: orgB,
      role: "admin",
    }]);

    const conversation = crypto.randomUUID();
    const foreignConversation = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.conversations (id, organization_id, title, created_by)
       values ($1, $2, 'Repository onboarding', $3),
              ($4, $5, 'Foreign chat', $6)`,
      [
        conversation,
        orgA,
        writer.principalId,
        foreignConversation,
        orgB,
        outsider.principalId,
      ],
    );
    const service = crypto.randomUUID();
    principals.push(service);
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id, display_name, principal_type)
       values ($1, 'Agent Writer', 'service')`,
      [service],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at,
         created_at, updated_at, version
       ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
      [crypto.randomUUID(), orgA, service, now],
    );

    const messages = () =>
      count(fixture, "from bakery.messages where conversation_id = $1", [
        conversation,
      ]);
    const send = (
      who: Person,
      body: Record<string, unknown>,
      key?: string,
    ) =>
      call(
        fixture,
        who.cookie,
        orgA,
        `/v1/conversations/${conversation}/messages`,
        {
          method: "POST",
          ...(key ? { key } : {}),
          body: {
            body: "hello",
            clientMessageId: crypto.randomUUID(),
            intent: "discussion",
            ...body,
          },
        },
      );

    await t.step(
      "sharers names up to three people who may share, the author first",
      async () => {
        const page = await json<{
          items: { principalId: string; displayName: string }[];
        }>(
          await call(
            fixture,
            viewer.cookie,
            orgA,
            `/v1/conversations/${conversation}/access/sharers`,
          ),
          200,
        );
        // Wren wrote the conversation, so leads; Dana also holds the share
        // right. Viewers, a disabled account, a removed member, an agent and
        // another organization's admin never appear.
        assertEquals(page.items.map((item) => item.principalId), [
          writer.principalId,
          dev.principalId,
        ]);
        assertEquals(
          page.items.map((item) => Object.keys(item).sort()),
          [["displayName", "principalId"], ["displayName", "principalId"]],
        );
        const foreign = await call(
          fixture,
          writer.cookie,
          orgA,
          `/v1/conversations/${foreignConversation}/access/sharers`,
        );
        assertEquals(foreign.status, 404);
        await foreign.body?.cancel();
      },
    );

    await t.step(
      "search shows only visible members, marked by access",
      async () => {
        const all: Candidate[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const query: string = `?limit=2&query=${tag}${
            cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
          }`;
          const page: Page<Candidate> = await json<Page<Candidate>>(
            await call(
              fixture,
              writer.cookie,
              orgA,
              `/v1/conversations/${conversation}/mention-candidates${query}`,
            ),
            200,
          );
          all.push(...page.items);
          cursor = page.nextCursor;
          pages++;
        } while (cursor && pages < 10);
        assert(pages >= 2, "keyset pages through the result");
        const ids = all.map((item) => item.principalId);
        assertEquals(
          new Set(ids).size,
          ids.length,
          "no row repeats across pages",
        );
        assertEquals(
          new Set(ids),
          new Set([
            writer.principalId,
            dev.principalId,
            viewer.principalId,
            viewer2.principalId,
          ]),
          "no disabled, removed or other-organization person",
        );
        const byId = new Map(all.map((item) => [item.principalId, item]));
        assertEquals(byId.get(dev.principalId)?.hasAccess, true);
        assertEquals(byId.get(viewer.principalId)?.hasAccess, false);
        assertEquals(byId.get(viewer.principalId)?.gainsAccessOnSend, true);
        for (const item of all) {
          assertEquals(Object.keys(item).sort(), [
            "displayName",
            "gainsAccessOnSend",
            "hasAccess",
            "principalId",
          ]);
          assert(!JSON.stringify(item).includes("@example.test"));
        }
        // Email matches, but is never returned.
        const byEmail = await json<Page<Candidate>>(
          await call(
            fixture,
            writer.cookie,
            orgA,
            `/v1/conversations/${conversation}/mention-candidates?query=vic.viewer-${tag}`,
          ),
          200,
        );
        assertEquals(byEmail.items.map((item) => item.principalId), [
          viewer.principalId,
        ]);
        // Cross-organization: another org's conversation is not found, and an
        // outsider cannot search this one.
        assertEquals(
          (await call(
            fixture,
            writer.cookie,
            orgA,
            `/v1/conversations/${foreignConversation}/mention-candidates`,
          )).status,
          404,
        );
        assertEquals(
          (await call(
            fixture,
            outsider.cookie,
            orgA,
            `/v1/conversations/${conversation}/mention-candidates`,
          )).status,
          404,
        );
        // A viewer can search but cannot share: nobody gains access through them.
        const asViewer = await json<Page<Candidate>>(
          await call(
            fixture,
            viewer2.cookie,
            orgA,
            `/v1/conversations/${conversation}/mention-candidates?query=${tag}&limit=25`,
          ),
          200,
        );
        assert(asViewer.items.every((item) => !item.gainsAccessOnSend));
        void disabled;
        void removed;
      },
    );

    let mentionMessageId = "";
    await t.step(
      "a mention send grants, references and notifies in one transaction",
      async () => {
        assertEquals(
          (await send(viewer, {})).status,
          403,
          "viewer cannot reply yet",
        );
        const clientMessageId = crypto.randomUUID();
        const body = {
          body: "@Vic @Dana please look",
          clientMessageId,
          mentions: [
            viewer.principalId,
            dev.principalId,
            writer.principalId,
            viewer.principalId,
          ],
        };
        const created = await json<{ id: string; sequence: string }>(
          await send(writer, body, "mention-send-1"),
          201,
        );
        mentionMessageId = created.id;
        assertEquals(
          await count(
            fixture,
            "from bakery.message_mentions where message_id = $1",
            [created.id],
          ),
          3,
          "distinct references, self included",
        );
        const grants = await fixture.pgDatabase.query<
          { principal_id: string; granted_by: string }
        >(
          `select principal_id, granted_by from bakery.conversation_access_grants
         where conversation_id = $1 and revoked_at is null`,
          [conversation],
        );
        assertEquals(grants.rows, [{
          principal_id: viewer.principalId,
          granted_by: writer.principalId,
        }]);
        const notified = await fixture.pgDatabase.query<
          { recipient_id: string; kind: string; target_id: string }
        >(
          `select recipient_id, kind, target_id from bakery.notifications
         where organization_id = $1 order by recipient_id`,
          [orgA],
        );
        assertEquals(
          new Set(notified.rows.map((row) => row.recipient_id)),
          new Set([viewer.principalId, dev.principalId]),
          "one item per distinct non-self recipient",
        );
        assert(
          notified.rows.every((row) =>
            row.kind === "mention" && row.target_id === created.id
          ),
        );
        const signals = await fixture.pgDatabase.query<
          { recipient_id: string; payload: Record<string, unknown> }
        >(
          `select recipient_id, payload from bakery.domain_events
         where organization_id = $1 and event_type = 'notifications.inbox_changed'`,
          [orgA],
        );
        assertEquals(
          new Set(signals.rows.map((row) => row.recipient_id)),
          new Set([viewer.principalId, dev.principalId]),
        );
        for (const row of signals.rows) {
          assertEquals(Object.keys(row.payload).sort(), [
            "resourceId",
            "resourceVersion",
          ], "no content");
        }
        // A replay creates nothing new.
        const before = await count(
          fixture,
          "from bakery.notifications where organization_id = $1",
          [orgA],
        );
        const replay = await send(writer, body, "mention-send-2");
        assertEquals((await json<{ id: string }>(replay, 201)).id, created.id);
        assertEquals(
          await count(
            fixture,
            "from bakery.notifications where organization_id = $1",
            [orgA],
          ),
          before,
        );
        assertEquals(
          await count(
            fixture,
            "from bakery.conversation_access_grants where conversation_id = $1",
            [conversation],
          ),
          1,
        );
        // The grant opens read and reply, and nothing more.
        assertEquals(
          (await send(viewer, {})).status,
          201,
          "viewer can reply now",
        );
        assertEquals(
          (await send(viewer, { intent: "agent_request" })).status,
          403,
          "no agent execution",
        );
        assertEquals(
          (await call(
            fixture,
            viewer.cookie,
            orgA,
            `/v1/conversations/${conversation}/access/${viewer.principalId}/revoke`,
            {
              method: "POST",
              ifMatch: '"1"',
              body: {},
            },
          )).status,
          403,
          "a mention-only recipient cannot manage access",
        );
      },
    );

    await t.step(
      "a refused mention writes nothing, not even the message",
      async () => {
        const startMessages = await messages();
        const startNotifications = await count(
          fixture,
          "from bakery.notifications where organization_id = $1",
          [orgA],
        );
        const outside = await send(writer, {
          mentions: [dev.principalId, outsider.principalId],
        });
        const problem = await json<
          { code: string; issues: { path: unknown[]; code: string }[] }
        >(outside, 422);
        assertEquals(problem.code, "UNPROCESSABLE");
        assertEquals(problem.issues.map((issue) => [issue.path, issue.code]), [[
          ["mentions", 1],
          "mention_not_member",
        ]]);
        const gone = await send(writer, {
          mentions: [disabled.principalId, removed.principalId],
        });
        assertEquals(
          (await json<{ issues: { code: string }[] }>(gone, 422)).issues.map((
            issue,
          ) => issue.code),
          [
            "mention_not_member",
            "mention_not_member",
          ],
        );
        // The mention-only recipient cannot bring in someone new.
        const reshare = await send(viewer, { mentions: [viewer2.principalId] });
        assertEquals(
          (await json<{ issues: { code: string }[] }>(reshare, 422)).issues[0]
            ?.code,
          "mention_share_forbidden",
        );
        assertEquals(await messages(), startMessages);
        assertEquals(
          await count(
            fixture,
            "from bakery.notifications where organization_id = $1",
            [orgA],
          ),
          startNotifications,
        );
        assertEquals(
          await count(
            fixture,
            "from bakery.conversation_access_grants where principal_id = $1",
            [viewer2.principalId],
          ),
          0,
        );
      },
    );

    await t.step(
      "an agent writer can notify people with access but cannot share",
      async () => {
        const registry = createConversationRegistry({
          database: appPg,
          cursorSecret: "mention-agent-cursor-secret",
        });
        const agentApp = createApiRouter({
          registry,
          createContext: () =>
            ({
              principal: {
                principalId: service,
                principalType: "service",
                displayName: "Agent Writer",
              },
            }) as never,
        });
        const post = (mentions: string[]) =>
          agentApp.fetch(
            new Request(
              `${authTestOrigin}/v1/conversations/${conversation}/messages`,
              {
                method: "POST",
                headers: {
                  "Bakery-Organization-Id": orgA,
                  "content-type": "application/json",
                  "Idempotency-Key": crypto.randomUUID(),
                },
                body: JSON.stringify({
                  body: "from the agent",
                  clientMessageId: crypto.randomUUID(),
                  intent: "discussion",
                  mentions,
                }),
              },
            ),
          );
        const startMessages = await messages();
        const widen = await post([viewer2.principalId]);
        assertEquals(
          (await json<{ issues: { code: string }[] }>(widen, 422)).issues[0]
            ?.code,
          "mention_share_forbidden",
        );
        assertEquals(await messages(), startMessages);
        const devItems = () =>
          count(fixture, "from bakery.notifications where recipient_id = $1", [
            dev.principalId,
          ]);
        const before = await devItems();
        const notify = await post([dev.principalId]);
        assertEquals(notify.status, 201, await notify.clone().text());
        assertEquals(await devItems(), before + 1);
      },
    );

    await t.step(
      "per-conversation access lists and revokes under CAS with audit",
      async () => {
        const listed = await json<
          Page<
            {
              principalId: string;
              version: number;
              grantedById: string;
              sourceMessageId: string;
            }
          >
        >(
          await call(
            fixture,
            writer.cookie,
            orgA,
            `/v1/conversations/${conversation}/access`,
          ),
          200,
        );
        assertEquals(
          listed.items.map((
            item,
          ) => [item.principalId, item.grantedById, item.sourceMessageId]),
          [
            [viewer.principalId, writer.principalId, mentionMessageId],
          ],
        );
        const version = listed.items[0]!.version;
        const path =
          `/v1/conversations/${conversation}/access/${viewer.principalId}/revoke`;
        assertEquals(
          (await call(fixture, writer.cookie, orgA, path, {
            method: "POST",
            ifMatch: `"${version + 5}"`,
            body: {},
          })).status,
          412,
          "stale version",
        );
        const revoked = await json<
          { revokedAt: string | null; version: number }
        >(
          await call(fixture, writer.cookie, orgA, path, {
            method: "POST",
            ifMatch: `"${version}"`,
            body: {},
          }),
          200,
        );
        assert(revoked.revokedAt !== null);
        assertEquals(revoked.version, version + 1);
        assertEquals(
          (await send(viewer, {})).status,
          403,
          "revocation takes effect on the next request",
        );
        assertEquals(
          await count(
            fixture,
            "from bakery.audit_events where organization_id = $1 and operation = 'conversationAccess.revoke'",
            [orgA],
          ),
          1,
        );
        assertEquals(
          await count(
            fixture,
            "from bakery.domain_events where organization_id = $1 and event_type = 'conversations.access_changed'",
            [orgA],
          ),
          2,
          "granted then revoked",
        );
        // Another organization's conversation is not found for this writer.
        assertEquals(
          (await call(
            fixture,
            writer.cookie,
            orgA,
            `/v1/conversations/${foreignConversation}/access`,
          )).status,
          404,
        );
        // Removing a grant never removes inherited access.
        assertEquals((await send(dev, {})).status, 201);
      },
    );

    await t.step(
      "sharers stops at three, and a guest whose custom role cannot read still gets it through a grant",
      async () => {
        const path = (id: string) => `/v1/conversations/${id}/access/sharers`;
        for (const n of ["Ann Extra", "Bob Extra", "Cy Extra", "Di Extra"]) {
          await human(n, [{ org: orgA, role: "developer" }]);
        }
        const page = await json<
          { items: { principalId: string; displayName: string }[] }
        >(
          await call(fixture, writer.cookie, orgA, path(conversation)),
          200,
        );
        assertEquals(page.items.length, 3, "cap of three");
        assertEquals(
          page.items[0].principalId,
          writer.principalId,
          "author first",
        );
        assert(
          !page.items.some((i) => i.principalId === outsider.principalId),
          "no foreign org person",
        );
        const guest = await human("Gus Guest", [{ org: orgA, role: "guest" }]);
        const roleId = crypto.randomUUID();
        await fixture.pgDatabase.query(
          `insert into bakery.organization_roles (id, organization_id, key, name, permissions, created_by_principal_id) values ($1, $2, 'files-only', 'Files only', $3, $4)`,
          [roleId, orgA, ["artifact:read"], writer.principalId],
        );
        await fixture.pgDatabase.query(
          `update bakery.organization_memberships set custom_role_id = $3 where organization_id = $1 and principal_id = $2`,
          [orgA, guest.principalId, roleId],
        );
        const before = await call(
          fixture,
          guest.cookie,
          orgA,
          path(conversation),
        );
        assert(
          [403, 404].includes(before.status),
          "guest without grant: " + before.status,
        );
        await before.body?.cancel();
        await fixture.pgDatabase.query(
          `insert into bakery.conversation_access_grants (organization_id, conversation_id, principal_id, granted_by) values ($1, $2, $3, $4)`,
          [orgA, conversation, guest.principalId, writer.principalId],
        );
        const granted = await json<{ items: { principalId: string }[] }>(
          await call(fixture, guest.cookie, orgA, path(conversation)),
          200,
        );
        assertEquals(
          granted.items.length,
          3,
          "grant-only guest gets the answer",
        );
        const other = crypto.randomUUID();
        await fixture.pgDatabase.query(
          `insert into bakery.conversations (id, organization_id, title, created_by) values ($1, $2, 'Other chat', $3)`,
          [other, orgA, writer.principalId],
        );
        const elsewhere = await call(fixture, guest.cookie, orgA, path(other));
        assert(
          [403, 404].includes(elsewhere.status),
          "grant is for one conversation only: " + elsewhere.status,
        );
        await elsewhere.body?.cancel();
      },
    );
  } finally {
    try {
      await fixture.pgDatabase.query(
        `delete from public.session where "userId" = any($1::uuid[])`,
        [users],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.organizations where id = any($1::uuid[])`,
        [[orgA, orgB]],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.principals where id = any($1::uuid[])`,
        [principals],
      );
      await fixture.pgDatabase.query(
        `delete from public."user" where id = any($1::uuid[])`,
        [users],
      );
    } catch (error) {
      cleanupError = error;
    } finally {
      await closePgDatabase(appPg);
      await fixture.close();
    }
  }
  if (cleanupError) throw cleanupError;
});
