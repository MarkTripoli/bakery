// The `link` command (#70) against a fake Bakery and a fake terminal: the
// design's terminal text verbatim, both paths (a code in the command, and a
// code an Admin approves), and every case where it stops.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_ERRORS,
  type LinkIo,
  LinkStepFailed,
  parseLinkCommand,
  type RegisteredHost,
  runLink,
} from "../../packages/worker-bootstrap/src/index.ts";
import { startLinkedService } from "../../packages/worker-bootstrap/src/service-start.ts";

const SERVER = "https://bakery.example";
const CODE = "K7QM-2XPD";
const NOW = new Date("2026-11-21T12:00:00.000Z");
const EXPIRES = "2026-11-21T12:07:30.000Z";

type Reply = { status: number; body?: unknown };
type Call = { path: string; body: Record<string, unknown> };

function preview(overrides: Record<string, unknown> = {}) {
  return {
    organizationName: "Fixture Org",
    name: "build-box-01",
    slots: 2,
    capabilities: ["claude"],
    supported: true,
    supportedSystems: [{ os: "linux", architecture: "arm64" }],
    expiresAt: EXPIRES,
    ...overrides,
  };
}

async function harness(options: {
  routes: Record<string, Reply[]>;
  answer?: string;
  isTerminal?: boolean;
  platform?: string;
  arch?: string;
  install?: () => Promise<void>;
  startService?: () => Promise<void>;
  registeredHost?: RegisteredHost;
}) {
  const root = await mkdtemp(join(tmpdir(), "bakery-link-"));
  const out: string[] = [];
  const calls: Call[] = [];
  const asked: string[] = [];
  const events: string[] = [];
  const fetch = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assertEquals(url.origin, SERVER);
    const path = url.pathname.replace(/[0-9a-f-]{36}/, "{id}");
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    const queue = options.routes[path];
    const reply = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!reply) return Promise.reject(new Error(`unexpected ${path}`));
    return Promise.resolve(
      new Response(
        reply.body === undefined ? null : JSON.stringify(reply.body),
        {
          status: reply.status,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  }) as unknown as typeof globalThis.fetch;
  const io: LinkIo = {
    isTerminal: options.isTerminal ?? true,
    ask: (question) => {
      asked.push(question);
      out.push(question + (options.answer ?? "y") + "\n");
      return Promise.resolve(options.answer ?? "y");
    },
    waitForEnter: () => {
      events.push("enter");
      return Promise.resolve();
    },
    write: (text) => void out.push(text),
    fetch,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    machine: {
      platform: options.platform ?? "linux",
      arch: options.arch ?? "arm64",
      hostname: "build-box-01",
    },
    install: options.install ?? (() => {
      events.push("install");
      return Promise.resolve();
    }),
    startService: options.startService ?? ((_binding, _root, repairOf) => {
      events.push(repairOf === null ? "service" : `repair:${repairOf}`);
      return Promise.resolve();
    }),
    registeredHost: () =>
      Promise.resolve(options.registeredHost ?? { kind: "none" }),
  };
  return {
    root,
    io,
    calls,
    asked,
    events,
    text: () => out.join(""),
    async run(code: string | null = CODE) {
      return await runLink({ server: SERVER, code, root }, io);
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

const HOST = "11111111-1111-4111-8111-111111111111";
const INSPECT = "/v1/worker/link-code-inspection";

Deno.test("with a code: the summary, one question, then the ticks", async () => {
  const h = await harness({
    routes: {
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 200, body: preview() },
        { status: 409, body: { code: "STATE_CONFLICT", reason: "used" } },
      ],
    },
  });
  try {
    assertEquals(await h.run(), 0);
    assertEquals(
      h.text(),
      [
        "Bakery worker · link this machine",
        "",
        "  Organization   Fixture Org",
        "  Machine        build-box-01",
        "  Tasks at once  2",
        "  Coding agent   Claude Code",
        "  This computer  Linux arm64",
        "",
        "This installs the worker, adds the service bakery-worker",
        "(asks for your password once) and starts it.",
        "",
        "Link this machine? [y/N] y",
        "",
        "✓ Installed",
        "✓ Service started",
        "✓ Connected to Bakery",
        "",
        "build-box-01 is linked. One thing left, in Bakery: sign in to Claude Code.",
        "",
      ].join("\n"),
    );
    assertEquals(h.asked, ["Link this machine? [y/N] "]);
    assertEquals(h.events, ["install", "service"]);
    assertEquals(h.calls[0]!.body, {
      linkCode: CODE,
      os: "linux",
      architecture: "arm64",
      hostname: "build-box-01",
    });
    // The code is kept for the worker in an owner-only file, never in the binding.
    const codeFile = join(h.root, "enrollment-token");
    assertEquals((await readFile(codeFile, "utf8")).trim(), CODE);
    assertEquals((await stat(codeFile)).mode & 0o077, 0);
    const binding = await readFile(join(h.root, "pairing.json"), "utf8");
    assertEquals(binding.includes(CODE), false);
    assertEquals(JSON.parse(binding).name, "build-box-01");
  } finally {
    await h.close();
  }
});

Deno.test("answering n installs nothing and says how long the command works", async () => {
  const h = await harness({
    answer: "n",
    routes: { [INSPECT]: [{ status: 200, body: preview() }] },
  });
  try {
    assertEquals(await h.run(), 1);
    assert(
      h.text().endsWith(
        "Nothing was installed. The command still works for 7 minutes.\n",
      ),
    );
    assertEquals(h.events, []);
  } finally {
    await h.close();
  }
});

for (
  const [name, reply, expected] of [
    [
      "expired",
      { status: 409, body: { reason: "expired" } },
      "This command expired. They work for 10 minutes. Get a new one: https://bakery.example/machines/new\n",
    ],
    [
      "unknown",
      { status: 404, body: { reason: "not_found" } },
      "Bakery does not know this code. Copy the command again from Add a machine.\n",
    ],
    [
      "used",
      { status: 409, body: { reason: "used" } },
      "This command was already used. Each one works once.\n",
    ],
  ] as const
) {
  Deno.test(`a code that is ${name} stops before anything is installed`, async () => {
    const h = await harness({ routes: { [INSPECT]: [reply] } });
    try {
      assertEquals(await h.run(), 2);
      assertEquals(h.text(), expected);
      assertEquals(h.events, []);
    } finally {
      await h.close();
    }
  });
}

Deno.test("an unsupported system stops and names what is supported", async () => {
  const h = await harness({
    platform: "darwin",
    arch: "arm64",
    routes: {
      [INSPECT]: [{ status: 200, body: preview({ supported: false }) }],
    },
  });
  try {
    assertEquals(await h.run(), 2);
    assertEquals(
      h.text(),
      "Bakery does not support macOS arm64 yet. Nothing was installed. Supported today: Linux arm64.\n",
    );
    assertEquals(h.calls.length, 1);
    assertEquals(h.calls[0]!.body.os, "macos");
  } finally {
    await h.close();
  }
});

Deno.test("with no terminal to answer in, nothing is asked or installed", async () => {
  const h = await harness({ isTerminal: false, routes: {} });
  try {
    assertEquals(await h.run(), 2);
    assertEquals(h.text(), "Run this in a terminal: it asks one question.\n");
    assertEquals(h.calls, []);
  } finally {
    await h.close();
  }
});

Deno.test("a computer already linked is not changed", async () => {
  const h = await harness({
    routes: {
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 409, body: { reason: "used" } },
      ],
    },
  });
  try {
    assertEquals(await h.run(), 0);
    const second = await harness({
      routes: { [INSPECT]: [{ status: 200, body: preview() }] },
    });
    try {
      const again = await runLink(
        { server: SERVER, code: "AAAA-BBBB", root: h.root },
        second.io,
      );
      assertEquals(again, 0);
      assertEquals(
        second.text(),
        "This computer is already linked to Fixture Org as build-box-01. Nothing was changed.\n",
      );
      assertEquals(second.calls.map((call) => call.path), [INSPECT]);
      assertEquals(second.events, []);
      const withoutCode = await runLink(
        { server: SERVER, code: null, root: h.root },
        second.io,
      );
      assertEquals(withoutCode, 0);
      assertEquals(
        second.calls.length,
        1,
        "no code: nothing is asked of Bakery",
      );
    } finally {
      await second.close();
    }
  } finally {
    await h.close();
  }
});

