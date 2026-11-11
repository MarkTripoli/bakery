import { type Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { IDEMPOTENCY_REPLAY_TTL_SECONDS } from "@bakery/persistence";
import { jsonResponse, parseContract } from "./http.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import {
  adminTransaction,
  assertNonEmptyText,
  contractSchemas,
  decodeBase64,
  ENROLLMENT_TTL_MS,
  type ExecutionRouteOptions,
  normalizeArchitecture,
  normalizeCapabilities,
  parseIdempotencyKey,
  parseWorkerProtocolVersion,
  protect,
  randomSecret,
  requestDigest,
  requestMetadata,
  sha256Hex,
  unprotect,
  withPgTransaction,
} from "./shared.ts";

import { createWorkerSessionWorkflows } from "@bakery/persistence/worker-session";
export async function enrollWorker(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const input = await parseContract(
    context,
    contractSchemas.WorkerEnrollmentCreate,
  );
  const canonicalInput = {
    ...input,
    architecture: normalizeArchitecture(input.architecture),
  };
  const idempotencyKey = parseIdempotencyKey(
    context.req.header("Idempotency-Key"),
  );
  const digest = await requestDigest(canonicalInput);
  const capabilities = normalizeCapabilities(input.capabilities);
  const metadata = requestMetadata(context);
  const result = await adminTransaction(
    context,
    options,
    async (transaction, organization, principal) => {
      const result = await createWorkerSessionWorkflows(transaction).enroll({
        organizationId: organization,
        principalId: principal.principalId,
        idempotencyKey,
        requestDigest: digest,
        name: input.name,
        os: input.os,
        architecture: canonicalInput.architecture,
        capabilities,
        slots: input.slots,
        metadata,
        enrollmentTtlSeconds: ENROLLMENT_TTL_MS / 1000,
        replayTtlSeconds: IDEMPOTENCY_REPLAY_TTL_SECONDS,
        randomSecret,
        hash: sha256Hex,
        protect: (value) => protect(options.secret, value),
        unprotect: (value) => unprotect(options.secret, value),
      });
      return {
        response: contractSchemas.WorkerEnrollment.parse(result.response),
        replayed: result.replayed,
      };
    },
  );
  return jsonResponse(result.response, 201, result.replayed);
}
function assertCredentialStrength(value: string): void {
  const decoded = decodeBase64(value);
  if (!decoded || decoded.byteLength < 32) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { field: "workerCredential" },
    });
  }
}

export async function registerWorker(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const protocolVersion = parseWorkerProtocolVersion(context.req.raw.headers);
  const input = await parseContract(
    context,
    contractSchemas.WorkerRegistration,
  );
  assertNonEmptyText(input.name);
  assertNonEmptyText(input.architecture);
  const canonicalInput = {
    ...input,
    architecture: normalizeArchitecture(input.architecture),
  };
  const idempotencyKey = parseIdempotencyKey(
    context.req.header("Idempotency-Key"),
  );
  const digest = await requestDigest({
    ...canonicalInput,
    protocolVersion,
  });
  const metadata = requestMetadata(context);
  assertCredentialStrength(input.workerCredential);
  const enrollmentHash = await sha256Hex(input.enrollmentToken);
  const requestedCapabilities = normalizeCapabilities(input.capabilities);
  const result = await withPgTransaction(
    options.database,
    async (transaction) => {
      const result = await createWorkerSessionWorkflows(transaction).register({
        idempotencyKey,
        requestDigest: digest,
        enrollmentHash,
        name: input.name,
        os: input.os,
        architecture: canonicalInput.architecture,
        capabilities: requestedCapabilities,
        slots: input.slots,
        toolchainVersions: input.toolchainVersions,
        workerCredential: input.workerCredential,
        protocolVersion,
        metadata,
        replayTtlSeconds: IDEMPOTENCY_REPLAY_TTL_SECONDS,
        hash: sha256Hex,
      });
      return {
        response: contractSchemas.WorkerRegistrationResult.parse(
          result.response,
        ),
        replayed: result.replayed,
      };
    },
    context.req.raw.signal,
  );
  return jsonResponse(result.response, 200, result.replayed);
}
