import { join } from "node:path";
import {
  type Exec,
  type ExecResult,
  runDrill,
} from "../../scripts/deploy/backup-runner/drill.ts";
import {
  keyFingerprint,
  STORES,
  writeBackupManifest,
} from "../../scripts/deploy/backup-runner/manifest.ts";
import {
  type Census,
  censusOf,
  type EffectRow,
} from "../../apps/server/src/modules/backups/cutoff-rules.ts";

/**
 * The restore drill's fixture (#64 slice D, #49): a real backup set and
 * manifest on disk, a release checkout, and a scripted `exec` standing in for
 * Docker, age and Postgres. Each call of `run` drives one drill; a test
 * overrides the script's answers to make one check fail.
 */

export const CUTOFF_AT = "2026-11-21T03:00:05.000Z";
export const KEY_BYTES = new TextEncoder().encode("test-secrets-key-material");
export const POSTGRES = "postgres:18-alpine@sha256:" + "a".repeat(64);
export const REDIS = "redis:7.4-alpine@sha256:" + "b".repeat(64);
export const SKILL_KEY =
  "organizations/11111111-1111-4111-8111-111111111111/skill-versions/22222222-2222-4222-8222-222222222222/sha256/abc";
export const SKILL_BYTES = "skill file bytes";

export const EFFECTS: EffectRow[] = [
  {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    status: "prepared",
    operation: "github.merge",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    status: "uncertain",
    operation: "github.comment",
  },
];

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type Script = Record<
  string,
  ExecResult | ((command: string) => ExecResult)
>;

/** One drill fixture: a set on disk, a release checkout and a scripted exec. */
export type DrillFixture = {
  readonly dir: string;
  readonly set: string;
  readonly release: string;
  readonly keyFile: string;
  readonly calls: string[];
  /** What each call wrote to a process's stdin, in order. */
  readonly stdins: string[];
  readonly run: (
    overrides?: { script?: Script; keyFile?: string | null; now?: () => Date },
  ) => ReturnType<typeof runDrill>;
};

export const ok = (stdout = ""): ExecResult => ({
  code: 0,
  stdout,
  stderr: "",
});
export const bad = (code = 2): ExecResult => ({
  code,
  stdout: "",
  stderr: "boom",
});

