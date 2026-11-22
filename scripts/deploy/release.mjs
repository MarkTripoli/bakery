import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
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
import {
  askLines,
  completionLines,
  decisionLines,
  failedStepLine,
  failureLines,
  gateReviewLines,
  isRefusal,
  statusLines,
  STEP_LABELS,
  stepLine,
  unsureLines,
} from "./release-messages.mjs";
import {
  addApproval,
  approves,
  gateChanges,
  gateDigests,
  gateFingerprint,
  readApprovals,
} from "./trusted-gate.mjs";

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ROOT = "/opt/bakery";
const STATE = "/var/lib/bakery/deploy/state.json";
// Every event of the update history, one JSON line each. Kept on this host so
// an answer or an outcome is never lost when the database cannot be reached;
// recover sends them to Bakery again, and Bakery ignores one it already has.
const HISTORY = "/var/lib/bakery/deploy/history.jsonl";
// Who approved a change to the checks or the launcher, for exactly which move.
const GATE_APPROVALS = "/var/lib/bakery/deploy/gate-approvals.json";
// Exists from just before an update switches versions until it ends. The proxy
// reads it to say "Bakery is being updated" instead of "not answering". Under
// /etc/bakery because the proxy user can read it; recover and restore remove
// one a crashed launcher left.
const MARKER = "/etc/bakery/update-in-progress";

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

function emit(progress, step, result = "ok") {
  progress({
    step,
    total: STEP_LABELS.length,
    label: STEP_LABELS[step - 1],
    result,
  });
}

