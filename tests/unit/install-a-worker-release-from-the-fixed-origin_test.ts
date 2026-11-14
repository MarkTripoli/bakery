import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  BootstrapError,
  installFromOrigin,
  isExactRelease,
  type ReleaseConfig,
} from "../../packages/worker-bootstrap/src/index.ts";

// #18, last slice (AC1): installing from the fixed release origin. A bad
// network, a bad signature, an unsupported target or a refused permission must
// never cost the machine what it already runs. The network is a fake `fetch`.

const ORIGIN = "https://releases.bakery.example";
const NOW = new Date("2026-11-11T00:00:00.000Z");
const BINARY = new TextEncoder().encode(
  "#!/bin/sh\necho bakery worker 1.2.3\n",
);
const BINARY_2 = new TextEncoder().encode(
  "#!/bin/sh\necho bakery worker 2.0.0\n",
);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function testKey(keyId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" }))
    .subarray(-32);
  return {
    keyId,
    privateKey,
    trust: { keyId, publicKey: raw.toString("base64") },
  };
}
const KEY = testKey("release-2026-a");
const OTHER_KEY = testKey("release-2026-b");

const CONFIG: ReleaseConfig = {
  origin: ORIGIN,
  trustRoot: [KEY.trust],
  protocol: 3,
  stateFormat: 2,
};

function manifestFor(
  release: string,
  binary: Uint8Array,
  over: Record<string, unknown> = {},
) {
  return {
    schema: 1,
    release,
    issuedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    protocol: { min: 3, max: 4 },
    stateFormat: 2,
    targets: {
      "linux-x64": {
        file: `bakery-worker-${release}-linux-x64`,
        size: binary.byteLength,
        sha256: sha(binary),
      },
    },
    ...over,
  };
}

function envelope(manifest: unknown, key = KEY): string {
  const payload = Buffer.from(JSON.stringify(manifest), "utf8");
  return JSON.stringify({
    keyId: key.keyId,
    payload: payload.toString("base64"),
    signature: sign(null, payload, key.privateKey).toString("base64"),
  });
}

type Answer =
  | Response
  | Error
  | ((url: string) => Response | Promise<Response>);

/** A release origin: each path answers with a response, or throws, or is a 404. */
function origin(routes: Record<string, Answer>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fakeFetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const answer = routes[path];
    if (answer === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === "function") return Promise.resolve(answer(url));
    return Promise.resolve(answer.clone());
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

function release(
  release: string,
  binary: Uint8Array<ArrayBuffer>,
  over: Record<string, unknown> = {},
  key = KEY,
) {
  return {
    [`/releases/${release}/manifest.json`]: new Response(
      envelope(manifestFor(release, binary, over), key),
    ),
    [`/releases/${release}/bakery-worker-${release}-linux-x64`]: new Response(
      binary,
    ),
  } as Record<string, Answer>;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bakery-origin-"));
  await chmod(root, 0o700);
  return root;
}

async function treeOf(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {out.push(
          `${path}:${(await lstat(path)).size}:${
            entry.isSymbolicLink() ? await readlink(path) : ""
          }`,
        );}
    }
  };
  await walk(root);
  return out.sort();
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BootstrapError) return error.code;
    throw error;
  }
  return "no error";
}

const run = (
  root: string,
  fake: { fetch: typeof fetch },
  over: Partial<Parameters<typeof installFromOrigin>[0]> = {},
) =>
  installFromOrigin({
    root,
    release: "1.2.3",
    config: CONFIG,
    fetch: fake.fetch,
    now: NOW,
    platform: "linux",
    arch: "x64",
    ...over,
  });

