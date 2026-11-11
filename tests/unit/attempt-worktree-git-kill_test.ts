import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  defaultGitSpawn,
  type GitChild,
  type GitSpawn,
  runGit,
} from "../../apps/worker/src/attempt-worktree.ts";

// `git()` stopped a child with SIGTERM alone and then waited for it to exit. A
// child that traps SIGTERM was never stopped, so the call, and `addWorktree`
// with it, hung whatever its deadline said (seen once: 11 minutes). A stop now
// escalates: SIGTERM, a short grace period, SIGKILL, and a bounded wait.

type Output = { code: number; stdout: Uint8Array; stderr: Uint8Array };
const text = (value: string) => new TextEncoder().encode(value);

/** A child whose exit the test controls, and a log of what it was sent. */
function fakeChild(options: { exitsOn?: "SIGTERM" | "SIGKILL" } = {}) {
  const sent: Array<{ signal: string; at: number }> = [];
  const started = performance.now();
  let finish!: (output: Output) => void;
  const exited = new Promise<Output>((resolve) => {
    finish = resolve;
  });
  const child: GitChild = {
    kill(signal) {
      sent.push({ signal, at: performance.now() - started });
      if (options.exitsOn === signal) {
        finish({ code: 143, stdout: text(""), stderr: text("stopped") });
      }
    },
    output: () => exited,
  };
  const spawn: GitSpawn = () => child;
  return { spawn, sent, finish };
}

const limits = { killGraceMs: 60, exitWaitMs: 80 };

Deno.test("a child that exits on SIGTERM is not sent SIGKILL", async () => {
  const { spawn, sent } = fakeChild({ exitsOn: "SIGTERM" });
  const result = await runGit(spawn, "git", "/", [], 20, undefined, limits);
  assertEquals(result, { code: -1, stdout: "", stderr: "git deadline" });
  assertEquals(sent.map((entry) => entry.signal), ["SIGTERM"]);
});