export async function transition(
  store,
  operations,
  sha,
  digest,
  rollback = false,
  bootstrap = false,
  progress = () => {},
) {
  commit(sha);
  const old = await store.read();
  if (
    old.phase === "enrollment" && !rollback && !bootstrap &&
    old.desired.sha === sha
  ) {
    return await finish(store, operations, old, progress);
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
  // A candidate never approves a change to its own checks or launcher: the
  // version running now, which is what this launcher compares it with, does.
  // Only an update of a running installation is held: a rollback goes to a
  // release that was already trusted, and a first install has nothing running.
  if (!rollback && !bootstrap && old.active) {
    const gate = typeof operations.gate === "function"
      ? await operations.gate(old.active.sha, sha)
      : null;
    if (gate && gate.changes.length > 0 && !gate.approved) {
      throw Object.assign(new Error("TRUSTED_GATE_CHANGE"), { gate });
    }
  }
  emit(progress, 1);
  const additions = pendingMigrations(old.migrations, target, rollback);
  emit(progress, 2, additions.length ? `${additions.length} to apply` : "none");
  // Only an update of a running installation pauses work. A rollback has to
  // work when Bakery is broken, and a first install has nothing to pause. The
  // journal records which release's code holds the pause (`paused`) before it
  // is taken, so a launcher that dies mid-update is resumed by `recover`, and
  // a host where nothing was paused never calls the database to resume. A
  // refused pause clears the record and throws before anything else is
  // written, so nothing needs undoing.
  const pausing = !rollback && !bootstrap && Boolean(old.active) &&
    typeof operations.pause === "function";
  if (pausing) {
    await store.write({ ...old, paused: sha });
    try {
      await operations.pause(sha);
    } catch (error) {
      try {
        await store.write(old);
      } catch {
        // The journal cannot be written; recover clears the record.
      }
      throw error;
    }
  }
  emit(progress, 3, pausing ? "quiet" : "skipped");
  const askable = !rollback && !bootstrap && Boolean(old.active);
  let switched = false;
  const desired = { sha, slot: old.active?.slot === "blue" ? "green" : "blue" };
  let state = {
    ...old,
    ...(pausing ? { paused: sha } : {}),
    phase: "preparing",
    desired,
    transaction: randomUUID(),
  };
  try {
    await store.write(state);
  } catch (error) {
    if (pausing) await resumeWork(operations, sha);
    throw error;
  }
  if (askable) await setMarker(operations, true);
  try {
    await operations.backup();
    emit(progress, 4);
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
    switched = true;
    await operations.publicSmoke(desired);
    emit(progress, 5);
    if (bootstrap) {
      state = { ...state, phase: "enrollment" };
      await store.write(state);
      await note(operations, progress, { kind: "installed", to: sha });
      return state;
    }
    const done = await finish(store, operations, state, progress, askable);
    await note(operations, progress, {
      kind: rollback ? "rolled_back" : "updated",
      from: old.active.sha,
      to: sha,
    });
    return done;
  } catch (error) {
    // finish() already undid it, asked and recorded: once is the rule.
    if (settled.has(error)) throw error;
    const attempt = askable ? { from: desired.sha, to: old.active.sha } : null;
    throw await undoUpdate(store, operations, error, {
      progress,
      // Traffic reached the new release only after the switch, so only then is
      // there a release to go back from and a person to ask.
      askAbout: switched ? attempt : null,
      wentBack: attempt,
    });
  } finally {
    if (askable) await setMarker(operations, false);
  }
}

/**
 * What `recover` records: the switch that did not finish, and the release it
 * put back. Only a journal that really was mid-switch counts, so running
 * recover again (or on a committed host) records nothing.
 */
export function interruptedMove(before, after) {
  if (
    !before?.desired || before.phase === "committed" ||
    before.phase === "enrollment" || !after?.active
  ) return null;
  return {
    kind: "interrupted",
    from: before.desired.sha,
    to: after.active.sha,
    via: after.active.sha,
  };
}

/** Removes a marker a crashed launcher left; recover and a reboot are the ways out. */
async function clearMarker(operations) {
  await setMarker(operations, false);
}

/** Best effort: a marker that cannot be written never stops an update. */
async function setMarker(operations, on) {
  if (typeof operations.marker !== "function") return;
  try {
    await operations.marker(on);
  } catch {
    // The proxy then says "not answering", which is true.
  }
}

/**
 * Undoes an update that failed, or asks first when the installation's policy
 * says to. Returns the error for the caller to throw.
 *
 * Before the switch there is nothing to ask: the old release was never
 * replaced. After it, the policy decides. `go_back` (also what an unreadable
 * policy means, because the database may be what is down) goes back at once.
 * `ask` shows the state and waits for a person at the terminal: yes goes back,
 * and so does no answer at all being impossible, so a script that cannot be
 * asked leaves the release in place and says how to go back. The answer is
 * recorded for Bakery's history, never needed to go back.
 */
// Errors an undoUpdate has already dealt with. finish() undoes a failure and
// rethrows it into transition(), whose own catch must not ask or record again.
const settled = new WeakSet();

async function undoUpdate(store, operations, error, context) {
  const result = await undoUpdateOnce(store, operations, error, context);
  if (typeof result === "object" && result !== null) settled.add(result);
  return result;
}

async function undoUpdateOnce(
  store,
  operations,
  error,
  { progress, askAbout, wentBack },
) {
  if (!askAbout || !(await asksFirst(operations, askAbout.from))) {
    await recover(store, operations);
    // Bakery did it by itself, so no one is named.
    if (wentBack) {
      await note(operations, progress, {
        kind: "went_back",
        by: null,
        ...wentBack,
      });
    }
    return error;
  }
  const choice = await operations.ask(askAbout);
  if (choice !== "go_back" && choice !== "stay") {
    // Nobody could be asked. The new release stays running, so the history says
    // it was installed and that it was kept by default, with no one named.
    await keepRunning(operations, progress, askAbout);
    await note(operations, progress, {
      kind: "decided_stay",
      by: null,
      from: askAbout.from,
      to: askAbout.to,
    });
    return new Error("UPDATE_LEFT_UNHEALTHY");
  }
  if (choice === "stay") {
    await keepRunning(operations, progress, askAbout);
    await remember(operations, progress, choice, askAbout);
    return new Error("UPDATE_LEFT_UNHEALTHY");
  }
  await recover(store, operations);
  await remember(operations, progress, choice, askAbout);
  return error;
}

/**
 * The new release is serving and stays that way: record the move, so the
 * history (and the Updates page's "can go back to") knows what was replaced
 * even though the update did not finish well.
 */
async function keepRunning(operations, progress, { from, to }) {
  await note(operations, progress, { kind: "updated", from: to, to: from });
}

async function asksFirst(operations, sha) {
  if (
    typeof operations.policy !== "function" ||
    typeof operations.ask !== "function"
  ) return false;
  try {
    return (await operations.policy(sha)).onFailure === "ask";
  } catch {
    return false;
  }
}

/**
 * Records one event of the update history: on this host first, then in
 * Bakery. Never fatal: what happened already happened. Reports through
 * `progress` so the closing lines can say whether Bakery has it.
 */
async function note(operations, progress, event) {
  if (typeof operations.record !== "function") return;
  const full = {
    id: randomUUID(),
    kind: event.kind,
    by: event.by === null ? null : event.by ?? operations.who?.() ?? null,
    at: new Date().toISOString(),
    fromRelease: event.from ?? null,
    toRelease: event.to ?? null,
    detail: event.detail ?? null,
  };
  let saved = { kept: false, inBakery: false };
  try {
    saved = await operations.record(full, event.via);
  } catch {
    // Neither place took it; the lines say so for an answer at the terminal.
  }
  progress({ recorded: { ...full, ...saved } });
  return full;
}

async function remember(operations, progress, choice, { from, to }) {
  await note(operations, progress, {
    kind: choice === "go_back" ? "decided_go_back" : "decided_stay",
    from,
    to,
  });
}

async function finish(
  store,
  operations,
  state,
  progress = () => {},
  askable = false,
) {
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
      // Kept until work has really resumed, so `recover` can retry a resume
      // that failed here or that the launcher never got to run.
      ...(state.paused ? { paused: state.paused } : {}),
    };
    await store.write(committed);
    emit(progress, 6);
    // After the commit, and never fatal: the update is done. If work cannot be
    // resumed now, the record stays, `recover` retries it, and the pause's
    // lease lapses on its own in the meantime.
    const after = await resumeAndClear(store, operations, committed);
    if (after.resumed !== undefined) progress({ resumed: after.resumed });
    return after.state;
  } catch (error) {
    const attempt = askable && state.active
      ? { from: state.desired.sha, to: state.active.sha }
      : null;
    // Everything in finish() runs after the switch, so there is always a
    // release to go back from and a person to ask.
    throw await undoUpdate(store, operations, error, {
      progress,
      askAbout: attempt,
      wentBack: attempt,
    });
  }
}

