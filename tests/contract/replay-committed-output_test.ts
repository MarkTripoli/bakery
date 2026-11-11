import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ApiTransportError,
  createBakeryClient,
  isOutputSocketServerFrame,
  type OutputSocketClientFrame,
  type OutputSocketServerFrame,
} from "../../packages/contracts/src/client.ts";
import {
  type ContractOutput,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import {
  OutputImplementedAction,
  outputImplementedActions,
} from "../../packages/contracts/src/implemented-actions.ts";
import {
  OUTPUT_READER_LIMITS,
  OutputBatchSchema,
  outputDigest,
} from "../../packages/contracts/src/output.ts";

const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix}`;

async function outputBatch() {
  const value = {
    sessionId: uuid("000000000001"),
    writerGeneration: "1",
    batchId: uuid("000000000002"),
    sequence: "1",
    parts: [{
      itemId: uuid("000000000003"),
      channel: "stdout" as const,
      text: "committed bytes",
    }],
    capture: "capturing" as const,
    reason: null,
  };
  return OutputBatchSchema.parse({
    ...value,
    digest: await outputDigest(value),
  });
}

Deno.test("output reader contracts pin bounded HTTP and socket surfaces", async () => {
  assertEquals(OUTPUT_READER_LIMITS, {
    defaultBatches: 32,
    maxBatches: 64,
    defaultPageBytes: 131072,
    maxPageBytes: 262144,
  });
  assertEquals(outputImplementedActions, [
    OutputImplementedAction.StreamsList,
    OutputImplementedAction.StreamsRead,
  ]);
  assert(
    contractSchemas.OutputStreamListQuery.safeParse({
      limit: 64,
      maxBytes: 262144,
    })
      .success,
  );
  for (
    const input of [
      { limit: 0 },
      { limit: 65 },
      { limit: 1.5 },
      { maxBytes: 0 },
      { maxBytes: 262145 },
      { maxBytes: Number.NaN },
      { maxBytes: Number.POSITIVE_INFINITY },
    ]
  ) {
    assertEquals(
      contractSchemas.OutputStreamListQuery.safeParse(input).success,
      false,
    );
  }
  const batch = await outputBatch();
  const clientFrame: OutputSocketClientFrame = {
    type: "output.subscribe",
    requestId: uuid("000000000004"),
    streamId: batch.sessionId,
    after: null,
  };
  const serverFrame: OutputSocketServerFrame = {
    type: "output.batch",
    requestId: uuid("000000000004"),
    streamId: batch.sessionId,
    batch,
  };
  const frames = [
    clientFrame,
    serverFrame,
    {
      type: "output.cursor",
      requestId: uuid("000000000004"),
      streamId: batch.sessionId,
      cursor: "opaque",
      highwater: "1",
    },
    {
      type: "output.reset_required",
      requestId: uuid("000000000004"),
      streamId: batch.sessionId,
      cursor: "opaque-reset-cursor",
      retainedFrom: "2",
      resumeAfter: "1",
      highwater: "2",
    },
  ];
  for (const frame of frames) {
    assert(contractSchemas.WebSocketFrame.safeParse(frame).success);
  }
  assertEquals(isOutputSocketServerFrame(frames[0]), false);
  for (const frame of frames.slice(1)) assert(isOutputSocketServerFrame(frame));
  assertEquals(
    contractSchemas.WebSocketFrame.safeParse({
      type: "output.subscribe",
      requestId: uuid("000000000004"),
      streamId: batch.sessionId,
      after: "x".repeat(513),
    }).success,
    false,
  );
  assert(
    contractSchemas.WebSocketFrame.safeParse({
      type: "subscribe",
      requestId: uuid("000000000004"),
      scopes: [{ type: "application", id: batch.sessionId }],
      after: "1",
    }).success,
  );
  assert(
    contractSchemas.WebSocketFrame.safeParse({
      type: "subscribe",
      requestId: uuid("000000000004"),
      scopes: [{ type: "application", id: batch.sessionId }],
      after: "not-a-sequence",
    }).success,
  );
});

Deno.test("generated typed client preserves output cursors and validates pages", async () => {
  const streamId = uuid("000000000010");
  const organizationId = uuid("000000000011");
  const applicationId = uuid("000000000012");
  const batch = await outputBatch();
  const stream = {
    streamId,
    organizationId,
    applicationId,
    repositoryId: null,
    jobId: uuid("000000000013"),
    taskId: null,
    runStepId: null,
    conversationId: null,
    logicalActor: "repository.inspect:native",
    highwater: "1",
    closed: false,
    capture: "capturing",
    reason: null,
    archive: "pending",
    archiveFailure: null,
    archivedAt: null,
    historyExpiresAt: null,
    segments: [],
    producers: [],
    createdAt: "2026-10-04T00:00:00.000Z",
  } satisfies ContractOutput<"OutputStream">;
  const requests: Request[] = [];
  const client = createBakeryClient({
    baseUrl: "http://reader.test",
    getContext: () => ({ organizationId }),
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = request.url.includes(`/${streamId}`)
        ? {
          disposition: "page",
          stream,
          batches: [batch],
          cursor: "opaque-read-cursor",
          highwater: "1",
          retainedFrom: "1",
          resumeAfter: null,
          encodedBytes: 1024,
        }
        : {
          items: [stream],
          nextCursor: "opaque-list-cursor",
          encodedBytes: 512,
        };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const listed = await client.actions["output.streams.list"]({
    applicationId,
    cursor: "opaque-input-cursor",
    limit: 1,
    maxBytes: 4096,
  });
  assertEquals(listed.nextCursor, "opaque-list-cursor");
  const read = await client.actions["output.streams.read"]({
    streamId,
    cursor: "opaque-read-input",
    limit: 1,
    maxBytes: 4096,
  });
  assertEquals(read.cursor, "opaque-read-cursor");
  assertEquals(read.batches[0], batch);
  assert(
    new URL(requests[0].url).searchParams.get("cursor") ===
      "opaque-input-cursor",
  );
  assert(
    new URL(requests[1].url).searchParams.get("cursor") === "opaque-read-input",
  );
  assertEquals(
    contractSchemas.OutputStreamPage.safeParse({
      items: Array.from({ length: 65 }, () => stream),
      nextCursor: null,
      encodedBytes: 1,
    }).success,
    false,
  );
  assertEquals(
    contractSchemas.OutputReadPage.safeParse({
      disposition: "page",
      stream,
      batches: Array.from({ length: 65 }, () => batch),
      cursor: "opaque",
      highwater: "65",
      retainedFrom: "1",
      resumeAfter: null,
      encodedBytes: 1,
    }).success,
    false,
  );
  assertEquals(
    contractSchemas.OutputReadPage.safeParse({
      disposition: "page",
      stream,
      batches: [],
      cursor: "opaque",
      highwater: "1",
      retainedFrom: "1",
      resumeAfter: null,
      encodedBytes: 262145,
    }).success,
    false,
  );

  await assertRejects(
    () => client.actions["output.streams.read"]({ streamId, limit: 65 }),
    ApiTransportError,
    "protocol",
  );
});
