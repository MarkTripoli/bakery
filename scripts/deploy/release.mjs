import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ROOT = "/opt/bakery";
const STATE = "/var/lib/bakery/deploy/state.json";

export function commit(value) {
  if (typeof value !== "string" || !SHA.test(value)) {
    throw new Error("RELEASE_SHA_INVALID");
  }
  return value;
}

export function manifest(value, expectedSha) {
  if (
    value?.format !== 1 || value.sha !== commit(expectedSha) ||
    value.architecture !== "arm64" ||
    value.release !== `bakery@${expectedSha}` ||
    !value.migrations || !value.assets || !Array.isArray(value.expand)
  ) throw new Error("RELEASE_MANIFEST_INVALID");
  for (const [path, digest] of Object.entries(value.migrations)) {
    if (
      !/^apps\/server\/src\/(?:platform|modules\/[^/]+)\/migrations\/[a-zA-Z0-9_./-]+\.(?:sql|ts)$/
        .test(path) ||
      path.split("/").includes("..") || !DIGEST.test(digest)
    ) throw new Error("RELEASE_MIGRATION_INVALID");
  }
  for (const [path, digest] of Object.entries(value.assets)) {
    if (
      !/^assets\/[a-zA-Z0-9_./-]+$/.test(path) ||
      path.split("/").includes("..") || !DIGEST.test(digest)
    ) throw new Error("RELEASE_ASSET_INVALID");
  }
  return value;
}

export function pendingMigrations(applied, target, rollback = false) {
  for (const [path, digest] of Object.entries(target.migrations)) {
    if (applied[path] && applied[path] !== digest) {
      throw new Error("APPLIED_MIGRATION_CHANGED");
    }
  }
  if (rollback) {
    if (Object.entries(target.migrations).some(([p, d]) => applied[p] !== d)) {
      throw new Error("ROLLBACK_SCHEMA_INCOMPATIBLE");
    }
    return [];
  }
  if (Object.keys(applied).some((p) => !target.migrations[p])) {
    throw new Error("APPLIED_MIGRATION_REMOVED");
  }
  const additions = Object.keys(target.migrations).filter((p) => !applied[p]);
  if (Object.keys(applied).length === 0) return additions;
  for (const path of additions) {
    if (
      !target.expand.some((v) =>
        v.path === path && v.sha256 === target.migrations[path]
      )
    ) {
      throw new Error("MIGRATION_COMPATIBILITY_REVIEW_REQUIRED");
    }
  }
  return additions;
}

export async function writeAtomic(path, value, mode = 0o600) {
  const directory = path.slice(0, path.lastIndexOf("/"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", mode);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function ownedDirectory(path, privateDirectory = false) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() || stat.uid !== process.getuid() ||
    (privateDirectory
      ? (stat.mode & 0o777) !== 0o700
      : Boolean(stat.mode & 0o022)) ||
    await realpath(path) !== resolve(path)
  ) throw new Error("PREPARATION_DIRECTORY_UNTRUSTED");
}

export async function snapshotArchive(source, destination, expectedDigest) {
  if (!DIGEST.test(expectedDigest)) throw new Error("ARCHIVE_DIGEST_INVALID");
  await ownedDirectory(dirname(destination), true);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await input.stat()).isFile()) throw new Error("ARCHIVE_NOT_REGULAR");
    const output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        const bytes = buffer.subarray(0, bytesRead);
        await output.writeFile(bytes);
        hash.update(bytes);
      }
      if (hash.digest("hex") !== expectedDigest) {
        throw new Error("ARCHIVE_DIGEST_MISMATCH");
      }
      await output.chmod(0o400);
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