const THIS_HOST = "6c1f0c1e-4b0e-4c55-9a59-3c3e8f6b1a01";
const OTHER_HOST = "0b2d6f43-5c1e-4f8e-8d2a-7e9a1c4b2f02";
const known = (workerHostId: string): RegisteredHost => ({
  kind: "known",
  workerHostId,
});

Deno.test("after a failed service step, running the same command again adds the service", async () => {
  let failures = 1;
  const h = await harness({
    routes: {
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 200, body: preview() },
        { status: 200, body: preview() },
        { status: 409, body: { reason: "used" } },
      ],
    },
    startService: () => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(
          new LinkStepFailed(
            "The service could not be added.",
            "/tmp/service.log",
          ),
        );
      }
      h.events.push("service");
      return Promise.resolve();
    },
  });
  try {
    assertEquals(await h.run(), 2);
    assert(h.text().includes("Fix it, then run the same command again."));
    await assertRejects(() => stat(join(h.root, "pairing.json")));
    await assertRejects(() => stat(join(h.root, "enrollment-token")));
    assertEquals(await h.run(), 0, h.text());
    assert(h.events.includes("service"));
    assert(!h.text().includes("already linked"));
  } finally {
    await h.close();
  }
});

Deno.test("a repair code for this machine re-links it: new pairing and code, the old registration dropped", async () => {
  const h = await harness({
    routes: {
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 409, body: { reason: "used" } },
      ],
    },
  });
  try {
    assertEquals(await h.run(), 0);
    const repair = await harness({
      registeredHost: { kind: "known", workerHostId: THIS_HOST },
      routes: {
        [INSPECT]: [
          { status: 200, body: preview({ repairsWorkerHostId: THIS_HOST }) },
          { status: 409, body: { reason: "used" } },
        ],
      },
    });
    try {
      const again = await runLink(
        { server: SERVER, code: "AAAA-BBBB", root: h.root },
        repair.io,
      );
      assertEquals(again, 0, repair.text());
      assertEquals(repair.events, ["install", `repair:${THIS_HOST}`]);
      assertEquals(
        (await readFile(join(h.root, "enrollment-token"), "utf8")).trim(),
        "AAAA-BBBB",
      );
      assert(repair.text().includes("Link this machine? [y/N] "));
    } finally {
      await repair.close();
    }
  } finally {
    await h.close();
  }
});

