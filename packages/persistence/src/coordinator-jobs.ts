import {
  COORDINATOR_TURN_ACTION,
  CoordinatorTurnJobInputSchema,
} from "@bakery/contracts/coordinator-turn";
import { AgentVersionCreateConfigSchema } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { assertActionAgentPolicy } from "./action-admission.ts";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "./postgres.ts";

/** A coordinator turn gets exactly one worker attempt, so one model run. */
export const COORDINATOR_TURN_MAX_ATTEMPTS = 1;

/** Keys that would pin a coordinator job to a run or a repository. */
const FORBIDDEN_PIN_KEYS = [
  "runStepId",
  "run_step_id",
  "runId",
  "applicationId",
  "application_id",
  "repositoryId",
  "repository_id",
  "repositoryProfileId",
  "repositoryProfileRevision",
  "repositoryProfileDigest",
  "observationId",
  "observationDigest",
  "baseSha",
] as const;

export type EnqueueCoordinatorTurnJobInput = Readonly<{
  organizationId: string;
  turnId: string;
  /** Pinned agent version the turn froze at admission. */
  agentVersionId: string;
  /** Frozen agent version config, copied verbatim into the job. */
  agentConfig: Record<string, unknown>;
  /** `agentConfig.billing`, copied verbatim into the job. */
  billing: Record<string, unknown>;
  /** Held installation reservation that funds the turn. */
  installationReservationId: string;
  /** Job input; parsed against `CoordinatorTurnJobInputSchema`. */
  input: unknown;
}>;

export type EnqueuedCoordinatorTurnJob = Readonly<{
  jobId: string;
  created: boolean;
}>;

function reject(reason: string): never {
  throw new StandardError({ code: "VALIDATION_FAILED", params: { reason } });
}

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

/**
 * Get-or-create the single worker job of a turn. The job is standalone: no run
 * step, application, repository, profile or observation pin, so the
 * repository-profile identity rule holds for any conversation scope. Scope is
 * derived through `conversation_turn_id`. Caller reserves funding first and
 * passes the held reservation id.
 */
