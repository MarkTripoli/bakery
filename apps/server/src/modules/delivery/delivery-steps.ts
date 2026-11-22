import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import {
  createDeploymentDriver,
  type DeploymentDriver,
  type DriveOutcome,
} from "./deployment-driver.ts";
import {
  createDeployment,
  type DeploymentRead,
  readDeployment,
} from "./deployments.ts";
import {
  DEPLOYMENT_ENVIRONMENTS,
  type DeploymentEnvironment,
} from "./deployment-states.ts";
import type { HealthEvidence } from "./local-release-target.ts";
import type {
  EngineStepRequest,
  EngineStepResult,
  EngineStepRunner,
} from "../workflow-adapter/engine-steps.ts";
import { createPostgresDeploymentLedger } from "./postgres-deployment-ledger.ts";
import {
  deployEffectKey,
  type ReleaseAdapter,
  ReleaseRefused,
} from "./release-adapter.ts";

/**
 * Delivery steps of a workflow plan (#43, B10.06): `delivery.prepare`,
 * `delivery.deploy` and `delivery.health`, settled by the engine itself like a
 * projection or a stop, with no worker job (docs/technical-design/25-one-engine.md,
 * "One engine": a step kind is an action over the one run row, not a new node
 * type). The release directory of a local target lives on the server host, so a
 * worker could not reach it.
 *
 * The plan's own `effectKey` input is validated and kept in the step's record, but
 * the key the target sees is the step's identity, which is stricter: two deploy
 * steps (or two iterations of one) that an author gave the same key still get
 * their own effects.
 *
 * One effect key runs end to end: the step key `<runId>:<stepKey>:<iteration>`
 * is the scope of the deployment record's request, of the effect key the target
 * journals (`deploy:<scope>`) and of any rollback key. A replayed or resumed
 * step finds its own record by that key and reads the target back; nothing is
 * deployed twice. The driver call runs outside any database transaction: the
 * caller (the engine's admission) commits the step in its own short one.
 */

/** The output schemas are registered by name for the engine; the typed map lists inputs only. */
function outputSchema(name: "PrepareOutput" | "DeployOutput" | "HealthOutput") {
  const schema = (contractSchemas as unknown as Record<
    string,
    { parse(value: unknown): unknown } | undefined
  >)[name];
  if (!schema) {
    throw new Error(`delivery output schema does not resolve: ${name}`);
  }
  return schema;
}

export const DELIVERY_STEP_ACTIONS = [
  "delivery.prepare",
  "delivery.deploy",
  "delivery.health",
] as const;
export type DeliveryStepAction = (typeof DELIVERY_STEP_ACTIONS)[number];

export function isDeliveryStepAction(
  action: string,
): action is DeliveryStepAction {
  return (DELIVERY_STEP_ACTIONS as readonly string[]).includes(action);
}

/** What the engine hands a delivery step; the action is one of ours. */
export type DeliveryStepRequest =
  & EngineStepRequest
  & Readonly<{
    action: DeliveryStepAction;
  }>;

export type DeliveryStepResult = EngineStepResult;

/** The engine's port, owned here for the three delivery actions. */
export type DeliveryStepRunner = EngineStepRunner;

/** Where releases go: the target of a repository, and of an environment when the step names one. */
export type DeliveryTargets = Readonly<{
  resolve(
    input: Readonly<{
      organizationId: string;
      repositoryId: string;
      environment?: string;
      /** Keeps one health observation as an artifact version and returns its id. */
      saveEvidence: (evidence: HealthEvidence) => Promise<string>;
    }>,
  ): ReleaseAdapter | null;
}>;

const stepScope = (request: DeliveryStepRequest) =>
  `${request.runId}:${request.stepKey}:${request.iteration}`;
const requestIdOf = (scope: string) => `step:${scope}`;

const failed = (code: string, message: string): DeliveryStepResult => ({
  kind: "failed",
  code,
  message,
});
const pending: DeliveryStepResult = { kind: "pending" };