Deno.test("a linked computer refuses a repair code for any other machine, even one of the same name", async () => {
  const h = await harness({
    routes: {
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 409, body: { reason: "used" } },
      ],
    },
  });
  try {
    assertEquals(await h.run(), 0);
    for (
      const [registeredHost, body] of [
        [known(THIS_HOST), preview({ repairsWorkerHostId: OTHER_HOST })],
        [known(THIS_HOST), preview({ repairsWorkerHostId: null })],
        [{ kind: "none" }, preview({ repairsWorkerHostId: THIS_HOST })],
        [
          known(THIS_HOST),
          preview({
            repairsWorkerHostId: THIS_HOST,
            organizationName: "Other Org",
          }),
        ],
      ] as const
    ) {
      const other = await harness({
        registeredHost,
        routes: { [INSPECT]: [{ status: 200, body }] },
      });
      try {
        assertEquals(
          await runLink(
            { server: SERVER, code: "CCCC-DDDD", root: h.root },
            other.io,
          ),
          0,
        );
        assertEquals(other.events, []);
        assertEquals(
          other.text(),
          "This computer is already linked to Fixture Org as build-box-01. Nothing was changed.\n",
        );
      } finally {
        await other.close();
      }
    }
  } finally {
    await h.close();
  }
});

Deno.test("on a linked computer an expired or mistyped code says so, not that it is linked", async () => {
  const h = await harness({
    routes: {
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 409, body: { reason: "used" } },
      ],
    },
  });
  try {
    assertEquals(await h.run(), 0);
    for (
      const reply of [
        { status: 409, body: { code: "STATE_CONFLICT", reason: "expired" } },
        { status: 404, body: { code: "RESOURCE_NOT_FOUND" } },
      ]
    ) {
      const other = await harness({ routes: { [INSPECT]: [reply] } });
      try {
        assertEquals(
          await runLink(
            { server: SERVER, code: "EEEE-FFFF", root: h.root },
            other.io,
          ),
          2,
        );
        assert(!other.text().includes("already linked"), other.text());
        assertEquals(other.events, []);
      } finally {
        await other.close();
      }
    }
  } finally {
    await h.close();
  }
});

