import type { PgTransactionClient } from "./postgres.ts";
import {
  ARTIFACT_PREVIEW_RETENTION_GRACE_SECONDS,
  RETENTION_SWEEP_BATCH_SIZE,
  WORKER_COMMAND_TERMINAL_RETENTION_SECONDS,
} from "./constants.ts";
export {
  RETENTION_SWEEP_BATCH_SIZE,
  WORKER_COMMAND_TERMINAL_RETENTION_SECONDS,
} from "./constants.ts";

export async function sweepExecutionRetention(
  transaction: PgTransactionClient,
): Promise<void> {
  await transaction.query(
    `with doomed as materialized (
       select id from bakery.worker_claim_replays
       where expires_at <= clock_timestamp()
       order by expires_at, id
       limit ${RETENTION_SWEEP_BATCH_SIZE}
     )
     delete from bakery.worker_claim_replays replay
     using doomed where replay.id = doomed.id`,
  );
  await transaction.query(
    `with doomed as materialized (
       select id from bakery.worker_registration_replays
       where expires_at <= clock_timestamp()
       order by expires_at, id
       limit ${RETENTION_SWEEP_BATCH_SIZE}
     )
     delete from bakery.worker_registration_replays replay
     using doomed where replay.id = doomed.id`,
  );
  await transaction.query(
    `with doomed as materialized (
       select id from bakery.worker_enrollment_replays
       where expires_at <= clock_timestamp()
       order by expires_at, id
       limit ${RETENTION_SWEEP_BATCH_SIZE}
     )
     delete from bakery.worker_enrollment_replays replay
     using doomed where replay.id = doomed.id`,
  );
  await transaction.query(
    `with doomed as materialized (
       select id from bakery.worker_lease_renewal_replays
       where expires_at <= clock_timestamp()
       order by expires_at, id
       limit ${RETENTION_SWEEP_BATCH_SIZE}
     )
     delete from bakery.worker_lease_renewal_replays replay
     using doomed where replay.id = doomed.id`,
  );
  await transaction.query(
    `with doomed as materialized (
       select id from bakery.worker_heartbeat_replays
       where expires_at <= clock_timestamp()
       order by expires_at, id
       limit ${RETENTION_SWEEP_BATCH_SIZE}
     )
     delete from bakery.worker_heartbeat_replays replay
     using doomed where replay.id = doomed.id`,
  );
  await transaction.query(
    `with doomed as materialized (
       select id from bakery.worker_enrollments
       where consumed_at is null
         and (canceled_at is not null or expires_at <= clock_timestamp())
       order by expires_at, id
       limit ${RETENTION_SWEEP_BATCH_SIZE}
     )
     delete from bakery.worker_enrollments enrollment
     using doomed where enrollment.id = doomed.id`,
  );
  await transaction.query(
    `with doomed as materialized (
       select command.id, command.organization_id, attempt.worker_host_id,
              command.status, command.acknowledged_at
       from bakery.worker_commands command
       join bakery.job_attempts attempt
         on attempt.organization_id = command.organization_id
        and attempt.id = command.attempt_id
       where command.status in ('acknowledged', 'rejected')
         and command.acknowledged_at <= clock_timestamp() -
           ($1::integer * interval '1 second')
       order by command.acknowledged_at asc, command.id asc
       limit ${RETENTION_SWEEP_BATCH_SIZE}
       for update of command skip locked
     ), saved as (
       insert into bakery.worker_command_ack_tombstones (
         command_id, organization_id, worker_host_id, status,
         acknowledged_at, expires_at
       )
       select id, organization_id, worker_host_id, status, acknowledged_at,
         clock_timestamp() + ($1::integer * interval '1 second')
       from doomed on conflict (command_id) do nothing returning command_id
     ) delete from bakery.worker_commands command
     using doomed where command.id = doomed.id`,
    [WORKER_COMMAND_TERMINAL_RETENTION_SECONDS],
  );
  await transaction.query(
    `with doomed as materialized (
       select command_id from bakery.worker_command_ack_tombstones
       where expires_at <= clock_timestamp()
       order by expires_at, command_id limit ${RETENTION_SWEEP_BATCH_SIZE}
     )
     delete from bakery.worker_command_ack_tombstones tombstone
     using doomed where tombstone.command_id = doomed.command_id
       and not exists (
         select 1 from bakery.worker_commands command
         where command.id = tombstone.command_id
       )`,
  );
  // Artifact preview rows hold only hashes and are useless once expired.
  // Sessions go first; a grant goes only when no session still references it,
  // so a live session is never cascaded away by an expired grant.
  await transaction.query(
    `with doomed as materialized (
       select id from bakery.artifact_preview_sessions
       where expires_at <= clock_timestamp() -
         ($1::integer * interval '1 second')
       order by expires_at, id
       limit ${RETENTION_SWEEP_BATCH_SIZE}
       for update skip locked
     )
     delete from bakery.artifact_preview_sessions session
     using doomed where session.id = doomed.id`,
    [ARTIFACT_PREVIEW_RETENTION_GRACE_SECONDS],
  );
  await transaction.query(
    `with doomed as materialized (
       select grant_row.id from bakery.artifact_preview_grants grant_row
       where grant_row.expires_at <= clock_timestamp() -
         ($1::integer * interval '1 second')
         and not exists (
           select 1 from bakery.artifact_preview_sessions session
           where session.organization_id = grant_row.organization_id
             and session.grant_id = grant_row.id
         )
       order by grant_row.expires_at, grant_row.id
       limit ${RETENTION_SWEEP_BATCH_SIZE}
       for update of grant_row skip locked
     )
     delete from bakery.artifact_preview_grants grant_row
     using doomed where grant_row.id = doomed.id`,
    [ARTIFACT_PREVIEW_RETENTION_GRACE_SECONDS],
  );
}
