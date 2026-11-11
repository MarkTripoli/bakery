import { assert, assertEquals, assertExists } from "@std/assert";
import { authTestOrigin, cleanupAuthFixture } from "../helpers/auth.ts";
import {
  assertFrame,
  openSocketFixture,
  type SocketFixture,
} from "../helpers/events-socket.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import type {
  WebSocketHandshakeFailure,
  WebSocketNext,
  WsClient,
} from "../helpers/ws-client.ts";

type SocketConnection = WsClient | WebSocketHandshakeFailure;

type SecondaryIdentity = {
  email: string;
  cookie: string;
};

type OtherOrganizationTask = {
  organizationId: string;
  applicationId: string;
  conversationId: string;
  taskId: string;
};

type SecurityFrame = Record<string, unknown> & {
  type: string;
  problem?: unknown;
  requestId?: unknown;
  cursor?: string;
  status?: string;
  events?: unknown;
};

type CapturedClose = {
  frames: SecurityFrame[];
  close: { code: number; reason: string };
};

function parseFrame(value: string | Uint8Array): SecurityFrame {
  const parsed = assertFrame(value);
  if (
    parsed !== null && typeof parsed === "object" && "type" in parsed &&
    typeof parsed.type === "string"
  ) {
    return parsed as SecurityFrame;
  }
  throw new Error("WEBSOCKET_FRAME_INVALID");
}

const REQUEST_ID = () => crypto.randomUUID();

function isHandshakeFailure(
  value: SocketConnection,
): value is WebSocketHandshakeFailure {
  return !("send" in value);
}

function requireFailure(value: SocketConnection): WebSocketHandshakeFailure {
  assert(isHandshakeFailure(value), "expected the WebSocket upgrade to fail");
  return value;
}

function requireClient(value: SocketConnection): WsClient {
  assert(
    !isHandshakeFailure(value),
    "expected the WebSocket upgrade to succeed",
  );
  return value;
}

function bodyCode(body: unknown): string {
  if (
    body === null || typeof body !== "object" || !("code" in body) ||
    typeof body.code !== "string"
  ) {
    throw new Error(`problem code missing: ${JSON.stringify(body)}`);
  }
  return body.code;
}

function frameCode(frame: SecurityFrame): string {
  assertEquals(frame.type, "problem");
  const problem = frame.problem;
  assert(problem !== null && typeof problem === "object");
  return bodyCode(problem);
}

function requireText(next: WebSocketNext): string {
  assert(
    typeof next === "string",
    `expected a text frame, got ${JSON.stringify(next)}`,
  );
  return next;
}
type FixtureLease = {
  fixture: SocketFixture;
  release: () => void;
};

let fixtureTail = Promise.resolve();

async function openTestFixture(
  options: Parameters<typeof openSocketFixture>[0] = {},
): Promise<FixtureLease> {
  let release!: () => void;
  const turn = new Promise<void>((resolve) => release = resolve);
  const previous = fixtureTail;
  fixtureTail = fixtureTail.then(() => turn);
  await previous;
  try {
    return { fixture: await openSocketFixture(options), release };
  } catch (error) {
    release();
    throw error;
  }
}

async function closeTestFixture(
  lease: FixtureLease,
  extraEmails: readonly string[] = [],
): Promise<void> {
  try {
    await cleanupAuthFixture(
      lease.fixture.pgDatabase,
      [lease.fixture.email, ...extraEmails],
    );
    await lease.fixture.close();
  } finally {
    lease.release();
  }
}

async function nextFrame(
  client: WsClient,
  timeoutMs = 2_500,
): Promise<SecurityFrame> {
  return parseFrame(requireText(await client.next(timeoutMs)));
}

async function taskCount(fixture: SocketFixture): Promise<number> {
  const result = await fixture.pgDatabase.query<{ count: string }>(
    `select count(*)::text as count
       from bakery.tasks
      where organization_id = $1`,
    [fixture.organizationId],
  );
  const count = Number(result.rows[0]?.count);
  assert(Number.isSafeInteger(count));
  return count;
}

function assertNoLeaks(
  values: readonly unknown[],
  secrets: readonly string[] = [],
): void {
  const output = values.map((value) =>
    typeof value === "string" ? value : JSON.stringify(value)
  ).join("\n");
  for (
    const needle of [
      "postgres://",
      "session_token",
      "bakery.",
      ...secrets,
    ]
  ) {
    assertEquals(
      output.includes(needle),
      false,
      `unexpected secret in output: ${needle}`,
    );
  }
}

