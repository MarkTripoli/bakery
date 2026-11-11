import * as issue39 from "./recovery-case-imports.ts";

const { assertEquals, WorkerApiClient, heartbeatResponse } = issue39;

// Cases are imported from the issue entrypoint.
Deno.test("concurrent worker responses keep replay metadata request-scoped", async () => {
  const workerHostId = crypto.randomUUID();
  const workerSessionId = crypto.randomUUID();
  const body = {
    workerHostId,
    observedAt: new Date().toISOString(),
    load: 0,
    activeAttemptIds: [],
    ackCommandIds: [],
    rejectedCommandIds: [],
    workerSessionId,
    workerSessionGeneration: "1",
  };
  const replayedResponse = Promise.withResolvers<Response>();
  const freshResponse = Promise.withResolvers<Response>();
  const client = new WorkerApiClient({
    baseUrl: "http://127.0.0.1:8788",
    credential: "credential",
    fetcher: (_input, init) => {
      const key = new Headers(init?.headers).get("Idempotency-Key");
      return key === "replayed"
        ? replayedResponse.promise
        : freshResponse.promise;
    },
  });
  const replayed = client.heartbeat(body, undefined, "replayed");
  const fresh = client.heartbeat(body, undefined, "fresh");
  freshResponse.resolve(
    heartbeatResponse(
      workerHostId,
      [],
      [],
      workerSessionId,
      "1",
    ),
  );
  replayedResponse.resolve(
    heartbeatResponse(
      workerHostId,
      [],
      [],
      workerSessionId,
      "1",
      [],
      { headers: { "Idempotent-Replayed": "true" } },
    ),
  );
  const [replayedResult, freshResult] = await Promise.all([replayed, fresh]);
  assertEquals(replayedResult.replayed, true);
  assertEquals(freshResult.replayed, false);
});
