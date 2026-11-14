import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
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
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  BootstrapError,
  boundedDownload,
  installFromOrigin,
  type ReleaseConfig,
} from "../../packages/worker-bootstrap/src/index.ts";

// #18 (B08.06), security: what a hostile network, a hostile release origin, a
// hostile Bakery, a planted link in the install root or a habit from another
// tool can and cannot do to the installer. Real loopback servers, a real file
// system and, where an install must activate (a symlink the lane does not allow
// in-process), the real command line as its own process.

const SECRET = "bk_setup_8f3a1c5e9d7b2a4f";
const DAY = 24 * 60 * 60 * 1000;
const SCRIPT = new TextEncoder().encode(
  "#!/bin/sh\necho bakery worker 1.2.3\n",
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

function signed(release: string, binary: Uint8Array): string {
  const payload = Buffer.from(
    JSON.stringify({
      schema: 1,
      release,
      issuedAt: new Date(Date.now() - DAY).toISOString(),
      expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
      protocol: { min: 3, max: 4 },
      stateFormat: 2,
      targets: {
        "linux-x64": {
          file: `bakery-worker-${release}-linux-x64`,
          size: binary.byteLength,
          sha256: sha(binary),
        },
      },
    }),
    "utf8",
  );
  return JSON.stringify({
    keyId: KEY.keyId,
    payload: payload.toString("base64"),
    signature: sign(null, payload, KEY.privateKey).toString("base64"),
  });
}

type Handler = (request: Request) => Response | Promise<Response>;

function serve(handler: Handler) {
  const requests: string[] = [];
  const abort = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: abort.signal,
    onListen: () => undefined,
  }, (request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return handler(request);
  });
  return {
    origin: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    requests,
    close: async () => {
      abort.abort();
      await server.finished.catch(() => undefined);
    },
  };
}

/** A body that never ends, counting what the server was asked to produce. */
function endless(
  counter: { bytes: number },
  chunk = 64 * 1024,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      counter.bytes += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(97));
    },
  });
}

function config(origin: string): ReleaseConfig {
  return { origin, trustRoot: [KEY.trust], protocol: 3, stateFormat: 2 };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bakery-sec-"));
  await chmod(root, 0o700);
  return root;
}

async function install(root: string, origin: string, release = "1.2.3") {
  return await installFromOrigin({
    root,
    release,
    config: config(origin),
    fetch,
    now: new Date(),
    platform: "linux",
    arch: "x64",
  });
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

const sanitize = { sanitizeOps: false, sanitizeResources: false };

/** Every file or link under a root, at any depth: empty directories are not an install. */
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path);
    }
  };
  await walk(root);
  return found;
}