export async function extractArchive(snapshot, directory) {
  await ownedDirectory(dirname(snapshot), true);
  await ownedDirectory(directory, true);
  const stat = await lstat(snapshot);
  if (
    !stat.isFile() || stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o400
  ) {
    throw new Error("ARCHIVE_SNAPSHOT_UNTRUSTED");
  }
  // Trusted stdlib parser only: no service credentials, user imports or archive execution.
  await execute("/usr/bin/python3", [
    "-I",
    "-c",
    `
import pathlib, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive.getmembers():
        if member.name.startswith('/') or '..' in pathlib.PurePosixPath(member.name).parts:
            raise ValueError('ARCHIVE_PATH_INVALID')
    archive.extractall(sys.argv[2], filter='data')
`,
    snapshot,
    directory,
  ], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 300_000,
    maxBuffer: 1024 * 1024,
  });
}

export async function verifyRelease(
  directory,
  sha,
  immutable = true,
  privateRoot = false,
) {
  const data = manifest(
    JSON.parse(await readFile(join(directory, "release.json"), "utf8")),
    sha,
  );
  async function inspect(path) {
    const stat = await lstat(path);
    if (stat.uid !== process.getuid()) throw new Error("RELEASE_OWNER_INVALID");
    if (stat.isSymbolicLink()) {
      if (!(await realpath(path)).startsWith(`${directory}/`)) {
        throw new Error("ARCHIVE_LINK_ESCAPES_RELEASE");
      }
    } else {
      const closedRoot = privateRoot && path === directory &&
        (stat.mode & 0o777) === 0o700;
      if (immutable && (stat.mode & 0o222) && !closedRoot) {
        throw new Error("RELEASE_WRITABLE");
      }
      if (stat.isDirectory()) {
        for (const name of await readdir(path)) await inspect(join(path, name));
      } else if (!stat.isFile()) throw new Error("ARCHIVE_SPECIAL_FILE");
    }
  }
  await inspect(directory);
  for (const [path, hash] of Object.entries(data.migrations)) {
    if (digest(await readFile(join(directory, path))) !== hash) {
      throw new Error("MIGRATION_DIGEST_MISMATCH");
    }
  }
  for (const [path, hash] of Object.entries(data.assets)) {
    if (
      digest(await readFile(join(directory, "apps/web/dist", path))) !== hash
    ) throw new Error("ASSET_DIGEST_MISMATCH");
  }
  return data;
}

async function sealRelease(path, privateRoot = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) await sealRelease(join(path, name));
  }
  await chmod(
    path,
    privateRoot
      ? 0o700
      : stat.isDirectory() || (stat.mode & 0o111)
      ? 0o555
      : 0o444,
  );
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeQuarantine(path) {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    if (stat.uid !== process.getuid()) {
      throw new Error("QUARANTINE_OWNER_INVALID");
    }
    await chmod(path, 0o700);
    for (const name of await readdir(path)) {
      await removeQuarantine(join(path, name));
    }
  }
  await rm(path, { force: true, recursive: stat.isDirectory() });
}

