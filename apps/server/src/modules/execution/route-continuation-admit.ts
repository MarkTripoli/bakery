import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  nextAggregateVersion,
} from "@bakery/persistence";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  type CandidateRouteRow,
  ineligibleReason,
  jobBillingRoute,
  readRoutePricing,
} from "./route-continuations.ts";

/**
 * `routeContinuations.admit` (#26 slice 6b/6c): continue one stalled step on
 * another route, with exactly one winner however many submissions race.
 *
 * ## What a continuation changes, and why it is one transaction
 *
 * The runtime consumes a job's harness and `billing` (provider, model, billing
 * route, account, pricing snapshot) and nothing about a route's endpoint, so a
 * continuation only does anything when the *pin* changes. Moving the pin has three
 * parts that are wrong apart:
 *
 * - the old producer must stop (the live attempt is fenced: `lost`, and the job's
 *   fence advances, so its next heartbeat, event or result is `LEASE_FENCED`),
 * - the job must be claimable again on the new pin (`queued`, and the pin written),
 * - the step's budget reservation must describe the new pin, or the new attempt's
 *   usage would fail settlement against an intent for a provider it never used.
 *
 * Each is wrong without the others: a requeued job on its old pin runs on the route
 * that is down, and a changed pin under the old reservation cannot be settled. So
 * they happen together, under the same locks, or not at all.
 *
 * ## The reservation is re-priced in place, not replaced
 *
 * The step keeps its one intent and its two reservations; only the identity columns
 * move (provider, model, billing account and route, pricing snapshot). The dedupe
 * key does not change, so claim, settlement and the reconcile sweeps are untouched,
 * and nothing is left held for a release path to find. The amounts do not change
 * either, so no account's `reserved_usd` moves: the invariant a test pins.
 *
 * That is only sound while nothing has been spent, so it is only done then. A call
 * that was bound (dispatched), a usage record, or a live external effect means spend
 * may be in flight: that is `spend_in_flight`, nothing is committed, and the
 * existing provider-receipt reconciliation settles it, after which the choice can be
 * offered again. Unknown usage stays reserved and reconcilable.
 *
 * ## Refusals commit nothing
 *
 * Every refusal below is a thrown error before or instead of a write, and the whole
 * transaction rolls back, so a stale or refused submission leaves no trace. Each is
 * named so a person can be told what changed:
 *
 * - `PRECONDITION_FAILED`: the run changed since the offer,
 * - `run_not_active`, `incident_not_current`, `step_not_pinned_to_route`,
 * - `target_route_not_active`, `target_different_harness`, `target_route_open`,
 *   `target_pin_unchanged`, `target_pricing_unavailable`,
 * - `awaiting_reconciliation`, `cancel_requested`, `attempt_budget_exhausted`,
 * - `job_not_funded`, `spend_in_flight`, `already_continued`.
 *
 * ## Lock order
 *
 * Attempts, then jobs, then the run. The worker cancel path locks an attempt before
 * its job, and the no-attempt cancel locks jobs before the run, so this order
 * agrees with both and cannot deadlock against either. Everything is re-read under
 * its lock: a cancel that won the race is seen as `cancel_requested` or a terminal
 * run, and loses nothing.
 */

type Admit = z.output<typeof contractSchemas.RouteContinuationAdmit>;
type Admitted = z.output<typeof contractSchemas.RouteContinuation>;
type Pin = Admitted["previousPin"];

const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "canceled",
  "blocked",
  "needs_human",
];
const TERMINAL_JOB_STATUSES = ["completed", "failed", "canceled"];
const LIVE_ATTEMPT_STATUSES = ["leased", "running", "canceling"];
const LIVE_EFFECT_STATUSES = ["prepared", "submitted", "uncertain"];
const POSTGRES_UNIQUE_VIOLATION = "23505";

const refuse = (reason: string) =>
  new StandardError({ code: "STATE_CONFLICT", params: { reason } });

type JobRow = {
  id: string;
  status: string;
  current_fence: number | string;
  max_attempts: number;
  cancel_requested_at: Date | string | null;
  billing: Record<string, unknown> | null;
  agent_config: Record<string, unknown> | null;
  installation_reservation_id: string | null;
};

type RouteRow = CandidateRouteRow & {
  organization_id?: string;
  incident_id: string | null;
  billing_route: string;
  provider_account_id: string | null;
};

