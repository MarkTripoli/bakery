import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ApiProblemError,
  createBakeryClient,
} from "../../packages/contracts/src/client.ts";
import { createPostgresAuthPersistence } from "../../apps/server/src/modules/auth/adapters/postgres.ts";
import {
  createEventsSocketHandler,
  createEventsSocketRegistry,
} from "../../apps/server/src/modules/work/events-socket.ts";
import { batch, event, setup } from "../helpers/output-ingestion.ts";
import {
  createWorkerScope,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  connectWebSocket,
  type WebSocketHandshakeFailure,
  type WsClient,
} from "../helpers/ws-client.ts";

function reader(
  fixture: Pick<WorkerFixture, "app" | "adminCookie" | "config">,
  organizationId: string,
) {
  return createBakeryClient({
    baseUrl: fixture.config.publicBaseUrl,
    getContext: () => ({ organizationId }),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", fixture.adminCookie);
      return fixture.app.fetch(new Request(input, { ...init, headers }));
    },
  });
}

function connected(value: WsClient | WebSocketHandshakeFailure): WsClient {
  if (!("send" in value)) {
    throw new Error(`websocket handshake ${value.status}`);
  }
  return value;
}

async function openBackpressuredSocket(
  fixture: WorkerFixture,
  blockAfterHello = true,
) {
  const maxBufferedBytes = 64 * 1024;
  let buffered = 0;
  const registry = createEventsSocketRegistry();
  const handler = createEventsSocketHandler({
    database: fixture.runtimePgDatabase,
    store: createPostgresAuthPersistence(fixture.runtimePgDatabase),
    secret: fixture.config.auth!.secret,
    publicBaseUrl: fixture.config.publicBaseUrl,
    registry,
    limits: {
      maxBufferedBytes,
      backpressureGraceMs: 1_000,
      pollIntervalMs: 25,
    },
    upgradeWebSocket(request, options) {
      const upgraded = Deno.upgradeWebSocket(request, options);
      const send = upgraded.socket.send.bind(upgraded.socket);
      Object.defineProperties(upgraded.socket, {
        bufferedAmount: { configurable: true, get: () => buffered },
        send: {
          configurable: true,
          value: (data: string) => {
            send(data);
            if (blockAfterHello && JSON.parse(data).type === "hello") {
              buffered = maxBufferedBytes + 1;
            }
          },
        },
      });
      return upgraded;
    },
  });
  const principal = {
    principalId: fixture.principalId,
    principalType: "human",
    displayName: "Output Reader",
  } as const;
  let resolvePort: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => resolvePort = resolve);
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
  const socket = connected(
    await connectWebSocket(url, {
      headers: { cookie: fixture.adminCookie },
    }),
  );
  const hello = await socket.next(2_000);
  assert(typeof hello === "string");
  return {
    socket,
    drain: () => buffered = 0,
    registry,
    close: async () => {
      await socket.close();
      await server.shutdown();
    },
  };
}

Deno.test("reader cursors bind principal organization stream and filters while archived scope is denied", () =>
  withWorkerFixture(async (fixture) => {
    const first = await setup(fixture);
    const firstBatch = await batch(first.binding, "first");
    await first.client.postEvents(first.assignment.attemptId, {
      ...first.open,
      events: [event(firstBatch)],
    });
    const second = await setup(fixture);
    const secondBatch = await batch(second.binding, "second");
    await second.client.postEvents(second.assignment.attemptId, {
      ...second.open,
      events: [event(secondBatch)],
    });

    const client = reader(fixture, fixture.organizationId);
    assert(first.binding.taskId);
    assert(first.binding.runStepId);
    assert(first.binding.conversationId);
    const combined = await client.actions["output.streams.list"]({
      applicationId: first.binding.applicationId,
      taskId: first.binding.taskId,
      runStepId: first.binding.runStepId,
      conversationId: first.binding.conversationId,
      logicalActor: first.binding.logicalActor,
    });
    assertEquals(combined.items.map(({ streamId }) => streamId), [
      first.binding.sessionId,
    ]);
    assertEquals(combined.nextCursor, null);
    const discovery = await client.actions["output.streams.list"]({ limit: 1 });
    assertEquals(discovery.items.length, 1);
    assert(typeof discovery.nextCursor === "string");
    let changedFilterCode = "";
    try {
      await client.actions["output.streams.list"]({
        cursor: discovery.nextCursor,
        applicationId: crypto.randomUUID(),
      });
    } catch (error) {
      assert(error instanceof ApiProblemError);
      changedFilterCode = error.problem.code;
    }
    assertEquals(changedFilterCode, "INVALID_CURSOR");

    const firstRead = await client.actions["output.streams.read"]({
      streamId: first.binding.sessionId,
    });
    assert(typeof firstRead.cursor === "string");
    let changedStreamCode = "";
    try {
      await client.actions["output.streams.read"]({
        streamId: second.binding.sessionId,
        cursor: firstRead.cursor,
      });
    } catch (error) {
      assert(error instanceof ApiProblemError);
      changedStreamCode = error.problem.code;
    }
    assertEquals(changedStreamCode, "INVALID_CURSOR");

    const other = await createWorkerScope(
      fixture,
      "output-reader-other",
      fixture,
    );
    try {
      const foreign = reader(fixture, other.organizationId);
      assertEquals(
        (await foreign.actions["output.streams.list"]({})).items,
        [],
      );
      let changedOrganizationCode = "";
      try {
        await foreign.actions["output.streams.list"]({
          cursor: discovery.nextCursor,
        });
      } catch (error) {
        assert(error instanceof ApiProblemError);
        changedOrganizationCode = error.problem.code;
      }
      assertEquals(changedOrganizationCode, "INVALID_CURSOR");
      let foreignCode = "";
      try {
        await reader(fixture, other.organizationId).actions
          ["output.streams.read"]({
            streamId: first.binding.sessionId,
          });
      } catch (error) {
        assert(error instanceof ApiProblemError);
        foreignCode = error.problem.code;
      }
      assertEquals(foreignCode, "RESOURCE_NOT_FOUND");
    } finally {
      await fixture.pgDatabase.query(
        `delete from bakery.organizations where id=$1`,
        [other.organizationId],
      );
    }

    await fixture.pgDatabase.query(
      `update bakery.applications set archived_at=now() where organization_id=$1 and id=$2`,
      [fixture.organizationId, first.binding.applicationId],
    );
    let archivedCode = "";
    try {
      await client.actions["output.streams.read"]({
        streamId: first.binding.sessionId,
      });
    } catch (error) {
      assert(error instanceof ApiProblemError);
      archivedCode = error.problem.code;
    }
    assertEquals(archivedCode, "RESOURCE_NOT_FOUND");
  }));