export async function prepareRelease(
  { sha, checksum, incoming, quarantine, releases },
) {
  commit(sha);
  await ownedDirectory(releases);
  const directory = join(releases, sha);
  let exists = true;
  try {
    await lstat(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) {
    const closedRoot = ((await lstat(directory)).mode & 0o777) === 0o700;
    await verifyRelease(directory, sha, true, closedRoot);
    if (closedRoot) await chmod(directory, 0o555);
    await verifyRelease(directory, sha);
    return directory;
  }
  await ownedDirectory(quarantine, true);
  const privateDirectory = await mkdtemp(join(quarantine, "prepare-"));
  try {
    const snapshot = join(privateDirectory, "archive.tar.gz");
    await snapshotArchive(join(incoming, `${sha}.tar.gz`), snapshot, checksum);
    const tree = join(privateDirectory, "tree");
    await mkdir(tree, { mode: 0o700 });
    await extractArchive(snapshot, tree);
    // execFile has joined the sole trusted writer before validation/sealing/publication.
    await verifyRelease(tree, sha, false);
    await sealRelease(tree, true);
    await verifyRelease(tree, sha, true, true);
    await rename(tree, directory);
    await chmod(directory, 0o555);
    await verifyRelease(directory, sha);
    const parent = await open(releases, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return directory;
  } finally {
    await removeQuarantine(privateDirectory);
  }
}

export function renderCaddy(config, active, root = ROOT) {
  if (
    isIP(config.publicIp) !== 4 ||
    !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])$/.test(
      config.publicHost,
    ) ||
    isIP(config.publicHost) || !config.publicHost.includes(".") ||
    !/^[a-zA-Z0-9._+@-]+$/.test(config.acmeEmail) ||
    !/^\/[a-zA-Z0-9_/-]+$/.test(root)
  ) throw new Error("PRODUCTION_ORIGIN_INVALID");
  const app = (slot) => {
    if (!["blue", "green"].includes(slot)) throw new Error("SLOT_INVALID");
    return `
  @api path /health/* /livez /readyz /v1/* /api/* /mcp /mcp/* /.well-known/oauth-*
  handle @api {
    reverse_proxy 127.0.0.1:${slot === "blue" ? 18000 : 18001}
  }
  # Caddy sorts handle blocks by path length: a bare *.map handler loses to
  # /assets/*, so the assets block rejects source maps itself.
  @maps path *.map
  handle @maps {
    respond 404
  }
  handle /assets/* {
    route {
      @assetmaps path *.map
      respond @assetmaps 404
      root * ${root}/static
      header Cache-Control "public, max-age=31536000, immutable"
      file_server
    }
  }
  handle {
    root * ${root}/slots/${slot}/apps/web/dist
    header Cache-Control "no-store"
    try_files {path} /index.html
    file_server
  }`;
  };
  const tls = `tls {
    issuer acme {
      dir https://acme-v02.api.letsencrypt.org/directory
      email ${config.acmeEmail}
      profile shortlived
    }
  }`;
  return `{
  admin unix//run/bakery-caddy/admin.sock
  persist_config off
}
https://${config.publicHost} {
  bind ${config.publicIp}
  ${tls}
  ${active ? app(active.slot) : 'respond "Bakery installation pending" 503'}
}
https://${config.publicIp}, https://${config.publicIp}:8443 {
  bind ${config.publicIp}
  ${tls}
  @private expression {http.request.local.port} == "8443"
  handle @private {
    @local remote_ip 127.0.0.1 ${config.publicIp}
    handle @local {
      reverse_proxy 127.0.0.1:8288
    }
    respond 403
  }
  handle {
    redir https://${config.publicHost}{uri} 308
  }
}
http://127.0.0.1:19000 {
  bind 127.0.0.1
  ${app("blue")}
}
http://127.0.0.1:19001 {
  bind 127.0.0.1
  ${app("green")}
}
`;
}

