import { StandardError } from "@bakery/contracts/http";
import type { DeploymentRead } from "./deployments.ts";
import type { DeploymentStatus } from "./deployment-states.ts";
import {
  deployEffectKey,
  type HealthResult,
  type ReleaseAdapter,
  ReleaseRefused,
  rollbackEffectKey,
} from "./release-adapter.ts";

/**
 * Drives one deployment record through its lifecycle by calling the delivery
 * adapter (#43, B10.06). The record is the durable projection of what the
 * adapter reported: every move goes through the ledger, which refuses a move
 * the state machine does not allow and a record that changed meanwhile.
 *
 * Three rules from the adapter contract are kept here:
 * - Only `healthy` is success. `degraded` and `failed` end the deployment, and
 *   a release that replaced another is rolled back under a new effect key.
 * - An answer that may have been lost (a thrown error from deploy or
 *   rollback, an unreadable health check) is `unknown`, never assumed. The
 *   outcome carries the effect key, and `settle` reads that same key back
 *   before anything else is changed. Nothing here retries a mutation.
 * - A refusal made before anything changed is `failed` at once.
 */

/** What a deployment record needs from its store. */
export type DeploymentLedger = Readonly<{
  read(deploymentId: string): Promise<DeploymentRead>;
  advance(
    deploymentId: string,
    move: Readonly<{
      from: DeploymentStatus;
      to: DeploymentStatus;
      expectedVersion: number;
      healthEvidenceId?: string;
    }>,
  ): Promise<DeploymentRead>;
  /** Moves a release that served or failed to serve into rolling_back. */
  startRollback(deploymentId: string, reason: string): Promise<DeploymentRead>;
}>;

/** The record after the call, and the effect key to read back when it is unknown or still rolling back. */
export type DriveOutcome = Readonly<{
  deployment: DeploymentRead;
  effectKey: string | null;
}>;

export type DeploymentDriver = Readonly<{
  /** Prepares, deploys and verifies a queued deployment. */
  deploy(
    deploymentId: string,
    input: Readonly<{ profileRevision: number }>,
  ): Promise<DriveOutcome>;
  /** Restores the previous release of a deployment that is rolling back. */
  rollback(deploymentId: string): Promise<DriveOutcome>;
  /** Reads the effect of an unknown deployment back and moves it to what the read says. */
  settle(deploymentId: string, effectKey: string): Promise<DriveOutcome>;
}>;

