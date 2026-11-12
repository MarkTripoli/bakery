import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createDraftIsolation,
  DraftIsolationError,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import { DRAFT_LIMITS } from "../../apps/server/src/modules/knowledge/drafts.ts";
import { readDraftIsolationLauncher } from "../../packages/config/src/env.ts";
import {
  launcherCopy,
  type LauncherOptions,
} from "../helpers/draft-launcher.ts";

const fixture = (name: string) =>
  new URL(`../fixtures/draft-workers/${name}`, import.meta.url).pathname;

/** Runs `body` with an isolation that starts workers through a launcher copy. */
async function withLauncher<T>(
  options: LauncherOptions & { totalDeadlineMs?: number },
  body: (isolation: ReturnType<typeof createDraftIsolation>) => Promise<T>,
): Promise<T> {
  const copy = await launcherCopy(options);
  try {
    return await body(createDraftIsolation({
      launcher: "process",
      workerLauncherPath: copy.path,
      ...(options.totalDeadlineMs === undefined
        ? {}
        : { totalDeadlineMs: options.totalDeadlineMs }),
    }));
  } finally {
    await copy.cleanup();
  }
}

/** Shell lines that write the environment they run in to `file`. */
const record = (file: string) => `/usr/bin/env -0 > '${file}'`;

function variableNames(environ: string): string[] {
  return environ.split("\0").filter(Boolean).map((pair) =>
    pair.slice(0, pair.indexOf("="))
  );
}

// Set by a recording shell itself, never passed to it.
const SHELL_OWN = ["PWD", "SHLVL", "_"];

Deno.test("the process launcher runs the real worker and produces a draft candidate", async () => {
  await withLauncher({}, async (isolation) => {
    const candidate = await isolation.initialize("alpha target omega");
    assertEquals(candidate.text, "alpha target omega");
    assert(candidate.state.length > 0);
  });
});

Deno.test("process-launched workers that hang, exhaust memory, trap or flood are killed with a typed error", async () => {
  const cases = [
    ["timeout.ts", "timeout"],
    // The page cap refuses WebAssembly (Loro) memory growth at once.
    ["wasm-memory.ts", "unavailable"],
    ["trap.ts", "unavailable"],
    ["protocol-overflow.ts", "unavailable"],
  ] as const;
  for (const [name, kind] of cases) {
    await withLauncher({ workerPath: fixture(name) }, async (isolation) => {
      const started = performance.now();
      const error = await assertRejects(
        () => isolation.initialize("x"),
        DraftIsolationError,
      );
      assertEquals(error.kind, kind, `${name}: ${error.message}`);
      // The work budget from READY, plus start-up and the kill and reap.
      assert(
        performance.now() - started < DRAFT_LIMITS.workerRuntimeMs + 2_000,
        `${name} was not stopped within the deadline`,
      );
    });
  }
});

Deno.test("a worker whose JavaScript heap keeps growing is ended by its memory bounds", async () => {
  // Both the V8 old-space cap and RLIMIT_DATA apply; whichever fires first,
  // the worker must end by a memory bound (a crash exit, not a timeout) with
  // the deadline lifted. The V8 flag itself is pinned by the launcher unit
  // test.
  await withLauncher(
    { workerPath: fixture("heap.ts"), totalDeadlineMs: 60_000 },
    async (isolation) => {
      const error = await assertRejects(
        () => isolation.initialize("x"),
        DraftIsolationError,
      );
      assertEquals(error.kind, "unavailable", error.message);
      assert(error.message.startsWith("WORKER_EXIT_"), error.message);
    },
  );
});

Deno.test("off-heap memory is bounded too: an ArrayBuffer flood ends the worker", async () => {
  // Typed arrays live outside the V8 heap and WebAssembly caps; RLIMIT_DATA
  // set by the launcher must end this worker by itself, well before the time
  // bound (deadline lifted), not after it has allocated gigabytes.
  await withLauncher(
    { workerPath: fixture("memory.ts"), totalDeadlineMs: 30_000 },
    async (isolation) => {
      const started = performance.now();
      const error = await assertRejects(
        () => isolation.initialize("x"),
        DraftIsolationError,
      );
      assertEquals(error.kind, "unavailable", error.message);
      assert(error.message.startsWith("WORKER_EXIT_"), error.message);
      assert(performance.now() - started < 15_000, "not ended by the limit");
    },
  );
});