Deno.test("rerunning the used command on a linked computer says it is linked", async () => {
  const h = await harness({
    routes: {
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 409, body: { reason: "used" } },
      ],
    },
  });
  try {
    assertEquals(await h.run(), 0);
    const again = await harness({
      routes: {
        [INSPECT]: [{
          status: 409,
          body: { code: "STATE_CONFLICT", reason: "used" },
        }],
      },
    });
    try {
      assertEquals(
        await runLink({ server: SERVER, code: CODE, root: h.root }, again.io),
        0,
      );
      assertEquals(
        again.text(),
        "This computer is already linked to Fixture Org as build-box-01. Nothing was changed.\n",
      );
    } finally {
      await again.close();
    }
  } finally {
    await h.close();
  }
});

Deno.test("a Linux machine running the service passes the repair to the service step", async () => {
  const h = await harness({
    routes: {
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 409, body: { reason: "used" } },
      ],
    },
  });
  try {
    assertEquals(await h.run(), 0);
    const repair = await harness({
      registeredHost: { kind: "in-service" },
      routes: {
        [INSPECT]: [
          { status: 200, body: preview({ repairsWorkerHostId: THIS_HOST }) },
          { status: 409, body: { reason: "used" } },
        ],
      },
    });
    try {
      assertEquals(
        await runLink(
          { server: SERVER, code: "AAAA-BBBB", root: h.root },
          repair.io,
        ),
        0,
        repair.text(),
      );
      assertEquals(repair.events, ["install", `repair:${THIS_HOST}`]);
    } finally {
      await repair.close();
    }
  } finally {
    await h.close();
  }
});

Deno.test("a failed repair keeps this computer's link as it was", async () => {
  const h = await harness({
    routes: {
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 409, body: { reason: "used" } },
      ],
    },
  });
  try {
    assertEquals(await h.run(), 0);
    const before = await readFile(join(h.root, "pairing.json"), "utf8");
    const repair = await harness({
      registeredHost: { kind: "in-service" },
      routes: {
        [INSPECT]: [{
          status: 200,
          body: preview({ repairsWorkerHostId: OTHER_HOST }),
        }],
      },
      startService: () =>
        Promise.reject(
          new LinkStepFailed(
            "This repair command is for another machine. The service was not changed.",
            "/tmp/service.log",
          ),
        ),
    });
    try {
      assertEquals(
        await runLink(
          { server: SERVER, code: "AAAA-BBBB", root: h.root },
          repair.io,
        ),
        2,
      );
      assert(repair.text().includes("for another machine"));
      assertEquals(
        (await readFile(join(h.root, "enrollment-token"), "utf8")).trim(),
        CODE,
      );
      assertEquals(
        JSON.parse(await readFile(join(h.root, "pairing.json"), "utf8")).name,
        JSON.parse(before).name,
      );
    } finally {
      await repair.close();
    }
  } finally {
    await h.close();
  }
});

