import { assertEquals, assertRejects } from "@std/assert";
import {
  type AttemptProof,
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";

const ATTEMPT = "00000000-0000-4000-8000-0000000000a1";
const proof: AttemptProof = {
  leaseToken: "l".repeat(43),
  fence: "7",
  workerSessionId: "00000000-0000-4000-8000-0000000000a2",
  workerSessionGeneration: "3",
};

const facts = {
  facts: [{ wording: "Tests run with pnpm.", recordedAt: "2026-11-20" }],
  omitted: 2,
};

const served = {
  attemptId: ATTEMPT,
  runId: "00000000-0000-4000-8000-0000000000a3",
  facts,
  inputs: [{
    artifactVersionId: "00000000-0000-4000-8000-0000000000a4",
    artifactId: "00000000-0000-4000-8000-0000000000a5",
    digest: "a".repeat(64),
    sizeBytes: 5,
    mediaType: "text/markdown",
    contentBase64: "YnJpZWY=",
  }],
};

function client(body: unknown, seen: Array<Record<string, string>>) {
  return new WorkerApiClient({
    baseUrl: "http://worker.test",
    credential: "c".repeat(43),
    fetcher: (input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      seen.push({ url: input.toString() });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Bakery-Worker-Protocol-Version": "2",
          },
        }),
      );
    },
  });
}

Deno.test("reading an attempt's context presents the lease proof the route asks for", async () => {
  const seen: Array<Record<string, string>> = [];
  const read = await client(served, seen).attemptContext(ATTEMPT, proof);
  assertEquals(read.value.inputs, served.inputs);
  assertEquals(read.value.facts, facts);
  const headers = seen[0];
  assertEquals(headers["x-worker-lease-token"], proof.leaseToken);
  assertEquals(headers["x-worker-fence"], proof.fence);
  assertEquals(headers["x-worker-session-id"], proof.workerSessionId);
  assertEquals(
    headers["x-worker-session-generation"],
    proof.workerSessionGeneration,
  );
  assertEquals(
    seen[1].url,
    `http://worker.test/v1/worker/attempts/${ATTEMPT}/context`,
  );
});

Deno.test("a read with no recorded facts serves null rather than an empty list", async () => {
  const read = await client({ ...served, facts: null }, [])
    .attemptContext(ATTEMPT, proof);
  assertEquals(read.value.facts, null);
});

Deno.test("a read whose facts are not the declared shape is refused", async () => {
  const error = await assertRejects(
    () =>
      client({ ...served, facts: { facts: [{ wording: 1 }], omitted: 0 } }, [])
        .attemptContext(ATTEMPT, proof),
    WorkerRequestError,
  );
  assertEquals(error.code, "WORKER_RESPONSE_CONTEXT_INVALID");
});

Deno.test("a context read refuses a body that is not the declared read", async () => {
  const error = await assertRejects(
    () =>
      client({
        attemptId: ATTEMPT,
        runId: served.runId,
        items: served.inputs,
      }, []).attemptContext(ATTEMPT, proof),
    WorkerRequestError,
  );
  assertEquals(error.code, "WORKER_RESPONSE_CONTEXT_INVALID");
});
