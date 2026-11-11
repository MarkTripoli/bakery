import { assert, assertEquals } from "@std/assert";
import { createBakeryClient } from "../../packages/contracts/src/client.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import type { OutputBatch } from "../../packages/contracts/src/output.ts";
import { authTestOrigin, openAuthFixture } from "../helpers/auth.ts";
import { batch, event, setup } from "../helpers/output-ingestion.ts";
import {
  expireAndSupersedeAttempt,
  type WorkerFixture,
  workerFixtureCapabilities,
} from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  openRepositoryInspectionHarness,
  readInspectionAssignment,
} from "../helpers/repository-inspection.ts";
import {
  connectWebSocket,
  type WebSocketHandshakeFailure,
  type WsClient,
} from "../helpers/ws-client.ts";

function browserClient(
  fixture: Pick<
    WorkerFixture,
    "app" | "adminCookie" | "organizationId" | "config"
  >,
) {
  return createBakeryClient({
    baseUrl: fixture.config.publicBaseUrl,
    getContext: () => ({ organizationId: fixture.organizationId }),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", fixture.adminCookie);
      return fixture.app.fetch(new Request(input, { ...init, headers }));
    },
  });
}

async function serve(app: WorkerFixture["app"]) {
  let resolvePort: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, (request) => app.fetch(request));
  return {
    port: await listening,
    shutdown: () => server.shutdown(),
  };
}

function connected(value: WsClient | WebSocketHandshakeFailure): WsClient {
  if (!("send" in value)) {
    throw new Error(`websocket handshake ${value.status}`);
  }
  return value;
}

function assertEncodedPage(value: { encodedBytes: number }): void {
  assertEquals(
    value.encodedBytes,
    new TextEncoder().encode(JSON.stringify(value)).byteLength,
  );
}

async function nextFrame(client: WsClient): Promise<Record<string, unknown>> {
  const value = await client.next(2_000);
  if (typeof value !== "string") {
    throw new Error(`websocket closed ${value.code}: ${value.reason}`);
  }
  return contractSchemas.WebSocketFrame.parse(JSON.parse(value)) as Record<
    string,
    unknown
  >;
}

async function connectOutput(
  fixture: Pick<WorkerFixture, "adminCookie" | "organizationId">,
  port: number,
): Promise<WsClient> {
  const url = new URL(`ws://127.0.0.1:${port}/v1/events`);
  url.searchParams.set("organizationId", fixture.organizationId);
  return connected(
    await connectWebSocket(url, {
      headers: {
        cookie: fixture.adminCookie,
        origin: authTestOrigin,
      },
    }),
  );
}

async function readOutputFrames(
  client: WsClient,
  expectedBatches: number,
): Promise<{ batches: OutputBatch[]; cursor: string }> {
  const batches: OutputBatch[] = [];
  let cursor = "";
  while (!cursor) {
    const frame = await nextFrame(client);
    if (frame.type === "output.batch") {
      batches.push(frame.batch as OutputBatch);
    } else if (frame.type === "output.cursor") {
      cursor = frame.cursor as string;
    }
  }
  assertEquals(batches.length, expectedBatches);
  return { batches, cursor };
}

Deno.test("mounted worker output replays exact bytes over typed HTTP and sockets across replacement and restart", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const first = await batch(own.binding, "old-prefix");
    const firstEvent = event(first);
    await own.client.postEvents(own.assignment.attemptId, {
      ...own.open,
      events: [firstEvent],
    });

    const reader = browserClient(fixture);
    const malformed = await fixture.app.fetch(
      new Request(
        `${fixture.config.publicBaseUrl}/v1/output-streams?limit=1.5`,
        {
          headers: {
            cookie: fixture.adminCookie,
            "Bakery-Organization-Id": fixture.organizationId,
          },
        },
      ),
    );
    assertEquals(malformed.status, 400);
    assertEquals((await malformed.json()).code, "MALFORMED_REQUEST");

    const discovery = await reader.actions["output.streams.list"]({ limit: 1 });
    assertEquals(discovery.items.length, 1);
    assertEquals(discovery.items[0].streamId, own.binding.sessionId);
    assertEquals(discovery.items[0].archive, "pending");
    assertEncodedPage(discovery);
    const firstPage = await reader.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      limit: 1,
    });
    assertEquals(firstPage.batches, [first]);
    assertEncodedPage(firstPage);
    const firstCursor = firstPage.cursor;
    assert(typeof firstCursor === "string");

    let server = await serve(fixture.app);
    let socket = await connectOutput(fixture, server.port);
    assertEquals((await nextFrame(socket)).type, "hello");
    const requestId = crypto.randomUUID();
    await socket.send(JSON.stringify({
      type: "output.subscribe",
      requestId,
      streamId: own.binding.sessionId,
      after: null,
    }));
    const initialSocket = await readOutputFrames(socket, 1);
    assertEquals(initialSocket.batches, [first]);
    await socket.close();

    await expireAndSupersedeAttempt(fixture.pgDatabase, own.job.jobId);
    const replacement = (await own.client.claim({
      claimKey: crypto.randomUUID(),
      workerHostId: own.worker.registration.workerHostId,
      capabilities: [...workerFixtureCapabilities],
      workerSessionId: own.open.workerSessionId,
      workerSessionGeneration: own.open.workerSessionGeneration,
    })).value;
    assert(replacement);
    const replacementOpen = {
      ...own.open,
      leaseToken: replacement.leaseToken,
      fence: replacement.fence,
    };
    const replacementBinding = (await own.client.openOutput(
      replacement.attemptId,
      replacementOpen,
      crypto.randomUUID(),
    )).value;
    assertEquals(replacementBinding.sessionId, own.binding.sessionId);
    const second = await batch(replacementBinding, "new-prefix");
    await own.client.postEvents(replacement.attemptId, {
      ...replacementOpen,
      events: [event(second)],
    });

    await server.shutdown();
    const restarted = await openAuthFixture();
    try {
      const restartedFixture = { ...fixture, app: restarted.app };
      const restartedReader = browserClient(restartedFixture);
      const continuation = await restartedReader.actions["output.streams.read"](
        {
          streamId: own.binding.sessionId,
          cursor: firstCursor,
        },
      );
      assertEquals(continuation.batches, [second]);
      assertEquals(continuation.stream.streamId, own.binding.sessionId);
      assertEncodedPage(continuation);

      server = await serve(restarted.app);
      socket = await connectOutput(fixture, server.port);
      assertEquals((await nextFrame(socket)).type, "hello");
      await socket.send(JSON.stringify({
        type: "output.subscribe",
        requestId: crypto.randomUUID(),
        streamId: own.binding.sessionId,
        after: initialSocket.cursor,
      }));
      const resumed = await readOutputFrames(socket, 1);
      assertEquals(resumed.batches, [second]);
      assertEquals(
        [first, second].map((entry) => entry.parts[0].text),
        ["old-prefix", "new-prefix"],
      );
      await socket.close();
      await server.shutdown();
    } finally {
      await restarted.close();
    }

    const stale = await batch(own.binding, "stale", "3");
    let staleCode = "";
    try {
      await own.client.postEvents(own.assignment.attemptId, {
        ...own.open,
        events: [firstEvent, event(stale, "2")],
      });
    } catch (error) {
      staleCode = (error as { code?: string }).code ?? "";
    }
    assertEquals(staleCode, "LEASE_FENCED");
  }));

