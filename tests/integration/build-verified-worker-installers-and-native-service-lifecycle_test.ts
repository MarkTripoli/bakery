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
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  type BootstrapIo,
  type ReleaseConfig,
  runBootstrap,
  spawnProgram,
  systemProbes,
} from "../../packages/worker-bootstrap/src/index.ts";

// #18 (B08.06), local fixtures (G2): the verified installer end to end against
// real loopback HTTP servers, a real file system and the real command-line
// entry. A release origin serves signed manifests and files; a fake Bakery
// serves the enrollment inspection. What a real Linux runner proves for
// service stop/restart/sleep (AC3, G3) is owned by B15.06, not here.

const SECRET = "bk_setup_8f3a1c5e9d7b2a4f";
const NOW = new Date("2026-11-11T00:00:00.000Z");
const SCRIPT_1 = new TextEncoder().encode(
  "#!/bin/sh\necho bakery worker 1.2.3\n",
);
const SCRIPT_2 = new TextEncoder().encode(
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
const STRANGER = testKey("release-2026-z");

function signed(
  release: string,
  binary: Uint8Array,
  key = KEY,
  over: Record<string, unknown> = {},
): string {
  const payload = Buffer.from(
    JSON.stringify({
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
    }),
    "utf8",
  );
  return JSON.stringify({
    keyId: key.keyId,
    payload: payload.toString("base64"),
    signature: sign(null, payload, key.privateKey).toString("base64"),
  });
}

type Handler = (request: Request) => Response | Promise<Response>;

function serve(handler: Handler) {
  const requests: string[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => undefined,
  }, (request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return handler(request);
  });
  return {
    origin: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    requests,
    close: () => server.shutdown(),
  };
}

/** A release origin that serves releases 1.2.3 and 2.0.0 (bad ones are made by overriding). */
function releaseOrigin(over: Record<string, Handler> = {}) {
  const routes: Record<string, Handler> = {
    "/releases/1.2.3/manifest.json": () =>
      new Response(signed("1.2.3", SCRIPT_1)),
    "/releases/1.2.3/bakery-worker-1.2.3-linux-x64": () =>
      new Response(SCRIPT_1),
    "/releases/2.0.0/manifest.json": () =>
      new Response(signed("2.0.0", SCRIPT_2)),
    "/releases/2.0.0/bakery-worker-2.0.0-linux-x64": () =>
      new Response(SCRIPT_2),
    ...over,
  };
  return serve((request) => {
    const route = routes[new URL(request.url).pathname];
    return route ? route(request) : new Response("not found", { status: 404 });
  });
}

const PREVIEW = {
  enrollmentId: "00000000-0000-4000-8000-0000000000e1",
  organizationName: "Acme",
  name: "build-linux-01",
  os: "linux",
  architecture: "x64",
  slots: 2,
  capabilities: ["git", "shell", "claude"],
  expiresAt: "2026-11-14T00:10:00.000Z",
  state: "pending",
};

/** A fake Bakery: it only inspects. Anything else asked of it is a request to create a host. */
function bakery(preview: unknown = PREVIEW) {
  return serve((request) => {
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === "/v1/worker/enrollment-inspection"
    ) {
      return Response.json(preview);
    }
    return new Response("unexpected", { status: 500 });
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bakery-install-it-"));
  await chmod(root, 0o700);
  return root;
}

async function codeFile(root: string): Promise<string> {
  const path = `${root}.code`;
  await writeFile(path, `${SECRET}\n`, { mode: 0o600 });
  return path;
}

async function treeOf(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const info = await lstat(path);
        out.push(
          `${path}:${info.size}:${info.mode}:${
            entry.isSymbolicLink() ? await readlink(path) : ""
          }`,
        );
      }
    }
  };
  await walk(root);
  return out.sort();
}

function bootstrapIo(root: string, releases: string, answer = "y") {
  const out: string[] = [];
  const config: ReleaseConfig = {
    origin: releases,
    trustRoot: [KEY.trust],
    protocol: 3,
    stateFormat: 2,
  };
  const noop = () => undefined;
  const io: BootstrapIo = {
    defaultRoot: root,
    environment: {},
    command: {
      stdin: {
        resume: noop,
        pause: noop,
        setEncoding: noop,
        on: noop,
        off: noop,
      },
      ask: () => Promise.resolve(answer),
      write: (text) => void out.push(text),
      fetch,
      now: () => NOW,
      release: { config, platform: "linux", arch: "x64" },
    },
    operation: {
      write: (text) => void out.push(text),
      target: "linux",
      home: "/home/alice",
      probes: systemProbes("linux"),
    },
  };
  return { io, text: () => out.join("") };
}

const setup = (
  bakeryOrigin: string,
  file: string,
  release = "1.2.3",
  extra: string[] = [],
) => [
  "setup",
  "--server",
  bakeryOrigin,
  "--release",
  release,
  "--token-file",
  file,
  ...extra,
];

