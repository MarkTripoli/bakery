import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import {
  isTerminalTicketDisposition,
  type TicketReadinessReport,
} from "@bakery/contracts/ticket-admission";
import {
  appendAudit,
  appendDomainEvent,
  nextAggregateVersion,
} from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import { authorize } from "../auth/application/authorize.ts";
import { admitTicket, recordReadiness } from "./ticket-admission.ts";
import {
  dependencyUnavailable,
  preconditionFailed,
  type TicketOperationDependencies,
  ticketReads,
} from "./ticket-operation-runner.ts";
import { requestedIntentFromLabels } from "./ticket-policy.ts";
import { getTicketRequest } from "./ticket-request-query.ts";
import type { TicketPrefetch } from "./ticket-prefetch.ts";
import type { TicketReadFailure } from "./ticket-source-reader.ts";
import {
  lockSource,
  lockTicket,
  readTaskState,
  readTicketRef,
  requestById,
  requestTargets,
  runStatusOf,
  type TicketRequest,
  type TicketSource,
  updateRequest,
} from "./ticket-store.ts";
import { loadTaskScope } from "./postgres.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

/**
 * Ticket readiness, link and request commands. Each commits its state change,
 * an audit row and the catalog's domain event in one transaction; the events
 * carry no outbox delivery key. Readiness and request answers were read by the
 * operation runner before this transaction opened (`ticketReads`), so no
 * handler here reads GitHub. Lock order is the one admission uses: the ticket's
 * source `for share`, then the ticket, then (inside admission) the application
 * and the task.
 */

type OperationReceipt = z.output<typeof contractSchemas.TicketOperationReceipt>;
type ReadinessCreate = z.output<typeof contractSchemas.TicketReadinessCreate>;
type LinkCreate = z.output<typeof contractSchemas.TicketTaskLinkCreate>;
type LinkOutput = z.output<typeof contractSchemas.TicketTaskLink>;
type RequestCreate = z.output<typeof contractSchemas.TicketRequestCreate>;
type RequestOutput = z.output<typeof contractSchemas.TicketRequest>;
type RequestView = z.output<typeof contractSchemas.TicketRequestView>;
type RequestCancel = z.output<typeof contractSchemas.TicketRequestCancel>;

function ticketId(context: ActionContext): string {
  if (!context.params.id) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return context.params.id;
}

function actorOf(context: ActionContext): OrganizationActor {
  const authority = (context as Partial<AuthorizedActionContext>).authority;
  if (!authority || !("organizationId" in authority)) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return authority as OrganizationActor;
}

/**
 * `ticketRequests.create` guard: the caller holds `task:write` and `run:write`
 * now. The catalog permission alone (`ticketRequest:write`, which an action
 * grant can give) would let a person without them start work, because a
 * request creates a task and may start a run as its caller.
 */
export function authorizeTicketAdmission(context: ActionContext): void {
  const actor = actorOf(context);
  authorize(actor, "task:write");
  authorize(actor, "run:write");
}

/** The ticket's source, locked `for share` at the policy revision the caller last saw, and the ticket's issue number. */
async function lockedSource(
  transaction: PgTransactionClient,
  organizationId: string,
  id: string,
  expectedRevision: number,
): Promise<{ source: TicketSource; number: number }> {
  const ref = await readTicketRef(transaction, organizationId, id);
  const source = await lockSource(transaction, organizationId, ref.sourceId);
  if (source.policyRevision !== expectedRevision) {
    throw preconditionFailed("source_policy_changed");
  }
  if (ref.number === null) throw unprocessable(["id"], "ticket_number_missing");
  return { source, number: ref.number };
}

/** Audit row and domain event of one operation, in the caller's transaction. */
async function recordFact(
  context: ActionContext,
  transaction: PgTransactionClient,
  facts: {
    organizationId: string;
    principalId: string;
    applicationId: string | null;
    repositoryId: string | null;
    task?: { id: string; conversation_id: string };
    operation: string;
    resourceType: string;
    resourceId: string;
    resourceVersion: number;
    eventType: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: facts.organizationId,
    principalId: facts.principalId,
    operation: facts.operation,
    resourceType: facts.resourceType,
    resourceId: facts.resourceId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: facts.details,
  });
  await appendDomainEvent(transaction, {
    organizationId: facts.organizationId,
    applicationId: facts.applicationId,
    repositoryId: facts.repositoryId,
    taskId: facts.task?.id ?? null,
    conversationId: facts.task?.conversation_id ?? null,
    eventType: facts.eventType,
    aggregateId: facts.resourceId,
    aggregateVersion: await nextAggregateVersion(
      transaction,
      facts.organizationId,
      facts.resourceId,
      facts.eventType,
    ),
    payload: {
      resourceId: facts.resourceId,
      resourceVersion: facts.resourceVersion,
    },
    traceId: context.traceId,
  });
}

