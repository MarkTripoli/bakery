import type { BudgetRuntimeConfig } from "@bakery/config";
import { INNGEST_EVENT_DEFINITIONS } from "@bakery/contracts/events";
import { StandardError } from "@bakery/contracts/http";
import type { Inngest } from "inngest";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import { eventRouteId } from "../integrations/intake-workflow.ts";
import { readIssueRouteTarget } from "../integrations/ticket-reads.ts";
import {
  type AdmissionDeps,
  type AdmissionKind,
  admitTicket,
  type RecheckAction,
  recheckTicket,
} from "./ticket-admission.ts";
import { requestedIntentFromLabels } from "./ticket-policy.ts";
import { prefetchTicketReads } from "./ticket-prefetch.ts";
import type {
  TicketFactIndex,
  TicketSourceReader,
} from "./ticket-source-reader.ts";
import {
  findTicketForNumber,
  readSourceHandle,
  SYNC_INSTANT_PATTERN,
} from "./ticket-store.ts";
import {
  INTERNAL_PROBLEM_CODE,
  problemCodeOf,
  recordStepDefect,
  recordStepRefusal,
  runTicketSourceStep,
  SYNC_STEP_LIMIT,
  type SyncStepResult,
  TicketCandidateDefect,
} from "./ticket-sync.ts";

/**
 * Ticket automation: the two Inngest functions that feed the shared admission
 * code from GitHub. The intake function reacts to a verified `issues` delivery
 * and the poll function sweeps every enabled source on a schedule. Both read
 * GitHub first, with no transaction open, and hand the answers to
 * `admitTicket` or `recheckTicket`, which re-verify authority, the provider
 * marker and the actor under their locks. A provider failure is an answer, not
 * a throw: it ends the step with a recorded outcome and the next poll tries
 * again. An unexpected error in the intake function is rethrown, for Inngest to
 * retry; in the poll it is recorded for its source (`internal`), so the sweep
 * goes on to the next source instead of stopping at it.
 */

export const TICKET_INTAKE_FUNCTION_ID = "bakery-ticket-intake";
export const TICKET_POLL_FUNCTION_ID = "bakery-ticket-poll";
/** Every five minutes, as the fact sweep that keeps the fact index current. */
export const TICKET_POLL_CRON = "*/5 * * * *";
/** Most sources one poll run looks at; the least recently attempted go first. */
export const POLL_SOURCES_PER_RUN = 100;

const INTAKE_EVENT = INNGEST_EVENT_DEFINITIONS["intake.received"].name;

export type TicketWorkflowDeps = {
  database: PgDatabase;
  /** The live reader; every provider read of the functions goes through it. */
  reader: TicketSourceReader;
  /** The live fact index, or an in-memory one in tests. */
  factIndex: TicketFactIndex;
  /** Server budget policy; the fixed preset's availability reads it, so without it no ticket is ready. */
  budget: BudgetRuntimeConfig | undefined;
};

/** What the intake function did for one source of the delivery's repository. */
export type TicketIntakeSourceOutcome = {
  sourceId: string;
  /** `admit`: no request existed and the issue asks for one; `recheck`: a request exists. */
  action: "admit" | "recheck" | "none";
  admission: AdmissionKind | null;
  applied: RecheckAction[];
  /**
   * Fixed code of a provider failure or a refusal; null when the source was
   * handled. A failed issue read is `provider_unavailable:<reason>` with the
   * reader's reason (`forbidden` for lost authority, `rate_limited`, ...).
   */
  problem: string | null;
};

export type TicketIntakeOutcome =
  | {
    kind: "ignored";
    reason: "event_invalid" | "no_issue_target" | "no_source";
  }
  | { kind: "processed"; sources: TicketIntakeSourceOutcome[] };

/**
 * Handles the `issues` delivery a route names, for every enabled source on
 * its repository. A source that already owns a nonterminal request for the
 * issue rechecks it, whatever the action (the recheck suspends, resumes,
 * pauses or advances it); a source without one admits the issue only when its
 * live labels ask for a request. Any other route (another event kind, another
 * purpose) names no issue and is ignored.
 */
export async function processTicketIntake(
  deps: TicketWorkflowDeps,
  routeId: string,
  signal: AbortSignal,
): Promise<TicketIntakeOutcome> {
  const target = await withPgTransaction(
    deps.database,
    (transaction) => readIssueRouteTarget(transaction, routeId),
    signal,
  );
  if (target === null) return { kind: "ignored", reason: "no_issue_target" };
  const sources = await deps.database.query<{ id: string }>(
    `select id from bakery.ticket_sources
      where organization_id = $1 and integration_connection_id = $2
        and integration_resource_id = $3 and enabled
      order by id`,
    [target.organizationId, target.connectionId, target.resourceId],
  );
  if (sources.rows.length === 0) {
    return { kind: "ignored", reason: "no_source" };
  }
  const outcomes: TicketIntakeSourceOutcome[] = [];
  for (const { id } of sources.rows) {
    outcomes.push(
      await intakeSource(
        deps,
        {
          routeId,
          organizationId: target.organizationId,
          number: target.number,
        },
        id,
        signal,
      ),
    );
  }
  return { kind: "processed", sources: outcomes };
}

