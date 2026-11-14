import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  BootstrapError,
  boundedDownload,
  type DownloadOptions,
  type InstallOptions,
} from "../../packages/worker-bootstrap/src/index.ts";

// #18 slice 3: the download itself is bounded before the signed digest and size
// are checked: one origin, a short redirect chain that stays on it, no
// compression, a size that never exceeds the signed one, and no stalls.

const ORIGIN = "https://releases.bakery.example";
const PATH = "/releases/1.2.3/bakery-worker-linux-x64";
const BODY = new TextEncoder().encode("#!/bin/sh\necho bakery worker 1.2.3\n");

type Call = { url: string; init: RequestInit };

function network(
  answers: (call: Call, index: number) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  return {
    calls,
    fetch: ((url: string, init: RequestInit) => {
      const call = { url: String(url), init };
      calls.push(call);
      return Promise.resolve(answers(call, calls.length - 1));
    }) as unknown as typeof fetch,
  };
}

const file = (
  body: Uint8Array<ArrayBuffer> = BODY,
  headers: Record<string, string> = {},
) => new Response(body, { status: 200, headers });

const redirect = (location: string | null, status = 302) =>
  new Response(null, {
    status,
    headers: location === null ? {} : { location },
  });

function options(
  fake: { fetch: typeof fetch },
  overrides: Partial<DownloadOptions> = {},
): DownloadOptions {
  return {
    origin: ORIGIN,
    path: PATH,
    expectedBytes: BODY.byteLength,
    fetch: fake.fetch,
    ...overrides,
  };
}

async function drain(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of iterable) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function refusal(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof BootstrapError, `a BootstrapError, got ${error}`);
    return error.code;
  }
  return "accepted";
}

Deno.test("a download is one plain GET to the fixed origin, with no credentials and no encoding, and nothing is requested until it is read", async () => {
  const fake = network(() => file());
  const open = boundedDownload(options(fake));
  assertEquals(fake.calls.length, 0);
  assertEquals(await drain(open()), BODY);
  assertEquals(fake.calls.length, 1);
  const { url, init } = fake.calls[0]!;
  assertEquals(url, `${ORIGIN}${PATH}`);
  assertEquals(init.method, "GET");
  assertEquals(init.credentials, "omit");
  assertEquals(init.redirect, "manual");
  assertEquals(
    (init.headers as Record<string, string>)["accept-encoding"],
    "identity",
  );
  assertFalse("authorization" in (init.headers as Record<string, string>));
});

Deno.test("only an https origin and a plain absolute file path are accepted", async () => {
  const fake = network(() => file());
  for (
    const origin of [
      "http://releases.bakery.example",
      "https://user:pass@releases.bakery.example",
      "https://releases.bakery.example/releases",
      "https://releases.bakery.example/?x=1",
      "https://releases.bakery.example/#f",
      "ftp://releases.bakery.example",
      "releases.bakery.example",
      "",
    ]
  ) {
    assertEquals(
      await refusal(() => boundedDownload(options(fake, { origin }))),
      "DOWNLOAD_ORIGIN_INVALID",
      origin,
    );
  }
  // Plain http is only for a release served from this machine.
  boundedDownload(options(fake, { origin: "http://localhost:8080" }));
  boundedDownload(options(fake, { origin: "http://127.0.0.1:8080" }));
  for (
    const path of [
      "releases/x",
      "/",
      "/a/../b",
      "/a//b",
      "/a b",
      "/a?x=1",
      "/a#f",
      "/a\nb",
      "/%2e%2e/x",
      `/${"a".repeat(400)}`,
      "",
    ]
  ) {
    assertEquals(
      await refusal(() => boundedDownload(options(fake, { path }))),
      "DOWNLOAD_PATH_INVALID",
      JSON.stringify(path),
    );
  }
  for (const expectedBytes of [-1, 1.5, Number.NaN]) {
    assertEquals(
      await refusal(() => boundedDownload(options(fake, { expectedBytes }))),
      "ARTIFACT_SIZE_MISMATCH",
    );
  }
  assertEquals(fake.calls.length, 0);
});