async function insertEvent(
  fixture: SocketFixture,
  organizationId: string,
  applicationId: string,
  taskId: string,
  conversationId: string,
  eventType = "tasks.updated",
): Promise<string> {
  return await withPgTransaction(fixture.pgDatabase, async (transaction) => {
    const clock = await transaction.query<{ sequence: string }>(
      `insert into bakery.event_clock (organization_id, stream, next_seq)
       select $1, 'domain_events', coalesce(max(organization_sequence), 0) + 2
       from bakery.domain_events
       where organization_id = $1
       on conflict (organization_id, stream) do update
         set next_seq = bakery.event_clock.next_seq + 1
       returning (next_seq - 1)::text as sequence`,
      [organizationId],
    );
    const sequence = clock.rows[0]?.sequence;
    assertExists(sequence);
    const event = await transaction.query<{ id: string }>(
      `insert into bakery.domain_events (
         organization_id, organization_sequence, event_type, schema_version,
         application_id, repository_id, task_id, conversation_id,
         aggregate_id, aggregate_version, payload
       ) values ($1, $2, $3, 1, $4, null, $5, $6, $5, 1, $7::jsonb)
       returning id`,
      [
        organizationId,
        sequence,
        eventType,
        applicationId,
        taskId,
        conversationId,
        JSON.stringify({ resourceId: taskId, resourceVersion: 1 }),
      ],
    );
    const eventId = event.rows[0]?.id;
    assertExists(eventId);
    return eventId;
  });
}

async function createOtherOrganizationTask(
  fixture: SocketFixture,
): Promise<OtherOrganizationTask> {
  const organizationId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const now = new Date();
  await fixture.pgDatabase.query(
    `insert into bakery.organizations (
       id, name, slug, metadata, created_at, updated_at, version
     ) values ($1, 'WebSocket security isolation', $2, '{}'::jsonb, $3, $3, 1)`,
    [organizationId, `websocket-security-${organizationId}`, now],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, $3, 'WebSocket security isolation')`,
    [applicationId, organizationId, `websocket-security-app-${organizationId}`],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, title, created_by
     ) values ($1, $2, $3, 'WebSocket security isolation', $4)`,
    [conversationId, organizationId, applicationId, fixture.principalId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, conversation_id, title,
       task_type, status, priority, created_by
     ) values ($1, $2, $3, $4, 'WebSocket security isolation',
       'feature', 'draft', 50, $5)`,
    [
      taskId,
      organizationId,
      applicationId,
      conversationId,
      fixture.principalId,
    ],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status,
       joined_at, created_at, updated_at, version
     ) values ($1, $2, $3, 'admin', 'active', $4, $4, $4, 1)`,
    [crypto.randomUUID(), organizationId, fixture.principalId, now],
  );
  return { organizationId, applicationId, conversationId, taskId };
}

async function signSessionCookie(
  token: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(token),
    ),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return `better-auth.session_token=${token}.${btoa(binary)}`;
}

