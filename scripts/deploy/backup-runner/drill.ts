import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import process from "node:process";
import {
  type Census,
  compareCensus,
  type EffectRow,
} from "../../../apps/server/src/modules/backups/cutoff-rules.ts";
import {
  DRILL_CHECKS,
  type DrillCheck,
  type DrillFailureCode,
  drillProblems,
} from "../../../apps/server/src/modules/backups/drill-rules.ts";
import {
  type Problem,
  readKeyFingerprint,
  verifyBackupDirectory,
} from "./manifest.ts";

/**
 * A restore drill (issue #64 slice D, also #49): restore a backup set into an
 * isolated, throwaway copy of the stores and check it there, so that "we have a
 * backup" becomes "we proved a backup restores", with its age (RPO) and the time
 * the restore took (RTO) measured.
 *
 * Isolation is the point. Every container runs with no network and its own
 * name, nothing is mounted from production, nothing restored is sent anywhere,
 * and everything the drill made is removed when it ends, pass or fail. The
 * drill never writes to a production store, and it is not a restore in place
 * (that is slice E).
 *
 * The drill runs its checks in a fixed order and stops at the first that
 * fails. Every process it starts goes through `exec`, and the clock and the
 * waiting go through `now` and `sleep`, so the whole flow is tested without
 * Docker, `age` or a real database; a real run is proved against a local stack.
 */

export type ExecResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Runs one process; `stdin` is written to it when given. Never throws on a non-zero exit. */
export type Exec = (
  command: readonly string[],
  options?: { readonly stdin?: string },
) => Promise<ExecResult>;

export type DrillOptions = {
  /** The completed backup set to drill. */
  readonly directory: string;
  /** The operator's age identity file; used only as a path argument. */
  readonly identityFile: string;
  /** The installation's secrets key file, checked against the manifest's fingerprint. */
  readonly keyFile?: string;
  /** The release checkout (`/opt/bakery/background`): its compose file and migrations. */
  readonly releaseRoot: string;
  /** Where the drill makes its scratch directory. */
  readonly scratchRoot?: string;
  readonly exec?: Exec;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

/** What the drill found: the body of `backupRunner.drill`, without the id. */
export type DrillOutcome = {
  readonly backupName: string;
  readonly startedAt: string;
  readonly outcome: "passed" | "failed";
  readonly failureCode: DrillFailureCode | null;
  readonly detail: string | null;
  readonly cutoffAt: string | null;
  readonly rpoSeconds: number | null;
  readonly rtoSeconds: number;
  readonly checksPassed: DrillCheck[];
  readonly checksFailed: DrillCheck[];
};

type Failure = {
  readonly check: DrillCheck;
  readonly code: DrillFailureCode;
  readonly detail: string;
};

/**
 * The environment a drill's child processes get: only what `bash`, `docker`,
 * `age` and `tar` need to find themselves and the Docker daemon. The drill is
 * run with `--allow-env` for exactly these names, so it cannot pass anything
 * else on, and nothing of the runner's credential reaches a child.
 */
export const CHILD_ENV_NAMES = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "XDG_RUNTIME_DIR",
] as const;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function defaultExec(): Exec {
  return (command, options) =>
    new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv(),
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        }));
      child.stdin.on("error", () => {});
      child.stdin.end(options?.stdin ?? "");
    });
}

const DATABASES = ["bakery", "inngest"] as const;
/** Every database call goes here, never to the unix socket (see waitReady). */
const LOOPBACK = "127.0.0.1";
const READY_ATTEMPTS = 30;

/** The image a compose file pins for a service, so the drill restores into what production runs. */
export function imageOf(compose: string, service: "postgres" | "redis") {
  const pattern = new RegExp(
    `^\\s*image:\\s*(${service}:[^\\s]+)\\s*$`,
    "m",
  );
  return pattern.exec(compose)?.[1] ?? null;
}

