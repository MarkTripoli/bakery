import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";

Deno.test("worker client logs bounded redacted problem responses before throwing", async () => {
  const secret = "worker-secret-token";
  const logs: string[] = [];
  const client = new WorkerApiClient({
    baseUrl: "https://worker.example.test",
    credential: secret,
    logger: (message) => logs.push(message),
    fetcher: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: "UNPROCESSABLE",
            detail: `failure exposed ${secret} ${"d".repeat(2_000)}`,
            params: {
              authorization: secret,
              nested: { token: secret },
              visible: "kept",
            },
            requestId: "req-problem-1",
          }),
          {
            status: 422,
            headers: {
              "content-type": "application/problem+json",
              "X-Bakery-Worker-Protocol-Version": "2",
            },
          },
        ),
      ),
  });

  const error = await assertRejects(
    () =>
      client.claim({
        claimKey: crypto.randomUUID(),
        workerHostId: crypto.randomUUID(),
        capabilities: ["git"],
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
      }),
    WorkerRequestError,
    "UNPROCESSABLE",
  );

  assertEquals(error.status, 422);
  assertEquals(error.retryable, false);
  assertEquals(logs.length, 1);
  const problem = JSON.parse(logs[0]!);
  assertEquals(problem.component, "worker-client");
  assertEquals(problem.event, "problem_response");
  assertEquals(problem.route, "/v1/worker/claims");
  assertEquals(problem.code, "UNPROCESSABLE");
  assertEquals(problem.requestId, "req-problem-1");
  assertEquals(problem.params.authorization, "[REDACTED]");
  assertEquals(problem.params.nested.token, "[REDACTED]");
  assertEquals(problem.params.visible, "kept");
  assert(problem.detail.length <= 403);
  assert(logs[0]!.length < 2_000);
  assert(!logs[0]!.includes(secret));
  assertEquals(error.diagnostic, logs[0]);
});

Deno.test("worker client logs a problem before rejecting protocol drift", async () => {
  const logs: string[] = [];
  const client = new WorkerApiClient({
    baseUrl: "https://worker.example.test",
    credential: "synthetic-credential",
    logger: (message) => logs.push(message),
    fetcher: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: "UNPROCESSABLE",
            detail: "the server rejected this request",
            requestId: "req-protocol-1",
          }),
          {
            status: 422,
            headers: { "content-type": "application/problem+json" },
          },
        ),
      ),
  });

  const error = await assertRejects(
    () =>
      client.claim({
        claimKey: crypto.randomUUID(),
        workerHostId: crypto.randomUUID(),
        capabilities: ["git"],
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
      }),
    WorkerRequestError,
    "WORKER_PROTOCOL_UNSUPPORTED",
  );

  assertEquals(logs.length, 1);
  const problem = JSON.parse(logs[0]!);
  assertEquals(problem.route, "/v1/worker/claims");
  assertEquals(problem.code, "UNPROCESSABLE");
  assertEquals(problem.requestId, "req-protocol-1");
  assertEquals(error.diagnostic, logs[0]);
});

Deno.test("worker client redacts lease tokens echoed in problem detail", async () => {
  const leaseToken = "lease-token-secret";
  const logs: string[] = [];
  const client = new WorkerApiClient({
    baseUrl: "https://worker.example.test",
    credential: "synthetic-credential",
    logger: (message) => logs.push(message),
    fetcher: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: "UNPROCESSABLE",
            detail: `invalid leaseToken=${leaseToken}`,
            requestId: "req-lease-1",
          }),
          {
            status: 422,
            headers: {
              "content-type": "application/problem+json",
              "X-Bakery-Worker-Protocol-Version": "2",
            },
          },
        ),
      ),
  });

  const error = await assertRejects(
    () =>
      client.closeOutput(crypto.randomUUID(), {
        leaseToken,
        fence: "1",
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
        sessionId: crypto.randomUUID(),
        writerGeneration: "1",
        capture: "complete",
        reason: "clean-end",
      }, crypto.randomUUID()),
    WorkerRequestError,
    "UNPROCESSABLE",
  );

  assertEquals(logs.length, 1);
  assert(!logs[0]!.includes(leaseToken));
  assert(JSON.parse(logs[0]!).detail.includes("[REDACTED]"));
  assertEquals(error.diagnostic, logs[0]);
});

Deno.test("worker client marks serverProblem only on protocol-valid problem responses", async () => {
  const claimInput = () => ({
    claimKey: crypto.randomUUID(),
    workerHostId: crypto.randomUUID(),
    capabilities: ["git"],
    workerSessionId: crypto.randomUUID(),
    workerSessionGeneration: "1",
  });
  const clientFor = (respond: () => Response) =>
    new WorkerApiClient({
      baseUrl: "https://worker.example.test",
      credential: "synthetic-credential",
      logger: () => undefined,
      fetcher: () => Promise.resolve(respond()),
    });

  const problem = await assertRejects(
    () =>
      clientFor(() =>
        new Response(JSON.stringify({ code: "UNPROCESSABLE" }), {
          status: 422,
          headers: {
            "content-type": "application/problem+json",
            "X-Bakery-Worker-Protocol-Version": "2",
          },
        })
      ).claim(claimInput()),
    WorkerRequestError,
    "UNPROCESSABLE",
  );
  assertEquals(problem.serverProblem, true);

  const headerless = await assertRejects(
    () =>
      clientFor(() => Response.json({ code: "UPSTREAM" }, { status: 503 }))
        .claim(claimInput()),
    WorkerRequestError,
    "WORKER_PROTOCOL_UNSUPPORTED",
  );
  assertEquals(headerless.serverProblem, false);

  const statusInvalid = await assertRejects(
    () =>
      clientFor(() =>
        Response.json({}, {
          status: 201,
          headers: { "X-Bakery-Worker-Protocol-Version": "2" },
        })
      ).claim(claimInput()),
    WorkerRequestError,
  );
  assertEquals(statusInvalid.serverProblem, false);
});
