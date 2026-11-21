import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { installDenoWrapper } from "../helpers/backup-sandbox-release.ts";

/**
 * #80 P2: restore-to-time.sh in a sandbox. Its control flow is under test, so
 * docker, runtime.sh, the drill, the backup and pitr-prepare.sh are recording
 * stubs; `age` copies (its stub), `tar`, `node` and `bash` are real. The real
 * replay against Postgres is tests/e2e/pitr-replay_test.ts.
 */

const REPO = new URL("../../", import.meta.url).pathname;
const SET_NAME = "20261121T000000Z-00000000-0000-4000-8000-000000000000";
const TARGET = "2026-11-21T10:15:00Z";

type Sandbox = {
  dir: string;
  set: string;
  wal: string;
  state: string;
  calls: () => Promise<string[]>;
  run: (
    ...args: string[]
  ) => Promise<{ code: number; stderr: string; stdout: string }>;
};

async function withSandbox(
  options: { replay?: "promoted" | "short"; base?: boolean },
  body: (sandbox: Sandbox) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-restore-to-time-" });
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
        join(state, "postgres"),
        join(state, "wal-spool"),
        etc,
      ]
    ) await Deno.mkdir(path, { recursive: true });
    await installDenoWrapper(bin);
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
    await Deno.writeTextFile(join(state, "postgres/PG_VERSION"), "old cluster");
    await Deno.writeTextFile(
      join(state, "wal-spool/000000010000000000000009"),
      "spool segment",
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
    const stub = async (path: string, text: string) =>
      await Deno.writeTextFile(path, `#!/usr/bin/env bash\n${text}\n`, {
        mode: 0o755,
      });
    const replay = options.replay ?? "promoted";
    await stub(
      join(bin, "docker"),
      [
        `echo "docker $*" >> "${log}"`,
        `case "$*" in`,
        replay === "promoted"
          ? `  *pg_is_in_recovery*) echo f ;;`
          : `  *pg_is_in_recovery*) exit 1 ;;`,
        `  *"logs --no-log-prefix postgres"*) echo "FATAL:  recovery ended before configured recovery target was reached" ;;`,
        `esac`,
      ].join("\n"),
    );
    // age --decrypt --identity <id> [-o out] <file>
    await stub(
      join(bin, "age"),
      `out=""\nwhile [[ $# -gt 1 ]]; do if [[ "$1" == -o ]]; then out="$2"; shift; fi; shift; done\nif [[ -n "$out" ]]; then cp "$1" "$out"; else cat "$1"; fi`,
    );
    await stub(
      join(opt, "deploy/restore-drill.sh"),
      `echo "drill $*" >> "${log}"`,
    );
    await stub(
      join(opt, "deploy/backup.sh"),
      `echo "backup" >> "${log}"\necho BACKUP_COMPLETED pre-restore-set`,
    );
    await stub(
      join(opt, "deploy/runtime.sh"),
      `echo "runtime $*" >> "${log}"\ncase "$1" in restore-fence) echo '{"restoreId":"r1"}' ;; esac`,
    );
    await stub(
      join(opt, "deploy/pitr-prepare.sh"),
      `echo "prepare $(basename "$1") $2 $3 $4" >> "${log}"\nmkdir -p "$2"\necho new > "$2/PG_VERSION"`,
    );

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
    if (options.base ?? true) {
      await Deno.writeTextFile(join(set, "base.tar.age"), "base");
    }
    await Deno.writeTextFile(
      join(set, "manifest.json"),
      JSON.stringify({ finishedAt: "2026-11-21T03:01:00.000Z" }),
    );
    const wal = join(dir, "wal");
    await Deno.mkdir(wal);
    await Deno.writeTextFile(
      join(wal, "000000010000000000000008.age"),
      "shipped segment",
    );
    const identity = join(dir, "identity.txt");
    await Deno.writeTextFile(identity, "AGE-SECRET-KEY-FAKE\n");

    const run = async (...args: string[]) => {
      const output = await new Deno.Command("bash", {
        args: [join(REPO, "scripts/deploy/restore-to-time.sh"), ...args],
        clearEnv: true,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: dir,
          TMPDIR: dir,
          BAKERY_BACKUP_SANDBOX: dir,
          BAKERY_ENV: "test",
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
      wal,
      state,
      calls: async () => {
        try {
          return (await Deno.readTextFile(log)).trim().split("\n");
        } catch {
          return [];
        }
      },
      run,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const args = (s: Sandbox, target = TARGET, confirm = SET_NAME) => [
  s.set,
  join(s.dir, "identity.txt"),
  "--to",
  target,
  "--wal",
  s.wal,
  "--confirm",
  confirm,
];

Deno.test("restore to a minute refuses before touching anything", async (t) => {
  await t.step("without the set's own name typed", async () => {
    await withSandbox({}, async (s) => {
      const result = await s.run(...args(s, TARGET, "nope"));
      assertEquals(result.code, 65);
      assert(result.stderr.includes("RESTORE_CONFIRMATION_REQUIRED"));
      assertEquals(await s.calls(), []);
    });
  });
  await t.step("when the set has no base backup", async () => {
    await withSandbox({ base: false }, async (s) => {
      const result = await s.run(...args(s));
      assertEquals(result.code, 66);
      assert(result.stderr.includes("PITR_NO_BASE_BACKUP"), result.stderr);
      assertEquals(await s.calls(), []);
    });
  });
  await t.step("when the target is not a UTC instant", async () => {
    await withSandbox({}, async (s) => {
      const result = await s.run(...args(s, "2026-11-21 10:15"));
      assertEquals(result.code, 68);
      assert(result.stderr.includes("PITR_TARGET_INVALID"), result.stderr);
      assertEquals(await s.calls(), []);
    });
  });
  await t.step("when the target is before the set finished", async () => {
    await withSandbox({}, async (s) => {
      const result = await s.run(...args(s, "2026-11-21T03:00:00Z"));
      assertEquals(result.code, 68);
      assert(result.stderr.includes("PITR_TARGET_BEFORE_SET"), result.stderr);
      assertEquals(await s.calls(), []);
    });
  });
  await t.step("without --wal", async () => {
    await withSandbox({}, async (s) => {
      const result = await s.run(
        s.set,
        join(s.dir, "identity.txt"),
        "--to",
        TARGET,
        "--confirm",
        SET_NAME,
      );
      assertEquals(result.code, 64);
      assertEquals(await s.calls(), []);
    });
  });
});

Deno.test("a restore to a minute replays, fences at the target and leaves only the api running", async () => {
  await withSandbox({}, async (s) => {
    const result = await s.run(...args(s));
    assertEquals(result.code, 0, result.stderr);
    assert(result.stdout.includes(`PITR_REPLAYED ${TARGET}`), result.stdout);
    assert(result.stdout.includes("RESTORE_COMPLETED_HELD"), result.stdout);
    const calls = await s.calls();
    assertEquals(calls.slice(0, 2).map((c) => c.split(" ")[0]), [
      "drill",
      "backup",
    ]);
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
      `restore-fence ${sha} --backup-name ${SET_NAME} --cutoff-at ${TARGET}`,
      `api-start blue ${sha}`,
      "proxy " + join(s.dir, "etc/bakery/Caddyfile.next"),
    ]);
    // Postgres is stopped before its data is swapped, and the new data is
    // prepared from the base backup toward the target, reading the restore WAL.
    const stop = calls.findIndex((c) => c.endsWith("stop postgres"));
    const prepare = calls.findIndex((c) => c.startsWith("prepare "));
    assert(stop >= 0 && prepare > stop, calls.join("\n"));
    const [, base, data, target, walInContainer] = calls[prepare].split(" ");
    assert(base.startsWith("base-") && base.endsWith(".tar"), base);
    assertEquals(data, join(s.state, "postgres"));
    assertEquals(target, TARGET);
    assert(walInContainer.startsWith("/wal-spool/restore-"), walInContainer);
    // The old cluster is kept aside; the decrypted base and WAL are cleaned up.
    const entries = [...Deno.readDirSync(s.state)].map((e) => e.name);
    const aside = entries.find((n) => n.startsWith("postgres.pre-restore-"));
    assert(aside !== undefined, entries.join(","));
    assertEquals(
      await Deno.readTextFile(join(s.state, aside, "PG_VERSION")),
      "old cluster",
    );
    assertEquals(
      await Deno.readTextFile(join(s.state, "postgres/PG_VERSION")),
      "new\n",
    );
    const spool = [...Deno.readDirSync(join(s.state, "wal-spool"))].map((e) =>
      e.name
    );
    assertEquals(spool, ["000000010000000000000009"]);
    // Skills replaced, worker aside, no dump restored (the replay is the database).
    assertEquals(
      await Deno.readTextFile(join(s.state, "skills/new.txt")),
      "restored skills",
    );
    assert(entries.some((n) => n.startsWith("worker.pre-restore-")));
    assert(!calls.some((c) => c.includes("pg_restore")));
  });
});

Deno.test("when the WAL stops short of the target, the old database is put back and it exits 69", async () => {
  await withSandbox({ replay: "short" }, async (s) => {
    const result = await s.run(...args(s));
    assertEquals(result.code, 69, result.stderr);
    assert(result.stderr.includes("PITR_WAL_SHORT"), result.stderr);
    assert(!result.stderr.includes("RESTORE_FAILED"), result.stderr);
    assertEquals(
      await Deno.readTextFile(join(s.state, "postgres/PG_VERSION")),
      "old cluster",
    );
    const entries = [...Deno.readDirSync(s.state)].map((e) => e.name);
    assert(
      entries.some((n) => n.startsWith("postgres.failed-pitr-")),
      entries.join(","),
    );
    const calls = await s.calls();
    // Nothing after the database ran: no fence, no api.
    assert(!calls.some((c) => c.startsWith("runtime restore-fence")));
    assert(!calls.some((c) => c.startsWith("runtime api-start")));
  });
});
