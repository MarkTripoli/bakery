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
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

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

type StalledStepRow = {
  run_step_id: string;
  step_key: string;
  run_version: number;
  source_route_id: string;
  source_harness: string;
  incident_id: string;
  incident_generation: number;
};

type CandidateRouteRow = {
  id: string;
  provider: string;
  model: string;
  harness: string;
  billing_route: string;
  status: string;
  health: string;
};

/** Run statuses after which nothing more happens to a run. */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "canceled", "blocked"];
/** Job statuses after which a job produces nothing more. */
const TERMINAL_JOB_STATUSES = ["completed", "failed", "canceled"];

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
function ineligibleReason(
  candidate: CandidateRouteRow,
  sourceHarness: string,
): Target["ineligibleReason"] {
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
              i.id as incident_id, i.generation as incident_generation
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
         join bakery.provider_incidents as i
           on i.organization_id = pr.organization_id
          and i.id = pr.incident_id and i.status = 'open'
        where r.organization_id = $1 and r.id = $2
          and j.status <> all($3::text[])
          and not exists (
            select 1 from bakery.route_continuations as c
             where c.organization_id = r.organization_id
               and c.run_step_id = s.id
               and c.incident_generation = i.generation)
        order by s.id, i.opened_at, pr.id, j.id
     ) as stalled
     order by step_key, run_step_id`,
    [organizationId, runId, TERMINAL_JOB_STATUSES],
  );
  if (stalled.rows.length === 0) return { runId, offers: [] };

  const candidates = (await transaction.query<CandidateRouteRow>(
    `select id, provider, model, harness, billing_route, status, health
       from bakery.provider_routes
      where organization_id = $1
      order by created_at, id`,
    [organizationId],
  )).rows;

  return {
    runId,
    offers: stalled.rows.map((step) => ({
      runStepId: step.run_step_id,
      stepKey: step.step_key,
      incidentId: step.incident_id,
      incidentGeneration: step.incident_generation,
      sourceRouteId: step.source_route_id,
      runVersion: step.run_version,
      estimatedIncrementalCost: null,
      targets: candidates
        .filter((candidate) => candidate.id !== step.source_route_id)
        .map((candidate): Target => {
          const reason = ineligibleReason(candidate, step.source_harness);
          return {
            routeId: candidate.id,
            provider: candidate.provider,
            model: candidate.model,
            harness: candidate.harness as Target["harness"],
            billingRoute: candidate.billing_route as Target["billingRoute"],
            health: candidate.health as Target["health"],
            eligible: reason === null,
            ineligibleReason: reason,
          };
        }),
    })),
  };
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
