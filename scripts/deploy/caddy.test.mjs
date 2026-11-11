import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { backend, unusedPort } from "./caddy-test-harness.mjs";
import { renderCaddy, smoke, transition, writeAtomic } from "./release.mjs";

const run = promisify(execFile);
const caddy = process.env.CADDY_BINARY ?? "caddy";
const blue = "a".repeat(40), green = "b".repeat(40);

test("real Caddy reload restores blue after public green failure and supports immutable rollback", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bakery-caddy-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = await backend(t, blue), next = await backend(t, green);
  const publicPort = await unusedPort(),
    bluePort = await unusedPort(),
    greenPort = await unusedPort();
  for (const [slot, sha] of [["blue", blue], ["green", green]]) {
    const dist = join(directory, "slots", slot, "apps/web/dist");
    await mkdir(dist, { recursive: true });
    await writeAtomic(
      join(dist, "index.html"),
      `<script type="module" src="/assets/${sha}.js"></script>`,
    );
    await writeAtomic(join(dist, "_release.json"), JSON.stringify({ sha }));
    await writeAtomic(
      join(directory, "static/assets", `${sha}.js`),
      `export default '${sha}'`,
    );
    await writeAtomic(
      join(directory, "static/assets", `${sha}.js.map`),
      '{"version":3}',
    );
  }
  const address = `unix/${directory}/admin.sock`;
  const configPath = join(directory, "Caddy.json");
  const proxyConfig = async (active) => {
    const template = join(directory, "Caddyfile");
    await writeAtomic(
      template,
      renderCaddy(
        {
          publicIp: "203.0.113.10",
          publicHost: "bakery.example.com",
          acmeEmail: "ops@example.com",
        },
        active,
        directory,
      ),
    );
    const { stdout } = await run(caddy, [
      "adapt",
      "--config",
      template,
      "--adapter",
      "caddyfile",
    ]);
    const adapted = JSON.parse(stdout);
    const servers = Object.values(adapted.apps.http.servers);
    const publicServer = servers.find((s) =>
      s.routes.some((r) =>
        r.match?.some((m) => m.host?.includes("bakery.example.com"))
      )
    );
    const route = publicServer.routes.find((r) =>
      r.match?.some((m) => m.host?.includes("bakery.example.com"))
    );
    route.match = [{ host: ["127.0.0.1"] }];
    const candidate = (port, original) => ({
      ...servers.find((s) => s.listen.includes(`127.0.0.1:${original}`)),
      listen: [`127.0.0.1:${port}`],
    });
    const config = {
      admin: { listen: address, config: { persist: false } },
      apps: {
        http: {
          servers: {
            public: {
              listen: [`127.0.0.1:${publicPort}`],
              routes: [route],
              automatic_https: { disable: true },
            },
            blue: candidate(bluePort, 19000),
            green: candidate(greenPort, 19001),
          },
        },
      },
    };
    const bytes = JSON.stringify(config).replaceAll(
      "127.0.0.1:18000",
      `127.0.0.1:${old.port}`,
    ).replaceAll("127.0.0.1:18001", `127.0.0.1:${next.port}`);
    await writeAtomic(configPath, bytes);
    await run(caddy, ["validate", "--config", configPath]);
  };
  await proxyConfig({ sha: blue, slot: "blue" });
  const child = spawn(caddy, ["run", "--config", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
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
  const origin = `http://127.0.0.1:${publicPort}`;
  let ready = false, lastError;
  for (let i = 0; i < 50; i++) {
    try {
      await smoke(origin, blue);
      ready = true;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert(ready, `local Caddy readiness: ${lastError?.message}; ${logs}`);
  // MCP and OAuth discovery must reach the API, never the SPA fallback.
  for (
    const path of [
      "/mcp",
      "/mcp/session",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/api/auth",
    ]
  ) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /json/, path);
    assert.deepEqual(await response.json(), { bootstrapped: true }, path);
  }
  // Source maps stay private even under the immutable assets handler.
  assert.equal((await fetch(`${origin}/assets/${blue}.js`)).status, 200);
  assert.equal((await fetch(`${origin}/assets/${blue}.js.map`)).status, 404);
  const journal = join(directory, "state.json");
  const store = {
    read: async () => JSON.parse(await readFile(journal, "utf8")),
    write: (value) => writeAtomic(journal, JSON.stringify(value)),
  };
  await store.write({
    format: 1,
    phase: "committed",
    active: { sha: blue, slot: "blue" },
    previous: null,
    migrations: {},
  });
  const operations = {
    prepare: () => {},
    backup: () => {},
    services: () => {},
    nativeProbe: () => {},
    startApi: () => {},
    stopApi: () => {},
    background: () => {},
    backgroundSmoke: () => {},
    manifest: (sha) => ({
      format: 1,
      sha,
      architecture: "arm64",
      release: `bakery@${sha}`,
      migrations: {},
      assets: {},
      expand: [],
    }),
    greenSmoke: (active) =>
      smoke(
        `http://127.0.0.1:${active.slot === "blue" ? bluePort : greenPort}`,
        active.sha,
      ),
    switchProxy: async (active) => {
      await proxyConfig(active);
      await run(caddy, [
        "reload",
        "--config",
        configPath,
        "--address",
        address,
      ]);
    },
    publicSmoke: (active) => smoke(origin, active.sha),
  };
  next.failSecondHealth();
  await assert.rejects(
    transition(store, operations, green, "c".repeat(64)),
    /RELEASE_NOT_READY/,
  );
  await smoke(origin, blue);
  assert.equal((await store.read()).active.sha, blue);
  await transition(store, operations, green, "c".repeat(64));
  await smoke(origin, green);
  assert.equal((await fetch(`${origin}/assets/${blue}.js`)).status, 200);
  await transition(store, operations, blue, undefined, true);
  await smoke(origin, blue);
  assert.equal((await fetch(`${origin}/assets/${green}.js`)).status, 200);
});
