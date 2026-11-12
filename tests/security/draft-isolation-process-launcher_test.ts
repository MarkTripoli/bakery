import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createDraftIsolation,
  DraftIsolationError,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";
import { readDraftIsolationLauncher } from "../../packages/config/src/env.ts";

const fixture = (name: string) =>
  new URL(`../fixtures/draft-workers/${name}`, import.meta.url).pathname;

Deno.test("the process launcher runs the real worker and produces a draft candidate", async () => {
  const isolation = createDraftIsolation({ launcher: "process" });
  const candidate = await isolation.initialize("alpha target omega");
  assertEquals(candidate.text, "alpha target omega");
  assert(candidate.state.length > 0);
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
    const isolation = createDraftIsolation({
      launcher: "process",
      workerPath: fixture(name),
    });
    const started = performance.now();
    const error = await assertRejects(
      () => isolation.initialize("x"),
      DraftIsolationError,
    );
    assertEquals(error.kind, kind, `${name}: ${error.message}`);
    assert(
      performance.now() - started < 3_000,
      `${name} was not stopped within the deadline`,
    );
  }
});

Deno.test("the V8 heap cap alone ends a worker that outgrows it", async () => {
  // Near the cap V8 spends its time collecting, so at the normal deadline the
  // time bound ends this worker first. With the deadline lifted, the heap cap
  // must end it by itself: a fatal out-of-memory exit, not a timeout.
  const isolation = createDraftIsolation({
    launcher: "process",
    workerPath: fixture("heap.ts"),
    totalDeadlineMs: 60_000,
  });
  const error = await assertRejects(
    () => isolation.initialize("x"),
    DraftIsolationError,
  );
  assertEquals(error.kind, "unavailable", error.message);
  assert(error.message.startsWith("WORKER_EXIT_"), error.message);
});

Deno.test("a process-launched worker has no environment, file, subprocess, network, FFI or import access", async () => {
  const isolation = createDraftIsolation({
    launcher: "process",
    workerPath: fixture("permissions.ts"),
  });
  const error = await assertRejects(
    () => isolation.initialize("x"),
    DraftIsolationError,
  );
  // Exit 43: every probe was denied. 42 would mean one got through.
  assertEquals(error.message, "WORKER_EXIT_43");
});

Deno.test("a missing launcher reports host isolation unavailable, not a crash", async () => {
  const isolation = createDraftIsolation({
    launcher: "process",
    denoPath: "/nonexistent/deno",
  });
  const error = await assertRejects(
    () => isolation.initialize("x"),
    DraftIsolationError,
  );
  assertEquals(error.kind, "unavailable");
  assertEquals(error.message, "HOST_ISOLATION_UNAVAILABLE");
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

Deno.test("a process-launched worker starts with a cleared environment", async () => {
  const canaryName = "BAKERY_DRAFT_SECRET_CANARY";
  const canary = `canary-${crypto.randomUUID()}`;
  Deno.env.set(canaryName, canary);
  const workerPath = fixture("hold.ts");
  try {
    const isolation = createDraftIsolation({ launcher: "process", workerPath });
    const pending = isolation.initialize("x").catch((error) => error);
    let environ: string | undefined;
    const deadline = Date.now() + 1_500;
    while (environ === undefined && Date.now() < deadline) {
      for await (const entry of Deno.readDir("/proc")) {
        if (!/^\d+$/.test(entry.name)) continue;
        try {
          const cmdline = await Deno.readTextFile(
            `/proc/${entry.name}/cmdline`,
          );
          if (!cmdline.includes(workerPath)) continue;
          environ = await Deno.readTextFile(`/proc/${entry.name}/environ`);
          break;
        } catch {
          // Exited or not ours.
        }
      }
      if (environ === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const error = await pending;
    assert(error instanceof DraftIsolationError);
    assertEquals(error.kind, "timeout");
    assert(environ !== undefined, "worker process not observed");
    const names = environ.split("\0").filter(Boolean).map((pair) =>
      pair.slice(0, pair.indexOf("="))
    );
    assert(!environ.includes(canary), "the server environment leaked");
    for (const name of names) {
      assert(
        ["DENO_DIR", "HOME", "XDG_CACHE_HOME", "NO_COLOR"].includes(name),
        `unexpected variable ${name}`,
      );
    }
  } finally {
    Deno.env.delete(canaryName);
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
