import { assertEquals } from "@std/assert";
import {
  type GitChild,
  type GitSpawn,
  runGit,
  runGitRaw,
  type startGitProcess,
} from "../../apps/worker/src/git-process.ts";
import { boundedGit } from "../../apps/worker/src/reviewer.ts";

// Tests forced a deadline miss with a 0 or 1 ms bound and hoped the timer
// fired before real git finished. It does not always: a child that has already
// finished settles in microtasks, before the timer's turn, and under load the
// event loop reaches both at once. A bound of zero (or less) has already
// passed, so it must win against any child, however fast. That is what lets a
// test say "this deadline is missed" without racing real work.

const text = (value: string) => new TextEncoder().encode(value);
const finished = { code: 0, stdout: text("done"), stderr: text("") };

/** A child that finished before the call looked, and a log of what it was sent. */
function alreadyFinished() {
  const sent: string[] = [];
  const child: GitChild = {
    kill(signal) {
      sent.push(signal);
    },
    output: () => Promise.resolve(finished),
  };
  const spawn: GitSpawn = () => child;
  return { spawn, sent };
}

const limits = { killGraceMs: 20, exitWaitMs: 20 };

Deno.test("a deadline of zero or less is already spent, even against a child that has already finished", async () => {
  for (const timeoutMs of [0, -1, Number.NEGATIVE_INFINITY]) {
    for (let run = 0; run < 50; run += 1) {
      const { spawn } = alreadyFinished();
      assertEquals(
        await runGit(spawn, "git", "/", [], timeoutMs, undefined, limits),
        { code: -1, stdout: "", stderr: "git deadline" },
        `${timeoutMs} ms, run ${run}`,
      );
      assertEquals(
        await runGitRaw(spawn, "git", "/", [], timeoutMs, undefined, limits),
        { kind: "deadline" },
        `${timeoutMs} ms, run ${run}`,
      );
    }
  }
});

Deno.test("a spent deadline still stops the child it started", async () => {
  const { spawn, sent } = alreadyFinished();
  await runGitRaw(spawn, "git", "/", [], 0, undefined, limits);
  assertEquals(sent[0], "SIGTERM", "the child is stopped, not left running");
});

Deno.test("a positive deadline still lets a finished child win, and cancellation still outranks a spent deadline", async () => {
  const { spawn } = alreadyFinished();
  assertEquals(
    await runGit(spawn, "git", "/", [], 60_000, undefined, limits),
    { code: 0, stdout: "done", stderr: "" },
  );
  const aborted = new AbortController();
  aborted.abort();
  assertEquals(
    await runGit(spawn, "git", "/", [], 0, aborted.signal, limits),
    "aborted",
    "a call cancelled before it started is cancelled, not timed out",
  );
});

// The reviewer reads the changed files and the diff through its own bounded
// reader, with its own timer, and had the same race: `diffMs: 0` finished with
// the diff instead of the deadline fault ("NOT_FAILED: completed") about one
// run in fifty under load.

/** A git process that has already finished, with its output waiting. */
function finishedProcess() {
  const signals: string[] = [];
  const start = (() =>
    Promise.resolve({
      child: {
        status: Promise.resolve({ code: 0, success: true, signal: null }),
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(text("a diff"));
            controller.close();
          },
        }),
      },
      stop: {
        kill(signal: string) {
          signals.push(signal);
        },
      },
    })) as unknown as typeof startGitProcess;
  return { start, signals };
}

Deno.test("boundedGit: a deadline of zero or less is spent against a process that has already finished", async () => {
  for (const timeoutMs of [0, -1]) {
    for (let run = 0; run < 50; run += 1) {
      const { start, signals } = finishedProcess();
      const read = await boundedGit(
        ".",
        [],
        1024,
        timeoutMs,
        new AbortController().signal,
        { start, limits },
      );
      if (read === "aborted") throw new Error("not cancelled");
      assertEquals(read.code, null, `${timeoutMs} ms, run ${run}`);
      assertEquals(read.truncated, false, `${timeoutMs} ms, run ${run}`);
      assertEquals(signals[0], "SIGTERM", "the process was stopped");
    }
  }
});

Deno.test("boundedGit: a positive deadline still lets a finished process complete, and cancellation outranks a spent deadline", async () => {
  const { start } = finishedProcess();
  const done = await boundedGit(
    ".",
    [],
    1024,
    60_000,
    new AbortController().signal,
    { start, limits },
  );
  if (done === "aborted") throw new Error("not cancelled");
  assertEquals(done, { text: "a diff", truncated: false, code: 0 });
  const cancelled = new AbortController();
  cancelled.abort();
  assertEquals(
    await boundedGit(".", [], 1024, 0, cancelled.signal, {
      start: finishedProcess().start,
      limits,
    }),
    "aborted",
  );
});
