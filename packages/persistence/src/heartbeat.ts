import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "./postgres.ts";
import { appendAudit, appendDomainEvent } from "./event-audit.ts";
import { rebindLiveClaimAttempt } from "./attempts.ts";
import {
  IDEMPOTENCY_REPLAY_TTL_SECONDS,
  WORKER_COMMAND_TERMINAL_RETENTION_SECONDS,
} from "./constants.ts";
import {
  type RequestMetadata,
  sessionGeneration,
  type WorkerIdentity,
} from "./types.ts";

export type HeartbeatInput = {
  workerHostId: string;
  activeAttemptIds?: readonly string[];
  pendingClaimKey?: string;
  ackCommandIds?: readonly string[];
  rejectedCommandIds?: readonly string[];
  workerSessionId?: string;
  workerSessionGeneration?: string;
  adapterCapabilities?: readonly string[];
};

/** Closed steering-capability vocabulary a worker session may advertise. */
export const ADAPTER_CAPABILITIES: readonly string[] = [
  "stream",
  "resume",
  "steer",
  "follow_up",
  "interrupt",
];

export type HeartbeatResult = {
  body: string;
  status: 200;
  replayed: boolean;
};

export type HeartbeatRepository = {
  heartbeat(options: {
    identity: WorkerIdentity;
    input: HeartbeatInput;
    idempotencyKey: string;
    requestDigest: string;
    protocolVersion: number;
    metadata: RequestMetadata;
    makeResponse: (value: unknown) => unknown;
  }): Promise<HeartbeatResult>;
};

function jsonValue(value: unknown, fallback: unknown): unknown {
  return value && typeof value === "object" ? value : fallback;
}

function assertCommandStatus(value: string): void {
  if (
    ![
      "pending",
      "delivered",
      "acknowledged",
      "rejected",
    ].includes(value)
  ) throw new StandardError({ code: "UNPROCESSABLE" });
}

