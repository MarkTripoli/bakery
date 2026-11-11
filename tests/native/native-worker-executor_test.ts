import { dirname, join } from "node:path";
import { NativeOutputCapture } from "../../apps/worker/src/native-output.ts";
import {
  EventSpool,
  terminalReservationBytes,
} from "../../apps/worker/src/spool.ts";
import type { WorkerApiClient } from "../../apps/worker/src/client.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  createDeterministicExecutor,
  createNativeExecutor,
  type ExecutionOutcome,
  NATIVE_SKILL_ROOTS_ENV,
  type NativeActionDefinition,
  NativeExecutorError,
} from "../../apps/worker/src/executor.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import { outcomeResult } from "../../apps/worker/src/supervisor-support.ts";
import type {
  NativeOutputChannel,
  NativeOutputSink,
} from "../../apps/worker/src/native-output.ts";

const cgroupRoot = Deno.env.get("BAKERY_TEST_CGROUP_ROOT")?.trim();

function nativeTest(
  name: string,
  fn: () => void | Promise<void>,
): void {
  Deno.test({ name, ignore: !cgroupRoot, fn });
}

function wait(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await Deno.stat(path);
      return;
    } catch {
      await wait(10);
    }
  }
  throw new Error("NATIVE_CHILD_MARKER_TIMEOUT");
}

