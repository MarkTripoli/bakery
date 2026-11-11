import { assert, assertEquals, assertRejects } from "@std/assert";
import { assertFrame, openSocketFixture } from "../helpers/events-socket.ts";
import { generateContracts } from "../../packages/contracts/src/contracts.ts";
import type {
  WebSocketClose,
  WebSocketHandshakeFailure,
  WebSocketNext,
  WsClient,
} from "../helpers/ws-client.ts";
import { connectWebSocket } from "../helpers/ws-client.ts";

Deno.test(
  "SocketClient preserves delayed frames after timeout and closes cleanly",
  async () => {
    let resolvePort: (port: number) => void = () => {};
    const listening = new Promise<number>((resolve) => resolvePort = resolve);
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => resolveClosed = resolve);
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => resolvePort(port),
    }, (request) => {
      if (
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      ) {
        return new Response(null, { status: 400 });
      }
      const upgraded = Deno.upgradeWebSocket(request);
      upgraded.socket.onmessage = (event) => {
        assertEquals(event.data, "release-delayed");
        upgraded.socket.send("delayed");
      };
      upgraded.socket.onclose = () => resolveClosed();
      return upgraded.response;
    });
    let client: WsClient | undefined;
    try {
      const result = await connectWebSocket(
        `ws://127.0.0.1:${await listening}/events`,
      );
      if (!("send" in result)) {
        throw new Error(`WEBSOCKET_HANDSHAKE_FAILED:${result.status}`);
      }
      client = result;
      await assertRejects(
        () => result.next(5),
        Error,
        "WEBSOCKET_READ_TIMEOUT",
      );
      await client.send("release-delayed");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assertEquals(await client.next(500), "delayed");
      await client.close();
      await closed;
    } finally {
      await client?.close();
      await server.shutdown();
    }
  },
);

Deno.test(
  "rejects too many and duplicate scopes while keeping the socket open",
  async () => {
    const fixture = await openSocketFixture();
    let socket: WsClient | undefined;
    try {
      socket = client(await fixture.connect({ cookie: fixture.cookie }));
      assertHello(await nextFrame(socket));

      await socket.send(JSON.stringify({
        type: "subscribe",
        requestId: requestIds.tooManyScopes,
        scopes: Array.from(
          { length: 5 },
          () => ({ type: "application", id: fixture.applicationId }),
        ),
        after: null,
      }));
      assertProblem(
        await nextFrame(socket),
        "MALFORMED_REQUEST",
        requestIds.tooManyScopes,
      );
      await socket.send(
        JSON.stringify({ type: "ping", requestId: requestIds.ping }),
      );
      assertEquals(
        await nextFrame(socket),
        { type: "ping", requestId: requestIds.ping },
      );

      await socket.send(JSON.stringify({
        type: "subscribe",
        requestId: requestIds.duplicateScopes,
        scopes: [
          { type: "task", id: fixture.taskId },
          { type: "task", id: fixture.taskId },
        ],
        after: null,
      }));
      assertProblem(
        await nextFrame(socket),
        "MALFORMED_REQUEST",
        requestIds.duplicateScopes,
      );
      await socket.send(
        JSON.stringify({ type: "ping", requestId: requestIds.ping }),
      );
      assertEquals(
        await nextFrame(socket),
        { type: "ping", requestId: requestIds.ping },
      );
    } finally {
      await socket?.close();
      await fixture.close();
    }
  },
);

