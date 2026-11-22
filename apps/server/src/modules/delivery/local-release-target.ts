import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeploymentEnvironment } from "./deployment-states.ts";
import {
  type DeployReleaseInput,
  DeployReleaseInputSchema,
  type DeployReleaseResult,
  type HealthInput,
  HealthInputSchema,
  type HealthResult,
  type ObservedEffect,
  type PreparedRelease,
  type PrepareReleaseInput,
  PrepareReleaseInputSchema,
  type ReadEffectInput,
  ReadEffectInputSchema,
  type ReleaseAdapter,
  ReleaseRefused,
  type RollbackInput,
  RollbackInputSchema,
  type RollbackResult,
} from "./release-adapter.ts";

/**
 * A local deployment target (#43, B10.06): the delivery adapter over a
 * directory it owns. It stages built artifacts as immutable releases named by
 * their digest, makes one live by switching a single pointer file, reads what
 * the running release reports to decide health, and restores the previous
 * release by switching the pointer back. It never runs a command, so nothing
 * in workflow data can reach a shell through it.
 *
 * Layout under `root`:
 *   releases/<releaseId>/artifact.bin, release.json   immutable, never deleted
 *   deployments/<deploymentId>.json                   one record per deploy
 *   effects/<sha256 of effect key>.json               the journal that makes a
 *                                                     repeated key a read
 *   current.json                                      the release serving
 *
 * A mutation writes its journal entry first, switches the pointer second and
 * records the result last, so a read after a crash can tell "never started"
 * (journal only, pointer unmoved: provably not applied) from "applied".
 */

const RELEASE_ID = /^[0-9a-f]{12}-[0-9a-f]{12}$/;
const DEPLOYMENT_ID = /^dep-[0-9a-f-]{36}$/;

/** The built artifact of one revision, as the build produced it. */
export type BuiltArtifact = Readonly<{ digest: string; bytes: Uint8Array }>;

/** What a running release reports about itself, as its own health endpoint would. */
export type ReleaseProbe = Readonly<{ version: string; state: string }>;

/** What the target observed when it checked a deployment's health. */
export type HealthEvidence = Readonly<{
  deploymentId: string;
  releaseId: string;
  expectedCommitSha: string;
  observedVersion: string | null;
  observedState: string | null;
  probeError: string | null;
  checkedAt: string;
}>;

export type LocalReleaseTargetOptions = Readonly<{
  /** Directory the target owns. Nothing outside it is read or written. */
  root: string;
  environment: DeploymentEnvironment;
  /** The build of a revision, or null when there is none. Never a command. */
  artifacts: (input: PrepareReleaseInput) => Promise<BuiltArtifact | null>;
  /** What the serving release says about itself; a throw means unreachable. */
  probe: (
    current: Readonly<{ releaseId: string; commitSha: string }>,
  ) => Promise<ReleaseProbe>;
  /** Keeps health evidence as an artifact version and returns its id. */
  saveEvidence: (evidence: HealthEvidence) => Promise<string>;
  now?: () => Date;
}>;

type ReleaseFile = {
  releaseId: string;
  headSha: string;
  artifactDigest: string;
  preparedAt: string;
};

type Pointer = { releaseId: string; commitSha: string; deploymentId: string };

type DeploymentFile = {
  deploymentId: string;
  releaseId: string;
  commitSha: string;
  previous: Pointer | null;
  status:
    | "deploying"
    | "healthy"
    | "degraded"
    | "failed"
    | "rolling_back"
    | "rolled_back";
  /** True once the pointer was switched to this release. */
  switched: boolean;
  deployEffectId: string;
  rollbackEffectId: string | null;
};

type JournalFile = {
  kind: "deploy" | "rollback";
  effectKey: string;
  effectId: string;
  deploymentId: string;
  releaseId: string;
};

/** A rollback applied: the record says so, or the pointer is already back on the previous release. */
function isRestored(record: DeploymentFile, pointer: Pointer | null): boolean {
  return record.status === "rolled_back" ||
    (record.previous !== null &&
      pointer?.deploymentId === record.previous.deploymentId);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Write beside the target and rename over it, so a reader sees all or nothing. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), "utf8");
  await rename(temporary, path);
}

function parseOrRefuse<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ReleaseRefused("invalid_request");
  return parsed.data;
}