Deno.test("the manifest and the file are fetched from the fixed origin at their fixed paths, with no credentials and no encoding", async () => {
  const root = await tempRoot();
  try {
    const fake = origin(release("1.2.3", BINARY));
    const result = await run(root, fake);
    assertEquals(result.status, "installed");
    assertEquals(result.release, "1.2.3");
    assertEquals(result.target, "linux-x64");
    assertEquals(
      fake.calls.map((call) => call.url),
      [
        `${ORIGIN}/releases/1.2.3/manifest.json`,
        `${ORIGIN}/releases/1.2.3/bakery-worker-1.2.3-linux-x64`,
      ],
    );
    for (const call of fake.calls) {
      assertEquals(call.init?.credentials, "omit");
      assertEquals(call.init?.redirect, "manual");
      assertEquals(
        (call.init?.headers as Record<string, string>)["accept-encoding"],
        "identity",
      );
    }
    assertEquals(await readFile(result.binaryPath), Buffer.from(BINARY));
    assertEquals(
      await readlink(join(root, "current")),
      join("releases", "1.2.3-linux-x64"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("only an exact release is asked for, and nothing is requested for anything else or for a target not supported", async () => {
  const root = await tempRoot();
  try {
    for (
      const bad of [
        "latest",
        "^1.2.3",
        "1.2",
        "1.2.3.4",
        "../1.2.3",
        "1.2.3/..",
        " 1.2.3",
        "1.2.3\n",
        "",
      ]
    ) {
      const fake = origin(release("1.2.3", BINARY));
      assertEquals(
        await codeOf(run(root, fake, { release: bad })),
        "RELEASE_NOT_EXACT",
        JSON.stringify(bad),
      );
      assertEquals(fake.calls.length, 0, JSON.stringify(bad));
    }
    for (
      const [platform, arch] of [
        ["darwin", "arm64"],
        ["darwin", "x64"],
        ["linux", "arm64"],
        ["win32", "x64"],
        ["linux", "x86"],
      ]
    ) {
      const fake = origin(release("1.2.3", BINARY));
      assertEquals(
        await codeOf(run(root, fake, { platform, arch })),
        "MANIFEST_TARGET_UNSUPPORTED",
        `${platform}-${arch}`,
      );
      assertEquals(fake.calls.length, 0);
    }
    assertEquals(await readdir(root), []);
    assert(isExactRelease("1.2.3") && isExactRelease("10.20.30-rc.1"));
    assertFalse(isExactRelease("v1.2.3"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a manifest that is badly signed, signed by a stranger, expired, for another protocol or another release installs nothing", async () => {
  const cases: [string, Record<string, Answer>, string][] = [
    [
      "a stranger's key",
      release("1.2.3", BINARY, {}, OTHER_KEY),
      "MANIFEST_KEY_UNKNOWN",
    ],
    [
      "a signature that does not match",
      {
        "/releases/1.2.3/manifest.json": new Response(
          envelope(manifestFor("1.2.3", BINARY)).replace(
            /"signature":"[^"]{6}/,
            '"signature":"AAAAAA',
          ),
        ),
      },
      "MANIFEST_SIGNATURE_INVALID",
    ],
    [
      "expired",
      release("1.2.3", BINARY, { expiresAt: "2026-11-05T00:00:00.000Z" }),
      "MANIFEST_EXPIRED",
    ],
    [
      "another protocol",
      release("1.2.3", BINARY, { protocol: { min: 9, max: 9 } }),
      "MANIFEST_PROTOCOL_INCOMPATIBLE",
    ],
    [
      "another release's manifest",
      release("1.2.3", BINARY, { release: "9.9.9" }),
      "MANIFEST_RELEASE_MISMATCH",
    ],
    ["no manifest at all", {}, "ARTIFACT_DOWNLOAD_INTERRUPTED"],
    ["not JSON", {
      "/releases/1.2.3/manifest.json": new Response("<html>nope</html>"),
    }, "MANIFEST_MALFORMED"],
    ["not UTF-8", {
      "/releases/1.2.3/manifest.json": new Response(
        new Uint8Array([0xff, 0xfe, 0x00]),
      ),
    }, "MANIFEST_MALFORMED"],
  ];
  for (const [label, routes, expected] of cases) {
    const root = await tempRoot();
    try {
      const fake = origin(routes);
      assertEquals(await codeOf(run(root, fake)), expected, label);
      // Only the manifest was asked for; the file was never fetched; nothing was written.
      assertEquals(fake.calls.length, 1, label);
      assertEquals(await readdir(root), [], label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

Deno.test("a manifest over the size ceiling, or sent compressed or somewhere else, is refused unread", async () => {
  const cases: [string, Answer, string][] = [
    [
      "declared too long",
      new Response("x", { headers: { "content-length": String(200 * 1024) } }),
      "ARTIFACT_SIZE_MISMATCH",
    ],
    [
      "longer than declared allows",
      new Response(new Uint8Array(200 * 1024)),
      "ARTIFACT_SIZE_MISMATCH",
    ],
    [
      "compressed",
      new Response("x", { headers: { "content-encoding": "gzip" } }),
      "DOWNLOAD_ENCODING_REFUSED",
    ],
    [
      "redirected off the origin",
      new Response(null, {
        status: 302,
        headers: {
          location: "https://evil.example/releases/1.2.3/manifest.json",
        },
      }),
      "DOWNLOAD_REDIRECT_REFUSED",
    ],
    [
      "an error page",
      new Response("oops", { status: 500 }),
      "ARTIFACT_DOWNLOAD_INTERRUPTED",
    ],
    [
      "the network is down",
      new Error("ECONNREFUSED"),
      "ARTIFACT_DOWNLOAD_INTERRUPTED",
    ],
  ];
  for (const [label, answer, expected] of cases) {
    const root = await tempRoot();
    try {
      const fake = origin({ "/releases/1.2.3/manifest.json": answer });
      assertEquals(await codeOf(run(root, fake)), expected, label);
      assertEquals(fake.calls.length, 1, label);
      assertEquals(await readdir(root), [], label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  // A manifest right at the ceiling's edge is still read: it fails later, as a manifest.
  const root = await tempRoot();
  try {
    const fake = origin({
      "/releases/1.2.3/manifest.json": new Response(
        new Uint8Array(128 * 1024).fill(32),
      ),
    });
    assertEquals(await codeOf(run(root, fake)), "MANIFEST_MALFORMED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a download that fails after a good manifest leaves a prior working install exactly as it was", async () => {
  const root = await tempRoot();
  try {
    await run(root, origin(release("1.2.3", BINARY)));
    const before = await treeOf(root);
    const binaryPath = `/releases/2.0.0/bakery-worker-2.0.0-linux-x64`;
    const base = release("2.0.0", BINARY_2);
    const truncated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BINARY_2.subarray(0, 10));
        controller.error(new Error("connection reset"));
      },
    });
    const cases: [string, Answer, string][] = [
      [
        "interrupted mid-file",
        new Response(truncated),
        "ARTIFACT_DOWNLOAD_INTERRUPTED",
      ],
      [
        "too short",
        new Response(BINARY_2.subarray(0, 10)),
        "ARTIFACT_SIZE_MISMATCH",
      ],
      [
        "too long",
        new Response(new Uint8Array(BINARY_2.byteLength + 50)),
        "ARTIFACT_SIZE_MISMATCH",
      ],
      [
        "the right size, the wrong bytes",
        new Response(new Uint8Array(BINARY_2.byteLength).fill(65)),
        "ARTIFACT_DIGEST_MISMATCH",
      ],
      [
        "compressed",
        new Response(BINARY_2, { headers: { "content-encoding": "gzip" } }),
        "DOWNLOAD_ENCODING_REFUSED",
      ],
      [
        "gone",
        new Response("no", { status: 404 }),
        "ARTIFACT_DOWNLOAD_INTERRUPTED",
      ],
      [
        "origin unreachable",
        new Error("ENETUNREACH"),
        "ARTIFACT_DOWNLOAD_INTERRUPTED",
      ],
    ];
    for (const [label, answer, expected] of cases) {
      const fake = origin({ ...base, [binaryPath]: answer });
      assertEquals(
        await codeOf(run(root, fake, { release: "2.0.0", upgrade: true })),
        expected,
        label,
      );
      assertEquals(
        await treeOf(root),
        before,
        `${label}: the root is as it was`,
      );
      assertEquals(
        await readlink(join(root, "current")),
        join("releases", "1.2.3-linux-x64"),
        label,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a rerun installs nothing new, and a different release needs explicit consent", async () => {
  const root = await tempRoot();
  try {
    const first = await run(root, origin(release("1.2.3", BINARY)));
    assertEquals(first.status, "installed");
    const again = await run(root, origin(release("1.2.3", BINARY)));
    assertEquals(again.status, "already-installed");
    // Without consent a different release is refused; the first stays.
    const both = { ...release("1.2.3", BINARY), ...release("2.0.0", BINARY_2) };
    const refused = await codeOf(run(root, origin(both), { release: "2.0.0" }));
    assert(
      refused !== "no error",
      "a different release without consent is refused",
    );
    assertEquals(
      await readlink(join(root, "current")),
      join("releases", "1.2.3-linux-x64"),
    );
    // With consent it is replaced, atomically.
    const upgraded = await run(root, origin(both), {
      release: "2.0.0",
      upgrade: true,
    });
    assertEquals(upgraded.status, "installed");
    assertEquals(
      await readlink(join(root, "current")),
      join("releases", "2.0.0-linux-x64"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a refused permission leaves nothing behind: a root others can write to, a parent that cannot be written, or a root that is not absolute", async () => {
  const parent = await tempRoot();
  try {
    const root = join(parent, "worker");
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o777);
    assertEquals(
      await codeOf(run(root, origin(release("1.2.3", BINARY)))),
      "INSTALL_ROOT_INVALID",
    );
    await chmod(root, 0o700);
    assertEquals(await readdir(root), []);
    // A parent that cannot be written to refuses the new root, and nothing is made.
    await chmod(parent, 0o500);
    assertEquals(
      await codeOf(
        run(join(parent, "new-root"), origin(release("1.2.3", BINARY))),
      ),
      "INSTALL_PERMISSION_DENIED",
    );
    await chmod(parent, 0o700);
    assertEquals(await readdir(parent), ["worker"]);
    assertEquals(
      await codeOf(
        run("relative/root", origin(release("1.2.3", BINARY))),
      ),
      "INSTALL_ROOT_INVALID",
    );
  } finally {
    await chmod(parent, 0o700).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

Deno.test("the origin must be a fixed https origin: a path, a login or a plain http address is refused before any request", async () => {
  for (
    const origin of [
      "http://releases.bakery.example",
      "https://user:pass@releases.bakery.example",
      "https://releases.bakery.example/extra",
      "https://releases.bakery.example/?x=1",
      "ftp://releases.bakery.example",
      "not a url",
    ]
  ) {
    const root = await tempRoot();
    try {
      const fake = (() => {
        const calls: string[] = [];
        return {
          calls,
          fetch: ((
            url: string,
          ) => (calls.push(url),
            Promise.reject(new Error("no")))) as unknown as typeof fetch,
        };
      })();
      assertEquals(
        await codeOf(run(root, fake, { config: { ...CONFIG, origin } })),
        "DOWNLOAD_ORIGIN_INVALID",
        origin,
      );
      assertEquals(fake.calls, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  // A local test release may use loopback http.
  const root = await tempRoot();
  try {
    const fake = origin(release("1.2.3", BINARY));
    const local = await run(root, fake, {
      config: { ...CONFIG, origin: "http://127.0.0.1:8080" },
    });
    assertEquals(local.status, "installed");
    assertStringIncludes(
      fake.calls[0]!.url,
      "http://127.0.0.1:8080/releases/1.2.3/manifest.json",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
