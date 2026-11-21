import type { z } from "zod";
import { Hono, type MiddlewareHandler } from "hono";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  RouteContinuationsImplementedAction,
  routeContinuationsImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { createApiRouter, StandardError } from "@bakery/contracts/http";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { admitRouteContinuation } from "./route-continuation-admit.ts";

/**
 * The route continuation offers (#26 slice 6a): which steps of a run are stalled
 * behind a provider incident, and which routes each could continue on.
 *
 * A read of current state and never a decision. It admits nothing, pauses
 * nothing and charges nothing, so reading it twice is harmless and a person can
 * look before choosing. The choice itself is a command of its own (the next
 * slice), and it re-reads everything this read reports before it commits.
 *
 * ## How a step is found to be affected
 *
 * Nothing records which route a run uses: a job carries only the pin it was
 * admitted with, `agent_config.harness` and `billing` (provider, model, billing
 * route). A step is therefore affected when an active route of the organization
 * has the *same* provider, model, harness and billing route and an open incident.
 * That is derived on read, so there is no second source of truth to drift from
 * the job's real pin.
 *
 * The job names its billing route `api` or `subscription`; a route names it
 * `api_metered`, `subscription` or `local`. `api` is `api_metered`; a `local`
 * route has no job-side spelling, so a job never matches one.
 */

type Offers = z.output<typeof contractSchemas.RouteContinuationOffers>;
type Target = z.output<typeof contractSchemas.RouteContinuationTarget>;
type Offer = z.output<typeof contractSchemas.RouteContinuationOffer>;
type Unavailable = Offer["unavailable"][number];
type IneligibleReason = Unavailable["reason"] | null;

type StalledStepRow = {
  run_step_id: string;
  step_key: string;
  run_version: number;
  source_route_id: string;
  source_harness: string;
  source_provider: string;
  source_model: string;
  source_billing_route: string;
  source_health: string;
  incident_id: string;
  incident_generation: number;
  incident_reason: string;
  incident_opened_at: Date | string;
  incident_next_probe_at: Date | string | null;
};

/**
 * The joins that find a step stalled behind an open incident: a live job of the
 * step whose pin (provider, model, harness, billing route and account) matches an active route
 * with an open incident that the step has not already been continued past.
 * Aliases: `r` the run, `s` the step, `j` the job, `pr` the route, `a` its
 * account, `i` the
 * incident. `$1` is the organization and `$3` the waiting job statuses; the
 * caller adds its own run predicate. Shared by the offers and by the runs read's
 * `waitingOnModel`, so the badge and the card can never disagree.
 */
const STALLED_STEP_JOINS = `
         from bakery.workflow_runs as r
         join bakery.run_steps as s
           on s.organization_id = r.organization_id and s.run_id = r.id
         join bakery.jobs as j
           on j.organization_id = r.organization_id and j.run_step_id = s.id
         join bakery.provider_routes as pr
           on pr.organization_id = r.organization_id
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
         join bakery.provider_incidents as i
           on i.organization_id = pr.organization_id
          and i.id = pr.incident_id and i.status = 'open'
        where r.organization_id = $1
          and j.status = any($3::text[])
          and not exists (
            select 1 from bakery.route_continuations as c
             where c.organization_id = r.organization_id
               and c.run_step_id = s.id
               and c.incident_generation = i.generation)`;

/**
 * Which of `runIds` have a step waiting on a model: the same rule as the offers,
 * one statement for a whole page of runs. A terminal run never waits.
 */
export async function readRunsWaitingOnModel(
  transaction: PgTransactionClient,
  organizationId: string,
  runIds: readonly string[],
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const result = await transaction.query<{ run_id: string }>(
    `select distinct r.id as run_id${STALLED_STEP_JOINS}
          and r.id = any($2::uuid[])
          and r.status <> all($4::text[])`,
    [organizationId, runIds, WAITING_JOB_STATUSES, TERMINAL_RUN_STATUSES],
  );
  return new Set(result.rows.map((row) => row.run_id));
}
export type CandidateRouteRow = {
  id: string;
  provider: string;
  model: string;
  harness: string;
  billing_route: string;
  status: string;
  health: string;
};

