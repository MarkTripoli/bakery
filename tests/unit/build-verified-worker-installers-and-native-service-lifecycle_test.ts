import { assert, assertEquals, assertFalse } from "@std/assert";
import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  BootstrapError,
  detectTarget,
  type InstallOptions,
  installRelease,
  type ProcessInfo,
  type ProcessProbe,
  type StagedFile,
  type VerifiedManifest,
  verifySignedManifest,
} from "../../packages/worker-bootstrap/src/index.ts";
import { runsAsRoot } from "../../packages/worker-bootstrap/src/install.ts";
import { hasDuplicateKeys } from "../../packages/worker-bootstrap/src/manifest.ts";

// Local test signing keys only. No key here, or in the package, signs anything
// real; publishing the bootstrap needs the B00.04 allowlist.

const BINARY = new TextEncoder().encode(
  "#!/bin/sh\necho bakery worker 1.2.3\n",
);
const NOW = new Date("2026-11-11T00:00:00.000Z");
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function testKey(keyId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = Buffer.from(der).subarray(-32);
  return {
    keyId,
    privateKey,
    trust: { keyId, publicKey: raw.toString("base64") },
  };
}

const KEY = testKey("release-2026-a");
const OTHER_KEY = testKey("release-2026-b");
const TRUST_ROOT = [KEY.trust];

function manifestFor(binary: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    release: "1.2.3",
    issuedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    protocol: { min: 3, max: 4 },
    stateFormat: 2,
    targets: {
      "linux-x64": {
        file: "bakery-worker-1.2.3-linux-x64",
        size: binary.byteLength,
        sha256: sha(binary),
      },
    },
    ...over,
  };
}

function envelope(
  manifest: unknown,
  key = KEY,
  over: Record<string, unknown> = {},
): string {
  const payloadBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  return JSON.stringify({
    keyId: key.keyId,
    payload: payloadBytes.toString("base64"),
    signature: sign(null, payloadBytes, key.privateKey).toString("base64"),
    ...over,
  });
}

const VERIFY = {
  trustRoot: TRUST_ROOT,
  release: "1.2.3",
  target: "linux-x64",
  now: NOW,
  protocol: 3,
  stateFormat: 2,
};

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof BootstrapError) return error.code;
    throw error;
  }
  throw new Error("expected a BootstrapError");
}

async function codeOfAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BootstrapError) return error.code;
    throw error;
  }
  throw new Error("expected a BootstrapError");
}

// --- signed release manifest

Deno.test("a manifest signed by a trusted key verifies for the exact release and target", () => {
  const verified = verifySignedManifest(envelope(manifestFor(BINARY)), VERIFY);
  assertEquals(verified, {
    release: "1.2.3",
    target: "linux-x64",
    file: "bakery-worker-1.2.3-linux-x64",
    size: BINARY.byteLength,
    sha256: sha(BINARY),
    stateFormat: 2,
    protocol: { min: 3, max: 4 },
    expiresAt: "2026-12-01T00:00:00.000Z",
    keyId: "release-2026-a",
  });
});

Deno.test("a flipped signature byte is refused", () => {
  const parsed = JSON.parse(envelope(manifestFor(BINARY)));
  const signature = Buffer.from(parsed.signature, "base64");
  signature[0] ^= 0xff;
  parsed.signature = signature.toString("base64");
  assertEquals(
    codeOf(() => verifySignedManifest(JSON.stringify(parsed), VERIFY)),
    "MANIFEST_SIGNATURE_INVALID",
  );
});

Deno.test("a payload changed after signing is refused", () => {
  const parsed = JSON.parse(envelope(manifestFor(BINARY)));
  const tampered = manifestFor(BINARY, { release: "9.9.9" });
  parsed.payload = Buffer.from(JSON.stringify(tampered)).toString("base64");
  assertEquals(
    codeOf(() => verifySignedManifest(JSON.stringify(parsed), VERIFY)),
    "MANIFEST_SIGNATURE_INVALID",
  );
});

Deno.test("a valid signature by a key outside the trust root is refused", () => {
  assertEquals(
    codeOf(() =>
      verifySignedManifest(envelope(manifestFor(BINARY), OTHER_KEY), VERIFY)
    ),
    "MANIFEST_KEY_UNKNOWN",
  );
});

Deno.test("naming a trusted key id does not borrow its trust", () => {
  // Signed by the other key but claiming the trusted key's id.
  const claimed = envelope(manifestFor(BINARY), OTHER_KEY, {
    keyId: KEY.keyId,
  });
  assertEquals(
    codeOf(() => verifySignedManifest(claimed, VERIFY)),
    "MANIFEST_SIGNATURE_INVALID",
  );
});

Deno.test("an expired manifest is refused, and expiry is exclusive", () => {
  const expires = new Date("2026-12-01T00:00:00.000Z");
  assertEquals(
    codeOf(() =>
      verifySignedManifest(envelope(manifestFor(BINARY)), {
        ...VERIFY,
        now: expires,
      })
    ),
    "MANIFEST_EXPIRED",
  );
  verifySignedManifest(envelope(manifestFor(BINARY)), {
    ...VERIFY,
    now: new Date(expires.getTime() - 1),
  });
});

Deno.test("a manifest issued in the future is refused beyond clock skew", () => {
  const future = manifestFor(BINARY, {
    issuedAt: "2026-11-11T01:00:00.000Z",
    expiresAt: "2026-12-11T00:00:00.000Z",
  });
  assertEquals(
    codeOf(() => verifySignedManifest(envelope(future), VERIFY)),
    "MANIFEST_NOT_YET_VALID",
  );
});

Deno.test("only the exact requested release is accepted, never a moving name", () => {
  const signed = envelope(manifestFor(BINARY));
  assertEquals(
    codeOf(() => verifySignedManifest(signed, { ...VERIFY, release: "1.2.4" })),
    "MANIFEST_RELEASE_MISMATCH",
  );
  for (const moving of ["latest", "^1.2.3", "1.2", "", "1.2.3 "]) {
    assertEquals(
      codeOf(() =>
        verifySignedManifest(signed, { ...VERIFY, release: moving })
      ),
      "RELEASE_NOT_EXACT",
      JSON.stringify(moving),
    );
  }
});

Deno.test("an unsupported target is named plainly", () => {
  assertEquals(detectTarget("linux", "x64"), "linux-x64");
  for (
    const [platform, arch] of [
      ["win32", "x64"],
      ["freebsd", "x64"],
      ["linux", "ia32"],
      // Real runners exist for linux-x64 only; others are not claimed yet.
      ["linux", "arm64"],
      ["darwin", "arm64"],
      ["darwin", "x64"],
    ]
  ) {
    assertEquals(detectTarget(platform, arch), null, `${platform}/${arch}`);
  }
  assertEquals(
    codeOf(() =>
      verifySignedManifest(envelope(manifestFor(BINARY)), {
        ...VERIFY,
        target: "linux-arm64",
      })
    ),
    "MANIFEST_TARGET_UNSUPPORTED",
  );
});

