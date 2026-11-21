import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type ProbeOutcome,
  type ProbeResult,
  recordProbeResult,
} from "./provider-incidents.ts";
import { PROBE_OPENS_INCIDENTS } from "./provider-probe.ts";

/**
 * What a real attempt proves about the provider route its job is pinned to
 * (#70 slice 2).
 *
 * The probe sends no credential, so it can never say a credential is invalid or a
 * quota is spent, and it can never prove that paid work runs. A real attempt can
 * do all three, and this is where its answer becomes route evidence:
 *
 * - a failed attempt whose fault the harness classified as exhausted quota or an
 *   invalid credential is a `failure` (`quota_exhausted`, `credential_invalid`);
 * - a completed attempt is `inference_proven`: an already-authorized request that
 *   really ran. It is the closer an open incident waits for, so incidents can be
 *   opened without a transient outage permanently removing a route;
 * - every other outcome (a timeout, a non-zero exit, a cancel, a fault that names
 *   the worker's own setup) says nothing about the provider and records nothing.
 *
 * It goes through `recordProbeResult`, the one writer of route health and
 * incidents, so the generation fence and the duplicate rule hold: the attempt id
 * is the evidence watermark, and a replayed result counts once. The schedule the
 * probe owns is not moved: the route keeps its `next_probe_at`.
 *
 * A route matches when it is active and has the job's provider, model, harness,
 * billing route and billing account: the same pin match as the continuation
 * offers, narrowed by account, because a quota or a credential belongs to one
 * account and another account's routes are not touched by its answer.
 */

export type AttemptRouteFailure = {
  reason: "quota_exhausted" | "credential_invalid";
  severity: "outage";
};

/** Fault codes the harnesses emit for a credential the provider or the worker rejected as invalid. */
const CREDENTIAL_INVALID_CODES = new Set([
  "credential_invalid",
  "HARNESS_CREDENTIAL_FILE_INVALID",
  "CODEX_HARNESS_AUTH_FILE_INVALID",
  "CODEX_HARNESS_AUTH_SOURCE_INVALID",
  "PI_HARNESS_AUTH_FILE_INVALID",
  "PI_HARNESS_AUTH_SOURCE_INVALID",
]);

/**
 * A failed attempt's fault in the incident vocabulary, or `null` when it says
 * nothing about the provider route. `quota_exceeded` is the code the Claude Code
 * harness reports when the provider says the quota or rate limit is spent
 * (apps/worker/src/claude-harness.ts); `quota_exhausted` is accepted as the same.
 * A credential that is absent (`*_AUTH_UNAVAILABLE`, `*_CREDENTIAL_UNAVAILABLE`)
 * is the worker host's setup, not the route's, so it is deliberately not here.
 */
export function classifyAttemptFault(
  fault: unknown,
): AttemptRouteFailure | null {
  if (fault === null || typeof fault !== "object") return null;
  const code = (fault as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  if (code === "quota_exceeded" || code === "quota_exhausted") {
    return { reason: "quota_exhausted", severity: "outage" };
  }
  if (CREDENTIAL_INVALID_CODES.has(code)) {
    return { reason: "credential_invalid", severity: "outage" };
  }
  return null;
}

type MatchedRoute = {
  id: string;
  incident_generation: number;
  next_probe_at: Date | string | null;
};

/**
 * Records a terminal attempt's evidence on every route its job is pinned to.
 * Returns one result per matched route; an attempt that proves nothing reads no
 * route and writes nothing.
 */
export async function recordAttemptRouteEvidence(
  transaction: PgTransactionClient,
  attempt: {
    organizationId: string;
    jobId: string;
    attemptId: string;
    status: "completed" | "failed" | "canceled";
    fault: unknown;
    observedAt: Date;
  },
): Promise<ProbeResult[]> {
  const failure = attempt.status === "failed"
    ? classifyAttemptFault(attempt.fault)
    : null;
  if (attempt.status !== "completed" && failure === null) return [];
  const evidenceWatermark = `attempt:${attempt.attemptId}`;
  const outcome: ProbeOutcome = failure === null
    ? { kind: "inference_proven", evidenceWatermark }
    : { kind: "failure", ...failure, evidenceWatermark };
  const routes = (await transaction.query<MatchedRoute>(
    `select pr.id, pr.incident_generation, pr.next_probe_at
       from bakery.jobs as j
       join bakery.provider_routes as pr
         on pr.organization_id = j.organization_id
        and pr.status = 'active'
        and pr.provider = j.billing->>'provider'
        and pr.model = j.billing->>'model'
        and pr.harness = j.agent_config->>'harness'
        and pr.billing_route = case j.billing->>'billingRoute'
              when 'api' then 'api_metered'
              else j.billing->>'billingRoute' end
       join bakery.model_provider_accounts as a
         on a.organization_id = pr.organization_id
        and a.id = pr.provider_account_id
        and a.billing_identity = j.billing->>'billingAccountId'
      where j.organization_id = $1 and j.id = $2
      order by pr.id`,
    [attempt.organizationId, attempt.jobId],
  )).rows;
  const results: ProbeResult[] = [];
  for (const route of routes) {
    results.push(
      await recordProbeResult(transaction, {
        organizationId: attempt.organizationId,
        routeId: route.id,
        generation: route.incident_generation,
        observedAt: attempt.observedAt,
        nextProbeAt: route.next_probe_at === null
          ? null
          : new Date(route.next_probe_at),
        incidents: PROBE_OPENS_INCIDENTS ? "on" : "off",
        outcome,
      }),
    );
  }
  return results;
}
