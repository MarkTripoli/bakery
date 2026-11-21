import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  CHECKSUMS_FILE,
  describeProblems,
  hashFile,
  INCOMPLETE_FILE,
  IncompleteBackup,
  isDeclaredIncomplete,
  KEY_FINGERPRINT_DOMAIN,
  keyFingerprint,
  type Manifest,
  MANIFEST_FILE,
  STORES,
  verifyBackupDirectory,
  writeBackupManifest,
  writeChecksums,
} from "../../scripts/deploy/backup-runner/manifest.ts";
import type { Cutoff } from "../../apps/server/src/modules/backups/cutoff-rules.ts";

/**
 * #64 slice A: the completeness manifest. A backup set is complete only when
 * every declared required store is captured and every file matches what the
 * manifest recorded; anything else is incomplete, with the exact stores named.
 */

const started = new Date("2026-11-20T03:00:00.000Z");
const finished = new Date("2026-11-20T03:04:00.000Z");
const SHA = "a".repeat(40);
const KEY_BYTES = "unit-test-secret-key-bytes-0123456789";

async function makeSet(
  skip: readonly string[] = [],
): Promise<string> {
  const directory = await Deno.makeTempDir({ prefix: "bakery-manifest-test-" });
  for (const store of STORES) {
    if (store.file === null || skip.includes(store.file)) continue;
    const body = store.file === "release.json"
      ? JSON.stringify({ format: 1, active: { sha: SHA }, migrations: {} })
      : `encrypted bytes of ${store.id}`;
    await Deno.writeTextFile(join(directory, store.file), body);
  }
  return directory;
}

const baseInput = (directory: string) => ({
  directory,
  startedAt: started,
  finishedAt: finished,
  key: {
    state: "configured" as const,
    id: "key-2026",
    fingerprint: keyFingerprint(new TextEncoder().encode(KEY_BYTES)),
  },
  references: { skillFiles: 12, blobs: 3 },
});

Deno.test("the registry names every store once, each required one with a file", () => {
  const ids = STORES.map((store) => store.id);
  assertEquals(new Set(ids).size, ids.length);
  const files = STORES.flatMap((store) => store.file ? [store.file] : []);
  assertEquals(new Set(files).size, files.length);
  for (const file of files) assert(/^[A-Za-z0-9._-]+$/.test(file), file);
  for (const store of STORES) {
    if (store.required && store.id !== "secrets-key-identity") {
      assert(store.file !== null, `${store.id} is required but has no file`);
    }
    // A store that is never in the set says why, so absence is explicit.
    if (!store.required) {
      assert(
        store.excludedReason && store.excludedReason.length > 10,
        `${store.id} is excluded without a reason`,
      );
    }
  }
  // The stores the issue names are all declared.
  for (
    const id of [
      "postgres-bakery",
      "postgres-inngest",
      "redis",
      "files",
      "release-journal",
      "object-references",
      "secrets-key-identity",
    ]
  ) assert(ids.includes(id), id);
});

