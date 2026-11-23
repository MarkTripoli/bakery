import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Fetcher,
  WorkerApiClient,
  WorkerRequestError,
} from "../../apps/worker/src/client.ts";

/**
 * The worker's two plugin-job calls (#29, B14.02): what they send, how they
 * read the answer, and that a refusal reaches the executor with its status.
 */

const ATTEMPT = crypto.randomUUID();
const PROOF = {
  leaseToken: "lease-token",
  fence: "3",
  workerSessionId: crypto.randomUUID(),
  workerSessionGeneration: "2",
};

function clientFor(
  respond: (request: Request) => Response | Promise<Response>,
  seen: Request[] = [],
) {
  const fetcher: Fetcher = async (input, init) => {
    const request = new Request(input, init);
    seen.push(request.clone());
    const response = await respond(request);
    const headers = new Headers(response.headers);
    // A real server echoes the protocol version the worker spoke.
    headers.set(
      "X-Bakery-Worker-Protocol-Version",
      request.headers.get("X-Bakery-Worker-Protocol-Version") ?? "",
    );
    return new Response(response.body, { status: response.status, headers });
  };
  return new WorkerApiClient({
    baseUrl: "http://server.test",
    credential: "worker-credential",
    fetcher,
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const CALL = {
  requestId: "r1",
  sequence: 1,
  operation: "state.read",
  args: { key: "a" },
};

Deno.test("a broker call carries the attempt's proof and the request id, and reads a result", async () => {
  const seen: Request[] = [];
  const client = clientFor(
    () =>
      json({ ok: true, result: { value: 1 }, replayed: false, denial: null }),
    seen,
  );
  const answer = await client.callPluginBroker(ATTEMPT, PROOF, CALL);
  assertEquals(answer.value, {
    ok: true,
    result: { value: 1 },
    replayed: false,
  });
  const request = seen[0];
  assertEquals(request.method, "POST");
  assertEquals(
    new URL(request.url).pathname,
    `/v1/worker/attempts/${ATTEMPT}/plugin-broker`,
  );
  assertEquals(request.headers.get("Idempotency-Key"), "r1");
  assertEquals(request.headers.get("X-Worker-Lease-Token"), "lease-token");
  assertEquals(request.headers.get("X-Worker-Fence"), "3");
  assertEquals(
    request.headers.get("X-Worker-Session-Id"),
    PROOF.workerSessionId,
  );
  assertEquals(request.headers.get("X-Worker-Session-Generation"), "2");
  assertEquals(
    request.headers.get("Authorization"),
    "Bearer worker-credential",
  );
  assertEquals(await request.json(), CALL);
});

Deno.test("a replayed result is read as replayed", async () => {
  const client = clientFor(() =>
    json({ ok: true, result: null, replayed: true, denial: null })
  );
  assertEquals(
    (await client.callPluginBroker(ATTEMPT, PROOF, CALL)).value,
    { ok: true, result: null, replayed: true },
  );
});

Deno.test("a broker denial is read as a denial", async () => {
  const client = clientFor(() =>
    json({ ok: false, result: null, replayed: null, denial: "install_off" })
  );
  assertEquals(
    (await client.callPluginBroker(ATTEMPT, PROOF, CALL)).value,
    { ok: false, denial: "install_off" },
  );
});

Deno.test("an answer that is neither a clean result nor a clean denial is refused", async () => {
  for (
    const wire of [
      { ok: true, result: 1, replayed: null, denial: null },
      { ok: true, result: 1, replayed: false, denial: "install_off" },
      { ok: false, result: null, replayed: null, denial: null },
      { ok: true, result: 1, replayed: false },
      { ok: true, result: 1, replayed: false, denial: null, extra: true },
      { ok: false, result: null, replayed: null, denial: "x".repeat(65) },
    ]
  ) {
    const client = clientFor(() => json(wire));
    await assertRejects(
      () => client.callPluginBroker(ATTEMPT, PROOF, CALL),
      Error,
      undefined,
      JSON.stringify(wire),
    );
  }
});

Deno.test("the files call sends no body, carries the proof and reads the files", async () => {
  const seen: Request[] = [];
  const body = {
    bundleDigest: "a".repeat(64),
    entry: "jobs/nightly.js",
    files: [{ path: "jobs/nightly.js", contentBase64: btoa("run()") }],
  };
  const client = clientFor(() => json(body), seen);
  assertEquals((await client.getPluginJobFiles(ATTEMPT, PROOF)).value, body);
  assertEquals(seen[0].method, "GET");
  assertEquals(
    new URL(seen[0].url).pathname,
    `/v1/worker/attempts/${ATTEMPT}/plugin-job-files`,
  );
  assertEquals(seen[0].headers.get("X-Worker-Lease-Token"), "lease-token");
  assertEquals(
    seen[0].headers.get("Authorization"),
    "Bearer worker-credential",
  );
  assertEquals(await seen[0].text(), "");
});

Deno.test("a malformed file list is refused", async () => {
  for (
    const body of [
      {
        bundleDigest: "nope",
        entry: "a",
        files: [{ path: "a", contentBase64: "" }],
      },
      { bundleDigest: "a".repeat(64), entry: "a", files: [] },
      { bundleDigest: "a".repeat(64), entry: "a", files: [{ path: "a" }] },
      {
        bundleDigest: "a".repeat(64),
        entry: "a",
        files: Array.from(
          { length: 257 },
          (_, i) => ({ path: `f${i}`, contentBase64: "" }),
        ),
      },
      {
        bundleDigest: "a".repeat(64),
        entry: "a",
        files: [{ path: "p".repeat(501), contentBase64: "" }],
      },
      {
        bundleDigest: "a".repeat(64),
        entry: "a".repeat(501),
        files: [{ path: "a", contentBase64: "" }],
      },
    ]
  ) {
    const client = clientFor(() => json(body));
    await assertRejects(() => client.getPluginJobFiles(ATTEMPT, PROOF));
  }
});

Deno.test("a refusal reaches the caller as an error that carries the status", async () => {
  const client = clientFor(() =>
    json({
      type: "about:blank",
      title: "State conflict",
      status: 409,
      code: "STATE_CONFLICT",
      detail: "x",
      requestId: crypto.randomUUID(),
      retryable: false,
    }, 409)
  );
  const error = await assertRejects(
    () => client.getPluginJobFiles(ATTEMPT, PROOF),
    WorkerRequestError,
  );
  assertEquals(error.status, 409);
  assert(error.retryable === false);
});
