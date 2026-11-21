import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  boundaryArgs,
  BWRAP_FLAG,
  createBwrapRuntime,
} from "../../apps/worker/src/plugin-job-bwrap.ts";
import {
  memoryResultSink,
  type PluginJobLimits,
  runPluginJob,
} from "../../apps/worker/src/plugin-job-runtime.ts";

/**
 * Plugin jobs under bubblewrap (#29, B14.02, slice B). Bubblewrap needs
 * unprivileged user namespaces, which many hosts block. On such a host the
 * probe refuses jobs with a reason and these tests skip, so this file proves
 * the boundary only where the host can give one; the refusal itself always runs.
 */

const ENV = { [BWRAP_FLAG]: "1" };
const LIMITS: PluginJobLimits = {
  cpus: 1,
  memoryBytes: 256 * 1024 * 1024,
  pids: 32,
  timeoutMs: 8_000,
  outputBytes: 64 * 1024,
  lineBytes: 8 * 1024,
};

const probe = await createBwrapRuntime({ env: ENV }).probe();
const supported = probe.supported;
const bwrapTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, ignore: !supported, fn });

Deno.test("off by default, and a host that cannot contain says why instead of running bare", async () => {
  const off = await createBwrapRuntime({ env: {} }).probe();
  assertEquals(off.supported, false);
  assertStringIncludes(
    off.supported ? "" : off.reason,
    "not enabled on this worker",
  );
  if (!probe.supported) {
    assert(probe.reason.length > 0);
    const end = await runPluginJob({
      runtime: createBwrapRuntime({ env: ENV }),
      spec: {
        name: "never-started",
        codeDir: "/nonexistent",
        command: ["sh", "-c", "touch /tmp/ran-uncontained"],
        limits: LIMITS,
      },
      relay: () => Promise.resolve({ ok: false as const, denial: "x" }),
      identity: "i:j:1",
      sink: memoryResultSink(),
    });
    assertEquals(end.kind, "unsupported");
    // The job never started, so nothing it would have done exists.
    assertEquals(
      await Deno.stat("/tmp/ran-uncontained").then(() => true, () => false),
      false,
    );
  }
});

bwrapTest(
  "MUTANT: a boundary without --unshare-net fails the probe",
  async () => {
    const noNet = () => boundaryArgs().filter((a) => a !== "--unshare-net");
    const result = await createBwrapRuntime({ env: ENV, boundary: noNet })
      .probe();
    assertEquals(result.supported, false);
    assertStringIncludes(result.supported ? "" : result.reason, "network");
  },
);

async function job(script: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "plugin-bwrap-" });
  await Deno.writeTextFile(`${dir}/main.sh`, script);
  return dir;
}

bwrapTest(
  "hostile code finds no network, no root write, no home and no docker socket",
  async () => {
    const dir = await job(
      [
        `net=ok; (exec 3<>/dev/tcp/1.1.1.1/53) 2>/dev/null || net=blocked`,
        `root=wrote; touch /escape 2>/dev/null || root=refused`,
        `code=wrote; touch /code/escape 2>/dev/null || code=refused`,
        `home=seen; [ -z "$(ls /home 2>/dev/null)" ] && home=none`,
        `sock=seen; [ -e /var/run/docker.sock ] || sock=none`,
        `echo "{\\"result\\":{\\"net\\":\\"$net\\",\\"root\\":\\"$root\\",\\"code\\":\\"$code\\",\\"home\\":\\"$home\\",\\"sock\\":\\"$sock\\"}}"`,
      ].join("\n"),
    );
    const end = await runPluginJob({
      runtime: createBwrapRuntime({ env: ENV }),
      spec: {
        name: "t1",
        codeDir: dir,
        command: ["bash", "/code/main.sh"],
        limits: LIMITS,
      },
      relay: () => Promise.resolve({ ok: false as const, denial: "x" }),
      identity: "i:j:1",
      sink: memoryResultSink(),
    });
    assertEquals(end.kind, "result");
    assertEquals((end as { value: unknown }).value, {
      net: "blocked",
      root: "refused",
      code: "refused",
      home: "none",
      sock: "none",
    });
  },
);

bwrapTest(
  "runaway code is killed on its budget, and a process bomb stays under its limit",
  async () => {
    const runaway = await runPluginJob({
      runtime: createBwrapRuntime({ env: ENV }),
      spec: {
        name: "t2",
        codeDir: await job("while :; do :; done"),
        command: ["sh", "/code/main.sh"],
        limits: { ...LIMITS, timeoutMs: 2_000 },
      },
      relay: () => Promise.resolve({ ok: false as const, denial: "x" }),
      identity: "i:j:2",
      sink: memoryResultSink(),
    });
    assertEquals(runaway.kind, "timeout");

    const bomb = await runPluginJob({
      runtime: createBwrapRuntime({ env: ENV }),
      spec: {
        name: "t3",
        codeDir: await job(
          [
            `count=0`,
            `while [ $count -lt 300 ]; do`,
            `  if (sleep 30 &) 2>/dev/null; then count=$((count+1)); else break; fi`,
            `done`,
            `echo "{\\"result\\":{\\"forked\\":$count}}"`,
          ].join("\n"),
        ),
        command: ["bash", "/code/main.sh"],
        limits: LIMITS,
      },
      relay: () => Promise.resolve({ ok: false as const, denial: "x" }),
      identity: "i:j:3",
      sink: memoryResultSink(),
    });
    assertEquals(bomb.kind, "result");
    const forked = (bomb as { value: { forked: number } }).value.forked;
    assert(forked < LIMITS.pids, `forked ${forked} processes`);
  },
);
