import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootstrapError,
  type CommandIo,
  type EnrollmentPreview,
  inspectEnrollment,
  normalizeServerOrigin,
  PAIRING_FILE,
  pairInstallation,
  parseCommand,
  readHiddenToken,
  readProtectedToken,
  runCommand,
  TOKEN_FILE,
} from "../../packages/worker-bootstrap/src/index.ts";

// #18 slice 2 (AC2): hidden-input or protected-descriptor pairing, an
// installation bound to one organization, and a rerun that creates nothing new.
// Everything runs in temp roots against a fake server.

const SECRET = "bk_setup_8f3a1c5e9d7b2a4f";
const ORIGIN = "https://bakery.example";
const ENROLLMENT = "00000000-0000-4000-8000-0000000000e1";
const OTHER_ENROLLMENT = "00000000-0000-4000-8000-0000000000e2";
const NOW = new Date("2026-11-14T00:00:00.000Z");

const preview = (
  overrides: Partial<EnrollmentPreview> = {},
): EnrollmentPreview => ({
  enrollmentId: ENROLLMENT,
  organizationName: "Acme",
  name: "build-linux-01",
  os: "linux",
  architecture: "x64",
  slots: 2,
  capabilities: ["git", "shell", "claude"],
  expiresAt: "2026-11-14T00:10:00.000Z",
  state: "pending",
  ...overrides,
});

type Call = { url: string; init: RequestInit };

function server(
  answer: () => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(answer());
    }) as unknown as typeof fetch,
  };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bakery-pair-"));
  await chmod(root, 0o700);
  return root;
}

async function modeOf(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof BootstrapError, `a BootstrapError, got ${error}`);
    return error.code;
  }
  throw new Error("expected a refusal");
}

Deno.test("the server address is an https origin, or plain http for this machine only", () => {
  assertEquals(normalizeServerOrigin("https://bakery.example"), ORIGIN);
  assertEquals(normalizeServerOrigin("https://bakery.example/"), ORIGIN);
  assertEquals(
    normalizeServerOrigin("https://bakery.example:8443"),
    "https://bakery.example:8443",
  );
  assertEquals(
    normalizeServerOrigin("http://localhost:5173"),
    "http://localhost:5173",
  );
  assertEquals(
    normalizeServerOrigin("http://127.0.0.1:3000"),
    "http://127.0.0.1:3000",
  );
});

Deno.test("an address that is not a bare origin is refused, so nothing else can steer where the code goes", async () => {
  const refused: [string, string][] = [
    ["http://bakery.example", "PAIRING_SERVER_INSECURE"],
    ["http://10.0.0.5", "PAIRING_SERVER_INSECURE"],
    ["http://localhost.evil.test", "PAIRING_SERVER_INSECURE"],
    ["https://user:pass@bakery.example", "PAIRING_SERVER_INVALID"],
    ["https://bakery.example/path", "PAIRING_SERVER_INVALID"],
    ["https://bakery.example/?next=x", "PAIRING_SERVER_INVALID"],
    ["https://bakery.example/#frag", "PAIRING_SERVER_INVALID"],
    ["ftp://bakery.example", "PAIRING_SERVER_INVALID"],
    ["bakery.example", "PAIRING_SERVER_INVALID"],
    ["", "PAIRING_SERVER_INVALID"],
  ];
  for (const [input, code] of refused) {
    assertEquals(
      await codeOf(Promise.resolve().then(() => normalizeServerOrigin(input))),
      code,
      input,
    );
  }
});

