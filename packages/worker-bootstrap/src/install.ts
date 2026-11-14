import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { BootstrapError } from "./errors.ts";
import { readRecord } from "./bounded-read.ts";
import type { VerifiedManifest } from "./manifest.ts";

/**
 * The part of an open file the installer writes the artifact through. It is
 * the whole surface the installer needs, so a caller can wrap or replace the
 * opener to prove how the installer behaves when storage misbehaves.
 */
export type StagedFile = Readonly<{
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}>;

/** What the installer needs to know about a process to judge a lock's owner. */
export type ProcessInfo = Readonly<{ state: string; start: string }>;

/**
 * Looks a process up by pid: its info, `"absent"` when there is no such
 * process, or `null` when that cannot be told. The default reads `/proc`.
 */
export type ProcessProbe = (
  pid: number,
) => Promise<ProcessInfo | "absent" | null>;

export type InstallOptions = Readonly<{
  /** Absolute install root, for example `~/.local/share/bakery-worker`. */
  root: string;
  manifest: VerifiedManifest;
  /**
   * Opens the artifact for the manifest's fixed-origin URL. The installer
   * never builds a URL from the manifest; the caller owns the origin and any
   * redirect bound.
   */
  download: () => AsyncIterable<Uint8Array>;
  /** Defaults to the current user id; `0` is refused. */
  uid?: number;
  now: Date;
  /** Explicit consent to replace a different installed release. */
  upgrade?: boolean;
  /**
   * Opens the staged file for exclusive creation. Defaults to the real
   * filesystem; replace it only to exercise storage failures.
   */
  openStagedFile?: (path: string) => Promise<StagedFile>;
  /**
   * Looks up the process that owns an install lock. Defaults to reading
   * `/proc`; replace it only to exercise how a lock's owner is judged.
   */
  probeProcess?: ProcessProbe;
}>;

export type InstallResult = Readonly<{
  status: "installed" | "already-installed";
  release: string;
  target: string;
  /** Absolute path of the installed worker, for launching by absolute path. */
  binaryPath: string;
}>;

const BINARY_NAME = "bakery-worker";
const RECORD_NAME = "release.json";
const LOCK_NAME = ".install.lock";
const OWNER_NAME = "owner.json";
const TAKEOVER_SUFFIX = ".takeover";
/** A lock directory with no readable owner has this long to be filled in. */
const OWNERLESS_LOCK_GRACE_MS = 30_000;
/** A takeover marker older than this belongs to an installer that died. */
const TAKEOVER_STALE_MS = 60_000;

type Record_ = Readonly<{
  release: string;
  target: string;
  file: string;
  size: number;
  sha256: string;
  keyId: string;
  stateFormat: number;
  protocol: { min: number; max: number };
  installedAt: string;
}>;

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Maps a filesystem failure to a refusal; unknown causes stay in memory only. */
function fsFailure(error: unknown): BootstrapError {
  if (error instanceof BootstrapError) return error;
  const code = errnoOf(error);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new BootstrapError("INSTALL_PERMISSION_DENIED", { cause: error });
  }
  return new BootstrapError("INSTALL_IO_FAILED", { cause: error });
}

