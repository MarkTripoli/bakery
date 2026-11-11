import { assertEquals, assertRejects } from "@std/assert";
import {
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";

Deno.test("worker skill reads reject cacheable or protocol-ambiguous responses", async () => {
  const request = {
    workerHostId: "10000000-0000-4000-8000-000000000001",
    attemptId: "20000000-0000-4000-8000-000000000002",
    workerSessionId: "30000000-0000-4000-8000-000000000003",
    workerSessionGeneration: "1",
    leaseToken: "lease",
    fence: "1",
    versionId: "40000000-0000-8000-8000-000000000004",
    digest: "a".repeat(64),
  };
  const cacheable = new WorkerApiClient({
    baseUrl: "https://worker.test",
    credential: "credential",
    fetcher: () =>
      Promise.resolve(Response.json({}, {
        headers: { "X-Bakery-Worker-Protocol-Version": "2" },
      })),
  });
  const cacheError = await assertRejects(
    () => cacheable.getSkillVersion(request),
    WorkerRequestError,
    "WORKER_RESPONSE_CACHE_POLICY_INVALID",
  );
  assertEquals(cacheError.code, "WORKER_RESPONSE_CACHE_POLICY_INVALID");

  const ambiguous = new WorkerApiClient({
    baseUrl: "https://worker.test",
    credential: "credential",
    fetcher: () =>
      Promise.resolve(Response.json({}, {
        headers: { "Cache-Control": "no-store" },
      })),
  });
  const protocolError = await assertRejects(
    () => ambiguous.getSkillVersion(request),
    WorkerRequestError,
    "WORKER_PROTOCOL_UNSUPPORTED",
  );
  assertEquals(protocolError.code, "WORKER_PROTOCOL_UNSUPPORTED");
});