Deno.test("protocol and state-format compatibility are checked", () => {
  const signed = envelope(manifestFor(BINARY));
  for (const protocol of [2, 5]) {
    assertEquals(
      codeOf(() => verifySignedManifest(signed, { ...VERIFY, protocol })),
      "MANIFEST_PROTOCOL_INCOMPATIBLE",
    );
  }
  assertEquals(
    codeOf(() => verifySignedManifest(signed, { ...VERIFY, stateFormat: 1 })),
    "MANIFEST_STATE_FORMAT_INCOMPATIBLE",
  );
});

Deno.test("a malformed manifest is refused, whatever it carries", () => {
  const bad: [string, unknown][] = [
    ["unknown field", manifestFor(BINARY, { extra: true })],
    ["schema 2", manifestFor(BINARY, { schema: 2 })],
    ["non-date expiry", manifestFor(BINARY, { expiresAt: "tomorrow" })],
    [
      "expiry before issue",
      manifestFor(BINARY, { expiresAt: "2026-10-01T00:00:00.000Z" }),
    ],
    [
      "inverted protocol",
      manifestFor(BINARY, { protocol: { min: 4, max: 3 } }),
    ],
    [
      "unknown target name",
      manifestFor(BINARY, {
        targets: {
          "plan9-mips": {
            file: "bakery-worker-1.2.3-plan9-mips",
            size: BINARY.byteLength,
            sha256: sha(BINARY),
          },
        },
      }),
    ],
    ["not an object", ["a"]],
  ];
  for (const [name, manifest] of bad) {
    assertEquals(
      codeOf(() => verifySignedManifest(envelope(manifest), VERIFY)),
      "MANIFEST_MALFORMED",
      name,
    );
  }
  for (const text of ["", "not json", "[]", "null", "x".repeat(200_000)]) {
    assertEquals(
      codeOf(() => verifySignedManifest(text, VERIFY)),
      "MANIFEST_MALFORMED",
      text.slice(0, 12),
    );
  }
});

Deno.test("an artifact name that could leave the release directory is refused", () => {
  for (
    const file of [
      "../evil",
      "a/b",
      "..",
      ".hidden",
      "",
      "name with space",
      "x".repeat(200),
    ]
  ) {
    const manifest = manifestFor(BINARY);
    manifest.targets["linux-x64"].file = file;
    assertEquals(
      codeOf(() => verifySignedManifest(envelope(manifest), VERIFY)),
      "MANIFEST_MALFORMED",
      JSON.stringify(file),
    );
  }
});

Deno.test("an implausible artifact size or digest is refused", () => {
  for (
    const patch of [{ size: 0 }, { size: 1.5 }, { size: 2 ** 40 }, {
      sha256: "ABC",
    }, { sha256: "z".repeat(64) }]
  ) {
    const manifest = manifestFor(BINARY);
    Object.assign(manifest.targets["linux-x64"], patch);
    assertEquals(
      codeOf(() => verifySignedManifest(envelope(manifest), VERIFY)),
      "MANIFEST_MALFORMED",
      JSON.stringify(patch),
    );
  }
});

Deno.test("an error never echoes what the manifest or network supplied", () => {
  const secret = "SECRET-RELEASE-NAME-abc123";
  try {
    verifySignedManifest(
      envelope(manifestFor(BINARY, { release: secret })),
      VERIFY,
    );
  } catch (error) {
    assert(error instanceof BootstrapError);
    assertFalse(String(error.message).includes(secret));
    assertFalse(JSON.stringify(error).includes(secret));
    return;
  }
  throw new Error("expected a refusal");
});

// --- staged, atomic installation

async function withRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bakery-bootstrap-"));
  try {
    await run(root);
  } finally {
    await chmod(root, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function* chunked(
  bytes: Uint8Array,
  size = 7,
): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.byteLength; at += size) {
    yield bytes.subarray(at, at + size);
  }
}

function verified(binary = BINARY, release = "1.2.3"): VerifiedManifest {
  return verifySignedManifest(
    envelope(manifestFor(binary, { release })),
    { ...VERIFY, release },
  );
}

const install = (
  root: string,
  manifest: VerifiedManifest,
  bytes: Uint8Array,
  over: Partial<InstallOptions> = {},
) =>
  installRelease({
    root,
    manifest,
    download: () => chunked(bytes),
    uid: 1000,
    now: NOW,
    ...over,
  });

async function entries(path: string): Promise<string[]> {
  return (await readdir(path).catch(() => [])).sort();
}

async function currentTarget(root: string): Promise<string | null> {
  return await readlink(join(root, "current")).catch(() => null);
}

Deno.test("a verified artifact installs into a release directory behind one symlink", async () => {
  await withRoot(async (root) => {
    const result = await install(root, verified(), BINARY);
    assertEquals(result.status, "installed");
    assertEquals(result.release, "1.2.3");
    assertEquals(await currentTarget(root), "releases/1.2.3-linux-x64");
    const binary = join(root, "releases", "1.2.3-linux-x64", "bakery-worker");
    assertEquals(result.binaryPath, binary);
    assertEquals(new Uint8Array(await readFile(binary)), BINARY);
    assert(((await lstat(binary)).mode & 0o111) !== 0, "binary is executable");
    assertEquals(
      JSON.parse(
        await readFile(
          join(root, "releases", "1.2.3-linux-x64", "release.json"),
          "utf8",
        ),
      ),
      {
        release: "1.2.3",
        target: "linux-x64",
        file: "bakery-worker-1.2.3-linux-x64",
        size: BINARY.byteLength,
        sha256: sha(BINARY),
        keyId: "release-2026-a",
        stateFormat: 2,
        protocol: { min: 3, max: 4 },
        installedAt: NOW.toISOString(),
      },
    );
    assertEquals(await entries(join(root, "staging")), []);
    assertEquals(await entries(root), [
      "current",
      "releases",
      "staging",
    ]);
  });
});

async function installOld(root: string) {
  const old = new TextEncoder().encode("#!/bin/sh\necho old worker\n");
  await install(root, verified(old, "1.0.0"), old);
  return old;
}

