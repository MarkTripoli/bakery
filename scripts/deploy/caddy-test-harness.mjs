import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";

// Shared helpers for the real-Caddy tests (caddy.test.mjs, railway-caddy.test.mjs).

export async function backend(t, sha) {
  let healthRequests = 0, failAt = 0;
  const server = createServer((req, res) => {
    if (req.url === "/v1/me") {
      res.writeHead(401).end();
      return;
    }
    let value;
    if (req.url === "/health/ready") {
      healthRequests++;
      value = {
        state: "ok",
        version: healthRequests === failAt ? "wrong" : sha,
      };
    } else value = { bootstrapped: true };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    port: server.address().port,
    failSecondHealth: () => {
      failAt = healthRequests + 2;
    },
  };
}

export async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Backend that records every request and can be stopped and restarted on the
 * same port, to exercise proxy retries across an upstream restart.
 */
export async function echoBackend(t) {
  const requests = [];
  const handler = (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  };
  let server;
  let port = 0;
  const listen = async () => {
    server = createServer(handler);
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    port = server.address().port;
  };
  const stop = async () => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  await listen();
  t.after(stop);
  return {
    get port() {
      return port;
    },
    requests,
    stop,
    start: listen,
  };
}

/**
 * Starts a real Caddy on a Caddyfile and waits until `readyUrl` answers.
 * `env` is merged over a minimal environment; HOME and XDG dirs point at `dir`.
 */
export async function startCaddy(t, { binary, caddyfile, env, dir, readyUrl }) {
  const child = spawn(binary, [
    "run",
    "--config",
    caddyfile,
    "--adapter",
    "caddyfile",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      XDG_DATA_HOME: dir,
      XDG_CONFIG_HOME: dir,
      ...env,
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
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(readyUrl, { signal: AbortSignal.timeout(2000) });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Caddy not ready: ${lastError?.message}; ${logs}`);
}
