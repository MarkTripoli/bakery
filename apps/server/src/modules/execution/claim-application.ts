import { z } from "zod";
import type { PgTransactionClient } from "@bakery/persistence";
import { sha256Hex } from "../../platform/canonical-json.ts";
import {
  issueCredentialForAttempt,
  type MintedSessionCredential,
} from "./session-claim-credential.ts";
import { revokeAttemptCredentials } from "./session-credential-store.ts";
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
  /**
   * The claim's own transaction, so work that must commit with the lease can.
   * The session credential is minted here: a credential written outside this
   * transaction could name an attempt that was never leased.
   */
  readonly transaction: PgTransactionClient;
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

/**
 * Builds the envelope a worker receives. Exported so a test can assert what
 * actually reaches the wire: a field declared in the contract but never filled
 * in here is the "built and never called" defect with extra steps.
 */
export function assignmentFromJob(
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
  sessionCredential: MintedSessionCredential | null,
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
    // Handed back once, here, and never stored in the clear. Omitted rather
    // than null when there is none: the contract types this field as a string,
    // so a null is a shape the schema rejects - and a claim that fails to parse
    // is a worse outcome than a claim without a credential.
    ...(sessionCredential === null
      ? {}
      : { sessionCredential: sessionCredential.token }),
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
    async (context) => {
      const { identity, persistence } = context;
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
          const replayed = contractSchemas.JobAssignment.parse(
            await unprotect(options.secret, replay.responseCiphertext),
          ) as Assignment;
          // The token is served exactly once, on the response that minted it.
          // A replay re-serves the stored ciphertext, so handing it back whole
          // would make "returned once" false: the token would be readable from
          // the replay store for as long as the replay lives. The credential is
          // revoked and the replay carries none, because a worker that lost its
          // token should claim again rather than recover a secret from a cache.
          await revokeAttemptCredentials(context.transaction, {
            organizationId: identity.host.organizationId,
            attemptId: replay.attemptId,
          });
          const {
            sessionCredential: _withheld,
            ...withoutCredential
          } = replayed;
          const response = withoutCredential as Assignment;
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
      // The session operation credential is minted in this transaction, so the
      // attempt and the credential it authorises appear together or not at all.
      // A credential issued outside the claim could name an attempt that was
      // never leased, which is authority for work that does not exist.
      // No run, no person, no credential. A job with no run - a coordinator
      // turn, an onboarding job - has no requester, and falling back to the
      // worker host's principal would mint a credential that acts for the
      // machine's owner. That is the one thing this must never do: the audit
      // would name someone who did not ask for the work, and a host principal
      // is usually the widest one in the organisation. Refusing to mint costs
      // the session its tools; minting for the wrong person costs the audit its
      // meaning.
      const sessionCredential = identity.host.workerSessionId === null ||
          job.actsForPrincipalId === null
        ? null
        : await issueCredentialForAttempt(context.transaction, {
          organizationId: identity.host.organizationId,
          attemptId: lease.attemptId,
          // The person the agent acts for is the run's requester, never the
          // host that picked the job up: O50 audits the principal.
          actsForPrincipalType: job.actsForPrincipalType ?? "worker",
          actsForPrincipalId: job.actsForPrincipalId,
          workerSessionId: identity.host.workerSessionId,
          workerSessionGeneration: BigInt(
            identity.host.workerSessionGeneration ?? "1",
          ),
          fence,
          leaseTokenHash: await sha256Hex(leaseToken),
          leaseExpiresAt: lease.expiresAt,
        });
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
        sessionCredential,
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
