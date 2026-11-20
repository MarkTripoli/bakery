import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  type Manifest,
  verifyBackupDirectory,
} from "../../scripts/deploy/backup-runner/manifest.ts";

/**
 * #64 slice A: the real scripts/deploy/backup.sh against shim docker, age and
 * pg_dump programs, rooted in a scratch directory (BAKERY_BACKUP_SANDBOX).
 * It proves what a finished set holds and, above all, that an incomplete set
 * never becomes a backup: no `latest`, no set directory, exit 70.
 */

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const KEY_MATERIAL = "TOP-SECRET-KEY-MATERIAL-0123456789";

const DOCKER = `#!/usr/bin/env bash
# A fake \`docker compose ... exec -T <service> <command>\`.
args=("$@"); i=0
while [[ "\${args[$i]}" != exec ]]; do i=$((i+1)); done
service=\${args[$((i+2))]}
cmd=("\${args[@]:$((i+3))}")
case "$service" in
  postgres)
    case "\${cmd[0]}" in
      pg_dump)
        database=\${cmd[\${#cmd[@]}-1]}
        if [[ -n "\${FAKE_FAIL_DUMP:-}" && "$database" == "$FAKE_FAIL_DUMP" ]]; then
          echo "partial dump of $database"
          exit 1
        fi
        echo "dump of $database" ;;
      psql)
        sql=\${cmd[\${#cmd[@]}-1]}
        if [[ "$sql" == *jsonb_build_object* ]]; then
          if [[ -n "\${FAKE_FAIL_REFERENCES:-}" ]]; then exit 1; fi
          echo '{"format":1,"storageBackend":"filesystem","skillFiles":[{"objectKey":"skills/a","sha256":"x"}],"blobs":[]}'
        else
          echo "7 2"
        fi ;;
    esac ;;
  redis)
    case "\${cmd[*]}" in
      *"redis-cli SAVE"*) echo "\${FAKE_REDIS_SAVE:-OK}" ;;
      *"head -c 5"*) printf REDIS ;;
      "cat /data/dump.rdb") printf 'REDIS0011fake-snapshot' ;;
    esac ;;
esac
`;

const AGE = `#!/usr/bin/env bash
# A fake age: marks the stream as encrypted and passes it through.
echo "AGE-FAKE-ENCRYPTED"
cat
`;

