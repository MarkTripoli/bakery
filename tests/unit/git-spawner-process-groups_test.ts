import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { defaultGitSpawn, runGit } from "../../apps/worker/src/git-process.ts";
import { boundedGit } from "../../apps/worker/src/reviewer.ts";
import {
  type GroupSignal,
  signalProcessGroup,
  spawnInOwnProcessGroup,
} from "../../apps/worker/src/process-group.ts";
import type { startGitProcess } from "../../apps/worker/src/git-process.ts";
import { runHarnessGit } from "../../apps/worker/src/harness-common.ts";

// Every place the worker starts git has to end a call on schedule and leave
// nothing behind, whatever the child does. A child that traps SIGTERM was never
// stopped by the abort signal alone, and git's own children (hooks, credential
// helpers, remote transports) are not the child, so killing the child leaves
// them. These cases use a real child standing in for git: it traps SIGTERM and
// starts a grandchild, and each case then checks that both are gone.

const limits = { killGraceMs: 150, exitWaitMs: 3000 };

/** Behaviours of the stand-in: who traps SIGTERM and what the grandchild inherits. */
type Mode =
  | "both-trap"
  | "leader-exits-grandchild-traps-ignored-stdio"
  | "leader-exits-grandchild-traps-inherited-stdio";

const standIn = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [dir, mode] = process.argv.slice(1);
const trap = () => process.on("SIGTERM", () => {});
const idle = "setInterval(() => {}, 1000);";
const grandchild = [
  'const fs = require("node:fs");',
  'process.on("SIGTERM", () => {});',
  'fs.writeFileSync(process.argv[1] + "/grandchild.pid", String(process.pid));',
  idle,
].join("\\n");
if (mode === "both-trap") trap();
spawn(process.execPath, ["-e", grandchild, dir], {
  stdio: mode === "leader-exits-grandchild-traps-ignored-stdio" ? "ignore" : "inherit",
});
fs.writeFileSync(dir + "/leader.pid", String(process.pid));
process.stdout.write("started\\n");
setInterval(() => {}, 1000);
`;

function args(dir: string, mode: Mode): string[] {
  return ["-e", standIn, dir, mode];
}

async function readPid(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

/** Both processes are up, and the grandchild has installed its handler. */
async function started(
  dir: string,
): Promise<{ leader: string; grandchild: string }> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const leader = await readPid(`${dir}/leader.pid`);
    const grandchild = await readPid(`${dir}/grandchild.pid`);
    if (leader !== "" && grandchild !== "") return { leader, grandchild };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the stand-in never started");
}

function alive(pid: string): boolean {
  // /usr/bin/kill is on the unit lane's run grant; process.kill is not.
  return spawnSync("/usr/bin/kill", ["-0", pid], { stdio: "ignore" })
    .status === 0;
}

/** Waits briefly for a process the kernel is still reaping. */
async function gone(pid: string): Promise<boolean> {
  for (let waited = 0; waited < 3000; waited += 25) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function withDirectory<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "git-group-"));
  try {
    return await work(dir);
  } finally {
    for (const name of ["leader.pid", "grandchild.pid"]) {
      const pid = await readPid(`${dir}/${name}`);
      if (pid !== "" && alive(pid)) {
        spawnSync("/usr/bin/kill", ["-9", pid], { stdio: "ignore" });
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const modes: Mode[] = [
  "both-trap",
  "leader-exits-grandchild-traps-ignored-stdio",
  "leader-exits-grandchild-traps-inherited-stdio",
];

for (const mode of modes) {
  Deno.test(`runGit: an abort ends the call and leaves no process behind (${mode})`, async () => {
    await withDirectory(async (dir) => {
      const controller = new AbortController();
      const pending = runGit(
        defaultGitSpawn,
        "node",
        dir,
        args(dir, mode),
        60_000,
        controller.signal,
        limits,
      );
      const pids = await started(dir);
      const begun = performance.now();
      controller.abort();
      assertEquals(await pending, "aborted");
      assert(
        performance.now() - begun < 6000,
        "the call must return within the bound",
      );
      assert(await gone(pids.leader), "the leader is still running");
      assert(await gone(pids.grandchild), "the grandchild is still running");
    });
  });

  Deno.test(`runHarnessGit: a deadline ends the call and leaves no process behind (${mode})`, async () => {
    await withDirectory(async (dir) => {
      const begun = performance.now();
      const result = await runHarnessGit(dir, args(dir, mode), {
        executable: "node",
        timeoutMs: 2000,
        limits,
      });
      assert(
        performance.now() - begun < 8000,
        "the call must return within the bound",
      );
      assertEquals(result.code, -1);
      assertEquals(new TextDecoder().decode(result.stderr), "git deadline");
      const pids = await started(dir);
      assert(await gone(pids.leader), "the leader is still running");
      assert(await gone(pids.grandchild), "the grandchild is still running");
    });
  });

  Deno.test(`boundedGit: an abort stops the read and leaves no process behind (${mode})`, async () => {
    await withDirectory(async (dir) => {
      const controller = new AbortController();
      const pending = boundedGit(
        dir,
        args(dir, mode),
        1 << 20,
        60_000,
        controller.signal,
        {
          executable: "node",
          limits,
        },
      );
      const pids = await started(dir);
      const begun = performance.now();
      controller.abort();
      assertEquals(await pending, "aborted");
      assert(
        performance.now() - begun < 6000,
        "the call must return within the bound",
      );
      assert(await gone(pids.leader), "the leader is still running");
      assert(await gone(pids.grandchild), "the grandchild is still running");
    });
  });
}

Deno.test("runGit: a deadline ends the call and leaves no process behind", async () => {
  await withDirectory(async (dir) => {
    // The deadline is long enough for a cold start of the stand-in on a busy
    // host; the abort cases above cover every mode without depending on it.
    const result = await runGit(
      defaultGitSpawn,
      "node",
      dir,
      args(dir, "both-trap"),
      2000,
      undefined,
      limits,
    );
    assertEquals(result, { code: -1, stdout: "", stderr: "git deadline" });
    const pids = await started(dir);
    assert(await gone(pids.leader), "the leader is still running");
    assert(await gone(pids.grandchild), "the grandchild is still running");
  });
});

Deno.test("boundedGit: a deadline stops the read and leaves no process behind", async () => {
  await withDirectory(async (dir) => {
    const begun = performance.now();
    const read = await boundedGit(
      dir,
      args(dir, "both-trap"),
      1 << 20,
      2000,
      new AbortController().signal,
      {
        executable: "node",
        limits,
      },
    );
    assert(
      performance.now() - begun < 8000,
      "the call must return within the bound",
    );
    assert(read !== "aborted");
    assertEquals(
      read.code,
      null,
      "a read cut by its deadline has no exit code",
    );
    assertEquals(read.truncated, false);
    const pids = await started(dir);
    assert(await gone(pids.leader), "the leader is still running");
    assert(await gone(pids.grandchild), "the grandchild is still running");
  });
});

Deno.test("boundedGit: reaching the byte cap stops a child that ignores SIGTERM and keeps what was read", async () => {
  await withDirectory(async (dir) => {
    const flood = `
      process.on("SIGTERM", () => {});
      const chunk = "x".repeat(4096);
      require("fs").writeFileSync(process.argv[1] + "/leader.pid", String(process.pid));
      (function write() { while (process.stdout.write(chunk)) {} process.stdout.once("drain", write); })();
    `;
    const begun = performance.now();
    const read = await boundedGit(
      dir,
      ["-e", flood, dir],
      10_000,
      60_000,
      new AbortController().signal,
      {
        executable: "node",
        limits,
      },
    );
    assert(
      performance.now() - begun < 6000,
      "the call must return within the bound",
    );
    assert(read !== "aborted");
    assertEquals(read.truncated, true);
    assertEquals(read.text.length, 10_000);
    assertEquals(read.code, null);
    const pid = await readPid(`${dir}/leader.pid`);
    assert(
      pid !== "" && await gone(pid),
      "the flooding child is still running",
    );
  });
});

Deno.test("a child that finishes in time is not signalled, and its bytes are returned exactly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-bytes-"));
  try {
    // Not valid UTF-8: decoding it to text would change it.
    const emit =
      `process.stdout.write(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]));`;
    const harness = await runHarnessGit(dir, ["-e", emit], {
      executable: "node",
      limits,
    });
    assertEquals([...harness.stdout], [0xff, 0xfe, 0x00, 0x80, 0x41]);
    assertEquals(harness.code, 0);

    const bounded = await boundedGit(
      dir,
      ["-e", `console.log("hello")`],
      1 << 20,
      30_000,
      new AbortController().signal,
      {
        executable: "node",
        limits,
      },
    );
    assert(bounded !== "aborted");
    assertEquals(bounded.text, "hello\n");
    assertEquals(bounded.code, 0);
    assertEquals(bounded.truncated, false);

    const text = await runGit(
      defaultGitSpawn,
      "node",
      dir,
      ["-e", `console.log("ok"); console.error("warn")`],
      30_000,
      undefined,
      limits,
    );
    assertEquals(text, { code: 0, stdout: "ok\n", stderr: "warn\n" });

    const failing = await runGit(
      defaultGitSpawn,
      "node",
      dir,
      ["-e", `process.exit(3)`],
      30_000,
      undefined,
      limits,
    );
    assertEquals(failing, { code: 3, stdout: "", stderr: "" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("a program that cannot be started is an error, not a deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-nostart-"));
  try {
    for (
      const run of [
        () =>
          runHarnessGit(dir, [], {
            executable: "/nonexistent/program",
            limits,
          }),
        () =>
          boundedGit(dir, [], 1024, 30_000, new AbortController().signal, {
            executable: "/nonexistent/program",
            limits,
          }),
      ]
    ) {
      let failure: unknown;
      let result: unknown;
      try {
        result = await run();
      } catch (error) {
        failure = error;
      }
      // setsid runs the program, so a missing one is a nonzero exit, never a hang.
      assert(
        failure !== undefined ||
          (result as { code?: number | null })?.code !== 0,
        JSON.stringify(result),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- children no real process can imitate ----------------------------------
// A child stuck where SIGKILL cannot reach it never closes its pipe and never
// reports an exit. The call still has to end on schedule, so these cases hand
// boundedGit a stand-in that does exactly that.

/** A started child whose signals are recorded and whose exit the test controls. */
function stuckChild(
  options: { exitsOn?: "SIGTERM" | "SIGKILL"; chunk?: Uint8Array } = {},
) {
  const signals: string[] = [];
  let swept = 0;
  let closeStdout!: () => void;
  let finish!: (status: { code: number }) => void;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.chunk) controller.enqueue(options.chunk);
      closeStdout = () => controller.close();
    },
  });
  const status = new Promise<{ code: number }>((resolve) => {
    finish = resolve;
  });
  const start = (() =>
    Promise.resolve({
      child: { stdout, status, pid: 0 } as unknown as Deno.ChildProcess,
      stop: {
        kill: (signal: string) => {
          signals.push(signal);
          if (signal === options.exitsOn) {
            finish({ code: 143 });
            closeStdout();
          }
        },
        sweep: () => {
          swept += 1;
        },
      },
    })) as unknown as typeof startGitProcess;
  return { start, signals, swept: () => swept };
}

/** Fails the test instead of hanging it when the call does not return. */
async function returns<T>(call: Promise<T>, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the call did not return")), ms);
  });
  try {
    return await Promise.race([call, guard]);
  } finally {
    clearTimeout(timer);
  }
}

const quick = { killGraceMs: 50, exitWaitMs: 100 };

Deno.test("boundedGit: a child that never closes its pipe or exits still ends the call on its deadline", async () => {
  const stuck = stuckChild();
  const begun = performance.now();
  const read = await returns(
    boundedGit(".", [], 1024, 80, new AbortController().signal, {
      start: stuck.start,
      limits: quick,
    }),
  );
  const elapsed = performance.now() - begun;
  assert(read !== "aborted");
  assertEquals(read.code, null);
  assertEquals(read.text, "");
  // deadline + grace + the bounded wait for an exit that never comes
  assert(elapsed >= 80 + 50 + 100 - 20, `${elapsed} ms: it gave up too soon`);
  assert(elapsed < 2000, `${elapsed} ms: the wait must be bounded`);
  // SIGKILL went to the whole group already, so there is nothing to sweep.
  assertEquals(stuck.signals, ["SIGTERM", "SIGKILL"]);
  assertEquals(stuck.swept(), 0);
});

Deno.test("boundedGit: an abort ends the call the same way for a child that cannot be reaped", async () => {
  const stuck = stuckChild();
  const controller = new AbortController();
  const pending = boundedGit(".", [], 1024, 60_000, controller.signal, {
    start: stuck.start,
    limits: quick,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  assertEquals(await returns(pending), "aborted");
  assertEquals(stuck.signals, ["SIGTERM", "SIGKILL"]);
});

Deno.test("boundedGit: the byte cap stops a child that has said its piece and then goes silent", async () => {
  const stuck = stuckChild({ chunk: new TextEncoder().encode("x".repeat(40)) });
  const read = await returns(
    boundedGit(".", [], 10, 60_000, new AbortController().signal, {
      start: stuck.start,
      limits: quick,
    }),
  );
  assert(read !== "aborted");
  assertEquals(read.truncated, true);
  assertEquals(read.text, "x".repeat(10));
  assertEquals(read.code, null);
  assertEquals(stuck.signals, ["SIGTERM", "SIGKILL"]);
});

Deno.test("boundedGit: a child that exits on SIGTERM is not sent SIGKILL, and what is left of its group is swept", async () => {
  const stuck = stuckChild({ exitsOn: "SIGTERM" });
  const read = await returns(
    boundedGit(".", [], 1024, 60, new AbortController().signal, {
      start: stuck.start,
      limits: quick,
    }),
  );
  assert(read !== "aborted");
  assertEquals(read.code, null);
  assertEquals(stuck.signals, ["SIGTERM"]);
  assertEquals(stuck.swept(), 1);
});

Deno.test("boundedGit: a child that needs SIGKILL gets it once the grace period is over", async () => {
  const stuck = stuckChild({ exitsOn: "SIGKILL" });
  const begun = performance.now();
  const read = await returns(
    boundedGit(".", [], 1024, 60, new AbortController().signal, {
      start: stuck.start,
      limits: quick,
    }),
  );
  assert(read !== "aborted");
  assertEquals(stuck.signals, ["SIGTERM", "SIGKILL"]);
  assert(
    performance.now() - begun >= 60 + 50 - 20,
    "SIGKILL must wait out the grace",
  );
  assertEquals(stuck.swept(), 0);
});

// ---- signalling a process group ---------------------------------------------

Deno.test("signalProcessGroup: Deno.kill is asked for the negative pid, which is the whole group", async () => {
  const calls: Array<[number, GroupSignal]> = [];
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const result = await signalProcessGroup(
      4242,
      signal,
      "/nonexistent/kill",
      (pid, sent) => {
        calls.push([pid, sent]);
      },
    );
    assertEquals(result, { status: "confirmed", via: "deno-kill" });
  }
  assertEquals(calls, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
});

Deno.test("signalProcessGroup: an empty group is confirmed and the helper is not used", async () => {
  const result = await signalProcessGroup(
    4242,
    "SIGKILL",
    "/nonexistent/kill",
    () => {
      throw new Deno.errors.NotFound("no such process");
    },
  );
  assertEquals(result, { status: "confirmed", via: "deno-kill" });
});

Deno.test("signalProcessGroup: without the broad run grant the kill helper signals the group, for both signals", async () => {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "git-signal-"));
    try {
      // A process that leads its own group and a child in that group.
      const launch = await spawnInOwnProcessGroup("node", [
        "-e",
        `const { spawn } = require("node:child_process");
         const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
         require("fs").writeFileSync(process.argv[1] + "/child.pid", String(c.pid));
         setInterval(() => {}, 1000);`,
        dir,
      ]);
      assert(launch.grouped, "this host has no setsid");
      const leader = spawn(launch.command, launch.args, { stdio: "ignore" });
      const leaderExit = new Promise((resolve) => leader.once("exit", resolve));
      let childPid = "";
      for (let waited = 0; childPid === "" && waited < 10_000; waited += 25) {
        childPid = await readPid(`${dir}/child.pid`);
        if (childPid === "") {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert(childPid !== "", "the group never started");
      const denied = () => {
        throw new Deno.errors.PermissionDenied("run access");
      };
      const result = await signalProcessGroup(
        leader.pid!,
        signal,
        "/usr/bin/kill",
        denied,
      );
      assertEquals(result, { status: "confirmed", via: "kill-helper" });
      assert(await gone(String(leader.pid)), `the leader survived ${signal}`);
      assert(
        await gone(childPid),
        `the group's other member survived ${signal}`,
      );
      await leaderExit;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