async function createSecondaryIdentity(
  fixture: SocketFixture,
): Promise<SecondaryIdentity> {
  const suffix = crypto.randomUUID();
  const email = `events-security-secondary-${suffix}@example.test`;
  const providerUserId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const token = `events-security-session-${suffix}`;
  const now = new Date();
  await fixture.pgDatabase.query(
    `insert into public."user" (
       id, name, email, "emailVerified", "createdAt", "updatedAt"
     ) values ($1, 'Events Security Secondary', $2, true, $3, $3)`,
    [providerUserId, email, now],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.principals (
       id, provider_user_id, display_name, principal_type
     ) values ($1, $2, 'Events Security Secondary', 'human')`,
    [principalId, providerUserId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.organization_memberships (
       id, organization_id, principal_id, role, status,
       joined_at, created_at, updated_at, version
     ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
    [membershipId, fixture.organizationId, principalId, now],
  );
  await fixture.pgDatabase.query(
    `insert into public.session (
       id, "expiresAt", token, "createdAt", "updatedAt", "userId"
     ) values ($1, $2, $3, $4, $4, $5)`,
    [
      crypto.randomUUID(),
      new Date(now.getTime() + 60 * 60_000),
      token,
      now,
      providerUserId,
    ],
  );
  return {
    email,
    cookie: await signSessionCookie(token, fixture.config.auth!.secret),
  };
}

async function closeAfterFrames(client: WsClient): Promise<CapturedClose> {
  const frames: SecurityFrame[] = [];
  for (let index = 0; index < 8; index++) {
    const next = await client.next(2_500);
    if (typeof next !== "string") return { frames, close: next };
    frames.push(parseFrame(next));
  }
  throw new Error("WEBSOCKET_CLOSE_NOT_RECEIVED");
}

async function sendStableFrame(
  fixture: SocketFixture,
  client: WsClient,
  payload: string,
): Promise<SecurityFrame> {
  const before = await taskCount(fixture);
  await client.send(payload);
  const frame = await nextFrame(client);
  const after = await taskCount(fixture);
  assertEquals(
    after,
    before,
    `client frame changed the task count: ${payload}`,
  );
  return frame;
}

Deno.test("events socket rejects origin, authentication, and organization failures before upgrade", async () => {
  const lease = await openTestFixture();
  const { fixture } = lease;
  const outputs: unknown[] = [];
  try {
    const missingOrigin = requireFailure(
      await fixture.connect({ origin: null, cookie: fixture.cookie }),
    );
    outputs.push(missingOrigin.body);
    assertEquals(missingOrigin.status, 403);
    assertEquals(bodyCode(missingOrigin.body), "AUTH_FORBIDDEN");

    const hostileOrigin = requireFailure(
      await fixture.connect({
        origin: "https://attacker.example.test",
        cookie: fixture.cookie,
      }),
    );
    outputs.push(hostileOrigin.body);
    assertEquals(hostileOrigin.status, 403);
    assertEquals(bodyCode(hostileOrigin.body), "AUTH_FORBIDDEN");

    const missingCookie = requireFailure(await fixture.connect());
    outputs.push(missingCookie.body);
    assertEquals(missingCookie.status, 401);
    assertEquals(bodyCode(missingCookie.body), "AUTH_REQUIRED");

    const nonMemberOrganization = requireFailure(
      await fixture.connect({
        cookie: fixture.cookie,
        organizationId: crypto.randomUUID(),
      }),
    );
    outputs.push(nonMemberOrganization.body);
    assertEquals(nonMemberOrganization.status, 404);
    assertEquals(bodyCode(nonMemberOrganization.body), "RESOURCE_NOT_FOUND");

    const malformedUpgrade = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/events?organizationId=${fixture.organizationId}`,
        {
          headers: {
            cookie: fixture.cookie,
            origin: authTestOrigin,
          },
        },
      ),
    );
    const malformedBody = await malformedUpgrade.json();
    outputs.push(malformedBody);
    assertEquals(malformedUpgrade.status, 400);
    assertEquals(bodyCode(malformedBody), "MALFORMED_REQUEST");

    assertNoLeaks(outputs, [fixture.cookie, fixture.config.auth!.secret]);
  } finally {
    await closeTestFixture(lease);
  }
});

Deno.test("viewer and guest roles cannot read sensitive organization events", async () => {
  const lease = await openTestFixture();
  const { fixture } = lease;
  try {
    for (const role of ["viewer", "guest"] as const) {
      await fixture.pgDatabase.query(
        `update bakery.organization_memberships
            set role = $1
          where organization_id = $2 and principal_id = $3`,
        [role, fixture.organizationId, fixture.principalId],
      );
      const denied = requireFailure(
        await fixture.connect({ cookie: fixture.cookie }),
      );
      assertEquals(denied.status, 404, role);
      assertEquals(bodyCode(denied.body), "RESOURCE_NOT_FOUND", role);
    }
  } finally {
    await closeTestFixture(lease);
  }
});

function hasOutputType(values: readonly unknown[], type: string): boolean {
  return values.some((value) =>
    value !== null && typeof value === "object" && "type" in value &&
    value.type === type
  );
}