type Sandbox = {
  readonly dir: string;
  readonly backups: string;
  readonly run: (
    env?: Record<string, string>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

async function withSandbox(
  options: { infraEnv?: string },
  run: (sandbox: Sandbox) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-backup-script-" });
  try {
    const etc = join(dir, "etc/bakery");
    const state = join(dir, "var/lib/bakery");
    const opt = join(dir, "opt/bakery");
    const bin = join(dir, "bin");
    for (
      const path of [
        etc,
        join(state, "skills"),
        join(state, "worker"),
        join(state, "deploy"),
        join(opt, "production"),
        bin,
      ]
    ) await Deno.mkdir(path, { recursive: true });
    await Deno.writeTextFile(
      join(etc, "backup.env"),
      "BAKERY_BACKUP_RECIPIENT=age1test\n",
    );
    await Deno.writeTextFile(join(etc, "secrets.key"), KEY_MATERIAL);
    await Deno.writeTextFile(
      join(etc, "infra.env"),
      options.infraEnv ??
        `BAKERY_SECRETS_KEY_ID=key-2026\nBAKERY_SECRETS_KEY_FILE=${
          join(etc, "secrets.key")
        }\n`,
    );
    await Deno.writeTextFile(join(state, "skills/skill.txt"), "a skill");
    await Deno.writeTextFile(join(state, "worker/registration.json"), "{}");
    await Deno.writeTextFile(
      join(state, "deploy/state.json"),
      JSON.stringify({
        format: 1,
        active: { sha: "b".repeat(40) },
        migrations: {},
      }),
    );
    await Deno.writeTextFile(
      join(opt, "production/compose.yaml"),
      "name: test\n",
    );
    await Deno.symlink(REPO, join(opt, "background"));
    for (const [name, body] of [["docker", DOCKER], ["age", AGE]]) {
      await Deno.writeTextFile(join(bin, name), body, { mode: 0o755 });
    }
    await Deno.symlink(Deno.execPath(), join(bin, "deno"));
    const sandbox: Sandbox = {
      dir,
      backups: join(state, "backups"),
      run: async (env = {}) => {
        const output = await new Deno.Command("bash", {
          args: [join(REPO, "scripts/deploy/backup.sh")],
          clearEnv: true,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: dir,
            BAKERY_BACKUP_SANDBOX: dir,
            ...env,
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
        return {
          code: output.code,
          stdout: new TextDecoder().decode(output.stdout),
          stderr: new TextDecoder().decode(output.stderr),
        };
      },
    };
    await run(sandbox);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function entries(directory: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) names.push(entry.name);
  } catch { /* not created yet */ }
  return names.sort();
}

Deno.test("a complete set holds every declared store, a manifest and verifies", async () => {
  await withSandbox({}, async (box) => {
    const result = await box.run();
    assertEquals(result.code, 0, result.stderr);
    const name = /BACKUP_COMPLETED (\S+)/.exec(result.stdout)?.[1];
    assert(name, result.stdout);
    const set = join(box.backups, name);
    assertEquals(await entries(set), [
      "SHA256SUMS",
      "bakery.dump.age",
      "files.tar.gz.age",
      "inngest.dump.age",
      "manifest.json",
      "redis.rdb.age",
      "references.json.age",
      "release.json",
    ]);
    // `latest` names the set; no half-written directory is left behind.
    assertEquals(
      (await Deno.readTextFile(join(box.backups, "latest"))).trim(),
      set,
    );
    assertEquals(
      (await entries(box.backups)).filter((n) => n.startsWith(".")),
      [],
    );
    assertEquals(
      (await verifyBackupDirectory(set)).complete,
      true,
    );
    const manifest = JSON.parse(
      await Deno.readTextFile(join(set, "manifest.json")),
    ) as Manifest;
    assertEquals(manifest.references, { skillFiles: 7, blobs: 2 });
    assertEquals(manifest.release.sha, "b".repeat(40));
    const key = manifest.stores.find((s) => s.id === "secrets-key-identity");
    assertEquals(key?.status, "captured");
    assertEquals(key?.keyId, "key-2026");
    // The secrets key itself is nowhere in the set.
    for (const file of await entries(set)) {
      const text = await Deno.readTextFile(join(set, file));
      assert(!text.includes(KEY_MATERIAL), `${file} holds the key`);
    }
    // The set also passes the checksum tool the restore check uses.
    const check = await new Deno.Command("sha256sum", {
      args: ["--check", "--status", "SHA256SUMS"],
      cwd: set,
    }).output();
    assertEquals(check.code, 0);
  });
});

Deno.test("a failed Redis save leaves no set, no latest and exits 70", async () => {
  await withSandbox({}, async (box) => {
    await Deno.mkdir(box.backups, { recursive: true });
    await Deno.writeTextFile(join(box.backups, "latest"), "/previous-set\n");
    const result = await box.run({
      FAKE_REDIS_SAVE: "ERR background save in progress",
    });
    assertEquals(result.code, 70, result.stderr);
    assert(result.stderr.includes("BACKUP_INCOMPLETE"), result.stderr);
    assert(result.stderr.includes("redis"), result.stderr);
    assert(!result.stdout.includes("BACKUP_COMPLETED"));
    // Nothing became a backup, and the previous `latest` is untouched.
    assertEquals(await entries(box.backups), ["latest"]);
    assertEquals(
      (await Deno.readTextFile(join(box.backups, "latest"))).trim(),
      "/previous-set",
    );
  });
});

Deno.test("a dump that dies halfway is not kept just because it left a file", async () => {
  await withSandbox({}, async (box) => {
    const result = await box.run({ FAKE_FAIL_DUMP: "inngest" });
    assertEquals(result.code, 70, result.stderr);
    assert(result.stderr.includes("postgres-inngest"), result.stderr);
    assertEquals(await entries(box.backups), []);
  });
});

Deno.test("every missing store is reported together, not only the first", async () => {
  await withSandbox({}, async (box) => {
    const result = await box.run({
      FAKE_FAIL_DUMP: "bakery",
      FAKE_FAIL_REFERENCES: "1",
      FAKE_REDIS_SAVE: "ERR",
    });
    assertEquals(result.code, 70);
    for (const store of ["postgres-bakery", "object-references", "redis"]) {
      assert(result.stderr.includes(store), `${store}: ${result.stderr}`);
    }
    assertEquals(await entries(box.backups), []);
  });
});

Deno.test("a host with no secrets key records the exclusion and still completes", async () => {
  await withSandbox({ infraEnv: "POSTGRES_PASSWORD=x\n" }, async (box) => {
    const result = await box.run();
    assertEquals(result.code, 0, result.stderr);
    const name = /BACKUP_COMPLETED (\S+)/.exec(result.stdout)![1];
    const manifest = JSON.parse(
      await Deno.readTextFile(join(box.backups, name, "manifest.json")),
    ) as Manifest;
    const key = manifest.stores.find((s) => s.id === "secrets-key-identity");
    assertEquals(key?.status, "excluded");
    assertEquals(key?.reason, "no secrets key is configured on this host");
  });
});

Deno.test("a half-configured secrets key makes the set incomplete", async () => {
  await withSandbox(
    { infraEnv: "BAKERY_SECRETS_KEY_ID=key-2026\n" },
    async (box) => {
      const result = await box.run();
      assertEquals(result.code, 70, result.stderr);
      assert(result.stderr.includes("secrets-key-identity"), result.stderr);
      assertEquals(await entries(box.backups), []);
    },
  );
});

Deno.test("the verify command accepts a finished set and refuses a tampered one", async () => {
  await withSandbox({}, async (box) => {
    const done = await box.run();
    assertEquals(done.code, 0, done.stderr);
    const name = /BACKUP_COMPLETED (\S+)/.exec(done.stdout)![1];
    const set = join(box.backups, name);
    const verify = (...extra: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-prompt",
          `--allow-read=${set}`,
          join(REPO, "scripts/deploy/backup-manifest.ts"),
          "verify",
          set,
          ...extra,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
    const good = await verify();
    assertEquals(good.code, 0);
    await Deno.writeTextFile(join(set, "redis.rdb.age"), "tampered");
    const bad = await verify();
    assertEquals(bad.code, 70);
    assert(new TextDecoder().decode(bad.stderr).includes("redis"));
    // A set with no manifest fails closed unless legacy sets are allowed.
    await Deno.remove(join(set, "manifest.json"));
    const legacy = await verify();
    assertEquals(legacy.code, 70);
    assert(new TextDecoder().decode(legacy.stderr).includes("no_manifest"));
    const allowed = await verify("--allow-legacy");
    assertEquals(allowed.code, 0);
    assert(
      new TextDecoder().decode(allowed.stderr).includes("BACKUP_LEGACY_SET"),
    );
  });
});
