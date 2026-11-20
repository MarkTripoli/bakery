import { request as httpsRequest } from "node:https";
import type { Inngest } from "inngest";
import type { LookupFunction } from "node:net";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "@bakery/persistence";
import {
  EGRESS_REFUSED,
  endpointHostIsRefused,
  guardedLookup,
} from "./provider-egress.ts";
import {
  type ProbeOutcome,
  type ProbeResult,
  recordProbeResult,
} from "./provider-incidents.ts";

/**
 * The provider route probe (#26 slice 3): the first thing that produces input for
 * `recordProbeResult`.
 *
 * One health read per due route, leased so two processes never probe one route,
 * classified into the incident vocabulary, recorded through the generation fence,
 * and rescheduled with backoff. It sends no credential, so what it can prove is
 * limited and it says so: a response of any kind below 500 that is not a 429
 * means the endpoint is reachable, and that is *all* it means. A 401 is the normal
 * answer to an unauthenticated read, so the probe never reports
 * `credential_invalid` or `quota_exhausted`; only a real attempt can.
 */

/** The read's deadline: a probe that hangs must not hold a lease or a worker. */
export const PROBE_DEADLINE_MS = 10_000;
/** How long a claimed route is hidden from other processes. Longer than the deadline. */
export const PROBE_LEASE_SECONDS = 30;
const FIRST_RETRY_MS = 30_000;
const RETRY_CEILING_MS = 300_000;
/** A reachable route is looked at again on this interval. */
const STEADY_INTERVAL_MS = 300_000;
/** `Retry-After` is honoured up to this; a provider cannot park a route for a day. */
const RETRY_AFTER_CEILING_MS = 3_600_000;
/**
 * Whether a failure (a probe's, or a real attempt's) may open an incident.
 *
 * The ruling on #26 kept this off until something could close an incident, so a
 * transient outage could never permanently remove a route. That closer now exists
 * (#70): a completed attempt on a route's pin is `inference_proven`
 * (`attempt-route-evidence.ts`), and claiming work never checks a route's health,
 * so the next step that runs on the pin and succeeds closes the incident.
 */
export const PROBE_OPENS_INCIDENTS = true;
/** A route whose host the server may not call is retried rarely; it is a configuration fault. */
const REFUSED_RETRY_MS = 3_600_000;

export type ProbeTransportResult =
  | { kind: "response"; status: number; retryAfter: string | null }
  | { kind: "timeout" }
  | { kind: "network_error" }
  | { kind: "refused" };

/** One unauthenticated GET, no redirects, no body read, a hard deadline. */
export type ProbeTransport = (
  endpoint: string,
) => Promise<ProbeTransportResult>;

/**
 * The production transport.
 *
 * `node:https` and not `fetch`, because a connection's address can only be chosen
 * and checked in one step through its `lookup` option; `fetch` offers no such
 * hook. It follows no redirect, sends no credential and no body, and destroys the
 * response without reading it, so a hostile endpoint cannot make the probe buffer
 * anything.
 */
export function httpsProbeTransport(
  options: {
    deadlineMs?: number;
    lookup?: LookupFunction;
    /** Replaceable so a test can watch what is sent without a network. */
    request?: typeof httpsRequest;
  } = {},
): ProbeTransport {
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
  const lookup = options.lookup ?? guardedLookup();
  const request = options.request ?? httpsRequest;
  return (endpoint) =>
    new Promise((resolve) => {
      if (endpointHostIsRefused(endpoint)) {
        resolve({ kind: "refused" });
        return;
      }
      const url = new URL(endpoint);
      const signal = AbortSignal.timeout(deadlineMs);
      let settled = false;
      const settle = (result: ProbeTransportResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const req = request({
        method: "GET",
        protocol: "https:",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port === "" ? 443 : Number(url.port),
        path: url.pathname,
        headers: { accept: "*/*", "user-agent": "bakery-provider-probe" },
        agent: false,
        lookup,
        signal,
      }, (response) => {
        const retryAfter = response.headers["retry-after"];
        settle({
          kind: "response",
          status: response.statusCode ?? 0,
          retryAfter: typeof retryAfter === "string" ? retryAfter : null,
        });
        response.destroy();
      });
      req.on("error", (error: Error & { code?: string; name: string }) => {
        if (error.code === EGRESS_REFUSED) settle({ kind: "refused" });
        else if (
          error.name === "AbortError" || error.code === "ETIMEDOUT" ||
          signal.aborted
        ) settle({ kind: "timeout" });
        else settle({ kind: "network_error" });
      });
      req.end();
    });
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date, capped; null when unusable. */
export function parseRetryAfter(
  value: string | null,
  now: Date,
): number | null {
  if (value === null) return null;
  const text = value.trim();
  let ms: number;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    ms = at - now.getTime();
  }
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, RETRY_AFTER_CEILING_MS);
}