async function assertOldIntact(root: string, old: Uint8Array) {
  assertEquals(await currentTarget(root), "releases/1.0.0-linux-x64");
  assertEquals(
    new Uint8Array(
      await readFile(
        join(root, "releases", "1.0.0-linux-x64", "bakery-worker"),
      ),
    ),
    old,
  );
  assertEquals(await entries(join(root, "staging")), []);
  assertEquals(await entries(join(root, "releases")), ["1.0.0-linux-x64"]);
}

Deno.test("an interrupted download leaves the prior working install intact", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    async function* broken() {
      yield BINARY.subarray(0, 10);
      throw new Error("connection reset by SECRET-PEER");
    }
    const run = () =>
      installRelease({
        root,
        manifest: verified(),
        download: broken,
        uid: 1000,
        now: NOW,
        upgrade: true,
      });
    assertEquals(await codeOfAsync(run), "ARTIFACT_DOWNLOAD_INTERRUPTED");
    await assertOldIntact(root, old);
  });
});

Deno.test("a digest mismatch leaves the prior install intact", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    const forged = new Uint8Array(BINARY);
    forged[forged.length - 2] ^= 0x01;
    const code = await codeOfAsync(() =>
      install(root, verified(), forged, { upgrade: true })
    );
    assertEquals(code, "ARTIFACT_DIGEST_MISMATCH");
    await assertOldIntact(root, old);
  });
});

Deno.test("a size mismatch is refused, and a long stream is cut off early", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    const short = BINARY.subarray(0, BINARY.length - 3);
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), short, { upgrade: true })
      ),
      "ARTIFACT_SIZE_MISMATCH",
    );
    let pulled = 0;
    async function* endless() {
      for (;;) {
        pulled += 1024;
        yield new Uint8Array(1024);
      }
    }
    assertEquals(
      await codeOfAsync(() =>
        installRelease({
          root,
          manifest: verified(),
          download: endless,
          uid: 1000,
          now: NOW,
          upgrade: true,
        })
      ),
      "ARTIFACT_SIZE_MISMATCH",
    );
    assert(
      pulled <= BINARY.byteLength + 2048,
      `read ${pulled} bytes of an endless stream`,
    );
    await assertOldIntact(root, old);
  });
});

Deno.test("a refused permission changes nothing", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    await chmod(join(root, "releases"), 0o555);
    await chmod(join(root, "staging"), 0o555);
    try {
      assertEquals(
        await codeOfAsync(() =>
          install(root, verified(), BINARY, { upgrade: true })
        ),
        "INSTALL_PERMISSION_DENIED",
      );
    } finally {
      await chmod(join(root, "releases"), 0o755);
      await chmod(join(root, "staging"), 0o755);
    }
    await assertOldIntact(root, old);
  });
});

Deno.test("rerunning setup reports already installed and downloads nothing", async () => {
  await withRoot(async (root) => {
    await install(root, verified(), BINARY);
    let downloads = 0;
    const result = await installRelease({
      root,
      manifest: verified(),
      download: () => {
        downloads += 1;
        return chunked(BINARY);
      },
      uid: 1000,
      now: NOW,
    });
    assertEquals(result.status, "already-installed");
    assertEquals(downloads, 0);
    assertEquals(await currentTarget(root), "releases/1.2.3-linux-x64");
  });
});

Deno.test("a rerun never changes the version implicitly", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    let downloads = 0;
    const code = await codeOfAsync(() =>
      installRelease({
        root,
        manifest: verified(),
        download: () => {
          downloads += 1;
          return chunked(BINARY);
        },
        uid: 1000,
        now: NOW,
      })
    );
    assertEquals(code, "INSTALL_VERSION_DIFFERS");
    assertEquals(downloads, 0);
    await assertOldIntact(root, old);
  });
});

Deno.test("an explicit upgrade activates the new release and keeps the old one", async () => {
  await withRoot(async (root) => {
    await installOld(root);
    const result = await install(root, verified(), BINARY, { upgrade: true });
    assertEquals(result.status, "installed");
    assertEquals(await currentTarget(root), "releases/1.2.3-linux-x64");
    assertEquals(await entries(join(root, "releases")), [
      "1.0.0-linux-x64",
      "1.2.3-linux-x64",
    ]);
    assertEquals(await entries(join(root, "staging")), []);
  });
});

Deno.test("an installed binary that no longer matches its digest is reported, not trusted", async () => {
  await withRoot(async (root) => {
    await install(root, verified(), BINARY);
    await writeFile(
      join(root, "releases", "1.2.3-linux-x64", "bakery-worker"),
      "tampered",
    );
    assertEquals(
      await codeOfAsync(() => install(root, verified(), BINARY)),
      "INSTALL_CORRUPT",
    );
  });
});

Deno.test("setup never runs as root", async () => {
  await withRoot(async (root) => {
    assertEquals(
      await codeOfAsync(() => install(root, verified(), BINARY, { uid: 0 })),
      "INSTALL_REFUSED_ROOT",
    );
    assertEquals(await entries(root), []);
  });
});

Deno.test("a symlinked release path is a collision and nothing is written through it", async () => {
  await withRoot(async (root) => {
    const elsewhere = await mkdtemp(join(tmpdir(), "bakery-elsewhere-"));
    try {
      await mkdir(join(root, "releases"), { recursive: true });
      await symlink(elsewhere, join(root, "releases", "1.2.3-linux-x64"));
      assertEquals(
        await codeOfAsync(() => install(root, verified(), BINARY)),
        "INSTALL_PATH_COLLISION",
      );
      assertEquals(await entries(elsewhere), []);
      assertEquals(await currentTarget(root), null);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

Deno.test("a current path that is a real directory is a collision", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "current"), { recursive: true });
    assertEquals(
      await codeOfAsync(() => install(root, verified(), BINARY)),
      "INSTALL_PATH_COLLISION",
    );
    assertEquals(await entries(join(root, "current")), []);
  });
});

Deno.test("two installers on one root do not interleave", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, ".install.lock"), { recursive: true });
    assertEquals(
      await codeOfAsync(() => install(root, verified(), BINARY)),
      "INSTALL_LOCKED",
    );
    assertEquals(await currentTarget(root), null);
    // The lock belongs to whoever took it; a refusal must not remove it.
    assertEquals(
      (await lstat(join(root, ".install.lock"))).isDirectory(),
      true,
    );
  });
});

Deno.test("the lock is released after a failed install", async () => {
  await withRoot(async (root) => {
    const forged = new Uint8Array(BINARY);
    forged[0] ^= 0x01;
    await codeOfAsync(() => install(root, verified(), forged));
    assertFalse((await entries(root)).includes(".install.lock"));
    await install(root, verified(), BINARY);
  });
});