Deno.test(
  "resumes in-band from a subscribe cursor and replays the next event",
  async () => {
    const fixture = await openSocketFixture();
    let socket: WsClient | undefined;
    try {
      socket = client(await fixture.connect({ cookie: fixture.cookie }));
      assertHello(await nextFrame(socket));
      await socket.send(JSON.stringify({
        type: "subscribe",
        requestId: requestIds.resumeSubscribe,
        scopes: [{ type: "task", id: fixture.taskId }],
        after: null,
      }));
      const initialCursor = await nextFrame(socket) as CursorFrame;
      assertEquals(initialCursor.type, "cursor");
      if (initialCursor.type !== "cursor") {
        throw new Error("CURSOR_FRAME_REQUIRED");
      }

      const inserted = await fixture.insertDomainEvent({
        eventType: "tasks.updated",
        aggregateVersion: 2,
        payload: { resourceId: fixture.taskId, resourceVersion: 2 },
      });
      await socket.send(JSON.stringify({
        type: "resume",
        requestId: requestIds.resumeHappy,
        cursor: initialCursor.cursor,
      }));
      const events = await nextFrame(socket);
      assertEquals(events.type, "events");
      if (events.type !== "events") throw new Error("EVENTS_FRAME_REQUIRED");
      const eventValues = events.events as readonly {
        sequence: string;
      }[];
      assertEquals(eventValues.length, 1);
      assertEquals(eventValues[0]?.sequence, inserted.sequence);
      const cursor = await nextFrame(socket) as CursorFrame;
      assertEquals(cursor.type, "cursor");
      if (cursor.type !== "cursor") throw new Error("CURSOR_FRAME_REQUIRED");
      assertEquals(cursor.requestId, requestIds.resumeHappy);
      assertEquals(cursor.highwater, inserted.sequence);
    } finally {
      await socket?.close();
      await fixture.close();
    }
  },
);

Deno.test(
  "inbound executor closes when pending subscribe frames exceed the bound",
  async () => {
    const fixture = await openSocketFixture({
      eventsSocket: { limits: { maxPendingFrames: 2 } },
    });
    let socket: WsClient | undefined;
    try {
      const result = await fixture.connect({ cookie: fixture.cookie });
      if (!("send" in result)) {
        throw new Error(`WEBSOCKET_HANDSHAKE_FAILED:${result.status}`);
      }
      socket = result;
      assertHello(await nextFrame(socket));
      const subscribe = (requestId: string) =>
        JSON.stringify({
          type: "subscribe",
          requestId,
          scopes: [{ type: "application", id: fixture.applicationId }],
          after: null,
        });
      await socket.sendMany([
        subscribe(crypto.randomUUID()),
        subscribe(crypto.randomUUID()),
        subscribe(crypto.randomUUID()),
      ]);
      const outputs: Frame[] = [];
      let close: WebSocketClose | undefined;
      while (!close) {
        const value = await socket.next(2_000);
        if (typeof value === "string") {
          outputs.push(assertFrame(value) as Frame);
        } else close = value;
      }
      const problem = outputs.find((frame) => frame.type === "problem");
      assert(problem);
      const problemValue = problem.problem;
      assert(
        problemValue !== null &&
          typeof problemValue === "object" &&
          "code" in problemValue &&
          typeof problemValue.code === "string",
      );
      assertEquals(problemValue.code, "RATE_LIMITED");
      assertEquals(close.code, 1008);
      assertEquals(close.reason, "pending frames exceeded");
    } finally {
      await socket?.close();
      await fixture.close();
    }
  },
);

type Frame = {
  readonly type: string;
  readonly [key: string]: unknown;
};
type HelloFrame = Frame & {
  readonly type: "hello";
  readonly protocolVersion: number;
  readonly connectionId: string;
  readonly highwater: string;
  readonly retainedFrom: string;
};
type CursorFrame = Frame & {
  readonly type: "cursor";
  readonly cursor: string;
  readonly highwater: string;
};
type ProblemFrame = Frame & {
  readonly type: "problem";
  readonly requestId: string;
  readonly problem: {
    readonly type: string;
    readonly code: string;
    readonly requestId: string;
    readonly traceId: string;
    readonly retryable: boolean;
  };
};

