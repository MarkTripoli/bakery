import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
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
  MAX_RECORD_BYTES,
  PAIRING_FILE,
  parseOperation,
  planDrain,
  type Probes,
  readRecord,
  runOperation,
  type ServiceState,
  spawnProgram,
  spawnWithTimeout,
  systemProbes,
  TOKEN_FILE,
  UnreadableRecord,
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

/** Things a name in the root may be instead of a small regular file, each made without a program. */
function hostileFiles(
  dir: string,
): [string, (path: string) => Promise<void>][] {
  return [
    ["a directory", (path) => mkdir(path)],
    ["a link to /dev/zero", (path) => symlink("/dev/zero", path)],
    ["a link to /dev/null", (path) => symlink("/dev/null", path)],
    ["a link to another file", async (path) => {
      await writeFile(`${path}.real`, "{}");
      await symlink(`${path}.real`, path);
    }],
    ["a link that goes nowhere", (path) => symlink(join(dir, "nowhere"), path)],
    ["a sparse file of 300 MB", async (path) => {
      await writeFile(path, "");
      await truncate(path, 300 * 1024 * 1024);
    }],
    [
      "a file one byte over the limit",
      (path) => writeFile(path, " ".repeat(MAX_RECORD_BYTES + 1)),
    ],
  ];
}

