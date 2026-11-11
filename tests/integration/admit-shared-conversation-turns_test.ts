import { assert, assertEquals } from "@std/assert";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";

type Fixture = Awaited<ReturnType<typeof openAuthFixture>>;
type Message = {
  id: string;
  conversationId: string;
  authorId: string | null;
  clientMessageId: string;
  sequence: string;
  intent: string;
};
type Page<T> = { items: T[]; nextCursor: string | null };

type Scope = {
  applicationId: string;
  repositoryId: string;
  conversationId: string;
};

async function request(
  fixture: Fixture,
  cookie: string,
  organizationId: string,
  path: string,
  options: {
    method?: "GET" | "POST";
    key?: string;
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
    if (options.key) headers.set("Idempotency-Key", options.key);
  }
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(options.body) } : {}),
    }),
  );
}

async function problemCode(response: Response): Promise<string> {
  return (await response.json() as { code: string }).code;
}

async function createScope(
  fixture: Fixture,
  organizationId: string,
  principalId: string,
  label: string,
): Promise<Scope> {
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.applications (
       id, organization_id, slug, name, description
     ) values ($1, $2, $3, $4, '')`,
    [applicationId, organizationId, `${label}-${applicationId}`, label],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch, version
     ) values ($1, $2, $3, $4, $5, 'bakery', $6, 'main', 1)`,
    [
      repositoryId,
      organizationId,
      applicationId,
      crypto.randomUUID(),
      `${label}/${repositoryId}`,
      label,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, repository_id, title, created_by
     ) values ($1, $2, $3, $4, $5, $6)`,
    [
      conversationId,
      organizationId,
      applicationId,
      repositoryId,
      label,
      principalId,
    ],
  );
  return { applicationId, repositoryId, conversationId };
}

async function send(
  fixture: Fixture,
  cookie: string,
  organizationId: string,
  conversationId: string,
  key: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await request(
    fixture,
    cookie,
    organizationId,
    `/v1/conversations/${conversationId}/messages`,
    { method: "POST", key, body },
  );
}

async function facts(
  fixture: Fixture,
  organizationId: string,
  conversationId: string,
) {
  const result = await fixture.pgDatabase.query<{
    messages: number;
    turns: number;
    message_events: number;
    turn_events: number;
    audits: number;
    outbox: number;
  }>(
    `select
       (select count(*)::int from bakery.messages
         where organization_id=$1 and conversation_id=$2) as messages,
       (select count(*)::int from bakery.conversation_turns
         where organization_id=$1 and conversation_id=$2) as turns,
       (select count(*)::int from bakery.domain_events
         where organization_id=$1 and conversation_id=$2
           and event_type='conversation.message_created') as message_events,
       (select count(*)::int from bakery.domain_events
         where organization_id=$1 and conversation_id=$2
           and event_type='conversation.turn_changed') as turn_events,
       (select count(*)::int from bakery.audit_events
         where organization_id=$1 and operation='messages.create'
           and details->>'conversationId'=$2::text) as audits,
       (select count(*)::int from bakery.outbox outbox
         join bakery.domain_events event on event.id=outbox.event_id
         where event.organization_id=$1 and event.conversation_id=$2
           and event.event_type='conversation.turn_changed') as outbox`,
    [organizationId, conversationId],
  );
  return result.rows[0];
}

async function idempotencyCount(
  fixture: Fixture,
  organizationId: string,
  key: string,
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ count: number }>(
    `select count(*)::int as count from bakery.idempotency_records
      where organization_id=$1 and operation='messages.create' and key=$2`,
    [organizationId, key],
  );
  return result.rows[0]?.count ?? 0;
}

Deno.test("shared conversation admission and pages stay atomic and scoped", async () => {
  const fixture = await openAuthFixture();
  const organizationId = crypto.randomUUID();
  const otherOrganizationId = crypto.randomUUID();
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const secondProviderUserId = crypto.randomUUID();
  const secondPrincipalId = crypto.randomUUID();
  const sessionToken = `conversation-${crypto.randomUUID()}`;
  const secondSessionToken = `conversation-${crypto.randomUUID()}`;
  const now = new Date();
  let cleanupError: unknown;
  try {
    for (
      const [userId, email, name] of [
        [
          providerUserId,
          `conversation-${providerUserId}@example.test`,
          "Conversation Tester",
        ],
        [
          secondProviderUserId,
          `conversation-${secondProviderUserId}@example.test`,
          "Cursor Tester",
        ],
      ] as const
    ) {
      await fixture.pgDatabase.query(
        `insert into public."user" (
           id, name, email, "emailVerified", "createdAt", "updatedAt"
         ) values ($1, $2, $3, true, $4, $4)`,
        [userId, name, email, now],
      );
    }
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
         id, provider_user_id, display_name, principal_type
       ) values ($1, $2, 'Conversation Tester', 'human'),
                ($3, $4, 'Cursor Tester', 'human')`,
      [principalId, providerUserId, secondPrincipalId, secondProviderUserId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
         id, name, slug, metadata, created_at, updated_at, version
       ) values ($1, 'Conversation Org', $2, '{}'::jsonb, $3, $3, 1),
                ($4, 'Other Conversation Org', $5, '{}'::jsonb, $3, $3, 1)`,
      [
        organizationId,
        `conversation-${organizationId}`,
        now,
        otherOrganizationId,
        `conversation-${otherOrganizationId}`,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at,
         created_at, updated_at, version
       ) values ($1, $2, $3, 'developer', 'active', $5, $5, $5, 1),
                ($4, $2, $6, 'developer', 'active', $5, $5, $5, 1)`,
      [
        crypto.randomUUID(),
        organizationId,
        principalId,
        crypto.randomUUID(),
        now,
        secondPrincipalId,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5),
                ($6, $7, $8, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        sessionToken,
        providerUserId,
        new Date(now.getTime() + 3_600_000),
        now,
        crypto.randomUUID(),
        secondSessionToken,
        secondProviderUserId,
      ],
    );
    const cookie = await signSessionCookie(
      sessionToken,
      fixture.config.auth!.secret,
    );
    const secondCookie = await signSessionCookie(
      secondSessionToken,
      fixture.config.auth!.secret,
    );

    const main = await createScope(
      fixture,
      organizationId,
      principalId,
      "conversation-main",
    );
    const other = await createScope(
      fixture,
      otherOrganizationId,
      principalId,
      "conversation-foreign",
    );

    const discussionId = crypto.randomUUID();
    const discussion = await send(
      fixture,
      cookie,
      organizationId,
      main.conversationId,
      "discussion-1",
      {
        body: "First discussion",
        clientMessageId: discussionId,
        intent: "discussion",
      },
    );
    if (discussion.status !== 201) {
      throw new Error(
        `DISCUSSION_SEND_FAILED:${discussion.status}:${await discussion
          .text()}`,
      );
    }
    const discussionMessage = await discussion.json() as Message;
    assertEquals(discussionMessage.authorId, principalId);
    assertEquals(discussionMessage.sequence, "1");
    assertEquals(await facts(fixture, organizationId, main.conversationId), {
      messages: 1,
      turns: 0,
      message_events: 1,
      turn_events: 0,
      audits: 1,
      outbox: 0,
    });

    const agentId = crypto.randomUUID();
    const agent = await send(
      fixture,
      cookie,
      organizationId,
      main.conversationId,
      "agent-1",
      { body: "Queue work", clientMessageId: agentId, intent: "agent_request" },
    );
    assertEquals(agent.status, 201);
    const agentMessage = await agent.json() as Message;
    assertEquals(agentMessage.sequence, "2");
    assertEquals(await facts(fixture, organizationId, main.conversationId), {
      messages: 2,
      turns: 1,
      message_events: 2,
      turn_events: 1,
      audits: 2,
      outbox: 1,
    });
    const queued = await fixture.pgDatabase.query<{
      status: string;
      context_through_sequence: string | null;
      agent_session_id: string | null;
    }>(
      `select status, context_through_sequence::text, agent_session_id
         from bakery.conversation_turns
        where organization_id=$1 and trigger_message_id=$2`,
      [organizationId, agentMessage.id],
    );
    assertEquals(queued.rows, [{
      status: "queued",
      context_through_sequence: "2",
      agent_session_id: null,
    }]);

    const beforeHttpReplay = await facts(
      fixture,
      organizationId,
      main.conversationId,
    );
    const httpReplay = await send(
      fixture,
      cookie,
      organizationId,
      main.conversationId,
      "agent-1",
      { body: "Queue work", clientMessageId: agentId, intent: "agent_request" },
    );
    assertEquals(httpReplay.status, 201);
    assertEquals((await httpReplay.json() as Message).id, agentMessage.id);
    assertEquals(
      await facts(fixture, organizationId, main.conversationId),
      beforeHttpReplay,
    );

    const domainReplay = await send(
      fixture,
      cookie,
      organizationId,
      main.conversationId,
      "agent-domain-replay",
      { body: "Queue work", clientMessageId: agentId, intent: "agent_request" },
    );
    assertEquals(domainReplay.status, 201);
    assertEquals((await domainReplay.json() as Message).id, agentMessage.id);
    assertEquals(
      await facts(fixture, organizationId, main.conversationId),
      beforeHttpReplay,
    );

    const mismatch = await send(
      fixture,
      cookie,
      organizationId,
      main.conversationId,
      "agent-domain-mismatch",
      {
        body: "Changed work",
        clientMessageId: agentId,
        intent: "agent_request",
      },
    );
    assertEquals(mismatch.status, 422);
    assertEquals(await problemCode(mismatch), "IDEMPOTENCY_PAYLOAD_MISMATCH");
    assertEquals(
      await facts(fixture, organizationId, main.conversationId),
      beforeHttpReplay,
    );
    assertEquals(
      await idempotencyCount(fixture, organizationId, "agent-domain-mismatch"),
      0,
    );

    const concurrent = await Promise.all([
      send(
        fixture,
        cookie,
        organizationId,
        main.conversationId,
        "concurrent-a",
        {
          body: "Concurrent A",
          clientMessageId: crypto.randomUUID(),
          intent: "discussion",
        },
      ),
      send(
        fixture,
        cookie,
        organizationId,
        main.conversationId,
        "concurrent-b",
        {
          body: "Concurrent B",
          clientMessageId: crypto.randomUUID(),
          intent: "agent_request",
        },
      ),
    ]);
    assertEquals(concurrent.map((response) => response.status), [201, 201]);
    const concurrentMessages = await Promise.all(
      concurrent.map((response) => response.json() as Promise<Message>),
    );
    assertEquals(
      new Set(concurrentMessages.map(({ sequence }) => sequence)).size,
      2,
    );

    const rejectedInputFacts = await facts(
      fixture,
      organizationId,
      main.conversationId,
    );
    for (
      const [index, field] of [
        [0, { authorId: principalId }],
        [1, { sequence: "99" }],
        [2, { agentSessionId: crypto.randomUUID() }],
        [3, { messageType: "assistant" }],
        [4, { status: "completed" }],
      ] as const
    ) {
      const spoofed = await send(
        fixture,
        cookie,
        organizationId,
        main.conversationId,
        `spoof-${index}`,
        {
          body: "Spoofed",
          clientMessageId: crypto.randomUUID(),
          intent: "discussion",
          ...field,
        },
      );
      assertEquals(spoofed.status, 400);
      assertEquals(await problemCode(spoofed), "MALFORMED_REQUEST");
    }

    const comments = await send(
      fixture,
      cookie,
      organizationId,
      main.conversationId,
      "comment-refs",
      {
        body: "Referenced comment",
        clientMessageId: crypto.randomUUID(),
        intent: "agent_request",
        commentRefs: [{ commentId: crypto.randomUUID(), expectedVersion: 1 }],
      },
    );
    assertEquals(comments.status, 404);
    assertEquals(await problemCode(comments), "RESOURCE_NOT_FOUND");
    assertEquals(
      await facts(fixture, organizationId, main.conversationId),
      rejectedInputFacts,
    );

    const boundaryBody = "é".repeat(16_384);
    assertEquals(new TextEncoder().encode(boundaryBody).byteLength, 32_768);
    const boundary = await send(
      fixture,
      cookie,
      organizationId,
      main.conversationId,
      "utf8-boundary",
      {
        body: boundaryBody,
        clientMessageId: crypto.randomUUID(),
        intent: "discussion",
      },
    );
    assertEquals(boundary.status, 201);
    const boundaryFacts = await facts(
      fixture,
      organizationId,
      main.conversationId,
    );
    const overflow = await send(
      fixture,
      cookie,
      organizationId,
      main.conversationId,
      "utf8-overflow",
      {
        body: `${boundaryBody}a`,
        clientMessageId: crypto.randomUUID(),
        intent: "discussion",
      },
    );
    assertEquals(overflow.status, 400);
    assertEquals(await problemCode(overflow), "MALFORMED_REQUEST");
    assertEquals(
      await facts(fixture, organizationId, main.conversationId),
      boundaryFacts,
    );

    const replyScope = await createScope(
      fixture,
      organizationId,
      principalId,
      "conversation-reply-scope",
    );
    const replyOutside = await send(
      fixture,
      cookie,
      organizationId,
      replyScope.conversationId,
      "reply-outside",
      {
        body: "Wrong reply scope",
        clientMessageId: crypto.randomUUID(),
        intent: "discussion",
        replyToId: discussionMessage.id,
      },
    );
    assertEquals(replyOutside.status, 404);
    assertEquals(
      await facts(fixture, organizationId, replyScope.conversationId),
      {
        messages: 0,
        turns: 0,
        message_events: 0,
        turn_events: 0,
        audits: 0,
        outbox: 0,
      },
    );

    const archived = await createScope(
      fixture,
      organizationId,
      principalId,
      "conversation-archived",
    );
    await fixture.pgDatabase.query(
      `update bakery.conversations set archived_at=now()
        where organization_id=$1 and id=$2`,
      [organizationId, archived.conversationId],
    );
    const archivedSend = await send(
      fixture,
      cookie,
      organizationId,
      archived.conversationId,
      "archived-send",
      {
        body: "No archived send",
        clientMessageId: crypto.randomUUID(),
        intent: "discussion",
      },
    );
    assertEquals(archivedSend.status, 409);
    assertEquals(await problemCode(archivedSend), "STATE_CONFLICT");
    assertEquals(
      await idempotencyCount(fixture, organizationId, "archived-send"),
      0,
    );

    const crossTenant = await send(
      fixture,
      cookie,
      organizationId,
      other.conversationId,
      "cross-tenant",
      {
        body: "No cross tenant",
        clientMessageId: crypto.randomUUID(),
        intent: "discussion",
      },
    );
    assertEquals(crossTenant.status, 404);
    assertEquals(await problemCode(crossTenant), "RESOURCE_NOT_FOUND");

    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status='inactive'
        where organization_id=$1 and principal_id=$2`,
      [organizationId, principalId],
    );
    const permissionLost = await send(
      fixture,
      cookie,
      organizationId,
      main.conversationId,
      "permission-lost",
      {
        body: "No permission",
        clientMessageId: crypto.randomUUID(),
        intent: "discussion",
      },
    );
    assertEquals(permissionLost.status, 404);
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status='active'
        where organization_id=$1 and principal_id=$2`,
      [organizationId, principalId],
    );

    const httpRevoked = await createScope(
      fixture,
      organizationId,
      principalId,
      "conversation-http-replay-revoked",
    );
    const httpRevokedId = crypto.randomUUID();
    const httpOriginal = await send(
      fixture,
      cookie,
      organizationId,
      httpRevoked.conversationId,
      "revoked-http-key",
      {
        body: "Stored HTTP response",
        clientMessageId: httpRevokedId,
        intent: "discussion",
      },
    );
    assertEquals(httpOriginal.status, 201);
    const httpRevokedFacts = await facts(
      fixture,
      organizationId,
      httpRevoked.conversationId,
    );
    await fixture.pgDatabase.query(
      `update bakery.repositories set archived_at=now()
        where organization_id=$1 and id=$2`,
      [organizationId, httpRevoked.repositoryId],
    );
    const activeMembership = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.organization_memberships
        where organization_id=$1 and principal_id=$2`,
      [organizationId, principalId],
    );
    assertEquals(activeMembership.rows[0]?.status, "active");
    const deniedHttpReplay = await send(
      fixture,
      cookie,
      organizationId,
      httpRevoked.conversationId,
      "revoked-http-key",
      {
        body: "Stored HTTP response",
        clientMessageId: httpRevokedId,
        intent: "discussion",
      },
    );
    assertEquals(deniedHttpReplay.status, 404);
    assertEquals(
      await facts(fixture, organizationId, httpRevoked.conversationId),
      httpRevokedFacts,
    );
    assertEquals(
      await idempotencyCount(fixture, organizationId, "revoked-http-key"),
      1,
    );

    const domainRevoked = await createScope(
      fixture,
      organizationId,
      principalId,
      "conversation-domain-replay-revoked",
    );
    const domainRevokedId = crypto.randomUUID();
    const domainOriginal = await send(
      fixture,
      cookie,
      organizationId,
      domainRevoked.conversationId,
      "domain-original-key",
      {
        body: "Stored domain response",
        clientMessageId: domainRevokedId,
        intent: "discussion",
      },
    );
    assertEquals(domainOriginal.status, 201);
    const domainRevokedFacts = await facts(
      fixture,
      organizationId,
      domainRevoked.conversationId,
    );
    await fixture.pgDatabase.query(
      `update bakery.applications set archived_at=now()
        where organization_id=$1 and id=$2`,
      [organizationId, domainRevoked.applicationId],
    );
    const domainMembership = await fixture.pgDatabase.query<{
      status: string;
    }>(
      `select status from bakery.organization_memberships
        where organization_id=$1 and principal_id=$2`,
      [organizationId, principalId],
    );
    assertEquals(domainMembership.rows[0]?.status, "active");
    const deniedDomainReplay = await send(
      fixture,
      cookie,
      organizationId,
      domainRevoked.conversationId,
      "domain-fresh-key",
      {
        body: "Stored domain response",
        clientMessageId: domainRevokedId,
        intent: "discussion",
      },
    );
    assertEquals(deniedDomainReplay.status, 404);
    assertEquals(
      await facts(fixture, organizationId, domainRevoked.conversationId),
      domainRevokedFacts,
    );
    assertEquals(
      await idempotencyCount(fixture, organizationId, "domain-fresh-key"),
      0,
    );

    const queue = await createScope(
      fixture,
      organizationId,
      principalId,
      "conversation-queue-bound",
    );
    await fixture.pgDatabase.query(
      `insert into bakery.messages (
         organization_id, conversation_id, author_id, message_type, body,
         client_message_id, sequence, intent
       ) select $1, $2, $3, 'user', 'queued seed', gen_random_uuid()::text,
                value, 'agent_request'
           from generate_series(1, 50) value`,
      [organizationId, queue.conversationId, principalId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.conversation_turns (
         organization_id, conversation_id, trigger_message_id, status
       ) select organization_id, conversation_id, id, 'queued'
           from bakery.messages
          where organization_id=$1 and conversation_id=$2`,
      [organizationId, queue.conversationId],
    );
    const queueFull = await send(
      fixture,
      cookie,
      organizationId,
      queue.conversationId,
      "queue-full",
      {
        body: "Fifty-first turn",
        clientMessageId: crypto.randomUUID(),
        intent: "agent_request",
      },
    );
    assertEquals(queueFull.status, 409);
    assertEquals(await problemCode(queueFull), "STATE_CONFLICT");
    assertEquals(
      (await facts(fixture, organizationId, queue.conversationId)).messages,
      50,
    );

    const active = await createScope(
      fixture,
      organizationId,
      principalId,
      "conversation-one-active",
    );
    await fixture.pgDatabase.query(
      `insert into bakery.messages (
         organization_id, conversation_id, author_id, message_type, body,
         client_message_id, sequence, intent
       ) values ($1, $2, $3, 'user', 'active one', $4, 1, 'agent_request'),
                ($1, $2, $3, 'user', 'active two', $5, 2, 'agent_request')`,
      [
        organizationId,
        active.conversationId,
        principalId,
        crypto.randomUUID(),
        crypto.randomUUID(),
      ],
    );
    const activeMessages = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.messages
        where organization_id=$1 and conversation_id=$2 order by sequence`,
      [organizationId, active.conversationId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.conversation_turns (
         organization_id, conversation_id, trigger_message_id, status
       ) values ($1, $2, $3, 'active')`,
      [organizationId, active.conversationId, activeMessages.rows[0].id],
    );
    let activeConflict: unknown;
    try {
      await fixture.pgDatabase.query(
        `insert into bakery.conversation_turns (
           organization_id, conversation_id, trigger_message_id, status
         ) values ($1, $2, $3, 'cancel_requested')`,
        [organizationId, active.conversationId, activeMessages.rows[1].id],
      );
    } catch (error) {
      activeConflict = error;
    }
    assertEquals((activeConflict as { code?: string })?.code, "23505");

    const pageScope = await createScope(
      fixture,
      organizationId,
      principalId,
      "conversation-page-bound",
    );
    await fixture.pgDatabase.query(
      `insert into bakery.messages (
         organization_id, conversation_id, author_id, message_type, body,
         client_message_id, sequence, intent
       ) select $1, $2, $3, 'user', 'page seed', gen_random_uuid()::text,
                value, 'discussion'
           from generate_series(1, 101) value`,
      [organizationId, pageScope.conversationId, principalId],
    );
    const firstPageResponse = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${pageScope.conversationId}/messages?limit=100`,
    );
    assertEquals(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json() as Page<Message>;
    assertEquals(firstPage.items.length, 100);
    assert(firstPage.nextCursor);
    assertEquals(firstPage.items[0].sequence, "101");
    const finalPageResponse = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${pageScope.conversationId}/messages?limit=100&cursor=${
        encodeURIComponent(firstPage.nextCursor)
      }`,
    );
    assertEquals(finalPageResponse.status, 200);
    const finalPage = await finalPageResponse.json() as Page<Message>;
    assertEquals(finalPage.items.length, 1);
    assertEquals(finalPage.nextCursor, null);

    const wrongConversationCursor = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${main.conversationId}/messages?cursor=${
        encodeURIComponent(firstPage.nextCursor)
      }`,
    );
    assertEquals(wrongConversationCursor.status, 400);
    assertEquals(await problemCode(wrongConversationCursor), "INVALID_CURSOR");
    const wrongPrincipalCursor = await request(
      fixture,
      secondCookie,
      organizationId,
      `/v1/conversations/${pageScope.conversationId}/messages?cursor=${
        encodeURIComponent(firstPage.nextCursor)
      }`,
    );
    assertEquals(wrongPrincipalCursor.status, 400);
    assertEquals(await problemCode(wrongPrincipalCursor), "INVALID_CURSOR");
    const malformedCursor = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${pageScope.conversationId}/messages?cursor=not-a-cursor`,
    );
    assertEquals(malformedCursor.status, 400);
    assertEquals(await problemCode(malformedCursor), "INVALID_CURSOR");

    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status='inactive'
        where organization_id=$1 and principal_id=$2`,
      [organizationId, principalId],
    );
    const lostBetweenPages = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${pageScope.conversationId}/messages?cursor=${
        encodeURIComponent(firstPage.nextCursor)
      }`,
    );
    assertEquals(lostBetweenPages.status, 404);
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set status='active'
        where organization_id=$1 and principal_id=$2`,
      [organizationId, principalId],
    );

    const readRevoked = await createScope(
      fixture,
      organizationId,
      principalId,
      "conversation-read-revoked",
    );
    await fixture.pgDatabase.query(
      `insert into bakery.messages (
         organization_id, conversation_id, author_id, message_type, body,
         client_message_id, sequence, intent
       ) select $1, $2, $3, 'user', 'read revoke', gen_random_uuid()::text,
                value, 'discussion'
           from generate_series(1, 3) value`,
      [organizationId, readRevoked.conversationId, principalId],
    );
    const readable = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${readRevoked.conversationId}/messages?limit=2`,
    );
    assertEquals(readable.status, 200);
    const readablePage = await readable.json() as Page<Message>;
    assert(readablePage.nextCursor);
    await fixture.pgDatabase.query(
      `update bakery.repositories set archived_at=now()
        where organization_id=$1 and id=$2`,
      [organizationId, readRevoked.repositoryId],
    );
    const revokedPage = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${readRevoked.conversationId}/messages?cursor=${
        encodeURIComponent(readablePage.nextCursor)
      }`,
    );
    assertEquals(revokedPage.status, 404);

    const turnsResponse = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${main.conversationId}/turns?limit=1`,
    );
    assertEquals(turnsResponse.status, 200);
    const turns = await turnsResponse.json() as Page<{ status: string }>;
    assertEquals(turns.items.map(({ status }) => status), ["queued"]);
    assert(turns.nextCursor);
    const finalTurnsResponse = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${main.conversationId}/turns?limit=100&cursor=${
        encodeURIComponent(turns.nextCursor)
      }`,
    );
    assertEquals(finalTurnsResponse.status, 200);
    const finalTurns = await finalTurnsResponse.json() as Page<{
      status: string;
    }>;
    assert(finalTurns.items.length >= 1);
    assertEquals(
      finalTurns.items.every(({ status }) => status === "queued"),
      true,
    );
    assertEquals(finalTurns.nextCursor, null);
    const actionBoundCursor = await request(
      fixture,
      cookie,
      organizationId,
      `/v1/conversations/${main.conversationId}/turns?cursor=${
        encodeURIComponent(firstPage.nextCursor)
      }`,
    );
    assertEquals(actionBoundCursor.status, 400);
    assertEquals(await problemCode(actionBoundCursor), "INVALID_CURSOR");
  } finally {
    try {
      await fixture.pgDatabase.query(
        `delete from public.session where "userId" = any($1::uuid[])`,
        [[providerUserId, secondProviderUserId]],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.organizations where id = any($1::uuid[])`,
        [[organizationId, otherOrganizationId]],
      );
      await fixture.pgDatabase.query(
        `delete from bakery.principals where id = any($1::uuid[])`,
        [[principalId, secondPrincipalId]],
      );
      await fixture.pgDatabase.query(
        `delete from public."user" where id = any($1::uuid[])`,
        [[providerUserId, secondProviderUserId]],
      );
    } catch (error) {
      cleanupError = error;
    } finally {
      await fixture.close();
    }
  }
  if (cleanupError) throw cleanupError;
});