export async function enqueueCoordinatorTurnJob(
  transaction: PgTransactionClient,
  options: EnqueueCoordinatorTurnJobInput,
): Promise<EnqueuedCoordinatorTurnJob> {
  for (const key of FORBIDDEN_PIN_KEYS) {
    if (key in (options as Record<string, unknown>)) {
      reject("coordinator_job_pin_forbidden");
    }
  }
  const parsed = CoordinatorTurnJobInputSchema.safeParse(options.input);
  if (!parsed.success) reject("coordinator_job_input_invalid");
  if (parsed.data.turnId !== options.turnId) {
    reject("coordinator_job_turn_mismatch");
  }
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.jobs (
       organization_id, action, input, requirements, status, available_at,
       priority, max_attempts, agent_version_id, agent_config, skill_refs,
       billing, installation_reservation_id, conversation_turn_id
     ) values ($1, $2, $3::jsonb, $4::jsonb, 'queued', now(), 0, $5, $6,
               $7::jsonb, '[]'::jsonb, $8::jsonb, $9, $10)
     on conflict (organization_id, conversation_turn_id)
       where conversation_turn_id is not null
     do nothing
     returning id`,
    [
      options.organizationId,
      COORDINATOR_TURN_ACTION,
      JSON.stringify(parsed.data),
      JSON.stringify({ capabilities: ["model"] }),
      COORDINATOR_TURN_MAX_ATTEMPTS,
      options.agentVersionId,
      JSON.stringify(options.agentConfig),
      JSON.stringify(options.billing),
      options.installationReservationId,
      options.turnId,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { jobId: created.id, created: true };
  const existing = await transaction.query<{
    id: string;
    installationReservationId: string | null;
    agentVersionId: string | null;
  }>(
    `select id, installation_reservation_id as "installationReservationId",
            agent_version_id as "agentVersionId"
       from bakery.jobs
      where organization_id = $1 and conversation_turn_id = $2`,
    [options.organizationId, options.turnId],
  );
  const row = existing.rows[0];
  if (!row) conflict("coordinator_job_unavailable");
  if (
    row.installationReservationId !== options.installationReservationId ||
    row.agentVersionId !== options.agentVersionId
  ) conflict("coordinator_job_replay_mismatch");
  return { jobId: row.id, created: false };
}

export type CoordinatorTurnJobState = Readonly<{
  jobId: string;
  status: string;
  version: number;
  cancelRequestedAt: string | null;
  installationReservationId: string | null;
  /** Job age in ms by the database clock; deadlines key off it, not the caller. */
  ageMs: number;
  attempt:
    | Readonly<{
      id: string;
      status: string;
      /** Raw stored attempt result (output or fault), untouched. */
      result: unknown;
    }>
    | null;
}>;

/** Job status plus the latest attempt's stored result or fault. */
export async function readCoordinatorTurnJob(
  transaction: PgTransactionClient,
  options: Readonly<{ organizationId: string; turnId: string }>,
): Promise<CoordinatorTurnJobState | null> {
  const result = await transaction.query<{
    jobId: string;
    status: string;
    version: number;
    cancelRequestedAt: Date | string | null;
    installationReservationId: string | null;
    ageMs: string | number;
    attemptId: string | null;
    attemptStatus: string | null;
    attemptResult: unknown;
  }>(
    `select job.id as "jobId", job.status, job.version,
            job.cancel_requested_at as "cancelRequestedAt",
            job.installation_reservation_id as "installationReservationId",
            (extract(epoch from (clock_timestamp() - job.created_at)) * 1000)
              as "ageMs",
            attempt.id as "attemptId", attempt.status as "attemptStatus",
            attempt.result as "attemptResult"
       from bakery.jobs job
       left join lateral (
         select a.id, a.status, a.result
           from bakery.job_attempts a
          where a.organization_id = job.organization_id and a.job_id = job.id
          order by a.attempt_no desc
          limit 1
       ) attempt on true
      where job.organization_id = $1 and job.conversation_turn_id = $2`,
    [options.organizationId, options.turnId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    jobId: row.jobId,
    status: row.status,
    version: row.version,
    cancelRequestedAt: row.cancelRequestedAt === null
      ? null
      : new Date(row.cancelRequestedAt).toISOString(),
    installationReservationId: row.installationReservationId,
    ageMs: Math.max(0, Number(row.ageMs)),
    attempt: row.attemptId === null ? null : {
      id: row.attemptId,
      status: row.attemptStatus ?? "",
      result: row.attemptResult,
    },
  };
}

/**
 * Conditional `queued -> canceled`. False when a worker already claimed the
 * job (or it is terminal): the caller then keeps waiting.
 */
export async function cancelQueuedCoordinatorTurnJob(
  transaction: PgTransactionClient,
  options: Readonly<{ organizationId: string; turnId: string }>,
): Promise<boolean> {
  const result = await transaction.query(
    `update bakery.jobs
        set status = 'canceled', cancel_requested_at =
              coalesce(cancel_requested_at, current_timestamp),
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and conversation_turn_id = $2
        and status = 'queued'
      returning id`,
    [options.organizationId, options.turnId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Records cancel intent on a live (claimed) job through the existing
 * `cancel_requested_at` control column. This alone does not stop the model:
 * heartbeats deliver only `bakery.worker_commands` rows, so the caller also
 * pushes a worker cancel command (the server's
 * `pushCoordinatorCancelToWorker`). Without a live worker authority the run
 * finishes or times out, its late result is refused and lease reclaim ends the
 * job. False when the job is missing or already terminal.
 */
export async function requestCoordinatorTurnJobCancel(
  transaction: PgTransactionClient,
  options: Readonly<{ organizationId: string; turnId: string }>,
): Promise<boolean> {
  const result = await transaction.query(
    `update bakery.jobs
        set cancel_requested_at =
              coalesce(cancel_requested_at, current_timestamp),
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and conversation_turn_id = $2
        and status not in ('completed', 'failed', 'canceled')
      returning id`,
    [options.organizationId, options.turnId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Predicate the claim path uses: the job's funding is a held, installation
 * scope, run-less reservation with the turn's dedupe key and exactly the
 * billing ceiling, in the job's organization.
 */
export async function hasHeldCoordinatorTurnReservation(
  transaction: PgTransactionClient,
  options: Readonly<{ organizationId: string; jobId: string }>,
): Promise<boolean> {
  const result = await transaction.query<{ held: boolean }>(
    `select exists (
       select 1
         from bakery.jobs job
         join bakery.budget_reservations reservation
           on reservation.organization_id = job.organization_id
          and reservation.id = job.installation_reservation_id
         join bakery.budget_accounts account
           on account.id = reservation.budget_account_id
          and account.scope = 'installation'
        where job.organization_id = $1 and job.id = $2
          and job.action = $3
          and job.conversation_turn_id is not null
          and reservation.status = 'held'
          and reservation.run_step_id is null
          and reservation.dedupe_key =
                'coordinator-turn:' || job.conversation_turn_id::text
          and reservation.reserved_usd =
                ((job.billing ->> 'maxUsdReservation')::numeric)
     ) as held`,
    [options.organizationId, options.jobId, COORDINATOR_TURN_ACTION],
  );
  return result.rows[0]?.held === true;
}

/** Sorted-key JSON so JSONB round-trips compare byte for byte. */
function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(entry).sort()) {
        const child = (entry as Record<string, unknown>)[key];
        if (child !== undefined) sorted[key] = normalize(child);
      }
      return sorted;
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

/**
 * Claim-time admission for a `coordinator.turn` job. Throws STATE_CONFLICT
 * with a reason unless every rule holds; returns the capabilities the host
 * must advertise. `model_agent_required`, `model_billing_required` and
 * `agent_action_capability_denied` keep the meaning they have for run jobs.
 */
export async function admitCoordinatorTurnJob(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
): Promise<Readonly<{ capabilities: readonly string[] }>> {
  const result = await transaction.query<{
    action: string;
    input: unknown;
    agentVersionId: string | null;
    agentConfig: unknown;
    billing: unknown;
    conversationTurnId: string | null;
    turnStatus: string;
    turnAgentVersionId: string | null;
    versionConfig: unknown;
    versionOk: boolean;
  }>(
    `select job.action, job.input, job.agent_version_id as "agentVersionId",
            job.agent_config as "agentConfig", job.billing,
            job.conversation_turn_id as "conversationTurnId",
            turn.status as "turnStatus",
            turn.agent_version_id as "turnAgentVersionId",
            version.config as "versionConfig",
            coalesce(definition.enabled and definition.slug = 'coordinator'
              and definition.active_version_id = version.id, false)
              as "versionOk"
       from bakery.jobs job
       join bakery.conversation_turns turn
         on turn.organization_id = job.organization_id
        and turn.id = job.conversation_turn_id
       left join bakery.agent_versions version
         on version.organization_id = job.organization_id
        and version.id = job.agent_version_id
       left join bakery.agent_definitions definition
         on definition.organization_id = version.organization_id
        and definition.id = version.agent_id
      where job.organization_id = $1 and job.id = $2
        and job.action = $3 and job.run_step_id is null
        and job.conversation_turn_id is not null
      for share of job`,
    [organizationId, jobId, COORDINATOR_TURN_ACTION],
  );
  const row = result.rows[0];
  if (!row) conflict("coordinator_turn_unavailable");
  if (row.agentVersionId === null) assertActionAgentPolicy(["model"], null);
  if (row.turnStatus !== "active") conflict("coordinator_turn_not_active");
  if (row.agentVersionId !== row.turnAgentVersionId || !row.versionOk) {
    conflict("coordinator_agent_pin_mismatch");
  }
  if (canonicalJson(row.agentConfig) !== canonicalJson(row.versionConfig)) {
    conflict("coordinator_agent_config_mismatch");
  }
  const config = AgentVersionCreateConfigSchema.safeParse(row.agentConfig);
  if (!config.success) conflict("coordinator_agent_config_mismatch");
  assertActionAgentPolicy(["model"], config.data);
  if (config.data.harness !== "claude_code") {
    conflict("coordinator_harness_unsupported");
  }
  if (canonicalJson(row.billing) !== canonicalJson(config.data.billing)) {
    conflict("coordinator_billing_mismatch");
  }
  if (config.data.billing?.billingRoute !== "subscription") {
    conflict("coordinator_billing_unsupported");
  }
  const input = CoordinatorTurnJobInputSchema.safeParse(row.input);
  if (!input.success || input.data.turnId !== row.conversationTurnId) {
    conflict("coordinator_job_input_invalid");
  }
  if (
    !await hasHeldCoordinatorTurnReservation(transaction, {
      organizationId,
      jobId,
    })
  ) conflict("coordinator_funding_unavailable");
  return { capabilities: ["model"] };
}

/**
 * Returns the job's held run-less installation reservation to the account.
 * Called in the transaction that makes the job terminal, so a terminal
 * coordinator job never keeps funds reserved. Idempotent: false when the
 * reservation is gone, already released, or settled (never touched then).
 * No external-effect guard here: an effect needs a run step, and this
 * reservation is run-less, so no effect can name it.
 */
export async function releaseCoordinatorJobReservation(
  transaction: PgTransactionClient,
  options: Readonly<{ organizationId: string; jobId: string }>,
): Promise<boolean> {
  const found = await transaction.query<{
    reservationId: string;
    accountId: string;
  }>(
    `select reservation.id as "reservationId",
            reservation.budget_account_id as "accountId"
       from bakery.jobs job
       join bakery.budget_reservations reservation
         on reservation.organization_id = job.organization_id
        and reservation.id = job.installation_reservation_id
      where job.organization_id = $1 and job.id = $2
        and job.action = 'coordinator.turn'
        and job.conversation_turn_id is not null
        and reservation.run_step_id is null`,
    [options.organizationId, options.jobId],
  );
  const seen = found.rows[0];
  if (!seen) return false;
  await transaction.query(
    `select id from bakery.budget_accounts where id = $1 for update`,
    [seen.accountId],
  );
  const locked = await transaction.query<{ reservedUsd: string }>(
    `select reserved_usd::text as "reservedUsd"
       from bakery.budget_reservations
      where organization_id = $1 and id = $2 and status = 'held'
      for update`,
    [options.organizationId, seen.reservationId],
  );
  const held = locked.rows[0];
  if (!held) return false;
  const account = await transaction.query(
    `update bakery.budget_accounts
        set reserved_usd = reserved_usd - $2::numeric,
            updated_at = now(), version = version + 1
      where id = $1 and reserved_usd >= $2::numeric
      returning id`,
    [seen.accountId, held.reservedUsd],
  );
  if (!account.rows[0]) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "budget_reservation_balance_invalid" },
    });
  }
  await transaction.query(
    `update bakery.budget_reservations
        set status = 'released', updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and status = 'held'`,
    [options.organizationId, seen.reservationId],
  );
  return true;
}

export type CoordinatorJobSweep = Readonly<{
  /** Non-terminal jobs whose turn is terminal: canceled or cancel requested. */
  orphansCanceled: number;
  /** Terminal jobs that still held funding: released. */
  reservationsReleased: number;
  /** Jobs whose transaction threw; rolled back and left for the next run. */
  failures: number;
}>;

/** Server-side actions the persistence layer cannot perform itself. */
export type CoordinatorSweepHooks = Readonly<{
  /**
   * Runs after a claimed job got a cancel request, outside that row's
   * transaction. The server uses it to push a cancel command to the worker.
   * A throw counts as a row failure.
   */
  onCancelRequested?: (
    job: Readonly<{ organizationId: string; turnId: string; jobId: string }>,
  ) => Promise<void>;
}>;

/**
 * Recovery sweep. Cancels coordinator jobs whose turn already ended (a queued
 * job is canceled outright, a claimed one gets a cancel request) and returns
 * funding still held by terminal jobs. Idempotent; one transaction per job so
 * a bad row is skipped (counted in `failures`) and never blocks the rest.
 *
 * `limit` is the page size, not a cap. Pages follow a `(created_at, id)`
 * keyset, so rows that keep failing stay behind the cursor instead of at the
 * head of the next query, and every eligible row is visited once per run. A
 * counter moves only after the row's transaction commits, so a rolled-back
 * cancel is never reported.
 */
export async function sweepCoordinatorTurnJobs(
  database: PgDatabase,
  limit = 50,
  hooks: CoordinatorSweepHooks = {},
): Promise<CoordinatorJobSweep> {
  type Candidate = {
    organizationId: string;
    jobId: string;
    turnId: string;
    jobStatus: string;
    turnStatus: string;
    createdAtCursor: string;
  };
  let orphansCanceled = 0;
  let reservationsReleased = 0;
  let failures = 0;
  let after: { createdAt: string; id: string } | null = null;
  for (;;) {
    const found: { rows: Candidate[] } = await database.query<Candidate>(
      `select job.organization_id as "organizationId", job.id as "jobId",
              job.conversation_turn_id as "turnId", job.status as "jobStatus",
              turn.status as "turnStatus",
              to_char(job.created_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAtCursor"
         from bakery.jobs job
         join bakery.conversation_turns turn
           on turn.organization_id = job.organization_id
          and turn.id = job.conversation_turn_id
        where job.action = $1 and job.conversation_turn_id is not null
          and ($3::timestamptz is null
            or (job.created_at, job.id) > ($3::timestamptz, $4::uuid))
          and (
            (job.status not in ('completed', 'failed', 'canceled')
              and turn.status in ('completed', 'failed', 'canceled')
              and job.cancel_requested_at is null)
            or (job.status in ('completed', 'failed', 'canceled')
              and exists (
                select 1 from bakery.budget_reservations reservation
                 where reservation.organization_id = job.organization_id
                   and reservation.id = job.installation_reservation_id
                   and reservation.status = 'held'))
            or (job.status = 'queued'
              and turn.status in ('completed', 'failed', 'canceled'))
          )
        order by job.created_at asc, job.id asc
        limit $2`,
      [
        COORDINATOR_TURN_ACTION,
        limit,
        after?.createdAt ?? null,
        after?.id ?? null,
      ],
    );
    for (const row of found.rows) {
      try {
        const done = await withPgTransaction(database, async (transaction) => {
          let canceled = 0;
          let released = 0;
          let requested = false;
          const terminal = ["completed", "failed", "canceled"].includes(
            row.jobStatus,
          );
          // Funding returns only once the job cannot run: terminal already, or
          // canceled from queued here. A claimed job keeps its hold while the
          // model may still run; lease reclaim releases it later.
          let releasable = terminal;
          if (!terminal) {
            const scope = {
              organizationId: row.organizationId,
              turnId: row.turnId,
            };
            if (await cancelQueuedCoordinatorTurnJob(transaction, scope)) {
              canceled++;
              releasable = true;
            } else if (
              await requestCoordinatorTurnJobCancel(transaction, scope)
            ) {
              canceled++;
              requested = true;
            }
          }
          if (
            releasable &&
            await releaseCoordinatorJobReservation(transaction, {
              organizationId: row.organizationId,
              jobId: row.jobId,
            })
          ) released++;
          return { canceled, released, requested };
        });
        orphansCanceled += done.canceled;
        reservationsReleased += done.released;
        if (done.requested && hooks.onCancelRequested) {
          await hooks.onCancelRequested({
            organizationId: row.organizationId,
            turnId: row.turnId,
            jobId: row.jobId,
          });
        }
      } catch (error) {
        failures++;
        console.error(
          `coordinator sweep: job ${row.jobId} skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const last = found.rows.at(-1);
    if (!last || found.rows.length < limit) break;
    after = { createdAt: last.createdAtCursor, id: last.jobId };
  }
  return { orphansCanceled, reservationsReleased, failures };
}