/** A route with what pricing it needs: its pin and the account it bills. */
export type PricedRouteRow =
  & Pick<
    CandidateRouteRow,
    "provider" | "model" | "billing_route"
  >
  & { provider_account_id: string | null };

/** The job-side spelling of a route's billing route, or null when there is none. */
export function jobBillingRoute(
  routeBilling: string,
): "api" | "subscription" | null {
  if (routeBilling === "api_metered") return "api";
  if (routeBilling === "subscription") return "subscription";
  return null;
}

/**
 * The price Bakery would charge a step on `route` against, or null when it has
 * none: the job-side billing route, the billing identity of the route's account,
 * and the active pricing snapshot for that provider, model, account and billing
 * route. No account, no active price, or a billing route a job cannot carry
 * (`local`) is null. The one lookup both the offers (`priced`) and the admit
 * (`target_pricing_unavailable`) use, so an offer marked priced is never refused
 * for want of a price unless the price changed in between.
 */
export async function readRoutePricing(
  transaction: PgTransactionClient,
  organizationId: string,
  route: PricedRouteRow,
): Promise<
  {
    billingRoute: "api" | "subscription";
    account: { billing_identity: string };
    snapshot: { id: string; pricing_metadata_snapshot: string };
  } | null
> {
  const billingRoute = jobBillingRoute(route.billing_route);
  if (billingRoute === null || route.provider_account_id === null) return null;
  const account = (await transaction.query<{ billing_identity: string }>(
    `select billing_identity from bakery.model_provider_accounts
      where organization_id = $1 and id = $2`,
    [organizationId, route.provider_account_id],
  )).rows[0];
  if (!account) return null;
  // Pricing snapshots are global (a provider's published price), so this one
  // statement has no organization predicate: the account above is the scope.
  const snapshot = (await transaction.query<
    { id: string; pricing_metadata_snapshot: string }
  >(
    `select id, pricing_metadata_snapshot
       from bakery.provider_pricing_snapshots
      where provider = $1 and billing_account_id = $2 and model = $3
        and billing_type = $4 and status = 'active'
        and effective_from <= clock_timestamp()
        and (effective_until is null or effective_until > clock_timestamp())
      order by effective_from desc, id desc
      limit 1`,
    [route.provider, account.billing_identity, route.model, billingRoute],
  )).rows[0];
  if (!snapshot) return null;
  return { billingRoute, account, snapshot };
}

/**
 * Providers whose name a person recognises. Bakery has no provider catalog: a
 * route names its provider by an open key, so an unlisted key is shown as it is
 * rather than as a guessed company name.
 */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
  xai: "xAI",
  openrouter: "OpenRouter",
};

/** A provider as a person reads it, or its key when it is not a known one. */
export function providerDisplayName(provider: string): string {
  return PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
}

/**
 * A model as a person reads it. Bakery has no model catalog, and a model key
 * (`claude-sonnet-4-5`, `gpt-5-mini`) is already the name its provider uses, so
 * the key is the name.
 */
export function modelDisplayName(model: string): string {
  return model;
}

/** The order "cannot be used" is told in: the order a person would fix it. */
const UNAVAILABLE_ORDER: readonly NonNullable<IneligibleReason>[] = [
  "route_not_active",
  "different_harness",
  "route_open",
];

/** At most this many open routes are named; the count still covers them all. */
export const UNAVAILABLE_ROUTE_NAMES_CAP = 20;

/**
 * The routes a step cannot continue on, as one count per reason instead of one
 * row per route: per harness for `different_harness` (a person sees which other
 * agents have routes), and the names of at most
 * `UNAVAILABLE_ROUTE_NAMES_CAP` routes for `route_open` (a person may know
 * them by name and wait for one) and for `route_not_active` (a person sees
 * which routes are turned off in Settings). Reasons with no route are left out.
 */