async function processExists(pid: number): Promise<boolean> {
  try {
    await Deno.stat(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
async function readProcFdTargets(): Promise<string[]> {
  const targets: string[] = [];
  for await (const entry of Deno.readDir("/proc/self/fd")) {
    try {
      targets.push(await Deno.readLink(`/proc/self/fd/${entry.name}`));
    } catch {
      // Descriptors can close while the directory is being inspected.
    }
  }
  return targets;
}

const PARENT_ENV_CANARY = "BAKERY_TEST_PARENT_SECRET_CANARY";

function descriptorInspectionAction(
  markerPath: string,
): NativeActionDefinition {
  const markerName = markerPath.slice(markerPath.lastIndexOf("/") + 1);
  const marker = JSON.stringify(`/tmp/${markerName}`);
  const canaryName = JSON.stringify(PARENT_ENV_CANARY);
  const descriptorScript = [
    "const descriptorTargets = [];",
    'for await (const entry of Deno.readDir("/proc/self/fd")) {',
    "  try {",
    "    descriptorTargets.push(await Deno.readLink(`/proc/self/fd/${entry.name}`));",
    "  } catch {",
    "    // Descriptors can close while the directory is being inspected.",
    "  }",
    "}",
    "const ancestorDescriptorTargets = [];",
    "let ancestorPid = Deno.ppid;",
    "for (let depth = 0; depth < 8 && ancestorPid > 1; depth++) {",
    "  try {",
    "    for await (const entry of Deno.readDir(`/proc/${ancestorPid}/fd`)) {",
    "      try {",
    "        ancestorDescriptorTargets.push(",
    "          await Deno.readLink(`/proc/${ancestorPid}/fd/${entry.name}`),",
    "        );",
    "      } catch {",
    "        // Descriptors can close while the directory is being inspected.",
    "      }",
    "    }",
    "    const status = await Deno.readTextFile(`/proc/${ancestorPid}/status`);",
    "    const match = /^PPid:\\s*(\\d+)$/m.exec(status);",
    "    if (!match) break;",
    "    const nextPid = Number(match[1]);",
    "    if (!Number.isSafeInteger(nextPid) || nextPid === ancestorPid) break;",
    "    ancestorPid = nextPid;",
    "  } catch {",
    "    break;",
    "  }",
    "}",
  ].join("\n");
  const descendantScript = [
    descriptorScript,
    "const input = new Uint8Array(1);",
    "const stdinRead = await Deno.stdin.read(input);",
    `await Deno.writeTextFile(${marker}, JSON.stringify({`,
    "  pid: Deno.pid,",
    `  envCanary: Deno.env.get(${canaryName}) ?? null,`,
    '  stdin: stdinRead === null ? "eof" : "data",',
    "  descriptorTargets,",
    "  ancestorDescriptorTargets,",
    "}));",
  ].join("\n");
  const script = [
    descriptorScript,
    "const input = new Uint8Array(1);",
    "const stdinRead = await Deno.stdin.read(input);",
    "const detached = new Deno.Command(Deno.execPath(), {",
    `  args: ["eval", ${JSON.stringify(descendantScript)}],`,
    '  detached: true, stdin: "null", stdout: "null", stderr: "null",',
    "}).spawn();",
    "let descendantObserved = false;",
    "for (let attempt = 0; attempt < 100; attempt++) {",
    `  try { await Deno.stat(${marker}); descendantObserved = true; break; } catch {`,
    "    const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, 10); await promise;",
    "  }",
    "}",
    "await detached.status;",
    `const descendantObservation = JSON.parse(await Deno.readTextFile(${marker}));`,
    "await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({",
    "  pid: Deno.pid,",
    `  envCanary: Deno.env.get(${canaryName}) ?? null,`,
    '  stdin: stdinRead === null ? "eof" : "data",',
    "  descriptorTargets,",
    "  ancestorDescriptorTargets,",
    "  descendantObservation,",
    "})));",
  ].join("\n");
  return {
    action: "harness.implement",
    executable: Deno.execPath(),
    args: ["eval", script],
  };
}

async function recoverCrashWindow(
  crashWindow: "after-create" | "after-remove",
): Promise<void> {
  const directory = await Deno.makeTempDir({
    prefix: `bakery-native-${crashWindow}-`,
  });
  const markerPath = `${directory}/window.json`;
  const childPath =
    new URL("./native-worker-executor-child.ts", import.meta.url).pathname;
  const worker = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-all",
      childPath,
      cgroupRoot!,
      directory,
      markerPath,
      crashWindow,
    ],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  try {
    await waitForFile(markerPath);
    const sidecarDirectory = `${directory}/native-executions`;
    const sidecars = [];
    for await (const entry of Deno.readDir(sidecarDirectory)) {
      if (entry.name.endsWith("-boundary.json")) sidecars.push(entry.name);
    }
    assertEquals(sidecars.length, 1);
    const sidecarPath = `${sidecarDirectory}/${sidecars[0]}`;
    const identity = JSON.parse(
      await Deno.readTextFile(sidecarPath),
    ) as { phase: string; cgroupPath: string };
    assertEquals(
      identity.phase,
      crashWindow === "after-create" ? "provisioning" : "terminating",
    );
    assertEquals(
      await pathExists(identity.cgroupPath),
      crashWindow === "after-create",
    );
    worker.kill("SIGKILL");
    await worker.status;
    await createNativeExecutor({
      cgroupRoot: cgroupRoot!,
      stateDir: directory,
      terminationGraceMs: 600,
      probeIntervalMs: 10,
    }).initialize!();
    assertEquals(await pathExists(identity.cgroupPath), false);
    const remaining = [];
    for await (const entry of Deno.readDir(sidecarDirectory)) {
      remaining.push(entry.name);
    }
    assertEquals(remaining, []);
  } finally {
    try {
      worker.kill("SIGKILL");
    } catch {
      // The worker already exited.
    }
    await worker.status.catch(() => undefined);
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
}

function detachedDescendantAction(): NativeActionDefinition {
  const descendantScript = JSON.stringify("setInterval(() => {}, 1000);");
  const script = [
    `const detached = new Deno.Command(Deno.execPath(), {`,
    `args: ["eval", ${descendantScript}], detached: true, stdout: "null", stderr: "null"}).spawn();`,
    "await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({",
    "  parent: Deno.pid,",
    "  detached: detached.pid,",
    "})));",
    "await new Promise(() => {});",
  ].join("\n");
  return {
    action: "harness.implement",
    executable: Deno.execPath(),
    args: ["eval", script],
  };
}

Deno.test("native executor keeps deterministic behavior without a boundary", async () => {
  const deterministic = await createDeterministicExecutor().execute(
    localAssignment(),
    new AbortController().signal,
  );
  assertEquals(deterministic.status, "failed");
});

Deno.test("native executor fails closed without delegated cgroup v2", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-native-unavailable-",
  });
  try {
    const executor = createNativeExecutor({
      cgroupRoot: directory,
      stateDir: directory,
    });
    await assertRejects(
      () => executor.initialize!(),
      NativeExecutorError,
      "NATIVE_CGROUP_UNAVAILABLE",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

nativeTest(
  "native runtime closure rejects a supervisor secret root under a runtime mount",
  async () => {
    const stateDir = await Deno.makeTempDir({
      prefix: "bakery-native-runtime-secret-",
    });
    try {
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir,
        supervisorSecretPaths: [dirname(Deno.execPath())],
      });
      await assertRejects(
        () => executor.initialize!(),
        NativeExecutorError,
        "NATIVE_SECRET_MOUNT_OVERLAP",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native runtime mounts do not expose a credential beside the executable",
  async () => {
    const runtimeRoot = await Deno.makeTempDir({
      prefix: "bakery-native-runtime-root-",
    });
    const stateDir = await Deno.makeTempDir({
      prefix: "bakery-native-runtime-state-",
    });
    const executable = join(runtimeRoot, "deno");
    const credential = join(runtimeRoot, "worker-credential");
    try {
      await Deno.copyFile(Deno.execPath(), executable);
      await Deno.chmod(executable, 0o700);
      await Deno.writeTextFile(credential, "credential-not-for-actions\n");
      await Deno.chmod(credential, 0o600);
      const script = [
        `let visible = false;`,
        `try { await Deno.stat(${
          JSON.stringify(credential)
        }); visible = true; } catch {}`,
        `await Deno.stdout.write(new TextEncoder().encode(visible ? "visible" : "absent"));`,
      ].join("\n");
      const observed: Uint8Array[] = [];
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir,
        supervisorSecretPaths: [credential],
        actions: [{
          action: "harness.implement",
          executable,
          args: ["eval", script],
        }],
        terminationGraceMs: 600,
        probeIntervalMs: 10,
      });
      const outcome = await executor.execute(
        localAssignment(),
        new AbortController().signal,
        {
          write(channel, chunk) {
            if (channel === "stdout") observed.push(chunk.slice());
            return Promise.resolve();
          },
          sourceLost() {
            throw new Error("UNEXPECTED_NATIVE_OUTPUT_LOSS");
          },
        },
      );
      assertEquals(outcome.status, "failed");
      const bytes = new Uint8Array(
        observed.reduce((length, chunk) => length + chunk.length, 0),
      );
      let offset = 0;
      for (const chunk of observed) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      assertEquals(new TextDecoder().decode(bytes), "absent");
    } finally {
      await Deno.remove(runtimeRoot, { recursive: true }).catch(() =>
        undefined
      );
      await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native wrapper forwards both inner process pipes to the capture sink",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-output-",
    });
    const observed: Record<NativeOutputChannel, Uint8Array[]> = {
      stdout: [],
      stderr: [],
    };
    const sink: NativeOutputSink = {
      write(channel, chunk) {
        observed[channel].push(chunk.slice());
        return Promise.resolve();
      },
      sourceLost() {
        throw new Error("UNEXPECTED_NATIVE_OUTPUT_LOSS");
      },
    };
    try {
      const script = [
        'await Deno.stdout.write(new TextEncoder().encode("inner-out\\n"));',
        'await Deno.stderr.write(new TextEncoder().encode("inner-err\\n"));',
      ].join("\n");
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        actions: [{
          action: "harness.implement",
          executable: Deno.execPath(),
          args: ["eval", script],
        }],
        terminationGraceMs: 600,
        probeIntervalMs: 10,
      });
      const outcome = await executor.execute(
        localAssignment(),
        new AbortController().signal,
        sink,
      );
      assertEquals(outcome.status, "failed");
      const decode = (chunks: Uint8Array[]) => {
        const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const all = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          all.set(chunk, offset);
          offset += chunk.length;
        }
        return new TextDecoder().decode(all);
      };
      assertEquals(decode(observed.stdout), "inner-out\n");
      assertEquals(decode(observed.stderr), "inner-err\n");
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);
nativeTest(
  "native action isolates parent env, stdin, files, sockets, and pipes",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-descriptor-isolation-",
    });
    const markerPath = `${directory}/descendant.json`;
    const parentFilePath = `${directory}/parent-control.txt`;
    const parentFileCanary = `parent-open-file-${crypto.randomUUID()}`;
    const parentEnvCanary = `parent-env-${crypto.randomUUID()}`;
    const previousCanary = Deno.env.get(PARENT_ENV_CANARY);
    let parentFile: Deno.FsFile | undefined;
    let controlProcess: Deno.ChildProcess | undefined;
    let listener: Deno.Listener | undefined;
    try {
      Deno.env.set(PARENT_ENV_CANARY, parentEnvCanary);
      await Deno.writeTextFile(parentFilePath, parentFileCanary);
      const before = await readProcFdTargets();
      parentFile = await Deno.open(parentFilePath, { read: true });
      controlProcess = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "const { promise } = Promise.withResolvers(); await promise;",
        ],
        stdin: "piped",
        stdout: "null",
        stderr: "null",
      }).spawn();
      listener = Deno.listen({
        transport: "tcp",
        hostname: "127.0.0.1",
        port: 0,
      });
      const after = await readProcFdTargets();
      const baselineCounts = new Map<string, number>();
      for (const target of before) {
        baselineCounts.set(target, (baselineCounts.get(target) ?? 0) + 1);
      }
      const introduced: string[] = [];
      for (const target of after) {
        const count = baselineCounts.get(target) ?? 0;
        if (count === 0) {
          introduced.push(target);
        } else {
          baselineCounts.set(target, count - 1);
        }
      }
      const parentDescriptorTargets = introduced.filter((target) =>
        target === parentFilePath ||
        target.startsWith("pipe:[") ||
        target.startsWith("socket:[")
      );
      assertEquals(parentDescriptorTargets.includes(parentFilePath), true);
      assertEquals(
        parentDescriptorTargets.some((target) => target.startsWith("pipe:[")),
        true,
      );
      assertEquals(
        parentDescriptorTargets.some((target) => target.startsWith("socket:[")),
        true,
      );

      const observed: Record<NativeOutputChannel, Uint8Array[]> = {
        stdout: [],
        stderr: [],
      };
      const sink: NativeOutputSink = {
        write(channel, chunk) {
          observed[channel].push(chunk.slice());
          return Promise.resolve();
        },
        sourceLost() {
          throw new Error("UNEXPECTED_NATIVE_OUTPUT_LOSS");
        },
      };
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        actions: [descriptorInspectionAction(markerPath)],
        terminationGraceMs: 600,
        probeIntervalMs: 10,
      });
      const outcome = await executor.execute(
        localAssignment(),
        new AbortController().signal,
        sink,
      );
      assertEquals(outcome.status, "failed");

      const decode = (chunks: Uint8Array[]) => {
        const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const all = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          all.set(chunk, offset);
          offset += chunk.length;
        }
        return new TextDecoder().decode(all);
      };
      const capturedStdout = decode(observed.stdout);
      const capturedStderr = decode(observed.stderr);
      const actionObservation = JSON.parse(capturedStdout) as {
        pid: number;
        envCanary: string | null;
        stdin: string;
        descriptorTargets: string[];
        ancestorDescriptorTargets: string[];
        descendantObservation: {
          pid: number;
          envCanary: string | null;
          stdin: string;
          descriptorTargets: string[];
          ancestorDescriptorTargets: string[];
        };
      };
      const descendantObservation = actionObservation.descendantObservation;
      assertEquals(actionObservation.pid !== Deno.pid, true);
      assertEquals(descendantObservation.pid !== actionObservation.pid, true);
      assertEquals(actionObservation.envCanary, null);
      assertEquals(descendantObservation.envCanary, null);
      assertEquals(actionObservation.stdin, "eof");
      assertEquals(descendantObservation.stdin, "eof");
      assertEquals(capturedStderr, "");
      assertEquals(capturedStdout.includes(parentEnvCanary), false);
      assertEquals(capturedStdout.includes(parentFileCanary), false);
      const procfsLeaks: string[] = [];
      for (const target of parentDescriptorTargets) {
        assertEquals(
          actionObservation.descriptorTargets.includes(target),
          false,
        );
        assertEquals(
          descendantObservation.descriptorTargets.includes(target),
          false,
        );
        if (actionObservation.ancestorDescriptorTargets.includes(target)) {
          procfsLeaks.push(`action:${target}`);
        }
        if (
          descendantObservation.ancestorDescriptorTargets.includes(target)
        ) {
          procfsLeaks.push(`descendant:${target}`);
        }
      }
      assertEquals(
        procfsLeaks,
        [],
        "NATIVE_PROCFS_PARENT_DESCRIPTOR_VISIBLE",
      );
    } finally {
      parentFile?.close();
      listener?.close();
      if (controlProcess) {
        try {
          controlProcess.kill("SIGKILL");
        } catch {
          // The control process already exited.
        }
        await controlProcess.status.catch(() => undefined);
      }
      if (previousCanary === undefined) {
        Deno.env.delete(PARENT_ENV_CANARY);
      } else {
        Deno.env.set(PARENT_ENV_CANARY, previousCanary);
      }
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native action reads and runs an authorized prepared skill root",
  async () => {
    const stateDir = await Deno.makeTempDir({
      prefix: "bakery-native-authorized-root-",
    });
    try {
      const assignment = {
        ...localAssignment(),
        action: "quality.check",
        workerSessionId: crypto.randomUUID(),
        workerSessionGeneration: "1",
        skillRefs: [{
          versionId: crypto.randomUUID(),
          digest: "a".repeat(64),
        }],
      };
      const organizationId = crypto.randomUUID();
      const owner = {
        workerHostId: assignment.workerHostId,
        workerSessionId: assignment.workerSessionId,
        workerSessionGeneration: assignment.workerSessionGeneration,
        jobId: assignment.jobId,
        attemptId: assignment.attemptId,
        fence: String(assignment.fence),
      };
      const cacheRoot = join(stateDir, "skill-materialization-v1");
      const attemptRoot = join(
        cacheRoot,
        "attempts",
        owner.workerHostId,
        owner.workerSessionId,
        owner.workerSessionGeneration,
        owner.attemptId,
        owner.fence,
      );
      const copyId = crypto.randomUUID();
      const copyRoot = join(attemptRoot, copyId);
      const rootPath = join(copyRoot, "tree");
      const binPath = join(rootPath, "bin");
      await Deno.mkdir(binPath, { recursive: true, mode: 0o700 });
      await Deno.chmod(cacheRoot, 0o700);
      await Deno.chmod(rootPath, 0o700);
      await Deno.chmod(binPath, 0o700);
      await Deno.writeTextFile(
        join(rootPath, "SKILL.md"),
        "authorized skill read proof\n",
      );
      await Deno.chmod(join(rootPath, "SKILL.md"), 0o600);
      await Deno.writeTextFile(
        join(binPath, "run.sh"),
        '#!/bin/sh\nprintf "authorized-skill-run\\n"\n',
      );
      await Deno.chmod(join(binPath, "run.sh"), 0o700);
      const cacheInfo = await Deno.lstat(cacheRoot);
      const uid = Deno.uid();
      assert(uid !== null);
      await Deno.writeTextFile(
        join(copyRoot, "owner.json"),
        JSON.stringify({
          ...owner,
          copyId,
          dev: String(cacheInfo.dev),
          ino: String(cacheInfo.ino),
          uid,
          organizationId,
          versionId: assignment.skillRefs[0].versionId,
          digest: assignment.skillRefs[0].digest,
        }),
      );
      await Deno.chmod(join(copyRoot, "owner.json"), 0o600);
      const script = [
        `const roots = JSON.parse(Deno.env.get(${
          JSON.stringify(NATIVE_SKILL_ROOTS_ENV)
        }) ?? "[]");`,
        'if (roots.length !== 1) throw new Error("AUTHORIZED_ROOT_COUNT");',
        "const root = roots[0];",
        'const entry = await Deno.readTextFile(root + "/SKILL.md");',
        'const run = await new Deno.Command(root + "/bin/run.sh", { stdout: "piped", stderr: "piped" }).output();',
        'if (!run.success) throw new Error("AUTHORIZED_ROOT_EXECUTION_FAILED");',
        "await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({",
        "  entry,",
        "  run: new TextDecoder().decode(run.stdout),",
        "})));",
      ].join("\n");
      const observed: Uint8Array[] = [];
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir,
        actions: [{
          action: "quality.check",
          executable: Deno.execPath(),
          args: ["eval", script],
        }],
        terminationGraceMs: 600,
        probeIntervalMs: 10,
      });
      const preparedSkills = {
        owner,
        roots: [{
          ...owner,
          organizationId,
          versionId: assignment.skillRefs[0].versionId,
          digest: assignment.skillRefs[0].digest,
          rootPath,
          entryPath: "SKILL.md",
        }],
        release: () => Promise.resolve(),
      };
      const outcome = await executor.execute(
        assignment,
        new AbortController().signal,
        {
          write(channel, chunk) {
            if (channel === "stdout") observed.push(chunk.slice());
            return Promise.resolve();
          },
          sourceLost() {
            throw new Error("UNEXPECTED_NATIVE_OUTPUT_LOSS");
          },
        },
        preparedSkills,
      );
      assertEquals(outcome.status, "failed");
      const bytes = new Uint8Array(
        observed.reduce((length, chunk) => length + chunk.length, 0),
      );
      let offset = 0;
      for (const chunk of observed) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      assertEquals(JSON.parse(new TextDecoder().decode(bytes)), {
        entry: "authorized skill read proof\n",
        run: "authorized-skill-run\n",
      });
    } finally {
      await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native inspection source failure is accepted by the result wire contract",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-inspection-failure-",
    });
    try {
      const assignment = { ...localAssignment(), action: "repository.inspect" };
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        loadInspectionSource: () =>
          Promise.reject(new Error("INSPECTION_SOURCE_UNAVAILABLE")),
      });
      const outcome = await executor.execute(
        assignment,
        new AbortController().signal,
      );
      assertEquals(outcome.status, "failed");
      const result = contractSchemas.WorkerResult.parse({
        leaseToken: assignment.leaseToken,
        fence: String(assignment.fence),
        localSeq: "1",
        workerSessionId: assignment.workerSessionId,
        workerSessionGeneration: assignment.workerSessionGeneration,
        ...outcomeResult(outcome),
      });
      assert(result.status === "failed");
      assertEquals(result.fault.code, "INSPECTION_EXECUTION_FAILED");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
);

