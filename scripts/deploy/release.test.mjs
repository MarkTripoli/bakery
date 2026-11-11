import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  digest,
  extractArchive,
  manifest,
  pendingMigrations,
  prepareRelease,
  recover,
  renderCaddy,
  restoreAfterBoot,
  smoke,
  snapshotArchive,
  transition,
  writeAtomic,
} from "./release.mjs";
import {
  authorizeCandidate,
  promoteUploadedRelease,
} from "./build-release.mjs";

const execute = promisify(execFile);

const blue = "a".repeat(40), green = "b".repeat(40), hash = "c".repeat(64);
const migration = "apps/server/src/platform/migrations/001.sql";
const addition = "apps/server/src/platform/migrations/002.sql";
const release = (sha, migrations = { [migration]: hash }, expand = []) => ({
  format: 1,
  sha,
  architecture: "arm64",
  release: `bakery@${sha}`,
  migrations,
  assets: { "assets/index.js": hash },
  expand,
});

test("probe assembles validated candidate attribution before enabled production config/permissions", async () => {
  const deno = (await execute("which", ["deno"])).stdout.trim();
  const environment = {
    PATH: "/usr/bin:/bin",
    BAKERY_ENV: "production",
    BAKERY_SERVER_URL: "https://bakery.example.com",
    BAKERY_WORKER_STATE_DIR: "/tmp/bakery-synthetic-probe",
    BAKERY_WORKER_CAPABILITIES: "git",
    BAKERY_WORKER_SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/123",
    BAKERY_SENTRY_ENABLED: "true",
    BAKERY_SENTRY_ENVIRONMENT: "production",
  };
  const config =
    `import {readWorkerConfig,readWorkerLaunchPermissions} from './apps/worker/src/config.ts';
const names=${
      JSON.stringify(Object.keys(environment).filter((name) => name !== "PATH"))
    };
const env=Object.fromEntries([...names,'BAKERY_VERSION','BAKERY_SENTRY_RELEASE'].map(n=>[n,Deno.env.get(n)]));
const permissions=readWorkerLaunchPermissions(env,Deno.cwd());const config=readWorkerConfig(env);
console.log(JSON.stringify({version:config.version,enabled:config.sentry.enabled,release:config.sentry.release,net:permissions.net}));`;
  await assert.rejects(
    execute(deno, ["eval", "--cached-only", config], { env: environment }),
    /SENTRY_CONFIGURATION_INVALID:BAKERY_SENTRY_RELEASE/,
  );
  const { stdout } = await execute("bash", [
    "-c",
    'source "$1"; probe_release_environment "$2"; exec "$3" eval --cached-only "$4"',
    "probe-test",
    join(process.cwd(), "scripts/deploy/runtime.sh"),
    green,
    deno,
    config,
  ], { env: environment });
  const observed = JSON.parse(stdout);
  assert.equal(observed.version, green);
  assert.equal(observed.release, `bakery@${green}`);
  assert.equal(observed.enabled, true);
  assert(observed.net.includes("o1.ingest.us.sentry.io:443"));
  await assert.rejects(
    execute("bash", [
      "-c",
      'source "$1"; probe_release_environment "$2"',
      "probe-test",
      join(process.cwd(), "scripts/deploy/runtime.sh"),
      "not-a-sha",
    ], { env: environment }),
    (error) => error.code === 64,
  );
});

async function archiveFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "bakery-archive-test-"));
  const incoming = join(directory, "incoming"),
    quarantine = join(directory, "quarantine"),
    releases = join(directory, "releases"),
    source = join(directory, "source");
  for (const path of [incoming, quarantine, releases, source]) {
    await mkdir(path, { mode: 0o700 });
  }
  t.after(async () => {
    async function writableDirectories(path) {
      const stat = await lstat(path);
      if (!stat.isDirectory()) return;
      await chmod(path, 0o700);
      for (const entry of await readdir(path)) {
        await writableDirectories(join(path, entry));
      }
    }
    await writableDirectories(directory);
    await rm(directory, { recursive: true, force: true });
  });
  const tasks = "trusted migration entrypoint bytes",
    sql = "select 1;",
    asset = "export default true";
  const metadata = {
    ...release(green, { [migration]: digest(sql) }),
    assets: { "assets/index.js": digest(asset) },
  };
  for (
    const [path, bytes] of Object.entries({
      "release.json": JSON.stringify(metadata),
      "apps/server/src/tasks.ts": tasks,
      [migration]: sql,
      "apps/web/dist/assets/index.js": asset,
    })
  ) {
    await mkdir(join(source, path, ".."), { recursive: true });
    await writeFile(join(source, path), bytes);
  }
  const archive = join(incoming, `${green}.tar.gz`);
  const pack = async () => {
    await execute("tar", ["-czf", archive, "-C", source, "."], {
      env: { PATH: "/usr/bin:/bin" },
    });
    return digest(await readFile(archive));
  };
  return {
    directory,
    archive,
    source,
    quarantine,
    releases,
    incoming,
    tasks,
    pack,
    options: (checksum) => ({
      sha: green,
      checksum,
      incoming,
      quarantine,
      releases,
    }),
  };
}