Deno.test("a relative install root is refused", async () => {
  assertEquals(
    await codeOfAsync(() => install("relative/root", verified(), BINARY)),
    "INSTALL_ROOT_INVALID",
  );
});

// --- QA round 1 on #18 slice 1: storage that misbehaves, interrupted installs,
// --- stale locks, an unsafe root, and inputs that must fail closed

/** Opens the staged file for real, then lets a test wrap how it is written. */
function opening(wrap: (real: FileHandle) => StagedFile) {
  return async (path: string): Promise<StagedFile> =>
    wrap(await open(path, "wx", 0o700));
}

const passthrough = (real: FileHandle) => ({
  sync: () => real.sync(),
  close: () => real.close(),
});

Deno.test("a write that stores fewer bytes than asked is repeated until the chunk is on disk", async () => {
  await withRoot(async (root) => {
    const result = await install(root, verified(), BINARY, {
      openStagedFile: opening((real) => ({
        ...passthrough(real),
        // The kernel may store fewer bytes than asked without an error.
        write: (buffer, offset, length) =>
          real.write(buffer, offset, Math.min(length, 5)),
      })),
    });
    assertEquals(result.status, "installed");
    assertEquals(new Uint8Array(await readFile(result.binaryPath)), BINARY);
  });
});

Deno.test("a write that stores nothing fails closed instead of spinning", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    let calls = 0;
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), BINARY, {
          upgrade: true,
          openStagedFile: opening((real) => ({
            ...passthrough(real),
            // Makes no progress at first. If the installer kept retrying it
            // would eventually be let through, so a regression shows up as an
            // install that succeeds, not as a test run that never ends.
            write: (buffer, offset, length) => {
              calls += 1;
              return calls > 50
                ? real.write(buffer, offset, length)
                : Promise.resolve({ bytesWritten: 0 });
            },
          })),
        })
      ),
      "INSTALL_IO_FAILED",
    );
    assertEquals(calls, 1);
    await assertOldIntact(root, old);
  });
});

Deno.test("a disk-full error while writing is an install failure, not an interrupted download", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), BINARY, {
          upgrade: true,
          openStagedFile: opening((real) => ({
            ...passthrough(real),
            write: () =>
              Promise.reject(
                Object.assign(new Error("no space left"), { code: "ENOSPC" }),
              ),
          })),
        })
      ),
      "INSTALL_IO_FAILED",
    );
    await assertOldIntact(root, old);
  });
});

Deno.test("a file that holds less than was reported written never replaces a working install", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), BINARY, {
          upgrade: true,
          openStagedFile: opening((real) => ({
            ...passthrough(real),
            // Reports the whole chunk written but stores half of it.
            write: async (buffer, offset, length) => {
              await real.write(buffer, offset, Math.floor(length / 2));
              return { bytesWritten: length };
            },
          })),
        })
      ),
      "INSTALL_IO_FAILED",
    );
    await assertOldIntact(root, old);
  });
});

Deno.test("the staged file is flushed to disk once, before it is closed and activated", async () => {
  await withRoot(async (root) => {
    const events: string[] = [];
    await install(root, verified(), BINARY, {
      openStagedFile: opening((real) => ({
        write: (buffer, offset, length) => real.write(buffer, offset, length),
        sync: async () => {
          events.push("sync");
          await real.sync();
        },
        close: async () => {
          events.push("close");
          await real.close();
        },
      })),
    });
    assertEquals(events, ["sync", "close"]);
  });
});

Deno.test("an installed binary is mode 0755 exactly", async () => {
  await withRoot(async (root) => {
    const result = await install(root, verified(), BINARY);
    assertEquals((await lstat(result.binaryPath)).mode & 0o777, 0o755);
  });
});

// --- an install interrupted between its two renames is finished, not wedged

Deno.test("a crash between the two renames is finished by the next run without a download", async () => {
  await withRoot(async (root) => {
    await install(root, verified(), BINARY);
    await rm(join(root, "current"));
    let downloads = 0;
    const result = await installRelease({
      root,
      manifest: verified(),
      download: () => {
        downloads += 1;
        return chunked(BINARY);
      },
      uid: 1000,
      now: NOW,
    });
    assertEquals(result.status, "installed");
    assertEquals(downloads, 0);
    assertEquals(await currentTarget(root), "releases/1.2.3-linux-x64");
    assertEquals(await entries(join(root, "releases")), ["1.2.3-linux-x64"]);
  });
});

async function repoint(root: string, release: string) {
  await rm(join(root, "current"));
  await symlink(join("releases", release), join(root, "current"));
}

Deno.test("an interrupted upgrade is finished only with consent, and without a download", async () => {
  await withRoot(async (root) => {
    await installOld(root);
    await install(root, verified(), BINARY, { upgrade: true });
    // The crash: 1.2.3 is complete on disk but `current` still names 1.0.0.
    await repoint(root, "1.0.0-linux-x64");
    assertEquals(
      await codeOfAsync(() => install(root, verified(), BINARY)),
      "INSTALL_VERSION_DIFFERS",
    );
    assertEquals(await currentTarget(root), "releases/1.0.0-linux-x64");
    let downloads = 0;
    const result = await installRelease({
      root,
      manifest: verified(),
      download: () => {
        downloads += 1;
        return chunked(BINARY);
      },
      uid: 1000,
      now: NOW,
      upgrade: true,
    });
    assertEquals(result.status, "installed");
    assertEquals(downloads, 0);
    assertEquals(await currentTarget(root), "releases/1.2.3-linux-x64");
  });
});

Deno.test("a retained older release can be rolled back to with consent", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    await install(root, verified(), BINARY, { upgrade: true });
    const result = await install(root, verified(old, "1.0.0"), old, {
      upgrade: true,
    });
    assertEquals(result.status, "installed");
    assertEquals(await currentTarget(root), "releases/1.0.0-linux-x64");
  });
});

