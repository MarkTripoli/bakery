import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
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
import type { VerifiedManifest } from "./manifest.ts";

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

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null &&
    typeof (value as Record_).release === "string" &&
    typeof (value as Record_).target === "string" &&
    typeof (value as Record_).sha256 === "string";
}

/** The release `current` points at, read from that release's own record. */
async function installed(
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
      await readFile(join(root, "releases", match[1], RECORD_NAME), "utf8"),
    );
  } catch {
    throw new BootstrapError("INSTALL_CORRUPT");
  }
  if (!isRecord(record)) throw new BootstrapError("INSTALL_CORRUPT");
  return { name: match[1], record };
}

/** Streams the artifact into `path`, bounded by the signed size and digest. */
async function stageArtifact(
  path: string,
  manifest: VerifiedManifest,
  download: () => AsyncIterable<Uint8Array>,
): Promise<void> {
  const hash = createHash("sha256");
  const handle = await open(path, "wx", 0o700);
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
        await handle.write(chunk);
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
}

/**
 * Installs a verified release. Stages outside the release directory, verifies
 * size and digest, then activates with two atomic renames: the release
 * directory into place, and the `current` symlink over the old one. Nothing
 * before the second rename changes what `current` runs, so any failure leaves
 * the prior working install intact. A rerun reports what is installed and
 * never changes the version, the target or anything else implicitly.
 */
export async function installRelease(
  options: InstallOptions,
): Promise<InstallResult> {
  const { root, manifest } = options;
  const uid = options.uid ??
    (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (uid === 0) throw new BootstrapError("INSTALL_REFUSED_ROOT");
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new BootstrapError("INSTALL_ROOT_INVALID");
  }
  const name = `${manifest.release}-${manifest.target}`;
  const releaseDir = join(root, "releases", name);
  const lockDir = join(root, LOCK_NAME);
  const stagingRoot = join(root, "staging");
  const binaryPath = join(releaseDir, BINARY_NAME);

  try {
    await mkdir(root, { recursive: true, mode: 0o755 });
    try {
      await mkdir(lockDir, { mode: 0o700 });
    } catch (error) {
      if (errnoOf(error) === "EEXIST") {
        throw new BootstrapError("INSTALL_LOCKED");
      }
      throw error;
    }
  } catch (error) {
    throw fsFailure(error);
  }

  let stagingDir: string | undefined;
  try {
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

    // The release directory must not already exist as anything we did not
    // create: a symlink or a stray directory is a collision, never a target.
    const existing = await exists(releaseDir);
    if (existing !== null) throw new BootstrapError("INSTALL_PATH_COLLISION");
    const existingCurrent = await exists(join(root, "current"));
    if (existingCurrent !== null && !existingCurrent.isSymbolicLink()) {
      throw new BootstrapError("INSTALL_PATH_COLLISION");
    }

    await mkdir(stagingRoot, { recursive: true, mode: 0o755 });
    await mkdir(join(root, "releases"), { recursive: true, mode: 0o755 });
    stagingDir = join(stagingRoot, randomBytes(8).toString("hex"));
    await mkdir(stagingDir, { mode: 0o700 });

    await stageArtifact(
      join(stagingDir, BINARY_NAME),
      manifest,
      options.download,
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
    const pending = join(root, `.current-${randomBytes(6).toString("hex")}`);
    try {
      await symlink(join("releases", name), pending);
      await rename(pending, join(root, "current"));
    } catch (error) {
      await rm(pending, { force: true });
      throw error;
    }
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