/** Which named check a verification problem belongs to. */
export function checkOfProblem(problem: Problem): DrillCheck {
  switch (problem.kind) {
    case "size_mismatch":
    case "hash_mismatch":
    case "missing_file":
    case "checksums_mismatch":
      return "checksums";
    case "key_mismatch":
      return "key";
    case "cutoff_not_database":
      return "cutoff";
    default:
      return "manifest";
  }
}

const BASH = ["bash", "-c", "set -o pipefail; " /* the script follows */];

function pipeline(script: string, ...args: string[]): string[] {
  return [BASH[0], BASH[1], BASH[2] + script, "drill", ...args];
}

/** A tar member name that stays inside the directory it is extracted into. */
export function safeMemberName(name: string): boolean {
  return name !== "" && !name.startsWith("/") &&
    !name.split("/").includes("..") && !name.includes("\0");
}

type Context = {
  readonly options: DrillOptions;
  readonly exec: Exec;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly containers: string[];
  scratch: string;
};

async function waitReady(
  context: Context,
  container: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    // Over loopback, not the unix socket: the official image starts a temporary
    // server on the socket during its init phase, answers there, and then
    // restarts. That server does not listen on TCP, so a TCP answer means the
    // real one is up. Loopback exists in a container with no network.
    const ready = await context.exec([
      "docker",
      "exec",
      container,
      "pg_isready",
      "-h",
      LOOPBACK,
      "-U",
      "postgres",
    ]);
    if (ready.code === 0) return true;
    await context.sleep(1000);
  }
  return false;
}

async function psql(
  context: Context,
  container: string,
  database: string,
  sql: string,
): Promise<ExecResult> {
  return await context.exec([
    "docker",
    "exec",
    container,
    "psql",
    "-h",
    LOOPBACK,
    "-U",
    "postgres",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-Atq",
    "-F",
    "|",
    "-c",
    sql,
  ]);
}

/**
 * Like `psql`, for a query that takes one value from outside. The value goes in
 * as a psql variable and the SQL comes in on stdin and names it as :'name', so
 * psql quotes it as a literal; the value is never part of the SQL text. psql
 * does not expand variables in a `-c` string, which is why this reads stdin.
 */
async function psqlWithVariable(
  context: Context,
  container: string,
  database: string,
  sql: string,
  name: string,
  value: string,
): Promise<ExecResult> {
  return await context.exec([
    "docker",
    "exec",
    "-i",
    container,
    "psql",
    "-h",
    LOOPBACK,
    "-U",
    "postgres",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    `${name}=${value}`,
    "-Atq",
    "-F",
    "|",
    "-f",
    "-",
  ], { stdin: sql });
}

/** A UTC instant exactly as the manifest records it. */
const CUTOFF_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** Restores both databases into one isolated Postgres; returns its container. */
async function restoreDatabases(
  context: Context,
  image: string,
): Promise<{ container: string } | Failure> {
  const { directory, identityFile } = context.options;
  const container = `bakery-drill-pg-${crypto.randomUUID()}`;
  context.containers.push(container);
  const started = await context.exec([
    "docker",
    "run",
    "--detach",
    "--name",
    container,
    "--network",
    "none",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    image,
  ]);
  const fail = (detail: string): Failure => ({
    check: "postgres",
    code: "restore_failed",
    detail,
  });
  if (started.code !== 0) {
    return fail("The isolated database could not be started; check Docker.");
  }
  if (!await waitReady(context, container)) {
    return fail("The isolated database did not become ready in time.");
  }
  const roles = await psql(
    context,
    container,
    "postgres",
    "create role bakery_owner; create role bakery_app; create role inngest;",
  );
  if (roles.code !== 0) return fail("The isolated database refused its roles.");
  for (const database of DATABASES) {
    const created = await context.exec([
      "docker",
      "exec",
      container,
      "createdb",
      "-h",
      LOOPBACK,
      "-U",
      "postgres",
      database,
    ]);
    if (created.code !== 0) {
      return fail(`The ${database} database could not be created.`);
    }
    const restored = await context.exec(pipeline(
      'age --decrypt --identity "$1" "$2" | docker exec -i "$3" pg_restore -h 127.0.0.1 -U postgres --dbname "$4" --no-owner --no-acl --exit-on-error',
      identityFile,
      join(directory, `${database}.dump.age`),
      container,
      database,
    ));
    if (restored.code !== 0) {
      return fail(
        `The ${database} dump did not restore (exit ${restored.code}); the set or its identity may be wrong.`,
      );
    }
    const count = await psql(
      context,
      container,
      database,
      "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')",
    );
    if (count.code !== 0 || !/^[1-9][0-9]*$/.test(count.stdout.trim())) {
      return fail(`The restored ${database} database holds no tables.`);
    }
  }
  return { container };
}