export function summarizeUnavailable(
  refused: readonly {
    candidate: CandidateRouteRow;
    reason: NonNullable<IneligibleReason>;
  }[],
): Unavailable[] {
  return UNAVAILABLE_ORDER.flatMap((reason): Unavailable[] => {
    const mine = refused.filter((entry) => entry.reason === reason);
    if (mine.length === 0) return [];
    const group: Unavailable = { reason, count: mine.length };
    if (reason === "different_harness") {
      const counts = new Map<string, number>();
      for (const { candidate } of mine) {
        counts.set(candidate.harness, (counts.get(candidate.harness) ?? 0) + 1);
      }
      group.harnesses = [...counts]
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .map(([harness, count]) => ({
          harness: harness as Target["harness"],
          count,
        }));
    }
    if (reason === "route_open" || reason === "route_not_active") {
      group.routes = mine.slice(0, UNAVAILABLE_ROUTE_NAMES_CAP).map((
        { candidate },
      ) => ({
        provider: candidate.provider,
        model: candidate.model,
        providerName: providerDisplayName(candidate.provider),
        modelName: modelDisplayName(candidate.model),
      }));
    }
    return [group];
  });
}

/** Run statuses after which nothing more happens to a run. */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "canceled", "blocked"];
/** Job statuses after which a job produces nothing more. */
/**
 * A step waits on a model only while its job sits queued with no attempt in
 * flight. A leased or running attempt is still working, so one probe timeout on
 * its route does not make a healthy step read "cannot reach its model".
 */
const WAITING_JOB_STATUSES = ["queued"];

/**
 * Why a candidate cannot take a step, in the order a person would fix it, or
 * `null` when it can. The source route is never a candidate.
 *
 * Only the states that cannot serve work refuse a route. A `degraded` route is
 * failing below the open threshold, so it still serves some work, and an
 * `unverified` route is reachable but has no inference proof yet, which is the
 * state every route is in until the trial slice exists: refusing it would mean a
 * new route could never be a failover target. The choice is a person's and the
 * offer shows each route's health beside it, so the person weighs a degraded or
 * unverified target themselves; only `open` (paused behind its own incident) is
 * refused outright.
 */
export function ineligibleReason(
  candidate: CandidateRouteRow,
  sourceHarness: string,
): IneligibleReason {
  if (candidate.status !== "active") return "route_not_active";
  // A continuation keeps the step's harness: a different harness is a different
  // session with different tools, which is a product decision and not a failover.
  if (candidate.harness !== sourceHarness) return "different_harness";
  if (candidate.health === "open") return "route_open";
  return null;
}

