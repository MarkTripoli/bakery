import { assertEquals } from "@std/assert";
import { createHealthApp } from "../../packages/contracts/src/health-app.ts";

const app = createHealthApp({
  service: "bakery-server",
  version: "test",
  config: { missingConfig: [] },
  dependencies: [
    { name: "migrations", check: () => true },
    { name: "dispatch", check: () => false },
  ],
});

async function request(path: string): Promise<Response> {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0 },
    app.fetch,
  );
  const address = server.addr;
  if (address.transport !== "tcp") {
    await server.shutdown();
    throw new Error("Expected a TCP test listener");
  }
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("liveness is available while readiness reflects dependencies", async () => {
  const live = await request("/health/live");
  assertEquals(live.status, 200);
  assertEquals(await live.json(), {
    service: "bakery-server",
    state: "ok",
    version: "test",
    dependencies: [],
  });

  const ready = await request("/health/ready");
  assertEquals(ready.status, 503);
  assertEquals(await ready.json(), {
    service: "bakery-server",
    state: "unavailable",
    version: "test",
    dependencies: [
      { name: "migrations", state: "ok", reason: "AVAILABLE" },
      {
        name: "dispatch",
        state: "unavailable",
        reason: "DEPENDENCY_UNAVAILABLE",
      },
    ],
  });
});

Deno.test("health aliases preserve status and body", async () => {
  const response = await request("/livez");
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    service: "bakery-server",
    state: "ok",
    version: "test",
    dependencies: [],
  });

  const ready = await request("/readyz");
  assertEquals(ready.status, 503);
  assertEquals(await ready.json(), {
    service: "bakery-server",
    state: "unavailable",
    version: "test",
    dependencies: [
      { name: "migrations", state: "ok", reason: "AVAILABLE" },
      {
        name: "dispatch",
        state: "unavailable",
        reason: "DEPENDENCY_UNAVAILABLE",
      },
    ],
  });
});

// Regression: the bare /health is the path an uninformed caller or an off-the-shelf
// monitor reaches for. It answers readiness, not liveness, because readiness is
// the only probe here that can report ill health — including the fail-closed
// dependency verdict from aba2f985.
Deno.test("the bare /health answers readiness, byte for byte", async () => {
  const bare = await request("/health");
  const ready = await request("/health/ready");
  assertEquals(bare.status, ready.status);
  assertEquals(bare.status, 503);
  assertEquals(
    bare.headers.get("content-type"),
    ready.headers.get("content-type"),
  );
  assertEquals(await bare.text(), await ready.text());
});

Deno.test("the bare /health fails closed when a dependency throws", async () => {
  const unreachable = createHealthApp({
    service: "bakery-server",
    version: "test",
    config: { missingConfig: [] },
    dependencies: [{
      name: "database",
      check: () => {
        throw new Error("connection refused");
      },
    }],
  });
  const response = await unreachable.request("/health");
  assertEquals(response.status, 503);
  assertEquals((await response.json()).state, "unavailable");
});

Deno.test("the bare /health does not answer a non-GET method", async () => {
  assertEquals((await app.request("/health", { method: "POST" })).status, 404);
});