Deno.test("redirects are followed only on the origin, only a few, and never to a login, a query or another place", async () => {
  const same = network((_, index) =>
    index < 2 ? redirect(`${PATH}.${index + 1}`) : file()
  );
  assertEquals(await drain(boundedDownload(options(same))()), BODY);
  assertEquals(same.calls.map((call) => call.url), [
    `${ORIGIN}${PATH}`,
    `${ORIGIN}${PATH}.1`,
    `${ORIGIN}${PATH}.2`,
  ]);

  // Absolute locations on the same origin are fine; every status 301 to 308 counts.
  for (const status of [301, 302, 303, 307, 308]) {
    const fake = network((_, index) =>
      index === 0 ? redirect(`${ORIGIN}/other/file`, status) : file()
    );
    assertEquals(await drain(boundedDownload(options(fake))()), BODY);
  }

  // The fourth hop is one too many.
  const loop = network(() => redirect(PATH));
  assertEquals(
    await refusal(() => drain(boundedDownload(options(loop))())),
    "DOWNLOAD_REDIRECT_REFUSED",
  );
  assertEquals(loop.calls.length, 4);
  const lower = network(() => redirect(PATH));
  assertEquals(
    await refusal(() =>
      drain(boundedDownload(options(lower, { maxRedirects: 0 }))())
    ),
    "DOWNLOAD_REDIRECT_REFUSED",
  );
  assertEquals(lower.calls.length, 1);

  for (
    const location of [
      "https://evil.example/releases/x",
      "http://releases.bakery.example/releases/x",
      "https://releases.bakery.example:8443/releases/x",
      "https://user:pass@releases.bakery.example/releases/x",
      "//evil.example/releases/x",
      "/releases/x?token=1",
      "/releases/x#frag",
      "/releases/../x",
      "/releases/a b",
      "/",
      "",
      null,
    ]
  ) {
    const fake = network(() => redirect(location));
    assertEquals(
      await refusal(() => drain(boundedDownload(options(fake))())),
      "DOWNLOAD_REDIRECT_REFUSED",
      String(location),
    );
    // Nothing was fetched from the place it pointed to.
    assertEquals(fake.calls.length, 1, String(location));
  }
});

Deno.test("anything but a whole 200 is an interrupted download, and a network error says nothing of its cause", async () => {
  for (const status of [204, 206, 400, 404, 500, 503]) {
    const fake = network(() =>
      new Response(status === 204 ? null : "x", { status })
    );
    assertEquals(
      await refusal(() => drain(boundedDownload(options(fake))())),
      "ARTIFACT_DOWNLOAD_INTERRUPTED",
      String(status),
    );
  }
  const down = network(() => {
    throw new Error("connect ECONNREFUSED 10.0.0.1 secret-detail");
  });
  try {
    await drain(boundedDownload(options(down))());
    throw new Error("expected a refusal");
  } catch (error) {
    assert(error instanceof BootstrapError);
    assertEquals(error.code, "ARTIFACT_DOWNLOAD_INTERRUPTED");
    assertFalse(error.message.includes("secret-detail"));
    assertFalse(JSON.stringify(error).includes("secret-detail"));
  }
});

Deno.test("a compressed or re-encoded file is refused before a byte of it is read", async () => {
  for (const encoding of ["gzip", "br", "deflate", "compress", "gzip, br"]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(BODY);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fake = network(() =>
      new Response(body, {
        status: 200,
        headers: { "content-encoding": encoding },
      })
    );
    assertEquals(
      await refusal(() => drain(boundedDownload(options(fake))())),
      "DOWNLOAD_ENCODING_REFUSED",
      encoding,
    );
    assert(cancelled, `the ${encoding} body was cancelled`);
  }
  // An explicit identity is just a file.
  const plain = network(() => file(BODY, { "content-encoding": "identity" }));
  assertEquals(await drain(boundedDownload(options(plain))()), BODY);
});

Deno.test("a declared length that is not the signed size is refused, and none of the file is handed on", async () => {
  for (
    const length of [
      "0",
      String(BODY.byteLength + 1),
      String(BODY.byteLength - 1),
      "abc",
      "-1",
      "1e3",
      "99999999999999999999",
    ]
  ) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(BODY);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fake = network(() =>
      new Response(body, { status: 200, headers: { "content-length": length } })
    );
    const yielded: number[] = [];
    const code = await refusal(async () => {
      for await (const chunk of boundedDownload(options(fake))()) {
        yielded.push(chunk.byteLength);
      }
    });
    assertEquals(code, "ARTIFACT_SIZE_MISMATCH", length);
    assertEquals(yielded, [], `length ${length}: nothing was handed on`);
    assert(cancelled, `length ${length}: the body was cancelled`);
  }
});

