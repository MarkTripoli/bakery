// Serves the built Storybook (`storybook-static/`) over plain HTTP for the
// browser suites. The Playwright config's default `webServer` is the Storybook
// dev server, which compiles each story on first request; under three
// concurrent sweeps on the CI runner that first request regularly exceeds the
// suites' visibility timeout and the run fails on whichever story lost the
// race. The static build has nothing left to compile, so every story loads
// in constant time, and `servedBuildIdentityIssues` (storybook-harness.ts)
// pins what is served to what was built.
//
//   node scripts/serve-storybook-static.mjs [--port 6006] [--root storybook-static]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function parseArgs(argv) {
  const args = { port: 6006, root: "storybook-static" };
  for (let index = 0; index < argv.length; index += 1) {
    // `pnpm run script -- --port N` forwards the separator itself.
    if (argv[index] === "--") continue;
    if (argv[index] === "--port") args.port = Number(argv[++index]);
    else if (argv[index] === "--root") args.root = argv[++index];
    else throw new Error(`Unknown argument ${argv[index]}`);
  }
  if (!Number.isInteger(args.port) || args.port < 0) {
    throw new Error("--port must be a non-negative integer");
  }
  return args;
}

export function startStaticServer({ root, port = 0, host = "127.0.0.1" }) {
  const rootPath = resolve(root);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    // normalize() resolves `..` so the join can never escape the root.
    const filePath = join(rootPath, normalize(pathname));
    if (!filePath.startsWith(rootPath)) {
      response.writeHead(403);
      response.end();
      return;
    }
    let body;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
      body = await readFile(filePath);
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    // Headers only once the bytes are in hand: a read failing after a 200 was
    // sent would otherwise throw in the handler and leave the request open.
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(filePath)] ??
        "application/octet-stream",
      "content-length": body.byteLength,
      "cache-control": "no-store",
    });
    response.end(body);
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      const address = server.address();
      resolvePromise({
        server,
        url: `http://${host}:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const args = parseArgs(process.argv.slice(2));
  const started = await startStaticServer(args);
  console.log(`Serving ${resolve(args.root)} at ${started.url}`);
}