Deno.test("a child that ignores SIGTERM is sent SIGKILL after the grace period", async () => {
  const { spawn, sent } = fakeChild({ exitsOn: "SIGKILL" });
  const started = performance.now();
  const result = await runGit(spawn, "git", "/", [], 20, undefined, limits);
  const elapsed = performance.now() - started;
  assertEquals(result, { code: -1, stdout: "", stderr: "git deadline" });
  assertEquals(sent.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  assert(
    sent[0].at >= 15,
    `SIGTERM came at ${sent[0].at}ms, before the deadline`,
  );
  assert(
    sent[1].at - sent[0].at >= limits.killGraceMs - 5,
    "SIGKILL must wait out the grace period",
  );
  assert(elapsed < 1000, `took ${elapsed}ms`);
});

Deno.test("a child that cannot be killed is waited for only a bounded time", async () => {
  const { spawn, sent } = fakeChild();
  const started = performance.now();
  const result = await runGit(spawn, "git", "/", [], 20, undefined, limits);
  const elapsed = performance.now() - started;
  assertEquals(result, { code: -1, stdout: "", stderr: "git deadline" });
  assertEquals(sent.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  // deadline + grace + exit wait, plus slack for timers under load
  assert(
    elapsed >= 20 + limits.killGraceMs + limits.exitWaitMs - 10,
    `${elapsed}ms`,
  );
  assert(elapsed < 1500, `${elapsed}ms: the wait for exit must be bounded`);
});

Deno.test("an abort signal stops the child the same way and reports aborted", async () => {
  const { spawn, sent } = fakeChild({ exitsOn: "SIGKILL" });
  const controller = new AbortController();
  const pending = runGit(
    spawn,
    "git",
    "/",
    [],
    60_000,
    controller.signal,
    limits,
  );
  controller.abort();
  assertEquals(await pending, "aborted");
  assertEquals(sent.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
});

Deno.test("a signal that is already aborted stops the child at once", async () => {
  const { spawn, sent } = fakeChild({ exitsOn: "SIGTERM" });
  const result = await runGit(
    spawn,
    "git",
    "/",
    [],
    60_000,
    AbortSignal.abort(),
    limits,
  );
  assertEquals(result, "aborted");
  assertEquals(sent.map((entry) => entry.signal), ["SIGTERM"]);
});

Deno.test("a child that finishes in time returns its output and is never signalled", async () => {
  const { spawn, sent, finish } = fakeChild();
  const pending = runGit(spawn, "git", "/", [], 60_000, undefined, limits);
  finish({ code: 0, stdout: text("out"), stderr: text("err") });
  assertEquals(await pending, { code: 0, stdout: "out", stderr: "err" });
  assertEquals(sent, []);
});

Deno.test("a failure to start is thrown, not turned into a deadline", async () => {
  const spawn: GitSpawn = () => ({
    kill: () => {},
    output: () => Promise.reject(new Error("spawn failed")),
  });
  await assertRejects(
    () => runGit(spawn, "git", "/", [], 60_000, undefined, limits),
    Error,
    "spawn failed",
  );
});

Deno.test("a kill that throws because the process is already gone changes nothing", async () => {
  let finish!: (output: Output) => void;
  const exited = new Promise<Output>((resolve) => {
    finish = resolve;
  });
  const spawn: GitSpawn = () => ({
    kill: () => {
      finish({ code: 0, stdout: text(""), stderr: text("") });
      throw new Error("no such process");
    },
    output: () => exited,
  });
  const result = await runGit(spawn, "git", "/", [], 10, undefined, limits);
  assertEquals(result, { code: -1, stdout: "", stderr: "git deadline" });
});

/**
 * Runs `work` and reports how many timers it started and left running. The
 * test runner's own leak detector does not catch these here, and a timer that
 * outlives the call keeps the worker's event loop busy for as long as it asks.
 */
async function leftRunning(work: () => Promise<unknown>): Promise<number> {
  const live = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const id: unknown = realSet(() => {
      live.delete(id);
      handler();
    }, ms);
    live.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    live.delete(id);
    realClear(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  try {
    await work();
    return live.size;
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    for (const id of live) realClear(id as ReturnType<typeof setTimeout>);
  }
}

Deno.test("no timer is left running by any way a call can end", async () => {
  const scenarios: Record<string, () => Promise<unknown>> = {
    "finishes in time": () => {
      const { spawn, finish } = fakeChild();
      const pending = runGit(spawn, "git", "/", [], 60_000, undefined, limits);
      finish({ code: 0, stdout: text(""), stderr: text("") });
      return pending;
    },
    "stopped, exits on SIGTERM": () => {
      const { spawn } = fakeChild({ exitsOn: "SIGTERM" });
      return runGit(spawn, "git", "/", [], 10, undefined, {
        killGraceMs: 60_000,
        exitWaitMs: 60_000,
      });
    },
    "stopped, needs SIGKILL": () => {
      const { spawn } = fakeChild({ exitsOn: "SIGKILL" });
      return runGit(spawn, "git", "/", [], 10, undefined, {
        killGraceMs: 20,
        exitWaitMs: 60_000,
      });
    },
    "stopped, never exits": () => {
      const { spawn } = fakeChild();
      return runGit(spawn, "git", "/", [], 10, undefined, {
        killGraceMs: 20,
        exitWaitMs: 20,
      });
    },
    "aborted by a signal": () => {
      const { spawn } = fakeChild({ exitsOn: "SIGTERM" });
      const controller = new AbortController();
      const pending = runGit(
        spawn,
        "git",
        "/",
        [],
        60_000,
        controller.signal,
        { killGraceMs: 60_000, exitWaitMs: 60_000 },
      );
      controller.abort();
      return pending;
    },
    "fails to start": () => {
      const spawn: GitSpawn = () => ({
        kill: () => {},
        output: () => Promise.reject(new Error("spawn failed")),
      });
      return runGit(spawn, "git", "/", [], 60_000, undefined, limits).catch(
        () => undefined,
      );
    },
  };
  for (const [name, work] of Object.entries(scenarios)) {
    assertEquals(await leftRunning(work), 0, `${name}: timers left running`);
  }
});

/** True while the process exists, by `kill -0`. */
async function alive(pid: string): Promise<boolean> {
  const { success } = await new Deno.Command("/usr/bin/kill", {
    args: ["-0", pid],
    stdout: "null",
    stderr: "null",
  }).output();
  return success;
}

Deno.test("a real child that traps SIGTERM is killed and the call returns", async () => {
  const dir = await Deno.makeTempDir({ prefix: "git-kill-" });
  const script =
    `process.on("SIGTERM", () => {}); require("fs").writeFileSync("pid", String(process.pid)); setInterval(() => {}, 1000);`;
  const controller = new AbortController();
  let pid = "";
  try {
    const pending = runGit(
      defaultGitSpawn,
      "node",
      dir,
      ["-e", script],
      60_000,
      controller.signal,
      { killGraceMs: 150, exitWaitMs: 3000 },
    );
    // Stop only once the handler is installed, whatever the host load.
    for (let waited = 0; pid === "" && waited < 10_000; waited += 25) {
      try {
        pid = (await Deno.readTextFile(`${dir}/pid`)).trim();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert(pid !== "", "the child never started");
    assert(await alive(pid), "the child should be running before the stop");
    controller.abort();
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<"hung">((resolve) => {
      guardTimer = setTimeout(() => resolve("hung"), 8000);
    });
    const outcome = await Promise.race([pending, guard]);
    clearTimeout(guardTimer);
    assertEquals(outcome, "aborted", "the call must return, not hang");
    assertEquals(await alive(pid), false, "the child must be dead");
  } finally {
    if (pid !== "" && await alive(pid)) {
      await new Deno.Command("/usr/bin/kill", { args: ["-9", pid] }).output();
    }
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});