Deno.test("a fresh host installs the signed release over HTTP, runs it, and pairs, with the code only in its protected file", async () => {
  const root = await tempRoot();
  const releases = releaseOrigin();
  const server = bakery();
  try {
    const file = await codeFile(root);
    const h = bootstrapIo(root, releases.origin);
    assertEquals(
      await runBootstrap(setup(server.origin, file), h.io),
      0,
      h.text(),
    );
    assertEquals(releases.requests, [
      "GET /releases/1.2.3/manifest.json",
      "GET /releases/1.2.3/bakery-worker-1.2.3-linux-x64",
    ]);
    assertEquals(server.requests, ["POST /v1/worker/enrollment-inspection"]);
    // What was installed is exactly the signed file, and it runs.
    const binary = join(root, "current", "bakery-worker");
    assertEquals(await readFile(binary), Buffer.from(SCRIPT_1));
    const run = await spawnProgram([binary]);
    assertEquals(run.code, 0);
    assertEquals(run.stdout.trim(), "bakery worker 1.2.3");
    assertEquals(
      (await lstat(join(root, "enrollment-token"))).mode & 0o777,
      0o600,
    );
    assertEquals(
      await readFile(join(root, "enrollment-token"), "utf8"),
      `${SECRET}\n`,
    );
    assertFalse(h.text().includes(SECRET));
  } finally {
    await releases.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.code`, { force: true });
  }
});

Deno.test(
  "AC1: an interrupted download, a bad signature, an unsupported target or a refused permission leaves the prior working install intact",
  {
    // A connection destroyed mid-body leaves the socket's close to the runtime.
    sanitizeOps: false,
    sanitizeResources: false,
  },
  async () => {
    const root = await tempRoot();
    const good = releaseOrigin();
    const server = bakery();
    try {
      const file = await codeFile(root);
      assertEquals(
        await runBootstrap(
          setup(server.origin, file),
          bootstrapIo(root, good.origin).io,
        ),
        0,
      );
      const before = await treeOf(root);

      const broken: [string, Record<string, Handler>, string][] = [
        ["a connection cut mid-file", {
          "/releases/2.0.0/bakery-worker-2.0.0-linux-x64": () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(SCRIPT_2.subarray(0, 8));
                  controller.error(new Error("connection reset"));
                },
              }),
              { headers: { "content-length": String(SCRIPT_2.byteLength) } },
            ),
        }, "download was interrupted"],
        ["a stranger's signature", {
          "/releases/2.0.0/manifest.json": () =>
            new Response(signed("2.0.0", SCRIPT_2, STRANGER)),
        }, "key this bootstrap does not trust"],
        ["a file that is not the signed one", {
          "/releases/2.0.0/bakery-worker-2.0.0-linux-x64": () =>
            new Response(new Uint8Array(SCRIPT_2.byteLength).fill(65)),
        }, "does not match the signed digest"],
        ["a manifest with no build for this machine", {
          "/releases/2.0.0/manifest.json": () =>
            new Response(
              signed("2.0.0", SCRIPT_2, KEY, {
                targets: {
                  "darwin-arm64": {
                    file: "x",
                    size: 1,
                    sha256: "0".repeat(64),
                  },
                },
              }),
            ),
        }, "no build for this operating system"],
      ];
      for (const [label, over, fragment] of broken) {
        const origin = releaseOrigin(over);
        try {
          const h = bootstrapIo(root, origin.origin);
          assertEquals(
            await runBootstrap(
              setup(server.origin, file, "2.0.0", ["--upgrade"]),
              h.io,
            ),
            2,
            label,
          );
          assertStringIncludes(h.text(), fragment, label);
        } finally {
          await origin.close();
        }
        assertEquals(
          await treeOf(root),
          before,
          `${label}: the root is as it was`,
        );
        const run = await spawnProgram([
          join(root, "current", "bakery-worker"),
        ]);
        assertEquals(
          run.stdout.trim(),
          "bakery worker 1.2.3",
          `${label}: the old worker still runs`,
        );
      }

      // A refused permission: the root became writable by others.
      await chmod(root, 0o777);
      const h = bootstrapIo(root, good.origin);
      assertEquals(
        await runBootstrap(
          setup(server.origin, file, "2.0.0", ["--upgrade"]),
          h.io,
        ),
        2,
      );
      await chmod(root, 0o700);
      assertEquals(await treeOf(root), before);
    } finally {
      await chmod(root, 0o700).catch(() => undefined);
      await good.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.code`, { force: true });
    }
  },
);