function isEnvironment(value: string): value is DeploymentEnvironment {
  return (DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(value);
}

type PrepareFacts = Readonly<{
  headSha: string;
  artifactDigest: string;
  environment: string;
}>;

/** The completed prepare step of this run that produced the release, with what it was asked to build. */
async function prepareFacts(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
  releaseId: string,
): Promise<PrepareFacts | null> {
  const found = await transaction.query<{
    head_sha: string | null;
    artifact_digest: string | null;
    environment: string | null;
  }>(
    `select dispatch #>> '{input,headSha}' as head_sha,
            output ->> 'artifactDigest' as artifact_digest,
            output ->> 'environment' as environment
       from bakery.run_steps
      where organization_id = $1 and run_id = $2 and status = 'completed'
        and dispatch ->> 'action' = 'delivery.prepare'
        and output ->> 'releaseId' = $3
      order by finished_at desc
      limit 1`,
    [organizationId, runId, releaseId],
  );
  const row = found.rows[0];
  if (!row || !row.head_sha || !row.artifact_digest || !row.environment) {
    return null;
  }
  return {
    headSha: row.head_sha,
    artifactDigest: row.artifact_digest,
    environment: row.environment,
  };
}

async function evidenceRef(
  transaction: PgTransactionClient,
  organizationId: string,
  versionId: string,
): Promise<{ artifactId: string; versionId: string; sha256: string } | null> {
  const found = await transaction.query<
    { artifact_id: string; sha256: string; content: Uint8Array | null }
  >(
    `select artifact_id, sha256, content from bakery.artifact_versions
      where organization_id = $1 and id = $2`,
    [organizationId, versionId],
  );
  const row = found.rows[0];
  return row
    ? { artifactId: row.artifact_id, versionId, sha256: row.sha256 }
    : null;
}

/** When the evidence of a deployment says it was observed; falls back to the record's last update. */
async function observedAt(
  transaction: PgTransactionClient,
  organizationId: string,
  record: DeploymentRead,
): Promise<string> {
  if (record.healthEvidenceId === null) return record.updatedAt;
  const found = await transaction.query<{ content: Uint8Array | null }>(
    `select content from bakery.artifact_versions
      where organization_id = $1 and id = $2`,
    [organizationId, record.healthEvidenceId],
  );
  const content = found.rows[0]?.content;
  if (content) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(content)) as {
        checkedAt?: unknown;
      };
      if (typeof parsed.checkedAt === "string") return parsed.checkedAt;
    } catch {
      // Evidence that is not JSON still counts; the record's time stands.
    }
  }
  return record.updatedAt;
}