function isSha256Digest(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

export function createDeploymentDriver(
  deps: Readonly<{ ledger: DeploymentLedger; adapter: ReleaseAdapter }>,
): DeploymentDriver {
  const { ledger, adapter } = deps;

  const move = (
    record: DeploymentRead,
    to: DeploymentStatus,
    healthEvidenceId?: string,
  ) =>
    ledger.advance(record.id, {
      from: record.status,
      to,
      expectedVersion: record.version,
      ...(healthEvidenceId === undefined ? {} : { healthEvidenceId }),
    });

  const done = (
    deployment: DeploymentRead,
    effectKey: string | null = null,
  ) => ({
    deployment,
    effectKey,
  });

  /** A release that replaced another is rolled back; one that replaced nothing has nothing to restore. */
  async function rollBackIfPossible(
    record: DeploymentRead,
    reason: string,
  ): Promise<DriveOutcome> {
    if (record.previousDeploymentId === null) return done(record);
    const rolling = await ledger.startRollback(record.id, reason);
    return await rollback(rolling.id);
  }

  async function verify(record: DeploymentRead): Promise<DriveOutcome> {
    let health: HealthResult;
    try {
      health = await adapter.health({ deploymentId: await adapterId(record) });
    } catch {
      // A health check that cannot be read says nothing: unknown, read back.
      return done(await move(record, "unknown"), deployEffectKey(record.id));
    }
    const settled = await move(
      record,
      health.status,
      health.evidenceArtifactId,
    );
    if (health.status === "healthy") return done(settled);
    return await rollBackIfPossible(settled, `health_${health.status}`);
  }

  // The adapter names its own deployment; Bakery reads it back by effect key.
  async function adapterId(record: DeploymentRead): Promise<string> {
    const observed = await adapter.status({
      effectKey: deployEffectKey(record.id),
    });
    if (observed.deploymentId === null) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "deployment_not_known_to_target" },
      });
    }
    return observed.deploymentId;
  }

  async function deploy(
    deploymentId: string,
    input: Readonly<{ profileRevision: number }>,
  ): Promise<DriveOutcome> {
    let record = await ledger.read(deploymentId);
    // Already driven: nothing to start. An unknown one is settled, not redone.
    if (record.status !== "queued") return done(record);
    // The store keeps the digest as text; a malformed one is no artifact to verify.
    if (!isSha256Digest(record.artifactDigest)) {
      return done(await move(record, "failed"));
    }
    const artifactDigest = record.artifactDigest;

    let prepared;
    try {
      prepared = await adapter.prepare({
        repositoryId: record.repositoryId,
        headSha: record.commitSha,
        profileRevision: input.profileRevision,
        expectedDigest: artifactDigest,
      });
    } catch {
      // Preparing changes nothing in the environment: a failed prepare is final.
      return done(await move(record, "failed"));
    }
    if (prepared.artifactDigest !== artifactDigest) {
      return done(await move(record, "failed"));
    }

    const key = deployEffectKey(record.id);
    let accepted;
    try {
      accepted = await adapter.deploy({
        releaseId: prepared.releaseId,
        effectKey: key,
      });
    } catch (error) {
      return error instanceof ReleaseRefused
        ? done(await move(record, "failed"))
        : done(await move(record, "unknown"), key);
    }
    if (accepted.status === "failed") return done(await move(record, "failed"));
    if (accepted.status === "unknown") {
      return done(await move(record, "unknown"), key);
    }

    record = await move(record, "deploying");
    if (accepted.commitSha !== record.commitSha) {
      // The target deployed something else: the environment changed, so it ends
      // failed and the previous release is restored.
      return await rollBackIfPossible(
        await move(record, "failed"),
        "target_deployed_another_commit",
      );
    }
    record = await move(record, "verifying");
    return await verify(record);
  }

  async function rollback(deploymentId: string): Promise<DriveOutcome> {
    const record = await ledger.read(deploymentId);
    if (record.status !== "rolling_back") return done(record);
    const key = rollbackEffectKey(record.id, record.version);
    let result;
    try {
      result = await adapter.rollback({
        deploymentId: await adapterId(record),
        effectKey: key,
      });
    } catch (error) {
      return error instanceof ReleaseRefused
        ? done(await move(record, "failed"))
        : done(await move(record, "unknown"), key);
    }
    switch (result.status) {
      case "rolled_back":
        return done(await move(record, "rolled_back"));
      case "failed":
        return done(await move(record, "failed"));
      case "unknown":
        return done(await move(record, "unknown"), key);
      case "rolling_back":
        return done(record, key);
    }
  }

  async function settle(
    deploymentId: string,
    effectKey: string,
  ): Promise<DriveOutcome> {
    const record = await ledger.read(deploymentId);
    if (record.status !== "unknown") return done(record);
    const observed = await adapter.status({ effectKey });
    if (observed.status === "unknown") return done(record, effectKey);
    const isRollback = effectKey.startsWith("rollback:");
    if (isRollback) {
      switch (observed.status) {
        case "rolled_back":
          return done(await move(record, "rolled_back"));
        case "rolling_back":
          return done(await move(record, "rolling_back"), effectKey);
        default:
          // Nothing proves the previous release serves: the rollback failed.
          return done(await move(record, "failed"));
      }
    }
    switch (observed.status) {
      case "queued":
      case "deploying": {
        const deploying = await move(record, "deploying");
        return await verify(await move(deploying, "verifying"));
      }
      case "healthy":
      case "degraded":
        return await verify(await move(record, "verifying"));
      case "rolling_back":
      case "rolled_back":
        return done(await move(record, observed.status));
      case "failed": {
        const failed = await move(record, "failed");
        // Failed with the environment on this release: restore the one before.
        return observed.observedCommitSha === record.commitSha
          ? await rollBackIfPossible(failed, "settled_failed")
          : done(failed);
      }
    }
    return done(record, effectKey);
  }

  return { deploy, rollback, settle };
}