Deno.test("non-UUID request ids remain healthy through heartbeat", async () => {
  const lease = await openTestFixture({
    eventsSocket: { limits: { heartbeatMs: 25 } },
  });
  let client: WsClient | undefined;
  try {
    client = requireClient(
      await lease.fixture.connect({
        cookie: lease.fixture.cookie,
        headers: { "x-request-id": "proxy-request-id" },
      }),
    );
    assertEquals((await nextFrame(client)).type, "hello");
    const heartbeat = await nextFrame(client, 1_000);
    assertEquals(heartbeat.type, "ping");
    assert(
      typeof heartbeat.requestId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(heartbeat.requestId),
    );
    assert(heartbeat.requestId !== "proxy-request-id");
  } finally {
    await client?.close();
    await closeTestFixture(lease);
  }
});

Deno.test("events socket withholds foreign scopes and keeps every client frame read-only", async () => {
  const lease = await openTestFixture();
  const { fixture } = lease;
  const outputs: unknown[] = [];
  let client: WsClient | undefined;
  let otherOrganization: OtherOrganizationTask | undefined;
  try {
    otherOrganization = await createOtherOrganizationTask(fixture);
    await insertEvent(
      fixture,
      otherOrganization.organizationId,
      otherOrganization.applicationId,
      otherOrganization.taskId,
      otherOrganization.conversationId,
    );
    client = requireClient(await fixture.connect({ cookie: fixture.cookie }));
    outputs.push(await nextFrame(client));

    const foreignScopeProblem = await sendStableFrame(
      fixture,
      client,
      JSON.stringify({
        type: "subscribe",
        requestId: REQUEST_ID(),
        scopes: [{ type: "task", id: otherOrganization.taskId }],
        after: null,
      }),
    );
    outputs.push(foreignScopeProblem);
    assertEquals(frameCode(foreignScopeProblem), "RESOURCE_NOT_FOUND");
    assertEquals(foreignScopeProblem.type, "problem");

    const ping = await sendStableFrame(
      fixture,
      client,
      JSON.stringify({ type: "ping", requestId: REQUEST_ID() }),
    );
    outputs.push(ping);
    assertEquals(ping.type, "ping");

    const malformedJson = await sendStableFrame(
      fixture,
      client,
      "{not-json",
    );
    outputs.push(malformedJson);
    assertEquals(frameCode(malformedJson), "MALFORMED_JSON");

    const mutationShaped = await sendStableFrame(
      fixture,
      client,
      JSON.stringify({
        type: "tasks.create",
        requestId: REQUEST_ID(),
        title: "must never reach a command runner",
        organizationId: fixture.organizationId,
      }),
    );
    outputs.push(mutationShaped);
    assertEquals(frameCode(mutationShaped), "MALFORMED_REQUEST");

    const ack = await sendStableFrame(
      fixture,
      client,
      JSON.stringify({
        type: "ack",
        requestId: REQUEST_ID(),
        eventId: crypto.randomUUID(),
        sequence: "1",
      }),
    );
    outputs.push(ack);
    assertEquals(ack.type, "ack");
    assertEquals(ack.status, "rejected");

    const subscribe = await sendStableFrame(
      fixture,
      client,
      JSON.stringify({
        type: "subscribe",
        requestId: REQUEST_ID(),
        scopes: [{ type: "task", id: fixture.taskId }],
        after: null,
      }),
    );
    outputs.push(subscribe);
    assertEquals(subscribe.type, "cursor");
    assertEquals(hasOutputType(outputs, "events"), false);

    const inserted = await fixture.insertDomainEvent({
      eventType: "tasks.updated",
      aggregateVersion: 2,
      payload: { resourceId: fixture.taskId, resourceVersion: 2 },
    });
    const delivered = await nextFrame(client);
    outputs.push(delivered);
    assertEquals(delivered.type, "events");
    assert(Array.isArray(delivered.events));
    const event = delivered.events[0] as {
      id: string;
      sequence: string;
    } | undefined;
    assertExists(event);
    assertEquals(event.id, inserted.id);
    assertEquals(event.sequence, inserted.sequence);
    outputs.push(await nextFrame(client));

    const wrongEventId = await sendStableFrame(
      fixture,
      client,
      JSON.stringify({
        type: "ack",
        requestId: REQUEST_ID(),
        eventId: crypto.randomUUID(),
        sequence: inserted.sequence,
      }),
    );
    outputs.push(wrongEventId);
    assertEquals(wrongEventId.status, "rejected");

    const unseenSequence = await sendStableFrame(
      fixture,
      client,
      JSON.stringify({
        type: "ack",
        requestId: REQUEST_ID(),
        eventId: crypto.randomUUID(),
        sequence: (BigInt(inserted.sequence) + 1n).toString(),
      }),
    );
    outputs.push(unseenSequence);
    assertEquals(unseenSequence.status, "rejected");

    const exact = await sendStableFrame(
      fixture,
      client,
      JSON.stringify({
        type: "ack",
        requestId: REQUEST_ID(),
        eventId: event.id,
        sequence: event.sequence,
      }),
    );
    outputs.push(exact);
    assertEquals(exact.status, "accepted");

    assertNoLeaks(outputs, [fixture.cookie, fixture.config.auth!.secret]);
  } finally {
    await client?.close();
    if (otherOrganization) {
      await fixture.pgDatabase.query(
        "delete from bakery.organizations where id = $1",
        [otherOrganization.organizationId],
      );
    }
    await closeTestFixture(lease);
  }
});