async function checkRedis(
  context: Context,
  image: string,
): Promise<Failure | null> {
  const { directory, identityFile } = context.options;
  // The RDB is streamed into a container with no network and checked there; it
  // never touches the host's disk.
  const checked = await context.exec(pipeline(
    'age --decrypt --identity "$1" "$2" | docker run -i --rm --network none "$3" sh -c \'cat > /tmp/dump.rdb && redis-check-rdb /tmp/dump.rdb\'',
    identityFile,
    join(directory, "redis.rdb.age"),
    image,
  ));
  return checked.code === 0 ? null : {
    check: "redis",
    code: "restore_failed",
    detail:
      `The Redis snapshot is not a readable RDB file (exit ${checked.code}).`,
  };
}

async function restoreFiles(context: Context): Promise<Failure | null> {
  const { directory, identityFile } = context.options;
  const fail = (detail: string): Failure => ({
    check: "files",
    code: "restore_failed",
    detail,
  });
  const listed = await context.exec(pipeline(
    'age --decrypt --identity "$1" "$2" | tar -tzf -',
    identityFile,
    join(directory, "files.tar.gz.age"),
  ));
  if (listed.code !== 0) {
    return fail(`The files archive could not be read (exit ${listed.code}).`);
  }
  const names = listed.stdout.split("\n").filter((line) => line !== "");
  if (names.some((name) => !safeMemberName(name))) {
    return fail("The files archive holds a path outside its own directory.");
  }
  const root = join(context.scratch, "files");
  const extracted = await context.exec(pipeline(
    'mkdir -p "$3" && age --decrypt --identity "$1" "$2" | tar -xzf - -C "$3" --no-same-owner --no-same-permissions',
    identityFile,
    join(directory, "files.tar.gz.age"),
    root,
  ));
  if (extracted.code !== 0) {
    return fail(`The files archive did not extract (exit ${extracted.code}).`);
  }
  for (const required of ["skills", "worker"]) {
    try {
      if (!(await stat(join(root, required))).isDirectory()) throw new Error();
    } catch {
      return fail(`The files archive has no ${required} directory.`);
    }
  }
  return null;
}

type SkillReference = {
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
};

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function checkReferences(
  context: Context,
  expected: { skillFiles: number; blobs: number },
): Promise<Failure | null> {
  const { directory, identityFile } = context.options;
  const fail = (detail: string): Failure => ({
    check: "references",
    code: "references_missing",
    detail,
  });
  const decrypted = await context.exec([
    "age",
    "--decrypt",
    "--identity",
    identityFile,
    join(directory, "references.json.age"),
  ]);
  if (decrypted.code !== 0) {
    return fail("The references list could not be decrypted.");
  }
  let references: {
    format?: unknown;
    storageBackend?: unknown;
    skillFiles?: unknown;
    blobs?: unknown;
  };
  try {
    references = JSON.parse(decrypted.stdout);
  } catch {
    return fail("The references list is not valid JSON.");
  }
  if (
    references.format !== 1 || !Array.isArray(references.skillFiles) ||
    !Array.isArray(references.blobs)
  ) {
    return fail("The references list has an unknown shape.");
  }
  if (
    references.skillFiles.length !== expected.skillFiles ||
    references.blobs.length !== expected.blobs
  ) {
    return fail(
      "The references list does not match the counts the manifest recorded.",
    );
  }
  // Skill files kept on this host are in the set: each must be there with the
  // recorded size and hash. Objects in a remote store are recorded by key and
  // hash only; their bytes are not in the set, so they are counted, not read.
  if (references.storageBackend === "filesystem") {
    const skills = join(context.scratch, "files", "skills");
    for (const entry of references.skillFiles as SkillReference[]) {
      if (!safeMemberName(entry.objectKey)) {
        return fail("A skill file reference names a path outside the set.");
      }
      const path = join(skills, entry.objectKey);
      try {
        const info = await lstat(path);
        if (!info.isFile()) throw new Error();
        if (info.size !== entry.sizeBytes) throw new Error();
        if (await sha256OfFile(path) !== entry.sha256) throw new Error();
      } catch {
        return fail(
          "A skill file the database refers to is missing or does not match its recorded hash.",
        );
      }
    }
  }
  return null;
}

