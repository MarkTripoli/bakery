import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "./postgres.ts";
import {
  appendAudit,
  appendDomainEvent,
  nextAggregateVersion,
} from "./event-audit.ts";
import type { HostRow, RequestMetadata, WorkerIdentity } from "./types.ts";

export async function loadWorkerIdentity(
  transaction: PgTransactionClient,
  tokenHash: string,
  protocolVersion: number,
): Promise<WorkerIdentity> {
  const result = await transaction.query<HostRow>(
    `select id, organization_id as "organizationId",
          principal_id as "principalId", principal_type as "principalType",
          name, os, architecture, capabilities, slots, status,
          desired_mode as "desiredMode", credential_hash as "credentialHash",
          credential_generation as "credentialGeneration",
          protocol_version as "protocolVersion",
          inventory_revision as "inventoryRevision",
          readiness_revision as "readinessRevision",
          worker_session_id as "workerSessionId",
          worker_session_generation as "workerSessionGeneration",
          last_heartbeat_at as "lastHeartbeatAt"
       from bakery.worker_hosts
       where credential_hash = $1
       for update`,
    [tokenHash],
  );
  const host = result.rows[0];
  if (!host || host.status === "revoked") {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  if (protocolVersion !== host.protocolVersion) {
    throw new StandardError({
      code: "WORKER_PROTOCOL_UNSUPPORTED",
      status: 426,
    });
  }
  return { tokenHash, host };
}

export type WorkerSessionRepository = {
  loadIdentity(
    tokenHash: string,
    protocolVersion: number,
  ): Promise<WorkerIdentity>;
};

export function createWorkerSessionRepository(
  transaction: PgTransactionClient,
): WorkerSessionRepository {
  return {
    loadIdentity(tokenHash, protocolVersion) {
      return loadWorkerIdentity(transaction, tokenHash, protocolVersion);
    },
  };
}

export type EnrollmentRepositoryOptions = {
  organizationId: string;
  principalId: string;
  idempotencyKey: string;
  requestDigest: string;
  name: string;
  os: string;
  architecture: string;
  capabilities: readonly string[];
  slots: number;
  metadata: RequestMetadata;
  enrollmentTtlSeconds: number;
  replayTtlSeconds: number;
  randomSecret: () => string;
  hash: (value: string) => Promise<string>;
  protect: (value: unknown) => Promise<string>;
  unprotect: (value: string) => Promise<unknown>;
};

export type RegistrationRepositoryOptions = {
  idempotencyKey: string;
  requestDigest: string;
  enrollmentHash: string;
  name: string;
  os: string;
  architecture: string;
  capabilities: readonly string[];
  slots: number;
  toolchainVersions: unknown;
  workerCredential: string;
  protocolVersion: number;
  metadata: RequestMetadata;
  replayTtlSeconds: number;
  hash: (value: string) => Promise<string>;
};

export type WorkerSessionWorkflowResult = {
  response: Record<string, unknown>;
  replayed: boolean;
};

export type WorkerSessionWorkflows = {
  enroll(
    options: EnrollmentRepositoryOptions,
  ): Promise<WorkerSessionWorkflowResult>;
  register(
    options: RegistrationRepositoryOptions,
  ): Promise<WorkerSessionWorkflowResult>;
};

function jsonValue(value: unknown, fallback: unknown): unknown {
  return value && typeof value === "object" ? value : fallback;
}

function normalized(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.map((item) => item.trim().toLowerCase())
    : [];
}

function isSubset(
  requested: readonly string[],
  allowed: readonly string[],
): boolean {
  return requested.every((value) => allowed.includes(value));
}
const WORKER_OS_VALUES = ["linux", "macos"] as const;

function assertEnrollmentIntegrity(row: {
  name: string;
  os: string;
  architecture: string;
  slots: number;
}): void {
  if (!row.name.trim()) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (!WORKER_OS_VALUES.includes(row.os as typeof WORKER_OS_VALUES[number])) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (!row.architecture.trim()) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (!Number.isSafeInteger(row.slots) || row.slots < 1 || row.slots > 100) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

function normalizeArchitecture(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  switch (normalized) {
    case "x64":
    case "x86_64":
    case "amd64":
    case "x8664":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    case "x86":
    case "i386":
    case "i686":
      return "x86";
    default:
      return normalized;
  }
}

export function createWorkerSessionWorkflows(
  transaction: PgTransactionClient,
): WorkerSessionWorkflows {
  return {
    async enroll(options) {
      await transaction.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`worker-enrollment:${options.organizationId}:${options.principalId}:${options.idempotencyKey}`],
      );
      await transaction.query(
        `delete from bakery.worker_enrollment_replays
         where organization_id = $1 and principal_id = $2
           and idempotency_key = $3 and expires_at <= clock_timestamp()`,
        [options.organizationId, options.principalId, options.idempotencyKey],
      );
      const replay = await transaction.query<{
        request_digest: string;
        response_ciphertext: string;
      }>(
        `select request_digest, response_ciphertext
       from bakery.worker_enrollment_replays
       where organization_id = $1 and principal_id = $2 and idempotency_key = $3
         and expires_at > clock_timestamp()`,
        [options.organizationId, options.principalId, options.idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow) {
        if (replayRow.request_digest !== options.requestDigest) {
          throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        }
        return {
          response:
            (await options.unprotect(replayRow.response_ciphertext)) as Record<
              string,
              unknown
            >,
          replayed: true,
        };
      }
      const enrollmentToken = options.randomSecret();
      const tokenHash = await options.hash(enrollmentToken);
      const inserted = await transaction.query<{
        id: string;
        expires_at: Date | string;
      }>(
        `insert into bakery.worker_enrollments (
         organization_id, principal_id, name, os, architecture,
         allowed_capabilities, slots, token_hash, expires_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8,
         clock_timestamp() + ($9::integer * interval '1 second'))
       returning id, expires_at`,
        [
          options.organizationId,
          options.principalId,
          options.name,
          options.os,
          options.architecture,
          JSON.stringify(options.capabilities),
          options.slots,
          tokenHash,
          options.enrollmentTtlSeconds,
        ],
      );
      const row = inserted.rows[0];
      if (!row?.id) throw new Error("WORKER_ENROLLMENT_INSERT_FAILED");
      const response = {
        enrollmentId: row.id,
        enrollmentToken,
        expiresAt: new Date(row.expires_at).toISOString(),
      };
      await transaction.query(
        `insert into bakery.worker_enrollment_replays (
         organization_id, principal_id, idempotency_key, request_digest,
         response_ciphertext, expires_at
       ) values ($1, $2, $3, $4, $5,
         clock_timestamp() + ($6::integer * interval '1 second'))`,
        [
          options.organizationId,
          options.principalId,
          options.idempotencyKey,
          options.requestDigest,
          await options.protect(response),
          options.replayTtlSeconds,
        ],
      );
      await appendAudit(transaction, {
        organizationId: options.organizationId,
        principalId: options.principalId,
        operation: "workers.enroll",
        resourceType: "worker_enrollment",
        resourceId: row.id,
        requestId: options.metadata.requestId,
        traceId: options.metadata.traceId,
        details: {
          name: options.name,
          os: options.os,
          architecture: options.architecture,
        },
      });
      return { response, replayed: false };
    },
    async register(options) {
      await transaction.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`worker-registration:${options.enrollmentHash}:${options.idempotencyKey}`],
      );
      await transaction.query(
        `delete from bakery.worker_registration_replays replay
         using bakery.worker_enrollments enrollment
         where enrollment.id = replay.enrollment_id
           and enrollment.token_hash = $1 and replay.idempotency_key = $2
           and replay.expires_at <= clock_timestamp()`,
        [options.enrollmentHash, options.idempotencyKey],
      );
      const replay = await transaction.query<{
        request_digest: string;
        response: unknown;
      }>(
        `select replay.request_digest, replay.response
       from bakery.worker_registration_replays replay
       join bakery.worker_enrollments enrollment
         on enrollment.id = replay.enrollment_id
       where enrollment.token_hash = $1 and replay.idempotency_key = $2
         and replay.expires_at > clock_timestamp()`,
        [options.enrollmentHash, options.idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow) {
        if (replayRow.request_digest !== options.requestDigest) {
          throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        }
        return {
          response: jsonValue(replayRow.response, {}) as Record<
            string,
            unknown
          >,
          replayed: true,
        };
      }
      const enrollment = await transaction.query<{
        id: string;
        organization_id: string;
        principal_id: string;
        name: string;
        os: string;
        expires_at: Date | string;
        architecture: string;
        allowed_capabilities: unknown;
        slots: number;
        consumed_at: Date | string | null;
        canceled_at: Date | string | null;
        target_worker_host_id: string | null;
        expected_credential_generation: number | null;
      }>(
        `select id, organization_id, principal_id, name, os, architecture,
          allowed_capabilities, slots, expires_at, consumed_at, canceled_at,
          target_worker_host_id, expected_credential_generation
       from bakery.worker_enrollments
       where token_hash = $1 and expires_at > clock_timestamp()
       for update`,
        [options.enrollmentHash],
      );
      const enrollmentRow = enrollment.rows[0];
      if (!enrollmentRow) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      assertEnrollmentIntegrity(enrollmentRow);
      if (enrollmentRow.consumed_at || enrollmentRow.canceled_at) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      if (options.name !== enrollmentRow.name) {
        throw new StandardError({
          code: "UNPROCESSABLE",
          params: { field: "name" },
        });
      }
      if (options.os !== enrollmentRow.os) {
        throw new StandardError({
          code: "UNPROCESSABLE",
          params: { field: "os" },
        });
      }
      if (
        normalizeArchitecture(options.architecture) !==
          normalizeArchitecture(enrollmentRow.architecture)
      ) {
        throw new StandardError({
          code: "UNPROCESSABLE",
          params: { field: "architecture" },
        });
      }
      if (options.slots > enrollmentRow.slots) {
        throw new StandardError({
          code: "UNPROCESSABLE",
          params: { field: "slots" },
        });
      }
      if (
        !isSubset(
          options.capabilities,
          normalized(enrollmentRow.allowed_capabilities),
        )
      ) {
        throw new StandardError({
          code: "UNPROCESSABLE",
          params: { field: "capabilities" },
        });
      }
      if (enrollmentRow.target_worker_host_id !== null) {
        // Re-pair consumption: bind the exact same-organization revoked host
        // and its expected credential generation, rotate the credential, and
        // start the new generation paused and checking.
        const hosts = await transaction.query<{
          id: string;
          principal_id: string;
          name: string;
          os: string;
          architecture: string;
          capabilities: unknown;
          slots: number;
          status: string;
          credential_generation: number;
        }>(
          `select id, principal_id, name, os, architecture, capabilities,
                  slots, status, credential_generation
           from bakery.worker_hosts
           where organization_id = $1 and id = $2
           for update`,
          [enrollmentRow.organization_id, enrollmentRow.target_worker_host_id],
        );
        const host = hosts.rows[0];
        if (!host) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
        if (host.status !== "revoked") {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        if (
          enrollmentRow.expected_credential_generation === null ||
          enrollmentRow.expected_credential_generation !==
            host.credential_generation
        ) {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        if (options.name !== host.name) {
          throw new StandardError({
            code: "UNPROCESSABLE",
            params: { field: "name" },
          });
        }
        if (options.os !== host.os) {
          throw new StandardError({
            code: "UNPROCESSABLE",
            params: { field: "os" },
          });
        }
        if (
          normalizeArchitecture(options.architecture) !==
            normalizeArchitecture(host.architecture)
        ) {
          throw new StandardError({
            code: "UNPROCESSABLE",
            params: { field: "architecture" },
          });
        }
        if (options.slots > host.slots) {
          throw new StandardError({
            code: "UNPROCESSABLE",
            params: { field: "slots" },
          });
        }
        if (!isSubset(options.capabilities, normalized(host.capabilities))) {
          throw new StandardError({
            code: "UNPROCESSABLE",
            params: { field: "capabilities" },
          });
        }
        const credentialHash = await options.hash(options.workerCredential);
        const rotated = await transaction.query<{
          credential_generation: number;
        }>(
          `update bakery.worker_hosts
         set credential_hash = $2,
             credential_generation = credential_generation + 1,
             desired_mode = 'paused', status = 'online',
             worker_session_id = null, worker_session_generation = 0,
             inventory_revision = inventory_revision + 1,
             readiness_revision = readiness_revision + 1,
             updated_at = current_timestamp, version = version + 1
         where organization_id = $3 and id = $1
         returning credential_generation`,
          [host.id, credentialHash, enrollmentRow.organization_id],
        );
        const registrationGeneration = rotated.rows[0]?.credential_generation ??
          null;
        if (!registrationGeneration) {
          throw new Error("WORKER_REPAIR_ROTATION_FAILED");
        }
        await transaction.query(
          `update bakery.worker_enrollments
       set consumed_at = current_timestamp, worker_host_id = $2,
           updated_at = current_timestamp, version = version + 1
       where organization_id = $3 and id = $1`,
          [
            enrollmentRow.id,
            host.id,
            enrollmentRow.organization_id,
          ],
        );
        const response = {
          workerHostId: host.id,
          principalId: host.principal_id,
          status: "updated",
          registrationGeneration,
        };
        await transaction.query(
          `insert into bakery.worker_registration_replays (
         enrollment_id, idempotency_key, request_digest, worker_host_id,
         principal_id, registration_generation, response, expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb,
         clock_timestamp() + ($8::integer * interval '1 second'))`,
          [
            enrollmentRow.id,
            options.idempotencyKey,
            options.requestDigest,
            host.id,
            host.principal_id,
            registrationGeneration,
            JSON.stringify(response),
            options.replayTtlSeconds,
          ],
        );
        await appendDomainEvent(transaction, {
          organizationId: enrollmentRow.organization_id,
          eventType: "worker.registered",
          aggregateId: host.id,
          aggregateVersion: registrationGeneration,
          workerHostId: host.id,
          workerEnrollmentId: enrollmentRow.id,
          payload: {
            resourceId: host.id,
            resourceVersion: registrationGeneration,
          },
          traceId: options.metadata.traceId,
        });
        await appendDomainEvent(transaction, {
          organizationId: enrollmentRow.organization_id,
          eventType: "worker_enrollment.updated",
          aggregateId: enrollmentRow.id,
          aggregateVersion: await nextAggregateVersion(
            transaction,
            enrollmentRow.organization_id,
            enrollmentRow.id,
            "worker_enrollment.updated",
          ),
          workerEnrollmentId: enrollmentRow.id,
          workerHostId: host.id,
          payload: {
            resourceId: enrollmentRow.id,
            resourceVersion: 1,
            state: "consumed",
          },
          traceId: options.metadata.traceId,
        });
        await appendAudit(transaction, {
          organizationId: enrollmentRow.organization_id,
          principalId: enrollmentRow.principal_id,
          operation: "workers.register",
          resourceType: "worker_host",
          resourceId: host.id,
          requestId: options.metadata.requestId,
          traceId: options.metadata.traceId,
          details: {
            enrollmentId: enrollmentRow.id,
            principalId: host.principal_id,
            repair: true,
          },
        });
        return { response, replayed: false };
      }
      const workerPrincipal = await transaction.query<{ id: string }>(
        `insert into bakery.principals (display_name, principal_type)
       values ($1, 'worker') returning id`,
        [enrollmentRow.name],
      );
      const principalId = workerPrincipal.rows[0]?.id;
      if (!principalId) throw new Error("WORKER_PRINCIPAL_INSERT_FAILED");
      const credentialHash = await options.hash(options.workerCredential);
      const host = await transaction.query<{
        id: string;
        worker_session_id: string | null;
        worker_session_generation: string;
      }>(
        `insert into bakery.worker_hosts (
         organization_id, principal_id, name, os, architecture,
         capabilities, toolchain_versions, slots, credential_hash,
         credential_generation, protocol_version,
         worker_session_id, worker_session_generation
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, 1, $10,
         case when $10 = 1 then gen_random_uuid() else null end,
         case when $10 = 1 then 1 else 0 end)
       returning id, worker_session_id, worker_session_generation`,
        [
          enrollmentRow.organization_id,
          principalId,
          enrollmentRow.name,
          options.os,
          options.architecture,
          JSON.stringify(options.capabilities),
          JSON.stringify(jsonValue(options.toolchainVersions, {})),
          options.slots,
          credentialHash,
          options.protocolVersion,
        ],
      );
      const hostRow = host.rows[0];
      if (!hostRow) throw new Error("WORKER_HOST_INSERT_FAILED");
      await transaction.query(
        `update bakery.worker_enrollments
       set consumed_at = current_timestamp, worker_host_id = $2,
           updated_at = current_timestamp, version = version + 1
       where organization_id = $3 and id = $1`,
        [enrollmentRow.id, hostRow.id, enrollmentRow.organization_id],
      );
      const response = {
        workerHostId: hostRow.id,
        principalId,
        status: "registered",
        registrationGeneration: 1,
        ...(hostRow.worker_session_id === null ? {} : {
          workerSessionId: hostRow.worker_session_id,
          workerSessionGeneration: hostRow.worker_session_generation,
        }),
      };
      await transaction.query(
        `insert into bakery.worker_registration_replays (
         enrollment_id, idempotency_key, request_digest, worker_host_id,
         principal_id, registration_generation, response, expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb,
         clock_timestamp() + ($8::integer * interval '1 second'))`,
        [
          enrollmentRow.id,
          options.idempotencyKey,
          options.requestDigest,
          hostRow.id,
          principalId,
          1,
          JSON.stringify(response),
          options.replayTtlSeconds,
        ],
      );
      await appendDomainEvent(transaction, {
        organizationId: enrollmentRow.organization_id,
        eventType: "worker.registered",
        aggregateId: hostRow.id,
        aggregateVersion: 1,
        workerHostId: hostRow.id,
        workerEnrollmentId: enrollmentRow.id,
        payload: { resourceId: hostRow.id, resourceVersion: 1 },
        traceId: options.metadata.traceId,
      });
      await appendDomainEvent(transaction, {
        organizationId: enrollmentRow.organization_id,
        eventType: "worker_enrollment.updated",
        aggregateId: enrollmentRow.id,
        aggregateVersion: 1,
        workerEnrollmentId: enrollmentRow.id,
        workerHostId: hostRow.id,
        payload: {
          resourceId: enrollmentRow.id,
          resourceVersion: 1,
          state: "consumed",
        },
        traceId: options.metadata.traceId,
      });
      await appendAudit(transaction, {
        organizationId: enrollmentRow.organization_id,
        principalId: enrollmentRow.principal_id,
        operation: "workers.register",
        resourceType: "worker_host",
        resourceId: hostRow.id,
        requestId: options.metadata.requestId,
        traceId: options.metadata.traceId,
        details: {
          enrollmentId: enrollmentRow.id,
          principalId,
          architecture: options.architecture,
        },
      });
      return { response, replayed: false };
    },
  };
}
