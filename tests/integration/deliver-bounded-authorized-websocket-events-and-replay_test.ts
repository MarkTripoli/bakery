import { assert, assertEquals, assertRejects } from "@std/assert";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  createEventsSocketHandler,
  createEventsSocketRegistry,
  type EventsSocketHandler,
} from "../../apps/server/src/modules/work/events-socket.ts";
import { authTestOrigin, cleanupAuthFixture } from "../helpers/auth.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import {
  assertFrame,
  type EventsSocketFixture,
  openSocketFixture,
} from "../helpers/events-socket.ts";
import {
  connectWebSocket,
  type WebSocketHandshakeFailure,
  type WebSocketNext,
  type WsClient,
} from "../helpers/ws-client.ts";

type QueryConfig = Parameters<PgTransactionClient["query"]>[0];
type QueryResultRow = Awaited<
  ReturnType<PgTransactionClient["query"]>
>["rows"][number];

type WireEvent = {
  readonly id: string;
  readonly sequence: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly taskId: string | null;
  readonly repositoryId: string | null;
  readonly payload: Record<string, unknown>;
  readonly conversationId: string | null;
};

type WireFrame =
  | {
    readonly type: "hello";
    readonly protocolVersion: number;
    readonly connectionId: string;
    readonly highwater: string;
    readonly retainedFrom: string;
  }
  | {
    readonly type: "events";
    readonly requestId: string;
    readonly events: readonly WireEvent[];
    readonly highwater: string;
  }
  | {
    readonly type: "cursor";
    readonly requestId: string;
    readonly cursor: string;
    readonly highwater: string;
  }
  | {
    readonly type: "problem";
    readonly requestId: string;
    readonly problem: {
      readonly code: string;
      readonly [key: string]: unknown;
    };
  }
  | {
    readonly type: "reset_required";
    readonly requestId: string;
    readonly reason: "cursor_expired" | "scope_revoked";
    readonly retainedFrom: string;
    readonly highwater: string;
  };
const databaseOrganizationHeader = "Bakery-Organization-Id";
const slowPeerHeader = "x-test-slow-peer";
const bufferedPeerHeader = "x-test-buffered-peer";
const textEncoder = new TextEncoder();

/** Models a peer that never reads: every sent byte stays in `bufferedAmount`. */
function neverDrain(socket: WebSocket): void {
  let buffered = 0;
  const send = socket.send.bind(socket);
  Object.defineProperties(socket, {
    bufferedAmount: { configurable: true, get: () => buffered },
    send: {
      configurable: true,
      value: (data: string) => {
        buffered += textEncoder.encode(data).byteLength;
        send(data);
      },
    },
  });
}

type BufferedPeer = {
  fill(bytes: number): void;
  drain(): void;
};

function bufferedPeer(
  socket: WebSocket,
  afterSend?: (data: string) => void,
): BufferedPeer {
  let buffered = 0;
  const send = socket.send.bind(socket);
  Object.defineProperties(socket, {
    bufferedAmount: { configurable: true, get: () => buffered },
    send: {
      configurable: true,
      value: (data: string) => {
        buffered += textEncoder.encode(data).byteLength;
        send(data);
        afterSend?.(data);
      },
    },
  });
  return {
    fill(bytes) {
      buffered = bytes;
    },
    drain() {
      buffered = 0;
    },
  };
}

type FrameType = WireFrame["type"];

type FrameOfType<Type extends FrameType> = Extract<
  WireFrame,
  { type: Type }
>;

function frameOfType<Type extends FrameType>(
  frame: WireFrame,
  type: Type,
): FrameOfType<Type> {
  if (frame.type !== type) {
    throw new Error(`expected ${type} frame, received ${frame.type}`);
  }
  return frame as FrameOfType<Type>;
}

function connected(value: WsClient | WebSocketHandshakeFailure): WsClient {
  if (!("send" in value)) {
    throw new Error(`websocket handshake failed with ${value.status}`);
  }
  return value;
}

async function nextFrame(
  client: WsClient,
  timeoutMs = 2_000,
): Promise<WireFrame> {
  const value = await client.next(timeoutMs);
  if (typeof value !== "string") {
    throw new Error(`websocket closed with ${value.code}: ${value.reason}`);
  }
  return assertFrame(value) as unknown as WireFrame;
}

async function eventClock(
  fixture: EventsSocketFixture,
): Promise<{ highwater: string; retainedFrom: string }> {
  const result = await fixture.pgDatabase.query<{
    highwater: string;
    retainedFrom: string;
  }>(
    `select (next_seq - 1)::text as highwater,
       retained_from_seq::text as "retainedFrom"
     from bakery.event_clock
     where organization_id = $1 and stream = 'domain_events'`,
    [fixture.organizationId],
  );
  const clock = result.rows[0];
  if (!clock) throw new Error("EVENT_CLOCK_UNAVAILABLE");
  return clock;
}

async function taskRequest(
  fixture: EventsSocketFixture,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", fixture.cookie);
  headers.set(databaseOrganizationHeader, fixture.organizationId);
  headers.set("origin", authTestOrigin);
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, { ...init, headers }),
  );
}

async function closeSocketFixture(
  fixture: EventsSocketFixture,
): Promise<void> {
  try {
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
  } finally {
    await fixture.close();
  }
}

function subscribeFrame(
  requestId: string,
  scopes: readonly {
    type: "application" | "conversation" | "repository" | "task";
    id: string;
  }[],
  after: string | null,
): string {
  return JSON.stringify({ type: "subscribe", requestId, scopes, after });
}