Deno.test("the launcher execs in place: the worker's parent is the server", async () => {
  // Without exec the shell would stay between them, and the kill timer would
  // end the shell while the worker kept running.
  const recorded = await Deno.makeTempDir({ prefix: "bakery-draft-pid-" });
  const stand = `${recorded}/deno`;
  await Deno.writeTextFile(
    stand,
    `#!/bin/sh\nprintf '%s' "$PPID" > '${recorded}/parent'\n`,
  );
  await Deno.chmod(stand, 0o700);
  const copy = await launcherCopy({ denoPath: stand });
  try {
    const { code } = await new Deno.Command(copy.path, {
      args: [crypto.randomUUID()],
      clearEnv: true,
    }).output();
    assertEquals(code, 0);
    assertEquals(
      await Deno.readTextFile(`${recorded}/parent`),
      String(Deno.pid),
    );
  } finally {
    await copy.cleanup();
    await Deno.remove(recorded, { recursive: true });
  }
});

Deno.test("a process-launched worker has no environment, file, subprocess, network, FFI or import access", async () => {
  await withLauncher(
    { workerPath: fixture("permissions.ts") },
    async (isolation) => {
      const error = await assertRejects(
        () => isolation.initialize("x"),
        DraftIsolationError,
      );
      // Exit 43: every probe was denied. 42 would mean one got through.
      assertEquals(error.message, "WORKER_EXIT_43");
    },
  );
});

Deno.test("a worker never writes the project lockfile", async () => {
  // A JSR import, even a denied one, resolves the package manifest; without
  // --frozen that records a redirect in deno.lock.
  const lock = new URL("../../deno.lock", import.meta.url);
  const before = await Deno.readFile(lock);
  try {
    await withLauncher(
      { workerPath: fixture("lock-probe.ts") },
      async (isolation) => {
        await assertRejects(
          () => isolation.initialize("x"),
          DraftIsolationError,
        );
      },
    );
    assertEquals(await Deno.readFile(lock), before, "deno.lock was written");
  } finally {
    // Undo a regression's write where this lane may write (it fails anyway).
    const after = await Deno.readFile(lock);
    if (
      after.length !== before.length || after.some((b, i) => b !== before[i])
    ) {
      await Deno.writeFile(lock, before).catch(() => {});
    }
  }
});

Deno.test("a missing launcher reports host isolation unavailable, not a crash", async () => {
  const isolation = createDraftIsolation({
    launcher: "process",
    workerLauncherPath: "/nonexistent/launch.sh",
  });
  const error = await assertRejects(
    () => isolation.initialize("x"),
    DraftIsolationError,
  );
  assertEquals(error.kind, "unavailable");
  assertEquals(error.message, "HOST_ISOLATION_UNAVAILABLE");
});

Deno.test("the server starts the launcher with an empty environment and one UUID", async () => {
  const canaryName = "BAKERY_DRAFT_SECRET_CANARY";
  const canary = `canary-${crypto.randomUUID()}`;
  const recorded = await Deno.makeTempDir({ prefix: "bakery-draft-env-" });
  Deno.env.set(canaryName, canary);
  try {
    await withLauncher(
      {
        prelude: `${
          record(`${recorded}/launcher-env`)
        }\nprintf '%s' "$*" > '${recorded}/launcher-args'`,
      },
      async (isolation) => {
        const candidate = await isolation.initialize("cleared");
        assertEquals(candidate.text, "cleared");
      },
    );
    const environ = await Deno.readTextFile(`${recorded}/launcher-env`);
    assert(!environ.includes(canary), "the server environment leaked");
    for (const name of variableNames(environ)) {
      assert(SHELL_OWN.includes(name), `the launcher was given ${name}`);
    }
    const args = await Deno.readTextFile(`${recorded}/launcher-args`);
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        args,
      ),
      `the launcher was given ${JSON.stringify(args)}`,
    );
  } finally {
    Deno.env.delete(canaryName);
    await Deno.remove(recorded, { recursive: true });
  }
});