/**
 * Resumes a pause the launcher took and drops its record once work really
 * resumed. A resume that could not be done leaves the record, so a later
 * `recover` tries again; a record that cannot be rewritten is left too, which
 * only means the next `recover` resumes again, and resuming is safe to repeat.
 */
async function resumeAndClear(store, operations, state) {
  if (!state.paused) return { state, resumed: undefined };
  const resumed = await resumeWork(operations, state.paused);
  if (resumed === null) return { state, resumed };
  const { paused: _, ...rest } = state;
  try {
    await store.write(rest);
  } catch {
    return { state, resumed };
  }
  return { state: rest, resumed };
}

/**
 * Lets work start again after an update. Returns what waited, `null` when it
 * could not be done (the pause then lapses by itself), or undefined when this
 * host has no way to pause. Releases only a pause the launcher itself took.
 */
async function resumeWork(operations, sha) {
  if (typeof operations.resume !== "function") return undefined;
  try {
    return (await operations.resume(sha)).carriedOver;
  } catch {
    return null;
  }
}

export async function recover(store, operations) {
  const state = await store.read();
  if (state.phase === "committed" || state.phase === "enrollment") {
    // Also the way out when the launcher died after pausing and before it
    // resumed: the record is cleared only once work really resumed.
    if (state.paused && state.phase === "committed") {
      return (await resumeAndClear(store, operations, state)).state;
    }
    return state;
  }
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
    ...(state.paused ? { paused: state.paused } : {}),
  };
  await store.write(restored);
  // Only after the old version is serving again, so work never starts against
  // a version that is not answering. The record stays until it really resumed.
  return (await resumeAndClear(store, operations, restored)).state;
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

// Exit codes the "update" task uses to say why a pause was refused (see
// apps/server/src/platform/update-task.ts), so no text has to be read.
const PAUSE_REFUSALS = {
  74: "DRAIN_TIMEOUT",
  75: "INSTALLATION_RESTORING",
  76: "MAINTENANCE_HELD",
};

async function hostAction(name, ...args) {
  try {
    const { stdout } = await execute(`${ROOT}/deploy/runtime.sh`, [
      name,
      ...args,
    ], {
      timeout: name === "migrate" ? 600_000 : 300_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    });
    return stdout;
  } catch (error) {
    throw new Error(
      `DEPLOY_${name.toUpperCase()}_FAILED:${error.code ?? "unknown"}`,
    );
  }
}

/**
 * What the launcher asks of the database around an update: pause, resume, count
 * or list the unsure actions. Each prints one JSON line.
 */