Deno.test("events socket closes and withholds data after session or membership revocation", async () => {
  const sessionLease = await openTestFixture();
  const { fixture: sessionFixture } = sessionLease;
  const sessionOutputs: unknown[] = [];
  let sessionClient: WsClient | undefined;
  try {
    sessionClient = requireClient(
      await sessionFixture.connect({ cookie: sessionFixture.cookie }),
    );
    sessionOutputs.push(await nextFrame(sessionClient));
    const subscription = await sendStableFrame(
      sessionFixture,
      sessionClient,
      JSON.stringify({
        type: "subscribe",
        requestId: REQUEST_ID(),
        scopes: [{ type: "task", id: sessionFixture.taskId }],
        after: null,
      }),
    );
    sessionOutputs.push(subscription);
    assertEquals(subscription.type, "cursor");
    const before = await taskCount(sessionFixture);
    const signedToken = sessionFixture.cookie.slice(
      "better-auth.session_token=".length,
    );
    const separator = signedToken.lastIndexOf(".");
    assert(separator > 0);
    const token = signedToken.slice(0, separator);
    const deleted = await sessionFixture.pgDatabase.query(
      "delete from public.session where token = $1",
      [token],
    );
    assertEquals(deleted.rowCount, 1);
    await sessionFixture.insertDomainEvent({ eventType: "tasks.updated" });
    assertEquals(await taskCount(sessionFixture), before);
    const sessionResult = await closeAfterFrames(sessionClient);
    sessionOutputs.push(...sessionResult.frames, sessionResult.close);
    assertEquals(sessionResult.close.code, 1008);
    const problem = sessionResult.frames.find((frame) =>
      frame.type === "problem"
    );
    assertExists(problem);
    assertEquals(frameCode(problem), "AUTH_INVALID");
    assertEquals(
      sessionResult.frames.some((frame) => frame.type === "events"),
      false,
    );
    assertNoLeaks(sessionOutputs, [
      sessionFixture.cookie,
      sessionFixture.config.auth!.secret,
    ]);
  } finally {
    await sessionClient?.close();
    await closeTestFixture(sessionLease);
  }

  const membershipLease = await openTestFixture();
  const { fixture: membershipFixture } = membershipLease;
  const membershipOutputs: unknown[] = [];
  let membershipClient: WsClient | undefined;
  try {
    membershipClient = requireClient(
      await membershipFixture.connect({ cookie: membershipFixture.cookie }),
    );
    membershipOutputs.push(await nextFrame(membershipClient));
    const subscription = await sendStableFrame(
      membershipFixture,
      membershipClient,
      JSON.stringify({
        type: "subscribe",
        requestId: REQUEST_ID(),
        scopes: [{ type: "task", id: membershipFixture.taskId }],
        after: null,
      }),
    );
    membershipOutputs.push(subscription);
    assertEquals(subscription.type, "cursor");
    await membershipFixture.pgDatabase.query(
      `update bakery.organization_memberships
          set status = 'inactive', updated_at = current_timestamp,
              version = version + 1
        where organization_id = $1 and principal_id = $2`,
      [membershipFixture.organizationId, membershipFixture.principalId],
    );
    await membershipFixture.insertDomainEvent({ eventType: "tasks.updated" });
    const membershipResult = await closeAfterFrames(membershipClient);
    membershipOutputs.push(...membershipResult.frames, membershipResult.close);
    assertEquals(membershipResult.close.code, 1008);
    const problem = membershipResult.frames.find((frame) =>
      frame.type === "problem"
    );
    assertExists(problem);
    assertEquals(frameCode(problem), "AUTH_FORBIDDEN");
    assertEquals(
      membershipResult.frames.some((frame) => frame.type === "events"),
      false,
    );
    assertNoLeaks(membershipOutputs, [
      membershipFixture.cookie,
      membershipFixture.config.auth!.secret,
    ]);
  } finally {
    await membershipClient?.close();
    await closeTestFixture(membershipLease);
  }
});