export async function smoke(origin, sha, fetcher = fetch) {
  const request = async (path) => {
    const response = await fetcher(`${origin}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) throw new Error(`SMOKE_HTTP_${response.status}`);
    return response;
  };
  const health = await (await request("/health/ready")).json();
  if (health.version !== sha || health.state !== "ok") {
    throw new Error("SMOKE_RELEASE_NOT_READY");
  }
  const release = await (await request("/_release.json")).json();
  if (release.sha !== sha) throw new Error("SMOKE_STATIC_RELEASE_MISMATCH");
  const html = await (await request("/")).text();
  const urls = [
    ...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g),
  ]
    .map((m) => m[1]);
  if (!urls.some((p) => p.endsWith(".js"))) {
    throw new Error("SMOKE_BUNDLE_MISSING");
  }
  for (const path of new Set(urls)) {
    const response = await request(path);
    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      throw new Error("SMOKE_BUNDLE_IS_HTML");
    }
    await response.arrayBuffer();
  }
  const deep = await (await request("/sign-in")).text();
  if (deep !== html) throw new Error("SMOKE_DEEP_LINK_FAILED");
  const installation = await (await request("/v1/installation/status")).json();
  if (typeof installation.bootstrapped !== "boolean") {
    throw new Error("SMOKE_INSTALLATION_INVALID");
  }
  const identity = await fetcher(`${origin}/v1/me`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (identity.status !== 401) throw new Error("SMOKE_AUTH_BOUNDARY_FAILED");
}

export async function transition(
  store,
  operations,
  sha,
  digest,
  rollback = false,
  bootstrap = false,
) {
  commit(sha);
  const old = await store.read();
  if (
    old.phase === "enrollment" && !rollback && !bootstrap &&
    old.desired.sha === sha
  ) {
    return await finish(store, operations, old);
  }
  if (old.phase !== "committed") throw new Error("RECOVERY_REQUIRED");
  if (bootstrap && old.active) {
    throw new Error("BOOTSTRAP_ALREADY_INITIALIZED");
  }
  if (old.active?.sha === sha) return old;
  if (rollback && old.previous?.sha !== sha) {
    throw new Error("ROLLBACK_TARGET_INVALID");
  }
  await operations.prepare(sha, digest);
  const target = manifest(await operations.manifest(sha), sha);
  const additions = pendingMigrations(old.migrations, target, rollback);
  const desired = { sha, slot: old.active?.slot === "blue" ? "green" : "blue" };
  let state = {
    ...old,
    phase: "preparing",
    desired,
    transaction: randomUUID(),
  };
  await store.write(state);
  try {
    await operations.backup();
    if (additions.length) {
      state = {
        ...state,
        phase: "migrating",
        migrations: { ...state.migrations, ...target.migrations },
      };
      await store.write(state);
      await operations.migrate(sha);
      state = { ...state, phase: "preparing" };
      await store.write(state);
    }
    await operations.services();
    await operations.nativeProbe(sha);
    await operations.startApi(desired);
    await operations.greenSmoke(desired);
    state = { ...state, phase: "switching" };
    await store.write(state);
    await operations.switchProxy(desired);
    await operations.publicSmoke(desired);
    if (bootstrap) {
      state = { ...state, phase: "enrollment" };
      await store.write(state);
      return state;
    }
    return await finish(store, operations, state);
  } catch (error) {
    await recover(store, operations);
    throw error;
  }
}

async function finish(store, operations, state) {
  try {
    await operations.publicSmoke(state.desired);
    state = { ...state, phase: "background" };
    await store.write(state);
    await operations.background(state.desired);
    await operations.backgroundSmoke(state.desired);
    await operations.publicSmoke(state.desired);
    const committed = {
      format: 1,
      phase: "committed",
      active: state.desired,
      previous: state.active,
      migrations: state.migrations,
      transaction: state.transaction,
    };
    await store.write(committed);
    return committed;
  } catch (error) {
    await recover(store, operations);
    throw error;
  }
}

export async function recover(store, operations) {
  const state = await store.read();
  if (state.phase === "committed" || state.phase === "enrollment") return state;
  if (state.phase === "migrating") await operations.migrate(state.desired.sha);
  // The host lock binds recovery to this journal; no CI-side cancellation race.
  await operations.switchProxy(state.active);
  if (state.phase === "background") await operations.background(state.active);
  if (state.active) {
    await operations.publicSmoke(state.active);
    await operations.backgroundSmoke(state.active);
  } else {
    await operations.background(null);
  }
  if (state.desired) await operations.stopApi(state.desired);
  const restored = {
    format: 1,
    phase: "committed",
    active: state.active,
    previous: state.previous,
    migrations: state.migrations,
    transaction: state.transaction,
  };
  await store.write(restored);
  return restored;
}

export async function restoreAfterBoot(store, operations) {
  const state = await store.read();
  if (!state.active && !state.desired) return state;
  await operations.infrastructure();
  if (state.phase === "migrating") await operations.migrate(state.desired.sha);
  await operations.services();
  const active = state.phase === "enrollment" ? state.desired : state.active;
  if (active) {
    manifest(await operations.manifest(active.sha), active.sha);
    await operations.prepare(active.sha, "retained");
    await operations.nativeProbe(active.sha);
    await operations.startApi(active);
    await operations.switchProxy(active);
    await operations.publicSmoke(active);
    if (state.phase !== "enrollment") {
      await operations.bootBackground(active);
      await operations.backgroundSmoke(active);
    }
  } else {
    await operations.switchProxy(null);
  }
  if (state.desired && state.desired.slot !== active?.slot) {
    await operations.stopApi(state.desired);
  }
  if (state.phase === "enrollment" || state.phase === "committed") return state;
  const restored = {
    format: 1,
    phase: "committed",
    active: state.active,
    previous: state.previous,
    migrations: state.migrations,
    transaction: state.transaction,
  };
  await store.write(restored);
  return restored;
}

export function hostOperations(config) {
  const action = async (name, ...args) => {
    try {
      await execute(`${ROOT}/deploy/runtime.sh`, [name, ...args], {
        timeout: name === "migrate" ? 600_000 : 300_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      });
    } catch (error) {
      throw new Error(
        `DEPLOY_${name.toUpperCase()}_FAILED:${error.code ?? "unknown"}`,
      );
    }
  };
  const switchProxy = async (active) => {
    const path = "/etc/bakery/Caddyfile.next";
    await writeAtomic(path, renderCaddy(config, active), 0o644);
    await action("proxy", path);
  };
  return {
    prepare: (sha, digest) => action("prepare", sha, digest ?? "retained"),
    manifest: async (sha) =>
      JSON.parse(
        await readFile(`${ROOT}/releases/${sha}/release.json`, "utf8"),
      ),
    backup: () => action("backup"),
    migrate: (sha) => action("migrate", sha),
    nativeProbe: (sha) => action("probe", sha),
    startApi: (active) => action("api-start", active.slot, active.sha),
    stopApi: (active) => action("api-stop", active.slot),
    greenSmoke: async (active) => {
      const origin = `http://127.0.0.1:${
        active.slot === "blue" ? 19000 : 19001
      }`;
      await retry(() => smoke(origin, active.sha));
    },
    switchProxy,
    publicSmoke: (active) =>
      retry(() => smoke(`https://${config.publicHost}`, active.sha)),
    background: (active) => action("background", active?.sha ?? "stop"),
    backgroundSmoke: () => action("background-check"),
    infrastructure: () => action("infrastructure"),
    services: () => action("services"),
    bootBackground: (active) => action("boot-background", active.sha),
  };
}