async function intakeSource(
  deps: TicketWorkflowDeps,
  issue: { routeId: string; organizationId: string; number: number },
  sourceId: string,
  signal: AbortSignal,
): Promise<TicketIntakeSourceOutcome> {
  const { organizationId, number } = issue;
  const outcome = (
    detail: Partial<TicketIntakeSourceOutcome>,
  ): TicketIntakeSourceOutcome => ({
    sourceId,
    action: "none",
    admission: null,
    applied: [],
    problem: null,
    ...detail,
  });
  try {
    // The reads come first and run with no transaction open.
    const { source, handle } = await withPgTransaction(
      deps.database,
      (transaction) => readSourceHandle(transaction, organizationId, sourceId),
      signal,
    );
    const prefetch = await prefetchTicketReads(
      deps.reader,
      handle,
      { number, policy: source.policy, origin: "webhook" },
      signal,
    );
    const found = await withPgTransaction(
      deps.database,
      (transaction) =>
        findTicketForNumber(transaction, organizationId, sourceId, number),
      signal,
    );
    const unavailable = prefetch.issue.kind === "unavailable"
      ? `provider_unavailable:${prefetch.issue.reason}`
      : null;
    const admission: AdmissionDeps = {
      reader: deps.reader,
      budget: deps.budget,
      readsAllowed: true,
      database: deps.database,
    };
    if (found?.requestId != null) {
      const rechecked = await recheckTicket(admission, {
        organizationId,
        ticketId: found.ticketId,
        origin: "webhook",
        prefetch,
        signal,
      });
      return outcome({
        action: "recheck",
        applied: rechecked.applied,
        problem: unavailable,
      });
    }
    const asked = prefetch.issue.kind === "present" &&
      requestedIntentFromLabels(
          prefetch.issue.snapshot.labels,
          source.policy,
        ) !==
        null;
    // A failed read tells nothing about the labels. A ticket Bakery already
    // knows still gets its `provider_unavailable` report; an unknown one has
    // nothing to store, and the poll finds it once the fact index lists it.
    if (asked || (unavailable !== null && found !== null)) {
      const admitted = await admitTicket(admission, {
        organizationId,
        sourceId,
        number,
        intent: null,
        origin: "webhook",
        caller: null,
        prefetch,
        inboundEventRouteId: issue.routeId,
        signal,
      });
      return outcome({
        action: "admit",
        admission: admitted.kind,
        problem: unavailable,
      });
    }
    return outcome({ problem: unavailable });
  } catch (error) {
    if (error instanceof StandardError) {
      return outcome({ problem: problemCodeOf(error) });
    }
    throw error;
  }
}

/**
 * Reacts to each `intake.received` event: the delivery the #71 receiver
 * verified and routed. It runs beside the #71 processor, which refreshes the
 * fact index, and reads GitHub itself, so neither waits for the other.
 */
export function createTicketIntakeWorkflow(
  options: TicketWorkflowDeps & { client: Inngest },
) {
  const { client, ...deps } = options;
  return client.createFunction(
    {
      id: TICKET_INTAKE_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 4 }],
      triggers: [{ event: INTAKE_EVENT }],
    },
    async ({ event, step }) => {
      const routeId = eventRouteId(event);
      if (routeId === undefined) {
        return { kind: "ignored", reason: "event_invalid" } as const;
      }
      return await step.run(
        `process-ticket-intake-${routeId}`,
        () => processTicketIntake(deps, routeId, new AbortController().signal),
      );
    },
  );
}

/** An enabled source the poll looks at. */
export type PollSource = { organizationId: string; sourceId: string };

/**
 * The enabled sources a poll run looks at, a system sweep across
 * organizations: least recently attempted first, so a source that stops on a
 * rate limit or lost authority (and keeps its old `last_synced_at`) takes its
 * turn behind the rest and cannot hold the front of every run. A source still
 * waiting out a rate limit is left out: its step would read nothing. The
 * instants are fixed-format ISO text and compare as text; a stored value of
 * another shape is corrupt, so it never silences a source: a `notBefore` that
 * is not that shape is no wait (the step reads the checkpoint as empty and
 * repairs it) and an `attemptedAt` that is not that shape counts as never
 * attempted.
 */
export async function listPollSources(
  database: PgDatabase,
  limit = POLL_SOURCES_PER_RUN,
  now: Date = new Date(),
): Promise<PollSource[]> {
  const result = await database.query<PollSource>(
    `select organization_id as "organizationId", id as "sourceId"
       from bakery.ticket_sources
      where enabled
        and (sync_checkpoint->>'notBefore' is null
             or (sync_checkpoint->>'notBefore') !~ $3
             or (sync_checkpoint->>'notBefore') collate "C" <= $2)
      order by (case when (sync_checkpoint->>'attemptedAt') ~ $3
                     then sync_checkpoint->>'attemptedAt' end) collate "C"
                 nulls first,
               last_synced_at nulls first, id
      limit $1`,
    [limit, now.toISOString(), SYNC_INSTANT_PATTERN],
  );
  return result.rows;
}

