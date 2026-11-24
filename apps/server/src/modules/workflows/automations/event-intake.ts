/**
 * `bakery-automation-intake`: the consumer of the `automation` routes (issue
 * #36). A verified provider delivery that some enabled automation is bound to
 * hear earns a route of its own at receipt (see `event-gate.ts`); this reads it and
 * admits the firings it earns.
 *
 * The route is the only input, and everything else is read again from Bakery's
 * own rows: the organization comes from the route, never from the payload (the
 * receipt names none). The installation, connection and repository resource are
 * locked and judged as the integration processor does before it writes; the
 * Bakery repository is the one that resource resolves to on the route's own
 * connection; and only enabled automations whose active version is bound to
 * that repository and whose trigger matches the stored projection exactly can
 * fire. One transaction takes each automation's definition lock (in id order),
 * writes its firing and settles the route, so a firing and its route can never
 * disagree, and a redelivery changes nothing.
 *
 * It admits; it does not start runs. A firing it writes waits, `pending`, for
 * the promotion pass, which rechecks the actor, grants and budget, exactly as
 * for a schedule's firing. The overlap policy applies as for a schedule: an
 * event that arrives while the automation is busy is skipped, or queued behind
 * the run, by the version's policy. A loop guard bounds a runaway: an
 * automation admits at most `EVENT_FIRINGS_PER_HOUR` event firings an hour (the
 * ones it skips are not counted, so a burst it declined cannot lock out the next
 * event), and the rest are recorded as skipped.
 */
import type { Inngest } from "inngest";
import { INNGEST_EVENT_DEFINITIONS } from "@bakery/contracts/events";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../../platform/database.ts";
import { isQuiesced } from "../../../platform/maintenance.ts";
import {
  authorityVerdict,
  RouteOutcomeCode,
} from "../../integrations/fact-reads.ts";
import {
  AUTOMATION_ROUTE_PURPOSE,
  IntakeProjectionSchema,
} from "../../integrations/intake-events.ts";
import {
  eventRouteId,
  MAX_ROUTE_ATTEMPTS,
  PROCESSING_STALE_MS,
  retryDelaySeconds,
} from "../../integrations/intake-workflow.ts";
import { RouteStatus } from "../../integrations/intake-receipts.ts";
import { resolveRepositoryId } from "../../integrations/pull-requests.ts";
import { lockAuthority } from "../../integrations/write-authority.ts";
import { type EventFacts, eventMatches } from "./event-match.ts";
import { insertFiring } from "./firing.ts";
import { occupancyOf } from "./overlap.ts";
import { applyOverlap, type OverlapPolicy } from "./tick-plan.ts";
import { type EventTrigger, parseTrigger } from "./trigger.ts";
import { neutralEventOf } from "../../integrations/neutral-events.ts";
import { GITHUB_PROVIDER } from "../../integrations/registry.ts";
import { fireStartsFor, type StartFiringOutcome } from "../start-firing.ts";

export const AUTOMATION_INTAKE_FUNCTION_ID = "bakery-automation-intake";

/** The most event firings one automation admits in an hour; the rest are skipped. */
export const EVENT_FIRINGS_PER_HOUR = 60;

const INTAKE_EVENT = INNGEST_EVENT_DEFINITIONS["intake.received"].name;

/** Route outcome codes this consumer settles with, beside the authority codes. */
export const AutomationRouteCode = Object.freeze(
  {
    Fired: "automation_fired",
    NoMatch: "no_automation_matched",
    RepositoryUnresolved: "repository_unresolved",
    ProjectionInvalid: "projection_invalid",
    Error: "automation_intake_error",
    MaxAttempts: RouteOutcomeCode.MaxAttempts,
  } as const,
);

/** What came of one matching automation. */
export type FiringOutcome = Readonly<{
  automationId: string;
  versionId: string;
  result:
    | "admitted"
    | "skipped_overlap"
    | "skipped_rate"
    | "duplicate"
    | "not_routed";
}>;

export type AutomationRouteOutcome =
  | Readonly<{
    kind: "skipped";
    reason:
      | "not_found"
      | "not_automation"
      | "terminal"
      | "not_due"
      | "in_progress"
      | "quiesced";
  }>
  | Readonly<{
    kind: "settled";
    status: "completed" | "ignored" | "failed" | "deferred";
    code: string;
    firings: readonly FiringOutcome[];
    /** What the workflow starts that answered the event did (#406). */
    starts: readonly StartFiringOutcome[];
  }>;