Deno.test("the launcher hands the worker only its fixed variables, whatever it inherits", async () => {
  // Run the launcher directly with a polluted environment: what reaches
  // Deno must still be only the launcher's own fixed variables.
  const recorded = await Deno.makeTempDir({ prefix: "bakery-draft-env-" });
  const stand = `${recorded}/deno`;
  await Deno.writeTextFile(
    stand,
    `#!/bin/sh\n${record(`${recorded}/worker-env`)}\n`,
  );
  await Deno.chmod(stand, 0o700);
  const copy = await launcherCopy({ denoPath: stand });
  try {
    const output = await new Deno.Command(copy.path, {
      args: [crypto.randomUUID()],
      env: {
        BAKERY_DRAFT_SECRET_CANARY: "inherited-secret",
        DENO_AUTH_TOKENS: "x@example.com",
        DENO_V8_FLAGS: "--max-old-space-size=99999",
      },
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(output.code, 0);
    const environ = await Deno.readTextFile(`${recorded}/worker-env`);
    assert(!environ.includes("inherited-secret"), "inherited variable leaked");
    const names = variableNames(environ).filter((name) =>
      !SHELL_OWN.includes(name)
    ).sort();
    assertEquals(names, ["DENO_DIR", "HOME", "NO_COLOR"]);
  } finally {
    await copy.cleanup();
    await Deno.remove(recorded, { recursive: true });
  }
});

Deno.test("the launcher refuses anything but exactly one lower-case UUID", async () => {
  const copy = await launcherCopy({ denoPath: "/bin/false" });
  try {
    const uuid = crypto.randomUUID();
    for (
      const args of [
        [],
        ["eval"],
        [uuid, "extra"],
        [uuid.toUpperCase()],
        ["-".repeat(36)],
        ["00000000000000000000000000000000-000"],
        [`${uuid.slice(0, 7)}-${uuid.slice(7, 8)}${uuid.slice(9)}`],
        ["g".repeat(8) + uuid.slice(8)],
        ["eval", "console.log(1)"],
        ["../../etc/passwd-aaaa-bbbb-cccc-dddddddddddd"],
        [`${uuid}\n`],
      ]
    ) {
      const { code } = await new Deno.Command(copy.path, {
        args,
        clearEnv: true,
        stdout: "null",
        stderr: "null",
      }).output();
      assertEquals(code, 64, JSON.stringify(args));
    }
    // A valid id gets as far as the (stand-in) Deno, which exits 1.
    const valid = await new Deno.Command(copy.path, {
      args: [uuid],
      clearEnv: true,
    }).output();
    assertEquals(valid.code, 1);
  } finally {
    await copy.cleanup();
  }
});

Deno.test("the probe fixture is not blind: with every permission it reports access", async () => {
  // The fixture must see each capability when it is granted; otherwise exit
  // 43 above would prove nothing.
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--no-lock",
      "-A",
      fixture("permissions.ts"),
    ],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(output.code, 42);
  const reached = new TextDecoder().decode(output.stderr).split(",");
  for (
    const name of [
      "env",
      "read",
      "write",
      "run",
      "sys",
      "net-listen",
      "net-connect",
      "ffi",
      "import",
    ]
  ) {
    assert(reached.includes(name), `${name} not detected: ${reached}`);
  }
});

Deno.test("systemd stays the default launcher; only the two known values are accepted", () => {
  assertEquals(readDraftIsolationLauncher({}), "systemd");
  assertEquals(
    readDraftIsolationLauncher({ BAKERY_DRAFT_ISOLATION: "" }),
    "systemd",
  );
  assertEquals(
    readDraftIsolationLauncher({ BAKERY_DRAFT_ISOLATION: "process" }),
    "process",
  );
  assertThrows(() =>
    readDraftIsolationLauncher({ BAKERY_DRAFT_ISOLATION: "docker" })
  );
});
