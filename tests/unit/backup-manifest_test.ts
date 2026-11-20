import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  CHECKSUMS_FILE,
  describeProblems,
  hashFile,
  IncompleteBackup,
  type Manifest,
  MANIFEST_FILE,
  STORES,
  verifyBackupDirectory,
  writeBackupManifest,
} from "../../scripts/deploy/backup-runner/manifest.ts";

/**
 * #64 slice A: the completeness manifest. A backup set is complete only when
 * every declared required store is captured and every file matches what the
 * manifest recorded; anything else is incomplete, with the exact stores named.
 */

const started = new Date("2026-11-20T03:00:00.000Z");
const finished = new Date("2026-11-20T03:04:00.000Z");
const SHA = "a".repeat(40);

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
  key: { state: "configured" as const, id: "key-2026" },
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
    assertEquals(manifest.cutoffAt, started.toISOString());
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
    assertEquals(result, { complete: true, legacy: false, problems: [] });
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
          key: { state: "configured", id: "has spaces" },
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
      JSON.stringify({ ...manifest, format: 2 }),
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
