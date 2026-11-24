import { StandardError } from "@bakery/contracts/http";
import type { DeploymentRead } from "./deployments.ts";
import type { DeploymentStatus } from "./deployment-states.ts";
import {
  deployEffectKey,
  type DeployReleaseResult,
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
 *
 * Effect keys come from a `scope`: the deployment id by default, or the key of
 * the workflow step that drives it, so one key follows the step from the plan to
 * the target and a replayed step reads its own effects back.
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
      /** A rollback ended in failure by a path the ledger cannot see from the status. */
      rollbackFailed?: boolean;
    }>,
  ): Promise<DeploymentRead>;
  /** Moves a release that served or failed to serve into rolling_back. */
  startRollback(deploymentId: string, reason: string): Promise<DeploymentRead>;
}>;

/** The record after the call, and the effect key to read back when it is unknown or still rolling back. */
export type DriveOutcome = Readonly<{
  deployment: DeploymentRead;
  effectKey: string | null;
  /** What the target accepted, when this call deployed. */
  accepted?: DeployReleaseResult;
  /** What the health check observed, when this call checked health. */
  health?: HealthResult;
}>;

/** Names the effect keys of a call. Default: the deployment's own id. */
export type DriveScope = Readonly<{ scope?: string }>;

/** Where settling an unknown deploy stops: `deploying` leaves health to its own step. */
export type SettleOptions = DriveScope & Readonly<{ stopAt?: "deploying" }>;

