import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import {
  createDesktopCors,
  DESKTOP_CORS_ALLOWED_HEADERS,
  DESKTOP_CORS_EXPOSED_HEADERS,
} from "../../apps/server/src/platform/desktop-cors.ts";

const DESKTOP = "tauri://localhost";

function app(origins: readonly string[] | undefined) {
  const hono = new Hono();
  hono.use("*", createDesktopCors({ origins }));
  hono.get("/v1/me", (c) => c.json({ ok: true }, 200, { etag: '"v1"' }));
  hono.get(
    "/v1/refused",
    () =>
      new Response(JSON.stringify({ code: "AUTH_REQUIRED" }), {
        status: 401,
        headers: { "content-type": "application/problem+json" },
      }),
  );
  // A route whose response headers cannot be changed, as a response from fetch() has.
  hono.get("/v1/frozen", () => {
    const response = Response.error();
    return response.status === 0
      ? new Response("x", { status: 200 })
      : response;
  });
  hono.all(
    "/v1/events",
    () =>
      new Response(null, { status: 426, headers: { upgrade: "websocket" } }),
  );
  return hono;
}

function preflight(origin: string, extra: Record<string, string> = {}) {
  return new Request("http://bakery.test/v1/me", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
      ...extra,
    },
  });
}

Deno.test("a preflight from a configured desktop origin is answered without reaching a route", async () => {
  const response = await app([DESKTOP]).fetch(preflight(DESKTOP));
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("access-control-allow-origin"), DESKTOP);
  assertEquals(response.headers.get("vary"), "Origin");
  const headers = response.headers.get("access-control-allow-headers")!
    .split(", ");
  for (const name of DESKTOP_CORS_ALLOWED_HEADERS) {
    assert(headers.includes(name), name);
  }
  assert(headers.includes("authorization"));
  assert(
    response.headers.get("access-control-allow-methods")!.includes("PATCH"),
  );
  assertEquals(response.headers.get("access-control-max-age"), "600");
  // Credentials are never allowed: this opens the bearer path and not the cookie path.
  assertEquals(response.headers.get("access-control-allow-credentials"), null);
});

Deno.test("the origin is echoed and never a wildcard", async () => {
  const origins = ["tauri://localhost", "https://tauri.localhost"];
  for (const origin of origins) {
    const response = await app(origins).fetch(preflight(origin));
    assertEquals(response.headers.get("access-control-allow-origin"), origin);
    assert(response.headers.get("access-control-allow-origin") !== "*");
  }
});

Deno.test("a real call from a desktop origin carries the origin, the exposed headers and Vary", async () => {
  const response = await app([DESKTOP]).fetch(
    new Request("http://bakery.test/v1/me", {
      headers: { origin: DESKTOP, authorization: "Bearer bkd_x" },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("access-control-allow-origin"), DESKTOP);
  assertEquals(response.headers.get("vary"), "Origin");
  const exposed = response.headers.get("access-control-expose-headers")!
    .split(", ");
  for (const name of DESKTOP_CORS_EXPOSED_HEADERS) {
    assert(exposed.includes(name), name);
  }
  assertEquals(response.headers.get("access-control-allow-credentials"), null);
});

Deno.test("an error is readable by the page: a refusal carries the origin too", async () => {
  const response = await app([DESKTOP]).fetch(
    new Request("http://bakery.test/v1/refused", {
      headers: { origin: DESKTOP },
    }),
  );
  assertEquals(response.status, 401);
  assertEquals(response.headers.get("access-control-allow-origin"), DESKTOP);
});

Deno.test("any other origin gets no CORS header, and a preflight from it is not answered", async () => {
  for (
    const origin of [
      "https://evil.example",
      "http://localhost:3000",
      "null",
      "tauri://evil",
      "http://tauri.localhost",
    ]
  ) {
    const pre = await app([DESKTOP]).fetch(preflight(origin));
    assert(pre.status !== 204, origin);
    assertEquals(pre.headers.get("access-control-allow-origin"), null, origin);
    const real = await app([DESKTOP]).fetch(
      new Request("http://bakery.test/v1/me", { headers: { origin } }),
    );
    assertEquals(real.headers.get("access-control-allow-origin"), null, origin);
    assertEquals(
      real.headers.get("access-control-expose-headers"),
      null,
      origin,
    );
    // The answer still depends on the origin, so a shared cache must be told.
    assertEquals(real.headers.get("vary"), "Origin", origin);
  }
});

Deno.test("with no configured origins the middleware changes nothing", async () => {
  for (const origins of [undefined, []]) {
    const pre = await app(origins).fetch(preflight(DESKTOP));
    assert(pre.status !== 204);
    assertEquals(pre.headers.get("access-control-allow-origin"), null);
    const real = await app(origins).fetch(
      new Request("http://bakery.test/v1/me", { headers: { origin: DESKTOP } }),
    );
    assertEquals(real.status, 200);
    assertEquals(real.headers.get("access-control-allow-origin"), null);
    assertEquals(real.headers.get("vary"), null);
  }
});

Deno.test("a request with no Origin header is untouched", async () => {
  const response = await app([DESKTOP]).fetch(
    new Request("http://bakery.test/v1/me"),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("access-control-allow-origin"), null);
  assertEquals(response.headers.get("vary"), null);
});

Deno.test("a WebSocket upgrade from a desktop origin is left alone", async () => {
  const response = await app([DESKTOP]).fetch(
    new Request("http://bakery.test/v1/events", {
      headers: {
        origin: DESKTOP,
        upgrade: "websocket",
        connection: "Upgrade",
      },
    }),
  );
  assertEquals(response.status, 426);
  assertEquals(response.headers.get("access-control-allow-origin"), null);
});

Deno.test("a preflight is answered only when it asks for a method, so a plain OPTIONS is not CORS", async () => {
  const response = await app([DESKTOP]).fetch(
    new Request("http://bakery.test/v1/me", {
      method: "OPTIONS",
      headers: { origin: DESKTOP },
    }),
  );
  assert(response.status !== 204);
  assertEquals(response.headers.get("access-control-allow-methods"), null);
});

Deno.test("an origin that only begins with, ends with or contains an allowed one is not allowed", async () => {
  const configured = ["tauri://localhost", "http://tauri.localhost"];
  // Exact membership, not a prefix, suffix or substring: each of these would pass a loose match.
  for (
    const origin of [
      "tauri://localhost.evil.example",
      "tauri://localhost:1420",
      "tauri://localhostx",
      "tauri://evil-localhost",
      "xtauri://localhost",
      "tauri://localhost/",
      "http://tauri.localhost.evil.example",
      "http://tauri.localhost:8080",
      "https://tauri.localhost.evil.example",
      "https://tauri.localhost",
      "TAURI://LOCALHOST",
    ]
  ) {
    const pre = await app(configured).fetch(preflight(origin));
    assert(pre.status !== 204, `preflight ${origin}`);
    assertEquals(
      pre.headers.get("access-control-allow-origin"),
      null,
      `preflight ${origin}`,
    );
    const real = await app(configured).fetch(
      new Request("http://bakery.test/v1/me", { headers: { origin } }),
    );
    assertEquals(
      real.headers.get("access-control-allow-origin"),
      null,
      `call ${origin}`,
    );
    assertEquals(
      real.headers.get("access-control-expose-headers"),
      null,
      `call ${origin}`,
    );
  }
  // The exact origins still work.
  for (const origin of configured) {
    const response = await app(configured).fetch(preflight(origin));
    assertEquals(response.headers.get("access-control-allow-origin"), origin);
  }
});