Deno.test("session loss on the first subscribe closes with policy violation", async () => {
  const lease = await openTestFixture();
  const { fixture } = lease;
  let client: WsClient | undefined;
  try {
    client = requireClient(await fixture.connect({ cookie: fixture.cookie }));
    assertEquals((await nextFrame(client)).type, "hello");
    const signedToken = fixture.cookie.slice(
      "better-auth.session_token=".length,
    );
    const separator = signedToken.lastIndexOf(".");
    assert(separator > 0);
    const token = signedToken.slice(0, separator);
    await fixture.pgDatabase.query(
      "delete from public.session where token = $1",
      [token],
    );
    await client.send(
      JSON.stringify({
        type: "subscribe",
        requestId: REQUEST_ID(),
        scopes: [{ type: "task", id: fixture.taskId }],
        after: null,
      }),
    );
    const problem = await nextFrame(client);
    assertEquals(problem.type, "problem");
    assertEquals(frameCode(problem), "AUTH_INVALID");
    const close = await client.next(1_000);
    assert(typeof close !== "string");
    if (typeof close === "string") throw new Error("CLOSE_FRAME_REQUIRED");
    assertEquals(close.code, 1008);
  } finally {
    await client?.close();
    await closeTestFixture(lease);
  }
});

Deno.test("scope deletion emits one current reset and closes the live socket", async () => {
  const lease = await openTestFixture();
  const { fixture } = lease;
  let client: WsClient | undefined;
  try {
    client = requireClient(await fixture.connect({ cookie: fixture.cookie }));
    assertEquals((await nextFrame(client)).type, "hello");
    await client.send(
      JSON.stringify({
        type: "subscribe",
        requestId: REQUEST_ID(),
        scopes: [{ type: "task", id: fixture.taskId }],
        after: null,
      }),
    );
    assertEquals((await nextFrame(client)).type, "cursor");
    // Revoke the scope first, then advance the clock: the live loop only
    // re-authorizes on a highwater advance (or heartbeat), so this order is
    // deterministic and the reset must report the advanced clock. The fixture
    // has no events yet, so the clock row is created here (highwater 0 -> 1).
    await fixture.pgDatabase.query(
      "delete from bakery.tasks where id = $1",
      [fixture.taskId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.event_clock (organization_id, stream, next_seq)
       values ($1, 'domain_events', 2)
       on conflict (organization_id, stream) do update
         set next_seq = bakery.event_clock.next_seq + 1`,
      [fixture.organizationId],
    );
    const clock = await fixture.pgDatabase.query<{
      highwater: string;
      retainedFrom: string;
    }>(
      `select (next_seq - 1)::text as highwater,
              retained_from_seq::text as "retainedFrom"
         from bakery.event_clock
        where organization_id = $1 and stream = 'domain_events'`,
      [fixture.organizationId],
    );
    const currentClock = clock.rows[0];
    assertExists(currentClock);
    const result = await closeAfterFrames(client);
    const resets = result.frames.filter((frame) =>
      frame.type === "reset_required"
    );
    assertEquals(resets.length, 1);
    const reset = resets[0];
    assertExists(reset);
    assertEquals(reset.reason, "scope_revoked");
    assertEquals(reset.highwater, currentClock.highwater);
    assertEquals(reset.retainedFrom, currentClock.retainedFrom);
    assertEquals(result.close.code, 1008);
  } finally {
    await client?.close();
    await closeTestFixture(lease);
  }
});

Deno.test("events cursor is bound to the issuing principal and the ninth connection is rate limited", async () => {
  const lease = await openTestFixture();
  const { fixture } = lease;
  const outputs: unknown[] = [];
  const clients: WsClient[] = [];
  let secondary: SecondaryIdentity | undefined;
  try {
    secondary = await createSecondaryIdentity(fixture);
    const first = requireClient(
      await fixture.connect({ cookie: fixture.cookie }),
    );
    clients.push(first);
    outputs.push(await nextFrame(first));
    const cursorFrame = await sendStableFrame(
      fixture,
      first,
      JSON.stringify({
        type: "subscribe",
        requestId: REQUEST_ID(),
        scopes: [{ type: "task", id: fixture.taskId }],
        after: null,
      }),
    );
    outputs.push(cursorFrame);
    assertEquals(cursorFrame.type, "cursor");
    assert(typeof cursorFrame.cursor === "string");
    await first.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    clients.splice(clients.indexOf(first), 1);

    const secondaryClient = requireClient(
      await fixture.connect({ cookie: secondary.cookie }),
    );
    clients.push(secondaryClient);
    outputs.push(await nextFrame(secondaryClient));
    const invalidCursor = await sendStableFrame(
      fixture,
      secondaryClient,
      JSON.stringify({
        type: "resume",
        requestId: REQUEST_ID(),
        cursor: cursorFrame.cursor,
      }),
    );
    outputs.push(invalidCursor);
    assertEquals(frameCode(invalidCursor), "INVALID_CURSOR");
    await secondaryClient.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    clients.splice(clients.indexOf(secondaryClient), 1);

    const attempts = await Promise.all(
      Array.from(
        { length: 9 },
        () => fixture.connect({ cookie: fixture.cookie }),
      ),
    );
    const concurrentClients = attempts.filter(
      (value): value is WsClient => !isHandshakeFailure(value),
    );
    const concurrentFailures = attempts.filter(isHandshakeFailure);
    clients.push(...concurrentClients);
    outputs.push(...await Promise.all(concurrentClients.map(nextFrame)));
    assertEquals(concurrentClients.length, 8);
    assertEquals(concurrentFailures.length, 1);
    const ninth = concurrentFailures[0];
    assertExists(ninth);
    outputs.push(ninth.body);
    assertEquals(ninth.status, 429);
    assertEquals(bodyCode(ninth.body), "RATE_LIMITED");

    assertNoLeaks(outputs, [
      fixture.cookie,
      secondary.cookie,
      fixture.config.auth!.secret,
    ]);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await closeTestFixture(
      lease,
      secondary ? [secondary.email] : [],
    );
  }
});

Deno.test("events cursor rejects a different organization binding", async () => {
  const lease = await openTestFixture();
  const { fixture } = lease;
  const outputs: unknown[] = [];
  const clients: WsClient[] = [];
  let otherOrganization: OtherOrganizationTask | undefined;
  try {
    otherOrganization = await createOtherOrganizationTask(fixture);
    const first = requireClient(
      await fixture.connect({ cookie: fixture.cookie }),
    );
    clients.push(first);
    outputs.push(await nextFrame(first));
    const issued = await sendStableFrame(
      fixture,
      first,
      JSON.stringify({
        type: "subscribe",
        requestId: REQUEST_ID(),
        scopes: [{ type: "task", id: fixture.taskId }],
        after: null,
      }),
    );
    outputs.push(issued);
    assertEquals(issued.type, "cursor");
    if (issued.type !== "cursor") throw new Error("CURSOR_FRAME_REQUIRED");

    const other = requireClient(
      await fixture.connect({
        cookie: fixture.cookie,
        organizationId: otherOrganization.organizationId,
      }),
    );
    clients.push(other);
    outputs.push(await nextFrame(other));
    const invalidCursor = await sendStableFrame(
      fixture,
      other,
      JSON.stringify({
        type: "resume",
        requestId: REQUEST_ID(),
        cursor: issued.cursor,
      }),
    );
    outputs.push(invalidCursor);
    assertEquals(frameCode(invalidCursor), "INVALID_CURSOR");
    assertEquals(hasOutputType(outputs, "events"), false);
    assertNoLeaks(outputs, [fixture.cookie, fixture.config.auth!.secret]);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    try {
      if (otherOrganization) {
        await fixture.pgDatabase.query(
          "delete from bakery.organizations where id = $1",
          [otherOrganization.organizationId],
        );
      }
    } finally {
      await closeTestFixture(lease);
    }
  }
});