export async function withDrillFixture(
  options: {
    census?: Census;
    cutoff?: "database" | "none";
    storageBackend?: "filesystem" | "r2";
    skillFiles?: number;
  },
  work: (fixture: DrillFixture) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-drill-test-" });
  try {
    const set = join(dir, "20261121T030000Z-0b6c1f7e");
    const release = join(dir, "release");
    await Deno.mkdir(set);
    for (const store of STORES) {
      if (store.file === null) continue;
      await Deno.writeTextFile(
        join(set, store.file),
        store.file === "release.json"
          ? JSON.stringify({ format: 1, active: { sha: "d".repeat(40) } })
          : `bytes of ${store.id}`,
      );
    }
    const census = options.census ?? await censusOf(EFFECTS);
    const skillFiles = options.skillFiles ?? 1;
    await writeBackupManifest({
      directory: set,
      startedAt: new Date("2026-11-21T03:00:00.000Z"),
      finishedAt: new Date("2026-11-21T03:01:00.000Z"),
      key: {
        state: "configured",
        id: "key-2026",
        fingerprint: keyFingerprint(KEY_BYTES),
      },
      references: { skillFiles, blobs: 0 },
      ...(options.cutoff === "none"
        ? {}
        : { cutoff: { at: CUTOFF_AT, source: "database", effects: census } }),
    });
    const keyFile = join(dir, "secrets.key");
    await Deno.writeFile(keyFile, KEY_BYTES);
    // The release checkout: the compose file that pins the images, and the
    // migrations this release knows.
    await Deno.mkdir(join(release, "infra/production"), { recursive: true });
    await Deno.writeTextFile(
      join(release, "infra/production/compose.yaml"),
      `services:\n  postgres:\n    image: ${POSTGRES}\n  redis:\n    image: ${REDIS}\n`,
    );
    // The bakery ledger's sources: the platform's own directory (no owner
    // subdirectory) and each module's migrations/bakery. A provider-owned
    // migration is another ledger and must not count.
    const platform = join(release, "apps/server/src/platform/migrations");
    const module = join(
      release,
      "apps/server/src/modules/auth/migrations/bakery",
    );
    const provider = join(
      release,
      "apps/server/src/modules/auth/migrations/provider",
    );
    for (const directory of [platform, module, provider]) {
      await Deno.mkdir(directory, { recursive: true });
    }
    await Deno.writeTextFile(join(platform, "0001_start.sql"), "-- sql");
    await Deno.writeTextFile(join(module, "0002_next.sql"), "-- sql");
    await Deno.writeTextFile(join(module, "0003_last.sql"), "-- sql");
    await Deno.writeTextFile(
      join(provider, "0004_provider_only.sql"),
      "-- sql",
    );
    const calls: string[] = [];
    const stdins: string[] = [];
    const references = JSON.stringify({
      format: 1,
      storageBackend: options.storageBackend ?? "filesystem",
      skillFiles: skillFiles === 0 ? [] : [{
        objectKey: SKILL_KEY,
        sizeBytes: SKILL_BYTES.length,
        sha256: await sha256Hex(SKILL_BYTES),
      }],
      blobs: [],
    });
    const rows = EFFECTS.map((e) => `${e.id}|${e.status}|${e.operation}`).join(
      "\n",
    );
    const base: Script = {
      "docker run --detach": ok("container-id"),
      "pg_isready": ok(),
      "create role": ok(),
      "createdb": ok(),
      "pg_restore": ok(),
      "information_schema.tables": ok("12"),
      "redis-check-rdb": ok(),
      "tar -tzf": ok("skills/\nworker/\n"),
      "tar -xzf": ok(),
      "references.json.age": ok(references),
      "schema_migrations": ok("0001_start\n0002_next\n0003_last"),
      "backup_cutoffs": ok(census.digest),
      "external_effects": ok(rows),
      "docker rm": ok(),
    };
    const fixture: DrillFixture = {
      dir,
      set,
      release,
      keyFile,
      calls,
      stdins,
      run: (overrides = {}) => {
        const script = { ...base, ...(overrides.script ?? {}) };
        const exec: Exec = (command, execOptions) => {
          const stdin = execOptions?.stdin ?? "";
          const text = command.join(" ") +
            (stdin === "" ? "" : ` <<< ${stdin}`);
          calls.push(text);
          if (stdin !== "") stdins.push(stdin);
          // The most specific key wins: the longest matching substring.
          const key = Object.keys(script).filter((k) => text.includes(k))
            .sort((a, b) => b.length - a.length)[0];
          if (key === undefined) return Promise.resolve(ok());
          const answer = script[key];
          return Promise.resolve(
            typeof answer === "function" ? answer(text) : answer,
          );
        };
        const scratchRoot = join(dir, "scratch");
        return Deno.mkdir(scratchRoot, { recursive: true }).then(async () => {
          // The files archive extracts into the drill's scratch directory: put
          // the skill file there the way tar would.
          const original = exec;
          const wrapped: Exec = async (command, execOptions) => {
            const result = await original(command, execOptions);
            const text = command.join(" ");
            if (text.includes("tar -xzf") && result.code === 0) {
              const root = command[command.indexOf("drill") + 3];
              await Deno.mkdir(join(root, "skills", "organizations"), {
                recursive: true,
              });
              await Deno.mkdir(join(root, "worker"), { recursive: true });
              if (!overrides.script?.["skip-skill-file"]) {
                const path = join(root, "skills", SKILL_KEY);
                await Deno.mkdir(join(path, ".."), { recursive: true });
                await Deno.writeTextFile(path, SKILL_BYTES);
              }
            }
            return result;
          };
          return await runDrill({
            directory: set,
            identityFile: join(dir, "identity.txt"),
            releaseRoot: release,
            scratchRoot,
            ...(overrides.keyFile === null
              ? {}
              : { keyFile: overrides.keyFile ?? keyFile }),
            exec: wrapped,
            now: overrides.now ?? (() => new Date()),
            sleep: () => Promise.resolve(),
          });
        });
      },
    };
    await work(fixture);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