test("protected snapshot keeps verified bytes independent of an open upload writer", async (t) => {
  const f = await archiveFixture(t), checksum = await f.pack();
  const writer = await open(f.archive, "r+");
  const snapshot = join(f.quarantine, "snapshot.tar.gz");
  try {
    await snapshotArchive(f.archive, snapshot, checksum);
    assert.notEqual((await lstat(snapshot)).ino, (await writer.stat()).ino);
    assert.equal((await lstat(snapshot)).mode & 0o777, 0o400);
    await writer.truncate(0);
    await writer.writeFile("changed through retained incoming FD");
    const tree = join(f.quarantine, "tree");
    await mkdir(tree, { mode: 0o700 });
    await extractArchive(snapshot, tree);
    assert.equal(
      await readFile(join(tree, "apps/server/src/tasks.ts"), "utf8"),
      f.tasks,
    );
    assert.equal(digest(await readFile(snapshot)), checksum);
  } finally {
    await writer.close();
  }
});

test("preparation publishes only caller-owned immutable bytes after actual safe extraction", async (t) => {
  const f = await archiveFixture(t);
  await symlink("apps/server/src/tasks.ts", join(f.source, "internal-link"));
  const checksum = await f.pack();
  const prepared = await prepareRelease(f.options(checksum));
  assert.equal(
    await readFile(join(prepared, "apps/server/src/tasks.ts"), "utf8"),
    f.tasks,
  );
  for (
    const path of [
      prepared,
      join(prepared, "apps/server/src/tasks.ts"),
      join(prepared, migration),
      join(prepared, "internal-link"),
    ]
  ) {
    const stat = await lstat(path);
    assert.equal(stat.uid, process.getuid());
    if (!stat.isSymbolicLink()) assert.equal(stat.mode & 0o222, 0);
  }
  assert.deepEqual(await readdir(f.quarantine), []);
  await chmod(join(prepared, "apps/server/src/tasks.ts"), 0o644);
  await assert.rejects(
    prepareRelease(f.options("retained")),
    /RELEASE_WRITABLE/,
  );
});

test("bad byte digest and nonprivate quarantine cannot publish a release", async (t) => {
  const f = await archiveFixture(t), checksum = await f.pack();
  await assert.rejects(
    prepareRelease(f.options(hash)),
    /ARCHIVE_DIGEST_MISMATCH/,
  );
  assert.deepEqual(await readdir(f.releases), []);
  await chmod(f.quarantine, 0o755);
  await assert.rejects(
    prepareRelease(f.options(checksum)),
    /PREPARATION_DIRECTORY_UNTRUSTED/,
  );
  assert.deepEqual(await readdir(f.releases), []);
});

test("incoming symlink and tar path/link escapes are rejected before immutable publication", async (t) => {
  const f = await archiveFixture(t), checksum = await f.pack();
  const pointer = join(f.incoming, "pointer");
  await symlink(f.archive, pointer);
  await assert.rejects(
    snapshotArchive(pointer, join(f.quarantine, "linked-snapshot"), checksum),
    (error) => error.code === "ELOOP",
  );
  await symlink("../../outside", join(f.source, "outside-link"));
  await assert.rejects(
    prepareRelease(f.options(await f.pack())),
    /OutsideDestinationError/,
  );
  await execute("/usr/bin/python3", [
    "-I",
    "-c",
    "import io,sys,tarfile; a=tarfile.open(sys.argv[1],'w:gz'); t=tarfile.TarInfo('../escaped');t.size=4;a.addfile(t,io.BytesIO(b'bad!'));a.close()",
    f.archive,
  ], { env: { PATH: "/usr/bin:/bin" } });
  await assert.rejects(
    prepareRelease(f.options(digest(await readFile(f.archive)))),
    /ARCHIVE_PATH_INVALID/,
  );
  assert.deepEqual(await readdir(f.releases), []);
});