export function createHeartbeatRepository(
  transaction: PgTransactionClient,
): HeartbeatRepository {
  return {
    async heartbeat(options) {
      const {
        identity,
        input,
        idempotencyKey,
        requestDigest,
        protocolVersion,
        metadata,
      } = options;
      if (input.workerHostId !== identity.host.id) {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
      const clock = await transaction.query<{ now: Date }>(
        "select clock_timestamp() as now",
      );
      const heartbeatTime = clock.rows[0]?.now;
      if (!heartbeatTime) throw new Error("WORKER_HEARTBEAT_TIME_MISSING");
      await transaction.query(
        `delete from bakery.worker_heartbeat_replays
         where worker_host_id = $1 and idempotency_key = $2
           and expires_at <= $3`,
        [identity.host.id, idempotencyKey, heartbeatTime],
      );
      const replay = await transaction.query<{
        request_digest: string;
        response_status: number;
        response_body: string;
      }>(
        `select request_digest, response_status, response_body
         from bakery.worker_heartbeat_replays
         where worker_host_id = $1 and idempotency_key = $2
         and expires_at > $3`,
        [identity.host.id, idempotencyKey, heartbeatTime],
      );
      const replayRow = replay.rows[0];
      if (replayRow) {
        if (replayRow.request_digest !== requestDigest) {
          throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        }
        return {
          body: replayRow.response_body,
          status: 200,
          replayed: true,
        };
      }
      let reconcileAttempts = false;
      if (input.workerSessionId !== undefined) {
        const suppliedGeneration = sessionGeneration(
          input.workerSessionGeneration!,
          0n,
        );
        if (identity.host.workerSessionId === null) {
          if (suppliedGeneration !== 0n) {
            throw new StandardError({ code: "LEASE_FENCED" });
          }
          const session = await transaction.query<{
            worker_session_id: string;
            worker_session_generation: string;
          }>(
            `update bakery.worker_hosts
             set worker_session_id = $2, worker_session_generation = 1,
                 updated_at = $3, version = version + 1
             where id = $1 and worker_session_id is null
               and worker_session_generation = 0
             returning worker_session_id, worker_session_generation`,
            [identity.host.id, input.workerSessionId, heartbeatTime],
          );
          const row = session.rows[0];
          if (!row) throw new StandardError({ code: "LEASE_FENCED" });
          identity.host.workerSessionId = row.worker_session_id;
          identity.host.workerSessionGeneration = row.worker_session_generation;
          reconcileAttempts = true;
        } else if (input.workerSessionId === identity.host.workerSessionId) {
          if (
            suppliedGeneration !==
              sessionGeneration(identity.host.workerSessionGeneration, 0n)
          ) {
            throw new StandardError({ code: "LEASE_FENCED" });
          }
          reconcileAttempts = true;
        } else {
          const priorGeneration = sessionGeneration(
            identity.host.workerSessionGeneration,
            0n,
          );
          if (suppliedGeneration !== priorGeneration) {
            throw new StandardError({ code: "LEASE_FENCED" });
          }
          const session = await transaction.query<{
            worker_session_id: string;
            worker_session_generation: string;
          }>(
            `update bakery.worker_hosts
             set worker_session_id = $2,
                 worker_session_generation = worker_session_generation + 1,
                 updated_at = $5, version = version + 1
             where id = $1 and worker_session_id = $3
               and worker_session_generation = $4
             returning worker_session_id, worker_session_generation`,
            [
              identity.host.id,
              input.workerSessionId,
              identity.host.workerSessionId,
              priorGeneration.toString(),
              heartbeatTime,
            ],
          );
          const row = session.rows[0];
          if (!row) throw new StandardError({ code: "LEASE_FENCED" });
          identity.host.workerSessionId = row.worker_session_id;
          identity.host.workerSessionGeneration = row.worker_session_generation;
          reconcileAttempts = true;
        }
      }
      if (input.adapterCapabilities !== undefined) {
        const advertised = [...new Set(input.adapterCapabilities)];
        if (advertised.some((value) => !ADAPTER_CAPABILITIES.includes(value))) {
          throw new StandardError({
            code: "UNPROCESSABLE",
            params: { field: "adapterCapabilities" },
          });
        }
        await transaction.query(
          `update bakery.worker_hosts
             set adapter_capabilities = $2::jsonb, updated_at = $3
           where id = $1 and adapter_capabilities is distinct from $2::jsonb`,
          [identity.host.id, JSON.stringify(advertised), heartbeatTime],
        );
      }
      let pendingClaimAttemptId: string | undefined;
      if (input.pendingClaimKey !== undefined) {
        const pending = await transaction.query<{ attempt_id: string | null }>(
          `select attempt_id from bakery.worker_claim_replays
           where worker_host_id = $1 and claim_key = $2 and expires_at > $3`,
          [identity.host.id, input.pendingClaimKey, heartbeatTime],
        );
        const attemptId = pending.rows[0]?.attempt_id;
        if (
          attemptId && await rebindLiveClaimAttempt(
            transaction,
            identity,
            attemptId,
            heartbeatTime,
          )
        ) {
          pendingClaimAttemptId = attemptId;
          reconcileAttempts = true;
        }
      }
      if (identity.host.workerSessionId === null && reconcileAttempts) {
        throw new StandardError({ code: "LEASE_FENCED" });
      }
      const requestedStatus = new Map<string, "acknowledged" | "rejected">();
      for (const commandId of input.ackCommandIds ?? []) {
        const prior = requestedStatus.get(commandId);
        if (prior && prior !== "acknowledged") {
          throw new StandardError({ code: "MALFORMED_REQUEST" });
        }
        requestedStatus.set(commandId, "acknowledged");
      }
      for (const commandId of input.rejectedCommandIds ?? []) {
        const prior = requestedStatus.get(commandId);
        if (prior && prior !== "rejected") {
          throw new StandardError({ code: "MALFORMED_REQUEST" });
        }
        requestedStatus.set(commandId, "rejected");
      }
      const commandAcks: Array<
        { commandId: string; status: string; acknowledgedAt: string }
      > = [];
      if (requestedStatus.size) {
        const ids = [...requestedStatus.keys()];
        const commands = await transaction.query<{
          id: string;
          status: string;
          acknowledged_at: Date | string | null;
        }>(
          `select command.id, command.status, command.acknowledged_at
           from bakery.worker_commands command
           join bakery.job_attempts attempt
             on attempt.organization_id = command.organization_id
            and attempt.id = command.attempt_id
           where command.organization_id = $1 and attempt.worker_host_id = $2
             and command.id = any($3::uuid[])
           for update`,
          [identity.host.organizationId, identity.host.id, ids],
        );
        const tombstones = await transaction.query<{
          command_id: string;
          status: string;
          acknowledged_at: Date | string;
        }>(
          `select command_id, status, acknowledged_at
           from bakery.worker_command_ack_tombstones
           where organization_id = $1 and worker_host_id = $2
             and command_id = any($3::uuid[]) and expires_at > $4`,
          [identity.host.organizationId, identity.host.id, ids, heartbeatTime],
        );
        const commandById = new Map(commands.rows.map((row) => [row.id, row]));
        const tombstoneById = new Map(
          tombstones.rows.map((row) => [row.command_id, row]),
        );
        for (const commandId of ids) {
          const command = commandById.get(commandId);
          const tombstone = tombstoneById.get(commandId);
          if (!command && !tombstone) continue;
          if (!command && tombstone) {
            assertCommandStatus(tombstone.status);
            commandAcks.push({
              commandId,
              status: "duplicate",
              acknowledgedAt: new Date(tombstone.acknowledged_at).toISOString(),
            });
            continue;
          }
          assertCommandStatus(command!.status);
          const requested = requestedStatus.get(commandId)!;
          let status: "acknowledged" | "rejected" | "duplicate";
          let acknowledgedAt = command!.acknowledged_at;
          if (
            command!.status === "acknowledged" || command!.status === "rejected"
          ) {
            status = "duplicate";
          } else {
            const updated = await transaction.query<
              { acknowledged_at: Date | string }
            >(
              `update bakery.worker_commands
               set status = $2, acknowledged_at = $3
               where id = $1 and status in ('pending', 'delivered')
               returning acknowledged_at`,
              [commandId, requested, heartbeatTime],
            );
            acknowledgedAt = updated.rows[0]?.acknowledged_at ?? null;
            status = updated.rows.length === 1 ? requested : "duplicate";
          }
          if (!acknowledgedAt) {
            throw new Error("WORKER_COMMAND_ACK_TIME_MISSING");
          }
          await transaction.query(
            `insert into bakery.worker_command_ack_tombstones (
               command_id, organization_id, worker_host_id, status,
               acknowledged_at, expires_at
             ) values ($1, $2, $3, $4, $5,
               $6::timestamptz + ($7::integer * interval '1 second'))
             on conflict (command_id) do nothing`,
            [
              commandId,
              identity.host.organizationId,
              identity.host.id,
              command!.status === "rejected" || status === "rejected"
                ? "rejected"
                : "acknowledged",
              acknowledgedAt,
              heartbeatTime,
              WORKER_COMMAND_TERMINAL_RETENTION_SECONDS,
            ],
          );
          commandAcks.push({
            commandId,
            status,
            acknowledgedAt: new Date(acknowledgedAt).toISOString(),
          });
        }
      }
      const activeAttemptIds = input.activeAttemptIds ?? [];
      let reconciledAttemptIds: string[] = [];
      if (
        reconcileAttempts &&
        (input.activeAttemptIds !== undefined ||
          pendingClaimAttemptId !== undefined)
      ) {
        const reported = new Set(activeAttemptIds);
        if (pendingClaimAttemptId) reported.add(pendingClaimAttemptId);
        const reportedRows = await transaction.query<
          { worker_host_id: string }
        >(
          `select id, worker_host_id from bakery.job_attempts
           where organization_id = $1 and id = any($2::uuid[])`,
          [identity.host.organizationId, activeAttemptIds],
        );
        if (
          reportedRows.rows.some((row) =>
            row.worker_host_id !== identity.host.id
          )
        ) {
          throw new StandardError({ code: "AUTH_FORBIDDEN" });
        }
        const reboundIds = new Set<string>();
        if (pendingClaimAttemptId) reboundIds.add(pendingClaimAttemptId);
        if (activeAttemptIds.length) {
          const rebound = await transaction.query<{ id: string }>(
            `update bakery.job_attempts attempt
             set worker_session_id = $3, worker_session_generation = $4,
                 updated_at = $6, version = version + 1
             where attempt.organization_id = $1 and attempt.worker_host_id = $2
               and attempt.id = any($5::uuid[])
               and attempt.status in ('leased', 'running', 'canceling')
               and attempt.lease_expires_at > $6
               and exists (select 1 from bakery.jobs job
                 where job.organization_id = attempt.organization_id
                   and job.id = attempt.job_id and job.current_fence = attempt.fence)
             returning attempt.id`,
            [
              identity.host.organizationId,
              identity.host.id,
              identity.host.workerSessionId,
              sessionGeneration(identity.host.workerSessionGeneration, 1n)
                .toString(),
              activeAttemptIds,
              heartbeatTime,
            ],
          );
          for (const row of rebound.rows) reboundIds.add(row.id);
        }
        reconciledAttemptIds = activeAttemptIds.filter((id, index) =>
          activeAttemptIds.indexOf(id) === index && reboundIds.has(id)
        );
        if (
          pendingClaimAttemptId && reboundIds.has(pendingClaimAttemptId) &&
          !reconciledAttemptIds.includes(pendingClaimAttemptId)
        ) reconciledAttemptIds.push(pendingClaimAttemptId);
        reported.clear();
        for (const id of reconciledAttemptIds) reported.add(id);
        const live = await transaction.query<
          { id: string; job_id: string; fence: string }
        >(
          `select id, job_id, fence::text from bakery.job_attempts
           where organization_id = $1 and worker_host_id = $2
             and status in ('leased', 'running', 'canceling')
           order by lease_expires_at asc, id asc limit 100 for update`,
          [identity.host.organizationId, identity.host.id],
        );
        for (const attempt of live.rows) {
          if (reported.has(attempt.id)) continue;
          const quarantined = await transaction.query(
            `update bakery.job_attempts
             set status = 'quarantined', ended_at = $5,
                 updated_at = $5, version = version + 1
             where organization_id = $1 and id = $2
               and status in ('leased', 'running', 'canceling')
               and lease_expires_at > $5
               and not exists (
                 select 1 from bakery.worker_claim_replays replay
                 where replay.organization_id = $1 and replay.worker_host_id = $2
                   and replay.attempt_id = $3 and replay.expires_at > $5
                   and replay.created_at > coalesce($4::timestamptz, '-infinity'::timestamptz)
               )`,
            [
              identity.host.organizationId,
              attempt.id,
              attempt.id,
              identity.host.lastHeartbeatAt,
              heartbeatTime,
            ],
          );
          if (quarantined.rowCount !== 1) continue;
          const job = await transaction.query<{ version: number }>(
            `update bakery.jobs
             set status = 'awaiting_reconciliation', current_fence = current_fence + 1,
                 updated_at = $4, version = version + 1
             where organization_id = $1 and id = $2
               and status in ('leased', 'running', 'awaiting_reconciliation')
               and current_fence = $3 returning version`,
            [
              identity.host.organizationId,
              attempt.job_id,
              attempt.fence,
              heartbeatTime,
            ],
          );
          if (job.rows[0]) {
            await appendDomainEvent(transaction, {
              organizationId: identity.host.organizationId,
              eventType: "job.updated",
              aggregateId: attempt.job_id,
              aggregateVersion: job.rows[0].version,
              payload: {
                jobId: attempt.job_id,
                attemptId: attempt.id,
                version: job.rows[0].version,
              },
              traceId: metadata.traceId,
            });
          }
          await appendAudit(transaction, {
            organizationId: identity.host.organizationId,
            principalId: identity.host.principalId,
            operation: "workers.attempt_quarantined",
            resourceType: "job_attempt",
            resourceId: attempt.id,
            requestId: metadata.requestId,
            traceId: metadata.traceId,
            details: {
              jobId: attempt.job_id,
              reason: "heartbeat_reconciliation",
            },
          });
        }
      }
      const pending = await transaction.query<{
        id: string;
        attempt_id: string;
        message_id: string | null;
        command_type: "steer" | "follow_up" | "cancel";
        payload: unknown;
        status: "pending" | "delivered";
        created_at: Date | string;
      }>(
        `select command.id, command.attempt_id, command.message_id,
          command.command_type, command.payload, command.status, command.created_at
       from bakery.worker_commands command
       join bakery.job_attempts attempt
         on attempt.organization_id = command.organization_id and attempt.id = command.attempt_id
       where command.organization_id = $1 and attempt.worker_host_id = $2
         and command.status in ('pending', 'delivered')
       order by command.created_at asc, command.id asc limit 100 for update of command skip locked`,
        [identity.host.organizationId, identity.host.id],
      );
      const pendingCommands = pending.rows.map((command) => {
        const result = {
          id: command.id,
          attemptId: command.attempt_id,
          messageId: command.message_id,
          commandType: command.command_type,
          payload: jsonValue(command.payload, {}),
          status: "delivered",
          createdAt: new Date(command.created_at).toISOString(),
        };
        return result;
      });
      for (const command of pending.rows) {
        if (command.status === "pending") {
          await transaction.query(
            `update bakery.worker_commands set status = 'delivered'
             where id = $1 and status = 'pending'`,
            [command.id],
          );
        }
      }
      const applied = await transaction.query<{ inventory_revision: number }>(
        `update bakery.worker_hosts
       set last_heartbeat_at = $2,
           status = case when status = 'offline' then 'online' else status end,
           updated_at = $2, version = version + 1
       where id = $1
       returning inventory_revision`,
        [identity.host.id, heartbeatTime],
      );
      const inventoryRevision = applied.rows[0]?.inventory_revision;
      if (inventoryRevision === undefined) {
        throw new Error("WORKER_HEARTBEAT_HOST_MISSING");
      }
      const response = options.makeResponse({
        workerHostId: identity.host.id,
        status: "accepted",
        receivedAt: new Date(heartbeatTime).toISOString(),
        pendingCommands,
        commandAcks,
        ...(identity.host.workerSessionId === null ? {} : {
          workerSessionId: identity.host.workerSessionId,
          workerSessionGeneration: sessionGeneration(
            identity.host.workerSessionGeneration,
            1n,
          ).toString(),
        }),
        ...(protocolVersion >= 2 ? { reconciledAttemptIds } : {}),
        serverTime: new Date(heartbeatTime).toISOString(),
        inventoryRevision: Number(inventoryRevision),
      });
      await transaction.query(
        `insert into bakery.worker_heartbeat_replays (
           organization_id, worker_host_id, idempotency_key,
           request_digest, response_status, response_body, expires_at
         ) values ($1, $2, $3, $4, 200, $5,
           $6::timestamptz + ($7::integer * interval '1 second'))`,
        [
          identity.host.organizationId,
          identity.host.id,
          idempotencyKey,
          requestDigest,
          JSON.stringify(response),
          heartbeatTime,
          IDEMPOTENCY_REPLAY_TTL_SECONDS,
        ],
      );
      return { body: JSON.stringify(response), status: 200, replayed: false };
    },
  };
}