async function exists(path: string) {
  return await lstat(path).catch((error) => {
    if (errnoOf(error) === "ENOENT") return null;
    throw error;
  });
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function openForExclusiveWrite(path: string): Promise<StagedFile> {
  return await open(path, "wx", 0o700);
}

/** True when either the real or the effective user id is root. */
export function runsAsRoot(
  ids: Readonly<{ real?: number; effective?: number }>,
): boolean {
  return ids.real === 0 || ids.effective === 0;
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null &&
    typeof (value as Record_).release === "string" &&
    typeof (value as Record_).target === "string" &&
    typeof (value as Record_).sha256 === "string";
}

/** The release `current` points at, read from that release's own record. */
export async function installed(
  root: string,
): Promise<{ name: string; record: Record_ } | null> {
  let target: string;
  try {
    target = await readlink(join(root, "current"));
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT") return null;
    // Not a symlink: a real file or directory sits where `current` must be.
    if (code === "EINVAL") throw new BootstrapError("INSTALL_PATH_COLLISION");
    throw error;
  }
  const match = /^releases\/([A-Za-z0-9._-]+)$/.exec(target);
  if (!match) throw new BootstrapError("INSTALL_CORRUPT");
  let record: unknown;
  try {
    record = JSON.parse(
      await readRecord(join(root, "releases", match[1], RECORD_NAME)),
    );
  } catch {
    throw new BootstrapError("INSTALL_CORRUPT");
  }
  if (!isRecord(record)) throw new BootstrapError("INSTALL_CORRUPT");
  return { name: match[1], record };
}

/**
 * True when `releaseDir` is a real directory holding exactly the release this
 * manifest signs: its record names the release, and the binary in it has the
 * signed size and digest. Anything else in that place is not ours to adopt.
 */
async function holdsRelease(
  releaseDir: string,
  manifest: VerifiedManifest,
): Promise<boolean> {
  const directory = await exists(releaseDir);
  if (directory === null || !directory.isDirectory()) return false;
  let record: unknown;
  try {
    record = JSON.parse(await readRecord(join(releaseDir, RECORD_NAME)));
  } catch {
    return false;
  }
  if (
    !isRecord(record) || record.release !== manifest.release ||
    record.target !== manifest.target || record.sha256 !== manifest.sha256
  ) return false;
  const binaryPath = join(releaseDir, BINARY_NAME);
  const binary = await exists(binaryPath);
  if (binary === null || !binary.isFile() || binary.size !== manifest.size) {
    return false;
  }
  return (await sha256OfFile(binaryPath).catch(() => null)) === manifest.sha256;
}

/**
 * Writes the whole chunk. A write may store fewer bytes than asked without an
 * error, as it does at the edge of a full disk or a quota, so it is repeated
 * from where it stopped. A write that stores nothing would repeat forever, and
 * one that claims more than it was asked cannot be believed: both fail.
 */
async function writeFully(
  file: StagedFile,
  chunk: Uint8Array,
): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    const wanted = chunk.byteLength - written;
    const { bytesWritten } = await file.write(chunk, written, wanted);
    if (
      !Number.isInteger(bytesWritten) || bytesWritten <= 0 ||
      bytesWritten > wanted
    ) throw new BootstrapError("INSTALL_IO_FAILED");
    written += bytesWritten;
  }
}

/**
 * Streams the artifact into `path`, bounded by the signed size and digest, and
 * then reads the file back: what was handed to the filesystem is not evidence
 * of what it kept.
 */
async function stageArtifact(
  path: string,
  manifest: VerifiedManifest,
  download: () => AsyncIterable<Uint8Array>,
  openFile: (path: string) => Promise<StagedFile>,
): Promise<void> {
  const hash = createHash("sha256");
  const handle = await openFile(path);
  let received = 0;
  try {
    try {
      for await (const chunk of download()) {
        received += chunk.byteLength;
        // Cut off as soon as the stream exceeds the signed size; never buffer
        // an attacker-chosen amount.
        if (received > manifest.size) {
          throw new BootstrapError("ARTIFACT_SIZE_MISMATCH");
        }
        hash.update(chunk);
        try {
          await writeFully(handle, chunk);
        } catch (error) {
          // A storage failure is the install's, not the download's.
          throw fsFailure(error);
        }
      }
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      const code = errnoOf(error);
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
        throw fsFailure(error);
      }
      throw new BootstrapError("ARTIFACT_DOWNLOAD_INTERRUPTED", {
        cause: error,
      });
    }
    if (received !== manifest.size) {
      throw new BootstrapError("ARTIFACT_SIZE_MISMATCH");
    }
    if (hash.digest("hex") !== manifest.sha256) {
      throw new BootstrapError("ARTIFACT_DIGEST_MISMATCH");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const staged = await lstat(path);
  if (
    !staged.isFile() || staged.size !== manifest.size ||
    (await sha256OfFile(path)) !== manifest.sha256
  ) throw new BootstrapError("INSTALL_IO_FAILED");
}

// --- the install lock

type LockOwner = Readonly<{ pid: number; start: string | null }>;

/**
 * `/proc/<pid>/stat`: the state is field 3 and the start time field 22. A
 * missing entry only means the process is gone when `/proc` itself is there,
 * so on a host without it the answer is "cannot tell", never "absent".
 */
export const readProcessInfo: ProcessProbe = async (pid) => {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return fields[0] && fields[19]
      ? { state: fields[0], start: fields[19] }
      : null;
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") return null;
    return (await lstat("/proc/self").then(() => true, () => false))
      ? "absent"
      : null;
  }
};