/**
 * The migration versions the release knows for the `bakery` ledger: the files
 * in the platform's own migrations directory and in each module's
 * `migrations/bakery`. The `provider` and `data` owners keep their own ledgers
 * and are not part of it. A version is the file name without `.sql`.
 */
export async function releaseMigrations(root: string): Promise<Set<string>> {
  const versions = new Set<string>();
  const src = join(root, "apps", "server", "src");
  const directories = [join(src, "platform", "migrations")];
  const modules = join(src, "modules");
  for (const module of await readdir(modules, { withFileTypes: true })) {
    if (module.isDirectory()) {
      directories.push(join(modules, module.name, "migrations", "bakery"));
    }
  }
  for (const directory of directories) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".sql")) versions.add(name.slice(0, -4));
    }
  }
  return versions;
}

async function checkMigrations(
  context: Context,
  container: string,
): Promise<Failure | null> {
  const known = await releaseMigrations(context.options.releaseRoot);
  const applied = await psql(
    context,
    container,
    "bakery",
    "select version from bakery.schema_migrations order by version",
  );
  if (applied.code !== 0) {
    return {
      check: "migrations",
      code: "migration_unsupported",
      detail: "The restored database has no migration ledger.",
    };
  }
  const unknown = applied.stdout.split("\n").filter((line) => line !== "")
    .filter((version) => !known.has(version));
  if (unknown.length === 0) return null;
  return {
    check: "migrations",
    code: "migration_unsupported",
    detail: `The backup holds ${unknown.length} migration${
      unknown.length === 1 ? "" : "s"
    } this release does not know (first: ${
      unknown[0]
    }); install a release at least as new as the backup, then run the drill again.`,
  };
}

async function checkCutoff(
  context: Context,
  container: string,
  cutoff: { at: string; source: string; effects: Census | null },
): Promise<Failure | null> {
  const fail = (detail: string): Failure => ({
    check: "cutoff",
    code: "cutoff_mismatch",
    detail,
  });
  if (cutoff.source !== "database" || cutoff.effects === null) {
    return fail(
      "This set has no database cutoff (a backup the timer took, not the runner); a restore that must not replay effects needs one.",
    );
  }
  // The manifest is read from the set on disk, so its text is not trusted:
  // check it is a plain UTC instant, then hand it over as a variable.
  if (!CUTOFF_INSTANT.test(cutoff.at)) {
    return fail("The set's cutoff time is not a valid UTC instant.");
  }
  const stored = await psqlWithVariable(
    context,
    container,
    "bakery",
    `select effects_digest from bakery.backup_cutoffs
      where date_trunc('milliseconds', cutoff_at) = :'at'::timestamptz;`,
    "at",
    cutoff.at,
  );
  if (stored.code !== 0 || stored.stdout.trim() === "") {
    return fail(
      "The restored database holds no cutoff record for the cutoff in the manifest.",
    );
  }
  if (stored.stdout.trim() !== cutoff.effects.digest) {
    return fail(
      "The restored cutoff record disagrees with the manifest's census digest.",
    );
  }
  const live = await psql(
    context,
    container,
    "bakery",
    "select id, status, operation from bakery.external_effects where status in ('prepared', 'submitted', 'uncertain')",
  );
  if (live.code !== 0) {
    return fail("The restored effects could not be read.");
  }
  const rows: EffectRow[] = live.stdout.split("\n").filter((line) =>
    line !== ""
  ).map((line) => {
    const [id, status, operation] = line.split("|");
    return { id, status, operation };
  });
  const mismatches = await compareCensus(cutoff.effects, rows);
  if (mismatches.length > 0) {
    return fail(
      `The restored database does not match its own cutoff census (${
        mismatches.map((m) => m.field).join(", ")
      }).`,
    );
  }
  return null;
}

