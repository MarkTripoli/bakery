import type { OrganizationActor } from "../auth/application/authority.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import type { BudgetRuntimeConfig } from "@bakery/config";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import { type AdmissionResult, admitTicket } from "./ticket-admission.ts";
import type { TicketSourceReader } from "./ticket-source-reader.ts";
import type { StartResult } from "./batch-tick.ts";

/**
 * The batch supervisor's way of starting an issue (#58).
 *
 * It starts nothing the existing admission would not. Each candidate goes through
 * `admitTicket` as an explicit manual request by the person who started the batch,
 * resolved live every time, so a revoked permission, a stale issue body, an open
 * dependency, a cycle or an unknown effect refuses the issue exactly as it would
 * refuse that person pressing Start work. A refusal passes the issue over with its
 * readiness reason; only a real new admission counts as started.
 */

const CANDIDATES_PER_START = 20;
/** The reasons that mean the provider did not answer: not the issue's fault, so nothing is passed over. */
const PROVIDER_DOWN = "provider_unavailable";

type Candidate = { id: string; sourceId: string; number: number };

export type BatchStartPortDeps = {
  database: PgDatabase;
  reader: TicketSourceReader;
  budget: BudgetRuntimeConfig | undefined;
  /** Replaceable so a test can answer admission without a provider. */
  admit?: typeof admitTicket;
  /** Replaceable so a test can name the starter's authority without a database. */
  resolveCaller?: (
    database: PgDatabase,
    organizationId: string,
    principalId: string,
  ) => Promise<OrganizationActor>;
  /** Time allowed for one admission, which may read the provider. */
  admissionTimeoutMs?: number;
};

/** The first failing check's reason, which is what the page shows for a passed-over issue. */
function refusalReason(result: AdmissionResult): string {
  const failing = result.report.checks.find((check) => check.status !== "pass");
  return failing?.reason ?? "not_ready";
}

/**
 * The open issues the batch could take, in number order: the repository's enabled
 * sources, minus any the batch already started, merged, failed or cancelled. An issue
 * passed over earlier stays a candidate, because GitHub is read again each time and
 * one that became ready can join.
 */
export async function listBatchCandidates(
  transaction: PgTransactionClient,
  input: { organizationId: string; repositoryId: string; batchId: string },
): Promise<Candidate[]> {
  const rows = await transaction.query<
    { id: string; source_id: string; number: number }
  >(
    `select ticket.id, ticket.ticket_source_id as source_id,
            ticket.number::int as number
       from bakery.external_tickets as ticket
       join bakery.ticket_sources as source
         on source.organization_id = ticket.organization_id
        and source.id = ticket.ticket_source_id
      where ticket.organization_id = $1 and source.repository_id = $2
        and source.enabled and ticket.state = 'open'
        and ticket.number ~ '^[0-9]+$'
        and not exists (
          select 1 from bakery.batch_issues as taken
           where taken.organization_id = ticket.organization_id
             and taken.batch_id = $3 and taken.external_ticket_id = ticket.id
             and taken.state <> 'passed_over'
        )
      order by ticket.number::int asc
      limit $4`,
    [
      input.organizationId,
      input.repositoryId,
      input.batchId,
      CANDIDATES_PER_START,
    ],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    number: row.number,
  }));
}

/**
 * Whether this batch's own admission made the request. Admission commits in its own
 * transactions, so a tick that fails after it has admitted an issue leaves a request the
 * batch has no row for. Admission stamps the request id it was called with (`batch:<id>`) on
 * the audit row it writes, which is how the batch recognizes its own request later and not
 * one a person made.
 */
async function admittedByThisBatch(
  transaction: PgTransactionClient,
  input: { organizationId: string; batchId: string },
  ticketRequestId: string,
): Promise<boolean> {
  const found = await transaction.query(
    `select 1 from bakery.audit_events
      where organization_id = $1
        and resource_type = 'ticket_request' and resource_id = $2
        and operation = 'ticketRequests.create' and request_id = $3
      limit 1`,
    [input.organizationId, ticketRequestId, `batch:${input.batchId}`],
  );
  return found.rows.length > 0;
}

export function createBatchStartPort(deps: BatchStartPortDeps) {
  const admit = deps.admit ?? admitTicket;
  const resolveCaller = deps.resolveCaller ??
    ((database, organizationId, principalId) =>
      withPgTransaction(
        database,
        (actorTransaction) =>
          resolveOrganizationActor(
            actorTransaction,
            principalId as never,
            organizationId as never,
          ),
      ));
  return async (
    transaction: PgTransactionClient,
    input: {
      organizationId: string;
      batchId: string;
      repositoryId: string;
      startedBy: string;
    },
  ): Promise<StartResult> => {
    const candidates = await listBatchCandidates(transaction, input);
    const passedOver: { externalTicketId: string; reason: string }[] = [];
    for (const candidate of candidates) {
      // The starter's authority, read fresh for every issue.
      const caller = await resolveCaller(
        deps.database,
        input.organizationId,
        input.startedBy,
      );
      const result = await admit(
        {
          reader: deps.reader,
          budget: deps.budget,
          readsAllowed: true,
          database: deps.database,
        },
        {
          organizationId: input.organizationId,
          sourceId: candidate.sourceId,
          number: candidate.number,
          intent: "start",
          origin: "manual",
          caller,
          prefetch: null,
          signal: AbortSignal.timeout(deps.admissionTimeoutMs ?? 30_000),
          trace: {
            requestId: `batch:${input.batchId}`,
            traceId: `batch:${input.batchId}`,
          },
        },
      );
      if (result.kind === "admitted" && result.request) {
        return {
          started: true,
          externalTicketId: candidate.id,
          ticketRequestId: result.request.id,
          passedOver,
        };
      }
      // This batch admitted it on an earlier tick that then lost its transaction: take it
      // back as the started issue. Passing it over would leave its run going untracked.
      if (
        result.kind === "existing" && result.request &&
        await admittedByThisBatch(transaction, input, result.request.id)
      ) {
        return {
          started: true,
          externalTicketId: candidate.id,
          ticketRequestId: result.request.id,
          passedOver,
        };
      }
      const reason = result.kind === "unadmitted"
        ? refusalReason(result)
        // Someone already asked for it, or asked again with another intent: not the
        // batch's to take.
        : "already_requested";
      if (reason === PROVIDER_DOWN) {
        // GitHub did not answer. Nothing is wrong with the issue, so it is not passed
        // over: the tick fails for this batch and tries again, and the page can say so.
        throw new Error("PROVIDER_UNAVAILABLE");
      }
      passedOver.push({ externalTicketId: candidate.id, reason });
    }
    return { started: false, passedOver };
  };
}
