import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  installDenoWrapper,
  installReleaseManifestShim,
  toolsWithoutDeno,
} from "../helpers/backup-sandbox-release.ts";
import {
  INCOMPLETE_FILE,
  STORES,
  writeBackupManifest,
} from "../../scripts/deploy/backup-runner/manifest.ts";

/**
 * #64 slice A: scripts/deploy/restore-check.sh refuses a backup set that its
 * manifest says is incomplete, or whose files do not match, before it starts
 * any container. A set from before manifests fails closed unless the operator
 * passes --allow-legacy. A `docker` shim records every call, so "stopped at the
 * gate" is proved by docker never being called.
 */

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

async function writeSet(
  directory: string,
  options: { manifest?: boolean } = {},
): Promise<void> {
  await Deno.mkdir(directory);
  for (const store of STORES) {
    if (store.file === null) continue;
    await Deno.writeTextFile(
      join(directory, store.file),
      store.file === "release.json"
        ? JSON.stringify({ format: 1, active: { sha: "d".repeat(40) } })
        : `bytes of ${store.id}`,
    );
  }
  if (options.manifest !== false) {
    await writeBackupManifest({
      directory,
      startedAt: new Date("2026-11-20T03:00:00.000Z"),
      finishedAt: new Date("2026-11-20T03:01:00.000Z"),
      key: {
        state: "configured",
        id: "key-2026",
        fingerprint: "0123456789abcdef",
      },
      references: { skillFiles: 0, blobs: 0 },
    });
  } else {
    await Deno.writeTextFile(join(directory, "SHA256SUMS"), "");
  }
}

async function withCheck(
  run: (check: {
    readonly dir: string;
    readonly set: string;
    readonly dockerCalls: () => Promise<number>;
    readonly run: (
      ...extra: string[]
    ) => Promise<{ code: number; stderr: string }>;
    /** Like run, with BAKERY_ENV set to `env` (null removes it). */
    readonly runWithEnv: (
      env: string | null,
      ...extra: string[]
    ) => Promise<{ code: number; stderr: string }>;
    /** Like run, with PATH set to `path` (a directory list). */
    readonly runWithPath: (
      path: string,
    ) => Promise<{ code: number; stderr: string }>;
    readonly bin: string;
    readonly opt: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-restore-gate-" });
  try {
    const bin = join(dir, "bin");
    const opt = join(dir, "opt/bakery");
    await Deno.mkdir(bin);
    await Deno.mkdir(opt, { recursive: true });
    await Deno.mkdir(join(dir, "var/lib/bakery"), { recursive: true });
    await installReleaseManifestShim(opt, REPO);
    await installDenoWrapper(bin);
    const mark = join(dir, "docker-calls");
    await Deno.writeTextFile(
      join(bin, "docker"),
      `#!/usr/bin/env bash\necho "$*" >> "${mark}"\nexit 1\n`,
      { mode: 0o755 },
    );
    const identity = join(dir, "identity.txt");
    await Deno.writeTextFile(identity, "AGE-SECRET-KEY-FAKE\n");
    const set = join(dir, "set");
    const launch = async (
      env: string | null,
      extra: string[],
      path = `${bin}:/usr/bin:/bin`,
    ) => {
      const variables: Record<string, string> = {
        PATH: path,
        HOME: dir,
        BAKERY_BACKUP_SANDBOX: dir,
        TMPDIR: dir,
      };
      if (env !== null) variables.BAKERY_ENV = env;
      const output = await new Deno.Command("bash", {
        args: [
          join(REPO, "scripts/deploy/restore-check.sh"),
          set,
          identity,
          ...extra,
        ],
        clearEnv: true,
        env: variables,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: output.code,
        stderr: new TextDecoder().decode(output.stderr),
      };
    };
    await run({
      dir,
      set,
      dockerCalls: async () => {
        try {
          return (await Deno.readTextFile(mark)).trim().split("\n").length;
        } catch {
          return 0;
        }
      },
      run: (...extra) => launch("test", extra),
      runWithEnv: (env, ...extra) => launch(env, extra),
      runWithPath: (path) => launch("test", [], path),
      bin,
      opt,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a complete set passes the gate and reaches the restore", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set);
    const result = await check.run();
    // The shim docker fails the restore itself; what matters is that the gate
    // let the set through and the restore began.
    assert(!result.stderr.includes("BACKUP_INCOMPLETE"), result.stderr);
    assert((await check.dockerCalls()) >= 1);
  });
});

Deno.test("a set that lost a declared store's file stops at the gate with no container started", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set);
    await Deno.remove(join(check.set, "redis.rdb.age"));
    const result = await check.run();
    assertEquals(result.code, 70, result.stderr);
    assert(result.stderr.includes("redis"), result.stderr);
    assertEquals(await check.dockerCalls(), 0);
  });
});

