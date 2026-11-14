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
  type ServiceState,
} from "../../packages/worker-bootstrap/src/index.ts";

// #18, last slice (AC1 and AC2 through the one entry point): setup installs the
// named signed release and then pairs; a rerun creates nothing new; every
// failure leaves what was there. Release origin and Bakery are one fake fetch.

const RELEASES = "https://releases.bakery.example";
const BAKERY = "https://bakery.example";
const SECRET = "bk_setup_8f3a1c5e9d7b2a4f";
const ENROLLMENT = "00000000-0000-4000-8000-0000000000e1";
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
const STRANGER = testKey("release-2026-z");
const CONFIG: ReleaseConfig = {
  origin: RELEASES,
  trustRoot: [KEY.trust],
  protocol: 3,
  stateFormat: 2,
};

function signedManifest(
  release: string,
  binary: Uint8Array,
  key = KEY,
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
    }),
    "utf8",
  );
  return JSON.stringify({
    keyId: key.keyId,
    payload: payload.toString("base64"),
    signature: sign(null, payload, key.privateKey).toString("base64"),
  });
}

const PREVIEW = {
  enrollmentId: ENROLLMENT,
  organizationName: "Acme",
  name: "build-linux-01",
  os: "linux",
  architecture: "x64",
  slots: 2,
  capabilities: ["git", "shell", "claude"],
  expiresAt: "2026-11-14T00:10:00.000Z",
  state: "pending",
};

type World = {
  releases: Record<string, () => Response>;
  preview: () => unknown;
};