Deno.test("a macOS repair whose agent starts but never connects can be repaired again with the next code", async () => {
  const mac = { supportedSystems: [{ os: "macos", architecture: "arm64" }] };
  let bootstraps = 0;
  const first = await harness({
    platform: "darwin",
    routes: {
      [INSPECT]: [{ status: 200, body: preview(mac) }, {
        status: 409,
        body: { reason: "used" },
      }],
    },
  });
  const registered = join(first.root, "state", "registration.json");
  try {
    assertEquals(await first.run(), 0, first.text());
    await mkdir(join(first.root, "state"), { recursive: true });
    await writeFile(registered, JSON.stringify({ workerHostId: HOST }));
    for (const attempt of [1, 2]) {
      const h = await harness({
        platform: "darwin",
        routes: {
          [INSPECT]: [{
            status: 200,
            body: preview({ ...mac, repairsWorkerHostId: HOST }),
          }, { status: 200, body: preview(mac) }],
        },
      });
      const io: LinkIo = {
        ...h.io,
        registeredHost: async () => {
          for (
            const path of [
              registered,
              join(first.root, "state", "registration.before-repair.json"),
            ]
          ) {
            try {
              return {
                kind: "known",
                workerHostId:
                  JSON.parse(await readFile(path, "utf8")).workerHostId,
              };
            } catch {
              continue;
            }
          }
          return { kind: "none" };
        },
        startService: (binding, root, repairOf) =>
          startLinkedService(binding, {
            target: "macos",
            root,
            home: first.root,
            uid: 501,
            username: "ana",
          }, {
            run: (argv: readonly string[]) =>
              Promise.resolve(
                argv.includes("bootstrap") && ++bootstraps < 0 ? 1 : 0,
              ),
            writeFile: () => Promise.resolve(),
            makeDirectory: () => Promise.resolve(),
            remove: (path: string) => rm(path, { force: true }),
            move: (from: string, to: string) => rename(from, to),
            exists: (path: string) => stat(path).then(() => true, () => false),
          }, repairOf),
      };
      const code = await runLink({
        server: SERVER,
        code: "AAAA-BBBB",
        root: first.root,
      }, io);
      assertEquals(code, 1, h.text());
      assert(h.text().includes("Link this machine? [y/N] "), h.text());
      assert(!h.text().includes("already linked"), h.text());
      assert(
        h.text().includes("Bakery has not seen this machine yet"),
        "the agent started but never connected",
      );
      assertEquals(bootstraps, attempt);
      await h.close();
    }
    assert(
      await stat(join(first.root, "state", "registration.before-repair.json"))
        .then(() => true, () => false),
      "the set-aside registration is kept for the next repair",
    );
  } finally {
    await first.close();
  }
});

Deno.test("a failed install says what failed, where the log is, and to rerun", async () => {
  const h = await harness({
    routes: { [INSPECT]: [{ status: 200, body: preview() }] },
    install: () =>
      Promise.reject(
        new LinkStepFailed(
          "The worker could not be installed.",
          "/var/log/bakery-worker.log",
        ),
      ),
  });
  try {
    assertEquals(await h.run(), 2);
    assert(
      h.text().endsWith(
        "The worker could not be installed.\nNothing else was changed.\nThe log is in /var/log/bakery-worker.log.\nFix it, then run the same command again.\n",
      ),
    );
  } finally {
    await h.close();
  }
});

const CREATE = "/v1/worker/link-requests";
const POLL = "/v1/worker/link-requests/{id}/polls";
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
function created(userCode = CODE) {
  return {
    status: 201,
    body: {
      requestId: REQUEST_ID,
      userCode,
      deviceSecret: "device-secret-kept-here",
      expiresAt: "2026-11-21T12:10:00.000Z",
      pollIntervalSeconds: 5,
    },
  };
}

