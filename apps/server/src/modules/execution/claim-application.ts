import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import { workerActionOutputCarriesSession } from "@bakery/contracts/contracts";
import { DEFAULT_LEASE_SECONDS } from "@bakery/persistence";
import { canonicalExecutionInputDigest } from "@bakery/persistence/repository-admission";
import type { SealedCredentialOperation } from "@bakery/contracts/secret-identity";
import type {
  ClaimableJob,
  ClaimIdentity,
  ClaimsRepository,
} from "@bakery/persistence/claims";
import {
  assertCurrentWorkerSession,
  assertJobIntegrity,
  assertPositiveInteger,
  assertWorkerMutationSessionShape,
  assertWorkerSessionPair,
  type Assignment,
  asStringArray,
  claimRequestDigest,
  contractSchemas,
  iso,
  isSubset,
  jsonValue,
  normalizeCapabilities,
  normalizeSupportedActions,
  parseIdempotencyKey,
  protect,
  randomSecret,
  type RequestMetadata,
  sessionGeneration,
  unprotect,
} from "./shared.ts";

export type ClaimInput = z.output<typeof contractSchemas.WorkerClaim>;

export type ClaimResult =
  | { status: 204; replayed: boolean }
  | { status: 200; response: Assignment; replayed: boolean };

export type ClaimUnitOfWorkContext = {
  readonly identity: ClaimIdentity;
  readonly persistence: ClaimsRepository;
};

export type ClaimUnitOfWork = {
  run<T>(
    headers: Headers,
    workerHostId: string,
    work: (context: ClaimUnitOfWorkContext) => Promise<T>,
  ): Promise<T>;
};

export type ClaimApplicationOptions = {
  readonly secret: string;
  readonly headers: Headers;
  readonly input: ClaimInput;
  readonly unitOfWork: ClaimUnitOfWork;
};

function requestMetadata(headers: Headers): RequestMetadata {
  const requestId = headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const traceId = headers.get("x-trace-id")?.trim() || requestId;
  return { requestId, traceId };
}

function assignmentFromJob(
  job: ClaimableJob,
  attemptId: string,
  hostId: string,
  workerSessionId: string | null,
  workerSessionGeneration: string | number,
  leaseToken: string,
  fence: bigint,
  leaseExpiresAt: Date | string,
  leaseDurationSeconds: number,
  serverTime: Date | string,
  sealedCredentialOperation: SealedCredentialOperation | null,
): Assignment {
  const assignment = {
    jobId: job.id,
    attemptId,
    workerHostId: hostId,
    leaseToken,
    fence: fence.toString(),
    leaseExpiresAt: iso(leaseExpiresAt),
    action: job.action,
    requirements: jsonValue(job.requirements, {}),
    input: jsonValue(job.input, {}),
    currentCheckpoints: jsonValue(job.currentCheckpoints, []),
    agentConfig: jsonValue(job.agentConfig, {}),
    skillRefs: jsonValue(job.skillRefs, []),
    agentVersionId: job.agentVersionId,
    billing: jsonValue(job.billing, null),
    installationReservationId: job.installationReservationId,
    workerSessionId,
    workerSessionGeneration: sessionGeneration(
      workerSessionGeneration,
      1n,
    ).toString(),
    leaseDurationSeconds,
    serverTime: iso(serverTime),
    sealedCredentialOperation,
    // Only actions whose result names a session receive the server-created one.
    ...(job.agentSessionId === null ||
        !workerActionOutputCarriesSession(job.action)
      ? {}
      : { agentSessionId: job.agentSessionId }),
  };
  const parsed = contractSchemas.JobAssignment.safeParse(assignment);
  if (!parsed.success) {
    throw new StandardError({ code: "VALIDATION_FAILED", cause: parsed.error });
  }
  return parsed.data as Assignment;
}