Deno.test("a file changed after the backup stops at the gate", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set);
    await Deno.writeTextFile(join(check.set, "inngest.dump.age"), "tampered");
    const result = await check.run();
    assertEquals(result.code, 70, result.stderr);
    assert(result.stderr.includes("postgres-inngest"), result.stderr);
    assertEquals(await check.dockerCalls(), 0);
  });
});

Deno.test("a set with no manifest fails closed, and --allow-legacy lets the old checks run", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set, { manifest: false });
    const closed = await check.run();
    assertEquals(closed.code, 70, closed.stderr);
    assert(closed.stderr.includes("no_manifest"), closed.stderr);
    assertEquals(await check.dockerCalls(), 0);
    const allowed = await check.run("--allow-legacy");
    assert(allowed.stderr.includes("BACKUP_LEGACY_SET"), allowed.stderr);
    // The old checks start: docker is reached (the shim then fails the restore).
    assert((await check.dockerCalls()) >= 1);
  });
});

Deno.test("--allow-legacy never excuses a set that has a manifest and does not match it", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set);
    await Deno.writeTextFile(join(check.set, "bakery.dump.age"), "tampered");
    const result = await check.run("--allow-legacy");
    assertEquals(result.code, 70, result.stderr);
    assertEquals(await check.dockerCalls(), 0);
  });
});

Deno.test("an unknown third argument is refused", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set);
    const result = await check.run("--whatever");
    assertEquals(result.code, 64);
    assertEquals(await check.dockerCalls(), 0);
  });
});

Deno.test("the sandbox is honoured only when BAKERY_ENV=test, and refused before anything runs", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set);
    for (const env of [null, "", "production"]) {
      const result = await check.runWithEnv(env);
      assertEquals(result.code, 64, `BAKERY_ENV=${env}: ${result.stderr}`);
      assert(
        result.stderr.includes("only honoured when BAKERY_ENV=test"),
        result.stderr,
      );
      assertEquals(await check.dockerCalls(), 0);
    }
    // Under BAKERY_ENV=test it is honoured: the gate passes and the restore starts.
    const honoured = await check.runWithEnv("test");
    assert(!honoured.stderr.includes("only honoured"), honoured.stderr);
    assert((await check.dockerCalls()) >= 1);
  });
});

Deno.test("a set that declares itself incomplete is refused with its cause, even with --allow-legacy", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set, { manifest: false });
    await Deno.writeTextFile(
      join(check.set, INCOMPLETE_FILE),
      JSON.stringify({
        format: 1,
        complete: false,
        cause: "manifest_builder_missing",
        detail: "deno is not installed",
        failedStores: [],
      }),
    );
    for (const extra of [[], ["--allow-legacy"]]) {
      const result = await check.run(...extra);
      assertEquals(result.code, 70, result.stderr);
      assert(result.stderr.includes("declared_incomplete"), result.stderr);
      assert(result.stderr.includes("manifest_builder_missing"), result.stderr);
      assert(!result.stderr.includes("BACKUP_LEGACY_SET"));
      assertEquals(await check.dockerCalls(), 0);
    }
  });
});

Deno.test("on a host without Deno it says what to install, exits 70 and starts nothing", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set);
    await Deno.remove(join(check.bin, "deno"));
    const tools = await toolsWithoutDeno(check.dir);
    const result = await check.runWithPath(`${check.bin}:${tools}`);
    assertEquals(result.code, 70, result.stderr);
    assert(result.stderr.includes("deno"), result.stderr);
    assert(result.stderr.includes("Nothing was restored"), result.stderr);
    assertEquals(await check.dockerCalls(), 0);
  });
});

Deno.test("on a host without the release checkout it names the checkout, exits 70 and starts nothing", async () => {
  await withCheck(async (check) => {
    await writeSet(check.set);
    await Deno.remove(join(check.opt, "background"), { recursive: true });
    const result = await check.run();
    assertEquals(result.code, 70, result.stderr);
    assert(result.stderr.includes("release checkout"), result.stderr);
    assert(!result.stderr.includes("deno ("), result.stderr);
    assertEquals(await check.dockerCalls(), 0);
  });
});
