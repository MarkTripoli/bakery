import type { BudgetRuntimeConfig } from "@bakery/config";
import { AgentVersionCreateConfigSchema } from "@bakery/contracts/contracts";
import {
  buildCoordinatorTurnJobInput,
  CoordinatorTurnJobOutputSchema,
} from "@bakery/contracts/coordinator-turn";
import { StandardError } from "@bakery/contracts/http";
import {
  admitCoordinatorTurnJob,
  cancelQueuedCoordinatorTurnJob,
  connectivityState,
  type CoordinatorTurnJobState,
  dispatchGate,
  enqueueCoordinatorTurnJob,
  type PgDatabase,
  type PgTransactionClient,
  readCoordinatorTurnJob,
  releaseCoordinatorJobReservation,
  requestCoordinatorTurnJobCancel,
  type StoredCheck,
  withPgTransaction,
} from "@bakery/persistence";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { enqueueWorkerControlCommand } from "../execution/coordination.ts";
import { reserveCoordinatorTurn } from "../work/budget.ts";
import type {
  CoordinatorTurnExecutor,
  CoordinatorTurnInput,
  CoordinatorTurnResult,
} from "./coordinator.ts";

export const DEFAULT_COORDINATOR_CLAIM_TIMEOUT_MS = 60_000;
export const DEFAULT_COORDINATOR_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 1_000;

export type WorkerCoordinatorOptions = Readonly<{
  database: PgDatabase;
  /** Installation budget policy; absent funds nothing (`coordinator_budget_unconfigured`). */
  budget: BudgetRuntimeConfig | undefined;
  /** A queued job nobody claims within this many ms is canceled. */
  claimTimeoutMs: number;
  /** Hard bound on one turn's wait for the worker, ms; exceeds the claim timeout. */
  turnTimeoutMs: number;
  pollMs?: number;
  /** Test seam: runs just before the claim-deadline conditional cancel. */
  beforeQueuedCancel?: () => Promise<void>;
  /** Test seam: replaces `pushCoordinatorCancelToWorker` for a claimed job. */
  pushCancel?: (
    job: Readonly<{ organizationId: string; turnId: string; jobId: string }>,
  ) => Promise<boolean>;
}>;

type Failure = Extract<CoordinatorTurnResult, { status: "failed" }>;

function failure(code: string, detail: string): Failure {
  return { status: "failed", code, detail };
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

/**
 * Asks the worker running a claimed coordinator job to stop. Uses the run
 * control path (`enqueueWorkerControlCommand`): it cancels the live attempt
 * and the job, releases the funding, and queues a `cancel` command that the
 * host's next heartbeat delivers, so the model process is killed and the
 * host's busy latch frees at once. Runs in its own transaction so a refusal
 * leaves no partial write. With no live worker authority (no attempt, stale
 * session, expired lease) or an already terminal job the cancel request on
 * the job stays and lease reclaim finishes it. Returns whether a command was
 * queued.
 */
export async function pushCoordinatorCancelToWorker(
  database: PgDatabase,
  options: Readonly<{ organizationId: string; turnId: string; jobId: string }>,
): Promise<boolean> {
  try {
    return await withPgTransaction(database, async (tx) => {
      const live = await tx.query<{ id: string }>(
        `select attempt.id
           from bakery.job_attempts attempt
           join bakery.jobs job
             on job.organization_id = attempt.organization_id
            and job.id = attempt.job_id
          where attempt.organization_id = $1 and attempt.job_id = $2
            and attempt.status in ('leased', 'running', 'canceling')
            and attempt.fence = job.current_fence
          order by attempt.attempt_no desc, attempt.id desc
          limit 1`,
        [options.organizationId, options.jobId],
      );
      const attemptId = live.rows[0]?.id;
      if (!attemptId) return false;
      await enqueueWorkerControlCommand(tx, {
        organizationId: options.organizationId,
        attemptId,
        action: "cancel",
        reason: "coordinator_turn_canceled",
        idempotencyKey: `coordinator-cancel:${options.turnId}`,
        requestDigest: await sha256Hex(canonicalJson({
          turnId: options.turnId,
          attemptId,
          action: "cancel",
        })),
        traceId: crypto.randomUUID(),
      });
      return true;
    });
  } catch (error) {
    if (
      error instanceof StandardError &&
      (error.code === "STATE_CONFLICT" || error.code === "ALREADY_TERMINAL" ||
        error.code === "RESOURCE_NOT_FOUND")
    ) return false;
    throw error;
  }
}

function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof StandardError)) return undefined;
  const reason = error.params?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Maps a funding or enqueue refusal to the stable turn failure. */