Deno.test("a release path that is a symlink to a complete release is a collision, never adopted", async () => {
  await withRoot(async (root) => {
    const elsewhere = await mkdtemp(join(tmpdir(), "bakery-elsewhere-"));
    try {
      await install(root, verified(), BINARY);
      const releaseDir = join(root, "releases", "1.2.3-linux-x64");
      // A complete, correct release now lives outside the root, and the
      // release path inside the root points at it.
      await rename(releaseDir, join(elsewhere, "release"));
      await symlink(join(elsewhere, "release"), releaseDir);
      await rm(join(root, "current"));
      assertEquals(
        await codeOfAsync(() => install(root, verified(), BINARY)),
        "INSTALL_PATH_COLLISION",
      );
      assertEquals(await currentTarget(root), null);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

Deno.test("a release directory that does not hold the signed binary is still a collision", async () => {
  await withRoot(async (root) => {
    await install(root, verified(), BINARY);
    await rm(join(root, "current"));
    const binary = join(root, "releases", "1.2.3-linux-x64", "bakery-worker");
    // Same length as the signed binary, so only its digest can tell.
    const tampered = "x".repeat(BINARY.byteLength);
    await writeFile(binary, tampered);
    assertEquals(
      await codeOfAsync(() => install(root, verified(), BINARY)),
      "INSTALL_PATH_COLLISION",
    );
    // Refused, not repaired over: the unexpected file is left as found.
    assertEquals(await readFile(binary, "utf8"), tampered);
    assertEquals(await currentTarget(root), null);
  });
  await withRoot(async (root) => {
    // The binary is right but its record names something else.
    await install(root, verified(), BINARY);
    await rm(join(root, "current"));
    const record = join(root, "releases", "1.2.3-linux-x64", "release.json");
    const parsed = JSON.parse(await readFile(record, "utf8"));
    for (
      const change of [
        { sha256: "0".repeat(64) },
        { release: "9.9.9" },
        { target: "linux-arm64" },
      ]
    ) {
      await writeFile(record, JSON.stringify({ ...parsed, ...change }));
      assertEquals(
        await codeOfAsync(() => install(root, verified(), BINARY)),
        "INSTALL_PATH_COLLISION",
        JSON.stringify(change),
      );
      assertEquals(await currentTarget(root), null);
    }
  });
  await withRoot(async (root) => {
    await mkdir(join(root, "releases", "1.2.3-linux-x64"), { recursive: true });
    assertEquals(
      await codeOfAsync(() => install(root, verified(), BINARY)),
      "INSTALL_PATH_COLLISION",
    );
    assertEquals(await currentTarget(root), null);
  });
});

// --- a lock whose installer is gone is taken over; a live one is respected

const LOCK = ".install.lock";
// Above the kernel's pid limit (2^22), so no process can ever have this id.
const DEAD_PID = 2 ** 22 + 1;
const OWNER_PID = 4242;
type Seen = ProcessInfo | "absent" | null;

/**
 * A process table the installer consults instead of reading `/proc`. A pid with
 * no entry is absent; an entry of `null` is a process that cannot be looked up.
 */
const processes = (table: Record<number, Seen>): ProcessProbe => (pid) =>
  Promise.resolve(pid in table ? table[pid] : "absent");

const running = (start: string): ProcessInfo => ({ state: "S", start });

async function seedLock(
  root: string,
  owner: string | null,
  ageSeconds = 0,
): Promise<string> {
  const lock = join(root, LOCK);
  await mkdir(lock, { recursive: true });
  if (owner !== null) await writeFile(join(lock, "owner.json"), owner);
  if (ageSeconds > 0) {
    const past = new Date(Date.now() - ageSeconds * 1000);
    await utimes(lock, past, past);
  }
  return lock;
}

const ownedBy = (pid: number, start: string | null) =>
  JSON.stringify({ pid, start });

Deno.test("a lock held by a process that no longer exists is taken over", async () => {
  await withRoot(async (root) => {
    await seedLock(root, ownedBy(OWNER_PID, "123"));
    const result = await install(root, verified(), BINARY, {
      probeProcess: processes({}),
    });
    assertEquals(result.status, "installed");
    // No lock and no takeover marker remain.
    assertEquals(await entries(root), ["current", "releases", "staging"]);
  });
});

Deno.test("a lock whose pid now belongs to a different process is taken over", async () => {
  await withRoot(async (root) => {
    await seedLock(root, ownedBy(OWNER_PID, "123"));
    const result = await install(root, verified(), BINARY, {
      probeProcess: processes({ [OWNER_PID]: running("999") }),
    });
    assertEquals(result.status, "installed");
  });
});

Deno.test("a lock held by a live process is respected and left untouched", async () => {
  await withRoot(async (root) => {
    const owner = ownedBy(OWNER_PID, "123");
    const lock = await seedLock(root, owner);
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), BINARY, {
          probeProcess: processes({ [OWNER_PID]: running("123") }),
        })
      ),
      "INSTALL_LOCKED",
    );
    assertEquals(await readFile(join(lock, "owner.json"), "utf8"), owner);
    assertEquals(await currentTarget(root), null);
  });
});

Deno.test("a lock whose owner exited but was not yet collected is taken over", async () => {
  for (const state of ["Z", "X"]) {
    await withRoot(async (root) => {
      await seedLock(root, ownedBy(OWNER_PID, "123"));
      const result = await install(root, verified(), BINARY, {
        probeProcess: processes({ [OWNER_PID]: { state, start: "123" } }),
      });
      assertEquals(result.status, "installed", state);
    });
  }
});

Deno.test("a lock whose owner cannot be looked up is respected, never guessed dead", async () => {
  await withRoot(async (root) => {
    const lock = await seedLock(root, ownedBy(OWNER_PID, "123"));
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), BINARY, {
          probeProcess: processes({ [OWNER_PID]: null }),
        })
      ),
      "INSTALL_LOCKED",
    );
    assert((await lstat(lock)).isDirectory());
  });
});

Deno.test("a lock owner recorded without a start time is judged by its pid alone", async () => {
  await withRoot(async (root) => {
    await seedLock(root, ownedBy(OWNER_PID, null));
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), BINARY, {
          probeProcess: processes({ [OWNER_PID]: running("anything") }),
        })
      ),
      "INSTALL_LOCKED",
    );
  });
});

Deno.test("a lock with an unreadable owner is respected while young and taken over when old", async () => {
  for (const owner of [null, "{not json", JSON.stringify({ pid: "x" })]) {
    await withRoot(async (root) => {
      await seedLock(root, owner);
      assertEquals(
        await codeOfAsync(() => install(root, verified(), BINARY)),
        "INSTALL_LOCKED",
        `young, owner ${owner}`,
      );
    });
    await withRoot(async (root) => {
      await seedLock(root, owner, 120);
      assertEquals(
        (await install(root, verified(), BINARY)).status,
        "installed",
        `old, owner ${owner}`,
      );
    });
  }
});

Deno.test("the installer records its own pid and start time in the lock", async () => {
  await withRoot(async (root) => {
    let during: string | undefined;
    await install(root, verified(), BINARY, {
      probeProcess: (pid) =>
        Promise.resolve(pid === process.pid ? running("777") : "absent"),
      openStagedFile: async (path) => {
        // The lock is held while the artifact is being staged.
        during = await readFile(join(root, LOCK, "owner.json"), "utf8");
        return await open(path, "wx", 0o700);
      },
    });
    assertEquals(JSON.parse(during ?? "null"), {
      pid: process.pid,
      start: "777",
    });
  });
});