Deno.test("with no code: prints the code to approve, waits, then links", async () => {
  const h = await harness({
    routes: {
      [CREATE]: [created()],
      [POLL]: [
        { status: 200, body: { state: "pending" } },
        { status: 200, body: { state: "approved", linkCode: "ABCD-EFGH" } },
      ],
      [INSPECT]: [
        { status: 200, body: preview() },
        { status: 409, body: { reason: "used" } },
      ],
    },
  });
  try {
    assertEquals(await h.run(null), 0);
    assert(
      h.text().startsWith(
        [
          "Nothing is installed yet. Ask a Bakery administrator to approve this code:",
          "",
          "  K7QM-2XPD",
          "",
          "  https://bakery.example/machines/link   (opens on any device)",
          "",
          "Waiting for approval… 10 minutes left.",
          "",
        ].join("\n"),
      ),
    );
    assert(h.text().includes("✓ Connected to Bakery"));
    assertEquals(
      h.calls.filter((call) => call.path === POLL).map((call) => call.body),
      [{ deviceSecret: "device-secret-kept-here" }, {
        deviceSecret: "device-secret-kept-here",
      }],
    );
    assertEquals(
      h.calls.find((call) => call.path === INSPECT)!.body.linkCode,
      "ABCD-EFGH",
    );
  } finally {
    await h.close();
  }
});

Deno.test("with no code: a decline stops, and Enter asks again after expiry", async () => {
  const declined = await harness({
    routes: {
      [CREATE]: [created()],
      [POLL]: [{ status: 200, body: { state: "declined" } }],
    },
  });
  try {
    assertEquals(await declined.run(null), 1);
    assert(
      declined.text().endsWith(
        "An administrator declined. Nothing was installed.\n",
      ),
    );
    assertEquals(declined.events, []);
  } finally {
    await declined.close();
  }
  const expired = await harness({
    routes: {
      [CREATE]: [created(), created("WXYZ-2345")],
      [POLL]: [
        { status: 200, body: { state: "expired" } },
        { status: 200, body: { state: "declined" } },
      ],
    },
  });
  try {
    assertEquals(await expired.run(null), 1);
    assertEquals(expired.events, ["enter"]);
    assert(
      expired.text().includes(
        "The code K7QM-2XPD expired. Codes work for 10 minutes. Nothing was installed. Press Enter for a new code.\n",
      ),
    );
    assert(expired.text().includes("  WXYZ-2345\n"));
  } finally {
    await expired.close();
  }
});

Deno.test("link takes no token flag or token environment", () => {
  for (
    const argv of [["link", "--server", SERVER, "--token", "x"], [
      "link",
      "--server",
      SERVER,
      "--token-file",
      "/tmp/x",
    ]]
  ) {
    let refused = "";
    try {
      parseLinkCommand(argv, {}, { root: "/r" });
    } catch (error) {
      refused = (error as { code?: string }).code ?? "";
    }
    assertEquals(refused, "COMMAND_LINK_TOKEN_SHORTCUT");
  }
  // The refusal names only what link accepts.
  const message = BOOTSTRAP_ERRORS.COMMAND_LINK_TOKEN_SHORTCUT;
  assertEquals(message.includes("--token-file"), false);
  assertEquals(message.includes("--token-fd"), false);
  assertEquals(message.includes("--code"), true);
  let environment = "";
  try {
    parseLinkCommand(["link", "--server", SERVER], {
      BAKERY_WORKER_ENROLLMENT_TOKEN: "x",
    }, { root: "/r" });
  } catch (error) {
    environment = (error as { code?: string }).code ?? "";
  }
  assertEquals(environment, "COMMAND_LINK_TOKEN_SHORTCUT");
  assertEquals(
    parseLinkCommand(["link", "--server", SERVER, "--code", CODE], {}, {
      root: "/r",
    }),
    { server: SERVER, code: CODE, root: "/r" },
  );
});