export async function updateTask(sha, subcommand, ...args) {
  try {
    const stdout = await hostAction("update", sha, subcommand, ...args);
    return JSON.parse(stdout.trim().split("\n").at(-1));
  } catch (error) {
    const refusal = PAUSE_REFUSALS[Number(error.message.split(":")[1])];
    if (subcommand === "pause" && refusal) throw new Error(refusal);
    throw error;
  }
}

/** The person at the terminal: who ran sudo, else who is logged in. */
export function loginName() {
  const name = process.env.SUDO_USER;
  if (name && /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/.test(name)) return name;
  return userInfo().username;
}

// The most events kept on the host while Bakery's database does not take them.
// More than this means the database has been unreachable through a very long
// run of updates; the oldest go first, and the file says so in the lines kept.
export const MAX_KEPT_EVENTS = 1000;

async function keptLines(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function writeKept(path, lines) {
  await writeAtomic(path, lines.length ? `${lines.join("\n")}\n` : "");
}

/**
 * Appended and synced, so the event survives a database that is down. The file
 * holds only events Bakery has not taken: `forgetEvent` removes one once it has.
 */
export async function keepEvent(event, path = HISTORY) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "a", 0o600);
  try {
    await file.appendFile(`${JSON.stringify(event)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  const lines = await keptLines(path);
  if (lines.length > MAX_KEPT_EVENTS) {
    await writeKept(path, lines.slice(-MAX_KEPT_EVENTS));
  }
}

/** Drops one event from the host file once Bakery has it. */
export async function forgetEvent(id, path = HISTORY) {
  const lines = await keptLines(path);
  const left = lines.filter((line) => {
    try {
      return JSON.parse(line).id !== id;
    } catch {
      return false;
    }
  });
  if (left.length !== lines.length) await writeKept(path, left);
}

const dash = (value) => value ?? "-";

/**
 * Hands one event to Bakery's database through the update task. `via` is the
 * release whose code runs the task: the newest one that is prepared, since an
 * older one may not know the task yet. Throws when the database does not take it.
 */
async function sendEvent(event, via) {
  const release = via ?? event.toRelease ?? event.fromRelease;
  if (!release) throw new Error("EVENT_HAS_NO_RELEASE");
  await updateTask(
    release,
    "record",
    event.id,
    event.kind,
    dash(event.by),
    event.at,
    dash(event.fromRelease),
    dash(event.toRelease),
    dash(event.detail),
  );
  return true;
}

/**
 * Sends every event still kept on this host. Bakery ignores one it already
 * has, so this is safe to repeat. The file is then rewritten with only the
 * events Bakery did not take, so nothing is ever left behind a window and the
 * file does not grow. Returns how many were sent and how many are still kept.
 */
export async function resendEvents(send = sendEvent, path = HISTORY) {
  const lines = await keptLines(path);
  const unsent = [];
  let sent = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // Not an event: it cannot be sent, so it is not kept.
    }
    try {
      if (await send(event)) {
        sent++;
        continue;
      }
    } catch {
      // Not reachable: it stays on this host for the next time.
    }
    unsent.push(line);
  }
  if (unsent.length !== lines.length) {
    try {
      await writeKept(path, unsent);
    } catch {
      // The file is left as it was; the next run sends the same events again.
    }
  }
  return { sent, unsent: unsent.length };
}

/**
 * Asks the person at the terminal. Returns "go_back" or "stay", or null when
 * nobody can be asked (no terminal): a script is never answered for. The
 * default is No, so pressing Enter changes nothing.
 */
export async function askAtTerminal(
  { from, to },
  { input = process.stdin, output = process.stdout, yes = false } = {},
) {
  for (const line of askLines({ from, to })) output.write(`${line}\n`);
  const answer = await confirmAtTerminal(
    `Go back to ${to.slice(0, 8)} now? Work resumes afterwards.`,
    { input, output, yes },
  );
  return answer === null ? null : answer ? "go_back" : "stay";
}

/**
 * One yes/no question at the terminal. true only on an explicit yes, false for
 * Enter or anything else, null when nobody can be asked (no terminal). `yes`
 * answers for a script, and says so on the line.
 */
export async function confirmAtTerminal(
  question,
  { input = process.stdin, output = process.stdout, yes = false } = {},
) {
  if (yes) {
    output.write(`${question} [y/N] y (--yes)\n`);
    return true;
  }
  if (!input.isTTY) return null;
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    readline.close();
  }
}

/**
 * What differs between the running release and a prepared candidate in the
 * trusted gate, and whether a person already approved exactly that move.
 */
export async function gateReview(
  activeSha,
  sha,
  { root = ROOT, approvalsPath = GATE_APPROVALS } = {},
) {
  // A release that is not on disk must not read as "everything was removed".
  for (const release of [activeSha, sha]) {
    await lstat(`${root}/releases/${release}`);
  }
  const [before, after] = await Promise.all([
    gateDigests(`${root}/releases/${activeSha}`),
    gateDigests(`${root}/releases/${sha}`),
  ]);
  const changes = gateChanges(before, after);
  const fingerprint = gateFingerprint(after);
  return {
    changes,
    fingerprint,
    approved: changes.length === 0 ||
      approves(await readApprovals(approvalsPath), {
        sha,
        active: activeSha,
        fingerprint,
      }),
  };
}

/**
 * approve-gate: shows what the candidate changes in the trusted gate and, on a
 * yes at the terminal, records that this person approved exactly that move.
 * Never run by CI: the wrapper refuses it for the deploy user.
 */
export async function approveGate(
  state,
  sha,
  {
    confirm,
    review = gateReview,
    who = loginName,
    write = writeAtomic,
    approvalsPath = GATE_APPROVALS,
    print = console.log,
    now = () => new Date(),
  },
) {
  commit(sha);
  if (!state?.active) throw new Error("GATE_NOTHING_RUNNING");
  let gate;
  try {
    gate = await review(state.active.sha, sha);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("GATE_RELEASE_NOT_PREPARED");
    throw error;
  }
  if (gate.changes.length === 0) {
    print(
      "No change to the checks or the launcher, so there is nothing to approve.",
    );
    return null;
  }
  for (
    const line of gateReviewLines({
      active: state.active.sha,
      sha,
      changes: gate.changes,
    })
  ) print(line);
  const answer = await confirm("Approve this change?");
  if (answer !== true) throw new Error("GATE_NOT_APPROVED");
  const approval = {
    sha,
    active: state.active.sha,
    fingerprint: gate.fingerprint,
    by: who(),
    at: now().toISOString(),
  };
  await addApproval(approvalsPath, approval, write);
  print(
    `Approved by ${approval.by} at ${
      approval.at.slice(11, 16)
    } UTC. Run the update again.`,
  );
  return approval;
}

export function hostOperations(config, { yes = false } = {}) {
  const action = hostAction;
  const switchProxy = async (active) => {
    const path = "/etc/bakery/Caddyfile.next";
    await writeAtomic(path, renderCaddy(config, active), 0o644);
    await action("proxy", path);
  };
  return {
    pause: (sha) => updateTask(sha, "pause"),
    resume: (sha) => updateTask(sha, "resume"),
    policy: (sha) => updateTask(sha, "policy"),
    gate: (activeSha, sha) => gateReview(activeSha, sha),
    ask: (context) => askAtTerminal(context, { yes }),
    who: loginName,
    record: async (event, via) => {
      let kept = true, inBakery = true;
      try {
        await keepEvent(event);
      } catch {
        kept = false;
      }
      try {
        await sendEvent(event, via);
        // Bakery has it: the host copy has done its job.
        await forgetEvent(event.id).catch(() => {});
      } catch {
        inBakery = false;
      }
      return { kept, inBakery };
    },
    marker: (on) =>
      on
        ? writeAtomic(MARKER, `${new Date().toISOString()}\n`, 0o644)
        : rm(MARKER, { force: true }),
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

const store = {
  read: async () => JSON.parse(await readFile(STATE, "utf8")),
  write: (value) => writeAtomic(STATE, `${JSON.stringify(value, null, 2)}\n`),
};

// The journal as it is now, or null when it cannot be read (first install).
async function readState() {
  try {
    return await store.read();
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  // --yes answers the question "go back?" for a script; it is not an argument.
  const yes = args.includes("--yes");
  const [command, sha, checksum] = args.filter((arg) => arg !== "--yes");
  let lastStep = 0;
  // `resumed` is what waited through an update: counts, null when work could
  // not be resumed, undefined when nothing was paused.
  const notes = { resumed: undefined };
  const progress = (event) => {
    if ("resumed" in event) {
      notes.resumed = event.resumed;
      return;
    }
    if ("recorded" in event) {
      (notes.recorded ??= []).push(event.recorded);
      return;
    }
    lastStep = event.step;
    console.log(stepLine(event));
  };
  try {
    await run(command, sha, checksum, progress, notes, { yes });
  } catch (error) {
    const state = await readState();
    const code = error instanceof Error ? error.message.split(":")[0] : "";
    const failed = ["deploy", "bootstrap", "rollback"].includes(command)
      ? failedStepLine(lastStep + 1, STEP_LABELS.length, code)
      : null;
    if (failed) console.error(failed);
    for (
      const line of failureLines(error, {
        command,
        requested: sha,
        active: state?.active?.sha ?? null,
        previous: state?.previous?.sha ?? null,
        phase: state?.phase ?? null,
        gate: error?.gate,
      })
    ) console.error(line);
    // A refusal that changed nothing is still a line of the history.
    if (
      ["deploy", "bootstrap", "rollback"].includes(command) &&
      !notes.recorded?.length && isRefusal(code) && state?.active &&
      notes.operations
    ) {
      await note(notes.operations, progress, {
        kind: "refused",
        to: SHA.test(sha ?? "") ? sha : null,
        detail: failureLines(error, { command, requested: sha })[0]
          .slice(0, 200),
        via: state.active.sha,
      });
    }
    for (
      const line of decisionLines(
        notes.recorded?.findLast((e) => e.kind.startsWith("decided_")),
      )
    ) console.error(line);
    process.exitCode = 1;
  }
}

async function run(
  command,
  sha,
  checksum,
  progress,
  notes = {},
  options = {},
) {
  if (process.getuid() !== 0) throw new Error("ROOT_REQUIRED");
  if (command === "status") {
    const state = await readState();
    // The counts come from the database, not from Bakery, so they are there
    // when the server is down. If the database does not answer, say so.
    const release = state?.active?.sha;
    const ask = async (subcommand) => {
      if (!release) return undefined;
      try {
        return await updateTask(release, subcommand);
      } catch {
        return null;
      }
    };
    const lines = sha === "--unsure"
      ? unsureLines(await ask("unsure"))
      : statusLines(state, await ask("counts"), await ask("policy"));
    for (const line of lines) console.log(line);
    return;
  }
  if (command === "approve-gate") {
    await approveGate(await readState(), sha, {
      confirm: (question) => confirmAtTerminal(question, { yes: options.yes }),
    });
    return;
  }
  const config = JSON.parse(
    await readFile("/etc/bakery/deployment.json", "utf8"),
  );
  const operations = await hostOperations(config, options);
  notes.operations = operations;
  switch (command) {
    case "deploy": {
      if (!DIGEST.test(checksum)) throw new Error("ARCHIVE_DIGEST_INVALID");
      const before = await readState();
      const state = await transition(
        store,
        operations,
        sha,
        checksum,
        false,
        false,
        progress,
      );
      for (
        const line of completionLines("deploy", state, before, notes.resumed)
      ) {
        console.log(line);
      }
      break;
    }
    case "bootstrap":
      if (!DIGEST.test(checksum)) throw new Error("ARCHIVE_DIGEST_INVALID");
      await transition(store, operations, sha, checksum, false, true, progress);
      console.log("API_READY_WORKER_ENROLLMENT_REQUIRED");
      break;
    case "rollback": {
      const state = await store.read();
      if (state.active?.sha !== commit(sha)) {
        throw new Error("ROLLBACK_HEAD_CHANGED");
      }
      if (!state.previous) throw new Error("NO_ROLLBACK_BASELINE");
      const done = await transition(
        store,
        operations,
        state.previous.sha,
        undefined,
        true,
        false,
        progress,
      );
      for (const line of completionLines("rollback", done, state)) {
        console.log(line);
      }
      break;
    }
    case "recover": {
      const before = await readState();
      await recover(store, operations);
      const after = await readState();
      // A switch that never finished is part of the history; so is clearing it.
      const moved = interruptedMove(before, after);
      if (moved) await note(operations, progress, moved);
      await clearMarker(operations);
      // Events kept while the database could not be reached.
      if (after?.active) {
        await resendEvents((event) => sendEvent(event, after.active.sha));
      }
      break;
    }
    case "restore":
      await restoreAfterBoot(store, operations);
      await clearMarker(operations);
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
  await main();
}