Deno.test("AC2: a rerun, a second setup or a second organization in the same root creates no host and moves no ownership", async () => {
  const root = await tempRoot();
  const releases = releaseOrigin();
  const server = bakery();
  const otherOrganization = bakery({
    ...PREVIEW,
    organizationName: "Other Corp",
  });
  const otherSetup = bakery({
    ...PREVIEW,
    enrollmentId: "00000000-0000-4000-8000-0000000000e2",
  });
  try {
    const file = await codeFile(root);
    assertEquals(
      await runBootstrap(
        setup(server.origin, file),
        bootstrapIo(root, releases.origin).io,
      ),
      0,
    );
    const before = await treeOf(root);
    const again = bootstrapIo(root, releases.origin);
    assertEquals(await runBootstrap(setup(server.origin, file), again.io), 0);
    assertStringIncludes(again.text(), "already installed");
    assertStringIncludes(again.text(), "already paired with this setup");
    assertEquals(
      await runBootstrap(
        setup(otherOrganization.origin, file),
        bootstrapIo(root, releases.origin).io,
      ),
      2,
    );
    assertEquals(
      await runBootstrap(
        setup(otherSetup.origin, file),
        bootstrapIo(root, releases.origin).io,
      ),
      2,
    );
    assertEquals(await treeOf(root), before);
    // Every request any Bakery saw was an inspection: not one could have created a host.
    for (const seen of [server, otherOrganization, otherSetup]) {
      for (const request of seen.requests) {
        assertEquals(request, "POST /v1/worker/enrollment-inspection");
      }
    }
  } finally {
    await releases.close();
    await server.close();
    await otherOrganization.close();
    await otherSetup.close();
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.code`, { force: true });
  }
});

const BIN =
  new URL("../../packages/worker-bootstrap/src/bin.ts", import.meta.url)
    .pathname;

async function bin(
  root: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", BIN, ...args],
    env: { ...env, HOME: root },
    stdout: "piped",
    stderr: "piped",
    clearEnv: false,
  });
  const result = await command.output();
  return {
    code: result.code,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}

Deno.test("the real command-line entry runs status, doctor, drain and plan with the real probes, and setup says this build has no release origin", async () => {
  const root = await tempRoot();
  const releases = releaseOrigin();
  const server = bakery();
  try {
    const file = await codeFile(root);
    assertEquals(
      await runBootstrap(
        setup(server.origin, file),
        bootstrapIo(root, releases.origin).io,
      ),
      0,
    );
    const before = await treeOf(root);

    const status = await bin(root, ["status", "--root", root]);
    assertEquals(status.code, 0, status.err);
    assertStringIncludes(status.out, "Installed: release 1.2.3 for linux-x64");
    assertStringIncludes(status.out, "Paired: Acme");
    assertStringIncludes(status.out, "Service: ");

    const doctor = await bin(root, ["doctor", "--root", root]);
    assert([0, 1, 2].includes(doctor.code), doctor.err);
    for (
      const id of [
        "unprivileged",
        "root",
        "install",
        "pairing",
        "code-file",
        "settings-file",
        "disk",
        "sandbox",
        "service",
      ]
    ) {
      assertStringIncludes(doctor.out, `${id}:`);
    }
    assertStringIncludes(
      doctor.out,
      "ok        install: The installed worker matches its signed digest.",
    );
    assertStringIncludes(
      doctor.out,
      "ok        pairing: Paired with an organization.",
    );
    assertStringIncludes(
      doctor.out,
      "ok        disk: There is enough free disk space.",
    );

    const drain = await bin(root, ["drain", "--root", root]);
    assertEquals(drain.code, 0, drain.err);
    assertStringIncludes(drain.out, "systemctl stop bakery-worker");

    const plan = await bin(root, ["plan", "--root", root]);
    assertEquals(plan.code, 0, plan.err);
    assertStringIncludes(plan.out, "BAKERY_WORKER_NAME=build-linux-01");
    assertFalse(plan.out.includes(SECRET));

    const noOrigin = await bin(root, [
      "setup",
      "--server",
      server.origin,
      "--release",
      "1.2.3",
      "--token-file",
      file,
      "--root",
      root,
    ]);
    assertEquals(noOrigin.code, 2);
    assertStringIncludes(noOrigin.out + noOrigin.err, "no release origin");

    const shortcut = await bin(root, [
      "pair",
      "--server",
      server.origin,
      "--token",
      SECRET,
      "--root",
      root,
    ]);
    assertEquals(shortcut.code, 2);
    assertFalse((shortcut.out + shortcut.err).includes(SECRET));

    // None of that changed the root, and the Bakery saw one inspection only.
    assertEquals(await treeOf(root), before);
    assertEquals(server.requests, ["POST /v1/worker/enrollment-inspection"]);
  } finally {
    await releases.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.code`, { force: true });
  }
});

Deno.test("the real probes answer about the real machine: free space, a user id, the service manager and an unknown program", async () => {
  const probes = systemProbes("linux");
  const free = await probes.freeBytes(tmpdir());
  assert(free !== null && free > 0);
  assertEquals(typeof probes.uid(), "number");
  assert(
    ["active", "inactive", "failed", "absent", "unknown"].includes(
      await probes.serviceState(),
    ),
  );
  assertEquals(await probes.runs(["/nonexistent/program"]), false);
  assertEquals(await probes.runs(["/bin/true"]), true);
});