/** Everything the drill made is removed, whatever happened. */
async function cleanUp(context: Context): Promise<void> {
  for (const container of context.containers) {
    await context.exec(["docker", "rm", "--force", "--volumes", container])
      .catch(() => {});
  }
  if (context.scratch !== "") {
    await rm(context.scratch, { recursive: true, force: true });
  }
}

export async function runDrill(options: DrillOptions): Promise<DrillOutcome> {
  const now = options.now ?? (() => new Date());
  const startedAtDate = now();
  const context: Context = {
    options,
    exec: options.exec ?? defaultExec(),
    sleep: options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
    containers: [],
    scratch: "",
  };
  const passed: DrillCheck[] = [];
  let failure: Failure | null = null;
  let cutoffAt: string | null = null;
  const pass = (check: DrillCheck) => void passed.push(check);
  const stop = (found: Failure | null) => {
    if (found !== null && failure === null) failure = found;
    return failure !== null;
  };
  try {
    context.scratch = await mkdtemp(
      join(options.scratchRoot ?? "/var/tmp", "bakery-restore-drill-"),
    );
    // manifest, checksums, key: one verification, sorted into the named checks.
    const verified = await verifyBackupDirectory(options.directory, {
      requireDatabaseCutoff: true,
      ...(options.keyFile === undefined ? {} : { keyFile: options.keyFile }),
    });
    cutoffAt = verified.cutoff?.at ?? null;
    const problemsOf = (check: DrillCheck) =>
      verified.problems.filter((problem) => checkOfProblem(problem) === check);
    const describe = (check: DrillCheck, fallback: string) =>
      problemsOf(check).map((problem) =>
        `${problem.store ?? problem.file ?? problem.kind}: ${problem.kind}`
      ).join("; ") || fallback;
    if (
      stop(
        problemsOf("manifest").length > 0 || verified.legacy
          ? {
            check: "manifest",
            code: "set_incomplete",
            detail: `The set is not a complete backup: ${
              describe("manifest", "it has no manifest")
            }.`,
          }
          : null,
      )
    ) return await finish();
    pass("manifest");
    if (
      stop(
        problemsOf("checksums").length > 0
          ? {
            check: "checksums",
            code: "set_incomplete",
            detail: `A file in the set does not match its recorded checksum: ${
              describe("checksums", "")
            }.`,
          }
          : null,
      )
    ) return await finish();
    pass("checksums");
    if (
      stop(
        options.keyFile === undefined
          ? {
            check: "key",
            code: "key_mismatch",
            detail:
              "No secrets key file was given, so the key could not be checked; pass the installation's key file.",
          }
          : problemsOf("key").length > 0
          ? {
            check: "key",
            code: "key_mismatch",
            detail:
              "The secrets key file is not the one this backup was taken with.",
          }
          : null,
      )
    ) return await finish();
    pass("key");

    const compose = await readFile(
      join(options.releaseRoot, "infra", "production", "compose.yaml"),
      "utf8",
    ).catch(() => "");
    const postgresImage = imageOf(compose, "postgres");
    const redisImage = imageOf(compose, "redis");
    if (postgresImage === null || redisImage === null) {
      stop({
        check: "postgres",
        code: "drill_error",
        detail:
          "The release's compose file does not pin the Postgres and Redis images, so the drill cannot use the ones production runs.",
      });
      return await finish();
    }
    const restored = await restoreDatabases(context, postgresImage);
    if (!("container" in restored)) {
      stop(restored);
      return await finish();
    }
    pass("postgres");
    if (stop(await checkRedis(context, redisImage))) return await finish();
    pass("redis");
    if (stop(await restoreFiles(context))) return await finish();
    pass("files");
    const manifest = JSON.parse(
      await readFile(join(options.directory, "manifest.json"), "utf8"),
    ) as { references: { skillFiles: number; blobs: number } };
    if (stop(await checkReferences(context, manifest.references))) {
      return await finish();
    }
    pass("references");
    if (stop(await checkMigrations(context, restored.container))) {
      return await finish();
    }
    pass("migrations");
    const cutoff = verified.cutoff;
    if (
      stop(
        problemsOf("cutoff").length > 0 || cutoff == null
          ? {
            check: "cutoff",
            code: "cutoff_mismatch",
            detail:
              "This set has no database cutoff (a backup the timer took, not the runner); a restore that must not replay effects needs one.",
          }
          : await checkCutoff(context, restored.container, cutoff),
      )
    ) return await finish();
    pass("cutoff");
    return await finish();
  } catch (error) {
    // An unexpected error belongs to the check that was running: the first one
    // that had not passed. Naming a check that already passed would make the
    // report contradict itself.
    stop({
      check: DRILL_CHECKS.find((name) => !passed.includes(name)) ?? "cutoff",
      code: "drill_error",
      detail: `The drill stopped unexpectedly (${
        error instanceof Error ? error.name : "error"
      }); see the host's log.`,
    });
    return await finish();
  }

  async function finish(): Promise<DrillOutcome> {
    const finishedAt = now();
    await cleanUp(context);
    const failed = failure as Failure | null;
    const rto = Math.max(
      0,
      Math.round((finishedAt.getTime() - startedAtDate.getTime()) / 1000),
    );
    const rpo = cutoffAt === null ? null : Math.max(
      0,
      Math.floor((startedAtDate.getTime() - Date.parse(cutoffAt)) / 1000),
    );
    const outcome: DrillOutcome = {
      backupName: basename(options.directory),
      startedAt: startedAtDate.toISOString(),
      outcome: failed === null ? "passed" : "failed",
      failureCode: failed?.code ?? null,
      detail: failed?.detail ?? null,
      cutoffAt,
      rpoSeconds: rpo,
      rtoSeconds: rto,
      checksPassed: passed,
      checksFailed: failed === null ? [] : [failed.check],
    };
    return ensureCoherent(outcome);
  }
}