Deno.test("two installers cannot both take over the same dead lock", async () => {
  await withRoot(async (root) => {
    await seedLock(root, ownedBy(OWNER_PID, "1"));
    // The seeded owner is gone; the installers, which share this process, are
    // alive, so a lock one of them takes is respected by the others.
    const probeProcess = processes({ [process.pid]: running("1") });
    const settled = await Promise.allSettled([
      install(root, verified(), BINARY, { probeProcess }),
      install(root, verified(), BINARY, { probeProcess }),
      install(root, verified(), BINARY, { probeProcess }),
    ]);
    const outcomes = settled.map((s) =>
      s.status === "fulfilled"
        ? s.value.status
        : (s.reason as BootstrapError).code
    );
    assertEquals(
      outcomes.filter((o) => o === "installed").length,
      1,
      outcomes.join(),
    );
    for (const outcome of outcomes) {
      assert(
        ["installed", "already-installed", "INSTALL_LOCKED"].includes(outcome),
        outcome,
      );
    }
    assertEquals(await currentTarget(root), "releases/1.2.3-linux-x64");
    assertFalse((await entries(root)).includes(LOCK));
  });
});

Deno.test("a takeover that was itself abandoned does not wedge the root", async () => {
  await withRoot(async (root) => {
    await seedLock(root, ownedBy(OWNER_PID, "1"));
    const probeProcess = processes({});
    const mutex = join(root, `${LOCK}.takeover`);
    await mkdir(mutex);
    // Fresh: another installer is mid-takeover, so this one stands aside.
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), BINARY, { probeProcess })
      ),
      "INSTALL_LOCKED",
    );
    assert((await lstat(mutex)).isDirectory());
    const past = new Date(Date.now() - 600_000);
    await utimes(mutex, past, past);
    assertEquals(
      (await install(root, verified(), BINARY, { probeProcess })).status,
      "installed",
    );
    assertFalse((await entries(root)).includes(`${LOCK}.takeover`));
  });
});

Deno.test("partial downloads left by a dead run are swept before the next install", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "staging", "deadbeef"), { recursive: true });
    await writeFile(
      join(root, "staging", "deadbeef", "bakery-worker"),
      "partial",
    );
    await install(root, verified(), BINARY);
    assertEquals(await entries(join(root, "staging")), []);
  });
});

// --- the real /proc, in a Node process: the Deno unit lane may not read /proc,
// --- and Node is what runs the installer, so these runs use the real probe

const NODE_INSTALL = `import { readFileSync, writeFileSync } from "node:fs";
import { installRelease } from process.argv[3];
const s = JSON.parse(readFileSync(process.argv[2], "utf8"));
const bytes = Buffer.from(s.bytes, "base64");
try {
  const result = await installRelease({
    root: s.root,
    manifest: s.manifest,
    uid: 1000,
    now: new Date(s.now),
    upgrade: s.upgrade === true,
    download: async function* () {
      yield bytes.subarray(0, 7);
      if (s.stallAfterFirstChunk) {
        writeFileSync(s.ready, "x");
        await new Promise(() => setInterval(() => {}, 1000));
      }
      yield bytes.subarray(7);
    },
  });
  process.stdout.write(JSON.stringify({ status: result.status }) + "\\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code ?? error.name }) + "\\n");
}
`;
const INSTALL_URL = new URL(
  "../../packages/worker-bootstrap/src/install.ts",
  import.meta.url,
).href;

/** A Node process running one install, and the means to wait for its report. */
type NodeRun = Readonly<{
  child: ChildProcess;
  dir: string;
  /** Resolves with everything the process printed once it has exited. */
  done: Promise<string>;
}>;

async function inNode(
  root: string,
  over: { stall?: string; upgrade?: boolean } = {},
): Promise<NodeRun> {
  const dir = await mkdtemp(join(tmpdir(), "bakery-bootstrap-child-"));
  const spec = join(dir, "spec.json");
  const script = join(dir, "child.mjs");
  await writeFile(
    spec,
    JSON.stringify({
      root,
      manifest: verified(),
      bytes: Buffer.from(BINARY).toString("base64"),
      now: NOW.toISOString(),
      upgrade: over.upgrade,
      stallAfterFirstChunk: over.stall !== undefined,
      ready: over.stall,
    }),
  );
  await writeFile(
    script,
    NODE_INSTALL.replace("process.argv[3]", JSON.stringify(INSTALL_URL)),
  );
  const child = spawn("node", [script, spec], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let printed = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    printed += chunk;
  });
  const done = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve(printed));
  });
  return { child, dir, done };
}

/** Ends a run that may still be going, waits for it, and removes its files. */
async function finish(run: NodeRun): Promise<void> {
  run.child.kill("SIGKILL");
  await run.done.catch(() => "");
  await rm(run.dir, { recursive: true, force: true });
}

/** Runs one install in Node to completion and returns what it reported. */
async function installInNode(root: string): Promise<Record<string, string>> {
  const run = await inNode(root);
  try {
    return JSON.parse((await run.done).trim());
  } finally {
    await finish(run);
  }
}

Deno.test("the real /proc probe: a dead owner is taken over, a live one is respected", async () => {
  await withRoot(async (root) => {
    await seedLock(root, ownedBy(DEAD_PID, "123"));
    assertEquals(await installInNode(root), { status: "installed" });
  });
  await withRoot(async (root) => {
    // This test process is alive, and its start time is not recorded.
    await seedLock(root, ownedBy(process.pid, null));
    assertEquals(await installInNode(root), { code: "INSTALL_LOCKED" });
    assert((await lstat(join(root, LOCK))).isDirectory());
  });
  await withRoot(async (root) => {
    // The same pid with a start time it never had: a different process. Zero
    // is no running process's start time (it is also what the neighbouring
    // /proc field always holds, so reading the wrong field would match it).
    await seedLock(root, ownedBy(process.pid, "0"));
    assertEquals(await installInNode(root), { status: "installed" });
  });
});