Deno.test("signalProcessGroup: the helper sends the signal it was asked for, so SIGTERM can be trapped and SIGKILL cannot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-signal-kind-"));
  try {
    const launch = await spawnInOwnProcessGroup("node", [
      "-e",
      `const fs = require("node:fs");
       process.on("SIGTERM", () => fs.writeFileSync(process.argv[1] + "/term.seen", "1"));
       fs.writeFileSync(process.argv[1] + "/leader.pid", String(process.pid));
       setInterval(() => {}, 1000);`,
      dir,
    ]);
    assert(launch.grouped, "this host has no setsid");
    const leader = spawn(launch.command, launch.args, { stdio: "ignore" });
    const leaderExit = new Promise((resolve) => leader.once("exit", resolve));
    const denied = () => {
      throw new Deno.errors.PermissionDenied("run access");
    };
    for (let waited = 0; waited < 10_000; waited += 25) {
      if (await readPid(`${dir}/leader.pid`) !== "") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const term = await signalProcessGroup(
      leader.pid!,
      "SIGTERM",
      "/usr/bin/kill",
      denied,
    );
    assertEquals(term, { status: "confirmed", via: "kill-helper" });
    // The handler ran, so it really was SIGTERM, and the process outlived it.
    for (let waited = 0; waited < 5000; waited += 25) {
      if (await readPid(`${dir}/term.seen`) !== "") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertEquals(
      await readPid(`${dir}/term.seen`),
      "1",
      "SIGTERM never arrived",
    );
    assert(
      alive(String(leader.pid)),
      "SIGTERM must not have killed a process that traps it",
    );
    await signalProcessGroup(leader.pid!, "SIGKILL", "/usr/bin/kill", denied);
    assert(await gone(String(leader.pid)), "SIGKILL cannot be trapped");
    await leaderExit;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("signalProcessGroup: the helper reports an already empty group as confirmed", async () => {
  const launch = await spawnInOwnProcessGroup("node", ["-e", "0"]);
  const finished = spawn(launch.command, launch.args, { stdio: "ignore" });
  const pid = finished.pid!;
  await new Promise((resolve) => finished.once("exit", resolve));
  const denied = () => {
    throw new Deno.errors.PermissionDenied("run access");
  };
  assertEquals(
    await signalProcessGroup(pid, "SIGKILL", "/usr/bin/kill", denied),
    {
      status: "confirmed",
      via: "kill-helper",
    },
  );
});

Deno.test("signalProcessGroup: a helper that is missing is reported as unconfirmed, never as a success", async () => {
  const denied = () => {
    throw new Deno.errors.PermissionDenied("run access");
  };
  assertEquals(
    await signalProcessGroup(4242, "SIGKILL", "/nonexistent/kill", denied),
    {
      status: "unconfirmed",
      via: "none",
      reason: "group-kill-helper-unavailable",
    },
  );
});