async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readRecord(join(lockDir, OWNER_NAME)),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, start } = parsed as { pid?: unknown; start?: unknown };
    if (
      typeof pid === "number" && Number.isInteger(pid) && pid > 0 &&
      (start === null || typeof start === "string")
    ) return { pid, start };
  } catch {
    // Missing or unreadable: handled as an owner that cannot be identified.
  }
  return null;
}

/**
 * Whether the installer that wrote this lock may still be running. The start
 * time tells an installer from a later process that reused its pid. When the
 * answer cannot be read, the lock is treated as held: taking over a live
 * installer's lock is the harm to avoid.
 */
async function ownerIsAlive(
  owner: LockOwner,
  probe: ProcessProbe,
): Promise<boolean> {
  const seen = await probe(owner.pid);
  if (seen === "absent") return false;
  if (seen === null) return true;
  // Exited but not yet collected by its parent.
  if (seen.state === "Z" || seen.state === "X") return false;
  return owner.start === null || owner.start === seen.start;
}

/**
 * Removes the lock when its installer is gone. Takers go through a marker
 * directory so only one at a time judges and removes a lock; the mkdir that
 * follows decides who then holds it. Returns whether the lock is gone.
 *
 * A marker left by a taker that died is cleared after it has been idle
 * `TAKEOVER_STALE_MS`. Two installers clearing the same abandoned marker at the
 * same instant could both proceed; that needs a dead lock, a dead marker and a
 * simultaneous start, and the cost is one install racing another.
 */