nativeTest(
  "native cgroup cleanup kills detached descendants and preserves unrelated processes",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-cgroup-",
    });
    const unrelated = new Deno.Command(Deno.execPath(), {
      args: ["eval", "setInterval(() => {}, 1000);"],
      stdout: "null",
      stderr: "null",
    }).spawn();
    const observed: Uint8Array[] = [];
    const output: NativeOutputSink = {
      write(channel, chunk) {
        if (channel === "stdout") observed.push(chunk.slice());
        return Promise.resolve();
      },
      sourceLost() {
        throw new Error("UNEXPECTED_NATIVE_OUTPUT_LOSS");
      },
    };
    const controller = new AbortController();
    try {
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        actions: [detachedDescendantAction()],
        terminationGraceMs: 600,
        probeIntervalMs: 10,
      });
      const execution = executor.execute(
        localAssignment(),
        controller.signal,
        output,
      );
      for (let attempt = 0; attempt < 500 && observed.length === 0; attempt++) {
        await wait(10);
      }
      assert(observed.length > 0);
      assertEquals(await processExists(unrelated.pid), true);
      controller.abort();
      const outcome = await execution;
      assertEquals(outcome.status, "canceled");
      if (outcome.status !== "canceled") return;
      const cancellation = outcome.cancellation as Record<string, unknown>;
      assertEquals(cancellation.processExited, true);
      assertEquals(cancellation.cleanupStatus, "complete");
      assertEquals(cancellation.terminationStatus, "confirmed");
      assert(
        (await Deno.readTextFile(`${cgroupRoot}/cgroup.events`)).includes(
          "populated 0",
        ),
      );
      assertEquals(await processExists(unrelated.pid), true);
    } finally {
      unrelated.kill("SIGKILL");
      await unrelated.status;
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native restart cleanup removes descendants after worker SIGKILL",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-crash-",
    });
    const markerPath = `${directory}/worker.json`;
    const childPath =
      new URL("./native-worker-executor-child.ts", import.meta.url)
        .pathname;
    const worker = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-check",
        "--allow-all",
        childPath,
        cgroupRoot!,
        directory,
        markerPath,
      ],
      stdout: "null",
      stderr: "inherit",
    }).spawn();
    try {
      await waitForFile(markerPath);
      const sidecarDirectory = `${directory}/native-executions`;
      const sidecars = [];
      for await (const entry of Deno.readDir(sidecarDirectory)) {
        if (entry.name.endsWith("-boundary.json")) sidecars.push(entry.name);
      }
      assertEquals(sidecars.length, 1);
      const identity = JSON.parse(
        await Deno.readTextFile(`${sidecarDirectory}/${sidecars[0]}`),
      ) as { cgroupPath: string };
      worker.kill("SIGKILL");
      await worker.status;
      await createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        terminationGraceMs: 600,
      }).initialize!();
      assertEquals(await pathExists(identity.cgroupPath), false);
    } finally {
      try {
        worker.kill("SIGKILL");
      } catch {
        // The worker already exited.
      }
      await worker.status.catch(() => undefined);
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native SIGKILL after cgroup creation reconciles provisioning state",
  () => recoverCrashWindow("after-create"),
);