export async function executeClaim(
  options: ClaimApplicationOptions,
): Promise<ClaimResult> {
  const { input } = options;
  const idempotencyKey = parseIdempotencyKey(
    options.headers.get("Idempotency-Key"),
  );
  if (idempotencyKey !== input.claimKey) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const digest = await claimRequestDigest(input);
  const metadata = requestMetadata(options.headers);
  const requestedCapabilities = normalizeCapabilities(input.capabilities);
  const supportedActions = normalizeSupportedActions(input.supportedActions);
  assertWorkerSessionPair(
    input.workerSessionId,
    input.workerSessionGeneration,
  );

  return await options.unitOfWork.run(
    options.headers,
    input.workerHostId,
    async ({ identity, persistence }) => {
      await persistence.acquireClaimLock(
        identity.host.id,
        input.claimKey,
      );
      assertWorkerMutationSessionShape(
        identity.host,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      const replay = await persistence.loadReplay(
        identity.host.id,
        input.claimKey,
      );
      if (replay) {
        if (replay.requestDigest !== digest) {
          throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        }
        if (replay.responseStatus === 204) {
          if (
            replay.responseCiphertext !== null ||
            replay.attemptId !== null
          ) {
            throw new Error("WORKER_CLAIM_REPLAY_INVALID");
          }
          if (input.workerSessionId !== undefined) {
            assertCurrentWorkerSession(
              identity.host,
              input.workerSessionId,
              input.workerSessionGeneration,
            );
          }
          await persistence.rebindLiveAttempt(replay.attemptId);
          return { status: 204 as const, replayed: true };
        }
        if (replay.responseStatus === 200) {
          if (
            replay.responseCiphertext === null ||
            replay.attemptId === null
          ) {
            throw new Error("WORKER_CLAIM_REPLAY_INVALID");
          }
          if (input.workerSessionId !== undefined) {
            assertCurrentWorkerSession(
              identity.host,
              input.workerSessionId,
              input.workerSessionGeneration,
            );
          }
          await persistence.rebindLiveAttempt(replay.attemptId);
          await persistence.rebindPreparedIdentityOperation(replay.attemptId);
          const response = contractSchemas.JobAssignment.parse(
            await unprotect(options.secret, replay.responseCiphertext),
          ) as Assignment;
          return { status: 200 as const, response, replayed: true };
        }
        throw new Error("WORKER_CLAIM_REPLAY_INVALID");
      }

      const hostCapabilities = asStringArray(identity.host.capabilities).map((
        entry,
      ) => entry.toLowerCase());
      if (!isSubset(requestedCapabilities, hostCapabilities)) {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
      assertCurrentWorkerSession(
        identity.host,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      const activeAttempts = await persistence.reclaimAndCountCapacity(
        {
          organizationId: identity.host.organizationId,
          workerHostId: identity.host.id,
          principalId: identity.host.principalId,
          metadata,
        },
      );
      const saveNoAssignmentReplay = async () => {
        await persistence.saveNoAssignmentReplay({
          organizationId: identity.host.organizationId,
          workerHostId: identity.host.id,
          claimKey: input.claimKey,
          requestDigest: digest,
        });
        return { status: 204 as const, replayed: false };
      };
      if (activeAttempts >= BigInt(identity.host.slots)) {
        return await saveNoAssignmentReplay();
      }
      // One dispatch decision shared with the dispatch-blockers projection:
      // host status, desired mode, heartbeat connectivity and fresh failed
      // checks all come from dispatchGate. Old or expired check generations
      // are ignored by the shared freshness rule.
      const gate = await persistence.readinessGate();
      if (
        gate.allBlocked ||
        requestedCapabilities.some((capability) =>
          gate.blockedCapabilities.includes(capability)
        )
      ) {
        return await saveNoAssignmentReplay();
      }
      const job = await persistence.findClaimableJob({
        organizationId: identity.host.organizationId,
        requestedCapabilities,
        supportedActions,
        metadata,
        principalId: identity.host.principalId,
      });
      if (!job) {
        return await saveNoAssignmentReplay();
      }
      const currentFence = assertJobIntegrity(job);
      const fence = currentFence + 1n;
      const attemptNo = await persistence.nextAttemptNumber(
        job.id,
      );
      if (attemptNo === undefined) {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      assertPositiveInteger(attemptNo);
      const leaseToken = randomSecret();
      const lease = await persistence.createLeasedAttempt(
        {
          organizationId: identity.host.organizationId,
          jobId: job.id,
          workerHostId: identity.host.id,
          workerSessionId: identity.host.workerSessionId,
          workerSessionGeneration: identity.host.workerSessionGeneration,
          attemptNo,
          fence,
          leaseToken,
          metadata,
        },
      );
      if (!lease.ok) {
        if (lease.reason === "job_version_missing") {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        if (lease.reason === "attempt_budget_exhausted") {
          return await saveNoAssignmentReplay();
        }
        throw new Error("JOB_ATTEMPT_INSERT_FAILED");
      }
      let sealedCredentialOperation: SealedCredentialOperation | null = null;
      if (job.action === "secret.identity.read") {
        if (identity.host.workerSessionId === null) {
          throw new StandardError({ code: "LEASE_FENCED" });
        }
        sealedCredentialOperation = await persistence.prepareIdentityOperation({
          organizationId: identity.host.organizationId,
          jobId: job.id,
          attemptId: lease.attemptId,
          workerHostId: identity.host.id,
          workerSessionId: identity.host.workerSessionId,
          workerSessionGeneration: identity.host.workerSessionGeneration,
          fence,
          leaseToken,
          leaseExpiresAt: lease.expiresAt,
          inputDigest: await canonicalExecutionInputDigest(job.input),
        });
      }
      const response = assignmentFromJob(
        job,
        lease.attemptId,
        identity.host.id,
        identity.host.workerSessionId,
        identity.host.workerSessionGeneration,
        leaseToken,
        fence,
        lease.expiresAt,
        DEFAULT_LEASE_SECONDS,
        lease.serverTime,
        sealedCredentialOperation,
      );
      await persistence.recordAssignment({
        organizationId: identity.host.organizationId,
        workerHostId: identity.host.id,
        claimKey: input.claimKey,
        requestDigest: digest,
        jobId: job.id,
        attemptId: lease.attemptId,
        jobVersion: lease.jobVersion,
        principalId: identity.host.principalId,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        fence,
        encryptReplay: () => protect(options.secret, response),
      });
      return { status: 200 as const, response, replayed: false };
    },
  );
}
