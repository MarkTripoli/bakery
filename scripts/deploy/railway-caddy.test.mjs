import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { echoBackend, startCaddy, unusedPort } from "./caddy-test-harness.mjs";

const caddy = process.env.CADDY_BINARY ?? "caddy";
const caddyfile = fileURLToPath(
  new URL("../../infra/railway/Caddyfile", import.meta.url),
);

async function site(t) {
  const directory = await mkdtemp(join(tmpdir(), "bakery-railway-caddy-"));
  // Caddy is stopped by a hook registered later and may still be writing.
  t.after(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    })
  );
  const root = join(directory, "srv");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<main>bakery spa</main>");
  await writeFile(join(root, "assets", "app.js"), "export default 1");
  await writeFile(join(root, "assets", "app.js.map"), "{}");
  return { directory, root };
}

async function proxy(t, { trusted, header, backend }) {
  const { directory, root } = await site(t);
  const port = await unusedPort();
  await startCaddy(t, {
    binary: caddy,
    caddyfile,
    dir: directory,
    readyUrl: `http://127.0.0.1:${port}/`,
    env: {
      PORT: String(port),
      BAKERY_API_UPSTREAM: `127.0.0.1:${backend.port}`,
      BAKERY_WEB_ROOT: root,
      BAKERY_WEB_GRACE_PERIOD: "250ms",
      ...(trusted ? { BAKERY_WEB_TRUSTED_PROXIES: trusted } : {}),
      ...(header ? { BAKERY_WEB_CLIENT_IP_HEADER: header } : {}),
    },
  });
  return `http://127.0.0.1:${port}`;
}

const lastRequest = (backend) => backend.requests.at(-1);

test("a trusted peer's client address header replaces any client-sent X-Forwarded-For", async (t) => {
  const backend = await echoBackend(t);
  const origin = await proxy(t, {
    trusted: "127.0.0.1/32",
    header: "X-Real-IP",
    backend,
  });
  const response = await fetch(`${origin}/v1/me`, {
    headers: {
      "X-Forwarded-For": "203.0.113.9",
      "X-Real-IP": "198.51.100.7",
      "X-Bakery-Remote-Addr": "192.0.2.99",
      Forwarded: "for=192.0.2.98",
    },
  });
  assert.equal(response.status, 200);
  const seen = lastRequest(backend).headers;
  assert.equal(seen["x-forwarded-for"], "198.51.100.7");
  assert.equal(seen["x-bakery-remote-addr"], undefined);
  assert.equal(seen["x-real-ip"], undefined);
  assert.equal(seen.forwarded, undefined);
});

test("an untrusted peer cannot choose the client address", async (t) => {
  const backend = await echoBackend(t);
  const origin = await proxy(t, {
    trusted: "192.0.2.1/32",
    header: "X-Real-IP",
    backend,
  });
  await fetch(`${origin}/v1/me`, {
    headers: {
      "X-Forwarded-For": "203.0.113.9",
      "X-Real-IP": "198.51.100.7",
      "X-Bakery-Remote-Addr": "192.0.2.99",
    },
  });
  const seen = lastRequest(backend).headers;
  assert.equal(seen["x-forwarded-for"], "127.0.0.1");
  assert.equal(seen["x-bakery-remote-addr"], undefined);
});

test("default trust list is loopback only and reads X-Forwarded-For", async (t) => {
  const backend = await echoBackend(t);
  const origin = await proxy(t, { backend });
  await fetch(`${origin}/api/auth/get-session`, {
    headers: { "X-Forwarded-For": "203.0.113.9" },
  });
  assert.equal(lastRequest(backend).headers["x-forwarded-for"], "203.0.113.9");
});

test("API, MCP and OAuth discovery paths reach the backend", async (t) => {
  const backend = await echoBackend(t);
  const origin = await proxy(t, { backend });
  for (
    const path of [
      "/mcp",
      "/mcp/x",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/api/auth",
      "/v1/x",
      "/api/x",
      "/health/ready",
      "/livez",
      "/readyz",
      // Caddy's `/x/*` needs the trailing slash, so every bare prefix the api
      // owns is listed here too: each one used to reach the SPA catch-all.
      "/health",
      "/v1",
      "/api",
    ]
  ) {
    const before = backend.requests.length;
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(backend.requests.length, before + 1, path);
    assert.equal(lastRequest(backend).url, path);
  }
});

// Regression: `GET /health` once answered 200 text/html with the SPA shell, so a monitor
// pointed at the most guessable health path on a box we gate deploys on could
// never go red. The SPA must not be allowed to answer this path again.
test("the bare /health reaches the health app and never the SPA shell", async (t) => {
  const backend = await echoBackend(t);
  const origin = await proxy(t, { backend });
  const response = await fetch(`${origin}/health`);
  assert.equal(response.status, 200);
  assert.doesNotMatch(
    response.headers.get("content-type") ?? "",
    /text\/html/,
    "the SPA catch-all answered /health",
  );
  const body = await response.text();
  assert.doesNotMatch(body, /bakery spa/);
  assert.equal(JSON.parse(body).url, "/health");
  assert.equal(lastRequest(backend).url, "/health");
});

test("static routes: SPA fallback is no-store, assets immutable, source maps 404", async (t) => {
  const backend = await echoBackend(t);
  const origin = await proxy(t, { backend });
  const spa = await fetch(`${origin}/some/route`);
  assert.equal(spa.status, 200);
  assert.equal(spa.headers.get("cache-control"), "no-store");
  assert.match(await spa.text(), /bakery spa/);
  const asset = await fetch(`${origin}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.equal(
    asset.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal((await fetch(`${origin}/assets/app.js.map`)).status, 404);
  assert.equal(
    backend.requests.length,
    0,
    JSON.stringify(backend.requests.map((r) => r.url)),
  );
});

test("a request in flight during an API restart succeeds within the retry window", async (t) => {
  const backend = await echoBackend(t);
  const origin = await proxy(t, { backend });
  assert.equal((await fetch(`${origin}/health/ready`)).status, 200);
  await backend.stop();
  const pending = fetch(`${origin}/health/ready`, {
    signal: AbortSignal.timeout(9000),
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await backend.start();
  const response = await pending;
  assert.equal(response.status, 200);
});