function fundingFailure(error: unknown): Failure | undefined {
  const reason = reasonOf(error);
  switch (reason) {
    case "coordinator_billing_unsupported":
      return failure(
        "coordinator_billing_unsupported",
        "Coordinator turns support only the subscription billing route",
      );
    case "coordinator_budget_unconfigured":
    case "budget_policy_unavailable":
    case "budget_policy_invalid":
    case "billing_configuration_missing":
    case "budget_pricing_unavailable":
      return failure(
        "coordinator_budget_unconfigured",
        `Coordinator funding is not configured (${reason})`,
      );
    case "budget_cap_exceeded":
      return failure(
        "coordinator_budget_exceeded",
        "The installation budget cannot fund another coordinator turn",
      );
    default:
      return reason === undefined ? undefined : failure(
        "coordinator_failed",
        `Coordinator turn could not be dispatched (${reason})`,
      );
  }
}

type HostRow = {
  id: string;
  status: string;
  desired_mode: string;
  last_heartbeat_at: Date | string | null;
  credential_generation: number;
  inventory_revision: number;
  capabilities: unknown;
};

type CheckRow = {
  worker_host_id: string;
  check_id: string;
  status: string;
  reason: string | null;
  host_generation: number;
  inventory_revision: number;
  expires_at: Date | string;
};

export type CoordinatorHostState = Readonly<{
  /** Non-archived hosts that advertise the model capability. */
  modelHosts: number;
  /** Of those, hosts whose heartbeat is current. */
  onlineHosts: number;
  /** Online model hosts whose `capability:model` check currently fails. */
  credentialBlockedHosts: number;
}>;

/**
 * Read-only view of who could claim a coordinator turn, from the same dispatch
 * rule the claim gate uses. A host advertises its supported actions only when
 * it claims, so the model capability stands in for it here.
 */
