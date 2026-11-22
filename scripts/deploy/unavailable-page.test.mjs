import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { echoBackend, unusedPort } from "./caddy-test-harness.mjs";
import { renderCaddy, writeAtomic } from "./release.mjs";

// #59 slice 5: while the API cannot be reached, a page request gets one static
// page with status 503 that says whether Bakery is being updated (the
// launcher's marker exists) or only not answering. API requests keep Caddy's
// own error.

const run = promisify(execFile);
const caddy = process.env.CADDY_BINARY ?? "caddy";
const page = fileURLToPath(new URL("./unavailable.html", import.meta.url));

const WORDS = {
  updatingTitle: "Bakery is being updated",
  updating:
    "This usually takes a few minutes. Work that was running carries on by itself afterwards. This page checks again every 15 seconds.",
  downTitle: "Bakery is not answering right now",
  down: "It may be restarting. This page checks again every 15 seconds.",
  both:
    "If this lasts more than a few minutes, tell whoever runs your Bakery server.",
};

/** The public site of the production Caddyfile, on loopback, over `api`. */
async function proxy(t, api) {
  const directory = await mkdtemp(join(tmpdir(), "bakery-unavailable-"));
  t.after(() =>
    rm(directory, { recursive: true, force: true, maxRetries: 20 })
  );
  const dist = join(directory, "slots/blue/apps/web/dist");
  await mkdir(dist, { recursive: true });
  await writeAtomic(join(dist, "index.html"), "<main>bakery spa</main>");
  await writeAtomic(join(directory, "static/assets/app.js"), "export {}");
  await mkdir(join(directory, "deploy"), { recursive: true });
  await copyFile(page, join(directory, "deploy/unavailable.html"));
  const markers = join(directory, "etc");
  await mkdir(markers, { recursive: true });
  const template = join(directory, "Caddyfile");
  await writeAtomic(
    template,
    renderCaddy(
      {
        publicIp: "203.0.113.10",
        publicHost: "bakery.example.com",
        acmeEmail: "ops@example.com",
      },
      { slot: "blue" },
      directory,
      markers,
    ),
  );
  const { stdout } = await run(caddy, [
    "adapt",
    "--config",
    template,
    "--adapter",
    "caddyfile",
  ]);
  const servers = Object.values(JSON.parse(stdout).apps.http.servers);
  const isPublic = (route) =>
    route.match?.some((m) => m.host?.includes("bakery.example.com"));
  const server = servers.find((s) => s.routes.some(isPublic));
  const route = server.routes.find(isPublic);
  route.match = [{ host: ["127.0.0.1"] }];
  const errors = server.errors.routes.find(isPublic);
  errors.match = [{ host: ["127.0.0.1"] }];
  const port = await unusedPort();
  const config = JSON.stringify({
    admin: { disabled: true },
    apps: {
      http: {
        servers: {
          public: {
            listen: [`127.0.0.1:${port}`],
            routes: [route],
            errors: { routes: [errors] },
            automatic_https: { disable: true },
          },
        },
      },
    },
  }).replaceAll("127.0.0.1:18000", `127.0.0.1:${api.port}`);
  const configPath = join(directory, "Caddy.json");
  await writeAtomic(configPath, config);
  const child = spawn(caddy, ["run", "--config", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_DATA_HOME: directory,
      XDG_CONFIG_HOME: directory,
    },
  });
  let logs = "";
  child.stderr.on("data", (bytes) => {
    logs = (logs + bytes).slice(-4000);
  });
  const stopped = once(child, "exit");
  t.after(async () => {
    child.kill("SIGTERM");
    await stopped;
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0;; attempt++) {
    try {
      await fetch(`${origin}/assets/app.js`);
      break;
    } catch {
      if (attempt > 100) throw new Error(`Caddy not ready: ${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    origin,
    marker: join(markers, "update-in-progress"),
  };
}

const text = (html) =>
  html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();

test("pages load while the API answers its liveness check", async (t) => {
  const api = await echoBackend(t);
  const { origin } = await proxy(t, api);
  for (const path of ["/", "/tasks/42"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), "<main>bakery spa</main>", path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
  }
  // The check asks the liveness route with no credentials of the visitor.
  const checks = api.requests.filter((r) => r.url === "/health/live");
  assert.equal(checks.length, 2);
  assert.equal(checks[0].method, "GET");
  assert.equal(checks[0].headers.cookie, undefined);
});

test("with the API away and no marker, a page says Bakery is not answering", async (t) => {
  const api = await echoBackend(t);
  const { origin } = await proxy(t, api);
  await api.stop();
  const response = await fetch(`${origin}/tasks/42`, {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /<meta http-equiv="refresh" content="15">/);
  assert.equal(
    text(html),
    `${WORDS.downTitle} Bakery ${WORDS.downTitle} ${WORDS.down} ${WORDS.both}`,
  );
  assert.doesNotMatch(html, /being updated/);
  // API and asset requests keep their own answers.
  const apiResponse = await fetch(`${origin}/v1/me`);
  assert.equal(apiResponse.status, 502);
  assert.doesNotMatch(await apiResponse.text(), /Bakery/);
  assert.equal((await fetch(`${origin}/assets/app.js`)).status, 200);
  // Back again: the page loads as before.
  await api.start();
  assert.equal((await fetch(`${origin}/tasks/42`)).status, 200);
});

test("with the API away and the launcher's marker, a page says Bakery is being updated", async (t) => {
  const api = await echoBackend(t);
  const { origin, marker } = await proxy(t, api);
  await api.stop();
  await writeAtomic(marker, "2026-11-22T12:00:00.000Z\n");
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.equal(
    text(html),
    `${WORDS.updatingTitle} Bakery ${WORDS.updatingTitle} ${WORDS.updating} ${WORDS.both}`,
  );
  assert.doesNotMatch(html, /not answering/);
});

test("the page stands alone: styles inline, light and dark, no script", async () => {
  const html = await readFile(page, "utf8");
  assert.match(html, /<meta http-equiv="refresh" content="15">/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /<script|<link|<img|src=|href=/);
  assert.doesNotMatch(html, /Nothing was lost/i);
});
