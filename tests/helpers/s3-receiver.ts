/**
 * A tiny in-process S3-compatible receiver on loopback: path-style PUT, GET and
 * DELETE of objects, with one access key it answers 403 to in the way a real
 * service does (naming the key in its message).
 */
export function startS3Receiver(options: { rejectKey?: string } = {}) {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const requests: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const authorization = request.headers.get("authorization") ?? "";
      const used = /Credential=([^/]+)\//.exec(authorization)?.[1] ?? "";
      if (options.rejectKey !== undefined && used === options.rejectKey) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidAccessKeyId</Code><Message>The access key ${used} does not exist in our records.</Message></Error>`,
          { status: 403, headers: { "content-type": "application/xml" } },
        );
      }
      if (request.method === "PUT") {
        objects.set(
          url.pathname,
          new Uint8Array(await request.arrayBuffer()),
        );
        return new Response(null, {
          status: 200,
          headers: { etag: '"fixture"' },
        });
      }
      if (request.method === "GET") {
        const body = objects.get(url.pathname);
        return body === undefined
          ? new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
            headers: { "content-type": "application/xml" },
          })
          : new Response(body, { status: 200 });
      }
      if (request.method === "DELETE") {
        objects.delete(url.pathname);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    stop: () => server.shutdown(),
  };
}
