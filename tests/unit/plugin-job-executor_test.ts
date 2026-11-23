import { assert, assertEquals } from "@std/assert";
import {
  executePluginJob,
  outcomeFor,
  type PluginJobDeps,
} from "../../apps/worker/src/plugin-job-executor.ts";
import type {
  ContainmentRuntime,
  PluginJobSpec,
  RunningPluginJob,
} from "../../apps/worker/src/plugin-job-runtime.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";

/**
 * One plugin.job attempt (#29, B14.02), with the runtime and the server faked:
 * how every way a job can end becomes the attempt's outcome, that a job the
 * worker cannot contain never runs, and that its code never outlives it.
 */

const INSTALL = crypto.randomUUID();
/** The version every job is admitted against; a job without one is refused. */
const VERSION = crypto.randomUUID();
const assignment = (over: Record<string, unknown> = {}) =>
  ({
    jobId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    fence: "1",
    action: "plugin.job",
    input: {
      installId: INSTALL,
      entry: "jobs/nightly.js",
      versionId: VERSION,
    },
    ...over,
  }) as unknown as JobAssignment;

const files = (over: Record<string, unknown> = {}) => ({
  entry: "jobs/nightly.js",
  files: [{ path: "jobs/nightly.js", contentBase64: btoa("run()") }],
  ...over,
});

type Script = {
  lines?: string[];
  hang?: boolean;
  exit?: { code: number | null; oomKilled?: boolean };
  supported?: boolean;
};

function fakeRuntime(script: Script) {
  const log = {
    started: 0,
    killed: 0,
    written: [] as string[],
    specs: [] as PluginJobSpec[],
  };
  const runtime: ContainmentRuntime = {
    name: "fake",
    probe: () =>
      Promise.resolve(
        script.supported === false
          ? { supported: false, runtime: "fake", reason: "no boundary here" }
          : { supported: true, runtime: "fake" },
      ),
    start: (spec) => {
      log.started++;
      log.specs.push(spec);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let killed = false;
      const job: RunningPluginJob = {
        write: (line) => {
          log.written.push(line);
          return Promise.resolve();
        },
        lines: (async function* () {
          for (const line of script.lines ?? []) yield line;
          if (script.hang) await gate;
        })(),
        exited: gate.then(() => script.exit ?? { code: 0 }),
        kill: () => {
          if (!killed) {
            killed = true;
            log.killed++;
          }
          release();
          return Promise.resolve();
        },
      };
      if (!script.hang) release();
      return Promise.resolve(job);
    },
  };
  return { runtime, log };
}