nativeTest(
  "native SIGKILL after cgroup removal reconciles terminating state",
  () => recoverCrashWindow("after-remove"),
);

nativeTest(
  "native startup reclaims owned orphan boundaries and temp sidecars only",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-orphan-",
    });
    const orphanId = crypto.randomUUID();
    const probeId = crypto.randomUUID();
    const unrelatedId = crypto.randomUUID();
    const orphanPath = `${cgroupRoot}/bakery-native-${orphanId}`;
    const probePath = `${cgroupRoot}/bakery-native-probe-${probeId}`;
    const unrelatedPath = `${cgroupRoot}/bakery-unrelated-${unrelatedId}`;
    const tempSidecar =
      `${directory}/native-executions/bakery-native-${orphanId}-boundary.json.tmp-${crypto.randomUUID()}`;
    try {
      await Deno.mkdir(orphanPath);
      await Deno.mkdir(probePath);
      await Deno.mkdir(unrelatedPath);
      await Deno.mkdir(`${directory}/native-executions`, { recursive: true });
      await Deno.writeTextFile(tempSidecar, "{}");
      await createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        terminationGraceMs: 600,
        probeIntervalMs: 10,
      }).initialize!();
      assertEquals(await pathExists(probePath), false);
      assertEquals(await pathExists(orphanPath), false);
      assertEquals(await pathExists(tempSidecar), false);
      assertEquals(await pathExists(unrelatedPath), true);
    } finally {
      await Deno.remove(orphanPath, { recursive: true }).catch(() => undefined);
      await Deno.remove(probePath, { recursive: true }).catch(() => undefined);
      await Deno.remove(unrelatedPath).catch(() => undefined);
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native recovery completes stale boundaries before a failing sandbox probe",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-stale-probe-",
    });
    const boundaryId = crypto.randomUUID();
    const cgroupPath = `${cgroupRoot}/bakery-native-${boundaryId}`;
    const sidecarDirectory = `${directory}/native-executions`;
    const sidecarPath =
      `${sidecarDirectory}/bakery-native-${boundaryId}-boundary.json`;
    const sourcePath = `${sidecarDirectory}/bakery-native-${boundaryId}-source`;
    try {
      await Deno.mkdir(cgroupPath);
      await Deno.mkdir(sidecarDirectory, { recursive: true });
      await Deno.mkdir(sourcePath);
      const info = await Deno.lstat(cgroupPath);
      await Deno.writeTextFile(
        sidecarPath,
        JSON.stringify({
          type: "cgroup-v2",
          phase: "active",
          boundaryId,
          attemptId: "stale-attempt",
          assignmentFence: "1",
          cgroupRoot,
          cgroupPath,
          cgroupDevice: String(info.dev),
          cgroupInode: String(info.ino),
          sidecarPath,
        }),
      );
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        terminationGraceMs: 600,
        probeIntervalMs: 10,
        testHooks: {
          beforeSandboxProbe: async () => {
            assertEquals(await pathExists(cgroupPath), false);
            assertEquals(await pathExists(sidecarPath), false);
            assertEquals(await pathExists(sourcePath), false);
            throw new Error("INJECTED_NATIVE_SANDBOX_PROBE_FAILURE");
          },
        },
      });
      await assertRejects(
        () => executor.initialize!(),
        NativeExecutorError,
        "NATIVE_SANDBOX_UNAVAILABLE",
      );
      assertEquals(await pathExists(cgroupPath), false);
      assertEquals(await pathExists(sidecarPath), false);
      assertEquals(await pathExists(sourcePath), false);
    } finally {
      await Deno.remove(cgroupPath, { recursive: true }).catch(() => undefined);
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native attach revocation fails closed without releasing a boundary",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-attach-fault-",
    });
    let revoked = false;
    try {
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        testHooks: {
          beforeCgroupWrite: (operation) => {
            if (revoked && operation === "attach") {
              throw new Error("INJECTED_ATTACH_REVOCATION");
            }
          },
        },
      });
      await executor.initialize!();
      revoked = true;
      await assertRejects(
        () => executor.execute(localAssignment(), new AbortController().signal),
        NativeExecutorError,
        "NATIVE_CGROUP_BOUNDARY_FAILED",
      );
      const remaining = [];
      for await (
        const entry of Deno.readDir(`${directory}/native-executions`)
      ) {
        remaining.push(entry.name);
      }
      assertEquals(remaining, []);
    } finally {
      revoked = false;
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native kill revocation drains durably and recovers on restart",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-kill-fault-",
    });
    let revoked = false;
    try {
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        testHooks: {
          beforeCgroupWrite: (operation) => {
            if (revoked && operation === "kill") {
              throw new Error("INJECTED_KILL_REVOCATION");
            }
          },
        },
      });
      await executor.initialize!();
      revoked = true;
      await assertRejects(
        () => executor.execute(localAssignment(), new AbortController().signal),
        NativeExecutorError,
        "NATIVE_CGROUP_CLEANUP_FAILED",
      );
      const sidecars = [];
      for await (
        const entry of Deno.readDir(`${directory}/native-executions`)
      ) {
        if (entry.name.endsWith("-boundary.json")) sidecars.push(entry.name);
      }
      assertEquals(sidecars.length, 1);
      const identity = JSON.parse(
        await Deno.readTextFile(
          `${directory}/native-executions/${sidecars[0]}`,
        ),
      ) as { phase: string; cgroupPath: string };
      assertEquals(identity.phase, "terminating");
      assertEquals(await pathExists(identity.cgroupPath), true);
      revoked = false;
      await createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        terminationGraceMs: 600,
        probeIntervalMs: 10,
      }).initialize!();
      assertEquals(await pathExists(identity.cgroupPath), false);
      const remaining = [];
      for await (
        const entry of Deno.readDir(`${directory}/native-executions`)
      ) {
        remaining.push(entry.name);
      }
      assertEquals(remaining, []);
    } finally {
      revoked = false;
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

nativeTest(
  "native identity fence refuses a replaced boundary before signaling",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-fence-",
    });
    const controller = new AbortController();
    let execution: Promise<ExecutionOutcome> | undefined;
    const observed: Uint8Array[] = [];
    const output: NativeOutputSink = {
      write(channel, chunk) {
        if (channel === "stdout") observed.push(chunk.slice());
        return Promise.resolve();
      },
      sourceLost() {
        throw new Error("UNEXPECTED_NATIVE_OUTPUT_LOSS");
      },
    };
    try {
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        actions: [detachedDescendantAction()],
        terminationGraceMs: 600,
        probeIntervalMs: 10,
      });
      execution = executor.execute(
        localAssignment(),
        controller.signal,
        output,
      );
      for (let attempt = 0; attempt < 500 && observed.length === 0; attempt++) {
        await wait(10);
      }
      assert(observed.length > 0);
      const sidecars = [];
      for await (
        const entry of Deno.readDir(`${directory}/native-executions`)
      ) {
        sidecars.push(entry.name);
      }
      assertEquals(sidecars.length, 1);
      const sidecarPath = `${directory}/native-executions/${sidecars[0]}`;
      const identity = JSON.parse(
        await Deno.readTextFile(sidecarPath),
      ) as Record<string, unknown>;
      identity.cgroupInode = "replaced-boundary";
      await Deno.writeTextFile(sidecarPath, JSON.stringify(identity));
      const restarted = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        terminationGraceMs: 100,
        probeIntervalMs: 10,
      });
      await assertRejects(
        () => restarted.initialize!(),
        NativeExecutorError,
        "NATIVE_CGROUP_IDENTITY_MISMATCH",
      );
      assert(
        (
          await Deno.readTextFile(
            `${String(identity.cgroupPath)}/cgroup.events`,
          )
        ).includes("populated 1"),
      );
      controller.abort();
      const outcome = await execution!;
      assertEquals(outcome.status, "canceled");
    } finally {
      controller.abort();
      await execution?.catch(() => undefined);
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  },
);