Deno.test("a length that Number() would read as the signed size, but is not plain digits, is still refused", async () => {
  const sixteen = new Uint8Array(16).fill(7);
  // "0x10" and "1.6e1" all read as 16 to Number(); only plain digits are a length.
  for (
    const length of ["0x10", "1.6e1", "+16", "0b10000", "16.0"]
  ) {
    const fake = network(() => file(sixteen, { "content-length": length }));
    assertEquals(
      await refusal(() =>
        drain(boundedDownload(options(fake, { expectedBytes: 16 }))())
      ),
      "ARTIFACT_SIZE_MISMATCH",
      length,
    );
  }
  const plain = network(() => file(sixteen, { "content-length": "16" }));
  assertEquals(
    await drain(boundedDownload(options(plain, { expectedBytes: 16 }))()),
    sixteen,
  );
});

Deno.test("a stream that runs past the signed size is cut off at that size, not buffered", async () => {
  let delivered = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fake = network(() => new Response(endless, { status: 200 }));
  const seen: number[] = [];
  const code = await refusal(async () => {
    for await (
      const chunk of boundedDownload(options(fake, { expectedBytes: 4096 }))()
    ) {
      delivered += chunk.byteLength;
      seen.push(chunk.byteLength);
    }
  });
  assertEquals(code, "ARTIFACT_SIZE_MISMATCH");
  // Everything handed on was within the signed size; nothing past it ever was.
  assert(delivered <= 4096, `delivered ${delivered}`);
  assert(cancelled, "the body was cancelled");
});

Deno.test("a stalled stream and a broken one are interrupted, and a reader that stops early cancels the body", async () => {
  const stalled = network(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise(() => undefined),
      }),
      { status: 200 },
    )
  );
  assertEquals(
    await refusal(() =>
      drain(boundedDownload(options(stalled, { idleMs: 30 }))())
    ),
    "ARTIFACT_DOWNLOAD_INTERRUPTED",
  );

  const slowFirst = network(() => {
    let sent = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(BODY.subarray(0, 4));
            return;
          }
          return new Promise(() => undefined);
        },
      }),
      { status: 200 },
    );
  });
  assertEquals(
    await refusal(() =>
      drain(boundedDownload(options(slowFirst, { idleMs: 30 }))())
    ),
    "ARTIFACT_DOWNLOAD_INTERRUPTED",
  );

  const broken = network(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("reset by peer secret-detail"));
        },
      }),
      { status: 200 },
    )
  );
  try {
    await drain(boundedDownload(options(broken))());
    throw new Error("expected a refusal");
  } catch (error) {
    assert(error instanceof BootstrapError);
    assertEquals(error.code, "ARTIFACT_DOWNLOAD_INTERRUPTED");
    assertFalse(error.message.includes("secret-detail"));
  }

  let cancelled = false;
  const long = network(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(8));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    )
  );
  for await (
    const _ of boundedDownload(options(long, { expectedBytes: 1_000_000 }))()
  ) {
    break;
  }
  assert(cancelled, "the body is released when the reader stops");
});

Deno.test("the whole download has a deadline, even when bytes keep arriving", async () => {
  const trickle = network(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.enqueue(new Uint8Array(1));
        },
      }),
      { status: 200 },
    )
  );
  assertEquals(
    await refusal(() =>
      drain(
        boundedDownload(
          options(trickle, {
            expectedBytes: 1000,
            timeoutMs: 100,
            idleMs: 5000,
          }),
        )(),
      )
    ),
    "ARTIFACT_DOWNLOAD_INTERRUPTED",
  );
});

Deno.test("the bounded download is what the installer takes as its download", () => {
  // A type-level fit: `download` of InstallOptions is exactly what this returns.
  const fake = network(() => file());
  const download: InstallOptions["download"] = boundedDownload(options(fake));
  assertEquals(typeof download, "function");
  assertEquals(fake.calls.length, 0);
});