async function withDeps<T>(
  script: Script,
  over: Partial<PluginJobDeps>,
  run: (
    deps: PluginJobDeps,
    log: ReturnType<typeof fakeRuntime>["log"],
    parent: string,
  ) => Promise<T>,
): Promise<T> {
  const parent = await Deno.makeTempDir({ prefix: "plugin-exec-test-" });
  const { runtime, log } = fakeRuntime(script);
  try {
    return await run(
      {
        runtime,
        codeParent: parent,
        limits: {
          cpus: 1,
          memoryBytes: 1 << 26,
          pids: 8,
          timeoutMs: 300,
          outputBytes: 4096,
          lineBytes: 1024,
        },
        command: (entry) => ["sh", `/code/${entry}`],
        fetchFiles: () => Promise.resolve(files()),
        relay: () =>
          Promise.resolve({ ok: true as const, result: { value: 1 } }),
        ...over,
      },
      log,
      parent,
    );
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
}

const left = (parent: string) => [...Deno.readDirSync(parent)].length;
const faultOf = (outcome: { status: string; fault?: unknown }) =>
  (outcome.fault as { code: string } | undefined)?.code;

Deno.test("a result completes the attempt, runs the entry the job names, and leaves no code behind", () =>
  withDeps(
    { lines: ['{"result":{"done":true}}'] },
    {},
    async (deps, log, parent) => {
      const outcome = await executePluginJob(
        assignment(),
        new AbortController().signal,
        deps,
      );
      assertEquals(outcome, {
        status: "completed",
        result: { resultJson: '{"done":true}' },
      });
      assertEquals(log.specs[0].command, ["sh", "/code/jobs/nightly.js"]);
      assertEquals(left(parent), 0);
    },
  ));

Deno.test("a job's requests go through the relay and its answers come back", () => {
  const seen: string[] = [];
  return withDeps(
    {
      lines: [
        '{"call":{"requestId":"r1","sequence":1,"operation":"state.read","args":{"key":"a"}}}',
        '{"result":1}',
      ],
    },
    {
      relay: (call) => {
        seen.push(call.operation);
        return Promise.resolve({ ok: true as const, result: { value: 7 } });
      },
    },
    async (deps, log) => {
      const outcome = await executePluginJob(
        assignment(),
        new AbortController().signal,
        deps,
      );
      assertEquals(outcome.status, "completed");
      assertEquals(seen, ["state.read"]);
      assertEquals(JSON.parse(log.written[0]), {
        requestId: "r1",
        ok: true,
        result: { value: 7 },
      });
    },
  );
});

Deno.test("each way a job can end is a distinct, truthful outcome", () => {
  const code = (end: Parameters<typeof outcomeFor>[0]) =>
    faultOf(outcomeFor(end) as never);
  assertEquals(code({ kind: "timeout" }), "DEPENDENCY_TIMEOUT");
  assertEquals(
    code({ kind: "unsupported", reason: "x" }),
    "DEPENDENCY_UNAVAILABLE",
  );
  assertEquals(code({ kind: "start_failed" }), "DEPENDENCY_UNAVAILABLE");
  assertEquals(code({ kind: "output_limit" }), "UNPROCESSABLE");
  assertEquals(
    code({ kind: "protocol_violation", detail: "d" }),
    "UNPROCESSABLE",
  );
  assertEquals(
    code({ kind: "crashed", code: 1, oomKilled: false }),
    "INTERNAL",
  );
  const oom = outcomeFor({
    kind: "crashed",
    code: 137,
    oomKilled: true,
  }) as unknown as {
    fault: { detail: string };
  };
  assert(oom.fault.detail.includes("out of memory"));
  assertEquals(outcomeFor({ kind: "aborted" }).status, "canceled");
  const big = outcomeFor({
    kind: "result",
    value: "x".repeat(70000),
    recorded: true,
  });
  assertEquals(faultOf(big as never), "UNPROCESSABLE");
  assertEquals(
    outcomeFor({ kind: "result", value: undefined, recorded: true }),
    { status: "completed", result: { resultJson: "null" } },
  );
});

Deno.test("a job that runs past its budget is stopped and reported as a timeout", () =>
  withDeps({ hang: true }, {}, async (deps, log, parent) => {
    const outcome = await executePluginJob(
      assignment(),
      new AbortController().signal,
      deps,
    );
    assertEquals(faultOf(outcome as never), "DEPENDENCY_TIMEOUT");
    assertEquals(log.killed, 1);
    assertEquals(left(parent), 0);
  }));

Deno.test("a worker that cannot contain jobs runs nothing and says why", () =>
  withDeps({ supported: false }, {}, async (deps, log, parent) => {
    const outcome = await executePluginJob(
      assignment(),
      new AbortController().signal,
      deps,
    );
    assertEquals(faultOf(outcome as never), "DEPENDENCY_UNAVAILABLE");
    assert(JSON.stringify(outcome).includes("no boundary here"));
    assertEquals(log.started, 0);
    assertEquals(left(parent), 0);
  }));

Deno.test("code the server refuses, or the worker refuses, never runs", async () => {
  const refusal = Object.assign(new Error("refused"), { status: 409 });
  const cases: [string, Partial<PluginJobDeps>, string][] = [
    [
      "install off",
      { fetchFiles: () => Promise.reject(refusal) },
      "STATE_CONFLICT",
    ],
    [
      "server down",
      { fetchFiles: () => Promise.reject(new Error("net")) },
      "DEPENDENCY_UNAVAILABLE",
    ],
    [
      "hostile path",
      {
        fetchFiles: () =>
          Promise.resolve(
            files({ files: [{ path: "../x.js", contentBase64: btoa("y") }] }),
          ),
      },
      "UNPROCESSABLE",
    ],
    [
      "other entry",
      {
        fetchFiles: () =>
          Promise.resolve(
            files({
              entry: "other.js",
              files: [{ path: "other.js", contentBase64: btoa("y") }],
            }),
          ),
      },
      "UNPROCESSABLE",
    ],
  ];
  for (const [name, over, expected] of cases) {
    await withDeps(
      { lines: ['{"result":1}'] },
      over,
      async (deps, log, parent) => {
        const outcome = await executePluginJob(
          assignment(),
          new AbortController().signal,
          deps,
        );
        assertEquals(faultOf(outcome as never), expected, name);
        assertEquals(log.started, 0, name);
        assertEquals(left(parent), 0, name);
      },
    );
  }
});

Deno.test("an invalid input, or an abort before or during the run, is handled and cleaned up", async () => {
  await withDeps({ lines: [] }, {}, async (deps, log) => {
    const bad = await executePluginJob(
      assignment({ input: { installId: "not-a-uuid", entry: "x" } }),
      new AbortController().signal,
      deps,
    );
    assertEquals(faultOf(bad as never), "VALIDATION_FAILED");
    assertEquals(log.started, 0);
  });
  await withDeps({ lines: [] }, {}, async (deps, log) => {
    const early = new AbortController();
    early.abort();
    assertEquals(
      (await executePluginJob(assignment(), early.signal, deps)).status,
      "canceled",
    );
    assertEquals(log.started, 0);
  });
  await withDeps(
    { hang: true },
    { limits: undefined },
    async (deps, log, parent) => {
      const controller = new AbortController();
      const running = executePluginJob(assignment(), controller.signal, {
        ...deps,
        limits: { ...(deps.limits ?? {}), timeoutMs: 60_000 } as never,
      });
      while (log.started === 0) await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      assertEquals((await running).status, "canceled");
      assertEquals(log.killed >= 1, true);
      assertEquals(left(parent), 0);
    },
  );
});

Deno.test("an abort while the code is being fetched ends the attempt as canceled, not as an outage", () => {
  const controller = new AbortController();
  return withDeps(
    { lines: ['{"result":1}'] },
    {
      fetchFiles: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          queueMicrotask(() => controller.abort());
        }),
    },
    async (deps, log, parent) => {
      const outcome = await executePluginJob(
        assignment(),
        controller.signal,
        deps,
      );
      assertEquals(outcome.status, "canceled");
      assertEquals(log.started, 0);
      assertEquals(left(parent), 0);
    },
  );
});

Deno.test("context the server attaches beside the input is ignored; a missing field is still refused", () =>
  withDeps({ lines: ['{"result":1}'] }, {}, async (deps) => {
    const withContext = await executePluginJob(
      assignment({
        input: {
          installId: INSTALL,
          entry: "jobs/nightly.js",
          versionId: VERSION,
          repositoryProfile: { id: crypto.randomUUID() },
          somethingElse: true,
        },
      }),
      new AbortController().signal,
      deps,
    );
    assertEquals(withContext.status, "completed");
    for (const input of [{ installId: INSTALL }, { entry: "x" }, null, []]) {
      const outcome = await executePluginJob(
        assignment({ input }),
        new AbortController().signal,
        deps,
      );
      assertEquals(faultOf(outcome as never), "VALIDATION_FAILED");
    }
  }));
