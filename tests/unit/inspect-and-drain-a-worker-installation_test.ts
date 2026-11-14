import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootstrapError,
  describeChecks,
  describeStatus,
  doctor,
  doctorExitCode,
  installationStatus,
  linuxServiceState,
  macServiceState,
  PAIRING_FILE,
  parseOperation,
  planDrain,
  type Probes,
  runOperation,
  type ServiceState,
  spawnProgram,
  spawnWithTimeout,
  systemProbes,
  TOKEN_FILE,
} from "../../packages/worker-bootstrap/src/index.ts";

// #18 slice 3: `status`, `doctor` and `drain`. They read an install root and ask
// injected probes about the machine; they change nothing, and `drain` names the
// one command for the operator instead of running it.

const BINARY = new TextEncoder().encode(
  "#!/bin/sh\necho bakery worker 1.2.3\n",
);
const DIGEST = createHash("sha256").update(BINARY).digest("hex");
const GIB = 1024 ** 3;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bakery-operate-"));
  await chmod(root, 0o700);
  return root;
}

/** What slice 1 leaves behind: a release directory with its record, and `current` pointing at it. */
async function installRelease(
  root: string,
  overrides: Record<string, unknown> = {},
  binary: Uint8Array = BINARY,
): Promise<void> {
  const release = join(root, "releases", "1.2.3-linux-x64");
  await mkdir(release, { recursive: true });
  await writeFile(join(release, "bakery-worker"), binary, { mode: 0o755 });
  await writeFile(
    join(release, "release.json"),
    JSON.stringify({
      release: "1.2.3",
      target: "linux-x64",
      file: "bakery-worker",
      size: BINARY.length,
      sha256: DIGEST,
      keyId: "k1",
      stateFormat: 1,
      protocol: { min: 1, max: 1 },
      installedAt: "2026-11-14T00:00:00.000Z",
      ...overrides,
    }),
  );
  await symlink(join("releases", "1.2.3-linux-x64"), join(root, "current"));
}

async function pairRoot(
  root: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(root, PAIRING_FILE),
    JSON.stringify({
      version: 1,
      serverOrigin: "https://bakery.example",
      organizationName: "Acme",
      enrollmentId: "00000000-0000-4000-8000-0000000000e1",
      name: "build-linux-01",
      boundAt: "2026-11-14T00:00:00.000Z",
      ...overrides,
    }),
    { mode: 0o600 },
  );
}

type FakeOptions = Partial<{
  service: ServiceState | "throws";
  runs: boolean | "throws";
  free: number | null | "throws";
  uid: number | null;
}>;

function fakeProbes(options: FakeOptions = {}) {
  const calls: string[] = [];
  const probes: Probes = {
    serviceState: () => {
      calls.push("serviceState");
      if (options.service === "throws") return Promise.reject(new Error("x"));
      return Promise.resolve(options.service ?? "active");
    },
    runs: (argv) => {
      calls.push(`runs ${argv.join(" ")}`);
      if (options.runs === "throws") return Promise.reject(new Error("x"));
      return Promise.resolve(options.runs ?? true);
    },
    freeBytes: () => {
      calls.push("freeBytes");
      if (options.free === "throws") return Promise.reject(new Error("x"));
      return Promise.resolve(
        options.free === undefined ? 10 * GIB : options.free,
      );
    },
    uid: () => (options.uid === undefined ? 1000 : options.uid),
  };
  return { probes, calls };
}

async function healthyRoot(): Promise<string> {
  const root = await tempRoot();
  await installRelease(root);
  await pairRoot(root);
  await writeFile(join(root, "worker.env"), "BAKERY_X=1\n", { mode: 0o600 });
  return root;
}

const statusOf = (
  checks: readonly { id: string; status: string }[],
  id: string,
) => checks.find((check) => check.id === id)?.status;