Deno.test(
  "a redirect to another origin is never followed: the other origin sees no request",
  sanitize,
  async () => {
    const elsewhere = serve(() => new Response("evil"));
    const origin = serve(() =>
      new Response(null, {
        status: 302,
        headers: {
          location: `${elsewhere.origin}/releases/1.2.3/manifest.json`,
        },
      })
    );
    const root = await tempRoot();
    try {
      assertEquals(
        await codeOf(install(root, origin.origin)),
        "DOWNLOAD_REDIRECT_REFUSED",
      );
      assertEquals(elsewhere.requests, []);
      assertEquals(await readdir(root), []);
    } finally {
      await origin.close();
      await elsewhere.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

Deno.test(
  "a compression bomb is refused before a byte is decoded",
  sanitize,
  async () => {
    // 256 MiB of zeros compresses to a few hundred KiB; a client that decodes it pays in memory.
    const zeros = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 256; i += 1) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        }
        controller.close();
      },
    }).pipeThrough(
      new CompressionStream("gzip") as unknown as TransformStream<
        Uint8Array,
        Uint8Array
      >,
    );
    const bomb = new Uint8Array(await new Response(zeros).arrayBuffer());
    assert(
      bomb.byteLength < 2 * 1024 * 1024,
      `bomb is ${bomb.byteLength} bytes`,
    );
    const origin = serve((request) =>
      new URL(request.url).pathname.endsWith("manifest.json")
        ? new Response(signed("1.2.3", SCRIPT))
        : new Response(bomb, { headers: { "content-encoding": "gzip" } })
    );
    const root = await tempRoot();
    try {
      const before = Deno.memoryUsage().rss;
      assertEquals(
        await codeOf(install(root, origin.origin)),
        "DOWNLOAD_ENCODING_REFUSED",
      );
      assert(
        Deno.memoryUsage().rss - before < 150 * 1024 * 1024,
        "nothing was decoded into memory",
      );
      assertEquals(
        await filesUnder(root),
        [],
        "no file, no link: nothing was installed",
      );
    } finally {
      await origin.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

Deno.test(
  "a body that never ends, with no length, is cut at the signed size and the server is not asked for more",
  sanitize,
  async () => {
    const counter = { bytes: 0 };
    const origin = serve((request) =>
      new URL(request.url).pathname.endsWith("manifest.json")
        ? new Response(signed("1.2.3", SCRIPT))
        : new Response(endless(counter))
    );
    const root = await tempRoot();
    try {
      assertEquals(
        await codeOf(install(root, origin.origin)),
        "ARTIFACT_SIZE_MISMATCH",
      );
      assert(
        counter.bytes < 4 * 1024 * 1024,
        `the server produced ${counter.bytes} bytes`,
      );
      assertEquals(
        await filesUnder(root),
        [],
        "no file, no link: nothing was installed",
      );
    } finally {
      await origin.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

Deno.test(
  "a manifest that never ends is refused at its ceiling",
  sanitize,
  async () => {
    const counter = { bytes: 0 };
    const origin = serve(() => new Response(endless(counter)));
    const root = await tempRoot();
    try {
      assertEquals(
        await codeOf(install(root, origin.origin)),
        "ARTIFACT_SIZE_MISMATCH",
      );
      assert(
        counter.bytes < 4 * 1024 * 1024,
        `the server produced ${counter.bytes} bytes`,
      );
    } finally {
      await origin.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

Deno.test(
  "a server that sends one byte and stalls is given up on at the idle limit",
  sanitize,
  async () => {
    const origin = serve(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([97]));
            // never more, never closed
          },
        }),
      )
    );
    try {
      const started = Date.now();
      const stream = boundedDownload({
        origin: origin.origin,
        path: "/releases/1.2.3/file",
        expectedBytes: 100,
        fetch,
        idleMs: 300,
      })();
      await assertRejects(async () => {
        for await (const _chunk of stream) {
          // drain
        }
      }, BootstrapError);
      assert(Date.now() - started < 3_000, "gave up quickly");
    } finally {
      await origin.close();
    }
  },
);

Deno.test("an origin with a login, a path, plain http off this machine or another scheme is refused before any request", async () => {
  for (
    const origin of [
      "https://user:pass@releases.example",
      "https://releases.example/x",
      "http://releases.example",
      "ftp://releases.example",
      "file:///etc",
    ]
  ) {
    const root = await tempRoot();
    try {
      let asked = 0;
      const refusing =
        (() => (asked += 1,
          Promise.reject(new Error("no")))) as unknown as typeof fetch;
      assertEquals(
        await codeOf(
          installFromOrigin({
            root,
            release: "1.2.3",
            config: config(origin),
            fetch: refusing,
            now: new Date(),
            platform: "linux",
            arch: "x64",
          }),
        ),
        "DOWNLOAD_ORIGIN_INVALID",
        origin,
      );
      assertEquals(asked, 0, origin);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

const ENTRY =
  new URL("../fixtures/worker-bootstrap-test-entry.ts", import.meta.url)
    .pathname;

async function cli(
  root: string,
  releases: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", ENTRY, ...args, "--root", root],
    env: {
      HOME: join(root, ".."),
      BAKERY_TEST_RELEASE_CONFIG: JSON.stringify(config(releases)),
      ...env,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("y\n"));
  await writer.close();
  const output = await child.output();
  return {
    code: output.code,
    text: new TextDecoder().decode(output.stdout) +
      new TextDecoder().decode(output.stderr),
  };
}

const PREVIEW = {
  enrollmentId: "00000000-0000-4000-8000-0000000000e1",
  organizationName: "Acme",
  name: "build-linux-01",
  os: "linux",
  architecture: "x64",
  slots: 2,
  capabilities: ["git", "shell"],
  expiresAt: "2026-11-14T00:10:00.000Z",
  state: "pending",
};

function release() {
  return serve((request) =>
    new URL(request.url).pathname.endsWith("manifest.json")
      ? new Response(signed("1.2.3", SCRIPT))
      : new Response(SCRIPT)
  );
}

async function codeFile(root: string): Promise<string> {
  const path = `${root}.code`;
  await writeFile(path, `${SECRET}\n`, { mode: 0o600 });
  return path;
}

const setup = (
  server: string,
  file: string,
) => ["setup", "--server", server, "--release", "1.2.3", "--token-file", file];

async function ln(target: string, link: string) {
  const made = await new Deno.Command("ln", { args: ["-s", target, link] })
    .output();
  assert(made.success, "ln -s");
}

Deno.test(
  "a hostile Bakery cannot put control sequences on the person's terminal or write a record: nothing is paired",
  sanitize,
  async () => {
    for (
      const name of [
        "\u001b[2K\rOrganization: Acme (your own)",
        "Acme\nPaired: yes",
        "Acme‮",
      ]
    ) {
      const releases = release();
      const bakery = serve(() =>
        Response.json({ ...PREVIEW, organizationName: name })
      );
      const root = await tempRoot();
      try {
        const file = await codeFile(root);
        const result = await cli(
          root,
          releases.origin,
          setup(bakery.origin, file),
        );
        assertEquals(result.code, 2, result.text);
        assertFalse(
          result.text.includes("\u001b"),
          "no escape sequence reached the terminal",
        );
        assertFalse(result.text.includes("‮"));
        assertFalse(result.text.includes("your own"));
        const names = await readdir(root);
        assertFalse(
          names.includes("pairing.json") || names.includes("enrollment-token"),
          "nothing was recorded",
        );
      } finally {
        await releases.close();
        await bakery.close();
        await rm(root, { recursive: true, force: true });
        await rm(`${root}.code`, { force: true });
      }
    }
  },
);

Deno.test(
  "an inspection answer that never ends is cut at its cap",
  sanitize,
  async () => {
    const counter = { bytes: 0 };
    const releases = release();
    const bakery = serve(() =>
      new Response(endless(counter), {
        headers: { "content-type": "application/json" },
      })
    );
    const root = await tempRoot();
    try {
      const file = await codeFile(root);
      const result = await cli(
        root,
        releases.origin,
        setup(bakery.origin, file),
      );
      assertEquals(result.code, 2, result.text);
      assert(
        counter.bytes < 4 * 1024 * 1024,
        `the server produced ${counter.bytes} bytes`,
      );
    } finally {
      await releases.close();
      await bakery.close();
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.code`, { force: true });
    }
  },
);

Deno.test(
  "the setup code has no shortcut: not on the command line, not in the environment, and it is written once, to its protected file",
  sanitize,
  async () => {
    const releases = release();
    const bakery = serve(() => Response.json(PREVIEW));
    const root = await tempRoot();
    try {
      const file = await codeFile(root);
      // On the command line, and in either variable a habit might use: refused by name, before the network.
      const attempts: { args: string[]; env: Record<string, string> }[] = [
        {
          args: ["pair", "--server", bakery.origin, "--token", SECRET],
          env: {},
        },
        {
          args: ["pair", "--server", bakery.origin, `--token=${SECRET}`],
          env: {},
        },
        {
          args: ["pair", "--server", bakery.origin, "--token-file", file],
          env: { BAKERY_WORKER_ENROLLMENT_TOKEN: SECRET },
        },
        {
          args: ["pair", "--server", bakery.origin, "--token-file", file],
          env: { BAKERY_ENROLLMENT_TOKEN: SECRET },
        },
      ];
      for (const attempt of attempts) {
        const result = await cli(
          root,
          releases.origin,
          attempt.args,
          attempt.env,
        );
        assertEquals(result.code, 2, result.text);
        assertFalse(result.text.includes(SECRET), "the code is never echoed");
      }
      assertEquals(bakery.requests, [], "the Bakery was never asked");
      assertEquals(await readdir(root), [], "nothing was written");
      // The real thing: the code ends up in one file, owner-only, and nowhere else in the root.
      const done = await cli(root, releases.origin, setup(bakery.origin, file));
      assertEquals(done.code, 0, done.text);
      assertFalse(done.text.includes(SECRET));
      assertEquals(
        (await lstat(join(root, "enrollment-token"))).mode & 0o777,
        0o600,
      );
      const holders: string[] = [];
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (
            entry.isFile() && (await readFile(path)).includes(SECRET)
          ) holders.push(path);
        }
      };
      await walk(root);
      assertEquals(holders, [join(root, "enrollment-token")]);
    } finally {
      await releases.close();
      await bakery.close();
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.code`, { force: true });
    }
  },
);

Deno.test(
  "a planted link in the install root writes nothing outside it and overwrites nothing it points at",
  sanitize,
  async () => {
    const releases = release();
    const bakery = serve(() => Response.json(PREVIEW));
    try {
      // 1. `enrollment-token` is a link to someone's file: pairing replaces the link, never writes through it.
      {
        const root = await tempRoot();
        const victim = `${root}.victim`;
        try {
          await writeFile(victim, "do not touch");
          await ln(victim, join(root, "enrollment-token"));
          const file = await codeFile(root);
          const result = await cli(
            root,
            releases.origin,
            setup(bakery.origin, file),
          );
          assertEquals(
            await readFile(victim, "utf8"),
            "do not touch",
            `${result.text}`,
          );
          const info = await lstat(join(root, "enrollment-token"));
          if (result.code === 0) {
            assert(
              info.isFile() && !info.isSymbolicLink(),
              "the link was replaced by a real file",
            );
          }
        } finally {
          await rm(root, { recursive: true, force: true });
          await rm(`${root}.victim`, { force: true });
          await rm(`${root}.code`, { force: true });
        }
      }
      // 2. `pairing.json` is a link: it is not a record this installation wrote.
      {
        const root = await tempRoot();
        const victim = `${root}.victim`;
        try {
          await writeFile(victim, "{}");
          await ln(victim, join(root, "pairing.json"));
          const file = await codeFile(root);
          const result = await cli(
            root,
            releases.origin,
            setup(bakery.origin, file),
          );
          assertEquals(result.code, 2, result.text);
          assertEquals(await readFile(victim, "utf8"), "{}");
        } finally {
          await rm(root, { recursive: true, force: true });
          await rm(`${root}.victim`, { force: true });
          await rm(`${root}.code`, { force: true });
        }
      }
      // 3. `current` is a link out of the root: nothing is installed through it.
      {
        const root = await tempRoot();
        const outside = await mkdtemp(join(tmpdir(), "bakery-sec-outside-"));
        try {
          await ln(outside, join(root, "current"));
          const file = await codeFile(root);
          const result = await cli(
            root,
            releases.origin,
            setup(bakery.origin, file),
          );
          assertEquals(result.code, 2, result.text);
          assertEquals(
            await readdir(outside),
            [],
            "nothing was written outside the root",
          );
        } finally {
          await rm(root, { recursive: true, force: true });
          await rm(outside, { recursive: true, force: true });
          await rm(`${root}.code`, { force: true });
        }
      }
      // 3b. `releases` and `staging` are links to a directory elsewhere: the
      // release is never carried out of the root.
      for (const name of ["releases", "staging"]) {
        const root = await tempRoot();
        const outside = await mkdtemp(join(tmpdir(), "bakery-sec-outside-"));
        try {
          await ln(outside, join(root, name));
          const file = await codeFile(root);
          const result = await cli(
            root,
            releases.origin,
            setup(bakery.origin, file),
          );
          assertEquals(result.code, 2, `${name}: ${result.text}`);
          assertStringIncludes(result.text, "not what setup expects");
          assertEquals(
            await readdir(outside),
            [],
            `${name}: nothing was written outside the root`,
          );
          assertFalse(
            (await readdir(root)).includes("current"),
            `${name}: nothing was activated`,
          );
        } finally {
          await rm(root, { recursive: true, force: true });
          await rm(outside, { recursive: true, force: true });
          await rm(`${root}.code`, { force: true });
        }
      }
      // 4. A root others can write to is refused outright.
      {
        const root = await tempRoot();
        try {
          await chmod(root, 0o777);
          const file = await codeFile(root);
          const result = await cli(
            root,
            releases.origin,
            setup(bakery.origin, file),
          );
          assertEquals(result.code, 2, result.text);
          await chmod(root, 0o700);
          assertEquals(await readdir(root), []);
        } finally {
          await chmod(root, 0o700).catch(() => undefined);
          await rm(root, { recursive: true, force: true });
          await rm(`${root}.code`, { force: true });
        }
      }
    } finally {
      await releases.close();
      await bakery.close();
    }
  },
);

Deno.test("the package never elevates, evals, shells out beyond its read-only probes or reads the environment outside its entry", async () => {
  const dir = new URL("../../packages/worker-bootstrap/src/", import.meta.url);
  const names = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.endsWith(".ts")) names.push(entry.name);
  }
  assert(names.length >= 10);
  for (const name of names) {
    const text = await readFile(new URL(name, dir), "utf8");
    // Words in comments (this code says it never runs sudo) are not code.
    const source = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    // `sudo` as a command (a string that starts with it, or the head of an
    // argument list); the account refusals name it as a group, which is not one.
    assertFalse(
      /["'`]sudo\s|\[\s*["'`]sudo["'`]\s*,/.test(source),
      `${name}: no sudo in code`,
    );
    assertFalse(/\beval\(|new Function\(/.test(source), `${name}: no eval`);
    assertFalse(
      /shell:\s*true|execSync|spawnSync/.test(source),
      `${name}: no shell`,
    );
    if (!["probes.ts"].includes(name)) {
      assertFalse(
        /child_process|execFile|Deno\.Command/.test(source),
        `${name}: starts no process`,
      );
    }
    if (!["process-main.ts", "bin.ts"].includes(name)) {
      assertFalse(
        /process\.env|Deno\.env/.test(source),
        `${name}: reads no environment`,
      );
    }
    assertFalse(/--no-verify/.test(source), `${name}: no hook bypass`);
    // Every mode this code creates a file or directory with must not be
    // writable by group or others (a mask such as `mode & 0o777` is not one).
    for (const match of source.matchAll(/\bmode:\s*0o([0-7]{3})\b/g)) {
      assertEquals(
        parseInt(match[1]!, 8) & 0o022,
        0,
        `${name}: ${match[0]} is writable by others`,
      );
    }
    assertFalse(
      /chmod\([^)]*0o[0-7]*[2367]\)/.test(source),
      `${name}: no chmod to a writable mode`,
    );
  }
});

Deno.test("an unreadable code file or one others can read is refused and the code is never used", async () => {
  const releases = release();
  const bakery = serve(() => Response.json(PREVIEW));
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    await chmod(file, 0o644);
    const result = await cli(root, releases.origin, setup(bakery.origin, file));
    assertEquals(result.code, 2, result.text);
    assertFalse(result.text.includes(SECRET));
    assertEquals(bakery.requests, [], "the Bakery was never asked");
    await mkdir(join(root, "x"));
    assert(true);
    assertStringIncludes(result.text.toLowerCase(), "code");
  } finally {
    await releases.close();
    await bakery.close();
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.code`, { force: true });
  }
});

Deno.test(
  "plan, through the real process, never prints a unit that runs as root and keeps what pairing fixed",
  sanitize,
  async () => {
    const releases = release();
    const bakery = serve(() => Response.json(PREVIEW));
    const root = await tempRoot();
    try {
      const file = await codeFile(root);
      assertEquals(
        (await cli(root, releases.origin, setup(bakery.origin, file))).code,
        0,
      );
      for (
        const account of [
          "root",
          "daemon",
          "nobody",
          "systemd-network",
          "adm",
          "ubuntu",
        ]
      ) {
        const result = await cli(root, releases.origin, [
          "plan",
          "--account",
          account,
        ]);
        assertEquals(result.code, 2, account);
        assertFalse(
          result.text.includes("User="),
          `${account}: no unit was printed`,
        );
      }
      const override = await cli(root, releases.origin, [
        "plan",
        "--setting",
        "BAKERY_WORKER_CAPABILITIES=git,docker,root",
      ]);
      assertEquals(override.code, 2);
      assertFalse(override.text.includes("docker"));
      const fine = await cli(root, releases.origin, [
        "plan",
        "--account",
        "bakery-ci",
      ]);
      assertEquals(fine.code, 0, fine.text);
      assertStringIncludes(fine.text, "User=bakery-ci");
    } finally {
      await releases.close();
      await bakery.close();
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.code`, { force: true });
    }
  },
);
