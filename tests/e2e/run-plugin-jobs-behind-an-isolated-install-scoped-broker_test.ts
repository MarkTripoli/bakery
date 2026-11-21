import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDockerRuntime,
  DOCKER_FLAG,
  hardeningArgs,
} from "../../apps/worker/src/plugin-job-docker.ts";
import {
  effectIdentity,
  memoryResultSink,
  type PluginJobLimits,
  runPluginJob,
} from "../../apps/worker/src/plugin-job-runtime.ts";

/**
 * Plugin jobs in a real container (#29, B14.02, slice B, AC1 and AC3): hostile
 * code probes the filesystem, network, processes and memory, and runaway code
 * is killed on its budget. The tests need Docker and an `alpine` image, and say
 * so when they cannot run rather than passing without proving anything.
 */

const IMAGE = Deno.env.get("BAKERY_PLUGIN_TEST_IMAGE") ?? "alpine:latest";
const ENV = { [DOCKER_FLAG]: "1" };
const LIMITS: PluginJobLimits = {
  cpus: 1,
  memoryBytes: 64 * 1024 * 1024,
  pids: 16,
  timeoutMs: 8_000,
  outputBytes: 64 * 1024,
  lineBytes: 8 * 1024,
};

async function dockerReady(): Promise<boolean> {
  try {
    const out = await new Deno.Command("docker", {
      args: ["image", "inspect", IMAGE],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.code === 0;
  } catch {
    return false;
  }
}
const ready = await dockerReady();
// Every directory a test makes, removed when that test ends, so a self-hosted
// runner does not collect one per job.
const tempDirs: string[] = [];
async function makeTemp(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  tempDirs.push(dir);
  return dir;
}
async function removeTemps(): Promise<void> {
  for (const dir of tempDirs.splice(0)) {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}
const dockerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({
    name,
    ignore: !ready,
    fn: async () => {
      try {
        await fn();
      } finally {
        await removeTemps();
      }
    },
  });

async function job(script: string): Promise<string> {
  const dir = await makeTemp("plugin-job-");
  await Deno.writeTextFile(`${dir}/main.sh`, script);
  // A bind mount keeps host permissions, and the job runs as an unprivileged
  // user, so the code directory has to be readable by it.
  await Deno.chmod(dir, 0o755);
  await Deno.chmod(`${dir}/main.sh`, 0o644);
  return dir;
}

function run(
  codeDir: string,
  over: Partial<PluginJobLimits> = {},
  relayed: string[] = [],
) {
  const runtime = createDockerRuntime({ env: ENV, image: IMAGE });
  const sink = memoryResultSink();
  const name = `bakery-plugin-test-${crypto.randomUUID()}`;
  return {
    sink,
    name,
    go: (identity = "i:j:1") =>
      runPluginJob({
        runtime,
        spec: {
          name,
          codeDir,
          command: ["sh", "/code/main.sh"],
          limits: { ...LIMITS, ...over },
        },
        relay: (call) => {
          relayed.push(call.operation);
          return Promise.resolve(
            call.operation === "state.read"
              ? { ok: true as const, result: { value: 7 } }
              : { ok: false as const, denial: "not_granted" },
          );
        },
        identity,
        sink,
      }),
  };
}

async function containerExists(name: string): Promise<boolean> {
  const out = await new Deno.Command("docker", {
    args: ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).trim().length > 0;
}

dockerTest(
  "the probe passes on a contained runtime and the flag is off by default",
  async () => {
    const on = await createDockerRuntime({ env: ENV, image: IMAGE }).probe();
    assertEquals(on, { supported: true, runtime: "docker" });
    const off = await createDockerRuntime({ env: {}, image: IMAGE }).probe();
    assertEquals(off.supported, false);
    assertStringIncludes(
      off.supported ? "" : off.reason,
      "not enabled on this worker",
    );
  },
);

dockerTest(
  "MUTANT: a runtime that skips --network none fails the probe",
  async () => {
    const withNetwork = (name: string, limits: PluginJobLimits) => {
      const args = hardeningArgs(name, limits);
      const at = args.indexOf("--network");
      return [...args.slice(0, at), ...args.slice(at + 2)];
    };
    const probe = await createDockerRuntime({
      env: ENV,
      image: IMAGE,
      hardening: withNetwork,
    }).probe();
    assertEquals(probe.supported, false);
    assertStringIncludes(
      probe.supported ? "" : probe.reason,
      "network interface",
    );
  },
);

dockerTest(
  "MUTANT: a runtime that skips --read-only fails the probe",
  async () => {
    const writable = (name: string, limits: PluginJobLimits) =>
      hardeningArgs(name, limits).filter((a) => a !== "--read-only");
    const probe = await createDockerRuntime({
      env: ENV,
      image: IMAGE,
      hardening: writable,
    }).probe();
    assertEquals(probe.supported, false);
    assertStringIncludes(
      probe.supported ? "" : probe.reason,
      "root filesystem",
    );
  },
);

dockerTest(
  "a job reaches the broker only through the relay, and its result is recorded once",
  async () => {
    const dir = await job(
      [
        `echo '{"call":{"requestId":"r1","sequence":1,"operation":"state.read","args":{"key":"a"}}}'`,
        `read reply`,
        `echo '{"call":{"requestId":"r2","sequence":2,"operation":"shell.exec","args":{}}}'`,
        `read denied`,
        `echo "{\\"result\\":{\\"first\\":$reply,\\"second\\":$denied}}"`,
      ].join("\n"),
    );
    const relayed: string[] = [];
    const { go, sink, name } = run(dir, {}, relayed);
    const end = await go();
    assertEquals(relayed, ["state.read", "shell.exec"]);
    assertEquals(end.kind, "result");
    const value = (end as { value: Record<string, Record<string, unknown>> })
      .value;
    assertEquals(value.first.ok, true);
    assertEquals(value.second, {
      requestId: "r2",
      ok: false,
      denial: "not_granted",
    });
    assertEquals(sink.recorded.size, 1);
    assertEquals((end as { recorded: boolean }).recorded, true);
    assertEquals(await containerExists(name), false);
    // The same scheduled work run again records nothing new, and says so.
    const kept = [...sink.recorded.values()][0];
    const again = await go();
    assertEquals(again.kind, "result");
    assertEquals((again as { recorded: boolean }).recorded, false);
    assertEquals(sink.recorded.size, 1);
    assertEquals([...sink.recorded.values()][0], kept);
  },
);

dockerTest(
  "malicious code finds no network, no root write, no host files, no way to change its code",
  async () => {
    const dir = await job(
      [
        `net=ok; wget -q -T 2 -O- http://1.1.1.1/ >/dev/null 2>&1 || net=blocked`,
        `dns=ok; nslookup example.com >/dev/null 2>&1 || dns=blocked`,
        `root=wrote; touch /escape 2>/dev/null || root=refused`,
        `code=wrote; touch /code/escape 2>/dev/null || code=refused`,
        `host=seen; [ -e /home ] && ls /home 2>/dev/null | grep -q . || host=none`,
        `sock=seen; [ -e /var/run/docker.sock ] || sock=none`,
        `ifaces=$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | grep -v '^lo$' | wc -l | tr -d ' ')`,
        `echo "{\\"result\\":{\\"net\\":\\"$net\\",\\"dns\\":\\"$dns\\",\\"root\\":\\"$root\\",\\"code\\":\\"$code\\",\\"host\\":\\"$host\\",\\"sock\\":\\"$sock\\",\\"ifaces\\":$ifaces}}"`,
      ].join("\n"),
    );
    const { go } = run(dir);
    const end = await go();
    assertEquals(end.kind, "result");
    assertEquals((end as { value: unknown }).value, {
      net: "blocked",
      dns: "blocked",
      root: "refused",
      code: "refused",
      host: "none",
      sock: "none",
      ifaces: 0,
    });
  },
);

dockerTest(
  "runaway code is killed on its time budget and leaves no container",
  async () => {
    const dir = await job("while :; do :; done");
    const { go, name, sink } = run(dir, { timeoutMs: 2_000 });
    const started = Date.now();
    const end = await go();
    assertEquals(end.kind, "timeout");
    assert(Date.now() - started < 15_000, "the kill must follow the budget");
    assertEquals(await containerExists(name), false);
    assertEquals(sink.recorded.size, 0);
  },
);

dockerTest(
  "a memory hog is stopped at its limit and reported as crashed",
  async () => {
    const dir = await job(
      `x=a; while :; do x="$x$x$x$x"; done`,
    );
    const { go, name } = run(dir, { timeoutMs: 20_000 });
    const end = await go();
    assertEquals(end.kind, "crashed");
    assertEquals(await containerExists(name), false);
  },
);

dockerTest("a process bomb is held to its process limit", async () => {
  const dir = await job(
    [
      `count=0`,
      `while [ $count -lt 300 ]; do`,
      `  if (sleep 30 &) 2>/dev/null; then count=$((count+1)); else break; fi`,
      `done`,
      `echo "{\\"result\\":{\\"forked\\":$count}}"`,
    ].join("\n"),
  );
  const { go, name } = run(dir);
  const end = await go();
  assertEquals(end.kind, "result");
  const forked = (end as { value: { forked: number } }).value.forked;
  assert(forked > 0 && forked < LIMITS.pids, `forked ${forked} processes`);
  assertEquals(await containerExists(name), false);
});

dockerTest(
  "a flood of output, valid or not, or a line that never ends, stops the job",
  async () => {
    const junk = run(await job(`yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`));
    assertEquals((await junk.go()).kind, "protocol_violation");
    assertEquals(await containerExists(junk.name), false);

    const calls = run(
      await job(
        `while :; do echo '{"call":{"requestId":"r","sequence":1,"operation":"a.b","args":{}}}'; done`,
      ),
      { outputBytes: 4096 },
    );
    assertEquals((await calls.go()).kind, "output_limit");
    assertEquals(await containerExists(calls.name), false);

    const endless = run(
      await job(`while :; do printf aaaaaaaaaaaaaaaaaaaaaaaa; done`),
      { lineBytes: 1024 },
    );
    assertEquals((await endless.go()).kind, "output_limit");
    assertEquals(await containerExists(endless.name), false);
  },
);

async function inspectWhileRunning(name: string) {
  // Twenty seconds: under load Docker takes several seconds to start one.
  for (let waited = 0; waited < 200; waited++) {
    const out = await new Deno.Command("docker", {
      args: ["ps", "-q", "--filter", `name=${name}`],
      stdout: "piped",
    }).output();
    const id = new TextDecoder().decode(out.stdout).trim();
    if (id.length > 0) {
      const inspect = await new Deno.Command("docker", {
        args: ["inspect", id],
        stdout: "piped",
      }).output();
      return JSON.parse(new TextDecoder().decode(inspect.stdout))[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the job's container never appeared");
}

dockerTest(
  "a running job's container carries every limit and drop it is meant to",
  async () => {
    const dir = await job(`sleep 4; echo '{"result":1}'`);
    const { go, name } = run(dir);
    const ended = go();
    const info = await inspectWhileRunning(name);
    const host = info.HostConfig;
    assertEquals(host.NetworkMode, "none");
    assertEquals(host.ReadonlyRootfs, true);
    assertEquals(host.CapDrop, ["ALL"]);
    assert(
      (host.SecurityOpt as string[]).some((o) =>
        o.startsWith("no-new-privileges")
      ),
      "no-new-privileges is missing",
    );
    assertEquals(host.PidsLimit, LIMITS.pids);
    assertEquals(host.Memory, LIMITS.memoryBytes);
    // Swap equal to memory means no swap at all.
    assertEquals(host.MemorySwap, LIMITS.memoryBytes);
    assertEquals(host.NanoCpus, LIMITS.cpus * 1e9);
    assertEquals(host.IpcMode, "none");
    // A log driver would keep the job's output on the host past every cap.
    assertEquals(host.LogConfig.Type, "none");
    assertEquals(info.Config.User, "65534:65534");
    assertEquals((await ended).kind, "result");
  },
);

dockerTest(
  "inside, the job holds no capabilities, no privilege gain, no root, no exec from /tmp and no write to its code",
  async () => {
    const dir = await job(
      [
        `cap=$(awk '/^CapEff/ {print $2}' /proc/self/status)`,
        `nnp=$(awk '/^NoNewPrivs/ {print $2}' /proc/self/status)`,
        `uid=$(id -u)`,
        `cp /bin/busybox /tmp/busybox 2>/dev/null; /tmp/busybox true 2>/dev/null && ex=ran || ex=refused`,
        `touch /code/x 2>/dev/null && code=wrote || code=refused`,
        `echo "{\\"result\\":{\\"cap\\":\\"$cap\\",\\"nnp\\":$nnp,\\"uid\\":$uid,\\"exec\\":\\"$ex\\",\\"code\\":\\"$code\\"}}"`,
      ].join("\n"),
    );
    // Writable by anyone on the host, so only the read-only mount refuses a write.
    await Deno.chmod(dir, 0o777);
    const { go } = run(dir);
    const end = await go();
    assertEquals(end.kind, "result");
    assertEquals((end as { value: unknown }).value, {
      cap: "0000000000000000",
      nnp: 1,
      uid: 65534,
      exec: "refused",
      code: "refused",
    });
  },
);

dockerTest(
  "a job that floods stderr is stopped on its budget and keeps nothing on the host",
  async () => {
    const dir = await job(
      `while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx 1>&2; done`,
    );
    const { go, name } = run(dir, { timeoutMs: 2_000 });
    const ended = go();
    const info = await inspectWhileRunning(name);
    assertEquals(info.HostConfig.LogConfig.Type, "none");
    assertEquals((await ended).kind, "timeout");
    assertEquals(await containerExists(name), false);
  },
);

dockerTest(
  "a job named like a container that already exists does not touch it, and same-named jobs do not collide",
  async () => {
    const decoy = `bakery-plugin-test-decoy-${crypto.randomUUID().slice(0, 8)}`;
    const started = await new Deno.Command("docker", {
      args: ["run", "-d", "--name", decoy, IMAGE, "sleep", "60"],
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(started.code, 0);
    try {
      const dir = await job(`sleep 2; echo '{"result":1}'`);
      // Both runs carry the decoy's exact name as their label.
      const spec = (name: string) => ({
        runtime: createDockerRuntime({ env: ENV, image: IMAGE }),
        spec: {
          name,
          codeDir: dir,
          command: ["sh", "/code/main.sh"],
          limits: LIMITS,
        },
        relay: () => Promise.resolve({ ok: false as const, denial: "x" }),
        sink: memoryResultSink(),
      });
      const [a, b] = await Promise.all([
        runPluginJob({ ...spec(decoy), identity: "i:j:1" }),
        runPluginJob({ ...spec(decoy), identity: "i:j:2" }),
      ]);
      assertEquals(a.kind, "result");
      assertEquals(b.kind, "result");
      assertEquals(await containerExists(decoy), true);
    } finally {
      await new Deno.Command("docker", {
        args: ["rm", "-fv", decoy],
        stdout: "null",
        stderr: "null",
      }).output();
    }
  },
);

dockerTest(
  "a relay that never answers cannot hold the job past its budget",
  async () => {
    const dir = await job(
      `echo '{"call":{"requestId":"r","sequence":1,"operation":"a.b","args":{}}}'; sleep 30`,
    );
    const runtime = createDockerRuntime({ env: ENV, image: IMAGE });
    const name = `bakery-plugin-test-${crypto.randomUUID()}`;
    const started = Date.now();
    const end = await runPluginJob({
      runtime,
      spec: {
        name,
        codeDir: dir,
        command: ["sh", "/code/main.sh"],
        limits: { ...LIMITS, timeoutMs: 2_000 },
      },
      relay: () => new Promise(() => {}),
      identity: "i:j:1",
      sink: memoryResultSink(),
    });
    assertEquals(end.kind, "timeout");
    assert(
      Date.now() - started < 12_000,
      "the relay held the job past its budget",
    );
    assertEquals(await containerExists(name), false);
  },
);

dockerTest("a caller abort ends the job as aborted", async () => {
  const dir = await job(`sleep 30`);
  const controller = new AbortController();
  const runtime = createDockerRuntime({ env: ENV, image: IMAGE });
  const name = `bakery-plugin-test-${crypto.randomUUID()}`;
  const ended = runPluginJob({
    runtime,
    spec: {
      name,
      codeDir: dir,
      command: ["sh", "/code/main.sh"],
      limits: LIMITS,
    },
    relay: () => Promise.resolve({ ok: false as const, denial: "x" }),
    identity: "i:j:1",
    sink: memoryResultSink(),
    signal: controller.signal,
  });
  await inspectWhileRunning(name);
  controller.abort();
  assertEquals((await ended).kind, "aborted");
  assertEquals(await containerExists(name), false);
});

dockerTest(
  "byte caps count bytes: a short multibyte line is over a byte cap",
  async () => {
    // 5000 two-byte characters are 5000 UTF-16 units but 10000 bytes.
    const dir = await job(
      `awk 'BEGIN{printf "{\\"result\\":\\""; for(i=0;i<5000;i++) printf "é"; print "\\"}"}'`,
    );
    const { go } = run(dir, { lineBytes: 8 * 1024 });
    assertEquals((await go()).kind, "output_limit");
  },
);

dockerTest(
  "a relay that rejects is answered as relay_failed and the job carries on to a result",
  async () => {
    const dir = await job(
      [
        `echo '{"call":{"requestId":"r1","sequence":1,"operation":"a.b","args":{}}}'`,
        `read reply`,
        `echo "{\\"result\\":$reply}"`,
      ].join("\n"),
    );
    const name = `bakery-plugin-test-${crypto.randomUUID()}`;
    const end = await runPluginJob({
      runtime: createDockerRuntime({ env: ENV, image: IMAGE }),
      spec: {
        name,
        codeDir: dir,
        command: ["sh", "/code/main.sh"],
        limits: LIMITS,
      },
      relay: () => Promise.reject(new Error("the broker is down")),
      identity: "i:j:1",
      sink: memoryResultSink(),
    });
    assertEquals(end.kind, "result");
    assertEquals((end as { value: unknown }).value, {
      requestId: "r1",
      ok: false,
      denial: "relay_failed",
    });
    assertEquals(await containerExists(name), false);
  },
);

dockerTest(
  "any job name, even one Docker would refuse as a container name, still runs",
  async () => {
    for (const odd of ["", "-x", ".hidden", "a/b", "é", "x".repeat(300)]) {
      const dir = await job(`echo '{"result":1}'`);
      const end = await runPluginJob({
        runtime: createDockerRuntime({ env: ENV, image: IMAGE }),
        spec: {
          name: odd,
          codeDir: dir,
          command: ["sh", "/code/main.sh"],
          limits: LIMITS,
        },
        relay: () => Promise.resolve({ ok: false as const, denial: "x" }),
        identity: `i:j:${odd.length}`,
        sink: memoryResultSink(),
      });
      assertEquals(end.kind, "result", `name ${JSON.stringify(odd)}`);
    }
  },
);

async function countNamed(prefix: string): Promise<number> {
  const out = await new Deno.Command("docker", {
    args: ["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.Names}}"],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).split("\n").filter((n) =>
    n.length > 0
  ).length;
}

async function settledCount(
  prefix: string,
  steadySeconds: number,
): Promise<number> {
  // Containers a daemon was still creating appear late: under load its create
  // backlog drains for 15 to 30 seconds. A zero only counts once the count has
  // stayed the same for a long steady window, not for a few seconds.
  let last = -1;
  let steady = 0;
  for (let waited = 0; waited < 180 && steady < steadySeconds; waited++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const now = await countNamed(prefix);
    steady = now === last ? steady + 1 : 0;
    last = now;
  }
  return last;
}

dockerTest(
  "a kill while the daemon is still creating leaves no container",
  async () => {
    // A `docker` that is slow to create, and whose run outlives its client the
    // way a daemon's in-flight create does.
    const dir = await makeTemp("slow-docker-");
    const wrapper = `${dir}/docker`;
    await Deno.writeTextFile(
      wrapper,
      [
        "#!/bin/sh",
        'case "$1" in',
        '  create) sleep 1; exec docker "$@";;',
        '  run) ( sleep 1; exec docker "$@" </dev/null ) & wait $!; exit;;',
        '  *) exec docker "$@";;',
        "esac",
      ].join("\n") + "\n",
    );
    await Deno.chmod(wrapper, 0o755);
    const code = await job(`sleep 30`);
    const runtime = createDockerRuntime({
      env: ENV,
      image: IMAGE,
      docker: wrapper,
    });
    const started = runtime.start({
      name: "slowcreate",
      codeDir: code,
      command: ["sh", "/code/main.sh"],
      limits: LIMITS,
    });
    // Kill as soon as the caller has a handle: with `docker run` that is while
    // the create is still pending, and the container appears after the removal.
    const handle = await Promise.race([
      started,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    if (handle !== null) await handle.kill();
    else await (await started).kill();
    // The wrapper's run path sleeps 1 s and Docker then needs time to create,
    // so the container a leaking runtime leaves appears seconds after the kill.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    assertEquals(await countNamed("bakery-plugin-slowcreate-"), 0);
  },
);

dockerTest(
  "many jobs killed at random moments while their containers are being created leave none",
  async () => {
    const dir = await job(`sleep 30`);
    const runtime = createDockerRuntime({ env: ENV, image: IMAGE });
    await Promise.all(
      Array.from({ length: 80 }, async (_, i) => {
        const handle = await runtime.start({
          name: `stress-${i}`,
          codeDir: dir,
          command: ["sh", "/code/main.sh"],
          limits: LIMITS,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, Math.floor(Math.random() * 400))
        );
        await handle.kill();
      }),
    );
    assertEquals(await settledCount("bakery-plugin-stress-", 20), 0);
  },
);

dockerTest(
  "a create that fails ends the job as start_failed and leaves nothing",
  async () => {
    const code = await job(`echo '{"result":1}'`);
    const end = await runPluginJob({
      runtime: createDockerRuntime({
        env: ENV,
        // The image exists for the probe but the job asks for an entrypoint
        // that cannot be created: an empty command.
        image: IMAGE,
      }),
      spec: {
        name: "badcreate",
        codeDir: code,
        command: [],
        limits: { ...LIMITS, memoryBytes: 1 },
      },
      relay: () => Promise.resolve({ ok: false as const, denial: "x" }),
      identity: "i:j:1",
      sink: memoryResultSink(),
    });
    assertEquals(end.kind, "start_failed");
    assertEquals(await countNamed("bakery-plugin-badcreate-"), 0);
  },
);

Deno.test("the identity of one piece of work is install, job and fence", () => {
  assertEquals(
    effectIdentity({ installId: "i", jobId: "j", fence: 3 }),
    "i:j:3",
  );
});