/**
 * The drill's own report must never be the thing that crashes the command: with
 * no report and no result line the operator learns nothing. If an outcome ever
 * contradicts itself, say so as a coherent failed drill (the first check that
 * had not passed is the one that failed) instead of throwing.
 */
export function ensureCoherent(outcome: DrillOutcome): DrillOutcome {
  if (drillProblems(outcome).length === 0) return outcome;
  // The check that failed is the one the report already names; only when it
  // names none is it the first check that had not passed.
  const stuck =
    outcome.checksFailed.find((name) =>
      (DRILL_CHECKS as readonly string[]).includes(name)
    ) ?? DRILL_CHECKS.find((name) => !outcome.checksPassed.includes(name)) ??
      "cutoff";
  const fallback: DrillOutcome = {
    ...outcome,
    outcome: "failed",
    failureCode: "drill_error",
    detail:
      "The drill's own report was inconsistent, so it is reported as failed; see the host's log.",
    checksPassed: outcome.checksPassed.filter((name) => name !== stuck),
    checksFailed: [stuck],
    // The age and the cutoff come as a pair, or not at all.
    cutoffAt: outcome.rpoSeconds === null ? null : outcome.cutoffAt,
    rpoSeconds: outcome.cutoffAt === null ? null : outcome.rpoSeconds,
  };
  return fallback;
}

export { readKeyFingerprint };