type ClaimedRoute = Readonly<{
  id: string;
  organizationId: string;
  connectionId: string;
  installationId: string;
  resourceId: string | null;
  inboundEventId: string;
  eventKind: string;
  attempts: number;
  receivedMs: number;
  projection: unknown;
}>;

type ClaimResult =
  | Readonly<{ kind: "claimed"; route: ClaimedRoute }>
  | Extract<AutomationRouteOutcome, { kind: "skipped" | "settled" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function claim(
  database: PgDatabase,
  routeId: string,
): Promise<ClaimResult> {
  return await withPgTransaction(database, async (transaction) => {
    // A backup holds the installation: leave the route as it is, unclaimed and
    // with no attempt counted, so a long hold cannot use up its attempts and a
    // firing is not refused part way. The recovery sweep resends it after.
    if (await isQuiesced(transaction, "intake")) {
      return { kind: "skipped", reason: "quiesced" } as const;
    }
    const found = await transaction.query<{
      id: string;
      organizationId: string;
      connectionId: string;
      installationId: string;
      resourceId: string | null;
      purpose: string;
      status: string;
      attempts: number;
      due: boolean;
      stale: boolean;
      inboundEventId: string;
      eventKind: string;
      receivedMs: string;
      projection: unknown;
    }>(
      `select route.id, route.organization_id as "organizationId",
         route.connection_id as "connectionId",
         route.installation_id as "installationId",
         route.resource_id as "resourceId", route.purpose, route.status,
         route.attempts, route.not_before <= now() as due,
         route.updated_at <= now() - ($2::bigint * interval '1 millisecond')
           as stale,
         route.inbound_event_id as "inboundEventId",
         event.event_kind as "eventKind",
         floor(extract(epoch from event.received_at) * 1000)::bigint::text
           as "receivedMs",
         event.normalized_projection as projection
       from bakery.inbound_event_routes as route
       join bakery.inbound_events as event on event.id = route.inbound_event_id
       where route.id = $1
       for update of route`,
      [routeId, PROCESSING_STALE_MS],
    );
    const row = found.rows[0];
    if (row === undefined) return { kind: "skipped", reason: "not_found" };
    // Only this consumer's routes: any other purpose belongs to its own owner.
    if (row.purpose !== AUTOMATION_ROUTE_PURPOSE) {
      return { kind: "skipped", reason: "not_automation" };
    }
    switch (row.status) {
      case RouteStatus.Pending:
        break;
      case RouteStatus.Deferred:
        if (!row.due) return { kind: "skipped", reason: "not_due" };
        break;
      case RouteStatus.Processing:
        if (!row.stale) return { kind: "skipped", reason: "in_progress" };
        break;
      default:
        return { kind: "skipped", reason: "terminal" };
    }
    if (row.attempts >= MAX_ROUTE_ATTEMPTS) {
      await settle(
        transaction,
        row,
        RouteStatus.Failed,
        AutomationRouteCode.MaxAttempts,
      );
      return settled(RouteStatus.Failed, AutomationRouteCode.MaxAttempts, []);
    }
    await transaction.query(
      `update bakery.inbound_event_routes
          set status = $3, attempts = attempts + 1, updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2`,
      [row.organizationId, row.id, RouteStatus.Processing],
    );
    return {
      kind: "claimed",
      route: {
        id: row.id,
        organizationId: row.organizationId,
        connectionId: row.connectionId,
        installationId: row.installationId,
        resourceId: row.resourceId,
        inboundEventId: row.inboundEventId,
        eventKind: row.eventKind,
        attempts: row.attempts + 1,
        receivedMs: Number(row.receivedMs),
        projection: row.projection,
      },
    };
  });
}

const settled = (
  status: "completed" | "ignored" | "failed" | "deferred",
  code: string,
  firings: readonly FiringOutcome[],
  starts: readonly StartFiringOutcome[] = [],
): Extract<AutomationRouteOutcome, { kind: "settled" }> => ({
  kind: "settled",
  status,
  code,
  firings,
  starts,
});

async function settle(
  transaction: PgTransactionClient,
  route: { organizationId: string; id: string },
  status: string,
  code: string,
  delaySeconds = 0,
): Promise<void> {
  await transaction.query(
    `update bakery.inbound_event_routes
        set status = $3, outcome_code = $4, updated_at = now(),
            not_before = now() + ($5::int * interval '1 second'),
            version = version + 1
      where organization_id = $1 and id = $2`,
    [route.organizationId, route.id, status, code, delaySeconds],
  );
}

type Candidate = {
  id: string;
  versionId: string;
  trigger: unknown;
  overlapPolicy: string;
};

/**
 * Admits the firing one matching automation earns, under its definition lock.
 * The caller holds the lock.
 */
async function admitFiring(
  transaction: PgTransactionClient,
  route: ClaimedRoute,
  candidate: Candidate,
): Promise<FiringOutcome> {
  const outcome = (result: FiringOutcome["result"]): FiringOutcome => ({
    automationId: candidate.id,
    versionId: candidate.versionId,
    result,
  });
  // A redelivery of the event, or a replay of this route: already done.
  const existing = await transaction.query(
    `select 1 from bakery.automation_firings
      where organization_id = $1 and automation_version_id = $2
        and trigger_event_id = $3`,
    [route.organizationId, candidate.versionId, route.inboundEventId],
  );
  if (existing.rows.length > 0) return outcome("duplicate");

  // The firing's instant is the receipt's, kept one millisecond past the
  // version's latest firing so two events in one instant are two firings.
  const latest = await transaction.query<{ ms: string | null }>(
    `select (extract(epoch from max(scheduled_at)) * 1000)::bigint::text as ms
       from bakery.automation_firings
      where organization_id = $1 and automation_version_id = $2`,
    [route.organizationId, candidate.versionId],
  );
  const latestMs = latest.rows[0]?.ms ?? null;
  const scheduledMs = latestMs === null
    ? route.receivedMs
    : Math.max(route.receivedMs, Number(latestMs) + 1);
  const scheduledAt = new Date(scheduledMs);

  const recent = await transaction.query<{ count: string }>(
    `select count(*)::text as count
       from bakery.automation_firings firing
       join bakery.automation_versions version
         on version.organization_id = firing.organization_id
        and version.id = firing.automation_version_id
      where firing.organization_id = $1 and version.automation_id = $2
        and firing.trigger_event_id is not null
        and firing.status <> 'skipped'
        and firing.created_at > now() - interval '1 hour'`,
    [route.organizationId, candidate.id],
  );
  const overRate = Number(recent.rows[0]?.count ?? 0) >= EVENT_FIRINGS_PER_HOUR;
  const plan = overRate
    ? {
      scheduledAt,
      status: "skipped" as const,
      pending: false,
      skippedCount: 1,
    }
    : applyOverlap(
      candidate.overlapPolicy as OverlapPolicy,
      await occupancyOf(transaction, route.organizationId, candidate.id),
      { scheduledAt, status: "queued", pending: true, skippedCount: 0 },
      1,
    );
  const result = await insertFiring(transaction, {
    organizationId: route.organizationId,
    automationVersionId: candidate.versionId,
    scheduledAt: plan.scheduledAt,
    status: plan.status,
    pending: plan.pending,
    skippedCount: plan.skippedCount,
    triggerEventId: route.inboundEventId,
  });
  if (result === "duplicate") return outcome("duplicate");
  if (result === "event_not_routed") return outcome("not_routed");
  if (overRate) return outcome("skipped_rate");
  return outcome(plan.status === "skipped" ? "skipped_overlap" : "admitted");
}

/** The work of one claimed route, in one transaction: authority, matching, firings, settling. */
async function work(
  transaction: PgTransactionClient,
  route: ClaimedRoute,
): Promise<Extract<AutomationRouteOutcome, { kind: "settled" }>> {
  const ignored = async (code: string) => {
    await settle(transaction, route, RouteStatus.Ignored, code);
    return settled(RouteStatus.Ignored, code, []);
  };
  const projection = IntakeProjectionSchema.safeParse(route.projection);
  if (!projection.success) {
    return await ignored(AutomationRouteCode.ProjectionInvalid);
  }
  // The authority is read again and locked for the rest of the transaction.
  const locked = await lockAuthority(transaction, {
    organizationId: route.organizationId,
    connectionId: route.connectionId,
    installationId: route.installationId,
    resourceId: route.resourceId,
  });
  const verdict = authorityVerdict(
    {
      purpose: AUTOMATION_ROUTE_PURPOSE,
      installationId: route.installationId,
      resourceId: route.resourceId,
      eventKind: route.eventKind,
    },
    { ...locked, tracked: true },
  );
  if (verdict !== null) return await ignored(verdict);
  const resource = route.resourceId === null ? undefined : (await transaction
    .query<{ externalId: string; displayName: string }>(
      `select external_id as "externalId", display_name as "displayName"
         from bakery.integration_resources
        where organization_id = $1 and connection_id = $2 and id = $3`,
      [route.organizationId, route.connectionId, route.resourceId],
    )).rows[0];
  const repositoryId = resource === undefined
    ? null
    : await resolveRepositoryId(
      transaction,
      {
        organizationId: route.organizationId,
        connectionId: route.connectionId,
        externalId: resource.externalId,
        displayName: resource.displayName,
      },
    );
  if (repositoryId === null) {
    return await ignored(AutomationRouteCode.RepositoryUnresolved);
  }

  // Every enabled automation bound to this repository that listens for this
  // kind, locked in id order so concurrent consumers cannot deadlock.
  const candidates = await transaction.query<Candidate>(
    `select definition.id, definition.active_version_id as "versionId",
            version.trigger, version.overlap_policy as "overlapPolicy"
       from bakery.automation_definitions definition
       join bakery.automation_versions version
         on version.organization_id = definition.organization_id
        and version.id = definition.active_version_id
      where definition.organization_id = $1
        and definition.enabled
        and version.repository_id = $2
        and version.trigger ->> 'type' = 'event'
        and version.trigger ->> 'kind' = $3
      order by definition.id
        for update of definition`,
    [route.organizationId, repositoryId, route.eventKind],
  );
  const facts: EventFacts = {
    kind: route.eventKind,
    action: projection.data.action,
    number: projection.data.number,
    headSha: projection.data.headSha,
    repositoryId: projection.data.repositoryId,
  };
  const firings: FiringOutcome[] = [];
  for (const candidate of candidates.rows) {
    let trigger: EventTrigger;
    try {
      const parsed = parseTrigger(candidate.trigger);
      if (parsed.type !== "event") continue;
      trigger = parsed;
    } catch {
      continue;
    }
    if (!eventMatches(trigger, facts)) continue;
    firings.push(await admitFiring(transaction, route, candidate));
  }
  // The workflow starts the same delivery answers: the event in neutral terms,
  // matched against the version in use of every enabled workflow. They run in
  // this transaction, so a start's firing and the route settle together.
  const neutral = neutralEventOf(GITHUB_PROVIDER, facts);
  const starts = neutral === null ? [] : await fireStartsFor(
    transaction,
    route,
    { id: repositoryId },
    neutral,
  );
  const code = firings.length + starts.length === 0
    ? AutomationRouteCode.NoMatch
    : AutomationRouteCode.Fired;
  await settle(transaction, route, RouteStatus.Completed, code);
  return settled(RouteStatus.Completed, code, firings, starts);
}

/**
 * Processes the `automation` route an `intake.received` event names. A route
 * already claimed, settled or not due is left as it is, so the outbox's delivery
 * and the recovery's resend can both arrive. A failure of the work rolls back
 * whole (no firing without its route settling) and defers the route with a
 * backoff, or fails it after `MAX_ROUTE_ATTEMPTS`.
 */
export async function processAutomationRoute(
  database: PgDatabase,
  routeId: string,
): Promise<AutomationRouteOutcome> {
  if (!UUID.test(routeId)) return { kind: "skipped", reason: "not_found" };
  const claimed = await claim(database, routeId);
  if (claimed.kind !== "claimed") return claimed;
  const { route } = claimed;
  try {
    return await withPgTransaction(
      database,
      (transaction) => work(transaction, route),
    );
  } catch (error) {
    console.warn(JSON.stringify({
      component: "automations",
      event: "automation_intake_failed",
      routeId,
      errorClass: error instanceof Error ? error.name : typeof error,
    }));
    const exhausted = route.attempts >= MAX_ROUTE_ATTEMPTS;
    const status = exhausted ? RouteStatus.Failed : RouteStatus.Deferred;
    const code = exhausted
      ? AutomationRouteCode.MaxAttempts
      : AutomationRouteCode.Error;
    await withPgTransaction(
      database,
      (transaction) =>
        settle(
          transaction,
          route,
          status,
          code,
          exhausted ? 0 : retryDelaySeconds(route.attempts),
        ),
    );
    return settled(status, code, []);
  }
}

/** Reacts to each `intake.received` event, beside the integration and ticket consumers. */
export function createAutomationIntakeFunction(
  options: { database: PgDatabase; client: Inngest },
) {
  return options.client.createFunction(
    {
      id: AUTOMATION_INTAKE_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 4 }],
      triggers: [{ event: INTAKE_EVENT }],
    },
    async ({ event, step }) => {
      const routeId = eventRouteId(event);
      if (routeId === undefined) {
        return { kind: "skipped", reason: "not_found" } as const;
      }
      return await step.run(
        `process-automation-intake-${routeId}`,
        () => processAutomationRoute(options.database, routeId),
      );
    },
  );
}
