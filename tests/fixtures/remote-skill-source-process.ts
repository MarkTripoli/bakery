const root = Deno.args[0];
const nonce = Deno.args[1];
if (!root || !nonce || Deno.args.length !== 2) {
  throw new Error("FIXTURE_IDENTITY_REQUIRED");
}

const gitBackend = "/usr/lib/git-core/git-http-backend";
let archiveName = "archive-first.gz";
const observations: Array<Readonly<{ path: string; ifMatch: string | null }>> =
  [];
const encoder = new TextEncoder();

async function runGit(args: readonly string[]): Promise<void> {
  const result = await new Deno.Command("/usr/bin/git", {
    args: [...args],
    clearEnv: true,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  if (!result.success) throw new Error("FIXTURE_GIT_CONTROL_FAILED");
}

function cgiEnvironment(request: Request, url: URL): Record<string, string> {
  const contentLength = request.headers.get("content-length") ?? "";
  return {
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname,
    REQUEST_METHOD: request.method,
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: request.headers.get("content-type") ?? "",
    CONTENT_LENGTH: contentLength,
    REMOTE_ADDR: "127.0.0.1",
    SERVER_PROTOCOL: "HTTP/1.1",
    SERVER_NAME: "127.0.0.1",
    SERVER_PORT: url.port,
    HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
  };
}

async function gitResponse(request: Request, url: URL): Promise<Response> {
  const child = new Deno.Command(gitBackend, {
    clearEnv: true,
    env: cgiEnvironment(request, url),
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const writer = child.stdin.getWriter();
  const body = new Uint8Array(await request.arrayBuffer());
  await writer.write(body);
  await writer.close();
  const output = await child.output();
  if (!output.success) return new Response(null, { status: 500 });
  const text = new TextDecoder("latin1").decode(output.stdout);
  const separator = text.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const boundary = text.indexOf(separator);
  if (boundary < 0) return new Response(null, { status: 500 });
  const headerText = text.slice(0, boundary);
  const headerBytes = encoder.encode(headerText + separator).byteLength;
  const headers = new Headers();
  let status = 200;
  for (const line of headerText.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index < 1) continue;
    const name = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (name.toLowerCase() === "status") status = Number(value.slice(0, 3));
    else headers.append(name, value);
  }
  return new Response(output.stdout.slice(headerBytes), { status, headers });
}

function oversizedBody(): ReadableStream<Uint8Array> {
  let remaining = 12 * 1024 * 1024 + 1;
  return new ReadableStream({
    pull(controller) {
      if (remaining === 0) return controller.close();
      const size = Math.min(64 * 1024, remaining);
      remaining -= size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen({ port }) {
    console.log(`FIXTURE_PORT=${port}`);
  },
}, async (request) => {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/repository.git/")) {
    observations.push(Object.freeze({
      path: `${url.pathname}${url.search}`,
      ifMatch: request.headers.get("if-match"),
    }));
    return await gitResponse(request, url);
  }
  if (request.method === "POST" && url.pathname === "/control/git/second") {
    const commit = (await Deno.readTextFile(`${root}/second-commit`)).trim();
    await runGit([
      "--git-dir",
      `${root}/repository.git`,
      "update-ref",
      "refs/tags/v1",
      commit,
    ]);
    return new Response(null, { status: 204 });
  }
  if (request.method === "POST" && url.pathname === "/control/archive/second") {
    archiveName = "archive-second.gz";
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/control/identity") {
    return Response.json({ nonce, origin: url.origin });
  }
  if (url.pathname === "/control/observations") {
    return Response.json(observations);
  }
  observations.push(Object.freeze({
    path: url.pathname,
    ifMatch: request.headers.get("if-match"),
  }));
  if (url.pathname === "/archive-redirect") {
    return new Response(null, {
      status: 302,
      headers: { location: "/archive" },
    });
  }
  if (url.pathname === "/archive-timeout") {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (url.pathname === "/archive-oversized") {
    return new Response(oversizedBody(), {
      status: 200,
      headers: { etag: '"fixture-revision-1"' },
    });
  }
  const selected = url.pathname === "/archive-invalid"
    ? "archive-invalid.gz"
    : archiveName;
  const fixtureVariant = url.pathname.startsWith("/archive-fixture-") &&
    /^\/archive-fixture-[a-z][a-z-]{0,40}$/.test(url.pathname);
  if (
    url.pathname !== "/archive" && url.pathname !== "/archive-invalid" &&
    url.pathname !== "/archive-timeout" && !fixtureVariant
  ) {
    return new Response(null, { status: 404 });
  }
  const expected = '"fixture-revision-1"';
  if (request.headers.get("if-match") !== expected) {
    return new Response(null, { status: 412, headers: { etag: expected } });
  }
  return new Response(await Deno.readFile(`${root}/${selected}`), {
    status: 200,
    headers: {
      etag: expected,
      "content-type": "application/gzip",
    },
  });
});