export type Classified =
  | { kind: "outcome"; outcome: ProbeOutcome; retryAfterMs: number | null }
  | { kind: "refused" };

/**
 * A transport result in the incident vocabulary.
 *
 * Only a failure and a plain "it answered" are possible. A 429 is a slowdown, so
 * `degraded` with the provider's own wait; a 5xx, a timeout and a failed
 * connection are `outage`; a redirect is `redirected` and proves nothing. Everything else the endpoint answers (including
 * 401, 403 and 404) is reachable, which is deliberately weak.
 */
export function classifyProbe(
  result: ProbeTransportResult,
  watermark: string,
  now: Date,
): Classified {
  if (result.kind === "refused") return { kind: "refused" };
  const failure = (
    reason: Extract<ProbeOutcome, { kind: "failure" }>["reason"],
    severity: "degraded" | "outage",
    retryAfterMs: number | null = null,
  ): Classified => ({
    kind: "outcome",
    outcome: {
      kind: "failure",
      reason,
      severity,
      evidenceWatermark: watermark,
    },
    retryAfterMs,
  });
  if (result.kind === "timeout") return failure("timeout", "outage");
  if (result.kind === "network_error") {
    return failure("transport_failure", "outage");
  }
  if (result.status === 429) {
    return failure(
      "rate_limited",
      "degraded",
      parseRetryAfter(result.retryAfter, now),
    );
  }
  if (result.status >= 500) return failure("provider_error", "outage");
  // A redirect is not an answer from the endpoint the route names. The probe
  // follows none, so it cannot say where the redirect leads or that the real
  // endpoint is up. Counting it reachable would let a redirecting host (a moved
  // API, a captive page, a hostile one) pass as healthy; counting it a failure
  // would blame the provider for a host that did answer. It is its own outcome and
  // it proves nothing: only the probe time and schedule are recorded.
  if (result.status >= 300 && result.status < 400) {
    return {
      kind: "outcome",
      outcome: { kind: "redirected", evidenceWatermark: watermark },
      retryAfterMs: null,
    };
  }
  return {
    kind: "outcome",
    outcome: { kind: "reachable", evidenceWatermark: watermark },
    retryAfterMs: null,
  };
}

/**
 * When to probe next. A failure backs off 30 s, 1 min, 2 min, up to 5 min, with
 * jitter so a fleet of routes that failed together does not retry together, and
 * never sooner than the provider's `Retry-After`. A reachable route is looked at
 * again on a steady interval.
 */
export function nextProbeAt(
  outcome: ProbeOutcome,
  consecutiveFailures: number,
  retryAfterMs: number | null,
  now: Date,
  random: () => number,
): Date {
  if (outcome.kind !== "failure") {
    return new Date(now.getTime() + jittered(STEADY_INTERVAL_MS, random));
  }
  const exponent = Math.max(0, consecutiveFailures - 1);
  const base = Math.min(FIRST_RETRY_MS * 2 ** exponent, RETRY_CEILING_MS);
  const delay = Math.max(jittered(base, random), retryAfterMs ?? 0);
  return new Date(now.getTime() + Math.min(delay, RETRY_AFTER_CEILING_MS));
}

/** `ms` within plus or minus 20 percent. */
function jittered(ms: number, random: () => number): number {
  return Math.round(ms * (0.8 + random() * 0.4));
}