/**
 * `ticketReadiness.create`: records the snapshot and a readiness report of one
 * ticket from the answers read before the transaction opened, judged as a poll
 * would judge it (or as the recheck of the request the ticket owns). A failed
 * read is recorded as a `provider_unavailable` report, not refused. It admits
 * nothing: no task, link, request or run is written.
 */
export function createTicketReadinessHandler(
  dependencies: TicketOperationDependencies,
) {
  return async (
    context: ActionContext,
    input: ReadinessCreate,
  ): Promise<OperationReceipt> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const id = ticketId(context);
    const { prefetch } = ticketReads(context, "ticket");
    const { source, number } = await lockedSource(
      transaction,
      organizationId,
      id,
      input.expectedSourcePolicyRevision,
    );
    const recorded = await recordReadiness({
      reader: dependencies.reader,
      budget: dependencies.budget,
      readsAllowed: false,
      transaction,
    }, {
      organizationId,
      sourceId: source.id,
      number,
      intent: null,
      origin: "poll",
      caller: null,
      prefetch,
      signal: context.signal,
      trace: { requestId: context.requestId, traceId: context.traceId },
    });
    const version = await transaction.query<{ version: number }>(
      `select version from bakery.external_tickets
        where organization_id = $1 and id = $2`,
      [organizationId, id],
    );
    await recordFact(context, transaction, {
      organizationId,
      principalId,
      applicationId: source.applicationId,
      repositoryId: source.repositoryId,
      operation: "ticketReadiness.create",
      resourceType: "external_ticket",
      resourceId: id,
      resourceVersion: version.rows[0].version,
      eventType: "ticket.readiness_requested",
      details: {
        verdict: recorded.report.verdict,
        reportId: recorded.storedReport?.id ?? null,
        sourcePolicyRevision: source.policyRevision,
      },
    });
    return { operationId: crypto.randomUUID(), status: "completed" };
  };
}

/**
 * `ticketTaskLinks.create`: a reference link between a ticket and a task of the
 * source's application. A primary link is the admission's: it owns execution,
 * so it is never made here. Linking starts no work. The ticket is locked
 * before the task is touched, the order admission uses, so a link cannot
 * deadlock with a recheck of the same ticket.
 */
export async function createTicketTaskLink(
  context: ActionContext,
  input: LinkCreate,
): Promise<LinkOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  if (input.role === "primary") {
    throw unprocessable(["role"], "primary_link_requires_admission");
  }
  // A link shows the caller the task: they must be able to read tasks.
  authorize(actorOf(context), "task:read");
  const id = ticketId(context);
  const ref = await readTicketRef(transaction, organizationId, id);
  const source = await lockSource(transaction, organizationId, ref.sourceId);
  await lockTicket(transaction, organizationId, id);
  const task = await loadTaskScope(
    transaction,
    organizationId,
    input.taskId,
    undefined,
    false,
  );
  if (task.application_id !== source.applicationId) {
    throw unprocessable(["taskId"], "task_not_in_source_application");
  }
  const inserted = await transaction.query<
    {
      id: string;
      sync_health: LinkOutput["syncHealth"];
      created_at: Date;
      updated_at: Date;
      version: number;
    }
  >(
    `insert into bakery.ticket_task_links (
       id, organization_id, external_ticket_id, task_id, role
     ) values ($1, $2, $3, $4, 'reference')
     on conflict (organization_id, external_ticket_id, task_id) do nothing
     returning id, sync_health, created_at, updated_at, version`,
    [crypto.randomUUID(), organizationId, id, task.id],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "ticket_link_exists" },
    });
  }
  await recordFact(context, transaction, {
    organizationId,
    principalId,
    applicationId: source.applicationId,
    repositoryId: source.repositoryId,
    task,
    operation: "ticketTaskLinks.create",
    resourceType: "ticket_task_link",
    resourceId: row.id,
    resourceVersion: row.version,
    eventType: "ticket.link_changed",
    details: { ticketId: id, taskId: task.id, role: "reference" },
  });
  return {
    id: row.id,
    organizationId,
    externalTicketId: id,
    taskId: task.id,
    role: "reference",
    statusCommentExternalId: null,
    lastSyncedRunRevision: null,
    syncHealth: row.sync_health,
    lastProblemCode: null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  } as LinkOutput;
}