export async function readCoordinatorHostState(
  database: PgDatabase,
  organizationId: string,
): Promise<CoordinatorHostState> {
  const clock = await database.query<{ now: Date }>(
    "select clock_timestamp() as now",
  );
  const now = clock.rows[0]?.now ?? new Date();
  const hosts = await database.query<HostRow>(
    `select id, status, desired_mode, last_heartbeat_at, credential_generation,
            inventory_revision, capabilities
       from bakery.worker_hosts
      where organization_id = $1 and archived_at is null
        and status <> 'revoked'`,
    [organizationId],
  );
  const modelHosts = hosts.rows.filter((host) =>
    Array.isArray(host.capabilities) && host.capabilities.includes("model")
  );
  if (modelHosts.length === 0) {
    return { modelHosts: 0, onlineHosts: 0, credentialBlockedHosts: 0 };
  }
  const checks = await database.query<CheckRow>(
    `select worker_host_id, check_id, status, reason, host_generation,
            inventory_revision, expires_at
       from bakery.worker_checks
      where worker_host_id = any($1::uuid[])`,
    [modelHosts.map((host) => host.id)],
  );
  let onlineHosts = 0;
  let credentialBlockedHosts = 0;
  for (const host of modelHosts) {
    const connectivity = connectivityState(host.last_heartbeat_at, now);
    if (connectivity !== "online") continue;
    onlineHosts++;
    const stored: StoredCheck[] = checks.rows
      .filter((row) => row.worker_host_id === host.id)
      .map((row) => ({
        checkId: row.check_id,
        componentKey: null,
        status: row.status,
        reason: row.reason,
        hostGeneration: row.host_generation,
        inventoryRevision: row.inventory_revision,
        expiresAt: row.expires_at,
      }));
    const gate = dispatchGate({
      now,
      connectivity,
      status: host.status,
      desiredMode: host.desired_mode,
      credentialGeneration: host.credential_generation,
      inventoryRevision: host.inventory_revision,
      checks: stored,
    });
    if (gate.blockedCapabilities.includes("model")) credentialBlockedHosts++;
  }
  return { modelHosts: modelHosts.length, onlineHosts, credentialBlockedHosts };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function faultCode(attemptResult: unknown): string | undefined {
  if (attemptResult === null || typeof attemptResult !== "object") {
    return undefined;
  }
  const fault = (attemptResult as { fault?: unknown }).fault;
  if (fault === null || typeof fault !== "object") return undefined;
  const code = (fault as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Maps a terminal job to the turn outcome; no effect leaves an invalid result. */
function terminalOutcome(
  state: CoordinatorTurnJobState,
): CoordinatorTurnResult {
  if (state.status === "completed") {
    const payload = state.attempt?.result;
    const result = payload !== null && typeof payload === "object"
      ? (payload as { result?: unknown }).result
      : undefined;
    const parsed = CoordinatorTurnJobOutputSchema.safeParse(result);
    if (!parsed.success) {
      return failure(
        "coordinator_output_invalid",
        "The coordinator worker returned an answer that failed validation; nothing was applied",
      );
    }
    return { status: "completed", effects: parsed.data.effects };
  }
  if (state.status === "canceled") {
    return failure(
      "coordinator_aborted",
      "The coordinator worker job was canceled",
    );
  }
  const code = faultCode(state.attempt?.result);
  switch (code) {
    case "CLAUDE_COORDINATOR_BUSY":
      return failure(
        "coordinator_worker_busy",
        "The worker host is busy with another harness job; ask again when it ends",
      );
    case "CLAUDE_COORDINATOR_CREDENTIAL_UNAVAILABLE":
      return failure(
        "coordinator_credential_unavailable",
        "The worker host has no usable model credential",
      );
    case "CLAUDE_COORDINATOR_TIMEOUT":
      return failure(
        "coordinator_timeout",
        "The coordinator model run exceeded its time limit",
      );
    case "CLAUDE_COORDINATOR_OUTPUT_INVALID":
      return failure(
        "coordinator_output_invalid",
        "The coordinator model produced no valid answer; nothing was applied",
      );
    default: {
      const lost = state.attempt?.status === "lost";
      return failure(
        "coordinator_failed",
        lost
          ? "The worker lost the coordinator attempt (attempt_lost)"
          : code
          ? `The coordinator worker failed (${code})`
          : "The coordinator worker job failed",
      );
    }
  }
}

/**
 * Production coordinator: dispatches each turn as one `coordinator.turn`
 * worker job and applies nothing itself; Bakery's turn runtime applies the
 * returned effects under its own fence. Reattaches to the turn's existing job
 * on a retry, so a turn makes at most one model run.
 */
export function createWorkerCoordinatorExecutor(
  options: WorkerCoordinatorOptions,
): CoordinatorTurnExecutor {
  const { database } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const readJob = (organizationId: string, turnId: string) =>
    withPgTransaction(
      database,
      (tx) => readCoordinatorTurnJob(tx, { organizationId, turnId }),
    );

  /** Idempotent: terminal jobs hand their funding back. */
  const releaseFunding = (organizationId: string, jobId: string) =>
    withPgTransaction(
      database,
      (tx) => releaseCoordinatorJobReservation(tx, { organizationId, jobId }),
    );

  /**
   * Cancels a queued job and frees its funding, else records cancel intent on
   * a claimed one and asks its worker to stop. True only when the queued
   * cancel changed a row.
   */
  async function cancelJob(
    organizationId: string,
    turnId: string,
    jobId: string,
  ): Promise<boolean> {
    const canceled = await withPgTransaction(database, async (tx) => {
      const queued = await cancelQueuedCoordinatorTurnJob(tx, {
        organizationId,
        turnId,
      });
      if (queued) {
        await releaseCoordinatorJobReservation(tx, { organizationId, jobId });
        return true;
      }
      await requestCoordinatorTurnJobCancel(tx, { organizationId, turnId });
      return false;
    });
    if (!canceled) {
      // Best effort: the cancel request above is committed, and lease reclaim
      // ends the job if the push fails, so a push fault never replaces the
      // turn's own failure (timeout or abort).
      const job = { organizationId, turnId, jobId };
      try {
        await (options.pushCancel ??
          ((target) => pushCoordinatorCancelToWorker(database, target)))(job);
      } catch (error) {
        console.error(
          `coordinator cancel push for job ${jobId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return canceled;
  }

  /** Cancels only a queued job; false means a worker already holds it. */
  async function cancelQueuedOnly(
    organizationId: string,
    turnId: string,
    jobId: string,
  ): Promise<boolean> {
    if (options.beforeQueuedCancel) await options.beforeQueuedCancel();
    return await withPgTransaction(database, async (tx) => {
      const canceled = await cancelQueuedCoordinatorTurnJob(tx, {
        organizationId,
        turnId,
      });
      if (canceled) {
        await releaseCoordinatorJobReservation(tx, { organizationId, jobId });
      }
      return canceled;
    });
  }

  async function dispatch(
    input: CoordinatorTurnInput,
  ): Promise<Failure | undefined> {
    const config = AgentVersionCreateConfigSchema.safeParse(
      input.agentVersion.config,
    );
    if (!config.success) {
      return failure(
        "coordinator_unconfigured",
        "The pinned coordinator agent version has an invalid config",
      );
    }
    if (config.data.harness !== "claude_code") {
      return failure(
        "coordinator_harness_unsupported",
        "Live coordinator turns run on the claude_code harness only",
      );
    }
    const rawConfig = input.agentVersion.config as Record<string, unknown>;
    const rawBilling = rawConfig.billing;
    if (config.data.billing?.billingRoute !== "subscription") {
      return failure(
        "coordinator_billing_unsupported",
        "Coordinator turns support only the subscription billing route",
      );
    }
    try {
      await withPgTransaction(
        database,
        async (tx: PgTransactionClient) => {
          const reservation = await reserveCoordinatorTurn(tx, {
            organizationId: input.organizationId,
            turnId: input.turnId,
            agentVersionId: input.agentVersion.id,
            billing: rawBilling,
            policy: options.budget,
          });
          await enqueueCoordinatorTurnJob(tx, {
            organizationId: input.organizationId,
            turnId: input.turnId,
            agentVersionId: input.agentVersion.id,
            agentConfig: rawConfig,
            billing: rawBilling as Record<string, unknown>,
            installationReservationId: reservation.reservationId,
            input: buildCoordinatorTurnJobInput(input),
          });
        },
      );
    } catch (error) {
      const mapped = fundingFailure(error);
      if (mapped) return mapped;
      throw error;
    }
    return undefined;
  }

  async function unavailableDetail(
    organizationId: string,
    waitedMs: number,
  ): Promise<string> {
    const seconds = Math.round(waitedMs / 1000);
    try {
      const hosts = await readCoordinatorHostState(database, organizationId);
      if (hosts.modelHosts === 0) {
        return `No worker host with the model capability is enrolled; nothing claimed the turn in ${seconds}s`;
      }
      if (hosts.onlineHosts === 0) {
        return `No model worker host is online (${hosts.modelHosts} enrolled); nothing claimed the turn in ${seconds}s`;
      }
      return `${hosts.onlineHosts} online model worker host(s) did not claim the turn in ${seconds}s`;
    } catch {
      return `No worker claimed the coordinator turn in ${seconds}s`;
    }
  }

  /**
   * Re-runs claim admission for a job nobody claimed. A refusal reason (pin
   * mismatch, funding or config mismatch) names the true cause; otherwise
   * undefined and the caller reports the missing worker.
   */
  async function admissionRefusal(
    organizationId: string,
    jobId: string,
  ): Promise<string | undefined> {
    try {
      await withPgTransaction(
        database,
        (tx) => admitCoordinatorTurnJob(tx, organizationId, jobId),
      );
      return undefined;
    } catch (error) {
      return reasonOf(error);
    }
  }

  /** The signal aborted: user cancel and lease takeover look the same. */
  async function onAbort(
    organizationId: string,
    turnId: string,
    jobId: string,
  ): Promise<Failure> {
    try {
      const turn = await database.query<{ status: string }>(
        `select status from bakery.conversation_turns
          where organization_id = $1 and id = $2`,
        [organizationId, turnId],
      );
      const status = turn.rows[0]?.status;
      // A takeover leaves the turn active or queued under a newer version:
      // the live job stays for the next claimer to reattach to.
      if (
        status === undefined || status === "cancel_requested" ||
        isTerminal(status)
      ) {
        await cancelJob(organizationId, turnId, jobId);
      }
    } catch {
      // Recovery sweeps orphan jobs; never mask the abort.
    }
    return failure("coordinator_aborted", "Coordinator turn was aborted");
  }

  return {
    kind: "worker",
    async execute(input, signal) {
      const organizationId = input.organizationId;
      const turnId = input.turnId;
      let state = await readJob(organizationId, turnId);
      if (!state) {
        const refused = await dispatch(input);
        if (refused) return refused;
        state = await readJob(organizationId, turnId);
      }
      if (!state) {
        return failure(
          "coordinator_failed",
          "The coordinator job could not be created",
        );
      }
      for (;;) {
        if (signal.aborted) {
          return await onAbort(organizationId, turnId, state.jobId);
        }
        const current = await readJob(organizationId, turnId);
        if (!current) {
          return failure("coordinator_failed", "The coordinator job vanished");
        }
        state = current;
        if (isTerminal(state.status)) {
          await releaseFunding(organizationId, state.jobId);
          return terminalOutcome(state);
        }
        // Both deadlines run from the job's creation, so Inngest step retries
        // and lease takeovers never restart them.
        const waited = state.ageMs;
        if (state.status === "queued") {
          const hosts = await readCoordinatorHostState(
            database,
            organizationId,
          );
          if (
            hosts.onlineHosts > 0 &&
            hosts.credentialBlockedHosts === hosts.onlineHosts
          ) {
            if (await cancelQueuedOnly(organizationId, turnId, state.jobId)) {
              return failure(
                "coordinator_credential_unavailable",
                "Every online worker host fails its model credential check",
              );
            }
          } else if (waited >= options.claimTimeoutMs) {
            const refusal = await admissionRefusal(
              organizationId,
              state.jobId,
            );
            if (await cancelQueuedOnly(organizationId, turnId, state.jobId)) {
              if (refusal) {
                return failure(
                  "coordinator_unconfigured",
                  `The coordinator job is not claimable: ${refusal}`,
                );
              }
              return failure(
                "coordinator_worker_unavailable",
                await unavailableDetail(organizationId, waited),
              );
            }
          }
        }
        if (waited >= options.turnTimeoutMs) {
          await cancelJob(organizationId, turnId, state.jobId);
          return failure(
            "coordinator_timeout",
            `The coordinator turn did not finish within ${
              Math.round(options.turnTimeoutMs / 1000)
            }s`,
          );
        }
        await sleep(pollMs, signal);
      }
    },
  };
}
