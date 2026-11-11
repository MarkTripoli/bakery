import { assert, assertEquals, assertFalse } from "@std/assert";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootstrapError,
  detectTarget,
  installRelease,
  type VerifiedManifest,
  verifySignedManifest,
} from "../../packages/worker-bootstrap/src/index.ts";

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
      manifestFor(BINARY, { targets: { "plan9-mips": {} } }),
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
  over: Record<string, unknown> = {},
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
