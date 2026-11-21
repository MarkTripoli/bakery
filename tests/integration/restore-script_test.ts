import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { installDenoWrapper } from "../helpers/backup-sandbox-release.ts";

/**
 * #64 slice E2: restore.sh in a sandbox. The script's own control flow is the
 * thing under test, so docker, runtime.sh, the drill and the backup are
 * recording stubs; `age`, `tar`, `node` and `bash` are real. It is in the
 * integration lane because it spawns processes.
 */

const REPO = new URL("../../", import.meta.url).pathname;
const SET_NAME = "20261121T000000Z-00000000-0000-4000-8000-000000000000";

type Sandbox = {
  dir: string;
  set: string;
  calls: () => Promise<string[]>;
  run: (
    ...args: string[]
  ) => Promise<{ code: number; stderr: string; stdout: string }>;
  runEnv: (
    env: Record<string, string | undefined>,
    ...args: string[]
  ) => Promise<{ code: number; stderr: string; stdout: string }>;
  state: string;
};

async function withSandbox(
  options: { drill?: number; backup?: number },
  body: (sandbox: Sandbox) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-restore-script-" });
  try {
    const bin = join(dir, "bin");
    const opt = join(dir, "opt/bakery");
    const state = join(dir, "var/lib/bakery");
    const etc = join(dir, "etc/bakery");
    const log = join(dir, "calls");
    for (
      const path of [
        bin,
        join(opt, "deploy"),
        join(opt, "background"),
        join(state, "deploy"),
        join(state, "skills"),
        join(state, "worker"),
        join(state, "redis"),
        etc,
      ]
    ) await Deno.mkdir(path, { recursive: true });
    await installDenoWrapper(bin);
    // The script's own `node` calls run the host's real Node.
    const node = (Deno.env.get("PATH") ?? "").split(":")
      .map((directory) => join(directory, "node"))
      .find((candidate) => {
        try {
          return Deno.statSync(candidate).isFile;
        } catch {
          return false;
        }
      });
    assert(node !== undefined, "these tests need node on the PATH");
    await Deno.writeTextFile(
      join(bin, "node"),
      `#!/bin/sh\nexec ${JSON.stringify(node)} "$@"\n`,
      { mode: 0o755 },
    );
    await Deno.writeTextFile(join(state, "skills/old.txt"), "old skills");
    await Deno.writeTextFile(
      join(state, "worker/journal.json"),
      "worker journal",
    );
    await Deno.writeTextFile(
      join(state, "deploy/state.json"),
      JSON.stringify({ active: { slot: "blue", sha: "a".repeat(40) } }),
    );
    await Deno.writeTextFile(join(etc, "infra.env"), "");
    await Deno.writeTextFile(join(etc, "deployment.json"), "{}");
    await Deno.writeTextFile(
      join(opt, "deploy/release.mjs"),
      `export function renderCaddy(config, active) { return "caddy " + JSON.stringify(active); }\n`,
    );
    const stub = async (path: string, body: string) =>
      await Deno.writeTextFile(path, `#!/usr/bin/env bash\n${body}\n`, {
        mode: 0o755,
      });
    await stub(
      join(bin, "docker"),
      `echo "docker $*" >> "${log}"\ncase "$*" in *pg_restore*) cat > /dev/null ;; esac`,
    );
    await stub(join(bin, "age"), `file="\${@: -1}"\ncat "$file"`);
    await stub(
      join(opt, "deploy/restore-drill.sh"),
      `echo "drill $*" >> "${log}"\nexit ${options.drill ?? 0}`,
    );
    await stub(
      join(opt, "deploy/backup.sh"),
      `echo "backup" >> "${log}"\n${
        options.backup
          ? `echo "BACKUP_FAILED: the disk is full" >&2\nexit ${options.backup}`
          : "echo BACKUP_COMPLETED pre-restore-set"
      }`,
    );
    await stub(
      join(opt, "deploy/runtime.sh"),
      `echo "runtime $*" >> "${log}"\ncase "$1" in restore-fence) echo '{"restoreId":"r1"}' ;; esac`,
    );

    // The set: a manifest with a cutoff, a tar of skills, plain stand-ins for
    // the encrypted files (the age stub reads them as they are).
    const set = join(dir, "sets", SET_NAME);
    await Deno.mkdir(join(set, "skills-src/skills"), { recursive: true });
    await Deno.writeTextFile(
      join(set, "skills-src/skills/new.txt"),
      "restored skills",
    );
    const tar = await new Deno.Command("tar", {
      args: [
        "-czf",
        join(set, "files.tar.gz.age"),
        "-C",
        join(set, "skills-src"),
        "skills",
      ],
    }).output();
    assertEquals(tar.code, 0);
    for (
      const name of ["bakery.dump.age", "inngest.dump.age", "redis.rdb.age"]
    ) {
      await Deno.writeTextFile(join(set, name), "data");
    }
    await Deno.writeTextFile(
      join(set, "manifest.json"),
      JSON.stringify({
        cutoff: { at: "2026-11-21T00:00:00.000Z", source: "database" },
      }),
    );
    const identity = join(dir, "identity.txt");
    await Deno.writeTextFile(identity, "AGE-SECRET-KEY-FAKE\n");

    const runEnv = async (
      overrides: Record<string, string | undefined>,
      ...args: string[]
    ) => {
      const output = await new Deno.Command("bash", {
        args: [join(REPO, "scripts/deploy/restore.sh"), ...args],
        clearEnv: true,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: dir,
          TMPDIR: dir,
          ...Object.fromEntries(
            Object.entries({
              BAKERY_BACKUP_SANDBOX: dir,
              BAKERY_ENV: "test",
              ...overrides,
            }).filter((entry): entry is [string, string] =>
              entry[1] !== undefined
            ),
          ),
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
      };
    };

    await body({
      dir,
      set,
      state,
      calls: async () => {
        try {
          return (await Deno.readTextFile(log)).trim().split("\n");
        } catch {
          return [];
        }
      },
      run: (...args) => runEnv({}, ...args),
      runEnv,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const identityOf = (dir: string) => join(dir, "identity.txt");

Deno.test("without the set's own name typed, nothing runs and nothing changes", async () => {
  await withSandbox({}, async (s) => {
    for (const confirm of [[], ["--confirm", "something-else"]]) {
      const result = await s.run(s.set, identityOf(s.dir), ...confirm);
      assert(result.code === 64 || result.code === 65, `code ${result.code}`);
    }
    const typed = await s.run(s.set, identityOf(s.dir), "--confirm", "nope");
    assertEquals(typed.code, 65);
    assert(typed.stderr.includes("RESTORE_CONFIRMATION_REQUIRED"));
    assertEquals(await s.calls(), []);
    assertEquals(
      await Deno.readTextFile(join(s.state, "skills/old.txt")),
      "old skills",
    );
  });
});

Deno.test("a missing --confirm prints the usage line and changes nothing", async () => {
  await withSandbox({}, async (s) => {
    const result = await s.run(s.set, identityOf(s.dir));
    assertEquals(result.code, 64);
    assert(result.stderr.includes("--confirm <set name>"), result.stderr);
    assertEquals(await s.calls(), []);
  });
});

Deno.test("the sandbox root is refused outside BAKERY_ENV=test before anything runs", async () => {
  await withSandbox({}, async (s) => {
    for (const env of [undefined, "production"]) {
      const result = await s.runEnv(
        { BAKERY_ENV: env },
        s.set,
        identityOf(s.dir),
        "--confirm",
        SET_NAME,
      );
      assertEquals(result.code, 64);
      assert(
        result.stderr.includes("only honoured when BAKERY_ENV=test"),
        result.stderr,
      );
    }
    assertEquals(await s.calls(), []);
    assertEquals(
      await Deno.readTextFile(join(s.state, "skills/old.txt")),
      "old skills",
    );
  });
});

Deno.test("a set whose drill does not pass is refused before the installation is touched", async () => {
  await withSandbox({ drill: 1 }, async (s) => {
    const result = await s.run(s.set, identityOf(s.dir), "--confirm", SET_NAME);
    assertEquals(result.code, 66);
    assert(result.stderr.includes("RESTORE_REFUSED_DRILL_FAILED"));
    assertEquals((await s.calls()).map((call) => call.split(" ")[0]), [
      "drill",
    ]);
  });
});

Deno.test("with no pre-restore backup, it is refused before anything is stopped", async () => {
  await withSandbox({ backup: 70 }, async (s) => {
    const result = await s.run(s.set, identityOf(s.dir), "--confirm", SET_NAME);
    assertEquals(result.code, 67);
    assert(result.stderr.includes("RESTORE_REFUSED_NO_PRE_BACKUP"));
    // The backup's own reason reaches the operator.
    assert(
      result.stderr.includes("BACKUP_FAILED: the disk is full"),
      result.stderr,
    );
    assertEquals((await s.calls()).map((call) => call.split(" ")[0]), [
      "drill",
      "backup",
    ]);
  });
});

Deno.test("a restore runs in its order, moves the worker aside and leaves dispatch, the worker and Inngest stopped", async () => {
  await withSandbox({}, async (s) => {
    const result = await s.run(s.set, identityOf(s.dir), "--confirm", SET_NAME);
    assertEquals(result.code, 0, result.stderr);
    assert(result.stdout.includes("RESTORE_COMPLETED_HELD"));
    const calls = await s.calls();
    const sha = "a".repeat(40);
    const runtime = calls.filter((c) => c.startsWith("runtime ")).map((c) =>
      c.slice(8)
    );
    assertEquals(runtime, [
      "proxy " + join(s.dir, "etc/bakery/Caddyfile.next"),
      "api-stop blue",
      "api-stop green",
      "background stop",
      "inngest-stop",
      `migrate ${sha}`,
      `restore-fence ${sha} --backup-name ${SET_NAME} --cutoff-at 2026-11-21T00:00:00.000Z`,
      `api-start blue ${sha}`,
      "proxy " + join(s.dir, "etc/bakery/Caddyfile.next"),
    ]);
    // The drill and the pre-restore backup come first, then the stores.
    assertEquals(calls.slice(0, 2).map((c) => c.split(" ")[0]), [
      "drill",
      "backup",
    ]);
    assert(calls.some((c) => c.includes("pg_restore")));
    // Nothing starts dispatch, the worker or Inngest.
    assert(
      !runtime.some((c) =>
        c.startsWith("background ") && c !== "background stop"
      ),
    );
    assert(!calls.some((c) => c.includes("up --detach --wait inngest")));
    // Skills are replaced; the old tree is kept aside.
    assertEquals(
      await Deno.readTextFile(join(s.state, "skills/new.txt")),
      "restored skills",
    );
    const aside = [...Deno.readDirSync(s.state)].map((e) => e.name);
    assert(aside.some((n) => n.startsWith("skills.pre-restore-")));
    // The worker's journal is moved aside and NOT restored: the new directory is empty.
    const workerAside = aside.find((n) => n.startsWith("worker.pre-restore-"));
    assert(workerAside !== undefined);
    assertEquals(
      await Deno.readTextFile(join(s.state, workerAside, "journal.json")),
      "worker journal",
    );
    assertEquals([...Deno.readDirSync(join(s.state, "worker"))].length, 0);
  });
});
