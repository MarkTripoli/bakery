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
    ["memory.ts", "unavailable"],
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

Deno.test("a process-launched worker has no environment, file, subprocess or network access", async () => {
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
    prlimitPath: "/nonexistent/prlimit",
  });
  const error = await assertRejects(
    () => isolation.initialize("x"),
    DraftIsolationError,
  );
  assertEquals(error.kind, "unavailable");
  assertEquals(error.message, "HOST_ISOLATION_UNAVAILABLE");
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