function world(over: Partial<World> = {}): World {
  return {
    releases: {
      "/releases/1.2.3/manifest.json": () =>
        new Response(signedManifest("1.2.3", BINARY)),
      "/releases/1.2.3/bakery-worker-1.2.3-linux-x64": () =>
        new Response(BINARY),
      "/releases/2.0.0/manifest.json": () =>
        new Response(signedManifest("2.0.0", BINARY_2)),
      "/releases/2.0.0/bakery-worker-2.0.0-linux-x64": () =>
        new Response(BINARY_2),
    },
    preview: () => PREVIEW,
    ...over,
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bakery-boot-"));
  await chmod(root, 0o700);
  return root;
}

async function codeFile(root: string): Promise<string> {
  const path = join(root, "..", `code-${Math.random().toString(36).slice(2)}`);
  await writeFile(path, `${SECRET}\n`, { mode: 0o600 });
  return path;
}

function harness(
  root: string,
  w: World,
  options: {
    release?: boolean;
    service?: ServiceState;
    answer?: string;
    platform?: string;
    arch?: string;
    uid?: number | null;
    home?: string | null;
  } = {},
) {
  const out: string[] = [];
  const asked: string[] = [];
  const calls: { url: string; method: string }[] = [];
  const fakeFetch = ((url: string, init?: RequestInit) => {
    const target = new URL(String(url));
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (target.origin === RELEASES) {
      const route = w.releases[target.pathname];
      return Promise.resolve(
        route ? route() : new Response("not found", { status: 404 }),
      );
    }
    if (target.origin === BAKERY) {
      return Promise.resolve(
        new Response(JSON.stringify(w.preview()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.reject(new Error("unexpected origin"));
  }) as unknown as typeof fetch;
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
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(options.answer ?? "y");
      },
      write: (text) => void out.push(text),
      fetch: fakeFetch,
      now: () => NOW,
      release: options.release === false ? undefined : {
        config: CONFIG,
        platform: options.platform ?? "linux",
        arch: options.arch ?? "x64",
      },
    },
    operation: {
      write: (text) => void out.push(text),
      target: "linux",
      home: options.home === null ? undefined : (options.home ?? "/home/alice"),
      probes: {
        serviceState: () => Promise.resolve(options.service ?? "absent"),
        runs: () => Promise.resolve(true),
        freeBytes: () => Promise.resolve(10 * 1024 ** 3),
        uid: () => options.uid === undefined ? 1000 : options.uid,
      },
    },
  };
  return { io, out, asked, calls, text: () => out.join("") };
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

const setupArgs = (file: string, extra: string[] = []) => [
  "setup",
  "--server",
  BAKERY,
  "--release",
  "1.2.3",
  "--token-file",
  file,
  ...extra,
];

Deno.test("setup --release installs the signed release, confirms, then pairs, and the code never leaves its file", async () => {
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    const h = harness(root, world());
    assertEquals(await runBootstrap(setupArgs(file), h.io), 0);
    assertStringIncludes(h.text(), "Installed release 1.2.3 for linux-x64.\n");
    assertStringIncludes(h.text(), "Organization: Acme");
    assertStringIncludes(h.text(), "Paired. Start the worker service");
    assertEquals(h.asked.length, 1);
    assertEquals(
      await readlink(join(root, "current")),
      join("releases", "1.2.3-linux-x64"),
    );
    assertEquals(
      await readFile(join(root, "current", "bakery-worker")),
      Buffer.from(BINARY),
    );
    assertEquals((await lstat(join(root, "pairing.json"))).mode & 0o777, 0o600);
    assertEquals(
      (await lstat(join(root, "enrollment-token"))).mode & 0o777,
      0o600,
    );
    // The Bakery server was asked once, to inspect; nothing else was sent to it.
    assertEquals(
      h.calls.filter((call) => call.url.startsWith(BAKERY)).map((call) =>
        call.method
      ),
      ["POST"],
    );
    // The code is in its two protected files only: not in the output, not in a URL.
    assertFalse(h.text().includes(SECRET));
    for (const call of h.calls) assertFalse(call.url.includes(SECRET));
    for (const path of await treeOf(root)) {
      if (path.includes("enrollment-token") || path.includes("/code-")) {
        continue;
      }
      const name = path.split(":")[0]!;
      if ((await lstat(name)).isFile() && !name.endsWith("bakery-worker")) {
        assertFalse((await readFile(name, "utf8")).includes(SECRET), name);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a rerun of the same setup changes nothing and creates nothing: no second install, no second pairing, no second question", async () => {
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    const first = harness(root, world());
    assertEquals(await runBootstrap(setupArgs(file), first.io), 0);
    const before = await treeOf(root);
    const second = harness(root, world());
    assertEquals(await runBootstrap(setupArgs(file), second.io), 0);
    assertStringIncludes(
      second.text(),
      "Release 1.2.3 for linux-x64 is already installed.\n",
    );
    assertStringIncludes(
      second.text(),
      "already paired with this setup. Nothing was changed.",
    );
    assertEquals(second.asked, []);
    // Only the inspection reached Bakery; no create call exists to make a host.
    assertEquals(
      second.calls.filter((call) => call.url.startsWith(BAKERY)).map((call) =>
        call.method
      ),
      ["POST"],
    );
    assertEquals(await treeOf(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a second organization, a second setup, or a different release without consent changes nothing in a paired root", async () => {
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    assertEquals(
      await runBootstrap(setupArgs(file), harness(root, world()).io),
      0,
    );
    const before = await treeOf(root);
    const other = harness(
      root,
      world({
        preview: () => ({ ...PREVIEW, organizationName: "Other Corp" }),
      }),
    );
    assertEquals(await runBootstrap(setupArgs(file), other.io), 2);
    assertStringIncludes(other.text(), "different organization");
    const another = harness(
      root,
      world({
        preview: () => ({
          ...PREVIEW,
          enrollmentId: "00000000-0000-4000-8000-0000000000e2",
        }),
      }),
    );
    assertEquals(await runBootstrap(setupArgs(file), another.io), 2);
    const newer = harness(root, world());
    assertEquals(
      await runBootstrap(
        [
          "setup",
          "--server",
          BAKERY,
          "--release",
          "2.0.0",
          "--token-file",
          file,
        ],
        newer.io,
      ),
      2,
    );
    assertEquals(await treeOf(root), before);
    // With consent it is replaced: only then.
    const upgraded = harness(root, world());
    assertEquals(
      await runBootstrap(
        [
          "setup",
          "--server",
          BAKERY,
          "--release",
          "2.0.0",
          "--upgrade",
          "--token-file",
          file,
        ],
        upgraded.io,
      ),
      0,
    );
    assertEquals(
      await readlink(join(root, "current")),
      join("releases", "2.0.0-linux-x64"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("every way the install can fail ends with exit 2, one fixed sentence, a root exactly as it was, and no pairing", async () => {
  const cases: [
    string,
    Partial<World>,
    { platform?: string; arch?: string; release?: boolean },
    string,
  ][] = [
    [
      "a stranger's signature",
      {
        releases: {
          ...world().releases,
          "/releases/1.2.3/manifest.json": () =>
            new Response(signedManifest("1.2.3", BINARY, STRANGER)),
        },
      },
      {},
      "signed by a key this bootstrap does not trust",
    ],
    ["no manifest", { releases: {} }, {}, "download"],
    [
      "a file of the wrong size",
      {
        releases: {
          ...world().releases,
          "/releases/1.2.3/bakery-worker-1.2.3-linux-x64": () =>
            new Response(BINARY.subarray(0, 5)),
        },
      },
      {},
      "size",
    ],
    [
      "the wrong bytes",
      {
        releases: {
          ...world().releases,
          "/releases/1.2.3/bakery-worker-1.2.3-linux-x64": () =>
            new Response(new Uint8Array(BINARY.byteLength).fill(66)),
        },
      },
      {},
      "digest",
    ],
    [
      "an unsupported target",
      {},
      { platform: "darwin", arch: "arm64" },
      "no build for this operating system",
    ],
    [
      "an unsupported system on a supported processor",
      {},
      { platform: "darwin", arch: "x64" },
      "no build for this operating system",
    ],
    [
      "an unsupported processor on a supported system",
      {},
      { platform: "linux", arch: "arm64" },
      "no build for this operating system",
    ],
    [
      "a build with no release origin",
      {},
      { release: false },
      "no release origin",
    ],
  ];
  for (const [label, over, options, fragment] of cases) {
    const root = await tempRoot();
    try {
      const file = await codeFile(root);
      const before = await treeOf(root);
      const h = harness(root, world(over), options);
      assertEquals(await runBootstrap(setupArgs(file), h.io), 2, label);
      assert(
        h.text().toLowerCase().includes(fragment.toLowerCase()),
        `${label}: ${h.text()}`,
      );
      assertEquals(
        await treeOf(root),
        before,
        `${label}: the root is as it was`,
      );
      assertEquals(
        h.calls.filter((call) => call.url.startsWith(BAKERY)),
        [],
        `${label}: Bakery was never asked`,
      );
      assertEquals(h.asked, [], label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

Deno.test("declining at the confirmation keeps the verified install and pairs nothing", async () => {
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    const h = harness(root, world(), { answer: "n" });
    assertEquals(await runBootstrap(setupArgs(file), h.io), 1);
    assertEquals(
      await readlink(join(root, "current")),
      join("releases", "1.2.3-linux-x64"),
    );
    for (const name of await readdir(root)) {
      assertFalse(name === "pairing.json" || name === "enrollment-token", name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("setup without a release needs the worker installed already; pair takes no release; a code on the command line is refused", async () => {
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    const bare = harness(root, world());
    assertEquals(
      await runBootstrap(
        ["setup", "--server", BAKERY, "--token-file", file],
        bare.io,
      ),
      2,
    );
    assertStringIncludes(bare.text(), "Run setup with --release VERSION");
    const pairRelease = harness(root, world());
    assertEquals(
      await runBootstrap([
        "pair",
        "--server",
        BAKERY,
        "--release",
        "1.2.3",
        "--token-file",
        file,
      ], pairRelease.io),
      2,
    );
    assertStringIncludes(pairRelease.text(), "Unknown command or option");
    const shortcut = harness(root, world());
    assertEquals(
      await runBootstrap(
        ["pair", "--server", BAKERY, "--token", SECRET],
        shortcut.io,
      ),
      2,
    );
    assertFalse(shortcut.text().includes(SECRET));
    assertEquals(shortcut.calls, []);
    assertEquals(
      await readdir(root).then((names) =>
        names.filter((n) => !n.startsWith("code-"))
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("an unknown command, no command, and a range for a release say so and do nothing", async () => {
  const root = await tempRoot();
  try {
    for (
      const argv of [[], ["unknown"], ["install"], [
        "setup",
        "--server",
        BAKERY,
        "--release",
        "latest",
        "--token-file",
        "/x",
      ], ["status", "--server", BAKERY]]
    ) {
      const h = harness(root, world());
      assertEquals(await runBootstrap(argv, h.io), 2, argv.join(" "));
      assertEquals(h.calls, []);
    }
    assertEquals(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("status, doctor and drain run through the same entry and read what setup left", async () => {
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    assertEquals(
      await runBootstrap(setupArgs(file), harness(root, world()).io),
      0,
    );
    const status = harness(root, world(), { service: "active" });
    assertEquals(await runBootstrap(["status"], status.io), 0);
    assertStringIncludes(
      status.text(),
      "Installed: release 1.2.3 for linux-x64",
    );
    assertStringIncludes(
      status.text(),
      "Paired: Acme (https://bakery.example) as build-linux-01",
    );
    assertStringIncludes(status.text(), "Service: active");
    const doctor = harness(root, world(), { service: "active" });
    // The code file is still in the root (the worker uses it): owner-only, so ok.
    assertEquals(await runBootstrap(["doctor"], doctor.io), 1);
    assertStringIncludes(doctor.text(), "attention settings-file");
    assertStringIncludes(doctor.text(), "ok        code-file");
    const drain = harness(root, world());
    assertEquals(await runBootstrap(["drain"], drain.io), 0);
    assertStringIncludes(drain.text(), "systemctl stop bakery-worker");
    assertEquals(drain.calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("plan prints every change and every definition for the machine that was paired, and writes nothing", async () => {
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    assertEquals(
      await runBootstrap(setupArgs(file), harness(root, world()).io),
      0,
    );
    const before = await treeOf(root);
    const h = harness(root, world());
    assertEquals(await runBootstrap(["plan"], h.io), 0);
    const text = h.text();
    assertStringIncludes(text, "Nothing has been changed yet");
    assertStringIncludes(
      text,
      "[administrator] Create the dedicated account bakery-worker",
    );
    assertStringIncludes(text, "systemctl enable --now bakery-worker");
    assertStringIncludes(text, `ExecStart=${root}/current/bakery-worker`);
    assertStringIncludes(text, "BAKERY_SERVER_URL=https://bakery.example");
    assertStringIncludes(text, "BAKERY_WORKER_NAME=build-linux-01");
    assertStringIncludes(text, "BAKERY_WORKER_SLOTS=2");
    assertStringIncludes(text, "BAKERY_WORKER_CAPABILITIES=git,shell,claude");
    assertStringIncludes(
      text,
      `BAKERY_WORKER_ENROLLMENT_TOKEN_FILE=${root}/enrollment-token`,
    );
    assertStringIncludes(text, `BAKERY_WORKER_STATE_DIR=${root}/state`);
    assertFalse(
      text.includes(SECRET),
      "the code is only ever named by its file",
    );
    assertFalse(text.includes("sudo"));
    assertEquals(h.calls, []);
    assertEquals(await treeOf(root), before);
    // A coding agent's settings and another account are added by the operator.
    const more = harness(root, world());
    assertEquals(
      await runBootstrap([
        "plan",
        "--account",
        "svc-worker",
        "--setting",
        "BAKERY_CLAUDE_HARNESS=1",
      ], more.io),
      0,
    );
    assertStringIncludes(
      more.text(),
      "Create the dedicated account svc-worker",
    );
    assertStringIncludes(more.text(), "BAKERY_CLAUDE_HARNESS=1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("plan refuses what it cannot plan safely: not paired, another system, the setup code as a setting, a bad account, a record that cannot be shown", async () => {
  const root = await tempRoot();
  try {
    const none = harness(root, world());
    assertEquals(await runBootstrap(["plan"], none.io), 2);
    assertStringIncludes(none.text(), "not paired");
    const file = await codeFile(root);
    assertEquals(
      await runBootstrap(setupArgs(file), harness(root, world()).io),
      0,
    );
    const refusals: [string[], string][] = [
      [
        ["plan", "--system", "macos", "--account", "alice"],
        "different operating system",
      ],
      [
        ["plan", "--setting", "BAKERY_WORKER_ENROLLMENT_TOKEN=abc"],
        "setup code is never written",
      ],
      [
        ["plan", "--setting", "BAKERY_ENROLLMENT_TOKEN=abc"],
        "setup code is never written",
      ],
      [
        ["plan", "--setting", "lowercase=1"],
        "not allowed in a service definition",
      ],
      [
        ["plan", "--setting", "BAKERY_X=a\u001bb"],
        "not allowed in a service definition",
      ],
      [
        ["plan", "--account", "Root;rm -rf"],
        "characters the service definition does not allow",
      ],
      [
        ["plan", "--account", "root account"],
        "characters the service definition does not allow",
      ],
      [["plan", "--system", "windows"], "Unknown command or option"],
      [["plan", "--setting", "NOEQUALS"], "Unknown command or option"],
      [["status", "--account", "x"], "Unknown command or option"],
    ];
    for (const [argv, fragment] of refusals) {
      const h = harness(root, world());
      assertEquals(await runBootstrap(argv, h.io), 2, argv.join(" "));
      assertStringIncludes(h.text(), fragment);
      assertFalse(h.text().includes("\u001b"));
    }
    // A record edited to carry text that must not be shown is not planned from.
    const path = join(root, "pairing.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    for (
      const [field, value] of [
        ["name", "build\u001b[2K"],
        ["serverOrigin", "https://bakery.example\n"],
        ["capabilities", ["git", "‮"]],
        ["architecture", "x64\u0000"],
      ] as const
    ) {
      await writeFile(path, JSON.stringify({ ...record, [field]: value }), {
        mode: 0o600,
      });
      const h = harness(root, world());
      assertEquals(await runBootstrap(["plan"], h.io), 2, field);
      assertStringIncludes(h.text(), "pairing cannot be read");
      assertFalse(h.text().includes("\u001b") || h.text().includes("‮"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("plan never runs the worker as root or as a system account, and what pairing fixed cannot be replaced", async () => {
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    assertEquals(
      await runBootstrap(setupArgs(file), harness(root, world()).io),
      0,
    );
    for (
      const account of [
        "root",
        "daemon",
        "bin",
        "sys",
        "mail",
        "nobody",
        "nogroup",
        "sshd",
        "www-data",
        "postgres",
        "systemd-network",
        "systemd-resolve",
        "wheel",
        "sudo",
        "admin",
      ]
    ) {
      const h = harness(root, world());
      assertEquals(
        await runBootstrap(["plan", "--account", account], h.io),
        2,
        account,
      );
      assertStringIncludes(
        h.text(),
        "dedicated account, never root or a system account",
        account,
      );
      assertFalse(
        h.text().includes("User="),
        `${account}: no unit was printed`,
      );
    }
    // The default and an ordinary new account still plan, and run as themselves.
    for (
      const account of [
        undefined,
        "svc-worker",
        "builder",
        "bakery_worker1",
        "worker",
      ]
    ) {
      const h = harness(root, world());
      const argv = account === undefined
        ? ["plan"]
        : ["plan", "--account", account];
      assertEquals(await runBootstrap(argv, h.io), 0, String(account));
      assertStringIncludes(h.text(), `User=${account ?? "bakery-worker"}`);
      assertFalse(h.text().includes("User=root"));
    }
    // What the pairing fixed is where the settings come from: an extra setting adds, it never replaces.
    for (
      const name of [
        "BAKERY_SERVER_URL",
        "BAKERY_WORKER_NAME",
        "BAKERY_WORKER_SLOTS",
        "BAKERY_WORKER_CAPABILITIES",
        "BAKERY_WORKER_ENROLLMENT_TOKEN_FILE",
        "BAKERY_WORKER_STATE_DIR",
      ]
    ) {
      const h = harness(root, world());
      assertEquals(
        await runBootstrap(["plan", "--setting", `${name}=elsewhere`], h.io),
        2,
        name,
      );
      assertStringIncludes(h.text(), "not allowed in a service definition");
      assertFalse(
        h.text().includes("elsewhere"),
        `${name}: the override was not printed`,
      );
    }
    const added = harness(root, world());
    assertEquals(
      await runBootstrap(
        ["plan", "--setting", "BAKERY_CLAUDE_HARNESS=1"],
        added.io,
      ),
      0,
    );
    assertStringIncludes(added.text(), "BAKERY_CLAUDE_HARNESS=1");
    assertStringIncludes(
      added.text(),
      "BAKERY_WORKER_CAPABILITIES=git,shell,claude",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("plan for a Mac names the LaunchAgent under the user's home and needs an account; it never needs an administrator", async () => {
  const root = await tempRoot();
  try {
    const file = await codeFile(root);
    const mac = { ...PREVIEW, os: "macos", architecture: "arm64" };
    // A Mac cannot be set up by this bootstrap yet; the pairing record is what plan reads.
    const paired = harness(root, world({ preview: () => mac }));
    assertEquals(
      await runBootstrap([
        "pair",
        "--server",
        BAKERY,
        "--token-file",
        file,
        "--root",
        root,
      ], paired.io),
      0,
    );
    const missing = harness(root, world());
    assertEquals(
      await runBootstrap(["plan", "--system", "macos"], missing.io),
      2,
    );
    assertStringIncludes(missing.text(), "Unknown command or option");
    // Without a home directory there is nowhere to name the LaunchAgent, and
    // without a user id no domain to load it into: refused, not guessed.
    for (const options of [{ home: null }, { uid: null }]) {
      const nowhere = harness(root, world(), options);
      assertEquals(
        await runBootstrap(
          ["plan", "--system", "macos", "--account", "alice"],
          nowhere.io,
        ),
        2,
        JSON.stringify(options),
      );
      assertStringIncludes(
        nowhere.text(),
        "characters the service definition does not allow",
      );
    }
    const h = harness(root, world());
    assertEquals(
      await runBootstrap(
        ["plan", "--system", "macos", "--account", "alice"],
        h.io,
      ),
      0,
    );
    assertStringIncludes(h.text(), "[user] Write the LaunchAgent");
    assertStringIncludes(h.text(), "launchctl bootstrap gui/1000");
    assertStringIncludes(
      h.text(),
      "/home/alice/Library/LaunchAgents/io.bakery.worker.plist",
    );
    assertFalse(h.text().includes("[administrator]"));
    // The plan for the other system is refused: this was paired as macOS.
    const linux = harness(root, world());
    assertEquals(await runBootstrap(["plan"], linux.io), 2);
    assertStringIncludes(linux.text(), "different operating system");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