Deno.test("native action definitions reject remote-shaped command values", () => {
  assertThrows(
    () =>
      createNativeExecutor({
        cgroupRoot: "/tmp",
        stateDir: "/tmp/bakery-native-test",
        actions: [{
          action: "harness.implement",
          executable: "deno",
          args: ["eval", "Deno.exit(0)"],
        }],
      }),
    NativeExecutorError,
    "NATIVE_ACTION_ALLOWLIST_INVALID",
  );
});

nativeTest(
  "saturated real native capture cannot delay cancellation cleanup or close after lease loss",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "bakery-native-saturated-",
    });
    const controller = new AbortController();
    let execution: Promise<ExecutionOutcome> | undefined;
    try {
      const assignment = localAssignment();
      const spool = await EventSpool.open({
        path: `${directory}/spool.json`,
        maxRecords: 1000,
        maxBytes: 1024 * 1024,
      });
      await spool.reserveTerminal(
        assignment.attemptId,
        terminalReservationBytes(assignment),
      );
      let saturated = false;
      const capture = new NativeOutputCapture({
        assignment,
        spool,
        client: null as unknown as WorkerApiClient,
        workerSessionId: assignment.workerSessionId!,
        workerSessionGeneration: "1",
        binding: {
          sessionId: crypto.randomUUID(),
          organizationId: crypto.randomUUID(),
          applicationId: crypto.randomUUID(),
          jobId: assignment.jobId,
          taskId: null,
          runStepId: null,
          conversationId: null,
          logicalActor: "harness.implement:native",
          attemptId: assignment.attemptId,
          workerHostId: assignment.workerHostId,
          workerSessionId: assignment.workerSessionId!,
          workerSessionGeneration: "1",
          fence: "1",
          writerGeneration: "1",
          highwater: "0",
          nextSequence: "1",
          closed: false,
          capture: "capturing",
          reason: null,
          archive: "pending",
        },
        configuredSecrets: ["native-synthetic-secret"],
        leaseActive: () => !controller.signal.aborted,
        waitForAck: () => {
          saturated = true;
          assertEquals(spool.outputDepth(assignment.attemptId).records, 24);
          controller.abort();
          return Promise.resolve();
        },
      });
      const executor = createNativeExecutor({
        cgroupRoot: cgroupRoot!,
        stateDir: directory,
        terminationGraceMs: 600,
        probeIntervalMs: 10,
        actions: [{
          action: "harness.implement",
          executable: Deno.execPath(),
          args: [
            "eval",
            'while (true) { await Deno.stdout.write(new TextEncoder().encode("safe native-\\x1b[31msynthetic-secret\\n")); await new Promise(r => setTimeout(r, 2)); }',
          ],
        }],
      });
      execution = executor.execute(assignment, controller.signal, capture);
      const outcome = await execution;
      assertEquals(saturated, true);
      assertEquals(outcome.status, "canceled");
      if (outcome.status !== "canceled") {
        throw new Error("EXPECTED_CANCELLATION");
      }
      const cancellation = outcome.cancellation as Record<string, unknown>;
      assertEquals(cancellation.processExited, true);
      assertEquals(cancellation.cleanupStatus, "complete");
      assertEquals(cancellation.terminationStatus, "confirmed");
      assertEquals(await capture.finish(), null);
      assertEquals(spool.pendingOutputCloses(), []);
      assertEquals(spool.journalState(assignment.attemptId).ackedLocalSeq, "0");
      assertEquals(
        (await Deno.readTextFile(`${directory}/spool.json`)).includes(
          "native-synthetic-secret",
        ),
        false,
      );
      assertEquals(spool.outputDepth(assignment.attemptId).records, 24);
    } finally {
      controller.abort();
      await execution;
      await Deno.remove(directory, { recursive: true });
    }
  },
);