Deno.test("a complete set gets a manifest and checksums, and verifies", async () => {
  const directory = await makeSet();
  try {
    const manifest = await writeBackupManifest(baseInput(directory));
    assertEquals(manifest.stores.length, STORES.length);
    assertEquals(manifest.release.sha, SHA);
    // No runner took this backup: the cutoff is the host clock, marked weaker.
    assertEquals(manifest.cutoff, {
      at: started.toISOString(),
      source: "host-clock",
      effects: null,
    });
    assertEquals(manifest.references, { skillFiles: 12, blobs: 3 });
    const bakery = manifest.stores.find((s) => s.id === "postgres-bakery")!;
    assertEquals(bakery.status, "captured");
    assertEquals(bakery.file, "bakery.dump.age");
    assertEquals(
      bakery.sha256,
      (await hashFile(join(directory, "bakery.dump.age"))).sha256,
    );
    // Excluded stores are listed with their reason, not left out.
    const incoming = manifest.stores.find((s) => s.id === "incoming")!;
    assertEquals(incoming.status, "excluded");
    assert(incoming.reason && incoming.reason.length > 0);
    // The checksum file covers the manifest and the release journal too.
    const sums = await Deno.readTextFile(join(directory, CHECKSUMS_FILE));
    assert(sums.includes("./manifest.json"));
    assert(sums.includes("./release.json"));
    assert(!sums.includes("SHA256SUMS"));
    const result = await verifyBackupDirectory(directory);
    assertEquals(result, {
      complete: true,
      legacy: false,
      cutoff: manifest.cutoff,
      problems: [],
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the plaintext manifest holds no secret and no object key", async () => {
  const directory = await makeSet();
  try {
    await writeBackupManifest(baseInput(directory));
    const text = await Deno.readTextFile(join(directory, MANIFEST_FILE));
    // Only the key's id is recorded; its material is never in the manifest.
    assert(text.includes("key-2026"));
    for (
      const forbidden of [
        "BEGIN",
        "AGE-SECRET-KEY",
        "objectKey",
        "organizations/",
      ]
    ) {
      assert(!text.includes(forbidden), forbidden);
    }
    assert(text.includes("operator holds it"));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a missing required store makes the set incomplete and writes no manifest", async () => {
  const directory = await makeSet(["redis.rdb.age"]);
  try {
    const error = await assertRejects(
      () => writeBackupManifest(baseInput(directory)),
      IncompleteBackup,
    );
    assertEquals(error.problems.map((p) => [p.kind, p.store]), [
      ["missing_file", "redis"],
    ]);
    assert(describeProblems(error.problems).includes("redis"));
    // Nothing that could pass as a complete set is left behind.
    const names: string[] = [];
    for await (const entry of Deno.readDir(directory)) names.push(entry.name);
    assert(!names.includes(MANIFEST_FILE));
    assert(!names.includes(CHECKSUMS_FILE));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("an empty file, a reported failure and a bad key each name their store", async () => {
  const directory = await makeSet();
  try {
    await Deno.writeTextFile(join(directory, "inngest.dump.age"), "");
    const empty = await assertRejects(
      () =>
        writeBackupManifest({
          ...baseInput(directory),
          failed: { "object-references": "the query failed" },
          key: { state: "failed", reason: "the key file is missing" },
        }),
      IncompleteBackup,
    );
    const byStore = new Map(empty.problems.map((p) => [p.store, p.detail]));
    assertEquals(byStore.get("postgres-inngest"), "the file is empty");
    assertEquals(byStore.get("object-references"), "the query failed");
    assertEquals(
      byStore.get("secrets-key-identity"),
      "the key file is missing",
    );
    assertEquals(byStore.size, 3);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("no configured secrets key is an explicit exclusion, an invalid key id is a failure", async () => {
  const directory = await makeSet();
  try {
    const manifest = await writeBackupManifest({
      ...baseInput(directory),
      key: { state: "unconfigured" },
    });
    const key = manifest.stores.find((s) => s.id === "secrets-key-identity")!;
    assertEquals(key.status, "excluded");
    assertEquals(key.reason, "no secrets key is configured on this host");
    assertEquals((await verifyBackupDirectory(directory)).complete, true);
    await assertRejects(
      () =>
        writeBackupManifest({
          ...baseInput(directory),
          key: {
            state: "configured",
            id: "has spaces",
            fingerprint: keyFingerprint(new TextEncoder().encode(KEY_BYTES)),
          },
        }),
      IncompleteBackup,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("verifying names a changed file, a short file, a missing file and an unlisted file", async () => {
  const directory = await makeSet();
  try {
    await writeBackupManifest(baseInput(directory));
    // Same size, different bytes.
    const same = "encrypted bytes of postgres-bakery".replace("a", "b");
    await Deno.writeTextFile(join(directory, "bakery.dump.age"), same);
    // Shorter file.
    await Deno.writeTextFile(join(directory, "redis.rdb.age"), "x");
    // Missing file.
    await Deno.remove(join(directory, "files.tar.gz.age"));
    // A file nobody listed.
    await Deno.writeTextFile(join(directory, "stray.age"), "stray");
    const result = await verifyBackupDirectory(directory);
    assertEquals(result.complete, false);
    const kinds = new Map<string, string[]>();
    for (const problem of result.problems) {
      const key = problem.store ?? problem.file;
      if (!key) continue;
      kinds.set(key, [...(kinds.get(key) ?? []), problem.kind]);
    }
    assertEquals(kinds.get("postgres-bakery"), ["hash_mismatch"]);
    assertEquals(kinds.get("redis"), ["size_mismatch"]);
    assertEquals(kinds.get("files"), ["missing_file"]);
    // The stray file is unlisted in the manifest and absent from SHA256SUMS.
    assert(kinds.get("stray.age")!.includes("unlisted_file"));
    // SHA256SUMS disagrees too, so `sha256sum --check` would fail as well.
    assert(result.problems.some((p) => p.kind === "checksums_mismatch"));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a tampered manifest, a bad format and missing checksums are incomplete", async () => {
  const directory = await makeSet();
  try {
    await writeBackupManifest(baseInput(directory));
    const original = await Deno.readTextFile(join(directory, MANIFEST_FILE));
    // A required store dropped from the manifest.
    const manifest = JSON.parse(original) as Manifest;
    await Deno.writeTextFile(
      join(directory, MANIFEST_FILE),
      JSON.stringify({
        ...manifest,
        stores: manifest.stores.filter((s) => s.id !== "redis"),
      }),
    );
    const dropped = await verifyBackupDirectory(directory);
    assert(
      dropped.problems.some((p) =>
        p.store === "redis" && p.kind === "store_not_captured"
      ),
    );
    // A required store marked excluded does not count as captured.
    await Deno.writeTextFile(
      join(directory, MANIFEST_FILE),
      JSON.stringify({
        ...manifest,
        stores: manifest.stores.map((s) =>
          s.id === "redis"
            ? { id: s.id, status: "excluded", required: true, reason: "no" }
            : s
        ),
      }),
    );
    assert(
      (await verifyBackupDirectory(directory)).problems.some((p) =>
        p.store === "redis" && p.kind === "store_not_captured"
      ),
    );
    // Not JSON, and a wrong format.
    await Deno.writeTextFile(join(directory, MANIFEST_FILE), "{nope");
    assertEquals(
      (await verifyBackupDirectory(directory)).problems[0].kind,
      "manifest_invalid",
    );
    await Deno.writeTextFile(
      join(directory, MANIFEST_FILE),
      JSON.stringify({ ...manifest, format: 99 }),
    );
    assertEquals(
      (await verifyBackupDirectory(directory)).problems[0].kind,
      "manifest_invalid",
    );
    // Restore the manifest; losing the checksum file is a problem on its own.
    await Deno.writeTextFile(join(directory, MANIFEST_FILE), original);
    await Deno.remove(join(directory, CHECKSUMS_FILE));
    const noSums = await verifyBackupDirectory(directory);
    assertEquals(noSums.complete, false);
    assertEquals(noSums.problems.map((p) => p.kind), ["checksums_mismatch"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a set from before manifests is legacy and never complete", async () => {
  const directory = await makeSet();
  try {
    const result = await verifyBackupDirectory(directory);
    assertEquals(result.complete, false);
    assertEquals(result.legacy, true);
    assertEquals(result.problems.map((p) => p.kind), ["no_manifest"]);
    const allowed = await verifyBackupDirectory(directory, {
      allowLegacy: true,
    });
    // Allowing legacy sets changes the message, never the verdict.
    assertEquals(allowed.complete, false);
    assertEquals(allowed.legacy, true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("the key fingerprint is domain-separated, stable and changes with the key", async () => {
  const key = new TextEncoder().encode(KEY_BYTES);
  const fingerprint = keyFingerprint(key);
  // 16 hex characters of SHA-256(domain || key): first 64 bits.
  assertEquals(fingerprint.length, 16);
  assert(/^[0-9a-f]{16}$/.test(fingerprint));
  assertEquals(keyFingerprint(key), fingerprint);
  const expected = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(KEY_FINGERPRINT_DOMAIN + KEY_BYTES),
      ),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  assertEquals(fingerprint, expected);
  assertEquals(KEY_FINGERPRINT_DOMAIN, "bakery-backup-key-fingerprint-v1\n");
  // A different key, and one flipped byte, give a different fingerprint.
  assert(
    keyFingerprint(new TextEncoder().encode("another key")) !== fingerprint,
  );
  const flipped = new Uint8Array(key);
  flipped[0] ^= 1;
  assert(keyFingerprint(flipped) !== fingerprint);
  // It is not the plain SHA-256 of the key: the domain separates it.
  const plain = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", key)),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  assert(plain !== fingerprint);
});

Deno.test("the manifest records the key id and fingerprint and no key bytes", async () => {
  const directory = await makeSet();
  try {
    const manifest = await writeBackupManifest(baseInput(directory));
    const key = manifest.stores.find((s) => s.id === "secrets-key-identity")!;
    assertEquals(key.keyId, "key-2026");
    assertEquals(
      key.keyFingerprint,
      keyFingerprint(new TextEncoder().encode(KEY_BYTES)),
    );
    assertEquals(key.keyFingerprintFormat, "sha256-16hex-v1");
    // The key's bytes, in any common encoding, are in no file of the set.
    const raw = new TextEncoder().encode(KEY_BYTES);
    const needles = [
      KEY_BYTES,
      btoa(KEY_BYTES),
      [...raw].map((b) => b.toString(16).padStart(2, "0")).join(""),
    ];
    for await (const entry of Deno.readDir(directory)) {
      const text = await Deno.readTextFile(join(directory, entry.name));
      for (const needle of needles) {
        assert(!text.includes(needle), `${entry.name} holds the key`);
      }
    }
    // An invalid fingerprint is a failure, not a quiet pass.
    await assertRejects(
      () =>
        writeBackupManifest({
          ...baseInput(directory),
          key: { state: "configured", id: "key-2026", fingerprint: "nothex" },
        }),
      IncompleteBackup,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a key file is checked against the recorded fingerprint, and read only for that", async () => {
  const directory = await makeSet();
  try {
    await writeBackupManifest(baseInput(directory));
    const keyFile = join(directory, "..", `key-${crypto.randomUUID()}`);
    await Deno.writeTextFile(keyFile, KEY_BYTES);
    try {
      const good = await verifyBackupDirectory(directory, { keyFile });
      assertEquals(good.complete, true);
      // The wrong key, an unreadable file and a manifest with no key all fail.
      await Deno.writeTextFile(keyFile, "a different key entirely");
      const wrong = await verifyBackupDirectory(directory, { keyFile });
      assertEquals(wrong.problems.map((p) => p.kind), ["key_mismatch"]);
      assert(wrong.problems[0].detail.includes("fingerprint differs"));
      assert(!JSON.stringify(wrong).includes("a different key entirely"));
      const missing = await verifyBackupDirectory(directory, {
        keyFile: `${keyFile}.nope`,
      });
      assertEquals(missing.problems.map((p) => p.kind), ["key_mismatch"]);
    } finally {
      await Deno.remove(keyFile);
    }
    const none = await makeSet();
    try {
      await writeBackupManifest({
        ...baseInput(none),
        key: { state: "unconfigured" },
      });
      const result = await verifyBackupDirectory(none, {
        keyFile: "/nonexistent",
      });
      assertEquals(result.problems.map((p) => p.kind), ["key_mismatch"]);
    } finally {
      await Deno.remove(none, { recursive: true });
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a set that declares itself incomplete is refused first, and no flag excuses it", async () => {
  const directory = await makeSet();
  try {
    // backup.sh writes this marker (and no manifest) when it cannot build one.
    await Deno.writeTextFile(
      join(directory, INCOMPLETE_FILE),
      JSON.stringify({
        format: 1,
        complete: false,
        cause: "manifest_builder_missing",
        detail: "deno is not installed",
        failedStores: [],
      }),
    );
    assertEquals(await isDeclaredIncomplete(directory), true);
    for (const allowLegacy of [false, true]) {
      const result = await verifyBackupDirectory(directory, { allowLegacy });
      assertEquals(result.complete, false);
      // Not legacy: a missing manifest is not what is wrong with it.
      assertEquals(result.legacy, false);
      assertEquals(result.problems.map((p) => p.kind), ["declared_incomplete"]);
      assert(result.problems[0].detail.includes("manifest_builder_missing"));
    }
    // Even a set that otherwise has a valid manifest is refused if it carries the marker.
    await writeBackupManifest(baseInput(directory));
    assertEquals(
      (await verifyBackupDirectory(directory, { allowLegacy: true })).problems
        .map((p) => p.kind),
      ["declared_incomplete"],
    );
    // An unreadable marker still marks the set.
    await Deno.writeTextFile(join(directory, INCOMPLETE_FILE), "{broken");
    const broken = await verifyBackupDirectory(directory);
    assertEquals(broken.problems.map((p) => p.kind), ["declared_incomplete"]);
    assertEquals(
      await isDeclaredIncomplete(await Deno.makeTempDir()),
      false,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

// ---- #64 slice C: the cutoff the manifest records -------------------------

const databaseCutoff: Cutoff = {
  at: "2026-11-20T02:59:58.125Z",
  source: "database",
  effects: {
    total: 2,
    prepared: 1,
    submitted: 0,
    uncertain: 1,
    byOperation: [{ operation: "github.merge", count: 2 }],
    digest: "b".repeat(64),
  },
};

/** Rewrites manifest.json and its checksums, as a hand edit would not. */
async function rewriteManifest(
  directory: string,
  change: (manifest: Record<string, unknown>) => Record<string, unknown>,
) {
  const path = join(directory, MANIFEST_FILE);
  const manifest = JSON.parse(await Deno.readTextFile(path));
  await Deno.writeTextFile(path, JSON.stringify(change(manifest)));
  await writeChecksums(directory);
}

Deno.test("a database cutoff is recorded with its census, verified, and reported back", async () => {
  const directory = await makeSet();
  try {
    const manifest = await writeBackupManifest({
      ...baseInput(directory),
      cutoff: databaseCutoff,
    });
    assertEquals(manifest.format, 2);
    assertEquals(manifest.cutoff, databaseCutoff);
    // The old host-clock field is gone from a format 2 manifest.
    assertEquals("cutoffAt" in manifest, false);
    const onDisk = JSON.parse(
      await Deno.readTextFile(join(directory, MANIFEST_FILE)),
    );
    assertEquals(onDisk.cutoff, databaseCutoff);
    const result = await verifyBackupDirectory(directory, {
      requireDatabaseCutoff: true,
    });
    assertEquals(result.complete, true);
    assertEquals(result.cutoff, databaseCutoff);
    // Counts, names and a digest only: no id, target or argument is in it.
    const text = await Deno.readTextFile(join(directory, MANIFEST_FILE));
    assert(
      !/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/.test(text),
      "a uuid leaked",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a host-clock cutoff is weaker: complete as a set, refused when a database cutoff is required", async () => {
  const directory = await makeSet();
  try {
    await writeBackupManifest(baseInput(directory));
    const plain = await verifyBackupDirectory(directory);
    assertEquals(plain.complete, true);
    assertEquals(plain.cutoff?.source, "host-clock");
    assertEquals(plain.cutoff?.effects, null);
    const strict = await verifyBackupDirectory(directory, {
      requireDatabaseCutoff: true,
    });
    assertEquals(strict.complete, false);
    assertEquals(strict.problems.map((p) => p.kind), ["cutoff_not_database"]);
    assert(strict.problems[0].detail.includes("host clock"));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a format 2 manifest without a valid cutoff is invalid", async () => {
  const directory = await makeSet();
  try {
    await writeBackupManifest({
      ...baseInput(directory),
      cutoff: databaseCutoff,
    });
    const bad: [
      string,
      (m: Record<string, unknown>) => Record<string, unknown>,
    ][] = [
      ["missing", ({ cutoff: _gone, ...rest }) => rest],
      ["null", (m) => ({ ...m, cutoff: null })],
      ["no source", (m) => ({ ...m, cutoff: { at: databaseCutoff.at } })],
      [
        "database without a census",
        (m) => ({
          ...m,
          cutoff: { at: databaseCutoff.at, source: "database" },
        }),
      ],
      [
        "census that does not add up",
        (m) => ({
          ...m,
          cutoff: {
            ...databaseCutoff,
            effects: { ...databaseCutoff.effects, total: 9 },
          },
        }),
      ],
      [
        "malformed time",
        (m) => ({ ...m, cutoff: { ...databaseCutoff, at: "soon" } }),
      ],
    ];
    for (const [name, change] of bad) {
      await rewriteManifest(directory, (manifest) => {
        // Start each case from the good manifest.
        return change({ ...manifest, cutoff: databaseCutoff });
      });
      const result = await verifyBackupDirectory(directory);
      assertEquals(result.complete, false, name);
      assertEquals(result.problems[0].kind, "manifest_invalid", name);
      assert(result.problems[0].detail.includes("cutoff"), name);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a format 1 manifest is still readable, reported without a cutoff, and refused when one is required", async () => {
  const directory = await makeSet();
  try {
    await writeBackupManifest(baseInput(directory));
    await rewriteManifest(directory, ({ cutoff: _c, ...rest }) => ({
      ...rest,
      format: 1,
      cutoffAt: started.toISOString(),
    }));
    const plain = await verifyBackupDirectory(directory);
    assertEquals(plain.complete, true);
    assertEquals(plain.cutoff, null);
    const strict = await verifyBackupDirectory(directory, {
      requireDatabaseCutoff: true,
    });
    assertEquals(strict.complete, false);
    assertEquals(strict.problems.map((p) => p.kind), ["cutoff_not_database"]);
    assert(strict.problems[0].detail.includes("predates cutoff records"));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