Deno.test("a protected file is read only when it is a plain file nobody else can read, holding one short code", async () => {
  const root = await tempRoot();
  try {
    const good = join(root, "good");
    await writeFile(good, `${SECRET}\n`, { mode: 0o600 });
    await chmod(good, 0o600);
    assertEquals(await readProtectedToken(good), SECRET);

    const open = join(root, "open");
    await writeFile(open, SECRET, { mode: 0o644 });
    await chmod(open, 0o644);
    assertEquals(
      await codeOf(readProtectedToken(open)),
      "PAIRING_TOKEN_UNPROTECTED",
    );

    const group = join(root, "group");
    await writeFile(group, SECRET);
    await chmod(group, 0o640);
    assertEquals(
      await codeOf(readProtectedToken(group)),
      "PAIRING_TOKEN_UNPROTECTED",
    );

    const link = join(root, "link");
    await symlink(good, link);
    assertEquals(
      await codeOf(readProtectedToken(link)),
      "PAIRING_TOKEN_UNREADABLE",
    );

    await mkdir(join(root, "dir"), { mode: 0o700 });
    assertEquals(
      await codeOf(readProtectedToken(join(root, "dir"))),
      "PAIRING_TOKEN_UNREADABLE",
    );
    assertEquals(
      await codeOf(readProtectedToken(join(root, "missing"))),
      "PAIRING_TOKEN_UNREADABLE",
    );

    for (
      const [name, content] of [
        ["empty", ""],
        ["blank", "  \n"],
        ["two", "a\nb\n"],
        ["spaced", "two words"],
        ["long", "x".repeat(600)],
        ["control", "abc\u0007def"],
      ] as const
    ) {
      const path = join(root, name);
      await writeFile(path, content, { mode: 0o600 });
      await chmod(path, 0o600);
      assertEquals(
        await codeOf(readProtectedToken(path)),
        "PAIRING_TOKEN_INVALID",
        name,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeTerminal(options: { tty: boolean }) {
  const listeners = new Set<(chunk: string) => void>();
  const raw: boolean[] = [];
  return {
    raw,
    listeners,
    stream: {
      isTTY: options.tty,
      setRawMode: (mode: boolean) => {
        raw.push(mode);
      },
      resume: () => undefined,
      pause: () => undefined,
      setEncoding: () => undefined,
      on: (_event: "data", listener: (chunk: string) => void) => {
        listeners.add(listener);
      },
      off: (_event: "data", listener: (chunk: string) => void) => {
        listeners.delete(listener);
      },
    },
    type(text: string) {
      for (const listener of [...listeners]) listener(text);
    },
  };
}

Deno.test("the hidden prompt never echoes the code, lets backspace edit it, and restores the terminal", async () => {
  const terminal = fakeTerminal({ tty: true });
  const shown: string[] = [];
  const reading = readHiddenToken(terminal.stream, (text) => shown.push(text));
  terminal.type("bk_setup_");
  terminal.type("8f3aX\u007f");
  terminal.type("1c5e9d7b2a4f\r");
  assertEquals(await reading, SECRET);
  // Only the prompt and a line break were ever written to the screen.
  assertEquals(shown, ["Setup code (not shown): ", "\n"]);
  assertFalse(shown.join("").includes("bk_setup"));
  // Raw mode on while typing, off after; no listener left behind.
  assertEquals(terminal.raw, [true, false]);
  assertEquals(terminal.listeners.size, 0);
});

Deno.test("the hidden prompt refuses a pipe, and Ctrl-C ends it with no code and the terminal restored", async () => {
  const pipe = fakeTerminal({ tty: false });
  assertEquals(
    await codeOf(readHiddenToken(pipe.stream, () => undefined)),
    "PAIRING_TOKEN_UNREADABLE",
  );
  assertEquals(pipe.raw, []);

  const terminal = fakeTerminal({ tty: true });
  const reading = readHiddenToken(terminal.stream, () => undefined);
  terminal.type("bk_");
  terminal.type("\u0003");
  assertEquals(await codeOf(reading), "PAIRING_TOKEN_UNREADABLE");
  assertEquals(terminal.raw, [true, false]);
  assertEquals(terminal.listeners.size, 0);
});

Deno.test("inspection posts the code in the body to one fixed path, refuses redirects, and says nothing the server said", async () => {
  const fake = server(() => ok(preview()));
  const result = await inspectEnrollment({
    origin: ORIGIN,
    token: SECRET,
    fetch: fake.fetch,
  });
  assertEquals(result, preview());
  assertEquals(fake.calls.length, 1);
  const { url, init } = fake.calls[0]!;
  assertEquals(url, "https://bakery.example/v1/worker/enrollment-inspection");
  assertFalse(url.includes(SECRET));
  assertEquals(init.method, "POST");
  assertEquals(JSON.parse(String(init.body)), { enrollmentToken: SECRET });
  assertEquals(init.redirect, "error");
  assertFalse(JSON.stringify(init.headers).includes(SECRET));

  // A refusal, an outage and a timeout are one fixed message, with no server text.
  for (
    const answer of [
      () => new Response("secret server detail", { status: 404 }),
      () => new Response("secret server detail", { status: 429 }),
      () => new Response("secret server detail", { status: 500 }),
    ]
  ) {
    const failing = server(answer);
    const error = await assertRejects(
      () =>
        inspectEnrollment({
          origin: ORIGIN,
          token: SECRET,
          fetch: failing.fetch,
        }),
      BootstrapError,
    );
    assertEquals(error.code, "PAIRING_INSPECTION_FAILED");
    assertFalse(error.message.includes("secret server detail"));
    assertFalse(error.message.includes(SECRET));
  }
  const down = {
    fetch: (() =>
      Promise.reject(
        new Error(`connect refused ${SECRET}`),
      )) as unknown as typeof fetch,
  };
  const error = await assertRejects(
    () =>
      inspectEnrollment({ origin: ORIGIN, token: SECRET, fetch: down.fetch }),
    BootstrapError,
  );
  assertEquals(error.code, "PAIRING_INSPECTION_FAILED");
  assertFalse(error.message.includes(SECRET));
  assertFalse(JSON.stringify(error).includes(SECRET));
});

Deno.test("an inspection answer in the wrong shape, or too big, is refused before anything is shown", async () => {
  const malformed: unknown[] = [
    null,
    [],
    "text",
    {},
    { ...preview(), enrollmentId: "not-a-uuid" },
    { ...preview(), organizationName: "" },
    { ...preview(), organizationName: "x".repeat(201) },
    { ...preview(), slots: 0 },
    { ...preview(), slots: 1.5 },
    { ...preview(), slots: 101 },
    { ...preview(), slots: "2" },
    { ...preview(), capabilities: "git" },
    { ...preview(), capabilities: [1] },
    { ...preview(), capabilities: Array(101).fill("a") },
    { ...preview(), state: "consumed" },
    { ...preview(), state: undefined },
  ];
  for (const body of malformed) {
    const fake = server(() => ok(body));
    assertEquals(
      await codeOf(
        inspectEnrollment({ origin: ORIGIN, token: SECRET, fetch: fake.fetch }),
      ),
      "PAIRING_INSPECTION_MALFORMED",
      JSON.stringify(body)?.slice(0, 60),
    );
  }
  // Valid JSON, padded past the bound: only the size limit can refuse it.
  const huge = server(() =>
    new Response(JSON.stringify(preview()) + " ".repeat(40_000), {
      status: 200,
    })
  );
  assertEquals(
    await codeOf(
      inspectEnrollment({ origin: ORIGIN, token: SECRET, fetch: huge.fetch }),
    ),
    "PAIRING_INSPECTION_MALFORMED",
  );
  const notJson = server(() => new Response("<html>", { status: 200 }));
  assertEquals(
    await codeOf(
      inspectEnrollment({
        origin: ORIGIN,
        token: SECRET,
        fetch: notJson.fetch,
      }),
    ),
    "PAIRING_INSPECTION_MALFORMED",
  );
});

function pairing(root: string, fake: ReturnType<typeof server>, extra: {
  serverUrl?: string;
  confirm?: (p: EnrollmentPreview) => Promise<boolean>;
  token?: string;
} = {}) {
  const confirmed: EnrollmentPreview[] = [];
  return {
    confirmed,
    run: () =>
      pairInstallation({
        root,
        serverUrl: extra.serverUrl ?? ORIGIN,
        readToken: () => Promise.resolve(extra.token ?? SECRET),
        confirm: extra.confirm ?? ((p) => {
          confirmed.push(p);
          return Promise.resolve(true);
        }),
        fetch: fake.fetch,
        now: NOW,
      }),
  };
}

Deno.test("a first pairing asks first, then records the organization and keeps the code where only its owner can read it", async () => {
  const root = await tempRoot();
  try {
    const fake = server(() => ok(preview()));
    const pair = pairing(root, fake);
    const result = await pair.run();
    assertEquals(result.status, "paired");
    // The person saw the organization and the intent before anything was used.
    assertEquals(pair.confirmed, [preview()]);
    // Both files are the owner's alone; the record never holds the code.
    assertEquals(await modeOf(join(root, PAIRING_FILE)), 0o600);
    assertEquals(await modeOf(join(root, TOKEN_FILE)), 0o600);
    assertEquals(await readFile(join(root, TOKEN_FILE), "utf8"), `${SECRET}\n`);
    const binding = JSON.parse(
      await readFile(join(root, PAIRING_FILE), "utf8"),
    );
    assertEquals(binding, {
      version: 1,
      serverOrigin: ORIGIN,
      organizationName: "Acme",
      enrollmentId: ENROLLMENT,
      name: "build-linux-01",
      boundAt: NOW.toISOString(),
    });
    assertFalse(JSON.stringify(binding).includes(SECRET));
    assertEquals(result.tokenFile, join(root, TOKEN_FILE));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("declining, an expired code and a server that does not answer all leave the root exactly as it was", async () => {
  const root = await tempRoot();
  try {
    const declined = pairing(root, server(() => ok(preview())), {
      confirm: () => Promise.resolve(false),
    });
    assertEquals(await codeOf(declined.run()), "PAIRING_DECLINED");
    const expired = pairing(
      root,
      server(() => ok(preview({ state: "expired" }))),
    );
    assertEquals(await codeOf(expired.run()), "PAIRING_NOT_PENDING");
    assertEquals(expired.confirmed, []);
    const canceled = pairing(
      root,
      server(() => ok(preview({ state: "canceled" }))),
    );
    assertEquals(await codeOf(canceled.run()), "PAIRING_NOT_PENDING");
    const down = pairing(root, server(() => new Response("", { status: 503 })));
    assertEquals(await codeOf(down.run()), "PAIRING_INSPECTION_FAILED");
    const plain = pairing(root, server(() => ok(preview())), {
      serverUrl: "http://bakery.example",
    });
    assertEquals(await codeOf(plain.run()), "PAIRING_SERVER_INSECURE");
    // Nothing was written by any of them.
    for (const name of [PAIRING_FILE, TOKEN_FILE]) {
      await assertRejects(() => lstat(join(root, name)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a rerun of the same setup creates nothing new and asks nothing; a stop between the two files is resumed", async () => {
  const root = await tempRoot();
  try {
    const fake = server(() => ok(preview()));
    const first = pairing(root, fake);
    await first.run();
    const recorded = await readFile(join(root, PAIRING_FILE), "utf8");

    const again = pairing(root, fake);
    const result = await again.run();
    assertEquals(result.status, "already");
    // Idempotent and quiet: not asked again, the record is untouched.
    assertEquals(again.confirmed, []);
    assertEquals(await readFile(join(root, PAIRING_FILE), "utf8"), recorded);

    // A stop after the record and before the code file: the rerun restores the code.
    await rm(join(root, TOKEN_FILE));
    const resumed = await pairing(root, fake).run();
    assertEquals(resumed.status, "already");
    assertEquals(await readFile(join(root, TOKEN_FILE), "utf8"), `${SECRET}\n`);
    assertEquals(await modeOf(join(root, TOKEN_FILE)), 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("another organization, another server, or another setup of the same organization is refused and changes nothing", async () => {
  const root = await tempRoot();
  try {
    await pairing(root, server(() => ok(preview()))).run();
    const before = {
      binding: await readFile(join(root, PAIRING_FILE), "utf8"),
      token: await readFile(join(root, TOKEN_FILE), "utf8"),
    };
    // A second organization in the same root: refused, never moved.
    const other = pairing(
      root,
      server(() =>
        ok(
          preview({
            organizationName: "Globex",
            enrollmentId: OTHER_ENROLLMENT,
          }),
        )
      ),
      { token: "other-code-0001" },
    );
    assertEquals(await codeOf(other.run()), "PAIRING_ORGANIZATION_DIFFERS");
    assertEquals(other.confirmed, []);
    // The same name on another server is another organization.
    const elsewhere = pairing(root, server(() => ok(preview())), {
      serverUrl: "https://other.example",
      token: "other-code-0002",
    });
    assertEquals(await codeOf(elsewhere.run()), "PAIRING_ORGANIZATION_DIFFERS");
    // The same organization under another setup would be a second machine.
    const second = pairing(
      root,
      server(() => ok(preview({ enrollmentId: OTHER_ENROLLMENT }))),
      { token: "other-code-0003" },
    );
    assertEquals(await codeOf(second.run()), "PAIRING_ALREADY_PAIRED");
    assertEquals(second.confirmed, []);
    // Nothing moved: the record and the code are byte for byte what they were.
    assertEquals(
      await readFile(join(root, PAIRING_FILE), "utf8"),
      before.binding,
    );
    assertEquals(await readFile(join(root, TOKEN_FILE), "utf8"), before.token);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a record that cannot be trusted is refused and never replaced, and a root that is not the user's own is refused", async () => {
  const root = await tempRoot();
  try {
    const fake = server(() => ok(preview()));
    await writeFile(join(root, PAIRING_FILE), "{not json", { mode: 0o600 });
    await chmod(join(root, PAIRING_FILE), 0o600);
    assertEquals(
      await codeOf(pairing(root, fake).run()),
      "PAIRING_BINDING_CORRUPT",
    );
    assertEquals(await readFile(join(root, PAIRING_FILE), "utf8"), "{not json");

    await writeFile(join(root, PAIRING_FILE), JSON.stringify({ version: 2 }), {
      mode: 0o600,
    });
    await chmod(join(root, PAIRING_FILE), 0o600);
    assertEquals(
      await codeOf(pairing(root, fake).run()),
      "PAIRING_BINDING_CORRUPT",
    );

    // A record others can read is not one this installation wrote.
    await chmod(join(root, PAIRING_FILE), 0o644);
    assertEquals(
      await codeOf(pairing(root, fake).run()),
      "PAIRING_BINDING_CORRUPT",
    );
    await rm(join(root, PAIRING_FILE));

    await chmod(root, 0o775);
    assertEquals(
      await codeOf(pairing(root, fake).run()),
      "INSTALL_ROOT_INVALID",
    );
    assertEquals(
      await codeOf(pairing("relative/root", fake).run()),
      "INSTALL_ROOT_INVALID",
    );
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const HOME_ROOT = { root: "/home/operator/.local/share/bakery-worker" };

Deno.test("setup and pair take a server, an optional root and a protected file or descriptor, and nothing that carries the code", () => {
  assertEquals(
    parseCommand(["pair", "--server", ORIGIN], {}, HOME_ROOT),
    { name: "pair", server: ORIGIN, root: HOME_ROOT.root, tokenFile: null },
  );
  assertEquals(
    parseCommand(
      [
        "setup",
        "--server",
        ORIGIN,
        "--root",
        "/srv/w",
        "--token-file",
        "/run/code",
      ],
      {},
      HOME_ROOT,
    ),
    { name: "setup", server: ORIGIN, root: "/srv/w", tokenFile: "/run/code" },
  );
  assertEquals(
    parseCommand(["pair", "--server", ORIGIN, "--token-fd", "3"], {}, HOME_ROOT)
      .tokenFile,
    "/proc/self/fd/3",
  );
});

Deno.test("a code on the command line or in the environment is refused by name, whatever else is asked", () => {
  const refuse = (argv: string[], environment: Record<string, string> = {}) => {
    try {
      parseCommand(argv, environment, HOME_ROOT);
    } catch (error) {
      assert(error instanceof BootstrapError);
      return error.code;
    }
    return "accepted";
  };
  assertEquals(
    refuse(["pair", "--server", ORIGIN, "--token", SECRET]),
    "COMMAND_TOKEN_SHORTCUT",
  );
  assertEquals(
    refuse(["pair", "--server", ORIGIN, `--token=${SECRET}`]),
    "COMMAND_TOKEN_SHORTCUT",
  );
  assertEquals(
    refuse(["pair", "--server", ORIGIN], {
      BAKERY_WORKER_ENROLLMENT_TOKEN: SECRET,
    }),
    "COMMAND_TOKEN_SHORTCUT",
  );
  assertEquals(
    refuse(["pair", "--server", ORIGIN], { BAKERY_ENROLLMENT_TOKEN: SECRET }),
    "COMMAND_TOKEN_SHORTCUT",
  );
  // An empty variable carries nothing; anything else unknown is refused too.
  assertEquals(
    refuse(["pair", "--server", ORIGIN], {
      BAKERY_WORKER_ENROLLMENT_TOKEN: "",
    }),
    "accepted",
  );
  for (
    const argv of [
      [],
      ["install"],
      ["pair"],
      ["pair", "--server"],
      ["pair", "--server", ORIGIN, "extra"],
      ["pair", "--server", ORIGIN, "--unknown", "x"],
      ["pair", "--server", ORIGIN, "--token-file", "/a", "--token-fd", "3"],
      ["pair", "--server", ORIGIN, "--token-fd", "2"],
      ["pair", "--server", ORIGIN, "--token-fd", "abc"],
      ["pair", "--server", ORIGIN, "--token-fd", "../3"],
    ]
  ) assertEquals(refuse(argv), "COMMAND_UNKNOWN", argv.join(" "));
});

function commandIo(fake: ReturnType<typeof server>, answer: string) {
  const out: string[] = [];
  const asked: string[] = [];
  const io: CommandIo = {
    stdin: fakeTerminal({ tty: false }).stream,
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
    write: (text) => {
      out.push(text);
    },
    fetch: fake.fetch,
    now: () => NOW,
  };
  return { io, out, asked };
}

async function protectedCodeFile(root: string): Promise<string> {
  const path = join(root, "code");
  await writeFile(path, `${SECRET}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

Deno.test("pair shows the organization, asks locally, pairs, and prints only fixed words", async () => {
  const root = await tempRoot();
  try {
    const file = await protectedCodeFile(root);
    const fake = server(() => ok(preview()));
    const { io, out, asked } = commandIo(fake, "y");
    const status = await runCommand(
      { name: "pair", server: ORIGIN, root, tokenFile: file },
      io,
    );
    assertEquals(status, 0);
    assertEquals(asked, ["Pair this machine with this organization? [y/N] "]);
    const printed = out.join("");
    assert(printed.includes("Organization: Acme"));
    assert(printed.includes("Paired."));
    assertFalse(printed.includes(SECRET));
    assertEquals(await readFile(join(root, TOKEN_FILE), "utf8"), `${SECRET}\n`);

    // Again: quiet, nothing new, still exit 0 and still no secret on screen.
    const rerun = commandIo(fake, "y");
    assertEquals(
      await runCommand(
        { name: "pair", server: ORIGIN, root, tokenFile: file },
        rerun.io,
      ),
      0,
    );
    assertEquals(rerun.asked, []);
    assert(rerun.out.join("").includes("already paired"));
    assertFalse(rerun.out.join("").includes(SECRET));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("anything but yes pairs nothing, and an unexpected failure says nothing about its cause", async () => {
  const root = await tempRoot();
  try {
    const file = await protectedCodeFile(root);
    for (const answer of ["", "n", "no", "maybe", "yes please"]) {
      const { io } = commandIo(server(() => ok(preview())), answer);
      assertEquals(
        await runCommand({
          name: "pair",
          server: ORIGIN,
          root,
          tokenFile: file,
        }, io),
        1,
        answer,
      );
    }
    for (const name of [PAIRING_FILE, TOKEN_FILE]) {
      await assertRejects(() => lstat(join(root, name)));
    }
    // Not a refusal the bootstrap knows: the prompt itself fails with a message
    // that carries the code. The screen gets fixed words only.
    const broken = commandIo(server(() => ok(preview())), "y");
    const failing: CommandIo = {
      ...broken.io,
      ask: () => Promise.reject(new Error(`boom ${SECRET}`)),
    };
    assertEquals(
      await runCommand(
        { name: "pair", server: ORIGIN, root, tokenFile: file },
        failing,
      ),
      2,
    );
    assertFalse(broken.out.join("").includes(SECRET));
    assertFalse(broken.out.join("").includes("boom"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("setup needs the worker installed first, then pairs the same way", async () => {
  const root = await tempRoot();
  try {
    const file = await protectedCodeFile(root);
    const fake = server(() => ok(preview()));
    const without = commandIo(fake, "y");
    assertEquals(
      await runCommand(
        { name: "setup", server: ORIGIN, root, tokenFile: file },
        without.io,
      ),
      2,
    );
    assert(without.out.join("").includes("not installed"));
    assertEquals(fake.calls.length, 0);

    await symlink(join("releases", "1.2.3"), join(root, "current"));
    const installed = commandIo(fake, "y");
    assertEquals(
      await runCommand(
        { name: "setup", server: ORIGIN, root, tokenFile: file },
        installed.io,
      ),
      0,
    );
    assertEquals(fake.calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