export async function listRouteContinuations(
  context: ActionContext,
  _input: unknown,
): Promise<Offers> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const runId = context.params.id;
  if (!runId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  // The run is looked up inside the organization first, so another
  // organization's run is absent rather than forbidden.
  const run = await transaction.query<{ status: string }>(
    `select status from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  const runRow = run.rows[0];
  if (!runRow) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (TERMINAL_RUN_STATUSES.includes(runRow.status)) {
    return { runId, offers: [] };
  }

  // One row per step. A step can have more than one live job (one per action),
  // and more than one active route can share a pin (two endpoints or regions of
  // one provider), so the joins alone yield several rows for one stalled step. A
  // person is asked once per step, and the submission that follows names the step,
  // so the offer is the step's earliest-opened incident, with the route id and job
  // id as fixed tie-breakers: the same data always gives the same offer.
  const stalled = await transaction.query<StalledStepRow>(
    `select * from (
       select distinct on (s.id)
              s.id as run_step_id, s.step_key, r.version as run_version,
              pr.id as source_route_id, pr.harness as source_harness,
              pr.provider as source_provider, pr.model as source_model,
              pr.billing_route as source_billing_route,
              pr.health as source_health,
              i.id as incident_id, i.generation as incident_generation,
              i.reason as incident_reason, i.opened_at as incident_opened_at,
              i.next_probe_at as incident_next_probe_at${STALLED_STEP_JOINS}
          and r.id = $2
        order by s.id, i.opened_at, pr.id, j.id
     ) as stalled
     order by step_key, run_step_id`,
    [organizationId, runId, WAITING_JOB_STATUSES],
  );
  if (stalled.rows.length === 0) return { runId, offers: [] };

  const candidates = (await transaction.query<
    CandidateRouteRow & PricedRouteRow
  >(
    `select id, provider, model, harness, billing_route, status, health,
            provider_account_id
       from bakery.provider_routes
      where organization_id = $1
      order by created_at, id`,
    [organizationId],
  )).rows;

  // Whether each route has a price does not depend on the step, so it is read
  // once per route an offer could name, not once per step.
  const priced = new Map<string, boolean>();
  const isPriced = async (candidate: PricedRouteRow & { id: string }) => {
    const known = priced.get(candidate.id);
    if (known !== undefined) return known;
    const value =
      (await readRoutePricing(transaction, organizationId, candidate)) !== null;
    priced.set(candidate.id, value);
    return value;
  };

  const offers: Offer[] = [];
  for (const step of stalled.rows) {
    const others = candidates.filter((candidate) =>
      candidate.id !== step.source_route_id
    );
    const refused = others.flatMap((candidate) => {
      const reason = ineligibleReason(candidate, step.source_harness);
      return reason === null ? [] : [{ candidate, reason }];
    });
    const targets: Target[] = [];
    for (const candidate of others) {
      if (ineligibleReason(candidate, step.source_harness) !== null) continue;
      targets.push({
        routeId: candidate.id,
        provider: candidate.provider,
        model: candidate.model,
        providerName: providerDisplayName(candidate.provider),
        modelName: modelDisplayName(candidate.model),
        harness: candidate.harness as Target["harness"],
        billingRoute: candidate.billing_route as Target["billingRoute"],
        health: candidate.health as Target["health"],
        priced: await isPriced(candidate),
        // Bakery has no forecast of how many tokens a step has left to spend, so
        // it cannot price a continuation yet: null is "unknown", never "free".
        estimatedIncrementalCost: null,
      });
    }
    offers.push({
      runStepId: step.run_step_id,
      stepKey: step.step_key,
      incidentId: step.incident_id,
      incidentGeneration: step.incident_generation,
      sourceRouteId: step.source_route_id,
      source: {
        provider: step.source_provider,
        model: step.source_model,
        providerName: providerDisplayName(step.source_provider),
        modelName: modelDisplayName(step.source_model),
        harness: step.source_harness as Target["harness"],
        billingRoute: step.source_billing_route as Target["billingRoute"],
        health: step.source_health as Target["health"],
      },
      reason: step.incident_reason as Offer["reason"],
      since: new Date(step.incident_opened_at).toISOString(),
      nextCheckAt: step.incident_next_probe_at === null
        ? null
        : new Date(step.incident_next_probe_at).toISOString(),
      runVersion: step.run_version,
      targets,
      unavailable: summarizeUnavailable(refused),
    });
  }
  return { runId, offers };
}

export function createRouteContinuationActionRegistry(
  database: PgDatabase,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  registry.register({
    name: RouteContinuationsImplementedAction.RouteContinuationsList,
    method: HttpMethod.Get,
    path: "/v1/runs/:id/route-continuations",
    input: contractSchemas.IdPath,
    output: contractSchemas.RouteContinuationOffers,
    policy: {
      type: ActionKind.Query,
      // The same access as reading a route: the offers name routes, accounts and
      // outage state that a viewer is not shown.
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: listRouteContinuations,
  });
  registry.register({
    name: RouteContinuationsImplementedAction.RouteContinuationsAdmit,
    method: HttpMethod.Post,
    path: "/v1/runs/:id/route-continuations",
    input: contractSchemas.RouteContinuationAdmit,
    output: contractSchemas.RouteContinuation,
    policy: {
      type: ActionKind.Command,
      // The same access as controlling the run: continuing a step on another route
      // is a decision about that one run, like cancelling it.
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: admitRouteContinuation,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(
    registry,
    routeContinuationsImplementedActions,
  );
  return registry;
}

export function createRouteContinuationRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/runs/:id/route-continuations", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createRouteContinuationActionRegistry(options.database),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