Deno.test("pending output frame is reauthorized and slow reader never blocks producer commits", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const first = await batch(own.binding, "withheld");
    const firstEvent = event(first);
    await own.client.postEvents(own.assignment.attemptId, {
      ...own.open,
      events: [firstEvent],
    });

    const harness = await openBackpressuredSocket(fixture);
    const { socket } = harness;
    try {
      await socket.send(JSON.stringify({
        type: "output.subscribe",
        requestId: crypto.randomUUID(),
        streamId: own.binding.sessionId,
        after: null,
      }));
      await assertRejects(
        () => socket!.next(100),
        Error,
        "WEBSOCKET_READ_TIMEOUT",
      );

      const second = await batch(own.binding, "producer-progress", "2");
      const committed = await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [firstEvent, event(second, "2")],
      });
      assertEquals(committed.value.lastEventSeq, "2");

      await fixture.pgDatabase.query(
        `update bakery.applications set archived_at=now() where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.applicationId],
      );
      harness.drain();
      const frames: Record<string, unknown>[] = [];
      let closed: { code: number; reason: string } | undefined;
      while (!closed) {
        const value = await socket.next(2_000);
        if (typeof value !== "string") {
          closed = value;
          break;
        }
        frames.push(JSON.parse(value));
      }
      assertEquals(frames.some(({ type }) => type === "output.batch"), false);
      assertEquals(closed.code, 1008);
      assertEquals(harness.registry.size, 0);
    } finally {
      await harness.close();
    }
  }));

Deno.test("pending reset frame is reauthorized before transmission", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const initial = await openBackpressuredSocket(fixture, false);
    let socketCursor: string;
    try {
      await initial.socket.send(JSON.stringify({
        type: "output.subscribe",
        requestId: crypto.randomUUID(),
        streamId: own.binding.sessionId,
        after: null,
      }));
      const value = await initial.socket.next(2_000);
      assert(typeof value === "string");
      const frame = JSON.parse(value);
      assertEquals(frame.type, "output.cursor");
      socketCursor = frame.cursor;
    } finally {
      await initial.close();
    }
    const first = await batch(own.binding, "removed", "1");
    const second = await batch(own.binding, "retained", "2");
    await own.client.postEvents(own.assignment.attemptId, {
      ...own.open,
      events: [event(first, "1"), event(second, "2")],
    });
    await fixture.pgDatabase.query(
      `delete from bakery.session_output_batches
        where organization_id=$1 and session_id=$2 and sequence=1`,
      [fixture.organizationId, own.binding.sessionId],
    );

    const immediate = await openBackpressuredSocket(fixture, false);
    try {
      await immediate.socket.send(JSON.stringify({
        type: "output.subscribe",
        requestId: crypto.randomUUID(),
        streamId: own.binding.sessionId,
        after: socketCursor,
      }));
      const value = await immediate.socket.next(2_000);
      assert(typeof value === "string");
      assertEquals(JSON.parse(value).type, "output.reset_required");
      await assertRejects(
        () => immediate.socket.next(100),
        Error,
        "WEBSOCKET_READ_TIMEOUT",
      );
    } finally {
      await immediate.close();
    }

    const harness = await openBackpressuredSocket(fixture);
    try {
      await harness.socket.send(JSON.stringify({
        type: "output.subscribe",
        requestId: crypto.randomUUID(),
        streamId: own.binding.sessionId,
        after: socketCursor,
      }));
      await assertRejects(
        () => harness.socket.next(100),
        Error,
        "WEBSOCKET_READ_TIMEOUT",
      );
      await fixture.pgDatabase.query(
        `update bakery.applications set archived_at=now()
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, own.binding.applicationId],
      );
      harness.drain();
      const frames: Record<string, unknown>[] = [];
      let closed: { code: number; reason: string } | undefined;
      while (!closed) {
        const value = await harness.socket.next(2_000);
        if (typeof value !== "string") {
          closed = value;
          break;
        }
        frames.push(JSON.parse(value));
      }
      assertEquals(
        frames.some(({ type }) => type === "output.reset_required"),
        false,
      );
      assertEquals(closed.code, 1008);
      assertEquals(harness.registry.size, 0);
    } finally {
      await harness.close();
    }
  }));