/** The first read failure a prefetch holds, which carries the provider's retry-after. */
function readFailure(prefetch: TicketPrefetch): TicketReadFailure | null {
  const reads = [
    prefetch.issue,
    prefetch.links,
    ...prefetch.proofs.map(({ proof }) => proof),
  ];
  for (const read of reads) {
    if (read?.kind === "unavailable") return read;
  }
  return null;
}

/**
 * What an admission that admitted nothing means to the caller. A provider that
 * could not answer is `DEPENDENCY_UNAVAILABLE` (with its retry-after, when it
 * gave one); an issue with more labels than the reader keeps is
 * `STATE_CONFLICT {labels_truncated}`, because retrying cannot change it;
 * anything else is `STATE_CONFLICT {ticket_not_ready}`, whose problem lists
 * the failing checks as `issues` (check id, reason code, wait or reject).
 * Either way the throw rolls the transaction back, so no report, snapshot or
 * row is written: `ticketReadiness.create` is how a report is recorded. The
 * full checks, evidence included, travel in the error's params for the log.
 */
export function unadmittedError(
  report: TicketReadinessReport,
  prefetch: TicketPrefetch,
): StandardError {
  const failing = report.checks.find((check) => check.status !== "pass");
  if (failing?.reason === "provider_unavailable") {
    if (
      failing.evidence.some(({ ref }) => ref === "provider:labels_truncated")
    ) {
      return new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "labels_truncated" },
      });
    }
    return dependencyUnavailable(
      readFailure(prefetch) ?? { retryAfterSeconds: null },
    );
  }
  return new StandardError({
    code: "STATE_CONFLICT",
    params: {
      reason: "ticket_not_ready",
      checks: report.checks,
      issues: report.checks.filter((check) => check.status !== "pass").map(
        (check) => ({
          path: ["checks", check.id],
          code: check.reason,
          message: check.status === "wait"
            ? "The check is waiting."
            : "The check rejects.",
        }),
      ),
    },
  });
}

async function requestOutput(
  transaction: PgTransactionClient,
  request: TicketRequest,
): Promise<RequestOutput> {
  const times = await transaction.query<{ created_at: Date; updated_at: Date }>(
    `select created_at, updated_at from bakery.ticket_requests
      where organization_id = $1 and id = $2`,
    [request.organizationId, request.id],
  );
  return {
    id: request.id,
    organizationId: request.organizationId,
    ticketTaskLinkId: request.linkId,
    externalTicketId: request.externalTicketId,
    intent: request.intent,
    generation: request.generation,
    authorityPrincipalId: request.authorityPrincipalId,
    inboundEventRouteId: request.inboundEventRouteId,
    sourcePolicyRevision: request.sourcePolicyRevision,
    requirementsDigest: request.requirementsDigest,
    planArtifactVersionId: null,
    disposition: request.disposition,
    workflowRunId: request.workflowRunId,
    origin: request.origin,
    dispositionReason: request.dispositionReason,
    readinessReportId: request.readinessReportId,
    pinnedPreset: request.pinnedPreset,
    pauseRequestedAt: request.pauseRequestedAt?.toISOString() ?? null,
    targets: await requestTargets(
      transaction,
      request.organizationId,
      request.id,
    ),
    createdAt: times.rows[0].created_at.toISOString(),
    updatedAt: times.rows[0].updated_at.toISOString(),
    version: request.version,
  } as RequestOutput;
}

/**
 * `ticketRequests.create`: asks admission to admit one ticket as the caller.
 * The origin is `adoption` when the live issue carries a request label (a
 * person taking over what automation left waiting) and `manual` otherwise.
 * Admission re-checks the source revision, the caller's live authority, the
 * caller's requirements digest against the text it just read and readiness
 * under its locks. It admits the ticket, answers the request that already
 * exists (a suspended one is re-pinned when the caller holds the current
 * digest, and refused with `requirements_changed` when it does not), or
 * refuses with nothing written.
 */