export type DeploymentDriver = Readonly<{
  /** Prepares, deploys and verifies a queued deployment. */
  deploy(
    deploymentId: string,
    input: Readonly<{ profileRevision: number }> & DriveScope,
  ): Promise<DriveOutcome>;
  /** Makes a prepared release live and stops there; health is a later call. */
  startDeploy(
    deploymentId: string,
    input: Readonly<{ releaseId: string }> & DriveScope,
  ): Promise<DriveOutcome>;
  /** Reads the health of a deploying release and closes the record by it. */
  checkHealth(deploymentId: string, input?: DriveScope): Promise<DriveOutcome>;
  /** Restores the previous release of a deployment that is rolling back. */
  rollback(deploymentId: string, input?: DriveScope): Promise<DriveOutcome>;
  /** Reads the effect of an unknown deployment back and moves it to what the read says. */
  settle(
    deploymentId: string,
    effectKey: string,
    input?: SettleOptions,
  ): Promise<DriveOutcome>;
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

  /** A rollback that settles to failed, whichever path it took, is a failed going-back. */
  const rollbackFailed = (record: DeploymentRead) =>
    ledger.advance(record.id, {
      from: record.status,
      to: "failed",
      expectedVersion: record.version,
      rollbackFailed: true,
    });

  const done = (
    deployment: DeploymentRead,
    effectKey: string | null = null,
    extra: Readonly<{ accepted?: DeployReleaseResult; health?: HealthResult }> =
      {},
  ): DriveOutcome => ({ deployment, effectKey, ...extra });

  const scopeOf = (record: DeploymentRead, input?: DriveScope) =>
    input?.scope ?? record.id;

  // The adapter names its own deployment; Bakery reads it back by effect key.
  async function adapterId(key: string): Promise<string> {
    const observed = await adapter.status({ effectKey: key });
    if (observed.deploymentId === null) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "deployment_not_known_to_target" },
      });
    }
    return observed.deploymentId;
  }

  /** A release that replaced another is rolled back; one that replaced nothing has nothing to restore. */
  async function rollBackIfPossible(
    record: DeploymentRead,
    reason: string,
    scope: string,
  ): Promise<DriveOutcome> {
    if (record.previousDeploymentId === null) return done(record);
    const rolling = await ledger.startRollback(record.id, reason);
    return await rollback(rolling.id, { scope });
  }

  async function verify(
    record: DeploymentRead,
    scope: string,
  ): Promise<DriveOutcome> {
    let health: HealthResult;
    try {
      health = await adapter.health({
        deploymentId: await adapterId(deployEffectKey(scope)),
      });
    } catch {
      // A health check that cannot be read says nothing: unknown, read back.
      return done(await move(record, "unknown"), deployEffectKey(scope));
    }
    const settled = await move(
      record,
      health.status,
      health.evidenceArtifactId,
    );
    if (health.status === "healthy") return done(settled, null, { health });
    const after = await rollBackIfPossible(
      settled,
      `health_${health.status}`,
      scope,
    );
    return { ...after, health };
  }

  async function deploy(
    deploymentId: string,
    input: Readonly<{ profileRevision: number }> & DriveScope,
  ): Promise<DriveOutcome> {
    const record = await ledger.read(deploymentId);
    // Already driven: nothing to start. An unknown one is settled, not redone.
    if (record.status !== "queued") return done(record);
    // The store keeps the digest as text; a malformed one is no artifact to verify.
    if (!isSha256Digest(record.artifactDigest)) {
      return done(await move(record, "failed"));
    }
    const artifactDigest = record.artifactDigest;
    const scope = scopeOf(record, input);

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
    const started = await startDeploy(deploymentId, {
      releaseId: prepared.releaseId,
      scope,
    });
    if (started.deployment.status !== "deploying") return started;
    return await checkHealth(deploymentId, { scope });
  }

  async function startDeploy(
    deploymentId: string,
    input: Readonly<{ releaseId: string }> & DriveScope,
  ): Promise<DriveOutcome> {
    const record = await ledger.read(deploymentId);
    if (record.status !== "queued") return done(record);
    const key = deployEffectKey(scopeOf(record, input));
    let accepted: DeployReleaseResult;
    try {
      accepted = await adapter.deploy({
        releaseId: input.releaseId,
        effectKey: key,
      });
    } catch (error) {
      return error instanceof ReleaseRefused
        ? done(await move(record, "failed"))
        : done(await move(record, "unknown"), key);
    }
    if (accepted.status === "failed") {
      return done(await move(record, "failed"), null, { accepted });
    }
    if (accepted.status === "unknown") {
      return done(await move(record, "unknown"), key, { accepted });
    }
    const deploying = await move(record, "deploying");
    if (accepted.commitSha !== record.commitSha) {
      // The target deployed something else: the environment changed, so it ends
      // failed and the previous release is restored.
      return await rollBackIfPossible(
        await move(deploying, "failed"),
        "target_deployed_another_commit",
        scopeOf(record, input),
      );
    }
    return done(deploying, null, { accepted });
  }

  async function checkHealth(
    deploymentId: string,
    input?: DriveScope,
  ): Promise<DriveOutcome> {
    const record = await ledger.read(deploymentId);
    const scope = scopeOf(record, input);
    if (record.status === "deploying") {
      return await verify(await move(record, "verifying"), scope);
    }
    if (record.status === "verifying") return await verify(record, scope);
    return done(record);
  }

  async function rollback(
    deploymentId: string,
    input?: DriveScope,
  ): Promise<DriveOutcome> {
    const record = await ledger.read(deploymentId);
    if (record.status !== "rolling_back") return done(record);
    const scope = scopeOf(record, input);
    const key = rollbackEffectKey(scope, record.version);
    let result;
    try {
      result = await adapter.rollback({
        deploymentId: await adapterId(deployEffectKey(scope)),
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
    input?: SettleOptions,
  ): Promise<DriveOutcome> {
    const record = await ledger.read(deploymentId);
    if (record.status !== "unknown") return done(record);
    const scope = scopeOf(record, input);
    const observed = await adapter.status({ effectKey });
    if (observed.status === "unknown") return done(record, effectKey);
    if (effectKey.startsWith("rollback:")) {
      switch (observed.status) {
        case "rolled_back":
          return done(await move(record, "rolled_back"));
        case "rolling_back":
          return done(await move(record, "rolling_back"), effectKey);
        default:
          // Nothing proves the previous release serves: the rollback failed.
          // The record is `unknown` here, so the ledger cannot tell it was a
          // rollback; the effect key does.
          return done(await rollbackFailed(record));
      }
    }
    switch (observed.status) {
      case "queued":
      case "deploying": {
        const deploying = await move(record, "deploying");
        if (input?.stopAt === "deploying") return done(deploying);
        return await verify(await move(deploying, "verifying"), scope);
      }
      case "healthy":
      case "degraded":
        // A deploy step settling is not the health step: it stops at deploying.
        if (input?.stopAt === "deploying") {
          return done(await move(record, "deploying"));
        }
        return await verify(await move(record, "verifying"), scope);
      case "rolling_back":
      case "rolled_back":
        return done(await move(record, observed.status));
      case "failed": {
        const failed = await move(record, "failed");
        // Failed with the environment on this release: restore the one before.
        return observed.observedCommitSha === record.commitSha
          ? await rollBackIfPossible(failed, "settled_failed", scope)
          : done(failed);
      }
    }
    return done(record, effectKey);
  }

  return { deploy, startDeploy, checkHealth, rollback, settle };
}