Deno.test("an installer killed mid-download leaves a lock and a partial file that the next run recovers", async () => {
  await withRoot(async (root) => {
    const flag = join(root, "..", `ready-${Date.now()}-${process.pid}`);
    const run = await inNode(root, { stall: flag });
    try {
      const deadline = Date.now() + 20_000;
      while (!(await stat(flag).then(() => true, () => false))) {
        assert(Date.now() < deadline, "the child never reached the download");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // While that installer is alive, its lock holds against a second one,
      // judged by the pid and start time it recorded itself.
      assertEquals(await installInNode(root), { code: "INSTALL_LOCKED" });
      assert((await lstat(join(root, LOCK))).isDirectory());
      run.child.kill("SIGKILL");
      await run.done;
      // What a kill leaves behind: the lock and a partial staged file.
      assert((await lstat(join(root, LOCK))).isDirectory());
      assertEquals((await entries(join(root, "staging"))).length, 1);
      assertEquals(await installInNode(root), { status: "installed" });
      assertEquals(
        new Uint8Array(
          await readFile(
            join(root, "releases", "1.2.3-linux-x64", "bakery-worker"),
          ),
        ),
        BINARY,
      );
      assertEquals(await entries(join(root, "staging")), []);
      assertFalse((await entries(root)).includes(LOCK));
    } finally {
      await rm(flag, { force: true });
      await finish(run);
    }
  });
});

// --- the root itself

Deno.test("a root other users can write to is refused before anything is written", async () => {
  for (const mode of [0o777, 0o775, 0o757]) {
    await withRoot(async (root) => {
      await chmod(root, mode);
      assertEquals(
        await codeOfAsync(() => install(root, verified(), BINARY)),
        "INSTALL_ROOT_INVALID",
        mode.toString(8),
      );
      assertEquals(await entries(root), []);
    });
  }
});

Deno.test("a root that is a symlink is refused and nothing is written through it", async () => {
  await withRoot(async (real) => {
    const parent = await mkdtemp(join(tmpdir(), "bakery-bootstrap-link-"));
    try {
      const link = join(parent, "root");
      await symlink(real, link);
      assertEquals(
        await codeOfAsync(() => install(link, verified(), BINARY)),
        "INSTALL_ROOT_INVALID",
      );
      assertEquals(await entries(real), []);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

Deno.test("root is refused whether it is the real or the effective user", () => {
  assert(runsAsRoot({ real: 0 }));
  assert(runsAsRoot({ effective: 0 }));
  assert(runsAsRoot({ real: 1000, effective: 0 }));
  assert(runsAsRoot({ real: 0, effective: 1000 }));
  assertFalse(runsAsRoot({ real: 1000, effective: 1000 }));
  assertFalse(runsAsRoot({}));
});

// --- inputs that must fail closed

Deno.test("an unusable clock or protocol never lets a manifest through", () => {
  const signed = envelope(manifestFor(BINARY));
  assertEquals(
    codeOf(() =>
      verifySignedManifest(signed, { ...VERIFY, now: new Date(NaN) })
    ),
    "CLOCK_INVALID",
  );
  // A manifest that expired in 2020 must not verify against a broken clock.
  const expired = envelope(manifestFor(BINARY, {
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-02-01T00:00:00.000Z",
  }));
  assertEquals(
    codeOf(() =>
      verifySignedManifest(expired, { ...VERIFY, now: new Date(NaN) })
    ),
    "CLOCK_INVALID",
  );
  for (const protocol of [NaN, 3.5, Infinity]) {
    assertEquals(
      codeOf(() => verifySignedManifest(signed, { ...VERIFY, protocol })),
      "MANIFEST_PROTOCOL_INCOMPATIBLE",
      String(protocol),
    );
  }
});

Deno.test("an installer given an invalid clock writes nothing", async () => {
  await withRoot(async (root) => {
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), BINARY, { now: new Date(NaN) })
      ),
      "CLOCK_INVALID",
    );
    assertEquals(await entries(root), []);
  });
});

Deno.test("clock skew is allowed up to five minutes and not a millisecond more", () => {
  const edge = new Date(NOW.getTime() + 5 * 60 * 1000);
  verifySignedManifest(
    envelope(manifestFor(BINARY, { issuedAt: edge.toISOString() })),
    VERIFY,
  );
  assertEquals(
    codeOf(() =>
      verifySignedManifest(
        envelope(manifestFor(BINARY, {
          issuedAt: new Date(edge.getTime() + 1).toISOString(),
        })),
        VERIFY,
      )
    ),
    "MANIFEST_NOT_YET_VALID",
  );
});

Deno.test("base64 that decodes to the signed bytes but is not canonical is refused", () => {
  // Pad the payload to 1 mod 3 bytes so the last base64 digit has four unused
  // bits, then set one of them: the same bytes, a different spelling.
  let text = JSON.stringify(manifestFor(BINARY));
  while (Buffer.byteLength(text) % 3 !== 1) text += " ";
  const bytes = Buffer.from(text, "utf8");
  const canonical = bytes.toString("base64");
  assert(canonical.endsWith("=="));
  const digits =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = canonical.length - 3;
  const flipped = digits[digits.indexOf(canonical[last]) ^ 1];
  const variant = canonical.slice(0, last) + flipped + "==";
  assertEquals(Buffer.from(variant, "base64"), bytes);
  assertEquals(
    codeOf(() =>
      verifySignedManifest(
        JSON.stringify({
          keyId: KEY.keyId,
          payload: variant,
          signature: sign(null, bytes, KEY.privateKey).toString("base64"),
        }),
        VERIFY,
      )
    ),
    "MANIFEST_MALFORMED",
  );
});

Deno.test("an envelope with an extra or missing key is refused", () => {
  const good = JSON.parse(envelope(manifestFor(BINARY)));
  assertEquals(
    codeOf(() =>
      verifySignedManifest(JSON.stringify({ ...good, extra: 1 }), VERIFY)
    ),
    "MANIFEST_MALFORMED",
  );
  const { signature: _signature, ...withoutSignature } = good;
  assertEquals(
    codeOf(() =>
      verifySignedManifest(JSON.stringify(withoutSignature), VERIFY)
    ),
    "MANIFEST_MALFORMED",
  );
});

function signedText(payloadText: string, envelopeText?: (p: string) => string) {
  const bytes = Buffer.from(payloadText, "utf8");
  const payload = bytes.toString("base64");
  const signature = sign(null, bytes, KEY.privateKey).toString("base64");
  return envelopeText
    ? envelopeText(payload).replace("SIGNATURE", signature)
    : JSON.stringify({ keyId: KEY.keyId, payload, signature });
}

Deno.test("a repeated JSON key is refused, however it is spelled", () => {
  const base = JSON.stringify(manifestFor(BINARY));
  const injected: [string, string][] = [
    [
      "top level",
      base.replace('"release":"1.2.3"', '"release":"9.9.9","release":"1.2.3"'),
    ],
    [
      "escaped spelling of the same key",
      base.replace(
        '"release":"1.2.3"',
        '"release":"9.9.9","relea\\u0073e":"1.2.3"',
      ),
    ],
    [
      "nested in protocol",
      base.replace('"min":3', '"min":9,"min":3'),
    ],
    [
      "nested in a target entry",
      base.replace(
        `"size":${BINARY.byteLength}`,
        `"size":1,"size":${BINARY.byteLength}`,
      ),
    ],
  ];
  for (const [name, text] of injected) {
    assert(text !== base, `${name}: the injection did not apply`);
    assertEquals(
      codeOf(() => verifySignedManifest(signedText(text), VERIFY)),
      "MANIFEST_MALFORMED",
      name,
    );
  }
  const repeatedEnvelopeKey = signedText(
    base,
    (payload) =>
      `{"keyId":"${KEY.keyId}","keyId":"${KEY.keyId}","payload":"${payload}","signature":"SIGNATURE"}`,
  );
  assertEquals(
    codeOf(() => verifySignedManifest(repeatedEnvelopeKey, VERIFY)),
    "MANIFEST_MALFORMED",
  );
  // The same key name in different objects is ordinary JSON.
  assertEquals(
    verifySignedManifest(signedText(base), VERIFY).release,
    "1.2.3",
  );
});

Deno.test("a handle that reports an impossible byte count is not believed", async () => {
  const claims: [string, (length: number) => number][] = [
    ["more than it was given", (length) => length + 1],
    ["not a number", () => NaN],
    ["a fraction", (length) => length - 0.5],
  ];
  for (const [name, claim] of claims) {
    await withRoot(async (root) => {
      const old = await installOld(root);
      assertEquals(
        await codeOfAsync(() =>
          install(root, verified(), BINARY, {
            upgrade: true,
            openStagedFile: opening((real) => ({
              ...passthrough(real),
              write: async (buffer, offset, length) => {
                // The bytes really are written; only the report is wrong.
                await real.write(buffer, offset, length);
                return { bytesWritten: claim(length) };
              },
            })),
          })
        ),
        "INSTALL_IO_FAILED",
        name,
      );
      await assertOldIntact(root, old);
    });
  }
});

Deno.test("a file of the right length but other bytes never replaces a working install", async () => {
  await withRoot(async (root) => {
    const old = await installOld(root);
    assertEquals(
      await codeOfAsync(() =>
        install(root, verified(), BINARY, {
          upgrade: true,
          openStagedFile: opening((real) => ({
            ...passthrough(real),
            // Reports and stores the right count, with every byte changed.
            write: (buffer, offset, length) =>
              real.write(
                new Uint8Array(buffer.byteLength).fill(0x41),
                offset,
                length,
              ),
          })),
        })
      ),
      "INSTALL_IO_FAILED",
    );
    await assertOldIntact(root, old);
  });
});

Deno.test("repeated-key detection reads JSON the way a parser does", () => {
  const repeated = [
    '{"a":1,"a":2}',
    '{"a":1,"b":{"c":1,"c":2}}',
    '{"a":[{"k":1,"k":2}]}',
    '{"a":1,"\\u0061":2}',
    '{"a\\"b":1,"a\\"b":2}',
    '{ "a" : 1 , "a" : 2 }',
  ];
  for (const text of repeated) {
    JSON.parse(text);
    assert(hasDuplicateKeys(text), text);
  }
  const fine = [
    "{}",
    "[]",
    '{"a":1,"b":2}',
    '{"a":{"a":1}}',
    '{"a":[{"a":1},{"a":2}]}',
    '{"a":"a","b":"a"}',
    '{"a":["a","a"]}',
    '{"a\\"b":1,"a":2}',
    '{"a":"x\\",\\"a\\":1"}',
    '{"a":{"b":1},"c":{"b":2}}',
    // The same name at different depths is not a repeat: containers close.
    '{"a":{"x":1},"x":2}',
    '{"a":[{"x":1}],"x":2}',
    '{"a":{"b":{"x":1},"x":2},"x":3}',
  ];
  for (const text of fine) {
    JSON.parse(text);
    assertFalse(hasDuplicateKeys(text), text);
  }
});

// --- reviewer lows: half-made `current` links and dots-only release names

Deno.test("a half-made current link left by a dead installer is swept, and nothing else is", async () => {
  await withRoot(async (root) => {
    // What an installer killed between creating the link and renaming it
    // leaves behind, plus names a sweep must not touch.
    await symlink("releases/none", join(root, ".current-0123456789ab"));
    await symlink("releases/none", join(root, ".current-ABCDEF012345"));
    await symlink("releases/none", join(root, ".current-0123456789abc"));
    await writeFile(join(root, ".current-notes"), "keep");
    await writeFile(join(root, "keep.txt"), "keep");
    assertEquals((await install(root, verified(), BINARY)).status, "installed");
    assertEquals(await entries(root), [
      ".current-0123456789abc",
      ".current-ABCDEF012345",
      ".current-notes",
      "current",
      "keep.txt",
      "releases",
      "staging",
    ]);
    assertEquals(await currentTarget(root), "releases/1.2.3-linux-x64");
  });
});

Deno.test("a current link to a dots-only name is corrupt, and no record is read through it", async () => {
  // Where a record would be found if `releases/<dots>` were followed.
  const reached: [string, string[]][] = [
    [".", ["releases"]],
    ["..", []],
    ["...", ["releases", "..."]],
  ];
  for (const [dots, where] of reached) {
    await withRoot(async (root) => {
      await mkdir(join(root, "releases", ...where.slice(1)), {
        recursive: true,
      });
      // The target is written literally: `join` would fold `releases/..`
      // into `.` and the link would never point where this test says.
      const target = `releases/${dots}`;
      await symlink(target, join(root, "current"));
      // A trusted-looking record sits where that link would be followed to, so
      // only the name check can refuse: without it the record would be read.
      await writeFile(
        join(root, ...where, "release.json"),
        JSON.stringify({
          release: "1.2.3",
          target: "linux-x64",
          sha256: sha(BINARY),
        }),
      );
      const before = await entries(join(root, "releases"));
      for (const upgrade of [false, true]) {
        assertEquals(
          await codeOfAsync(() =>
            install(root, verified(), BINARY, { upgrade })
          ),
          "INSTALL_CORRUPT",
          `${dots} upgrade=${upgrade}`,
        );
      }
      assertEquals(await currentTarget(root), target);
      assertEquals(await entries(join(root, "releases")), before);
    });
  }
});

Deno.test("dotted release names that are real names still install", async () => {
  await withRoot(async (root) => {
    const result = await install(
      root,
      verified(BINARY, "10.20.30-rc.1"),
      BINARY,
    );
    assertEquals(result.status, "installed");
    assertEquals(await currentTarget(root), "releases/10.20.30-rc.1-linux-x64");
  });
});
