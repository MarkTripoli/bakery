import { assert, assertEquals } from "@std/assert";
import {
  assertDescribedSchema,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
Deno.test("generated worker output operations validate public DTOs before network and preserve cancellation", async () => {
  for (
    const name of [
      "WorkerOutputOpen",
      "WorkerOutputClose",
      "WorkerOutputBinding",
      "OutputBatch",
    ] as const
  ) assertDescribedSchema(contractSchemas[name]);
  let calls = 0;
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:1",
    credential: "owned-generated-fixture",
    fetcher: () => {
      calls++;
      throw new Error("NO_NETWORK_ALLOWED");
    },
  });
  const input = {
    leaseToken: "owned-lease-fixture",
    fence: "1",
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
  };
  const forged = { ...input, applicationId: crypto.randomUUID() };
  let rejected = false;
  try {
    await client.openOutput(crypto.randomUUID(), forged, crypto.randomUUID());
  } catch {
    rejected = true;
  }
  assert(rejected);
  assertEquals(calls, 0);
  const controller = new AbortController();
  controller.abort();
  try {
    await client.openOutput(
      crypto.randomUUID(),
      input,
      crypto.randomUUID(),
      controller.signal,
    );
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.message, "WORKER_REQUEST_ABORTED");
  }
  assertEquals(calls, 0);
});

Deno.test("production output client rejects a described but foreign binding or wrong sequence handoff", async () => {
  const attemptId = crypto.randomUUID();
  const input = {
    leaseToken: "owned-fixture",
    fence: "1",
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
  };
  const base = {
    sessionId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    taskId: null,
    runStepId: null,
    conversationId: null,
    logicalActor: "repository.inspect:native",
    attemptId,
    workerHostId: crypto.randomUUID(),
    workerSessionId: input.workerSessionId,
    workerSessionGeneration: "1",
    fence: "1",
    writerGeneration: "1",
    highwater: "0",
    nextSequence: "1",
    closed: false,
    capture: "capturing",
    reason: null,
    archive: "pending",
  };
  for (
    const patch of [
      { attemptId: crypto.randomUUID() },
      { workerSessionId: crypto.randomUUID() },
      { fence: "2" },
      { nextSequence: "3" },
      { writerGeneration: "0" },
    ]
  ) {
    const client = new WorkerApiClient({
      baseUrl: "http://127.0.0.1:1",
      credential: "owned-fixture",
      fetcher: () =>
        Promise.resolve(
          new Response(JSON.stringify({ ...base, ...patch }), {
            headers: {
              "Content-Type": "application/json",
              "X-Bakery-Worker-Protocol-Version": "2",
            },
          }),
        ),
    });
    let rejected = false;
    try {
      await client.openOutput(attemptId, input, crypto.randomUUID());
    } catch (error) {
      assert(error instanceof Error);
      assertEquals(error.message, "WORKER_OUTPUT_BINDING_INVALID");
      rejected = true;
    }
    assert(rejected);
  }
});

Deno.test("archive projections describe immutable ranges, digests and bounded segments", () => {
  assertDescribedSchema(contractSchemas.OutputTranscriptSegment);
  assertDescribedSchema(contractSchemas.OutputStream);
  const segment = {
    segmentIndex: 0,
    firstSequence: "1",
    lastSequence: "2",
    sizeBytes: 512,
    sha256: "a".repeat(64),
    completeness: "interrupted" as const,
    artifactVersionId: crypto.randomUUID(),
  };
  assertEquals(contractSchemas.OutputTranscriptSegment.parse(segment), segment);
  assert(
    !contractSchemas.OutputTranscriptSegment.safeParse({
      ...segment,
      sizeBytes: 1_048_577,
    }).success,
  );
  assert(
    !contractSchemas.OutputTranscriptSegment.safeParse({
      ...segment,
      completeness: "complete_inferred",
    }).success,
  );
});