export type ClaimedRoute = {
  organizationId: string;
  routeId: string;
  endpoint: string;
  /** The route's incident generation now: the generation this probe is admitted under. */
  generation: number;
  consecutiveFailures: number;
  /**
   * The lease's expiry exactly as Postgres wrote it, microseconds included. It is
   * unique per claim, so it names one probe: a retried delivery of that probe's
   * result dedupes and a new probe does not, and a release only frees the lease it
   * took. Kept as text because a JavaScript `Date` loses the microseconds and
   * would never equal the stored value.
   */
  leaseToken: string;
};

type ClaimRow = {
  organization_id: string;
  route_id: string;
  endpoint: string;
  incident_generation: number;
  consecutive_failures: number;
  lease_token: string;
};

/**
 * Claims up to `limit` due routes for `leaseSeconds`.
 *
 * Due means active, past its `next_probe_at` (a route never probed has none and is
 * due at once), and not under another process's lease. The routes are locked with
 * `skip locked`, so two processes claiming at once take different routes and
 * neither waits. The lease is written to the route's health row, created on first
 * claim, in the same statement.
 */
export async function claimDueRoutes(
  database: PgDatabase,
  options: { limit: number; leaseSeconds: number },
): Promise<ClaimedRoute[]> {
  return await withPgTransaction(database, async (transaction) => {
    const result = await transaction.query<ClaimRow>(
      `with due as (
         select r.organization_id, r.id, r.health
           from bakery.provider_routes as r
           left join bakery.provider_route_health as h
             on h.organization_id = r.organization_id and h.route_id = r.id
          where r.status = 'active'
            and (r.next_probe_at is null or r.next_probe_at <= clock_timestamp())
            and (h.probe_lease_expires_at is null
                 or h.probe_lease_expires_at <= clock_timestamp())
          order by coalesce(r.next_probe_at, r.created_at), r.id
          limit $1
            for update of r skip locked
       ), leased as (
         insert into bakery.provider_route_health as h (
           organization_id, route_id, health, probe_lease_expires_at
         )
         select d.organization_id, d.id, d.health,
                clock_timestamp() + make_interval(secs => $2::double precision)
           from due as d
         on conflict (organization_id, route_id) do update
           set probe_lease_expires_at = excluded.probe_lease_expires_at,
               updated_at = now()
         returning h.organization_id, h.route_id, h.probe_lease_expires_at,
                   h.consecutive_failures
       )
       select r.organization_id, r.id as route_id, r.endpoint,
              r.incident_generation, l.consecutive_failures,
              l.probe_lease_expires_at::text as lease_token
         from leased as l
         join bakery.provider_routes as r
           on r.organization_id = l.organization_id and r.id = l.route_id`,
      [options.limit, options.leaseSeconds],
    );
    return result.rows.map((row) => ({
      organizationId: row.organization_id,
      routeId: row.route_id,
      endpoint: row.endpoint,
      generation: row.incident_generation,
      consecutiveFailures: row.consecutive_failures,
      leaseToken: row.lease_token,
    }));
  });
}

export type ProbeRunResult =
  | { routeId: string; kind: "recorded"; result: ProbeResult }
  | { routeId: string; kind: "refused" };