async function retry(operation) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  if (process.getuid() !== 0) throw new Error("ROOT_REQUIRED");
  const [command, sha, checksum] = process.argv.slice(2);
  const config = JSON.parse(
    await readFile("/etc/bakery/deployment.json", "utf8"),
  );
  const store = {
    read: async () => JSON.parse(await readFile(STATE, "utf8")),
    write: (value) => writeAtomic(STATE, `${JSON.stringify(value, null, 2)}\n`),
  };
  const operations = await hostOperations(config);
  switch (command) {
    case "deploy":
      if (!DIGEST.test(checksum)) throw new Error("ARCHIVE_DIGEST_INVALID");
      await transition(store, operations, sha, checksum);
      break;
    case "bootstrap":
      if (!DIGEST.test(checksum)) throw new Error("ARCHIVE_DIGEST_INVALID");
      await transition(store, operations, sha, checksum, false, true);
      console.log("API_READY_WORKER_ENROLLMENT_REQUIRED");
      break;
    case "rollback": {
      const state = await store.read();
      if (state.active?.sha !== commit(sha)) {
        throw new Error("ROLLBACK_HEAD_CHANGED");
      }
      if (!state.previous) throw new Error("NO_ROLLBACK_BASELINE");
      await transition(store, operations, state.previous.sha, undefined, true);
      break;
    }
    case "recover":
      await recover(store, operations);
      break;
    case "restore":
      await restoreAfterBoot(store, operations);
      break;
    case "render":
      await writeAtomic(
        "/etc/bakery/Caddyfile",
        renderCaddy(config, null),
        0o644,
      );
      break;
    default:
      throw new Error("EXPECTED_DEPLOY_ROLLBACK_RECOVER_RENDER");
  }
}

if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