/** How one source's poll step ended; `failed` is a refusal recorded by code. */
export type TicketPollOutcome = {
  sourceId: string;
  outcome: SyncStepResult["outcome"] | "failed";
  health: SyncStepResult["health"];
  problemCode: string | null;
  candidates: number;
  admitted: number;
  rechecked: number;
  /** Class name of the unexpected error the step died on, recorded as `internal`; absent otherwise. */
  errorName?: string;
  /** Issue number of the candidate that error came from, a fixed integer; absent when it came from no candidate. */
  candidateNumber?: number;
};

/**
 * Runs one bounded sync step for one source, reading with no transaction open.
 * A refusal (any `StandardError` the step throws) ends the step as a `failed`
 * outcome under its code, with no health (the step moved none). It comes before
 * the step's own write. Examples: a stored policy that does not parse, a
 * missing connection or resource, a stored marker that is not a date. The poll
 * stamps the attempt and the code on the row if it still exists, and the source
 * takes its turn behind the rest; it still needs an operator fix. An unexpected
 * error ends the step as a `failed` outcome too, under `internal`: the source
 * is stamped as attempted and `degraded` (`auth_required` stays), so it takes
 * its turn behind the rest and the sweep goes on; the outcome's `health` is the
 * one left on the row. Nothing moves the source's position, so it stalls at the
 * same candidate until the bug is fixed. The outcome and one log line carry the
 * error class name, the number of the failing candidate, the source id and the
 * code, never the message, which may hold issue text or a token.
 */
export async function pollTicketSource(
  deps: TicketWorkflowDeps,
  source: PollSource,
  signal: AbortSignal,
): Promise<TicketPollOutcome> {
  try {
    const step = await runTicketSourceStep(
      {
        reader: deps.reader,
        budget: deps.budget,
        readsAllowed: true,
        database: deps.database,
        factIndex: deps.factIndex,
      },
      {
        organizationId: source.organizationId,
        sourceId: source.sourceId,
        limit: SYNC_STEP_LIMIT,
        signal,
      },
    );
    return {
      sourceId: source.sourceId,
      outcome: step.outcome,
      health: step.health,
      problemCode: step.problemCode,
      candidates: step.results.length,
      admitted: step.results.filter((entry) => entry.admission === "admitted")
        .length,
      rechecked: step.results.filter((entry) => entry.action === "recheck")
        .length,
    };
  } catch (error) {
    const failed = {
      sourceId: source.sourceId,
      outcome: "failed" as const,
      candidates: 0,
      admitted: 0,
      rechecked: 0,
    };
    if (error instanceof StandardError) {
      const problemCode = problemCodeOf(error);
      await recordStepRefusal(deps.database, {
        ...source,
        problemCode,
        signal,
      });
      return { ...failed, health: null, problemCode };
    }
    const defect = error instanceof TicketCandidateDefect ? error : null;
    const errorName = defect?.errorName ??
      (error instanceof Error ? error.name : typeof error);
    const candidateNumber = defect?.candidateNumber;
    console.error(JSON.stringify({
      component: "work",
      event: "ticket_poll_step_defect",
      sourceId: source.sourceId,
      code: INTERNAL_PROBLEM_CODE,
      errorName,
      candidateNumber,
    }));
    const health = await recordStepDefect(deps.database, { ...source, signal });
    return {
      ...failed,
      health,
      problemCode: INTERNAL_PROBLEM_CODE,
      errorName,
      ...(candidateNumber === undefined ? {} : { candidateNumber }),
    };
  }
}

/**
 * Every five minutes, one sync step for each enabled source: new issues the
 * fact index lists, every request and every waiting ticket in rotation. The
 * concurrency limit keeps one run at a time; each source is its own step, so
 * a retry repeats one source and not the sweep.
 */
export function createTicketPollWorkflow(
  options: TicketWorkflowDeps & {
    client: Inngest;
    /** Most sources one run looks at; defaults to `POLL_SOURCES_PER_RUN`. */
    sourcesPerRun?: number;
  },
) {
  const { client, sourcesPerRun, ...deps } = options;
  return client.createFunction(
    {
      id: TICKET_POLL_FUNCTION_ID,
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: TICKET_POLL_CRON }],
    },
    async ({ step }) => {
      const sources = await step.run(
        "list-ticket-sources",
        () => listPollSources(deps.database, sourcesPerRun),
      );
      const outcomes: TicketPollOutcome[] = [];
      for (const source of sources) {
        outcomes.push(
          await step.run(
            `sync-ticket-source-${source.sourceId}`,
            () => pollTicketSource(deps, source, new AbortController().signal),
          ),
        );
      }
      return { sources: sources.length, outcomes };
    },
  );
}
