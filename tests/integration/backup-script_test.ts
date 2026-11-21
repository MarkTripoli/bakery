import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  installDenoWrapper,
  installReleaseManifestShim,
  toolsWithoutDeno,
} from "../helpers/backup-sandbox-release.ts";
import {
  INCOMPLETE_FILE,
  keyFingerprint,
  type Manifest,
  verifyBackupDirectory,
} from "../../scripts/deploy/backup-runner/manifest.ts";
import { isBackupName } from "../../scripts/deploy/backup-runner/retention.ts";
import type { Cutoff } from "../../apps/server/src/modules/backups/cutoff-rules.ts";

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
  readonly bin: string;
  readonly opt: string;
  readonly backups: string;
  /** A null value removes that variable from the script's environment. */
  readonly run: (
    env?: Record<string, string | null>,
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
    await installReleaseManifestShim(opt, REPO);
    for (const [name, body] of [["docker", DOCKER], ["age", AGE]]) {
      await Deno.writeTextFile(join(bin, name), body, { mode: 0o755 });
    }
    await installDenoWrapper(bin);
    const sandbox: Sandbox = {
      dir,
      bin,
      opt,
      backups: join(state, "backups"),
      run: async (env = {}) => {
        const merged: Record<string, string | null> = {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: dir,
          BAKERY_BACKUP_SANDBOX: dir,
          BAKERY_ENV: "test",
          ...env,
        };
        const output = await new Deno.Command("bash", {
          args: [join(REPO, "scripts/deploy/backup.sh")],
          clearEnv: true,
          env: Object.fromEntries(
            Object.entries(merged).filter(
              (entry): entry is [string, string] => entry[1] !== null,
            ),
          ),
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
    // The manifest records the key's fingerprint, never the key.
    assertEquals(
      key?.keyFingerprint,
      keyFingerprint(new TextEncoder().encode(KEY_MATERIAL)),
    );
    // The secrets key is in no file of the set, in any common encoding, and not
    // in what the script printed either.
    const raw = new TextEncoder().encode(KEY_MATERIAL);
    const needles = [
      KEY_MATERIAL,
      btoa(KEY_MATERIAL),
      [...raw].map((b) => b.toString(16).padStart(2, "0")).join(""),
    ];
    for (const file of await entries(set)) {
      const text = await Deno.readTextFile(join(set, file));
      for (const needle of needles) {
        assert(!text.includes(needle), `${file} holds the key`);
      }
    }
    for (const needle of needles) {
      assert(
        !result.stdout.includes(needle) && !result.stderr.includes(needle),
      );
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

Deno.test("the sandbox is honoured only when BAKERY_ENV=test, and refused before anything is touched", async () => {
  await withSandbox({}, async (box) => {
    for (const env of [null, "", "production", "staging"]) {
      const result = await box.run({ BAKERY_ENV: env });
      assertEquals(result.code, 64, `BAKERY_ENV=${env}: ${result.stderr}`);
      assert(
        result.stderr.includes("only honoured when BAKERY_ENV=test"),
        result.stderr,
      );
      // Nothing was created: no backups directory, no pending directory.
      assertEquals(await entries(box.backups), []);
      assertEquals(result.stdout, "");
    }
    // And under BAKERY_ENV=test it is honoured.
    assertEquals((await box.run()).code, 0);
  });
});

const KEPT_NAME =
  /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function assertKeptIncomplete(
  box: Sandbox,
  result: { code: number; stdout: string; stderr: string },
  previousLatest: string | null,
): Promise<string> {
  assertEquals(result.code, 70, result.stderr);
  assert(result.stderr.includes("BACKUP_INCOMPLETE"), result.stderr);
  assert(result.stderr.includes("manifest_builder_missing"), result.stderr);
  assert(!result.stdout.includes("BACKUP_COMPLETED"));
  // Exactly one kept set, under a normal name, and `latest` is untouched.
  const names = (await entries(box.backups)).filter((n) => n !== "latest");
  assertEquals(names.length, 1, names.join(","));
  const name = names[0];
  assert(KEPT_NAME.test(name), name);
  assert(isBackupName(name));
  if (previousLatest === null) {
    assert(!(await entries(box.backups)).includes("latest"));
  } else {
    assertEquals(
      (await Deno.readTextFile(join(box.backups, "latest"))).trim(),
      previousLatest,
    );
  }
  const set = join(box.backups, name);
  // The dumps are there, encrypted exactly as a normal run writes them.
  assertEquals(
    await Deno.readTextFile(join(set, "bakery.dump.age")),
    "AGE-FAKE-ENCRYPTED\ndump of bakery\n",
  );
  assertEquals(
    await Deno.readTextFile(join(set, "inngest.dump.age")),
    "AGE-FAKE-ENCRYPTED\ndump of inngest\n",
  );
  const files = await entries(set);
  for (
    const file of [
      "SHA256SUMS",
      "files.tar.gz.age",
      "redis.rdb.age",
      "references.json.age",
      "release.json",
      INCOMPLETE_FILE,
    ]
  ) assert(files.includes(file), `${file} is missing: ${files.join(",")}`);
  assert(!files.includes("manifest.json"));
  // The marker says it is incomplete and why, and holds no secret.
  const marker = JSON.parse(
    await Deno.readTextFile(join(set, INCOMPLETE_FILE)),
  ) as { complete: boolean; cause: string; detail: string };
  assertEquals(marker.complete, false);
  assertEquals(marker.cause, "manifest_builder_missing");
  assert(marker.detail.includes("take another backup"));
  for (const file of files) {
    assert(
      !(await Deno.readTextFile(join(set, file))).includes(KEY_MATERIAL),
      `${file} holds the key`,
    );
  }
  // SHA256SUMS still checks out, and the verifier refuses the set with the cause.
  const check = await new Deno.Command("sha256sum", {
    args: ["--check", "--status", "SHA256SUMS"],
    cwd: set,
  }).output();
  assertEquals(check.code, 0);
  const verified = await verifyBackupDirectory(set, { allowLegacy: true });
  assertEquals(verified.complete, false);
  assertEquals(verified.problems.map((p) => p.kind), ["declared_incomplete"]);
  assert(verified.problems[0].detail.includes("manifest_builder_missing"));
  return name;
}

Deno.test("with the release checkout missing the dumps are still taken, kept as an incomplete set, never latest", async () => {
  await withSandbox({}, async (box) => {
    await Deno.mkdir(box.backups, { recursive: true });
    await Deno.writeTextFile(
      join(box.backups, "latest"),
      "/previous-good-set\n",
    );
    await Deno.remove(join(box.opt, "background"), { recursive: true });
    const result = await box.run();
    await assertKeptIncomplete(box, result, "/previous-good-set");
  });
});

Deno.test("with Deno missing the dumps are still taken, kept as an incomplete set, never latest", async () => {
  await withSandbox({}, async (box) => {
    await Deno.remove(join(box.bin, "deno"));
    const tools = await toolsWithoutDeno(box.dir);
    const result = await box.run({ PATH: `${box.bin}:${tools}` });
    await assertKeptIncomplete(box, result, null);
  });
});

Deno.test("an incomplete set names the stores that also failed", async () => {
  await withSandbox({}, async (box) => {
    await Deno.remove(join(box.opt, "background"), { recursive: true });
    const result = await box.run({ FAKE_REDIS_SAVE: "ERR" });
    assertEquals(result.code, 70, result.stderr);
    const name = (await entries(box.backups)).find((n) => n !== "latest")!;
    const marker = JSON.parse(
      await Deno.readTextFile(join(box.backups, name, INCOMPLETE_FILE)),
    ) as { failedStores: string[] };
    assertEquals(marker.failedStores, ["redis"]);
    assert(!(await entries(join(box.backups, name))).includes("redis.rdb.age"));
  });
});

Deno.test("the verify command can check a key file against the recorded fingerprint", async () => {
  await withSandbox({}, async (box) => {
    const done = await box.run();
    assertEquals(done.code, 0, done.stderr);
    const name = /BACKUP_COMPLETED (\S+)/.exec(done.stdout)![1];
    const set = join(box.backups, name);
    const keyFile = join(box.dir, "etc/bakery/secrets.key");
    const verify = async (file: string) => {
      const output = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-prompt",
          `--allow-read=${set},${file}`,
          join(REPO, "scripts/deploy/backup-manifest.ts"),
          "verify",
          set,
          "--key-file",
          file,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: output.code,
        text: new TextDecoder().decode(output.stdout) +
          new TextDecoder().decode(output.stderr),
      };
    };
    assertEquals((await verify(keyFile)).code, 0);
    const other = join(box.dir, "other.key");
    await Deno.writeTextFile(other, "a different key");
    const wrong = await verify(other);
    assertEquals(wrong.code, 70);
    assert(wrong.text.includes("key_mismatch"), wrong.text);
    // Neither key's bytes are printed.
    assert(!wrong.text.includes("a different key"));
    assert(!wrong.text.includes(KEY_MATERIAL));
  });
});

// ---- #64 slice C: the cutoff ------------------------------------------------

const RUNNER_CUTOFF: Cutoff = {
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

Deno.test("a database cutoff from the runner is recorded in the manifest, with its census", async () => {
  await withSandbox({}, async (box) => {
    const result = await box.run({
      BAKERY_BACKUP_CUTOFF: JSON.stringify(RUNNER_CUTOFF),
    });
    assertEquals(result.code, 0, result.stderr);
    const name = /BACKUP_COMPLETED (\S+)/.exec(result.stdout)?.[1];
    assert(name, result.stdout);
    const set = join(box.backups, name);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(set, "manifest.json")),
    ) as Manifest;
    assertEquals(manifest.format, 2);
    assertEquals(manifest.cutoff, RUNNER_CUTOFF);
    // It is the cutoff a restore can rely on, and the verifier says so.
    const verified = await verifyBackupDirectory(set, {
      requireDatabaseCutoff: true,
    });
    assertEquals(verified.complete, true);
    assertEquals(verified.cutoff?.source, "database");
  });
});

Deno.test("with no runner cutoff the manifest records the host clock, marked weaker", async () => {
  await withSandbox({}, async (box) => {
    const before = Date.now();
    const result = await box.run();
    assertEquals(result.code, 0, result.stderr);
    const name = /BACKUP_COMPLETED (\S+)/.exec(result.stdout)?.[1];
    assert(name, result.stdout);
    const set = join(box.backups, name);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(set, "manifest.json")),
    ) as Manifest;
    assertEquals(manifest.format, 2);
    assertEquals(manifest.cutoff?.source, "host-clock");
    assertEquals(manifest.cutoff?.effects, null);
    const at = Date.parse(manifest.cutoff!.at);
    assert(at >= before - 2000 && at <= Date.now() + 2000, manifest.cutoff!.at);
    // Complete as a set, but not good enough for a restore that must know.
    assertEquals((await verifyBackupDirectory(set)).complete, true);
    const strict = await verifyBackupDirectory(set, {
      requireDatabaseCutoff: true,
    });
    assertEquals(strict.problems.map((p) => p.kind), ["cutoff_not_database"]);
  });
});

Deno.test("a cutoff that is not valid fails the backup loudly, leaves no set and keeps the previous latest", async () => {
  const bad: [string, string, string][] = [
    ["not JSON", "{nope", "not valid JSON"],
    [
      "a host-clock cutoff cannot be supplied",
      JSON.stringify({ at: RUNNER_CUTOFF.at, source: "host-clock" }),
      "only a database cutoff",
    ],
    [
      "a database cutoff without a census",
      JSON.stringify({ at: RUNNER_CUTOFF.at, source: "database" }),
      "census",
    ],
    [
      "a census that does not add up",
      JSON.stringify({
        ...RUNNER_CUTOFF,
        effects: { ...RUNNER_CUTOFF.effects, total: 9 },
      }),
      "do not add up",
    ],
    [
      "a malformed time",
      JSON.stringify({ ...RUNNER_CUTOFF, at: "soon" }),
      "malformed",
    ],
  ];
  for (const [name, cutoff, word] of bad) {
    await withSandbox({}, async (box) => {
      await Deno.mkdir(box.backups, { recursive: true });
      await Deno.writeTextFile(join(box.backups, "latest"), "/previous-set\n");
      const result = await box.run({ BAKERY_BACKUP_CUTOFF: cutoff });
      assertEquals(result.code, 70, `${name}: ${result.stderr}`);
      assert(result.stderr.includes("BACKUP_INCOMPLETE"), name);
      assert(result.stderr.includes(word), `${name}: ${result.stderr}`);
      assert(!result.stdout.includes("BACKUP_COMPLETED"), name);
      // Nothing became a backup, and the previous `latest` is untouched.
      assertEquals(await entries(box.backups), ["latest"], name);
      assertEquals(
        (await Deno.readTextFile(join(box.backups, "latest"))).trim(),
        "/previous-set",
        name,
      );
    });
  }
});
