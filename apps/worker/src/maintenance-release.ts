import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type ComponentRelease,
  type MaintenanceComponentAdapter,
  MaintenanceStepError,
  type MaintenanceVerb,
} from "./maintenance.ts";

/**
 * A Bakery-managed component installed as release directories:
 *
 *   <root>/releases/<digest>/artifact      the release manifest bytes
 *   <root>/releases/<digest>/release.json  { version, stateFormat }
 *   <root>/current -> releases/<digest>    the installed release
 *   <root>/state-format                    format of the component's state
 *
 * A new release is staged beside the current one and switched by renaming a
 * fresh symlink over `current`, so the switch is one atomic rename and the
 * previous release stays on disk for rollback. The installed digest is
 * always recomputed from the artifact bytes, never trusted from metadata.
 */
export type ReleaseArtifact = Readonly<{
  bytes: Uint8Array;
  version: string;
  stateFormat: number;
}>;

export type ReleaseDirectoryAdapterOptions = {
  componentKey: string;
  root: string;
  /** Fetches the artifact for a target from the fixed release origin. */
  fetchArtifact: (
    target: { digest: string; version: string | null },
  ) => Promise<ReleaseArtifact>;
  /** Local health check of the installed release. */
  health: (installed: ComponentRelease | null) => Promise<boolean>;
  verbs?: readonly MaintenanceVerb[];
  kind?: "worker" | "harness" | "toolchain";
};

const DEFAULT_VERBS: readonly MaintenanceVerb[] = [
  "refresh_inventory",
  "verify",
  "install_component",
  "update_component",
  "rollback_component",
  "remove_component",
];
const DIGEST = /^[0-9a-f]{64}$/;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "ENOENT";
}

export function createReleaseDirectoryAdapter(
  options: ReleaseDirectoryAdapterOptions,
): MaintenanceComponentAdapter {
  const releases = join(options.root, "releases");
  const current = join(options.root, "current");
  const verbs = new Set(options.verbs ?? DEFAULT_VERBS);

  async function readRelease(
    directory: string,
  ): Promise<ComponentRelease | null> {
    try {
      const bytes = await readFile(join(directory, "artifact"));
      const meta = JSON.parse(
        await readFile(join(directory, "release.json"), "utf8"),
      ) as { version?: unknown; stateFormat?: unknown };
      if (
        typeof meta.version !== "string" ||
        typeof meta.stateFormat !== "number"
      ) return null;
      return {
        digest: sha256(bytes),
        version: meta.version,
        stateFormat: meta.stateFormat,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function installed(): Promise<ComponentRelease | null> {
    let link: string;
    try {
      link = await readlink(current);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    return await readRelease(join(options.root, link));
  }

  async function replaceCurrent(link: string | null): Promise<void> {
    if (link === null) {
      await rm(current, { force: true });
      return;
    }
    const temporary = join(options.root, `.current-${randomUUID()}`);
    await symlink(link, temporary);
    await rename(temporary, current);
  }

  return {
    componentKey: options.componentKey,
    installOwner: "bakery",
    kind: options.kind ?? "worker",
    supports: (verb) => verbs.has(verb),
    installed,
    async verify() {
      const release = await installed();
      if (!release) return { ok: false, diagnostic: "not installed" };
      const named = await readlink(current);
      const expected = named.split("/").pop();
      return expected === release.digest
        ? { ok: true }
        : { ok: false, diagnostic: "installed bytes do not match release" };
    },
    async stage(target) {
      if (!DIGEST.test(target.digest)) {
        throw new MaintenanceStepError("digest_invalid");
      }
      const existing = await readRelease(join(releases, target.digest));
      if (existing?.digest === target.digest) return existing;
      const artifact = await options.fetchArtifact(target);
      const digest = sha256(artifact.bytes);
      if (digest !== target.digest) {
        throw new MaintenanceStepError(
          "digest_mismatch",
          `staged ${artifact.bytes.byteLength} bytes with another digest`,
        );
      }
      await mkdir(releases, { recursive: true, mode: 0o700 });
      const staging = join(releases, `.staging-${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        await writeFile(join(staging, "artifact"), artifact.bytes, {
          mode: 0o600,
          flush: true,
        });
        await writeFile(
          join(staging, "release.json"),
          JSON.stringify({
            version: artifact.version,
            stateFormat: artifact.stateFormat,
          }),
          { mode: 0o600, flush: true },
        );
        await rm(join(releases, digest), { recursive: true, force: true });
        await rename(staging, join(releases, digest));
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      const staged = await readRelease(join(releases, digest));
      if (!staged || staged.digest !== target.digest) {
        throw new MaintenanceStepError("digest_mismatch");
      }
      return staged;
    },
    async release(digest) {
      if (!DIGEST.test(digest)) return null;
      const found = await readRelease(join(releases, digest));
      return found?.digest === digest ? found : null;
    },
    async switchTo(release) {
      await replaceCurrent(join("releases", release.digest));
    },
    async health() {
      return await options.health(await installed());
    },
    async stateFormat() {
      try {
        const text = await readFile(join(options.root, "state-format"), "utf8");
        const value = Number(text.trim());
        return Number.isInteger(value) ? value : 0;
      } catch (error) {
        if (isMissing(error)) return 0;
        throw error;
      }
    },
    async remove() {
      await replaceCurrent(null);
    },
  };
}

/** The component key the worker's own release reports under. */
export const WORKER_COMPONENT_KEY = "worker.bakery";

/**
 * Reads a release folder (`<sourceDir>/<digest>/artifact` and
 * `release.json`) from the fixed local source. The adapter still hashes the
 * bytes and refuses any that do not match the target digest.
 */
export function localReleaseSource(
  sourceDir: string,
): ReleaseDirectoryAdapterOptions["fetchArtifact"] {
  return async (target) => {
    if (!DIGEST.test(target.digest)) {
      throw new MaintenanceStepError("digest_invalid");
    }
    const folder = join(sourceDir, target.digest);
    try {
      const bytes = await readFile(join(folder, "artifact"));
      const meta = JSON.parse(
        await readFile(join(folder, "release.json"), "utf8"),
      ) as { version?: unknown; stateFormat?: unknown };
      if (
        typeof meta.version !== "string" ||
        typeof meta.stateFormat !== "number"
      ) throw new MaintenanceStepError("release_metadata_invalid");
      return {
        bytes: new Uint8Array(bytes),
        version: meta.version,
        stateFormat: meta.stateFormat,
      };
    } catch (error) {
      if (isMissing(error)) {
        throw new MaintenanceStepError("release_not_available");
      }
      throw error;
    }
  };
}

/**
 * The managed components this host's configuration provides: the worker's
 * own release when a release root is set, otherwise none.
 */
export function workerMaintenanceAdapters(
  config: { maintenanceRelease?: { root: string; sourceDir: string } },
): MaintenanceComponentAdapter[] {
  const release = config.maintenanceRelease;
  if (!release) return [];
  return [createReleaseDirectoryAdapter({
    componentKey: WORKER_COMPONENT_KEY,
    root: release.root,
    fetchArtifact: localReleaseSource(release.sourceDir),
    // Health: the installed release is present and its bytes match the
    // digest it is filed under.
    health: async (installed) => {
      if (!installed) return false;
      try {
        const link = await readlink(join(release.root, "current"));
        return link.split("/").pop() === installed.digest;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
  })];
}