export function createTicketRequestHandler(
  dependencies: TicketOperationDependencies,
) {
  return async (
    context: ActionContext,
    input: RequestCreate,
  ): Promise<RequestOutput> => {
    const { transaction, organizationId } = requireWorkTransaction(context);
    const { prefetch } = ticketReads(context, "ticket");
    const { source, number } = await lockedSource(
      transaction,
      organizationId,
      ticketId(context),
      input.expectedSourcePolicyRevision,
    );
    const labels = prefetch.issue.kind === "present"
      ? prefetch.issue.snapshot.labels
      : [];
    const result = await admitTicket({
      reader: dependencies.reader,
      budget: dependencies.budget,
      readsAllowed: false,
      transaction,
    }, {
      organizationId,
      sourceId: source.id,
      number,
      intent: input.intent,
      origin: requestedIntentFromLabels(labels, source.policy) === null
        ? "manual"
        : "adoption",
      caller: actorOf(context),
      prefetch,
      signal: context.signal,
      requirementsDigest: input.requirementsDigest,
      preset: input.preset ?? null,
      trace: { requestId: context.requestId, traceId: context.traceId },
    });
    if (result.kind === "unadmitted" || result.request === null) {
      throw unadmittedError(result.report, prefetch);
    }
    return await requestOutput(transaction, result.request);
  };
}

/** Run statuses after which a run can no longer be stopped. */
const FINISHED_RUN_STATUSES: readonly string[] = [
  "completed",
  "failed",
  "canceled",
];

/**
 * The run a request answers for: its own, or the task's current one that the
 * next recheck would link to it. Null when neither exists or it has ended.
 */
async function liveRunOf(
  transaction: PgTransactionClient,
  request: TicketRequest,
): Promise<string | null> {
  const runId = request.workflowRunId ??
    (await readTaskState(transaction, request.organizationId, request.taskId))
      .currentRunId;
  if (runId === null) return null;
  const status = await runStatusOf(transaction, request.organizationId, runId);
  return status === null || FINISHED_RUN_STATUSES.includes(status)
    ? null
    : runId;
}

/**
 * `ticketRequests.cancel` (#61): stops a start request that has no run yet,
 * as the caller, by the request version the caller last read (If-Match). The
 * request ends `canceled` with the reason `request_canceled`; its task, plan
 * and links stay as they are and nothing is written on the provider. A
 * request that owns a live run (or whose task runs one the next recheck would
 * link) is refused with `ticket_request_has_run` and that run's id: it is
 * stopped through `runs.control`, which ends the request with `run_canceled`.
 * A finished request is refused with `ticket_request_finished`. Lock order is
 * admission's: the source `for share`, then the ticket, so a cancel cannot
 * race a recheck of the same ticket. The caller is recorded in the audit row.
 */
export async function cancelTicketRequest(
  context: ActionContext,
  _input: RequestCancel,
): Promise<RequestView> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const found = await requestById(transaction, organizationId, id);
  if (found === null) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const ref = await readTicketRef(
    transaction,
    organizationId,
    found.externalTicketId,
  );
  const source = await lockSource(transaction, organizationId, ref.sourceId);
  await lockTicket(transaction, organizationId, found.externalTicketId);
  // Read again under the ticket lock: a recheck may have moved it.
  const current = await requestById(transaction, organizationId, id);
  if (current === null) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (isTerminalTicketDisposition(current.disposition)) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "ticket_request_finished" },
    });
  }
  const runId = await liveRunOf(transaction, current);
  if (runId !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "ticket_request_has_run", runId },
    });
  }
  const canceled = await updateRequest(transaction, current, {
    disposition: "canceled",
    dispositionReason: "request_canceled",
  });
  const task = await loadTaskScope(
    transaction,
    organizationId,
    canceled.taskId,
    undefined,
    false,
  );
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "ticketRequests.cancel",
    resourceType: "ticket_request",
    resourceId: canceled.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      ticketId: canceled.externalTicketId,
      generation: canceled.generation,
      intent: canceled.intent,
      origin: canceled.origin,
      from: current.disposition,
      disposition: canceled.disposition,
      dispositionReason: canceled.dispositionReason,
      sourcePolicyRevision: source.policyRevision,
    },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: task.application_id,
    repositoryId: task.repository_id,
    taskId: task.id,
    conversationId: task.conversation_id,
    eventType: "ticket.request.updated",
    aggregateId: canceled.id,
    aggregateVersion: canceled.version,
    payload: { resourceId: canceled.id, resourceVersion: canceled.version },
    traceId: context.traceId,
  });
  return await getTicketRequest(context);
}