async function waitForRegistrySize(
  registry: { readonly size: number },
  expected: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (registry.size !== expected && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assertEquals(registry.size, expected);
}

type ServedHandler = {
  readonly url: URL;
  shutdown(): Promise<void>;
};

/** Serves a handler built with test limits/seams as the fixture's principal. */
async function serveHandler(
  fixture: EventsSocketFixture,
  handler: EventsSocketHandler,
): Promise<ServedHandler> {
  const principal = {
    principalId: fixture.principalId,
    principalType: "human",
    displayName: "Events Socket",
  };
  let resolvePort: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, (request) => {
    const url = new URL(request.url);
    return handler({
      req: {
        raw: request,
        header: (name) => request.headers.get(name) ?? undefined,
        query: (name) => url.searchParams.get(name) ?? undefined,
      },
      get: (name) => name === "principal" ? principal : undefined,
    });
  });
  const url = new URL(`ws://127.0.0.1:${await listening}/v1/events`);
  url.searchParams.set("organizationId", fixture.organizationId);
  return { url, shutdown: () => server.shutdown() };
}

Deno.test(
  "delivers bounded authorized websocket events and replay cursors",
  async (test) => {
    let fixture: EventsSocketFixture | undefined;
    let slowFixture: EventsSocketFixture | undefined;
    let liveFixture: EventsSocketFixture | undefined;
    try {
      fixture = await openSocketFixture();

      let seedCursor = "";
      let quietCursor = "";
      let latestHighwater = "0";
      let replayedSequence = "";

      await test.step(
        "replays three seeded events after zero in sequence order",
        async () => {
          const seeded = [];
          for (
            const [index, eventType] of [
              "tasks.created",
              "tasks.updated",
              "tasks.updated",
            ].entries()
          ) {
            seeded.push(
              await fixture!.insertDomainEvent({
                eventType,
                aggregateVersion: index + 1,
                payload: {
                  resourceId: fixture!.taskId,
                  resourceVersion: index + 1,
                },
              }),
            );
          }

          assertEquals(
            seeded.map(({ sequence }) => sequence),
            ["1", "2", "3"],
          );
          const client = connected(
            await fixture!.connect({ cookie: fixture!.cookie }),
          );
          const hello = frameOfType(
            await nextFrame(client),
            "hello",
          );
          assertEquals(hello.highwater, seeded.at(-1)?.sequence);
          await client.send(
            subscribeFrame(
              crypto.randomUUID(),
              [{ type: "task", id: fixture!.taskId }],
              "0",
            ),
          );
          const events = frameOfType(
            await nextFrame(client),
            "events",
          );
          assertEquals(
            events.events.map(({ sequence }) => sequence),
            seeded.map(({ sequence }) => sequence),
          );
          assertEquals(
            events.events.map(({ type }) => type),
            ["tasks.created", "tasks.updated", "tasks.updated"],
          );
          const cursor = frameOfType(
            await nextFrame(client),
            "cursor",
          );
          assertEquals(cursor.highwater, seeded.at(-1)?.sequence);
          assert(cursor.cursor.length > 0);
          seedCursor = cursor.cursor;
          latestHighwater = cursor.highwater;
          await client.close();
        },
      );

      await test.step(
        "splits individually valid events by encoded byte budget",
        async () => {
          const after = latestHighwater;
          const seeded = [];
          for (let index = 0; index < 9; index++) {
            seeded.push(
              await fixture!.insertDomainEvent({
                eventType: "tasks.updated",
                aggregateVersion: index + 10,
                payload: {
                  resourceId: fixture!.taskId,
                  resourceVersion: index + 10,
                  padding: "x".repeat(30_000),
                },
              }),
            );
          }
          const client = connected(
            await fixture!.connect({ cookie: fixture!.cookie }),
          );
          frameOfType(await nextFrame(client), "hello");
          const requestId = crypto.randomUUID();
          await client.send(
            subscribeFrame(
              requestId,
              [{ type: "task", id: fixture!.taskId }],
              after,
            ),
          );
          const events: WireEvent[] = [];
          let eventFrames = 0;
          while (true) {
            const frame = await nextFrame(client);
            if (frame.type === "events") {
              eventFrames++;
              events.push(...frame.events);
              continue;
            }
            const cursor = frameOfType(frame, "cursor");
            assertEquals(cursor.requestId, requestId);
            assertEquals(cursor.highwater, seeded.at(-1)?.sequence);
            break;
          }
          assert(eventFrames > 1);
          assertEquals(
            events.map(({ sequence }) => sequence),
            seeded.map(({ sequence }) => sequence),
          );
          latestHighwater = seeded.at(-1)?.sequence ?? latestHighwater;
          await client.close();
        },
      );

      await test.step(
        "serializes concurrent subscriptions and keeps the latest scopes",
        async () => {
          const client = connected(
            await fixture!.connect({ cookie: fixture!.cookie }),
          );
          frameOfType(await nextFrame(client), "hello");
          const firstRequestId = crypto.randomUUID();
          const secondRequestId = crypto.randomUUID();
          await client.send(
            subscribeFrame(
              firstRequestId,
              [{ type: "application", id: fixture!.applicationId }],
              latestHighwater,
            ),
          );
          await client.send(
            subscribeFrame(
              secondRequestId,
              [{ type: "task", id: fixture!.taskId }],
              latestHighwater,
            ),
          );
          const cursors: string[] = [];
          while (cursors.length < 2) {
            const cursor = frameOfType(await nextFrame(client), "cursor");
            cursors.push(cursor.requestId);
          }
          assertEquals(cursors, [firstRequestId, secondRequestId]);
          const inserted = await fixture!.insertDomainEvent({
            eventType: "tasks.updated",
            aggregateVersion: 20,
            payload: {
              resourceId: fixture!.taskId,
              resourceVersion: 20,
            },
          });
          const events = frameOfType(await nextFrame(client, 2_000), "events");
          assertEquals(events.requestId, secondRequestId);
          assertEquals(
            events.events.map(({ sequence }) => sequence),
            [inserted.sequence],
          );
          latestHighwater = inserted.sequence;
          await client.close();
        },
      );

      await test.step(
        "advances a quiet filtered cursor to the inspected highwater",
        async () => {
          const after = latestHighwater;
          const unrelated = await fixture!.insertDomainEvent({
            eventType: "organizations.updated",
            taskId: null,
            conversationId: null,
            aggregateId: crypto.randomUUID(),
            payload: { resourceId: crypto.randomUUID() },
          });
          const client = connected(
            await fixture!.connect({ cookie: fixture!.cookie }),
          );
          frameOfType(await nextFrame(client), "hello");
          await client.send(
            subscribeFrame(
              crypto.randomUUID(),
              [{ type: "task", id: fixture!.taskId }],
              after,
            ),
          );
          const cursor = frameOfType(await nextFrame(client), "cursor");
          assertEquals(cursor.highwater, unrelated.sequence);
          quietCursor = cursor.cursor;
          await client.close();

          await fixture!.pgDatabase.query(
            `update bakery.event_clock
             set retained_from_seq = next_seq
             where organization_id = $1 and stream = 'domain_events'`,
            [fixture!.organizationId],
          );
          try {
            const resumed = connected(
              await fixture!.connect({
                cookie: fixture!.cookie,
                after: cursor.cursor,
              }),
            );
            frameOfType(await nextFrame(resumed), "hello");
            const resumedCursor = frameOfType(
              await nextFrame(resumed),
              "cursor",
            );
            assertEquals(resumedCursor.type, "cursor");
            await resumed.close();
          } finally {
            await fixture!.pgDatabase.query(
              `update bakery.event_clock
               set retained_from_seq = 1
               where organization_id = $1 and stream = 'domain_events'`,
              [fixture!.organizationId],
            );
          }
          latestHighwater = unrelated.sequence;
        },
      );

      await test.step(
        "publishes a task creation made through the live HTTP app",
        async () => {
          const client = connected(
            await fixture!.connect({ cookie: fixture!.cookie }),
          );
          frameOfType(await nextFrame(client), "hello");
          await client.send(
            subscribeFrame(
              crypto.randomUUID(),
              [{ type: "application", id: fixture!.applicationId }],
              null,
            ),
          );
          frameOfType(await nextFrame(client), "cursor");

          const response = await taskRequest(fixture!, "/v1/tasks", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Idempotency-Key": `events-${crypto.randomUUID()}`,
            },
            body: JSON.stringify({
              applicationId: fixture!.applicationId,
              taskType: "feature",
              title: `Live events task ${crypto.randomUUID()}`,
            }),
          });
          assertEquals(response.status, 201, await response.clone().text());
          const created = await response.json() as { id: string };

          const events = frameOfType(
            await nextFrame(client, 2_000),
            "events",
          );
          assertEquals(events.events.length, 1);
          assertEquals(events.events[0]?.type, "tasks.created");
          assertEquals(events.events[0]?.payload.resourceId, created.id);
          const cursor = frameOfType(
            await nextFrame(client),
            "cursor",
          );
          assert(BigInt(cursor.highwater) > BigInt(latestHighwater));
          latestHighwater = cursor.highwater;
          await client.close();
        },
      );

      await test.step(
        "closes the sync highwater boundary without a gap or duplicate",
        async () => {
          const response = await taskRequest(
            fixture!,
            `/v1/sync?scopeType=application&scopeId=${fixture!.applicationId}`,
          );
          assertEquals(response.status, 200, await response.clone().text());
          const snapshot = await response.json() as {
            highwater: string;
            events: Array<{ sequence: string }>;
          };
          assertEquals(snapshot.events, []);
          const highwater = snapshot.highwater;
          const inserted = await fixture!.insertDomainEvent({
            eventType: "tasks.updated",
            aggregateVersion: 4,
            payload: {
              resourceId: fixture!.taskId,
              resourceVersion: 4,
            },
          });
          assertEquals(BigInt(inserted.sequence), BigInt(highwater) + 1n);

          const client = connected(
            await fixture!.connect({ cookie: fixture!.cookie }),
          );
          frameOfType(await nextFrame(client), "hello");
          await client.send(
            subscribeFrame(
              crypto.randomUUID(),
              [{ type: "application", id: fixture!.applicationId }],
              highwater,
            ),
          );
          const events = frameOfType(
            await nextFrame(client),
            "events",
          );
          assertEquals(
            events.events.map(({ sequence }) => sequence),
            [inserted.sequence],
          );
          const cursor = frameOfType(
            await nextFrame(client),
            "cursor",
          );
          assertEquals(cursor.highwater, inserted.sequence);
          latestHighwater = cursor.highwater;
          replayedSequence = inserted.sequence;
          await client.close();
        },
      );

      await test.step(
        "reconnects with the issued cursor and replays exactly the missed event",
        async () => {
          // quietCursor was issued for the task scope before the HTTP-created
          // task (a different task) and the boundary event; only the latter
          // is in scope, so the resume must replay exactly that one event.
          const client = connected(
            await fixture!.connect({
              cookie: fixture!.cookie,
              after: quietCursor,
            }),
          );
          frameOfType(await nextFrame(client), "hello");
          const events = frameOfType(
            await nextFrame(client),
            "events",
          );
          assertEquals(
            events.events.map(({ sequence }) => sequence),
            [replayedSequence],
          );
          const cursor = frameOfType(
            await nextFrame(client),
            "cursor",
          );
          assertEquals(cursor.highwater, latestHighwater);
          await client.close();
        },
      );

      await test.step(
        "orders task and conversation scopes by one organization sequence",
        async () => {
          const after = latestHighwater;
          const taskEvent = await fixture!.insertDomainEvent({
            eventType: "tasks.updated",
            conversationId: null,
            aggregateId: fixture!.taskId,
            aggregateVersion: 5,
            payload: {
              resourceId: fixture!.taskId,
              resourceVersion: 5,
            },
          });
          const conversationEvent = await fixture!.insertDomainEvent({
            eventType: "conversation.turn_changed",
            taskId: null,
            aggregateId: fixture!.conversationId,
            aggregateVersion: 1,
            payload: {
              resourceId: fixture!.conversationId,
              resourceVersion: 1,
              conversationId: fixture!.conversationId,
              triggerMessageId: crypto.randomUUID(),
              status: "active",
            },
          });
          const client = connected(
            await fixture!.connect({ cookie: fixture!.cookie }),
          );
          frameOfType(await nextFrame(client), "hello");
          await client.send(
            subscribeFrame(
              crypto.randomUUID(),
              [
                { type: "task", id: fixture!.taskId },
                { type: "conversation", id: fixture!.conversationId },
              ],
              after,
            ),
          );
          const events = frameOfType(
            await nextFrame(client),
            "events",
          );
          assertEquals(
            events.events.map(({ sequence }) => sequence),
            [taskEvent.sequence, conversationEvent.sequence],
          );
          const cursor = frameOfType(
            await nextFrame(client),
            "cursor",
          );
          assertEquals(cursor.highwater, conversationEvent.sequence);
          latestHighwater = cursor.highwater;
          await client.close();
        },
      );

      await test.step(
        "returns cursor_expired when retention advances beyond the owner highwater",
        async () => {
          const clock = await eventClock(fixture!);
          const retainedFrom = (BigInt(clock.highwater) + 1n).toString();
          await fixture!.pgDatabase.query(
            `update bakery.event_clock
             set retained_from_seq = next_seq
             where organization_id = $1 and stream = 'domain_events'`,
            [fixture!.organizationId],
          );
          try {
            const client = connected(
              await fixture!.connect({
                cookie: fixture!.cookie,
                after: seedCursor,
              }),
            );
            frameOfType(await nextFrame(client), "hello");
            const reset = frameOfType(
              await nextFrame(client),
              "reset_required",
            );
            assertEquals(reset.reason, "cursor_expired");
            assertEquals(reset.retainedFrom, retainedFrom);
            assertEquals(reset.highwater, clock.highwater);
            await client.close();
          } finally {
            await fixture!.pgDatabase.query(
              `update bakery.event_clock
               set retained_from_seq = 1
               where organization_id = $1 and stream = 'domain_events'`,
              [fixture!.organizationId],
            );
          }
        },
      );

      await test.step(
        "emits one live retention reset and stops polling",
        async () => {
          const client = connected(
            await fixture!.connect({ cookie: fixture!.cookie }),
          );
          frameOfType(await nextFrame(client), "hello");
          await client.send(
            subscribeFrame(
              crypto.randomUUID(),
              [{ type: "task", id: fixture!.taskId }],
              null,
            ),
          );
          frameOfType(await nextFrame(client), "cursor");
          await fixture!.insertDomainEvent({
            eventType: "tasks.updated",
            aggregateVersion: 21,
            payload: {
              resourceId: fixture!.taskId,
              resourceVersion: 21,
            },
          });
          await fixture!.pgDatabase.query(
            `update bakery.event_clock
             set retained_from_seq = next_seq
             where organization_id = $1 and stream = 'domain_events'`,
            [fixture!.organizationId],
          );
          try {
            const reset = frameOfType(
              await nextFrame(client, 2_000),
              "reset_required",
            );
            assertEquals(reset.reason, "cursor_expired");
            let followup: string | { code: number; reason: string } | undefined;
            try {
              followup = await client.next(800);
            } catch {
              followup = undefined;
            }
            if (typeof followup === "string") {
              const parsed = JSON.parse(followup) as { type?: string };
              assert(parsed.type !== "reset_required");
            }
          } finally {
            await fixture!.pgDatabase.query(
              `update bakery.event_clock
               set retained_from_seq = 1
               where organization_id = $1 and stream = 'domain_events'`,
              [fixture!.organizationId],
            );
            await client.close();
          }
        },
      );

      await closeSocketFixture(fixture!);
      fixture = undefined;

      await test.step(
        "closes a slow consumer with 1008 and removes it from the registry",
        async () => {
          slowFixture = await openSocketFixture();
          for (let index = 0; index < 10; index++) {
            await slowFixture.insertDomainEvent({
              eventType: "tasks.updated",
              aggregateVersion: index + 1,
              payload: {
                resourceId: slowFixture.taskId,
                resourceVersion: index + 1,
                padding: "x".repeat(12_000),
              },
            });
          }
          // Loopback drains every frame the server can produce here, so the
          // handler is driven directly with a socket whose bufferedAmount
          // models a peer that never reads: every sent byte stays buffered.
          const registry = createEventsSocketRegistry();
          let retentionTriggerArmed = false;
          let retentionTrigger: (() => Promise<void>) | undefined;
          const originalConnect = slowFixture.runtimePgDatabase.connect.bind(
            slowFixture.runtimePgDatabase,
          );
          const interposedDatabase = {
            connect: async () => {
              const client = await originalConnect();
              const originalQuery = client.query.bind(client);
              const interceptedQuery = async <
                R extends QueryResultRow = QueryResultRow,
              >(
                queryTextOrConfig: QueryConfig,
                values?: unknown[],
              ) => {
                const result = await originalQuery<R>(
                  queryTextOrConfig,
                  values,
                );
                if (
                  retentionTriggerArmed &&
                  typeof queryTextOrConfig === "string" &&
                  queryTextOrConfig.includes(
                    "from (values ($1::uuid)) as requested",
                  )
                ) {
                  retentionTriggerArmed = false;
                  await retentionTrigger?.();
                }
                return result;
              };
              return new Proxy(client, {
                get(target, property, receiver) {
                  if (property === "query") return interceptedQuery;
                  return Reflect.get(target, property, receiver);
                },
              });
            },
          } as PgDatabase;
          let bufferedPeerState: BufferedPeer | undefined;
          const handler = createEventsSocketHandler({
            database: interposedDatabase,
            store: createPostgresAuthPersistence(slowFixture.runtimePgDatabase),
            secret: slowFixture.config.auth!.secret,
            publicBaseUrl: slowFixture.config.publicBaseUrl,
            registry,
            limits: {
              maxBufferedBytes: 64 * 1024,
              backpressureGraceMs: 200,
              maxEventsPerFrame: 1,
              maxReplayFramesPerTick: 10,
              pollIntervalMs: 50,
            },
            upgradeWebSocket(request, options) {
              // Request headers are unreadable once upgraded.
              const slow = request.headers.get(slowPeerHeader) === "1";
              const mode = request.headers.get(bufferedPeerHeader);
              const upgraded = Deno.upgradeWebSocket(request, options);
              if (slow) {
                neverDrain(upgraded.socket);
              } else if (
                mode === "cursor" || mode === "page" || mode === "control" ||
                mode === "reset"
              ) {
                let filled = false;
                const peerState: BufferedPeer = bufferedPeer(
                  upgraded.socket,
                  (data) => {
                    const type = JSON.parse(data).type;
                    const shouldFill = mode === "reset"
                      ? type === "cursor"
                      : type === "hello";
                    if (filled || !shouldFill) return;
                    filled = true;
                    peerState.fill(
                      mode === "reset" ? 64 * 1024 - 1 : 64 * 1024 + 1,
                    );
                  },
                );
                bufferedPeerState = peerState;
              }
              return upgraded;
            },
          });
          const served = await serveHandler(slowFixture, handler);
          const clients: WsClient[] = [];
          try {
            const url = served.url;
            const connect = async (
              slow: boolean,
              mode?: "cursor" | "page" | "control" | "reset",
            ): Promise<WsClient> => {
              const headers = new Headers({ cookie: slowFixture!.cookie });
              if (slow) headers.set(slowPeerHeader, "1");
              if (mode) headers.set(bufferedPeerHeader, mode);
              const client = connected(
                await connectWebSocket(url, { headers }),
              );
              clients.push(client);
              return client;
            };

            const client = await connect(true);
            frameOfType(await nextFrame(client), "hello");
            await waitForRegistrySize(registry, 1);
            await client.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: slowFixture.taskId }],
                "0",
              ),
            );
            let slowEvents = 0;
            let close: { code: number; reason: string } | undefined;
            while (!close) {
              const value = await client.next(2_000);
              if (typeof value !== "string") {
                close = value;
                break;
              }
              const frame = frameOfType(
                assertFrame(value) as unknown as WireFrame,
                "events",
              );
              slowEvents += frame.events.length;
            }
            assertEquals(close.code, 1008);
            assertEquals(close.reason, "backpressure");
            // Frames past the budget are withheld: 5 × ~12 KiB fit in 64 KiB.
            assert(slowEvents > 0 && slowEvents < 10, `${slowEvents} events`);
            await waitForRegistrySize(registry, 0);

            const replay = await connect(false);
            frameOfType(await nextFrame(replay), "hello");
            await replay.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: slowFixture.taskId }],
                "10",
              ),
            );
            frameOfType(await nextFrame(replay), "cursor");
            const inserted = await slowFixture.insertDomainEvent({
              eventType: "tasks.updated",
              aggregateVersion: 11,
              payload: {
                resourceId: slowFixture.taskId,
                resourceVersion: 11,
              },
            });
            retentionTrigger = async () => {
              await withPgTransaction(
                slowFixture!.pgDatabase,
                async (transaction) => {
                  await transaction.query(
                    `update bakery.event_clock
                        set retained_from_seq = next_seq
                      where organization_id = $1 and stream = 'domain_events'`,
                    [slowFixture!.organizationId],
                  );
                  await transaction.query(
                    `delete from bakery.domain_events
                      where organization_id = $1
                        and organization_sequence = $2`,
                    [slowFixture!.organizationId, inserted.sequence],
                  );
                },
              );
            };
            retentionTriggerArmed = true;
            try {
              const reset = frameOfType(
                await nextFrame(replay, 2_000),
                "reset_required",
              );
              assertEquals(reset.reason, "cursor_expired");
              assertEquals(reset.highwater, inserted.sequence);
              assertEquals(
                reset.retainedFrom,
                (BigInt(inserted.sequence) + 1n).toString(),
              );
            } finally {
              retentionTriggerArmed = false;
              retentionTrigger = undefined;
              await slowFixture.pgDatabase.query(
                `update bakery.event_clock
                    set retained_from_seq = 1
                  where organization_id = $1 and stream = 'domain_events'`,
                [slowFixture.organizationId],
              );
              await replay.close();
            }

            const cursorPeer = await connect(false, "cursor");
            frameOfType(await nextFrame(cursorPeer), "hello");
            await cursorPeer.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: slowFixture.taskId }],
                "10",
              ),
            );
            await assertRejects(
              () => cursorPeer.next(50),
              Error,
              "WEBSOCKET_READ_TIMEOUT",
            );
            bufferedPeerState?.drain();
            const recoveredCursor = frameOfType(
              await nextFrame(cursorPeer, 1_000),
              "cursor",
            );
            assertEquals(recoveredCursor.highwater, inserted.sequence);
            await cursorPeer.close();

            const controlPeer = await connect(false, "control");
            const controlHello = frameOfType(
              await nextFrame(controlPeer),
              "hello",
            );
            await controlPeer.send(
              JSON.stringify({
                type: "ping",
                requestId: crypto.randomUUID(),
              }),
            );
            await controlPeer.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: slowFixture.taskId }],
                "10",
              ),
            );
            await assertRejects(
              () => controlPeer.next(50),
              Error,
              "WEBSOCKET_READ_TIMEOUT",
            );
            bufferedPeerState?.drain();

            const controlPing = await nextFrame(controlPeer);
            assertEquals(controlPing.type, "ping");
            const controlCursor = frameOfType(
              await nextFrame(controlPeer),
              "cursor",
            );
            assertEquals(controlCursor.highwater, controlHello.highwater);
            await controlPeer.close();

            const pagePeer = await connect(false, "page");
            const pageHello = frameOfType(await nextFrame(pagePeer), "hello");
            await pagePeer.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: slowFixture.taskId }],
                "9",
              ),
            );
            await assertRejects(
              () => pagePeer.next(50),
              Error,
              "WEBSOCKET_READ_TIMEOUT",
            );
            bufferedPeerState?.drain();
            const pageSequences: string[] = [];
            let pageCursor: Extract<WireFrame, { type: "cursor" }> | undefined;
            while (!pageCursor) {
              const frame = await nextFrame(pagePeer, 1_000);
              if (frame.type === "events") {
                pageSequences.push(
                  ...frame.events.map(({ sequence }) => sequence),
                );
              } else {
                pageCursor = frameOfType(frame, "cursor");
              }
            }
            assertEquals(
              pageSequences,
              ["10"],
            );
            assertEquals(pageCursor.highwater, pageHello.highwater);
            await pagePeer.close();

            const resetPeer = await connect(false, "reset");
            frameOfType(await nextFrame(resetPeer), "hello");
            await resetPeer.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: slowFixture.taskId }],
                inserted.sequence,
              ),
            );
            frameOfType(await nextFrame(resetPeer), "cursor");
            // Insert and retention advance commit together so no tick can pair
            // the new highwater with the old retention bound.
            const resetEvent = await slowFixture.insertDomainEvent({
              eventType: "tasks.updated",
              aggregateVersion: 12,
              payload: {
                resourceId: slowFixture.taskId,
                resourceVersion: 12,
              },
              expired: true,
            });
            try {
              const resetFrames: WireFrame[] = [];
              let terminal: { code: number; reason: string } | undefined;
              while (!terminal) {
                const value = await resetPeer.next(2_000);
                if (typeof value === "string") {
                  resetFrames.push(
                    assertFrame(value) as unknown as WireFrame,
                  );
                } else {
                  terminal = value;
                }
              }
              if (!terminal) throw new Error("RESET_CLOSE_REQUIRED");
              assertEquals(
                resetFrames.some((frame) => frame.type === "reset_required"),
                false,
              );
              assertEquals(terminal.code, 1008);
              assertEquals(terminal.reason, "backpressure");
              await waitForRegistrySize(registry, 0);
            } finally {
              await slowFixture.pgDatabase.query(
                `delete from bakery.domain_events
                  where organization_id = $1
                    and organization_sequence = $2`,
                [slowFixture.organizationId, resetEvent.sequence],
              );
              await slowFixture.pgDatabase.query(
                `update bakery.event_clock
                    set retained_from_seq = 1
                  where organization_id = $1 and stream = 'domain_events'`,
                [slowFixture.organizationId],
              );
              await resetPeer.close();
            }

            const recoveryPeer = await connect(false, "reset");
            frameOfType(await nextFrame(recoveryPeer), "hello");
            const recoveryClock = await eventClock(slowFixture);
            await recoveryPeer.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: slowFixture.taskId }],
                recoveryClock.highwater,
              ),
            );
            frameOfType(await nextFrame(recoveryPeer), "cursor");
            const recoveryEvent = await slowFixture.insertDomainEvent({
              eventType: "tasks.updated",
              aggregateVersion: 13,
              payload: {
                resourceId: slowFixture.taskId,
                resourceVersion: 13,
              },
              expired: true,
            });
            try {
              await assertRejects(
                () => recoveryPeer.next(50),
                Error,
                "WEBSOCKET_READ_TIMEOUT",
              );
              bufferedPeerState?.drain();
              const reset = frameOfType(
                await nextFrame(recoveryPeer, 1_000),
                "reset_required",
              );
              assertEquals(reset.reason, "cursor_expired");
              assertEquals(registry.size, 1);
              await recoveryPeer.close();
            } finally {
              await slowFixture.pgDatabase.query(
                `delete from bakery.domain_events
                  where organization_id = $1
                    and organization_sequence = $2`,
                [slowFixture.organizationId, recoveryEvent.sequence],
              );
              await slowFixture.pgDatabase.query(
                `update bakery.event_clock
                    set retained_from_seq = 1
                  where organization_id = $1 and stream = 'domain_events'`,
                [slowFixture.organizationId],
              );
              await recoveryPeer.close();
            }

            const draining = await connect(false);
            frameOfType(await nextFrame(draining), "hello");
            await draining.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: slowFixture.taskId }],
                "0",
              ),
            );
            let drainedEvents = 0;
            while (true) {
              const frame = await nextFrame(draining);
              if (frame.type === "events") {
                drainedEvents += frame.events.length;
                continue;
              }
              frameOfType(frame, "cursor");
              break;
            }
            assertEquals(drainedEvents, 10);
            await draining.send(
              JSON.stringify({ type: "ping", requestId: crypto.randomUUID() }),
            );
            assertEquals((await nextFrame(draining)).type, "ping");
            await draining.close();
            await waitForRegistrySize(registry, 0);
            const revokedPeer = await connect(false, "page");
            frameOfType(await nextFrame(revokedPeer), "hello");
            await revokedPeer.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: slowFixture.taskId }],
                "9",
              ),
            );
            await assertRejects(
              () => revokedPeer.next(50),
              Error,
              "WEBSOCKET_READ_TIMEOUT",
            );
            const signedToken = slowFixture.cookie.slice(
              "better-auth.session_token=".length,
            );
            const separator = signedToken.lastIndexOf(".");
            assert(separator > 0);
            const token = signedToken.slice(0, separator);
            const deleted = await slowFixture.pgDatabase.query(
              "delete from public.session where token = $1",
              [token],
            );
            assertEquals(deleted.rowCount, 1);
            bufferedPeerState?.drain();
            const revokedFrames: WireFrame[] = [];
            let revokedClose: { code: number; reason: string } | undefined;
            while (!revokedClose) {
              const value = await revokedPeer.next(2_000);
              if (typeof value === "string") {
                revokedFrames.push(
                  assertFrame(value) as unknown as WireFrame,
                );
              } else {
                revokedClose = value;
              }
            }
            if (!revokedClose) throw new Error("AUTH_CLOSE_REQUIRED");
            const problem = revokedFrames.find((frame) =>
              frame.type === "problem"
            );
            assert(problem && problem.type === "problem");
            assertEquals(problem.problem.code, "AUTH_INVALID");
            assertEquals(
              revokedFrames.some((frame) => frame.type === "events"),
              false,
            );
            assertEquals(revokedClose.code, 1008);
            await waitForRegistrySize(registry, 0);
            await revokedPeer.close();
          } finally {
            await Promise.allSettled(clients.map((client) => client.close()));
            await served.shutdown();
          }
        },
      );

      // The slow-consumer step revoked slowFixture's session; one fixture
      // (superuser) may exist at a time, so replace it.
      await closeSocketFixture(slowFixture!);
      slowFixture = undefined;

      await test.step(
        "retries a withheld page at poll cadence once the peer drains",
        async () => {
          liveFixture = await openSocketFixture();
          const inserted = await liveFixture.insertDomainEvent({
            eventType: "tasks.updated",
            payload: {
              resourceId: liveFixture.taskId,
              resourceVersion: 1,
              padding: "x".repeat(12_000),
            },
          });
          let peer: BufferedPeer | undefined;
          const handler = createEventsSocketHandler({
            database: liveFixture.runtimePgDatabase,
            store: createPostgresAuthPersistence(liveFixture.runtimePgDatabase),
            secret: liveFixture.config.auth!.secret,
            publicBaseUrl: liveFixture.config.publicBaseUrl,
            limits: {
              maxBufferedBytes: 64 * 1024,
              // Far beyond the assertion window: only the poll retry can deliver.
              backpressureGraceMs: 2_000,
              maxEventsPerFrame: 1,
              pollIntervalMs: 50,
            },
            upgradeWebSocket(request, options) {
              const upgraded = Deno.upgradeWebSocket(request, options);
              let filled = false;
              const state = bufferedPeer(upgraded.socket, (data) => {
                if (filled || JSON.parse(data).type !== "hello") return;
                filled = true;
                state.fill(64 * 1024 + 1);
              });
              peer = state;
              return upgraded;
            },
          });
          const served = await serveHandler(liveFixture, handler);
          let client: WsClient | undefined;
          try {
            client = connected(
              await connectWebSocket(served.url, {
                headers: new Headers({ cookie: liveFixture.cookie }),
              }),
            );
            const hello = frameOfType(await nextFrame(client), "hello");
            await client.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: liveFixture.taskId }],
                "0",
              ),
            );
            const withheld = client;
            await assertRejects(
              () => withheld.next(150),
              Error,
              "WEBSOCKET_READ_TIMEOUT",
            );
            peer?.drain();
            const drainedAt = performance.now();
            const page = frameOfType(await nextFrame(client, 1_000), "events");
            const latencyMs = performance.now() - drainedAt;
            assertEquals(
              page.events.map(({ sequence }) => sequence),
              [inserted.sequence],
            );
            assert(
              latencyMs < 500,
              `withheld page arrived ${latencyMs.toFixed(0)} ms after drain`,
            );
            const cursor = frameOfType(
              await nextFrame(client, 1_000),
              "cursor",
            );
            assertEquals(cursor.highwater, hello.highwater);
          } finally {
            await client?.close();
            await served.shutdown();
          }
        },
      );

      await test.step(
        "judges a second stall by its own grace window",
        async () => {
          const restallFixture = liveFixture!;
          const graceMs = 1_000;
          let peer: BufferedPeer | undefined;
          const handler = createEventsSocketHandler({
            database: restallFixture.runtimePgDatabase,
            store: createPostgresAuthPersistence(
              restallFixture.runtimePgDatabase,
            ),
            secret: restallFixture.config.auth!.secret,
            publicBaseUrl: restallFixture.config.publicBaseUrl,
            limits: {
              maxBufferedBytes: 64 * 1024,
              backpressureGraceMs: graceMs,
              pollIntervalMs: 50,
            },
            upgradeWebSocket(request, options) {
              const upgraded = Deno.upgradeWebSocket(request, options);
              let filled = false;
              const state = bufferedPeer(upgraded.socket, (data) => {
                if (filled || JSON.parse(data).type !== "hello") return;
                filled = true;
                state.fill(64 * 1024 + 1);
              });
              peer = state;
              return upgraded;
            },
          });
          const served = await serveHandler(restallFixture, handler);
          let client: WsClient | undefined;
          try {
            client = connected(
              await connectWebSocket(served.url, {
                headers: new Headers({ cookie: restallFixture.cookie }),
              }),
            );
            const stalled = client;
            const ping = () =>
              JSON.stringify({ type: "ping", requestId: crypto.randomUUID() });
            const stallOneStart = performance.now();
            frameOfType(await nextFrame(stalled), "hello");
            // Stall 1: withheld ping, drained well inside the grace window.
            await stalled.send(ping());
            await assertRejects(
              () => stalled.next(50),
              Error,
              "WEBSOCKET_READ_TIMEOUT",
            );
            peer?.drain();
            assertEquals((await nextFrame(stalled)).type, "ping");
            // Stall 2 begins inside stall 1's original deadline and drains
            // after it; only a fresh per-stall window lets the echo through.
            const midWindow = Promise.withResolvers<void>();
            setTimeout(
              midWindow.resolve,
              Math.max(0, stallOneStart + graceMs * 0.7 - performance.now()),
            );
            await midWindow.promise;
            peer?.fill(64 * 1024 + 1);
            await stalled.send(ping());
            await assertRejects(
              () => stalled.next(graceMs * 0.5),
              Error,
              "WEBSOCKET_READ_TIMEOUT",
            );
            peer?.drain();
            assertEquals((await nextFrame(stalled, 1_000)).type, "ping");
          } finally {
            await client?.close();
            await served.shutdown();
          }
        },
      );

      await test.step(
        "re-authorizes an idle subscription at most once per heartbeat window",
        async () => {
          const idleFixture = liveFixture!;
          const heartbeatMs = 300;
          const store = createPostgresAuthPersistence(
            idleFixture.runtimePgDatabase,
          );
          let sessionLookups = 0;
          const handler = createEventsSocketHandler({
            database: idleFixture.runtimePgDatabase,
            store: new Proxy(store, {
              get(target, property, receiver) {
                if (property !== "findSessionState") {
                  return Reflect.get(target, property, receiver);
                }
                return (token: string) => {
                  sessionLookups += 1;
                  return target.findSessionState(token);
                };
              },
            }),
            secret: idleFixture.config.auth!.secret,
            publicBaseUrl: idleFixture.config.publicBaseUrl,
            limits: { pollIntervalMs: 50, heartbeatMs },
          });
          const served = await serveHandler(idleFixture, handler);
          let client: WsClient | undefined;
          try {
            client = connected(
              await connectWebSocket(served.url, {
                headers: new Headers({ cookie: idleFixture.cookie }),
              }),
            );
            frameOfType(await nextFrame(client), "hello");
            await client.send(
              subscribeFrame(
                crypto.randomUUID(),
                [{ type: "task", id: idleFixture.taskId }],
                null,
              ),
            );
            frameOfType(await nextFrame(client), "cursor");
            sessionLookups = 0;
            const idleWindowMs = 1_000;
            const deadline = Date.now() + idleWindowMs;
            // Only application pings may arrive while the subscription idles.
            for (
              let remaining = idleWindowMs;
              remaining > 0;
              remaining = deadline - Date.now()
            ) {
              let value: WebSocketNext;
              try {
                value = await client.next(remaining);
              } catch (error) {
                if (
                  error instanceof Error &&
                  error.message === "WEBSOCKET_READ_TIMEOUT"
                ) break;
                throw error;
              }
              if (typeof value !== "string") {
                throw new Error(`websocket closed with ${value.code}`);
              }
              assertEquals(
                (assertFrame(value) as unknown as WireFrame).type,
                "ping",
              );
            }
            // Re-authorizations are at least heartbeatMs apart, so a window of
            // idleWindowMs holds at most floor(idleWindowMs / heartbeatMs) + 1.
            assert(
              sessionLookups >= 1,
              "idle subscription never re-authorized",
            );
            assert(
              sessionLookups <= Math.floor(idleWindowMs / heartbeatMs) + 1,
              `${sessionLookups} session lookups in ${idleWindowMs} ms`,
            );
          } finally {
            await client?.close();
            await served.shutdown();
          }
        },
      );
    } finally {
      if (liveFixture) {
        await closeSocketFixture(liveFixture);
        liveFixture = undefined;
      }
      if (slowFixture) {
        await closeSocketFixture(slowFixture);
        slowFixture = undefined;
      }
      if (fixture) {
        await closeSocketFixture(fixture);
        fixture = undefined;
      }
    }
  },
);
