import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  readArtifact,
  runBackupScript,
  StepError,
} from "../../scripts/deploy/backup-runner/backup-step.ts";
import { createSecrets } from "../../scripts/deploy/backup-runner/redact.ts";
import {
  STORES,
  writeBackupManifest,
} from "../../scripts/deploy/backup-runner/manifest.ts";

const NAME = "20261120T030000Z-00000000-0000-4000-8000-000000000001";

async function withRoot<T>(
  run: (root: string, script: (body: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-runner-step-" });
  try {
    const root = `${dir}/backups`;
    await Deno.mkdir(root);
    const script = async (body: string) => {
      const path = `${dir}/backup.sh`;
      await Deno.writeTextFile(
        path,
        `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
      );
      await Deno.chmod(path, 0o755);
      return path;
    };
    return await run(root, script);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const secrets = () => createSecrets(["super-secret-value-123"]);

/** A complete set on disk, as backup.sh leaves it: every store plus its manifest. */
async function writeCompleteSet(
  directory: string,
  skip: readonly string[] = [],
  manifest = true,
): Promise<void> {
  await Deno.mkdir(directory);
  for (const store of STORES) {
    if (store.file === null || skip.includes(store.file)) continue;
    await Deno.writeTextFile(
      join(directory, store.file),
      store.file === "release.json"
        ? JSON.stringify({ format: 1, active: { sha: "c".repeat(40) } })
        : `bytes of ${store.id}`,
    );
  }
  if (manifest) {
    await writeBackupManifest({
      directory,
      startedAt: new Date("2026-11-20T03:00:00.000Z"),
      finishedAt: new Date("2026-11-20T03:01:00.000Z"),
      key: { state: "configured", id: "key-2026" },
      references: { skillFiles: 1, blobs: 0 },
    });
  }
}

const announce = (name: string) => `printf 'BACKUP_COMPLETED %s\\n' "${name}"`;

Deno.test("a successful script's complete set is read back with sizes, sorted, and a total", async () => {
  await withRoot(async (root, script) => {
    await writeCompleteSet(`${root}/${NAME}`);
    await Deno.mkdir(`${root}/${NAME}/not-a-file`);
    const path = await script(announce(NAME));
    const artifact = await runBackupScript({
      script: path,
      root,
      secrets: secrets(),
    });
    assertEquals(artifact.name, NAME);
    assertEquals(artifact.directory, `${root}/${NAME}`);
    assertEquals(artifact.files.map((f) => f.name), [
      "SHA256SUMS",
      "bakery.dump.age",
      "files.tar.gz.age",
      "inngest.dump.age",
      "manifest.json",
      "redis.rdb.age",
      "references.json.age",
      "release.json",
    ]);
    assertEquals(
      artifact.totalBytes,
      artifact.files.reduce((sum, f) => sum + f.size, 0),
    );
    assertEquals(
      artifact.files.find((f) => f.name === "inngest.dump.age")?.size,
      "bytes of postgres-inngest".length,
    );
  });
});

Deno.test("a finished set missing a declared store is refused as incomplete_set", async () => {
  await withRoot(async (root, script) => {
    // The script claims success, but the set is missing Redis: the runner
    // reads the manifest check, not the script's word.
    await writeCompleteSet(`${root}/${NAME}`);
    await Deno.remove(`${root}/${NAME}/redis.rdb.age`);
    const path = await script(announce(NAME));
    const error = await assertRejects(
      () => runBackupScript({ script: path, root, secrets: secrets() }),
      StepError,
    );
    assertEquals(error.code, "incomplete_set");
    assert(error.detail.includes("redis"), error.detail);
    assert(error.detail.length <= 1000);
  });
});

Deno.test("a set with no manifest is refused as incomplete_set", async () => {
  await withRoot(async (root, script) => {
    await writeCompleteSet(`${root}/${NAME}`, [], false);
    await Deno.writeTextFile(`${root}/${NAME}/SHA256SUMS`, "x");
    const path = await script(announce(NAME));
    const error = await assertRejects(
      () => runBackupScript({ script: path, root, secrets: secrets() }),
      StepError,
    );
    assertEquals(error.code, "incomplete_set");
    assert(error.detail.includes("no_manifest"), error.detail);
  });
});

Deno.test("a script that reports BACKUP_INCOMPLETE is incomplete_set, and specific causes win", async () => {
  await withRoot(async (root, script) => {
    const incomplete = await script(
      `echo "BACKUP_INCOMPLETE redis: store_not_captured (the capture failed)" >&2; exit 70`,
    );
    const error = await assertRejects(
      () => runBackupScript({ script: incomplete, root, secrets: secrets() }),
      StepError,
    );
    assertEquals(error.code, "incomplete_set");
    assert(error.detail.includes("redis"), error.detail);
    // A full disk or a missing age recipient is the more useful cause.
    const disk = await script(
      `echo "No space left on device" >&2; echo "BACKUP_INCOMPLETE files" >&2; exit 70`,
    );
    const full = await assertRejects(
      () => runBackupScript({ script: disk, root, secrets: secrets() }),
      StepError,
    );
    assertEquals(full.code, "disk_full");
    const key = await script(
      `echo "age: error: failed to parse recipient" >&2; echo "BACKUP_INCOMPLETE files" >&2; exit 70`,
    );
    const missing = await assertRejects(
      () => runBackupScript({ script: key, root, secrets: secrets() }),
      StepError,
    );
    assertEquals(missing.code, "key_missing");
  });
});

Deno.test("a script that fails maps to the failure code and its detail is redacted and bounded", async () => {
  await withRoot(async (root, script) => {
    const disk = await script(
      `echo "tar: write error: No space left on device super-secret-value-123" >&2; exit 1`,
    );
    const error = await assertRejects(
      () => runBackupScript({ script: disk, root, secrets: secrets() }),
      StepError,
    );
    assertEquals(error.code, "disk_full");
    assert(!error.detail.includes("super-secret-value-123"));
    assert(error.detail.includes("exit 1"));

    const key = await script(
      `echo "backup.sh: line 14: age: command not found" >&2; exit 127`,
    );
    const keyError = await assertRejects(
      () => runBackupScript({ script: key, root, secrets: secrets() }),
      StepError,
    );
    assertEquals(keyError.code, "key_missing");

    const other = await script(
      `yes 'pg_dump: error: something odd' | head -n 5000 >&2; exit 2`,
    );
    const otherError = await assertRejects(
      () => runBackupScript({ script: other, root, secrets: secrets() }),
      StepError,
    );
    assertEquals(otherError.code, "runner_error");
    assert(otherError.detail.length <= 1000);
  });
});

Deno.test("a script that exits 0 without naming a real set is refused", async () => {
  await withRoot(async (root, script) => {
    const silent = await script(`true`);
    const none = await assertRejects(
      () => runBackupScript({ script: silent, root, secrets: secrets() }),
      StepError,
    );
    assertEquals(none.code, "runner_error");
    for (
      const bad of [
        "../etc",
        "latest",
        `${NAME}/x`,
        "20261320T030000Z-00000000-0000-4000-8000-000000000001",
      ]
    ) {
      const named = await script(`printf 'BACKUP_COMPLETED %s\\n' '${bad}'`);
      const error = await assertRejects(
        () => runBackupScript({ script: named, root, secrets: secrets() }),
        StepError,
        "",
        bad,
      );
      assertEquals(error.code, "runner_error", bad);
    }
    // A named set that is not there, and an empty one.
    const missing = await script(`printf 'BACKUP_COMPLETED %s\\n' '${NAME}'`);
    await assertRejects(() =>
      runBackupScript({ script: missing, root, secrets: secrets() })
    );
    await Deno.mkdir(`${root}/${NAME}`);
    const error = await assertRejects(
      () => readArtifact(root, NAME),
      StepError,
    );
    assertEquals(error.code, "runner_error");
  });
});

Deno.test("a script that cannot start, or is cancelled, is a runner error", async () => {
  await withRoot(async (root) => {
    const error = await assertRejects(
      () =>
        runBackupScript({
          script: `${root}/nope.sh`,
          root,
          secrets: secrets(),
        }),
      StepError,
    );
    assertEquals(error.code, "runner_error");
  });
  await withRoot(async (root, script) => {
    const slow = await script(`sleep 30`);
    const abort = new AbortController();
    const started = performance.now();
    const pending = runBackupScript({
      script: slow,
      root,
      secrets: secrets(),
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 100);
    const error = await assertRejects(() => pending, StepError);
    assertEquals(error.code, "runner_error");
    assert(performance.now() - started < 10_000);
  });
});