function pinOf(billing: Record<string, unknown>): Pin {
  return {
    provider: String(billing.provider),
    model: String(billing.model),
    billingRoute: billing.billingRoute as Pin["billingRoute"],
    billingAccountId: String(billing.billingAccountId),
  };
}

export async function admitRouteContinuation(
  context: ActionContext,
  input: unknown,
): Promise<Admitted> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const runId = context.params.id;
  if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const value = input as Admit;

  // 1. Attempts, then jobs, of the step (the lock order above). Nothing is
  //    written until every check has passed.
  const attempts = (await transaction.query<
    { id: string; job_id: string; status: string }
  >(
    `select a.id, a.job_id, a.status
       from bakery.job_attempts as a
       join bakery.jobs as j
         on j.organization_id = a.organization_id and j.id = a.job_id
       join bakery.run_steps as s
         on s.organization_id = j.organization_id and s.id = j.run_step_id
      where a.organization_id = $1 and s.run_id = $2 and s.id = $3
      order by a.id
        for update of a`,
    [organizationId, runId, value.runStepId],
  )).rows;
  const jobs = (await transaction.query<JobRow>(
    `select j.id, j.status, j.current_fence, j.max_attempts,
            j.cancel_requested_at, j.billing, j.agent_config,
            j.installation_reservation_id
       from bakery.jobs as j
       join bakery.run_steps as s
         on s.organization_id = j.organization_id and s.id = j.run_step_id
      where j.organization_id = $1 and s.run_id = $2 and s.id = $3
      order by j.id
        for update of j`,
    [organizationId, runId, value.runStepId],
  )).rows;
  // The step is looked up inside the run and the organization, so another
  // organization's run, or a step of another run, is absent.
  if (jobs.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }

  // 2. The run, under its lock. A cancel that won shows as a terminal run; a change
  //    since the offer shows as a different version.
  const run = (await transaction.query<{ status: string; version: number }>(
    `select status, version from bakery.workflow_runs
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, runId],
  )).rows[0];
  if (!run) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (TERMINAL_RUN_STATUSES.includes(run.status)) {
    throw refuse("run_not_active");
  }
  if (run.version !== value.runVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }

  // 3. The incident and the route it is on, under their locks. Recovered,
  //    superseded, or a newer generation is a stale choice: nothing is committed.
  const incident = (await transaction.query<
    { id: string; route_id: string; generation: number; status: string }
  >(
    `select id, route_id, generation, status from bakery.provider_incidents
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, value.incidentId],
  )).rows[0];
  if (
    !incident || incident.status !== "open" ||
    incident.generation !== value.incidentGeneration
  ) throw refuse("incident_not_current");
  const source =
    (await transaction.query<RouteRow & { provider: string; model: string }>(
      `select id, provider, model, harness, billing_route, status, health,
            incident_id, provider_account_id
       from bakery.provider_routes
      where organization_id = $1 and id = $2
        for update`,
      [organizationId, incident.route_id],
    )).rows[0];
  if (
    !source || source.status !== "active" || source.incident_id !== incident.id
  ) {
    throw refuse("incident_not_current");
  }

  // 4. The jobs still pinned to that route. If the pin moved since the offer, the
  //    offer is stale.
  const moving = jobs.filter((job) => {
    if (TERMINAL_JOB_STATUSES.includes(job.status)) return false;
    const billing = job.billing;
    if (billing === null) return false;
    return billing.provider === source.provider &&
      billing.model === source.model &&
      job.agent_config?.harness === source.harness &&
      jobBillingRoute(source.billing_route) === billing.billingRoute;
  });
  if (moving.length === 0) throw refuse("step_not_pinned_to_route");

  // 5. The target: in this organization, eligible, and a real change of pin.
  if (value.targetRouteId === source.id) throw refuse("target_pin_unchanged");
  const target =
    (await transaction.query<RouteRow & { provider: string; model: string }>(
      `select id, provider, model, harness, billing_route, status, health,
            incident_id, provider_account_id
       from bakery.provider_routes
      where organization_id = $1 and id = $2
        for share`,
      [organizationId, value.targetRouteId],
    )).rows[0];
  if (!target) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const reason = ineligibleReason(target, source.harness);
  if (reason !== null) throw refuse(`target_${reason}`);

  // The target's pin: its provider and model, the billing identity of its account,
  // and the pricing snapshot an active price exists for. No account, no price, or a
  // billing route a job cannot carry, and the step has nothing trustworthy to be
  // priced against.
  const pricing = await readRoutePricing(transaction, organizationId, target);
  if (pricing === null) throw refuse("target_pricing_unavailable");
  const { billingRoute: targetRoute, account, snapshot } = pricing;

  // 6. Every job to move, checked before any is touched.
  const plans = [];
  for (const job of moving) {
    if (job.status === "awaiting_reconciliation") {
      // Unknown effects must be settled first; a continuation would paper over them.
      throw refuse("awaiting_reconciliation");
    }
    if (job.cancel_requested_at !== null) throw refuse("cancel_requested");
    if (job.installation_reservation_id === null) {
      throw refuse("job_not_funded");
    }
    const mine = attempts.filter((attempt) => attempt.job_id === job.id);
    const live = mine.filter((attempt) =>
      LIVE_ATTEMPT_STATUSES.includes(attempt.status)
    );
    // The live attempt becomes terminal, and the new attempt needs a free one.
    if (mine.length >= job.max_attempts) {
      throw refuse("attempt_budget_exhausted");
    }

    const intent = (await transaction.query<{
      id: string;
      status: string;
      dedupe_key: string;
      call_status: string | null;
      provider_call_id: string | null;
    }>(
      `select intent.id, intent.status, intent.dedupe_key,
              call.status as call_status, call.provider_call_id
         from bakery.budget_action_intents as intent
         left join bakery.provider_call_intents as call
           on call.id = intent.provider_call_intent_id
        where intent.organization_id = $1
          and intent.installation_reservation_id = $2
          for update of intent`,
      [organizationId, job.installation_reservation_id],
    )).rows[0];
    if (!intent) throw refuse("job_not_funded");
    const reservations = (await transaction.query<{ status: string }>(
      `select status from bakery.budget_reservations
        where organization_id = $1 and dedupe_key = $2
          for update`,
      [organizationId, intent.dedupe_key],
    )).rows;
    const usage = await transaction.query(
      `select 1 from bakery.usage_records
        where organization_id = $1 and budget_reservation_id = $2 limit 1`,
      [organizationId, job.installation_reservation_id],
    );
    const effects = await transaction.query(
      `select 1 from bakery.external_effects
        where organization_id = $1 and run_step_id = $2 and status = any($3::text[])
        limit 1`,
      [organizationId, value.runStepId, LIVE_EFFECT_STATUSES],
    );
    // Nothing may have been spent or be in flight: the reservation is held, its call
    // was never dispatched, no usage was recorded, and no effect is live.
    const unspent = intent.status === "held" && reservations.length > 0 &&
      reservations.every((reservation) => reservation.status === "held") &&
      intent.call_status === "pending" && intent.provider_call_id === null &&
      usage.rows.length === 0 && effects.rows.length === 0;
    if (!unspent) throw refuse("spend_in_flight");
    plans.push({ job, live, intentId: intent.id });
  }
  const newPinFor = (billing: Record<string, unknown>) => ({
    ...billing,
    provider: target.provider,
    model: target.model,
    billingRoute: targetRoute,
    billingAccountId: account.billing_identity,
    pricingMetadataSnapshot: snapshot.pricing_metadata_snapshot,
  });
  const firstPlan = plans[0]!;
  const previousPin = pinOf(firstPlan.job.billing!);
  const newPin = pinOf(newPinFor(firstPlan.job.billing!));
  if (
    previousPin.provider === newPin.provider &&
    previousPin.model === newPin.model &&
    previousPin.billingRoute === newPin.billingRoute &&
    previousPin.billingAccountId === newPin.billingAccountId
  ) {
    // Only the pin has an effect, so a target with the same pin changes nothing.
    throw refuse("target_pin_unchanged");
  }

  // 7. The writes. Fence, re-price and re-pin, in that order, for every job.
  for (const { job, live, intentId } of plans) {
    if (live.length > 0) {
      // The old producer stops: its attempt is lost and the fence advances, so its
      // next heartbeat, event or result is refused as `LEASE_FENCED`.
      await transaction.query(
        `update bakery.job_attempts
            set status = 'lost', ended_at = clock_timestamp(),
                updated_at = clock_timestamp(), version = version + 1
          where organization_id = $1 and job_id = $2 and status = any($3::text[])`,
        [organizationId, job.id, LIVE_ATTEMPT_STATUSES],
      );
      const requeued = await transaction.query(
        `update bakery.jobs
            set status = 'queued', current_fence = current_fence + 1,
                updated_at = clock_timestamp(), version = version + 1
          where organization_id = $1 and id = $2
            and status in ('leased', 'running')`,
        [organizationId, job.id],
      );
      if (requeued.rowCount !== 1) throw refuse("spend_in_flight");
    }
    const billing = newPinFor(job.billing!);
    const intentUpdated = await transaction.query(
      `update bakery.budget_action_intents
          set provider = $3, billing_account_id = $4, model = $5,
              billing_route = $6, pricing_metadata_snapshot = $7,
              updated_at = clock_timestamp(), version = version + 1
        where organization_id = $1 and id = $2 and status = 'held'`,
      [
        organizationId,
        intentId,
        target.provider,
        account.billing_identity,
        target.model,
        targetRoute,
        snapshot.pricing_metadata_snapshot,
      ],
    );
    const callUpdated = await transaction.query(
      `update bakery.provider_call_intents
          set provider = $3, billing_account_id = $4, model = $5,
              billing_type = $6, pricing_snapshot_id = $7,
              pricing_metadata_snapshot = $8,
              updated_at = clock_timestamp(), version = version + 1
        where organization_id = $1 and status = 'pending'
          and provider_call_id is null
          and id = (select provider_call_intent_id
                      from bakery.budget_action_intents
                     where organization_id = $1 and id = $2)`,
      [
        organizationId,
        intentId,
        target.provider,
        account.billing_identity,
        target.model,
        targetRoute,
        snapshot.id,
        snapshot.pricing_metadata_snapshot,
      ],
    );
    if (intentUpdated.rowCount !== 1 || callUpdated.rowCount !== 1) {
      throw refuse("spend_in_flight");
    }
    await transaction.query(
      `update bakery.jobs
          set billing = $3::jsonb,
              agent_config = jsonb_set(agent_config, '{billing}', $3::jsonb),
              updated_at = clock_timestamp(), version = version + 1
        where organization_id = $1 and id = $2`,
      [organizationId, job.id, JSON.stringify(billing)],
    );
  }

  // 8. The run's version moves, so a second submission naming the old version is
  //    refused; and the record, which the unique key makes one per step and
  //    generation even if the locks above were wrong.
  await transaction.query(
    `update bakery.workflow_runs
        set version = version + 1, updated_at = clock_timestamp()
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  // One row records the continuation: the unique key allows one per step and
  // generation. A step has at most one claimable job (`jobs` is unique on
  // (run_step_id, action) and the claim check refuses any job whose action is not the
  // step's frozen one), so the claim matches the row by `job_id`.
  let continuation: { id: string; created_at: Date | string };
  try {
    continuation = (await transaction.query<
      { id: string; created_at: Date | string }
    >(
      `insert into bakery.route_continuations (
         organization_id, run_id, run_step_id, job_id, incident_id,
         incident_generation, source_route_id, target_route_id,
         admitted_by_principal_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id, created_at`,
      [
        organizationId,
        runId,
        value.runStepId,
        firstPlan.job.id,
        incident.id,
        incident.generation,
        source.id,
        target.id,
        principalId,
      ],
    )).rows[0]!;
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
      throw refuse("already_continued");
    }
    throw error;
  }

  // 9. Audited with what changed: both pins and both routes, and the pricing
  //    snapshot the step is now priced against.
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "routeContinuations.admit",
    resourceType: "route_continuation",
    resourceId: continuation.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      runId,
      runStepId: value.runStepId,
      incidentId: incident.id,
      incidentGeneration: incident.generation,
      sourceRouteId: source.id,
      targetRouteId: target.id,
      previousProvider: previousPin.provider,
      previousModel: previousPin.model,
      previousBillingAccountId: previousPin.billingAccountId,
      newProvider: newPin.provider,
      newModel: newPin.model,
      newBillingAccountId: newPin.billingAccountId,
      pricingSnapshotId: snapshot.id,
      jobsMoved: plans.length,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: null,
    repositoryId: null,
    eventType: "routeContinuations.admitted",
    aggregateId: continuation.id,
    aggregateVersion: await nextAggregateVersion(
      transaction,
      organizationId,
      continuation.id,
      "routeContinuations.admitted",
    ),
    payload: { resourceId: continuation.id, resourceVersion: run.version + 1 },
    traceId: context.traceId,
  });

  return {
    id: continuation.id,
    runId,
    runStepId: value.runStepId,
    jobId: firstPlan.job.id,
    incidentId: incident.id,
    incidentGeneration: incident.generation,
    sourceRouteId: source.id,
    targetRouteId: target.id,
    previousPin,
    newPin,
    admittedAt: new Date(continuation.created_at).toISOString(),
  };
}