async function reclaimStaleLock(
  lockDir: string,
  probe: ProcessProbe,
): Promise<boolean> {
  const marker = `${lockDir}${TAKEOVER_SUFFIX}`;
  try {
    await mkdir(marker, { mode: 0o700 });
  } catch (error) {
    if (errnoOf(error) !== "EEXIST") throw error;
    const taking = await exists(marker);
    if (taking !== null && Date.now() - taking.mtimeMs > TAKEOVER_STALE_MS) {
      await rm(marker, { recursive: true, force: true });
      return await reclaimStaleLock(lockDir, probe);
    }
    return false;
  }
  try {
    const lock = await exists(lockDir);
    if (lock === null) return true;
    const owner = await readOwner(lockDir);
    const abandoned = owner === null
      ? Date.now() - lock.mtimeMs > OWNERLESS_LOCK_GRACE_MS
      : !(await ownerIsAlive(owner, probe));
    if (!abandoned) return false;
    await rm(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    await rm(marker, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Takes the install lock. The lock is a directory holding its owner's pid and
 * start time, so a lock left by an installer that was killed is recognised and
 * taken over, while a live installer's lock is respected.
 */
async function acquireLock(
  lockDir: string,
  probe: ProcessProbe,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw error;
      if (await reclaimStaleLock(lockDir, probe)) continue;
      break;
    }
    try {
      const own = await probe(process.pid);
      await writeFile(
        join(lockDir, OWNER_NAME),
        JSON.stringify({
          pid: process.pid,
          start: typeof own === "object" && own !== null ? own.start : null,
        }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return;
  }
  throw new BootstrapError("INSTALL_LOCKED");
}

/** Partial downloads of an installer that died. Held under the lock, so none is live. */
async function sweepStaging(stagingRoot: string): Promise<void> {
  const names = await readdir(stagingRoot).catch(() => []);
  for (const name of names) {
    await rm(join(stagingRoot, name), { recursive: true, force: true })
      .catch(() => {});
  }
}

/**
 * The root must be a real directory owned by this user that no one else can
 * write to: a release is verified once and run later, and another user able to
 * write here could swap it in between.
 */
export async function checkRoot(root: string): Promise<void> {
  const info = await lstat(root);
  const owner = typeof process.geteuid === "function"
    ? process.geteuid()
    : undefined;
  if (
    !info.isDirectory() || (info.mode & 0o022) !== 0 ||
    (owner !== undefined && info.uid !== owner)
  ) throw new BootstrapError("INSTALL_ROOT_INVALID");
}

/** Points `current` at a release in one atomic rename over the old link. */
async function activate(root: string, name: string): Promise<void> {
  const pending = join(root, `.current-${randomBytes(6).toString("hex")}`);
  try {
    await symlink(join("releases", name), pending);
    await rename(pending, join(root, "current"));
  } catch (error) {
    await rm(pending, { force: true });
    throw error;
  }
}

/**
 * Installs a verified release. Stages outside the release directory, verifies
 * size and digest, reads the staged file back, then activates with two atomic
 * renames: the release directory into place, and the `current` symlink over
 * the old one. Nothing before the second rename changes what `current` runs,
 * so any failure leaves the prior working install intact. A rerun reports what
 * is installed and never changes the version, the target or anything else
 * implicitly; a run that finds the release already complete on disk (one that
 * stopped between its two renames, or a retained older release) points
 * `current` at it without downloading again.
 *
 * Signals are not handled here. An installer ended abruptly leaves its lock
 * and a partial download, and the next run recognises both as left by a dead
 * process and clears them.
 */
export async function installRelease(
  options: InstallOptions,
): Promise<InstallResult> {
  const { root, manifest } = options;
  const real = options.uid ??
    (typeof process.getuid === "function" ? process.getuid() : undefined);
  const effective = options.uid === undefined &&
      typeof process.geteuid === "function"
    ? process.geteuid()
    : undefined;
  if (runsAsRoot({ real, effective })) {
    throw new BootstrapError("INSTALL_REFUSED_ROOT");
  }
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new BootstrapError("INSTALL_ROOT_INVALID");
  }
  if (
    !(options.now instanceof Date) || !Number.isFinite(options.now.getTime())
  ) throw new BootstrapError("CLOCK_INVALID");
  const name = `${manifest.release}-${manifest.target}`;
  const releaseDir = join(root, "releases", name);
  const lockDir = join(root, LOCK_NAME);
  const stagingRoot = join(root, "staging");
  const binaryPath = join(releaseDir, BINARY_NAME);

  try {
    await mkdir(root, { recursive: true, mode: 0o755 });
    await checkRoot(root);
    await acquireLock(lockDir, options.probeProcess ?? readProcessInfo);
  } catch (error) {
    throw fsFailure(error);
  }

  let stagingDir: string | undefined;
  try {
    await sweepStaging(stagingRoot);
    const current = await installed(root);
    if (current !== null) {
      const same = current.name === name &&
        current.record.release === manifest.release &&
        current.record.target === manifest.target;
      if (!same && options.upgrade !== true) {
        throw new BootstrapError("INSTALL_VERSION_DIFFERS");
      }
      if (same) {
        const digest = await sha256OfFile(binaryPath).catch(() => null);
        if (digest !== current.record.sha256 || digest !== manifest.sha256) {
          throw new BootstrapError("INSTALL_CORRUPT");
        }
        return {
          status: "already-installed",
          release: manifest.release,
          target: manifest.target,
          binaryPath,
        };
      }
    }

    // The release directory is either exactly this release, complete, which a
    // stopped run or an earlier install left behind, or it is something this
    // installer did not create: a symlink, a stray directory, a changed binary.
    // The first is adopted; the rest are a collision, never a target.
    if ((await exists(releaseDir)) !== null) {
      if (!(await holdsRelease(releaseDir, manifest))) {
        throw new BootstrapError("INSTALL_PATH_COLLISION");
      }
      await activate(root, name);
      return {
        status: "installed",
        release: manifest.release,
        target: manifest.target,
        binaryPath,
      };
    }

    await mkdir(stagingRoot, { recursive: true, mode: 0o755 });
    await mkdir(join(root, "releases"), { recursive: true, mode: 0o755 });
    stagingDir = join(stagingRoot, randomBytes(8).toString("hex"));
    await mkdir(stagingDir, { mode: 0o700 });

    await stageArtifact(
      join(stagingDir, BINARY_NAME),
      manifest,
      options.download,
      options.openStagedFile ?? openForExclusiveWrite,
    );
    await chmod(join(stagingDir, BINARY_NAME), 0o755);
    const record: Record_ = {
      release: manifest.release,
      target: manifest.target,
      file: manifest.file,
      size: manifest.size,
      sha256: manifest.sha256,
      keyId: manifest.keyId,
      stateFormat: manifest.stateFormat,
      protocol: { ...manifest.protocol },
      installedAt: options.now.toISOString(),
    };
    await writeFile(
      join(stagingDir, RECORD_NAME),
      JSON.stringify(record, null, 2) + "\n",
      { mode: 0o644, flag: "wx" },
    );

    // Activation. Until the second rename, `current` still runs the old build.
    await rename(stagingDir, releaseDir);
    stagingDir = undefined;
    await activate(root, name);
    return {
      status: "installed",
      release: manifest.release,
      target: manifest.target,
      binaryPath,
    };
  } catch (error) {
    throw fsFailure(error);
  } finally {
    if (stagingDir !== undefined) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}