Deno.test("a name in the root that is not a small regular file is unreadable, quickly, whatever it is and whichever record it is", async () => {
  for (const record of ["pairing.json", "release.json"] as const) {
    const probe = await tempRoot();
    const cases = hostileFiles(probe);
    await rm(probe, { recursive: true, force: true });
    for (const [label, make] of cases) {
      const root = await tempRoot();
      try {
        await installRelease(root);
        await pairRoot(root);
        const target = record === "pairing.json"
          ? join(root, "pairing.json")
          : join(root, "releases", "1.2.3-linux-x64", "release.json");
        await rm(target, { force: true });
        await make(target);
        const started = Date.now();
        const report = await installationStatus(root, fakeProbes().probes);
        const checks = await doctor(root, fakeProbes().probes);
        assert(
          Date.now() - started < 2_000,
          `${record}: ${label} answered quickly`,
        );
        if (record === "pairing.json") {
          assertEquals(
            report.pairing.state,
            "unreadable",
            `${record}: ${label}`,
          );
          assertEquals(
            statusOf(checks, "pairing"),
            "failed",
            `${record}: ${label}`,
          );
        } else {
          assertEquals(
            report.installation.state,
            "unreadable",
            `${record}: ${label}`,
          );
          assertEquals(
            statusOf(checks, "install"),
            "failed",
            `${record}: ${label}`,
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

Deno.test("a binary that is not a regular file of the signed size is not intact and is never read", async () => {
  const cases: [string, (path: string) => Promise<void>][] = [
    ["a link to /dev/zero", (path) => symlink("/dev/zero", path)],
    ["a directory", (path) => mkdir(path)],
    ["a sparse file of 600 MB", async (path) => {
      await writeFile(path, "");
      await truncate(path, 600 * 1024 * 1024);
    }],
    [
      "the right content, one byte longer",
      (path) =>
        writeFile(path, Buffer.concat([Buffer.from(BINARY), Buffer.from("x")])),
    ],
    ["empty", (path) => writeFile(path, "")],
    [
      "the same size, other bytes",
      (path) => writeFile(path, Buffer.alloc(BINARY.length, 65)),
    ],
  ];
  for (const [label, make] of cases) {
    const root = await tempRoot();
    try {
      await installRelease(root);
      const path = join(root, "releases", "1.2.3-linux-x64", "bakery-worker");
      await rm(path, { force: true });
      await make(path);
      const started = Date.now();
      const report = await installationStatus(root, fakeProbes().probes);
      assert(Date.now() - started < 2_000, `${label} answered quickly`);
      assertEquals(
        (report.installation as { intact: boolean }).intact,
        false,
        label,
      );
      assertEquals(
        statusOf(await doctor(root, fakeProbes().probes), "install"),
        "failed",
        label,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

Deno.test("the binary is looked at before it is read: only a regular file of the signed size is ever hashed, and a hash that never ends is not intact", async () => {
  const never: string[] = [];
  const refuseToHash = (path: string): Promise<string> => {
    never.push(path);
    return Promise.reject(new Error("must not be hashed"));
  };
  const cases: [string, (path: string, dir: string) => Promise<void>][] = [
    ["a link to /dev/zero", (path) => symlink("/dev/zero", path)],
    ["a directory", (path) => mkdir(path)],
    ["a sparse file of 600 MB", async (path) => {
      await writeFile(path, "");
      await truncate(path, 600 * 1024 * 1024);
    }],
    [
      "a file one byte over",
      (path) => writeFile(path, Buffer.alloc(BINARY.length + 1, 65)),
    ],
    ["empty", (path) => writeFile(path, "")],
    // A link's own size is the length of where it points: this one is exactly
    // the signed size, and points at a file with the signed bytes, so only the
    // check that it is a regular file stops it.
    [
      "a link as long as the signed size, to the signed bytes",
      async (path, dir) => {
        const size = BINARY.length;
        assert(
          size % 2 === 1,
          "the construction below needs an odd signed size",
        );
        const target = `${"./".repeat((size - 1) / 2)}b`;
        assertEquals(target.length, size);
        await writeFile(join(dir, "b"), BINARY);
        await symlink(target, path);
      },
    ],
  ];
  for (const [label, make] of cases) {
    const root = await tempRoot();
    try {
      await installRelease(root);
      const dir = join(root, "releases", "1.2.3-linux-x64");
      const path = join(dir, "bakery-worker");
      await rm(path, { force: true });
      await make(path, dir);
      const report = await installationStatus(root, fakeProbes().probes, {
        hash: refuseToHash,
      });
      assertEquals(
        (report.installation as { intact: boolean }).intact,
        false,
        label,
      );
      assertEquals(never, [], `${label}: not hashed`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  // The proper file is hashed exactly once, and its answer decides.
  const root = await tempRoot();
  try {
    await installRelease(root);
    const hashed: string[] = [];
    const real = await installationStatus(root, fakeProbes().probes, {
      hash: (path) => {
        hashed.push(path);
        return Promise.resolve(DIGEST);
      },
    });
    assertEquals((real.installation as { intact: boolean }).intact, true);
    assertEquals(hashed.length, 1);
    const wrong = await installationStatus(root, fakeProbes().probes, {
      hash: () => Promise.resolve("0".repeat(64)),
    });
    assertEquals((wrong.installation as { intact: boolean }).intact, false);
    // A hash that never finishes gives up at the deadline.
    const started = Date.now();
    const stalled = await installationStatus(root, fakeProbes().probes, {
      hash: () => new Promise(() => undefined),
      hashDeadlineMs: 100,
    });
    assertEquals((stalled.installation as { intact: boolean }).intact, false);
    assert(Date.now() - started < 3_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A stand-in for an open file: what it says it is, and what it reads. Its identity is the real file's unless told otherwise. */
function fakeHandle(
  over: {
    isFile?: boolean;
    size?: number;
    available?: number;
    dev?: number;
    ino?: number;
  },
) {
  return async (opened: unknown) => {
    const real = await lstat(opened as string);
    return {
      stat: () =>
        Promise.resolve({
          isFile: () => over.isFile ?? true,
          size: over.size ?? 5,
          dev: over.dev ?? real.dev,
          ino: over.ino ?? real.ino,
        }),
      read: (buffer: Uint8Array, _offset: number, length: number) => {
        const count = Math.min(length, over.available ?? 5);
        buffer.fill(97, 0, count);
        return Promise.resolve({ bytesRead: count });
      },
      close: () => Promise.resolve(),
    } as never;
  };
}

Deno.test("a name swapped for a link between the look and the open is not followed, and the open asks not to follow or wait", async () => {
  const root = await tempRoot();
  try {
    const path = join(root, "record");
    const secret = join(root, "secret");
    await writeFile(path, "{}");
    await writeFile(secret, "SECRET-OUTSIDE-THE-RECORD");
    let flagsSeen = -1;
    await assertRejects(
      () =>
        readRecord(path, 100, 1_000, async (opened, flags, mode) => {
          flagsSeen = flags as number;
          // The path looked like a small regular file a moment ago; now it is a link.
          await rm(opened as string);
          await symlink(secret, opened as string);
          return await openFile(opened, flags, mode);
        }),
    );
    assertEquals(
      (flagsSeen & constants.O_NOFOLLOW) === constants.O_NOFOLLOW,
      true,
      "opened without following a link",
    );
    assertEquals(
      (flagsSeen & constants.O_NONBLOCK) === constants.O_NONBLOCK,
      true,
      "opened without waiting on a FIFO",
    );
    assertEquals(
      flagsSeen & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT),
      0,
      "read only, and nothing is created",
    );
    // The same swap with a link to a file that would be readable is still refused,
    // never read: nothing of the secret is returned.
    await rm(path);
    await writeFile(path, "{}");
    let leaked = "";
    try {
      leaked = await readRecord(
        path,
        100,
        1_000,
        async (opened, flags, mode) => {
          await rm(opened as string);
          await symlink(secret, opened as string);
          return await openFile(opened, flags, mode);
        },
      );
    } catch {
      // refused, as it should be
    }
    assertEquals(leaked, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("a record is checked again on the open handle: not a file, too big, or more bytes than allowed are refused, and the limit is exact", async () => {
  const root = await tempRoot();
  try {
    const path = join(root, "record");
    await writeFile(path, "hello");
    // The path looks fine; the open handle says otherwise (the file was swapped in between).
    await assertRejects(
      () => readRecord(path, 100, 1_000, fakeHandle({ isFile: false })),
      UnreadableRecord,
      "not a plain small file",
    );
    await assertRejects(
      () => readRecord(path, 100, 1_000, fakeHandle({ size: 101 })),
      UnreadableRecord,
      "not a plain small file",
    );
    // The open handle is another file than the one the path showed a moment ago
    // (a different inode, or a different device): refused, whatever it holds.
    await assertRejects(
      () => readRecord(path, 100, 1_000, fakeHandle({ ino: 1 })),
      UnreadableRecord,
      "changed under the read",
    );
    await assertRejects(
      () => readRecord(path, 100, 1_000, fakeHandle({ dev: 1 })),
      UnreadableRecord,
      "changed under the read",
    );
    // A file that grew after both looks: more bytes arrive than the limit.
    await assertRejects(
      () => readRecord(path, 10, 1_000, fakeHandle({ available: 50 })),
      UnreadableRecord,
      "not a plain small file",
    );
    await assertRejects(
      () => readRecord(path, 10, 1_000, fakeHandle({ available: 11 })),
      UnreadableRecord,
      "not a plain small file",
    );
    assertEquals(
      await readRecord(
        path,
        10,
        1_000,
        fakeHandle({ available: 10, size: 10 }),
      ),
      "a".repeat(10),
    );
    // Before it is ever opened, the path itself is judged, so a stalled open does not matter.
    for (
      const [label, make] of [
        ["a directory", (p: string) => mkdir(p)],
        ["a link", (p: string) => symlink(path, p)],
        ["too big", (p: string) => writeFile(p, "x".repeat(200))],
      ] as [string, (p: string) => Promise<void>][]
    ) {
      const hostile = join(root, `h-${label.replace(/ /g, "-")}`);
      await make(hostile);
      await assertRejects(
        () =>
          readRecord(hostile, 100, 5_000, () => new Promise(() => undefined)),
        UnreadableRecord,
        "not a plain small file",
        label,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("no read of a file in the install root goes around the bounded reader", async () => {
  const count = async (name: string) =>
    (await readFile(
      new URL(`../../packages/worker-bootstrap/src/${name}`, import.meta.url),
      "utf8",
    )).split("readFile(").length - 1;
  // operations.ts reads nothing but through readRecord; install.ts reads /proc once (a process's own
  // state); pairing.ts reads the protected code file once, after it has checked that file.
  assertEquals(await count("operations.ts"), 0);
  assertEquals(await count("install.ts"), 1);
  assertEquals(await count("pairing.ts"), 1);
});

Deno.test("a record is read only if it is a plain small file: the exact limit, one over, a link, a directory, a stalled open", async () => {
  const root = await tempRoot();
  try {
    const path = join(root, "record");
    await writeFile(path, "a".repeat(MAX_RECORD_BYTES));
    assertEquals((await readRecord(path)).length, MAX_RECORD_BYTES);
    await writeFile(path, "a".repeat(MAX_RECORD_BYTES + 1));
    await assertRejects(() => readRecord(path), UnreadableRecord);
    await writeFile(path, "hello");
    assertEquals(await readRecord(path, 5), "hello");
    await assertRejects(() => readRecord(path, 4), UnreadableRecord);
    await symlink(path, join(root, "link"));
    await assertRejects(() => readRecord(join(root, "link")), UnreadableRecord);
    await mkdir(join(root, "dir"));
    await assertRejects(() => readRecord(join(root, "dir")), UnreadableRecord);
    await assertRejects(() => readRecord(join(root, "missing")));
    // A file that is checked and then swapped for something that never opens
    // (the instant between the two looks) gives up at the deadline.
    const started = Date.now();
    await assertRejects(
      () => readRecord(path, 100, 100, () => new Promise(() => undefined)),
      UnreadableRecord,
      "no answer",
    );
    assert(Date.now() - started < 2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
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

Deno.test("a releases link to somewhere else is not read through: the installation is unreadable", async () => {
  const root = await tempRoot();
  const elsewhere = await tempRoot();
  try {
    await installRelease(root);
    // Move the real releases directory out and leave a link to it.
    const { rename } = await import("node:fs/promises");
    await rename(join(root, "releases"), join(elsewhere, "releases"));
    await symlink(join(elsewhere, "releases"), join(root, "releases"));
    const report = await installationStatus(root, fakeProbes().probes);
    assertEquals(report.installation.state, "unreadable");
    assertEquals(
      statusOf(await doctor(root, fakeProbes().probes), "install"),
      "failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
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

// The unit lane runs only a short list of programs (scripts/run-tests.ts): `node`
// is on it, so a real child process here is `node -e`, not /bin/true or /bin/sh.
const node = (
  script: string,
  ...args: string[]
) => ["node", "-e", script, ...args];

Deno.test("the real spawn never throws or hangs: success, failure, a missing program and an empty command", async () => {
  assertEquals((await spawnProgram(node(""))).code, 0);
  assertEquals((await spawnProgram(node("process.exit(1)"))).code, 1);
  assertEquals((await spawnProgram(node("process.exit(7)"))).code, 7);
  assertEquals((await spawnProgram(["/nonexistent/program"])).code, null);
  assertEquals((await spawnProgram([])).code, null);
  assertEquals(
    (await spawnProgram(node("console.log('hello')"))).stdout.trim(),
    "hello",
  );
  // No shell: metacharacters are plain arguments.
  assertEquals(
    (await spawnProgram(node("console.log(process.argv[1])", "a; rm -rf /")))
      .stdout.trim(),
    "a; rm -rf /",
  );
});

Deno.test("a program that runs too long, or prints too much, is stopped and answers `unknown`", async () => {
  const started = Date.now();
  const slow = await spawnWithTimeout(300)(node("setTimeout(() => {}, 20000)"));
  assertEquals(slow.code, null);
  assert(Date.now() - started < 5_000, "the time limit stops the program");
  const loud = await spawnWithTimeout(5_000)(
    node("process.stdout.write('x'.repeat(20000))"),
  );
  assertEquals(loud.code, null);
  assert(loud.stdout.length <= 4096 + 1024);
  const quiet = await spawnWithTimeout(5_000)(node("console.log('ok')"));
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