export function createLocalReleaseTarget(
  options: LocalReleaseTargetOptions,
): ReleaseAdapter {
  const now = options.now ?? (() => new Date());
  const releasePath = (releaseId: string) =>
    join(options.root, "releases", releaseId);
  const deploymentPath = (deploymentId: string) =>
    join(options.root, "deployments", `${deploymentId}.json`);
  const journalPath = (effectKey: string) =>
    join(options.root, "effects", `${sha256(effectKey)}.json`);
  const pointerPath = join(options.root, "current.json");

  async function ensureLayout() {
    for (const directory of ["releases", "deployments", "effects"]) {
      await mkdir(join(options.root, directory), { recursive: true });
    }
  }

  /** A staged release, read back and re-verified: a changed artifact is refused. */
  async function loadRelease(releaseId: string): Promise<ReleaseFile> {
    if (!RELEASE_ID.test(releaseId)) {
      throw new ReleaseRefused("no_such_release");
    }
    const release = await readJson<ReleaseFile>(
      join(releasePath(releaseId), "release.json"),
    );
    if (release === null) throw new ReleaseRefused("no_such_release");
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(releasePath(releaseId), "artifact.bin"));
    } catch (error) {
      if (isMissing(error)) throw new ReleaseRefused("release_changed");
      throw error;
    }
    if (`sha256:${sha256(bytes)}` !== release.artifactDigest) {
      throw new ReleaseRefused("release_changed");
    }
    return release;
  }

  async function loadDeployment(deploymentId: string): Promise<DeploymentFile> {
    if (!DEPLOYMENT_ID.test(deploymentId)) {
      throw new ReleaseRefused("no_such_deployment");
    }
    const record = await readJson<DeploymentFile>(deploymentPath(deploymentId));
    if (record === null) throw new ReleaseRefused("no_such_deployment");
    return record;
  }

  function deployResult(
    record: DeploymentFile,
    status: DeployReleaseResult["status"],
  ): DeployReleaseResult {
    return {
      deploymentId: record.deploymentId,
      commitSha: record.commitSha,
      effectId: record.deployEffectId,
      status,
    };
  }

  return {
    async prepare(raw): Promise<PreparedRelease> {
      const input = parseOrRefuse(PrepareReleaseInputSchema, raw);
      const built = await options.artifacts(input);
      if (built === null) throw new ReleaseRefused("artifact_missing");
      const digest = `sha256:${sha256(built.bytes)}`;
      // The digest the build claims and the digest of its bytes must agree, and
      // must be the one the caller verified earlier.
      if (digest !== built.digest) throw new ReleaseRefused("digest_mismatch");
      if (
        input.expectedDigest !== undefined && input.expectedDigest !== digest
      ) {
        throw new ReleaseRefused("digest_mismatch");
      }
      await ensureLayout();
      const releaseId = `${input.headSha.slice(0, 12)}-${digest.slice(7, 19)}`;
      const existing = await readJson<ReleaseFile>(
        join(releasePath(releaseId), "release.json"),
      );
      if (existing !== null) {
        // Immutable: the same release is reused, a different one is refused.
        await loadRelease(releaseId);
        if (
          existing.artifactDigest !== digest ||
          existing.headSha !== input.headSha
        ) {
          throw new ReleaseRefused("release_changed");
        }
      } else {
        await mkdir(releasePath(releaseId), { recursive: true });
        await writeFile(
          join(releasePath(releaseId), "artifact.bin"),
          built.bytes,
        );
        await writeJson(
          join(releasePath(releaseId), "release.json"),
          {
            releaseId,
            headSha: input.headSha,
            artifactDigest: digest,
            preparedAt: now().toISOString(),
          } satisfies ReleaseFile,
        );
      }
      return {
        releaseId,
        artifactDigest: digest as PreparedRelease["artifactDigest"],
        environment: options.environment,
        status: "prepared",
      };
    },

    async deploy(raw: DeployReleaseInput): Promise<DeployReleaseResult> {
      const input = parseOrRefuse(DeployReleaseInputSchema, raw);
      const journal = await readJson<JournalFile>(journalPath(input.effectKey));
      if (journal !== null) {
        // Same key, same answer: never the mutation twice.
        if (
          journal.kind !== "deploy" || journal.releaseId !== input.releaseId
        ) {
          throw new ReleaseRefused("effect_key_reused");
        }
        const record = await loadDeployment(journal.deploymentId);
        return deployResult(
          record,
          record.status === "failed" ? "failed" : "deploying",
        );
      }
      const release = await loadRelease(input.releaseId);
      await ensureLayout();
      const deploymentId = `dep-${randomUUID()}`;
      const effectId = `effect-${randomUUID()}`;
      const record: DeploymentFile = {
        deploymentId,
        releaseId: release.releaseId,
        commitSha: release.headSha,
        previous: await readJson<Pointer>(pointerPath),
        status: "deploying",
        switched: false,
        deployEffectId: effectId,
        rollbackEffectId: null,
      };
      await writeJson(deploymentPath(deploymentId), record);
      await writeJson(
        journalPath(input.effectKey),
        {
          kind: "deploy",
          effectKey: input.effectKey,
          effectId,
          deploymentId,
          releaseId: release.releaseId,
        } satisfies JournalFile,
      );
      await writeJson(
        pointerPath,
        {
          releaseId: release.releaseId,
          commitSha: release.headSha,
          deploymentId,
        } satisfies Pointer,
      );
      record.switched = true;
      await writeJson(deploymentPath(deploymentId), record);
      return deployResult(record, "deploying");
    },

    async status(raw: ReadEffectInput): Promise<ObservedEffect> {
      const input = parseOrRefuse(ReadEffectInputSchema, raw);
      const journal = await readJson<JournalFile>(journalPath(input.effectKey));
      if (journal === null) {
        // No journal: the request never reached the target, so nothing changed.
        return { deploymentId: null, effectId: null, status: "failed" };
      }
      const record = await loadDeployment(journal.deploymentId);
      const pointer = await readJson<Pointer>(pointerPath);
      const observed = pointer === null ? {} : {
        observedCommitSha: pointer
          .commitSha as ObservedEffect["observedCommitSha"],
      };
      if (journal.kind === "deploy") {
        const applied = record.switched ||
          pointer?.deploymentId === record.deploymentId;
        const status = !applied
          ? "failed"
          : record.status === "healthy" || record.status === "degraded" ||
              record.status === "failed" || record.status === "rolled_back" ||
              record.status === "rolling_back"
          ? record.status
          : "deploying";
        return {
          deploymentId: record.deploymentId,
          effectId: journal.effectId,
          status,
          ...observed,
        };
      }
      // A rollback effect: applied once the pointer is back on the previous one.
      const restored = isRestored(record, pointer);
      return {
        deploymentId: record.deploymentId,
        effectId: journal.effectId,
        status: restored ? "rolled_back" : "failed",
        ...observed,
      };
    },

    async health(raw: HealthInput): Promise<HealthResult> {
      const input = parseOrRefuse(HealthInputSchema, raw);
      const record = await loadDeployment(input.deploymentId);
      let observedVersion: string | null = null;
      let observedState: string | null = null;
      let probeError: string | null = null;
      try {
        const reported = await options.probe({
          releaseId: record.releaseId,
          commitSha: record.commitSha,
        });
        observedVersion = reported.version;
        observedState = reported.state;
      } catch (error) {
        probeError = error instanceof Error ? error.name : "unreachable";
      }
      // Healthy only when the release says it is the exact revision and ok.
      const status: HealthResult["status"] =
        observedVersion === record.commitSha && observedState === "ok"
          ? "healthy"
          : observedVersion === record.commitSha && observedState === "degraded"
          ? "degraded"
          : "failed";
      const checkedAt = now().toISOString();
      const evidenceArtifactId = await options.saveEvidence({
        deploymentId: record.deploymentId,
        releaseId: record.releaseId,
        expectedCommitSha: record.commitSha,
        observedVersion,
        observedState,
        probeError,
        checkedAt,
      });
      record.status = status;
      await writeJson(deploymentPath(record.deploymentId), record);
      return {
        deploymentId: record.deploymentId,
        status,
        checkedAt,
        evidenceArtifactId,
      };
    },

    async rollback(raw: RollbackInput): Promise<RollbackResult> {
      const input = parseOrRefuse(RollbackInputSchema, raw);
      const record = await loadDeployment(input.deploymentId);
      const journal = await readJson<JournalFile>(journalPath(input.effectKey));
      if (journal !== null) {
        if (
          journal.kind !== "rollback" ||
          journal.deploymentId !== record.deploymentId
        ) {
          throw new ReleaseRefused("effect_key_reused");
        }
        if (record.previous === null) {
          throw new ReleaseRefused("no_previous_release");
        }
        // The same test status() uses: a crash after the switch and before the
        // record write must not read differently by the two calls.
        const restored = isRestored(
          record,
          await readJson<Pointer>(pointerPath),
        );
        return {
          deploymentId: record.deploymentId,
          restoredCommitSha: record.previous.commitSha,
          effectId: journal.effectId,
          status: restored ? "rolled_back" : "unknown",
        };
      }
      if (record.previous === null) {
        throw new ReleaseRefused("no_previous_release");
      }
      // The release to restore must still be exactly what was served.
      await loadRelease(record.previous.releaseId);
      const effectId = `effect-${randomUUID()}`;
      record.rollbackEffectId = effectId;
      record.status = "rolling_back";
      await writeJson(deploymentPath(record.deploymentId), record);
      await writeJson(
        journalPath(input.effectKey),
        {
          kind: "rollback",
          effectKey: input.effectKey,
          effectId,
          deploymentId: record.deploymentId,
          releaseId: record.releaseId,
        } satisfies JournalFile,
      );
      await writeJson(pointerPath, record.previous satisfies Pointer);
      record.status = "rolled_back";
      await writeJson(deploymentPath(record.deploymentId), record);
      return {
        deploymentId: record.deploymentId,
        restoredCommitSha: record.previous
          .commitSha as RollbackResult["restoredCommitSha"],
        effectId,
        status: "rolled_back",
      };
    },
  };
}