const repository = "bakery-owner/bakery";
const trustedRun = () => ({
  id: 123,
  head_sha: green,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
});

test("final authorization stops a candidate superseded during build/upload", async () => {
  let main = green, deployed = false;
  const reads = [];
  const api = (path) => {
    reads.push(path);
    return path.includes("/runs?")
      ? { workflow_runs: [trustedRun()] }
      : { object: { sha: main } };
  };
  await authorizeCandidate(green, repository, api);
  main = blue;
  await assert.rejects(
    promoteUploadedRelease(green, repository, {
      api,
      deploy: () => {
        deployed = true;
      },
    }),
    /MAIN_CANDIDATE_SUPERSEDED/,
  );
  assert.equal(deployed, false);
  assert.equal(reads.filter((p) => p.endsWith("/heads/main")).length, 2);
});

test("promotion consumes fresh trusted CI and then current main immediately before mutation", async () => {
  const calls = [];
  const api = (path) => {
    calls.push(path.includes("/runs?") ? "ci" : "main");
    return path.includes("/runs?")
      ? { workflow_runs: [trustedRun()] }
      : { object: { sha: green } };
  };
  await promoteUploadedRelease(green, repository, {
    api,
    deploy: () => {
      calls.push("deploy");
    },
  });
  assert.deepEqual(calls, ["ci", "main", "deploy"]);
  for (
    const invalid of [
      { event: "pull_request" },
      { head_sha: blue },
      { conclusion: "failure" },
      { head_repository: { full_name: "fork/bakery" } },
      { head_branch: "feature" },
    ]
  ) {
    let deployed = false;
    const api = () => ({ workflow_runs: [{ ...trustedRun(), ...invalid }] });
    await assert.rejects(
      promoteUploadedRelease(green, repository, {
        api,
        deploy: () => {
          deployed = true;
        },
      }),
      /TRUSTED_MAIN_CI_REQUIRED/,
    );
    assert.equal(deployed, false);
  }
});

async function fixture(t, initial = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bakery-journal-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = {
    read: async () => JSON.parse(await readFile(path, "utf8")),
    write: (state) => writeAtomic(path, JSON.stringify(state)),
  };
  await store.write({
    format: 1,
    phase: "committed",
    active: { sha: blue, slot: "blue" },
    previous: null,
    migrations: { [migration]: hash },
    ...initial,
  });
  const calls = [], failures = new Map();
  let target = release(green);
  const operations = Object.fromEntries(
    [
      "prepare",
      "backup",
      "migrate",
      "nativeProbe",
      "startApi",
      "greenSmoke",
      "switchProxy",
      "publicSmoke",
      "background",
      "backgroundSmoke",
      "stopApi",
      "services",
      "infrastructure",
      "bootBackground",
    ].map((name) => [name, (...args) => {
      calls.push([name, ...args]);
      if (failures.has(name)) {
        const failure = failures.get(name);
        failures.delete(name);
        throw new Error(failure);
      }
    }]),
  );
  operations.manifest = () => target;
  return {
    store,
    operations,
    calls,
    failures,
    target: (value) => {
      target = value;
    },
  };
}

test("promotion commits only after public, native and background checks", async (t) => {
  const f = await fixture(t);
  const state = await transition(f.store, f.operations, green, hash);
  assert.equal(state.active.sha, green);
  assert.equal(state.previous.sha, blue);
  assert.equal(state.active.slot, "green");
  assert(
    f.calls.findIndex(([n]) => n === "nativeProbe") <
      f.calls.findIndex(([n]) => n === "startApi"),
  );
  assert(
    f.calls.findIndex(([n]) => n === "greenSmoke") <
      f.calls.findIndex(([n]) => n === "switchProxy"),
  );
  assert(
    f.calls.findIndex(([n]) => n === "publicSmoke") <
      f.calls.findIndex(([n]) => n === "background"),
  );
  assert.equal(f.calls.at(-1)[0], "publicSmoke");
});

