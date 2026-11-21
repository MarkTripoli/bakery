import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  ensureCoherent,
  type Exec,
  type ExecResult,
  imageOf,
  runDrill,
  safeMemberName,
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
import {
  DRILL_CHECKS,
  drillProblems,
} from "../../apps/server/src/modules/backups/drill-rules.ts";

/**
 * #64 slice D: the restore drill's flow, with a real backup set and manifest on
 * disk and a scripted `exec` standing in for Docker, age and Postgres. Each
 * test drives one outcome and checks both the verdict and that everything the
 * drill made is removed again.
 */

const CUTOFF_AT = "2026-11-21T03:00:05.000Z";
const KEY_BYTES = new TextEncoder().encode("test-secrets-key-material");
const POSTGRES = "postgres:16-alpine@sha256:" + "a".repeat(64);
const REDIS = "redis:7.4-alpine@sha256:" + "b".repeat(64);
const SKILL_KEY =
  "organizations/11111111-1111-4111-8111-111111111111/skill-versions/22222222-2222-4222-8222-222222222222/sha256/abc";
const SKILL_BYTES = "skill file bytes";

const EFFECTS: EffectRow[] = [
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

type Script = Record<string, ExecResult | ((command: string) => ExecResult)>;

type Fixture = {
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

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (code = 2): ExecResult => ({ code, stdout: "", stderr: "boom" });

async function withFixture(
  options: {
    census?: Census;
    cutoff?: "database" | "none";
    storageBackend?: "filesystem" | "r2";
    skillFiles?: number;
  },
  work: (fixture: Fixture) => Promise<void>,
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
    const fixture: Fixture = {
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

const removed = (calls: string[]) =>
  calls.filter((call) => call.startsWith("docker rm --force --volumes"));

Deno.test("a complete set passes all nine checks, with its age and restore time measured", async () => {
  await withFixture({}, async (f) => {
    const times = [
      new Date("2026-11-21T04:00:00.000Z"),
      new Date("2026-11-21T04:02:22.400Z"),
    ];
    let index = 0;
    const result = await f.run({
      now: () => times[Math.min(index++, times.length - 1)],
    });
    assertEquals(result.outcome, "passed", JSON.stringify(result));
    assertEquals(result.checksPassed, [...DRILL_CHECKS]);
    assertEquals(result.checksFailed, []);
    assertEquals(result.failureCode, null);
    assertEquals(result.cutoffAt, CUTOFF_AT);
    // Age: from the cutoff (03:00:05) to the start (04:00:00) is 3595 s.
    assertEquals(result.rpoSeconds, 3595);
    // Time: from 04:00:00 to 04:02:22.4 is 142 s.
    assertEquals(result.rtoSeconds, 142);
    assertEquals(drillProblems(result), []);
    // The postgres container and nothing else was started, with no network.
    const runs = f.calls.filter((call) =>
      call.startsWith("docker run --detach")
    );
    assertEquals(runs.length, 1);
    assert(runs[0].includes("--network none"));
    assert(runs[0].includes(POSTGRES));
    // The isolated stores are gone, and so is the scratch directory.
    assertEquals(removed(f.calls).length, 1);
    assertEquals([...Deno.readDirSync(join(f.dir, "scratch"))].length, 0);
  });
});

Deno.test("the redis check streams the snapshot into a container with no network and the pinned image", async () => {
  await withFixture({}, async (f) => {
    await f.run();
    const check = f.calls.find((call) => call.includes("redis-check-rdb"))!;
    assert(check.includes("--network none"));
    assert(check.includes(REDIS));
    assert(!check.includes("--mount") && !check.includes("-v "), check);
  });
});

Deno.test("a set that declares itself incomplete fails the manifest check before anything is started", async () => {
  await withFixture({}, async (f) => {
    // What backup.sh leaves beside a set it could not finish.
    await Deno.writeTextFile(
      join(f.set, "INCOMPLETE.json"),
      JSON.stringify({
        format: 1,
        complete: false,
        cause: "manifest_builder_missing",
        detail: "deno is not available",
        failedStores: [],
        startedAt: "2026-11-21T03:00:00.000Z",
      }),
    );
    const result = await f.run();
    assertEquals(result.outcome, "failed");
    assertEquals(result.checksFailed, ["manifest"]);
    assertEquals(result.failureCode, "set_incomplete");
    assertEquals(result.checksPassed, []);
    assertEquals(
      f.calls.filter((call) => call.startsWith("docker run")).length,
      0,
    );
    assertEquals(drillProblems(result), []);
  });
});

Deno.test("a store file missing from the set fails the checksums check before anything is started", async () => {
  await withFixture({}, async (f) => {
    await Deno.remove(join(f.set, "redis.rdb.age"));
    const result = await f.run();
    assertEquals(result.outcome, "failed");
    assertEquals(result.checksFailed, ["checksums"]);
    assertEquals(result.failureCode, "set_incomplete");
    assertEquals(result.checksPassed, ["manifest"]);
    assertEquals(
      f.calls.filter((call) => call.startsWith("docker run")).length,
      0,
    );
  });
});

Deno.test("a file that no longer matches its hash fails the checksums check", async () => {
  await withFixture({}, async (f) => {
    await Deno.writeTextFile(join(f.set, "redis.rdb.age"), "tampered");
    const result = await f.run();
    assertEquals(result.checksFailed, ["checksums"]);
    assertEquals(result.failureCode, "set_incomplete");
    assertEquals(result.checksPassed, ["manifest"]);
  });
});

Deno.test("no key file, or the wrong one, fails the key check and nothing is restored", async () => {
  await withFixture({}, async (f) => {
    const missing = await f.run({ keyFile: null });
    assertEquals(missing.checksFailed, ["key"]);
    assertEquals(missing.failureCode, "key_mismatch");
    const other = join(f.dir, "other.key");
    await Deno.writeTextFile(other, "a different key");
    const wrong = await f.run({ keyFile: other });
    assertEquals(wrong.checksFailed, ["key"]);
    assertEquals(wrong.checksPassed, ["manifest", "checksums"]);
    assertEquals(
      f.calls.filter((call) => call.startsWith("docker run")).length,
      0,
    );
  });
});

Deno.test("a dump that will not restore fails the postgres check and the container is removed", async () => {
  await withFixture({}, async (f) => {
    const result = await f.run({ script: { "pg_restore": bad(1) } });
    assertEquals(result.outcome, "failed");
    assertEquals(result.checksFailed, ["postgres"]);
    assertEquals(result.failureCode, "restore_failed");
    assertEquals(removed(f.calls).length, 1);
    assert(!result.detail!.includes("boom"), "no tool output in the detail");
  });
});

Deno.test("a database that restores to no tables fails the postgres check", async () => {
  await withFixture({}, async (f) => {
    const result = await f.run({
      script: { "information_schema.tables": ok("0") },
    });
    assertEquals(result.checksFailed, ["postgres"]);
  });
});

Deno.test("an unreadable redis snapshot fails the redis check", async () => {
  await withFixture({}, async (f) => {
    const result = await f.run({ script: { "redis-check-rdb": bad(1) } });
    assertEquals(result.checksFailed, ["redis"]);
    assertEquals(result.checksPassed, [
      "manifest",
      "checksums",
      "key",
      "postgres",
    ]);
  });
});

Deno.test("a files archive with a path outside itself is refused and never extracted", async () => {
  await withFixture({}, async (f) => {
    for (const name of ["../evil", "/etc/passwd", "skills/../../x"]) {
      assertEquals(safeMemberName(name), false, name);
    }
    const result = await f.run({
      script: { "tar -tzf": ok("skills/\n../evil\n") },
    });
    assertEquals(result.checksFailed, ["files"]);
    assertEquals(f.calls.filter((call) => call.includes("tar -xzf")).length, 0);
  });
});

Deno.test("a references list that disagrees with the manifest's counts fails the references check", async () => {
  await withFixture({}, async (f) => {
    const result = await f.run({
      script: {
        "references.json.age": ok(
          JSON.stringify({
            format: 1,
            storageBackend: "filesystem",
            skillFiles: [],
            blobs: [],
          }),
        ),
      },
    });
    assertEquals(result.checksFailed, ["references"]);
    assertEquals(result.failureCode, "references_missing");
  });
});

Deno.test("a skill file the database refers to but the set lacks fails the references check", async () => {
  await withFixture({}, async (f) => {
    const result = await f.run({ script: { "skip-skill-file": ok() } });
    assertEquals(result.checksFailed, ["references"]);
    assertEquals(result.failureCode, "references_missing");
  });
});

Deno.test("objects in a remote store are counted, not read, so a set with none of their bytes still passes", async () => {
  await withFixture({ storageBackend: "r2" }, async (f) => {
    const result = await f.run({ script: { "skip-skill-file": ok() } });
    assertEquals(result.outcome, "passed", JSON.stringify(result));
  });
});

Deno.test("a backup newer than the release fails the migrations check, naming the first unknown one", async () => {
  await withFixture({}, async (f) => {
    const result = await f.run({
      script: {
        "schema_migrations": ok(
          "0001_start\n0002_next\n0003_last\n0310_future\n0311_later",
        ),
      },
    });
    assertEquals(result.checksFailed, ["migrations"]);
    assertEquals(result.failureCode, "migration_unsupported");
    assert(result.detail!.includes("0310_future"));
    assert(result.detail!.includes("2 migrations"));
  });
});

Deno.test("a restored database whose effects differ from the recorded census fails the cutoff check", async () => {
  await withFixture({}, async (f) => {
    const result = await f.run({
      script: {
        "external_effects": ok(`${EFFECTS[0].id}|prepared|github.merge`),
      },
    });
    assertEquals(result.checksFailed, ["cutoff"]);
    assertEquals(result.failureCode, "cutoff_mismatch");
    assert(result.detail!.includes("total"));
    assertEquals(result.checksPassed.length, 8);
  });
});

Deno.test("a restored cutoff record with another digest, or none, fails the cutoff check", async () => {
  await withFixture({}, async (f) => {
    const other = await f.run({
      script: { "backup_cutoffs": ok("f".repeat(64)) },
    });
    assertEquals(other.checksFailed, ["cutoff"]);
    const none = await f.run({ script: { "backup_cutoffs": ok("") } });
    assertEquals(none.checksFailed, ["cutoff"]);
  });
});

Deno.test("a set no runner took has only a host-clock cutoff and fails the cutoff check last", async () => {
  await withFixture({ cutoff: "none" }, async (f) => {
    const result = await f.run();
    assertEquals(result.outcome, "failed");
    assertEquals(result.checksFailed, ["cutoff"]);
    assertEquals(result.failureCode, "cutoff_mismatch");
    // Every restore-side check ran before it.
    assertEquals(result.checksPassed.length, 8);
    // The age is still reported, from the weaker clock, so rpo and cutoff agree.
    assertEquals(result.rpoSeconds === null, result.cutoffAt === null);
    assertEquals(drillProblems(result), []);
  });
});

Deno.test("whatever stops the drill, the isolated stores and the scratch directory are removed", async () => {
  await withFixture({}, async (f) => {
    const result = await f.run({
      script: {
        "pg_isready": () => {
          throw new Error("docker is gone");
        },
      },
    });
    assertEquals(result.outcome, "failed");
    assertEquals(result.failureCode, "drill_error");
    assertEquals(removed(f.calls).length, 1);
    assertEquals([...Deno.readDirSync(join(f.dir, "scratch"))].length, 0);
    assert(!result.detail!.includes("docker is gone"), "no raw error text");
  });
});

Deno.test("the images come from the release's compose file, and a compose file that pins none stops the drill", async () => {
  assertEquals(
    imageOf(`  postgres:\n    image: ${POSTGRES}\n`, "postgres"),
    POSTGRES,
  );
  assertEquals(imageOf("services: {}", "redis"), null);
  await withFixture({}, async (f) => {
    await Deno.writeTextFile(
      join(f.release, "infra/production/compose.yaml"),
      "services: {}\n",
    );
    const result = await f.run();
    assertEquals(result.failureCode, "drill_error");
    assertEquals(
      f.calls.filter((call) => call.startsWith("docker run")).length,
      0,
    );
  });
});

Deno.test("the release's migrations are the platform's and each module's bakery ones, not another owner's", async () => {
  await withFixture({}, async (f) => {
    const { releaseMigrations } = await import(
      "../../scripts/deploy/backup-runner/drill.ts"
    );
    assertEquals(
      [...await releaseMigrations(f.release)].sort(),
      ["0001_start", "0002_next", "0003_last"],
    );
    // A restored ledger holding only a provider-owned version is unknown to it.
    const result = await f.run({
      script: { "schema_migrations": ok("0001_start\n0004_provider_only") },
    });
    assertEquals(result.checksFailed, ["migrations"]);
    assert(result.detail!.includes("0004_provider_only"));
  });
});

Deno.test("an unexpected error after postgres passed is reported against the check that was running, coherently", async () => {
  await withFixture({}, async (f) => {
    // The release has no server tree, so reading its migrations throws.
    await Deno.remove(join(f.release, "apps"), { recursive: true });
    const result = await f.run();
    assertEquals(result.outcome, "failed");
    assertEquals(result.failureCode, "drill_error");
    assertEquals(result.checksFailed, ["migrations"]);
    assert(result.checksPassed.includes("postgres"));
    assert(!result.checksPassed.includes("migrations"));
    assertEquals(drillProblems(result), []);
    // It still cleaned up everything it made.
    assertEquals(removed(f.calls).length, 1);
    assertEquals([...Deno.readDirSync(join(f.dir, "scratch"))].length, 0);
    assert(!result.detail!.includes("ENOENT"), "no raw error text");
  });
});

Deno.test("a report that contradicts itself is turned into a coherent failure, never thrown", () => {
  const incoherent = {
    backupName: "set-1",
    startedAt: "2026-11-21T04:00:00.000Z",
    outcome: "failed" as const,
    failureCode: "drill_error" as const,
    detail: "x",
    cutoffAt: null,
    rpoSeconds: 5,
    rtoSeconds: 3,
    // postgres is in both lists: the contradiction the reviewer found.
    checksPassed: ["manifest", "checksums", "key", "postgres"] as const,
    checksFailed: ["postgres"] as const,
  };
  const fixed = ensureCoherent({
    ...incoherent,
    checksPassed: [...incoherent.checksPassed],
    checksFailed: [...incoherent.checksFailed],
  });
  assertEquals(drillProblems(fixed), []);
  assertEquals(fixed.outcome, "failed");
  assertEquals(fixed.checksFailed, ["postgres"]);
  assertEquals(fixed.checksPassed, ["manifest", "checksums", "key"]);
  assertEquals(fixed.rpoSeconds, null, "an age without a cutoff is dropped");
  // A coherent outcome is returned as it is.
  const fine = {
    ...fixed,
    rpoSeconds: null,
  };
  assertEquals(ensureCoherent(fine), fine);
});

Deno.test("every database call goes over loopback, never the unix socket the init server answers on", async () => {
  await withFixture({}, async (f) => {
    await f.run();
    const databaseCalls = f.calls.filter((call) =>
      /\b(pg_isready|psql|createdb|pg_restore)\b/.test(call) &&
      call.includes("docker")
    );
    assert(databaseCalls.length >= 6, String(databaseCalls.length));
    for (const call of databaseCalls) {
      assert(call.includes("-h 127.0.0.1"), `no loopback host: ${call}`);
    }
  });
});

Deno.test("the cutoff time reaches psql as a variable on stdin, never inside the SQL text", async () => {
  await withFixture({}, async (f) => {
    const result = await f.run();
    assertEquals(result.outcome, "passed", JSON.stringify(result));
    const query = f.stdins.find((sql) => sql.includes("backup_cutoffs"))!;
    assert(query.includes(":'at'::timestamptz"), query);
    assert(!query.includes(CUTOFF_AT), "the time is not in the SQL text");
    const call = f.calls.find((c) => c.includes("backup_cutoffs"))!;
    assert(call.includes(`-v at=${CUTOFF_AT}`), call);
    assert(call.includes("-f -"), call);
  });
});
