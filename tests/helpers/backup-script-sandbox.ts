import { join } from "node:path";
import {
  installDenoWrapper,
  installReleaseManifestShim,
} from "./backup-sandbox-release.ts";

/**
 * The real scripts/deploy/backup.sh against shim docker, age and pg_dump
 * programs, rooted in a scratch directory (BAKERY_BACKUP_SANDBOX), shared by
 * the backup script tests (#64 slice A) and the #49 acceptance tests.
 */

export const REPO = new URL("../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
export const KEY_MATERIAL = "TOP-SECRET-KEY-MATERIAL-0123456789";

export const DOCKER = `#!/usr/bin/env bash
# A fake \`docker compose ... exec -T <service> <command>\`.
args=("$@"); i=0
while [[ "\${args[$i]}" != exec ]]; do i=$((i+1)); done
service=\${args[$((i+2))]}
cmd=("\${args[@]:$((i+3))}")
case "$service" in
  postgres)
    case "\${cmd[0]}" in
      pg_basebackup)
        if [[ -n "\${FAKE_FAIL_BASE:-}" ]]; then exit 1; fi
        echo "base backup tar" ;;
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

export const AGE = `#!/usr/bin/env bash
# A fake age: marks the stream as encrypted and passes it through.
echo "AGE-FAKE-ENCRYPTED"
cat
`;

/** One scratch host for backup.sh: its root, shims and a way to run the script. */
export type Sandbox = {
  readonly dir: string;
  readonly bin: string;
  readonly opt: string;
  readonly backups: string;
  /** A null value removes that variable from the script's environment. */
  readonly run: (
    env?: Record<string, string | null>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export async function withSandbox(
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

/** The names in a directory, sorted; none when it does not exist yet. */
export async function entries(directory: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) names.push(entry.name);
  } catch { /* not created yet */ }
  return names.sort();
}