const requestIds = {
  hello: "00000000-0000-4000-8000-000000000101",
  subscribe: "00000000-0000-4000-8000-000000000102",
  ping: "00000000-0000-4000-8000-000000000103",
  malformedJson: "00000000-0000-4000-8000-000000000104",
  resume: "00000000-0000-4000-8000-000000000105",
  serverHello: "00000000-0000-4000-8000-000000000106",
  create: "00000000-0000-4000-8000-000000000107",
  execute: "00000000-0000-4000-8000-000000000108",
  tooManyScopes: "00000000-0000-4000-8000-000000000109",
  duplicateScopes: "00000000-0000-4000-8000-000000000110",
  resumeSubscribe: "00000000-0000-4000-8000-000000000111",
  resumeHappy: "00000000-0000-4000-8000-000000000112",
} as const;

function client(
  value: WsClient | WebSocketHandshakeFailure,
): WsClient {
  if ("send" in value) return value;
  throw new Error(`WEBSOCKET_HANDSHAKE_FAILED:${value.status}`);
}

function assertUuid(value: unknown): asserts value is string {
  assert(
    typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(value),
  );
}

async function nextFrame(socket: WsClient): Promise<Frame> {
  const next: WebSocketNext = await socket.next();
  if (typeof next !== "string") {
    throw new Error(`EXPECTED_TEXT_FRAME:${next.code}`);
  }
  return assertFrame(next) as Frame;
}

function assertHello(frame: Frame): asserts frame is HelloFrame {
  assertEquals(frame.type, "hello");
  if (frame.type !== "hello") throw new Error("HELLO_FRAME_REQUIRED");
  const hello = frame as HelloFrame;
  assertEquals(hello.protocolVersion, 1);
  assertUuid(hello.connectionId);
  assert(/^(?:0|[1-9][0-9]*)$/.test(hello.highwater));
  assert(/^(?:0|[1-9][0-9]*)$/.test(hello.retainedFrom));
}

function assertProblem(
  frame: Frame,
  code: string,
  requestId?: string,
): asserts frame is ProblemFrame {
  assertEquals(frame.type, "problem");
  if (frame.type !== "problem") throw new Error("PROBLEM_FRAME_REQUIRED");
  const problemFrame = frame as ProblemFrame;
  const problem = problemFrame.problem;
  assertEquals(problem.code, code);
  assertEquals(problemFrame.requestId, problem.requestId);
  if (requestId !== undefined) assertEquals(problem.requestId, requestId);
  assertUuid(problem.requestId);
  assert(/^[0-9a-f]{32}$/i.test(problem.traceId));
  assertEquals(problem.retryable, false);
  const slug = code.toLowerCase().replaceAll("_", "-");
  assert(problem.type.endsWith(`/problems/${slug}`));
}