Deno.test("taskless native inspection output is discoverable through existing project authority", () =>
  withWorkerFixture(async (fixture) => {
    const harness = await openRepositoryInspectionHarness(
      { authDb: fixture.pgDatabase, appPg: fixture.runtimePgDatabase },
      fixture,
    );
    try {
      const repository = await harness.createRepository();
      await harness.onboard(repository.repositoryId);
      const assignment = await readInspectionAssignment(await harness.claim());
      const open = {
        leaseToken: assignment.leaseToken,
        fence: assignment.fence,
        workerSessionId: harness.registration.workerSessionId,
        workerSessionGeneration: harness.registration.workerSessionGeneration,
      };
      const opened = await harness.workerRequest(
        `/v1/worker/attempts/${assignment.attemptId}/output-bindings`,
        open,
      );
      assertEquals(opened.status, 200);
      const binding = contractSchemas.WorkerOutputBinding.parse(
        await opened.json(),
      );
      assertEquals(binding.taskId, null);
      assertEquals(binding.runStepId, null);
      assertEquals(binding.conversationId, null);
      const payload = await batch(binding, "native-inspection-output");
      const outputEvent = event(payload);
      const posted = await harness.workerRequest(
        `/v1/worker/attempts/${assignment.attemptId}/events`,
        { ...open, events: [outputEvent] },
        outputEvent.eventId,
      );
      const postedBody = await posted.clone().json();
      assertEquals(posted.status, 200, JSON.stringify(postedBody));

      const listed = await harness.memberRequest(
        "GET",
        `/v1/output-streams?applicationId=${repository.applicationId}`,
      );
      assertEquals(listed.status, 200);
      const page = contractSchemas.OutputStreamPage.parse(await listed.json());
      assertEquals(page.items.map(({ streamId }) => streamId), [
        binding.sessionId,
      ]);
      const read = await harness.memberRequest(
        "GET",
        `/v1/output-streams/${binding.sessionId}`,
      );
      assertEquals(read.status, 200);
      const output = contractSchemas.OutputReadPage.parse(await read.json());
      assertEquals(output.batches, [payload]);
      assertEquals(output.stream.logicalActor, "repository.inspect:native");
      // One attempt wrote the stream: exactly one producer, and the list and
      // the read agree on it.
      assertEquals(output.stream.producers, [{
        writerGeneration: payload.writerGeneration,
        attemptId: assignment.attemptId,
        attemptNo: 1,
      }]);
      assertEquals(page.items[0].producers, output.stream.producers);
      assertEncodedPage(output);

      await fixture.pgDatabase.query(
        `update bakery.repositories set archived_at=now()
          where organization_id=$1 and id=$2`,
        [fixture.organizationId, repository.repositoryId],
      );
      const hiddenList = await harness.memberRequest(
        "GET",
        `/v1/output-streams?applicationId=${repository.applicationId}`,
      );
      assertEquals(hiddenList.status, 200);
      assertEquals(
        contractSchemas.OutputStreamPage.parse(await hiddenList.json()).items,
        [],
      );
      const hiddenRead = await harness.memberRequest(
        "GET",
        `/v1/output-streams/${binding.sessionId}`,
      );
      assertEquals(hiddenRead.status, 404);
    } finally {
      await harness.close();
    }
  }));
