import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  readArtifact,
  runBackupScript,
  StepError,
} from "../../scripts/deploy/backup-runner/backup-step.ts";
import { createSecrets } from "../../scripts/deploy/backup-runner/redact.ts";

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

Deno.test("a successful script's set is read back with sizes, sorted, and a total", async () => {
  await withRoot(async (root, script) => {
    const path = await script(`
d="${root}/${NAME}"; mkdir "$d"
printf 'aaaa' > "$d/bakery.dump.age"
printf 'bb' > "$d/inngest.dump.age"
printf 'c' > "$d/SHA256SUMS"
printf '{}' > "$d/release.json"
mkdir "$d/not-a-file"
printf 'BACKUP_COMPLETED %s\\n' "${NAME}"
`);
    const artifact = await runBackupScript({
      script: path,
      root,
      secrets: secrets(),
    });
    assertEquals(artifact.name, NAME);
    assertEquals(artifact.directory, `${root}/${NAME}`);
    assertEquals(
      artifact.files.map((f) => [f.name, f.size]),
      [
        ["SHA256SUMS", 1],
        ["bakery.dump.age", 4],
        ["inngest.dump.age", 2],
        ["release.json", 2],
      ],
    );
    assertEquals(artifact.totalBytes, 9);
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