export function createDeliveryStepRunner(
  deps: Readonly<{
    database: PgDatabase;
    targets: DeliveryTargets;
    now?: () => Date;
  }>,
): DeliveryStepRunner {
  const { database } = deps;

  /** Health evidence is a real artifact version of the run's task: the deployment row points at it. */
  const evidenceSaver =
    (request: DeliveryStepRequest) =>
    async (evidence: HealthEvidence): Promise<string> =>
      await withPgTransaction(database, async (transaction) => {
        const artifactId = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        const bytes = new TextEncoder().encode(JSON.stringify(evidence));
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        await transaction.query(
          `insert into bakery.artifacts (id,organization_id,task_id,artifact_type,name)
         values ($1,$2,$3,'document',$4)`,
          [
            artifactId,
            request.organizationId,
            request.taskId,
            `deploy-health-${artifactId}`,
          ],
        );
        await transaction.query(
          `insert into bakery.artifact_versions (
           id,organization_id,artifact_id,task_id,author_id,revision,content,
           sha256,size_bytes,media_type,retention_class
         ) values ($1,$2,$3,$4,$5,1,$6,$7,$8,'application/json','evidence')`,
          [
            versionId,
            request.organizationId,
            artifactId,
            request.taskId,
            request.requestedBy,
            bytes,
            digest,
            bytes.length,
          ],
        );
        await transaction.query(
          `update bakery.artifacts set current_version_id = $3
          where organization_id = $1 and id = $2`,
          [request.organizationId, artifactId, versionId],
        );
        return versionId;
      });

  const driverFor = (
    request: DeliveryStepRequest,
    adapter: ReleaseAdapter,
  ): DeploymentDriver =>
    createDeploymentDriver({
      adapter,
      ledger: createPostgresDeploymentLedger({
        database,
        organizationId: request.organizationId,
        principalId: request.requestedBy,
        requestId: requestIdOf(stepScope(request)),
        traceId: request.traceId,
      }),
    });

  function adapterFor(
    request: DeliveryStepRequest,
    environment?: string,
  ): ReleaseAdapter | null {
    if (request.repositoryId === null) return null;
    return deps.targets.resolve({
      organizationId: request.organizationId,
      repositoryId: request.repositoryId,
      ...(environment === undefined ? {} : { environment }),
      saveEvidence: evidenceSaver(request),
    });
  }

  async function runPrepare(
    request: DeliveryStepRequest,
  ): Promise<DeliveryStepResult> {
    const parsed = contractSchemas.PrepareInput.safeParse(request.input);
    if (!parsed.success) {
      return failed(
        "DELIVERY_STEP_INPUT_INVALID",
        "The prepare input is not the shape of its action.",
      );
    }
    const input = parsed.data as {
      repositoryId: string;
      headSha: string;
      profileRevision: number;
    };
    if (input.repositoryId !== request.repositoryId) {
      return failed(
        "DELIVERY_REPOSITORY_MISMATCH",
        "The step names a repository other than the run's.",
      );
    }
    const adapter = adapterFor(request);
    if (adapter === null) {
      return failed(
        "DELIVERY_TARGET_UNAVAILABLE",
        "No deployment target is configured for this repository.",
      );
    }
    try {
      const prepared = await adapter.prepare({
        repositoryId: input.repositoryId,
        headSha: input.headSha,
        profileRevision: input.profileRevision,
      });
      return {
        kind: "completed",
        output: outputSchema("PrepareOutput").parse(prepared),
      };
    } catch (error) {
      // Preparing changes nothing in any environment: a failure is final.
      return failed(
        error instanceof ReleaseRefused
          ? `DELIVERY_PREPARE_${error.refusal.toUpperCase()}`
          : "DELIVERY_PREPARE_FAILED",
        "The target could not prepare the release.",
      );
    }
  }

  async function deployOutput(
    adapter: ReleaseAdapter,
    scope: string,
    record: DeploymentRead,
    statusOf: string | undefined,
  ): Promise<DeliveryStepResult> {
    const observed = await adapter.status({
      effectKey: deployEffectKey(scope),
    });
    if (observed.effectId === null) {
      return failed(
        "DELIVERY_DEPLOY_NOT_KNOWN",
        "The target has no record of this deploy.",
      );
    }
    const status = statusOf === "queued" || statusOf === "deploying"
      ? statusOf
      : "deploying";
    return {
      kind: "completed",
      output: outputSchema("DeployOutput").parse({
        deploymentId: record.id,
        commitSha: record.commitSha,
        status,
        providerEffectId: observed.effectId,
      }),
    };
  }

  async function runDeploy(
    request: DeliveryStepRequest,
  ): Promise<DeliveryStepResult> {
    const parsed = contractSchemas.DeployInput.safeParse(request.input);
    if (!parsed.success) {
      return failed(
        "DELIVERY_STEP_INPUT_INVALID",
        "The deploy input is not the shape of its action.",
      );
    }
    const input = parsed.data as { releaseId: string; environment: string };
    if (!isEnvironment(input.environment)) {
      return failed(
        "DELIVERY_ENVIRONMENT_UNKNOWN",
        "The environment is not one Bakery deploys to.",
      );
    }
    const environment = input.environment;
    const repositoryId = request.repositoryId;
    const adapter = adapterFor(request, environment);
    if (adapter === null || repositoryId === null) {
      return failed(
        "DELIVERY_TARGET_UNAVAILABLE",
        "No deployment target is configured for this environment.",
      );
    }
    const scope = stepScope(request);
    const requestId = requestIdOf(scope);
    const driver = driverFor(request, adapter);

    // The record this step owns, found by its request key; created once.
    let record = await withPgTransaction(database, async (transaction) => {
      const existing = await transaction.query<{ id: string }>(
        `select id from bakery.deployments
          where organization_id = $1 and request_id = $2`,
        [request.organizationId, requestId],
      );
      return existing.rows[0]
        ? await readDeployment(
          transaction,
          request.organizationId,
          existing.rows[0].id,
        )
        : null;
    });
    if (record === null) {
      const facts = await withPgTransaction(
        database,
        (transaction) =>
          prepareFacts(
            transaction,
            request.organizationId,
            request.runId,
            input.releaseId,
          ),
      );
      if (facts === null) {
        return failed(
          "DELIVERY_RELEASE_UNKNOWN",
          "No prepare step of this run produced that release.",
        );
      }
      if (facts.environment !== environment) {
        return failed(
          "DELIVERY_ENVIRONMENT_MISMATCH",
          "The release was prepared for another environment.",
        );
      }
      try {
        record = await withPgTransaction(
          database,
          (transaction) =>
            createDeployment(
              transaction,
              request.organizationId,
              request.requestedBy,
              {
                requestId,
                traceId: request.traceId,
                create: {
                  repositoryId,
                  runId: request.runId,
                  environment,
                  commitSha: facts.headSha,
                  artifactDigest: facts.artifactDigest,
                },
              },
            ),
        );
      } catch (error) {
        if (error instanceof StandardError) {
          const reason = (error.params as { reason?: string } | undefined)
            ?.reason;
          // Another deployment is in flight or its outcome is unknown: wait, never overlap.
          if (
            reason === "deployment_in_progress" || reason === "outcome_unknown"
          ) {
            return pending;
          }
          return failed("DELIVERY_DEPLOY_REFUSED", reason ?? error.code);
        }
        throw error;
      }
    }

    let outcome: DriveOutcome | null = null;
    switch (record.status) {
      case "queued":
        outcome = await driver.startDeploy(record.id, {
          releaseId: input.releaseId,
          scope,
        });
        break;
      case "unknown":
        outcome = await driver.settle(record.id, deployEffectKey(scope), {
          scope,
          stopAt: "deploying",
        });
        break;
      default:
        break;
    }
    const current = outcome?.deployment ?? record;
    switch (current.status) {
      case "unknown":
      case "rolling_back":
        return pending;
      case "failed":
      case "rolled_back":
        return failed(
          "DELIVERY_DEPLOY_FAILED",
          "The target did not make the release live.",
        );
      default:
        return await deployOutput(
          adapter,
          scope,
          current,
          outcome?.accepted?.status,
        );
    }
  }

  async function runHealth(
    request: DeliveryStepRequest,
  ): Promise<DeliveryStepResult> {
    const parsed = contractSchemas.HealthInput.safeParse(request.input);
    if (!parsed.success) {
      return failed(
        "DELIVERY_STEP_INPUT_INVALID",
        "The health input is not the shape of its action.",
      );
    }
    const { deploymentId } = parsed.data as { deploymentId: string };
    const found = await withPgTransaction(database, async (transaction) => {
      try {
        const record = await readDeployment(
          transaction,
          request.organizationId,
          deploymentId,
        );
        const key = await transaction.query<{ request_id: string }>(
          `select request_id from bakery.deployments
            where organization_id = $1 and id = $2`,
          [request.organizationId, deploymentId],
        );
        return { record, requestKey: key.rows[0]?.request_id ?? "" };
      } catch (error) {
        if (error instanceof StandardError) return null;
        throw error;
      }
    });
    if (found === null || found.record.runId !== request.runId) {
      return failed(
        "DELIVERY_DEPLOYMENT_UNKNOWN",
        "No deployment of this run has that id.",
      );
    }
    const { record, requestKey } = found;
    // The deploy step's own scope: the target knows the effect by that key.
    const scope = requestKey.startsWith("step:")
      ? requestKey.slice(5)
      : record.id;
    const adapter = adapterFor(request, record.environment);
    if (adapter === null) {
      return failed(
        "DELIVERY_TARGET_UNAVAILABLE",
        "No deployment target is configured for this environment.",
      );
    }
    const driver = driverFor(request, adapter);

    let outcome: DriveOutcome | null = null;
    switch (record.status) {
      case "queued":
        return failed(
          "DELIVERY_DEPLOY_NOT_STARTED",
          "The deployment has not been made live.",
        );
      case "deploying":
      case "verifying":
        outcome = await driver.checkHealth(record.id, { scope });
        break;
      case "unknown":
        outcome = await driver.settle(record.id, deployEffectKey(scope), {
          scope,
        });
        break;
      default:
        break;
    }
    const current = outcome?.deployment ?? record;
    switch (current.status) {
      case "unknown":
      case "rolling_back":
      case "deploying":
      case "verifying":
        return pending;
      default:
        break;
    }
    const status = current.status === "healthy"
      ? "healthy"
      : current.status === "degraded"
      ? "degraded"
      : "failed";
    return await withPgTransaction(database, async (transaction) => {
      if (current.healthEvidenceId === null) {
        return failed(
          "DELIVERY_NO_EVIDENCE",
          "The deployment closed without health evidence.",
        );
      }
      const ref = await evidenceRef(
        transaction,
        request.organizationId,
        current.healthEvidenceId,
      );
      if (ref === null) {
        return failed("DELIVERY_NO_EVIDENCE", "The health evidence is gone.");
      }
      return {
        kind: "completed" as const,
        output: outputSchema("HealthOutput").parse({
          deploymentId: current.id,
          status,
          checkedAt: outcome?.health?.checkedAt ??
            await observedAt(transaction, request.organizationId, current),
          evidenceArtifact: ref,
        }),
      };
    });
  }

  return {
    handles: isDeliveryStepAction,
    run(request) {
      if (!isDeliveryStepAction(request.action)) {
        return Promise.resolve(
          failed(
            "DELIVERY_ACTION_UNKNOWN",
            "This runner does not own that action.",
          ),
        );
      }
      const owned: DeliveryStepRequest = { ...request, action: request.action };
      switch (owned.action) {
        case "delivery.prepare":
          return runPrepare(owned);
        case "delivery.deploy":
          return runDeploy(owned);
        case "delivery.health":
          return runHealth(owned);
      }
    },
  };
}