for (
  const step of [
    "backup",
    "nativeProbe",
    "greenSmoke",
    "switchProxy",
    "publicSmoke",
    "background",
    "backgroundSmoke",
  ]
) {
  test(`${step} failure restores old public release and leaves no candidate consumer`, async (t) => {
    const f = await fixture(t);
    f.failures.set(step, `failed:${step}`);
    await assert.rejects(
      transition(f.store, f.operations, green, hash),
      new RegExp(`failed:${step}`),
    );
    assert.equal((await f.store.read()).active.sha, blue);
    assert.equal((await f.store.read()).phase, "committed");
    assert.deepEqual(f.calls.filter(([n]) => n === "switchProxy").at(-1)[1], {
      sha: blue,
      slot: "blue",
    });
    assert.deepEqual(f.calls.filter(([n]) => n === "stopApi").at(-1)[1], {
      sha: green,
      slot: "green",
    });
    if (step.startsWith("background")) {
      assert.equal(
        f.calls.filter(([n]) => n === "background").at(-1)[1].sha,
        blue,
      );
    }
  });
}

test("incomplete background journal recovers without trusting CI process lifetime", async (t) => {
  const f = await fixture(t, {
    phase: "background",
    desired: { sha: green, slot: "green" },
  });
  await assert.rejects(
    transition(f.store, f.operations, green, hash),
    /RECOVERY_REQUIRED/,
  );
  await recover(f.store, f.operations);
  assert.equal((await f.store.read()).active.sha, blue);
  assert.equal(f.calls.find(([n]) => n === "background")[1].sha, blue);
});

test("interrupted additive migration resumes before journal can claim schema compatibility", async (t) => {
  const migrations = { [migration]: hash, [addition]: hash };
  const f = await fixture(t, {
    phase: "migrating",
    desired: { sha: green, slot: "green" },
    migrations,
  });
  f.failures.set("migrate", "database unavailable");
  await assert.rejects(recover(f.store, f.operations), /database unavailable/);
  assert.equal((await f.store.read()).phase, "migrating");
  await recover(f.store, f.operations);
  assert.equal((await f.store.read()).migrations[addition], hash);
  assert.equal(f.calls.find(([n]) => n === "switchProxy")[1].sha, blue);
});

test("expanded schema remains recorded after failed green readiness and explicit rollback", async (t) => {
  const f = await fixture(t);
  f.target(
    release(green, { [migration]: hash, [addition]: hash }, [{
      path: addition,
      sha256: hash,
    }]),
  );
  f.failures.set("greenSmoke", "candidate not ready");
  await assert.rejects(
    transition(f.store, f.operations, green, hash),
    /candidate not ready/,
  );
  assert.equal((await f.store.read()).migrations[addition], hash);
  const before = f.calls.filter(([n]) => n === "migrate").length;
  await transition(f.store, f.operations, green, hash);
  f.target(release(blue));
  await transition(f.store, f.operations, blue, undefined, true);
  assert.equal((await f.store.read()).active.sha, blue);
  assert.equal(f.calls.filter(([n]) => n === "migrate").length, before);
});

test("initial bootstrap runs migrations before any API and holds enrollment without deployed claim", async (t) => {
  const f = await fixture(t, { active: null, migrations: {} });
  const state = await transition(
    f.store,
    f.operations,
    green,
    hash,
    false,
    true,
  );
  assert.equal(state.phase, "enrollment");
  assert.equal(state.active, null);
  assert.equal(state.desired.sha, green);
  assert(
    f.calls.findIndex(([n]) => n === "migrate") <
      f.calls.findIndex(([n]) => n === "startApi"),
  );
  assert(!f.calls.some(([n]) => n === "background"));
  await recover(f.store, f.operations);
  assert.equal((await f.store.read()).phase, "enrollment");
  await transition(f.store, f.operations, green, hash);
  assert.equal((await f.store.read()).phase, "committed");
  assert.equal((await f.store.read()).previous, null);
});