function tamper(cursor: string): string {
  const last = cursor.at(-1);
  if (!last) throw new Error("CURSOR_REQUIRED");
  return `${cursor.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

Deno.test("events OpenAPI organization authority accepts header or query", () => {
  const generated = generateContracts();
  const openapi = generated.openapi as {
    paths: Record<string, unknown>;
  };
  const path = openapi.paths["/v1/events"] as {
    get?: {
      parameters?: Array<{
        name: string;
        in: string;
        required?: boolean;
      }>;
    };
  };
  const parameters = path.get?.parameters ?? [];
  const organizationHeader = parameters.find((parameter) =>
    parameter.name === "Bakery-Organization-Id" && parameter.in === "header"
  );
  const organizationQuery = parameters.find((parameter) =>
    parameter.name === "organizationId" && parameter.in === "query"
  );
  assert(organizationHeader);
  assertEquals(organizationHeader.required, false);
  assert(organizationQuery);
});

Deno.test("bounded authorized websocket events and replay contract", async () => {
  const fixture = await openSocketFixture();
  try {
    const socket = client(await fixture.connect({ cookie: fixture.cookie }));
    const hello = await nextFrame(socket);
    assertHello(hello);

    await socket.send(JSON.stringify({
      type: "subscribe",
      requestId: requestIds.subscribe,
      scopes: [{ type: "application", id: fixture.applicationId }],
      after: null,
    }));
    const cursorFrame = await nextFrame(socket) as CursorFrame;
    assertEquals(cursorFrame.type, "cursor");
    if (cursorFrame.type !== "cursor") throw new Error("CURSOR_FRAME_REQUIRED");
    assert(cursorFrame.cursor.length > 0);
    assert(/^(?:0|[1-9][0-9]*)$/.test(cursorFrame.highwater));

    await socket.send(
      JSON.stringify({ type: "ping", requestId: requestIds.ping }),
    );
    assertEquals(
      await nextFrame(socket),
      { type: "ping", requestId: requestIds.ping },
    );
    await socket.close();

    const malformedSocket = client(
      await fixture.connect({ cookie: fixture.cookie }),
    );
    assertHello(await nextFrame(malformedSocket));
    const rejected = [
      { type: "hello", requestId: requestIds.serverHello },
      {
        type: "tasks.create",
        requestId: requestIds.create,
        input: { title: "must stay on REST" },
      },
      {
        type: "execute",
        requestId: requestIds.execute,
        operation: "tasks.create",
      },
    ];
    for (const value of rejected) {
      await malformedSocket.send(JSON.stringify(value));
      assertProblem(
        await nextFrame(malformedSocket),
        "MALFORMED_REQUEST",
        value.requestId,
      );
      await malformedSocket.send(
        JSON.stringify({ type: "ping", requestId: requestIds.ping }),
      );
      assertEquals(
        await nextFrame(malformedSocket),
        { type: "ping", requestId: requestIds.ping },
      );
    }
    await malformedSocket.send(`{"requestId":"${requestIds.malformedJson}",`);
    assertProblem(
      await nextFrame(malformedSocket),
      "MALFORMED_JSON",
      requestIds.malformedJson,
    );
    await malformedSocket.send(
      JSON.stringify({ type: "ping", requestId: requestIds.ping }),
    );
    assertEquals(
      await nextFrame(malformedSocket),
      { type: "ping", requestId: requestIds.ping },
    );
    await malformedSocket.close();

    const oversizedSocket = client(
      await fixture.connect({ cookie: fixture.cookie }),
    );
    assertHello(await nextFrame(oversizedSocket));
    await oversizedSocket.send("x".repeat(262_145));
    assertProblem(await nextFrame(oversizedSocket), "BODY_TOO_LARGE");
    const close = await oversizedSocket.next();
    if (typeof close === "string") throw new Error("CLOSE_FRAME_REQUIRED");
    assertEquals(close.code, 1009);

    const resumeSocket = client(
      await fixture.connect({ cookie: fixture.cookie }),
    );
    assertHello(await nextFrame(resumeSocket));
    await resumeSocket.send(JSON.stringify({
      type: "subscribe",
      requestId: requestIds.subscribe,
      scopes: [{ type: "application", id: fixture.applicationId }],
      after: null,
    }));
    const resumeCursor = await nextFrame(resumeSocket) as CursorFrame;
    assertEquals(resumeCursor.type, "cursor");
    if (resumeCursor.type !== "cursor") {
      throw new Error("CURSOR_FRAME_REQUIRED");
    }
    await resumeSocket.send(JSON.stringify({
      type: "resume",
      requestId: requestIds.resume,
      cursor: tamper(resumeCursor.cursor),
    }));
    assertProblem(
      await nextFrame(resumeSocket),
      "INVALID_CURSOR",
      requestIds.resume,
    );
    await resumeSocket.send(
      JSON.stringify({ type: "ping", requestId: requestIds.ping }),
    );
    assertEquals(
      await nextFrame(resumeSocket),
      { type: "ping", requestId: requestIds.ping },
    );
    await resumeSocket.close();
  } finally {
    await fixture.close();
  }
});
