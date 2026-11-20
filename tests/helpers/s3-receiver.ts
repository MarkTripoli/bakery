/**
 * A tiny in-process S3-compatible receiver on loopback: path-style PUT, GET,
 * HEAD and DELETE of objects, ListObjectsV2 (prefix and delimiter), multipart
 * upload, and one access key it answers 403 to in the way a real service does
 * (naming the key in its message).
 */
export function startS3Receiver(
  options: {
    rejectKey?: string;
    failPutUnder?: string;
    /** Makes HEAD report this many bytes more (or fewer) than the object holds. */
    headSizeDelta?: number;
  } = {},
) {
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const requests: string[] = [];
  const uploads = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
  const xml = (body: string, status = 200) =>
    new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
      status,
      headers: { "content-type": "application/xml" },
    });
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      const authorization = request.headers.get("authorization") ?? "";
      const used = /Credential=([^/]+)\//.exec(authorization)?.[1] ?? "";
      if (options.rejectKey !== undefined && used === options.rejectKey) {
        return xml(
          `<Error><Code>InvalidAccessKeyId</Code><Message>The access key ${used} does not exist in our records.</Message></Error>`,
          403,
        );
      }
      const uploadId = url.searchParams.get("uploadId");
      // Multipart upload.
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        const id = crypto.randomUUID();
        uploads.set(id, new Map());
        return xml(
          `<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>${url.pathname}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      if (request.method === "PUT" && uploadId !== null) {
        const parts = uploads.get(uploadId);
        if (!parts) return xml("<Error><Code>NoSuchUpload</Code></Error>", 404);
        const number = Number(url.searchParams.get("partNumber"));
        parts.set(number, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, {
          status: 200,
          headers: { etag: `"part-${number}"` },
        });
      }
      if (request.method === "POST" && uploadId !== null) {
        const parts = uploads.get(uploadId);
        if (!parts) return xml("<Error><Code>NoSuchUpload</Code></Error>", 404);
        const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(
          ([, bytes]) => bytes,
        );
        const whole = new Uint8Array(
          ordered.reduce((sum, bytes) => sum + bytes.length, 0),
        );
        let at = 0;
        for (const bytes of ordered) {
          whole.set(bytes, at);
          at += bytes.length;
        }
        objects.set(url.pathname, whole);
        uploads.delete(uploadId);
        return xml(
          `<CompleteMultipartUploadResult><Key>${url.pathname}</Key><ETag>"whole"</ETag></CompleteMultipartUploadResult>`,
        );
      }
      if (request.method === "DELETE" && uploadId !== null) {
        uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }
      if (request.method === "PUT") {
        if (
          options.failPutUnder !== undefined &&
          url.pathname.includes(options.failPutUnder)
        ) {
          return xml(
            "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>",
            403,
          );
        }
        objects.set(
          url.pathname,
          new Uint8Array(await request.arrayBuffer()),
        );
        return new Response(null, {
          status: 200,
          headers: { etag: '"fixture"' },
        });
      }
      // ListObjectsV2: GET /<bucket>?list-type=2&prefix=&delimiter=
      if (
        request.method === "GET" && url.searchParams.get("list-type") === "2"
      ) {
        const bucket = url.pathname.replace(/^\/|\/$/g, "");
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter") ?? "";
        const base = `/${bucket}/`;
        const contents: string[] = [];
        const common = new Set<string>();
        for (const [path, bytes] of [...objects.entries()].sort()) {
          if (!path.startsWith(base)) continue;
          const key = path.slice(base.length);
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const cut = delimiter === "" ? -1 : rest.indexOf(delimiter);
          if (cut >= 0) {
            common.add(`${prefix}${rest.slice(0, cut + delimiter.length)}`);
          } else {
            contents.push(
              `<Contents><Key>${key}</Key><Size>${bytes.length}</Size></Contents>`,
            );
          }
        }
        const prefixes = [...common].map((p) =>
          `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`
        );
        return xml(
          `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${
            contents.length + prefixes.length
          }</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${
            contents.join("")
          }${prefixes.join("")}</ListBucketResult>`,
        );
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const body = objects.get(url.pathname);
        if (body === undefined) {
          return request.method === "HEAD"
            ? new Response(null, { status: 404 })
            : xml("<Error><Code>NoSuchKey</Code></Error>", 404);
        }
        // Deno.serve drops the body of a HEAD answer but keeps the length it implies.
        const lie = request.method === "HEAD" ? options.headSizeDelta ?? 0 : 0;
        const answer = lie === 0 ? body : new Uint8Array(body.length + lie);
        return new Response(answer, {
          status: 200,
          headers: { "content-length": String(answer.length) },
        });
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