test("SHA, architecture, migration bytes and unreviewed schema changes fail closed", () => {
  assert.throws(() => manifest(release(green), blue), /MANIFEST_INVALID/);
  assert.throws(
    () => manifest({ ...release(green), architecture: "x64" }, green),
    /MANIFEST_INVALID/,
  );
  assert.throws(
    () =>
      pendingMigrations(
        { [migration]: hash },
        release(green, { [migration]: "d".repeat(64) }),
      ),
    /APPLIED_MIGRATION_CHANGED/,
  );
  assert.throws(
    () => pendingMigrations({ [migration]: hash }, release(green, {})),
    /APPLIED_MIGRATION_REMOVED/,
  );
  assert.throws(
    () =>
      pendingMigrations(
        { [migration]: hash },
        release(green, { [migration]: hash, [addition]: hash }),
      ),
    /COMPATIBILITY_REVIEW_REQUIRED/,
  );
  assert.throws(
    () =>
      pendingMigrations(
        { [migration]: hash },
        release(green, { [migration]: hash, [addition]: hash }),
        true,
      ),
    /ROLLBACK_SCHEMA_INCOMPATIBLE/,
  );
});

test("reboot restores committed API and one worker only after real readiness checks", async (t) => {
  const f = await fixture(t);
  f.target(release(blue));
  await restoreAfterBoot(f.store, f.operations);
  assert.equal(
    f.calls.find(([name]) => name === "bootBackground")[1].sha,
    blue,
  );
  assert(
    f.calls.findIndex(([name]) => name === "publicSmoke") <
      f.calls.findIndex(([name]) => name === "bootBackground"),
  );
  assert.equal(f.calls.at(-1)[0], "backgroundSmoke");
});

test("reboot during promotion restores old SHA and retains additive schema", async (t) => {
  const f = await fixture(t, {
    phase: "migrating",
    desired: { sha: green, slot: "green" },
    migrations: { [migration]: hash, [addition]: hash },
  });
  f.target(release(blue));
  f.failures.set("publicSmoke", "TLS unavailable");
  await assert.rejects(
    restoreAfterBoot(f.store, f.operations),
    /TLS unavailable/,
  );
  assert.equal((await f.store.read()).phase, "migrating");
  assert(!f.calls.some(([name]) => name === "bootBackground"));
  await restoreAfterBoot(f.store, f.operations);
  assert.equal((await f.store.read()).active.sha, blue);
  assert.equal((await f.store.read()).migrations[addition], hash);
});

test("reboot preserves initial enrollment API without starting consumers", async (t) => {
  const f = await fixture(t, {
    phase: "enrollment",
    active: null,
    desired: { sha: green, slot: "blue" },
  });
  await restoreAfterBoot(f.store, f.operations);
  assert.equal((await f.store.read()).phase, "enrollment");
  assert(!f.calls.some(([name]) => name === "bootBackground"));
  assert.equal(f.calls.at(-1)[0], "publicSmoke");
});

test("Caddy origin escaping and invalid slots are rejected", () => {
  const config = {
    publicIp: "203.0.113.10",
    publicHost: "bakery.example.com",
    acmeEmail: "ops@example.com",
  };
  assert.match(renderCaddy(config, { slot: "green" }), /127\.0\.0\.1:18001/);
  assert.throws(
    () => renderCaddy({ ...config, publicHost: "a.example.com\n}" }, null),
    /ORIGIN_INVALID/,
  );
  assert.throws(() => renderCaddy(config, { slot: "red" }), /SLOT_INVALID/);
});

test("public smoke exercises HTTP release identity, assets, deep links and auth boundary", async (t) => {
  let version = green,
    assetType = "application/javascript",
    identityStatus = 401;
  const html = '<script type="module" src="/assets/index.js"></script>';
  const server = createServer((req, res) => {
    const path = req.url;
    const json = path === "/health/ready"
      ? { state: "ok", version }
      : path === "/_release.json"
      ? { sha: green }
      : path === "/v1/installation/status"
      ? { bootstrapped: true }
      : null;
    if (path === "/v1/me") {
      res.writeHead(identityStatus).end();
      return;
    }
    if (json) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(json));
      return;
    }
    if (path === "/assets/index.js") {
      res.setHeader("content-type", assetType);
      res.end("export default true");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await smoke(origin, green);
  version = blue;
  await assert.rejects(smoke(origin, green), /RELEASE_NOT_READY/);
  version = green;
  assetType = "text/html";
  await assert.rejects(smoke(origin, green), /BUNDLE_IS_HTML/);
  assetType = "application/javascript";
  identityStatus = 200;
  await assert.rejects(smoke(origin, green), /AUTH_BOUNDARY_FAILED/);
});