Deno.test("status of an empty root says so: not installed, not paired, service as the probe says", async () => {
  const root = await tempRoot();
  try {
    const { probes } = fakeProbes({ service: "absent" });
    const report = await installationStatus(root, probes);
    assertEquals(report.installation.state, "not-installed");
    assertEquals(report.pairing.state, "unpaired");
    assertEquals(
      describeStatus(report),
      "Installed: no\nPaired: no\nService: absent\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("status of a healthy installation names the release, the organization and the service", async () => {
  const root = await healthyRoot();
  try {
    const report = await installationStatus(root, fakeProbes().probes);
    const text = describeStatus(report);
    assertStringIncludes(text, "Installed: release 1.2.3 for linux-x64\n");
    assertStringIncludes(
      text,
      "Paired: Acme (https://bakery.example) as build-linux-01 since 2026-11-14T00:00:00.000Z\n",
    );
    assertStringIncludes(text, "Service: active\n");
    assertEquals(report.installation, {
      state: "installed",
      release: "1.2.3",
      target: "linux-x64",
      intact: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a binary that no longer has its signed digest is reported, not hidden", async () => {
  const root = await tempRoot();
  try {
    await installRelease(root, {}, new TextEncoder().encode("tampered"));
    const report = await installationStatus(root, fakeProbes().probes);
    assertEquals(report.installation.state, "installed");
    assertEquals((report.installation as { intact: boolean }).intact, false);
    assertStringIncludes(
      describeStatus(report),
      "no longer matches its signed digest",
    );
    const checks = await doctor(root, fakeProbes().probes);
    assertEquals(statusOf(checks, "install"), "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a release whose binary is gone is not intact", async () => {
  const root = await tempRoot();
  try {
    await installRelease(root);
    await rm(join(root, "releases", "1.2.3-linux-x64", "bakery-worker"));
    const report = await installationStatus(root, fakeProbes().probes);
    assertEquals(report.installation, {
      state: "installed",
      release: "1.2.3",
      target: "linux-x64",
      intact: false,
    });
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "install"),
      "failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("text read back from the root never reaches the screen unless it is safe to show", async () => {
  const hostile = [
    "\u001b[2K\rOrganization: Acme (your own)",
    "Acme\nPaired: yes",
    "Acme‮",
    "ㅤ",
    "",
    "x".repeat(500),
  ];
  for (const bad of hostile) {
    for (
      const field of ["organizationName", "name", "serverOrigin", "boundAt"]
    ) {
      const root = await tempRoot();
      try {
        await installRelease(root);
        await pairRoot(root, { [field]: bad });
        const report = await installationStatus(root, fakeProbes().probes);
        assertEquals(
          report.pairing.state,
          "unreadable",
          `${field}: ${JSON.stringify(bad).slice(0, 20)}`,
        );
        const text = describeStatus(report);
        assertFalse(text.includes("\u001b"));
        assertFalse(text.includes("your own"));
        assertStringIncludes(text, "Paired: the record cannot be read\n");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    for (const field of ["release", "target"]) {
      const root = await tempRoot();
      try {
        await installRelease(root, { [field]: bad });
        const report = await installationStatus(root, fakeProbes().probes);
        assertEquals(report.installation.state, "unreadable", field);
        assertFalse(describeStatus(report).includes("\u001b"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

Deno.test("a damaged record is unreadable rather than a crash: bad JSON, wrong version, a real file where `current` goes", async () => {
  const root = await tempRoot();
  try {
    await writeFile(join(root, PAIRING_FILE), "{not json", { mode: 0o600 });
    await mkdir(join(root, "current"));
    const report = await installationStatus(root, fakeProbes().probes);
    assertEquals(report.pairing.state, "unreadable");
    assertEquals(report.installation.state, "unreadable");
    await pairRoot(root, { version: 2 });
    assertEquals(
      (await installationStatus(root, fakeProbes().probes)).pairing.state,
      "unreadable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a service probe that fails is `unknown`, not an error", async () => {
  const root = await tempRoot();
  try {
    const report = await installationStatus(
      root,
      fakeProbes({ service: "throws" }).probes,
    );
    assertEquals(report.service, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("doctor on a healthy installation passes every check, in a fixed order, and exits 0", async () => {
  const root = await healthyRoot();
  try {
    const checks = await doctor(root, fakeProbes().probes);
    assertEquals(
      checks.map((check) => check.id),
      [
        "unprivileged",
        "root",
        "install",
        "pairing",
        "code-file",
        "settings-file",
        "disk",
        "sandbox",
        "service",
      ],
    );
    assertEquals(checks.map((check) => check.status), Array(9).fill("ok"));
    assertEquals(doctorExitCode(checks), 0);
    const text = describeChecks(checks);
    assertEquals(text.trimEnd().split("\n").length, 9);
    assertStringIncludes(text, "ok        unprivileged: Not running as root.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("doctor: each condition is named by its own check and its own severity", async () => {
  const cases: [string, FakeOptions, string, string][] = [
    ["root user", { uid: 0 }, "unprivileged", "failed"],
    ["no uid", { uid: null }, "unprivileged", "ok"],
    ["disk nearly full", { free: 100 * 1024 * 1024 }, "disk", "failed"],
    ["disk exactly at the minimum", { free: 256 * 1024 * 1024 }, "disk", "ok"],
    ["disk one byte under", { free: 256 * 1024 * 1024 - 1 }, "disk", "failed"],
    ["disk unreadable", { free: null }, "disk", "attention"],
    ["disk probe throws", { free: "throws" }, "disk", "attention"],
    ["sandbox missing", { runs: false }, "sandbox", "attention"],
    ["sandbox probe throws", { runs: "throws" }, "sandbox", "attention"],
    ["service inactive", { service: "inactive" }, "service", "failed"],
    ["service failed", { service: "failed" }, "service", "failed"],
    ["service absent", { service: "absent" }, "service", "attention"],
    ["service unknown", { service: "unknown" }, "service", "attention"],
    ["service probe throws", { service: "throws" }, "service", "attention"],
  ];
  for (const [label, options, id, expected] of cases) {
    const root = await healthyRoot();
    try {
      assertEquals(
        statusOf(await doctor(root, fakeProbes(options).probes), id),
        expected,
        label,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

Deno.test("doctor reads the root's own condition: not installed, not paired, a code file or settings file others can read", async () => {
  const empty = await tempRoot();
  try {
    const checks = await doctor(empty, fakeProbes().probes);
    assertEquals(statusOf(checks, "install"), "failed");
    assertEquals(statusOf(checks, "pairing"), "attention");
    assertEquals(statusOf(checks, "code-file"), "ok");
    assertEquals(statusOf(checks, "settings-file"), "attention");
    assertEquals(doctorExitCode(checks), 2);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
  const root = await healthyRoot();
  try {
    await writeFile(join(root, TOKEN_FILE), "bk_setup_x", { mode: 0o600 });
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "code-file"),
      "ok",
    );
    await chmod(join(root, TOKEN_FILE), 0o640);
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "code-file"),
      "failed",
    );
    await chmod(join(root, TOKEN_FILE), 0o604);
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "code-file"),
      "failed",
    );
    await chmod(join(root, "worker.env"), 0o640);
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "settings-file"),
      "failed",
    );
    await chmod(join(root, "worker.env"), 0o604);
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "settings-file"),
      "failed",
    );
    await chmod(join(root, "worker.env"), 0o644);
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "settings-file"),
      "failed",
    );
    await chmod(join(root, "worker.env"), 0o400);
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "settings-file"),
      "ok",
    );
    await chmod(root, 0o777);
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "root"),
      "failed",
    );
    await chmod(root, 0o700);
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "root"),
      "ok",
    );
    await writeFile(join(root, PAIRING_FILE), "{", { mode: 0o600 });
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "pairing"),
      "failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("doctor on a relative or missing root says the root is wrong, with a fixed sentence", async () => {
  for (
    const root of [
      "relative/path",
      join(tmpdir(), "bakery-operate-missing-root"),
    ]
  ) {
    const checks = await doctor(root, fakeProbes().probes);
    assertEquals(statusOf(checks, "root"), "failed", root);
    const text = describeChecks(checks);
    assertFalse(text.includes(root), "the path is not echoed");
  }
});

Deno.test("the exit code is 2 for any failure, 1 for attention only, 0 for all well", () => {
  const check = (status: "ok" | "attention" | "failed") => ({
    id: "x",
    status,
    message: "m",
  });
  assertEquals(doctorExitCode([]), 0);
  assertEquals(doctorExitCode([check("ok"), check("ok")]), 0);
  assertEquals(doctorExitCode([check("ok"), check("attention")]), 1);
  assertEquals(
    doctorExitCode([check("attention"), check("failed"), check("ok")]),
    2,
  );
  assertEquals(doctorExitCode([check("failed")]), 2);
});

Deno.test("the doctor asks the machine only what it needs: the sandbox probe is fixed and runs no setup", async () => {
  const root = await healthyRoot();
  try {
    const { probes, calls } = fakeProbes();
    await doctor(root, probes);
    const ran = calls.filter((call) => call.startsWith("runs "));
    assertEquals(ran.length, 1);
    assertStringIncludes(ran[0]!, "/usr/bin/bwrap");
    assertFalse(ran[0]!.includes("sudo"));
    assertFalse(ran[0]!.includes("install"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("the sandbox probe asks for the user and process namespaces it needs, by absolute path", async () => {
  const root = await healthyRoot();
  try {
    const { probes, calls } = fakeProbes();
    await doctor(root, probes);
    assertEquals(
      calls.filter((call) => call.startsWith("runs ")),
      ["runs /usr/bin/bwrap --unshare-user --unshare-pid --ro-bind / / true"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a failed check reads FAILED and an attention check reads attention, so they are not mistaken for ok", () => {
  const text = describeChecks([
    { id: "a", status: "ok", message: "m1" },
    { id: "b", status: "attention", message: "m2" },
    { id: "c", status: "failed", message: "m3" },
  ]);
  assertEquals(
    text,
    "ok        a: m1\nattention b: m2\nFAILED    c: m3\n",
  );
});

Deno.test("drain names the command for the operator and the system it belongs to", () => {
  const linux = planDrain("linux", 1000);
  assertEquals(linux.length, 1);
  assertEquals(linux[0]!.actor, "administrator");
  assertEquals(linux[0]!.command, [
    "systemctl",
    "stop",
    "bakery-worker",
  ]);
  const mac = planDrain("macos", 501);
  assertEquals(mac[0]!.actor, "user");
  assertEquals(mac[0]!.command, [
    "launchctl",
    "bootout",
    "gui/501/io.bakery.worker",
  ]);
  for (const uid of [-1, 1.5, Number.NaN]) {
    let code = "";
    try {
      planDrain("macos", uid);
    } catch (error) {
      code = (error as BootstrapError).code;
    }
    assertEquals(code, "SERVICE_SPEC_INVALID", String(uid));
  }
  // Linux does not use the user id at all.
  assertEquals(planDrain("linux", -1)[0]!.command, [
    "systemctl",
    "stop",
    "bakery-worker",
  ]);
});

Deno.test("parseOperation takes status, doctor and drain with an optional root, and nothing else", () => {
  assertEquals(parseOperation(["status"], { root: "/var/lib/x" }), {
    name: "status",
    root: "/var/lib/x",
  });
  assertEquals(parseOperation(["doctor", "--root", "/r"], { root: "/d" }), {
    name: "doctor",
    root: "/r",
  });
  assertEquals(parseOperation(["drain", "--root", "/r"], { root: "/d" }), {
    name: "drain",
    root: "/r",
  });
  const refusals: [string[], string][] = [
    [[], "COMMAND_UNKNOWN"],
    [["setup"], "COMMAND_UNKNOWN"],
    [["pair", "--server", "https://x"], "COMMAND_UNKNOWN"],
    [["status", "--server", "https://x"], "COMMAND_UNKNOWN"],
    [["status", "extra"], "COMMAND_UNKNOWN"],
    [["status", "--root"], "COMMAND_UNKNOWN"],
    [["status", "--root", "--root"], "COMMAND_UNKNOWN"],
    [["status", "--token", "bk_setup_x"], "COMMAND_TOKEN_SHORTCUT"],
    [["doctor", "--token=bk_setup_x"], "COMMAND_TOKEN_SHORTCUT"],
  ];
  for (const [argv, code] of refusals) {
    let got = "";
    try {
      parseOperation(argv, { root: "/d" });
    } catch (error) {
      got = (error as BootstrapError).code;
    }
    assertEquals(got, code, argv.join(" "));
  }
});

Deno.test("runOperation: status and doctor print and set the exit code; drain prints the command and runs nothing", async () => {
  const root = await healthyRoot();
  try {
    for (
      const [name, expectedCode] of [["status", 0], ["doctor", 0]] as const
    ) {
      const out: string[] = [];
      const code = await runOperation({ name, root }, {
        write: (text) => out.push(text),
        probes: fakeProbes().probes,
        target: "linux",
      });
      assertEquals(code, expectedCode, name);
      assert(out.join("").length > 0);
    }
    const out: string[] = [];
    const { probes, calls } = fakeProbes();
    const code = await runOperation({ name: "drain", root }, {
      write: (text) => out.push(text),
      probes,
      target: "linux",
    });
    assertEquals(code, 0);
    assertStringIncludes(out.join(""), "systemctl stop bakery-worker");
    assertStringIncludes(out.join(""), "[administrator]");
    assertEquals(calls, [], "drain asks the machine nothing and runs nothing");
    // A doctor with a failure exits 2.
    const failing: string[] = [];
    assertEquals(
      await runOperation({ name: "doctor", root }, {
        write: (t) => failing.push(t),
        probes: fakeProbes({ uid: 0 }).probes,
        target: "linux",
      }),
      2,
    );
    // On a Mac without a user id the drain command cannot be named: a fixed message, exit 2.
    const mac: string[] = [];
    assertEquals(
      await runOperation({ name: "drain", root }, {
        write: (t) => mac.push(t),
        probes: fakeProbes({ uid: null }).probes,
        target: "macos",
      }),
      2,
    );
    assertStringIncludes(mac.join(""), "Nothing was written");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("running every operation changes nothing in the root", async () => {
  const root = await healthyRoot();
  try {
    const snapshot = async () => {
      const entries: string[] = [];
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else {
            const info = await lstat(path);
            entries.push(`${path}:${info.mtimeMs}:${info.size}:${info.mode}`);
          }
        }
      };
      await walk(root);
      return entries.sort();
    };
    const before = await snapshot();
    for (const name of ["status", "doctor", "drain"] as const) {
      await runOperation({ name, root }, {
        write: () => undefined,
        probes: fakeProbes().probes,
        target: "linux",
      });
    }
    assertEquals(await snapshot(), before);
    assertEquals(
      await readFile(join(root, "worker.env"), "utf8"),
      "BAKERY_X=1\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("the service manager's answers are read exactly: systemd and launchd", () => {
  assertEquals(
    linuxServiceState("LoadState=loaded\nActiveState=active\n", 0),
    "active",
  );
  assertEquals(
    linuxServiceState("LoadState=loaded\nActiveState=inactive\n", 0),
    "inactive",
  );
  assertEquals(
    linuxServiceState("LoadState=loaded\nActiveState=failed\n", 0),
    "failed",
  );
  assertEquals(
    linuxServiceState("LoadState=not-found\nActiveState=inactive\n", 0),
    "absent",
  );
  assertEquals(
    linuxServiceState("LoadState=loaded\nActiveState=activating\n", 0),
    "unknown",
  );
  assertEquals(linuxServiceState("", 0), "unknown");
  assertEquals(
    linuxServiceState("LoadState=loaded\nActiveState=active\n", null),
    "unknown",
  );
  assertEquals(macServiceState("\tstate = running\n", 0), "active");
  assertEquals(macServiceState("\tstate = waiting\n", 0), "inactive");
  assertEquals(macServiceState("no state here", 0), "unknown");
  assertEquals(macServiceState("", 113), "absent");
  assertEquals(macServiceState("", null), "unknown");
});

Deno.test("system probes ask the service manager the exact question, without a shell and without sudo", async () => {
  const asked: (readonly string[])[] = [];
  const linux = systemProbes("linux", (argv) => {
    asked.push(argv);
    return Promise.resolve({
      code: 0,
      stdout: "LoadState=loaded\nActiveState=active\n",
    });
  });
  assertEquals(await linux.serviceState(), "active");
  assertEquals(asked[0], [
    "systemctl",
    "show",
    "bakery-worker",
    "--property=LoadState,ActiveState",
  ]);
  if (typeof process.getuid === "function") {
    const mac = systemProbes("macos", (argv) => {
      asked.push(argv);
      return Promise.resolve({ code: 0, stdout: "\tstate = running\n" });
    });
    assertEquals(await mac.serviceState(), "active");
    assertEquals(asked[1], [
      "launchctl",
      "print",
      `gui/${process.getuid()}/io.bakery.worker`,
    ]);
  }
  const ran = systemProbes(
    "linux",
    () => Promise.resolve({ code: 1, stdout: "" }),
  );
  assertEquals(await ran.runs(["x"]), false);
  assertEquals(
    await systemProbes("linux", () => Promise.resolve({ code: 0, stdout: "" }))
      .runs(["x"]),
    true,
  );
  for (const call of asked) assertFalse(call.includes("sudo"));
});

Deno.test("the real spawn never throws or hangs: success, failure, a missing program and an empty command", async () => {
  assertEquals((await spawnProgram(["/bin/true"])).code, 0);
  assertEquals((await spawnProgram(["/bin/false"])).code, 1);
  assertEquals((await spawnProgram(["/nonexistent/program"])).code, null);
  assertEquals((await spawnProgram([])).code, null);
  assertEquals(
    (await spawnProgram(["/bin/echo", "hello"])).stdout.trim(),
    "hello",
  );
  // No shell: metacharacters are plain arguments.
  assertEquals(
    (await spawnProgram(["/bin/echo", "a; rm -rf /"])).stdout.trim(),
    "a; rm -rf /",
  );
});

Deno.test("a program that runs too long, or prints too much, is stopped and answers `unknown`", async () => {
  const started = Date.now();
  const slow = await spawnWithTimeout(200)(["/bin/sleep", "20"]);
  assertEquals(slow.code, null);
  assert(Date.now() - started < 5_000, "the time limit stops the program");
  const loud = await spawnWithTimeout(5_000)([
    "/bin/sh",
    "-c",
    "head -c 20000 /dev/zero | tr '\\0' x",
  ]);
  assertEquals(loud.code, null);
  assert(loud.stdout.length <= 4096 + 1024);
  const quiet = await spawnWithTimeout(5_000)(["/bin/echo", "ok"]);
  assertEquals(quiet, { code: 0, stdout: "ok\n" });
});

Deno.test("free space is the blocks available to this user times the block size, not the blocks free to root", async () => {
  const probes = systemProbes(
    "linux",
    undefined,
    () => Promise.resolve({ bavail: 10, bsize: 4096, bfree: 999 } as never),
  );
  assertEquals(await probes.freeBytes("/x"), 40_960);
  const big = systemProbes(
    "linux",
    undefined,
    () => Promise.resolve({ bavail: 3n, bsize: 1_048_576n } as never),
  );
  assertEquals(await big.freeBytes("/x"), 3_145_728);
  const failing = systemProbes(
    "linux",
    undefined,
    () => Promise.reject(new Error("x")),
  );
  assertEquals(await failing.freeBytes("/x"), null);
});

Deno.test("the real probes read the free space of a real directory and the user id", async () => {
  const root = await tempRoot();
  try {
    const probes = systemProbes("linux");
    const free = await probes.freeBytes(root);
    assert(free !== null && free > 0);
    assertEquals(await probes.freeBytes(join(root, "missing", "deeper")), null);
    assertEquals(
      probes.uid(),
      typeof process.getuid === "function" ? process.getuid() : null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("the operations read and ask; they never write, spawn, sudo or hold a secret", async () => {
  const source = await readFile(
    new URL(
      "../../packages/worker-bootstrap/src/operations.ts",
      import.meta.url,
    ),
    "utf8",
  );
  for (
    const forbidden of [
      "writeFile",
      "appendFile",
      "mkdir",
      "rename",
      "unlink",
      "rm(",
      "chmod",
      "symlink",
      "child_process",
      "execFile",
      "spawn",
      "sudo",
      "process.env",
      "Deno.env",
      "fetch(",
    ]
  ) {
    assertFalse(source.includes(forbidden), forbidden);
  }
  const probes = await readFile(
    new URL("../../packages/worker-bootstrap/src/probes.ts", import.meta.url),
    "utf8",
  );
  for (
    const forbidden of [
      "sudo",
      "shell: true",
      "execSync",
      "spawnSync",
      "shell:",
      "writeFile",
      "process.env",
      "Deno.env",
    ]
  ) {
    assertFalse(probes.includes(forbidden), forbidden);
  }
});