/** Probes one claimed route and records what it found. */
export async function probeClaimedRoute(
  database: PgDatabase,
  claimed: ClaimedRoute,
  dependencies: {
    transport: ProbeTransport;
    now: () => Date;
    random: () => number;
  },
): Promise<ProbeRunResult> {
  const transportResult = await dependencies.transport(claimed.endpoint);
  const observedAt = dependencies.now();
  const classified = classifyProbe(
    transportResult,
    `probe:${claimed.leaseToken}`,
    observedAt,
  );
  if (classified.kind === "refused") {
    // Not the provider's fault, so it is not an outage: the route's host is one
    // the server may not call. Leave its state alone, say so once, and look
    // again rarely; the endpoint needs an administrator's attention.
    await withPgTransaction(database, async (transaction) => {
      await releaseLease(transaction, claimed, {
        nextProbeAt: new Date(observedAt.getTime() + REFUSED_RETRY_MS),
      });
    });
    console.warn(JSON.stringify({
      component: "provider-probe",
      event: "provider_probe_egress_refused",
      routeId: claimed.routeId,
    }));
    return { routeId: claimed.routeId, kind: "refused" };
  }
  const failures = classified.outcome.kind === "failure"
    ? claimed.consecutiveFailures + 1
    : 0;
  const next = nextProbeAt(
    classified.outcome,
    failures,
    classified.retryAfterMs,
    observedAt,
    dependencies.random,
  );
  const result = await withPgTransaction(database, async (transaction) => {
    const recorded = await recordProbeResult(transaction, {
      organizationId: claimed.organizationId,
      routeId: claimed.routeId,
      generation: claimed.generation,
      observedAt,
      nextProbeAt: next,
      incidents: PROBE_OPENS_INCIDENTS ? "on" : "off",
      outcome: classified.outcome,
    });
    // A result that changed nothing (stale, duplicate, withdrawn route) wrote no
    // health row, so the lease would otherwise sit until it expires.
    if (
      recorded.kind === "stale" || recorded.kind === "duplicate" ||
      recorded.kind === "ignored"
    ) {
      await releaseLease(transaction, claimed, { nextProbeAt: null });
    }
    return recorded;
  });
  return { routeId: claimed.routeId, kind: "recorded", result };
}

async function releaseLease(
  transaction: PgTransactionClient,
  claimed: ClaimedRoute,
  options: { nextProbeAt: Date | null },
): Promise<void> {
  await transaction.query(
    `update bakery.provider_route_health
        set probe_lease_expires_at = null,
            next_probe_at = coalesce($3, next_probe_at), updated_at = now()
      where organization_id = $1 and route_id = $2
        and probe_lease_expires_at = $4::timestamptz`,
    [
      claimed.organizationId,
      claimed.routeId,
      options.nextProbeAt,
      claimed.leaseToken,
    ],
  );
  if (options.nextProbeAt !== null) {
    await transaction.query(
      `update bakery.provider_routes
          set next_probe_at = $3, updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and status = 'active'`,
      [claimed.organizationId, claimed.routeId, options.nextProbeAt],
    );
  }
}

/**
 * Probes every due route, a few at a time. The cap on routes per run and on
 * concurrency keeps one tick from opening an unbounded number of connections.
 */
export async function runDueProbes(
  database: PgDatabase,
  options: {
    transport?: ProbeTransport;
    now?: () => Date;
    random?: () => number;
    limit?: number;
    concurrency?: number;
  } = {},
): Promise<ProbeRunResult[]> {
  const dependencies = {
    transport: options.transport ?? httpsProbeTransport(),
    now: options.now ?? (() => new Date()),
    random: options.random ?? Math.random,
  };
  const claimed = await claimDueRoutes(database, {
    limit: options.limit ?? 20,
    leaseSeconds: PROBE_LEASE_SECONDS,
  });
  const results: ProbeRunResult[] = [];
  const concurrency = Math.max(1, options.concurrency ?? 5);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, claimed.length) }, async () => {
      while (index < claimed.length) {
        const route = claimed[index++]!;
        results.push(await probeClaimedRoute(database, route, dependencies));
      }
    }),
  );
  return results;
}

/** The function's stable id, and the cadence a missed wake is recovered on. */
export const PROVIDER_PROBE_FUNCTION_ID = "bakery-provider-route-probe";
export const PROVIDER_PROBE_CRON = "* * * * *";

/**
 * Every minute, probes whichever routes are due.
 *
 * The schedule lives in Postgres (`next_probe_at`), not in a sleeping workflow, so
 * there is one clock and a missed wake costs at most one tick: the next minute
 * claims whatever is due. `concurrency: 1` keeps two ticks of this function from
 * overlapping; the lease is what keeps two *processes* off one route.
 */
export function createProviderProbeWorkflow(
  options: { database: PgDatabase; client: Inngest },
) {
  return options.client.createFunction(
    {
      id: PROVIDER_PROBE_FUNCTION_ID,
      retries: 1,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: PROVIDER_PROBE_CRON }],
    },
    async ({ step }) =>
      await step.run("probe-due-provider-routes", async () => {
        const results = await runDueProbes(options.database);
        return { probed: results.length };
      }),
  );
}
