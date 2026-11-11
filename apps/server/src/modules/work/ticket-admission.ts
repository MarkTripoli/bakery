import type { ActionContext } from "@bakery/contracts/action-registry";
import type { BudgetRuntimeConfig } from "@bakery/config";
import {
  contractSchemas,
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import {
  type TicketAuthorityEvidence,
  type TicketPresetPin,
  type TicketReadinessReport,
  type TicketRequestIntent,
  type TicketRequestOrigin,
  type TicketStoredReport,
} from "@bakery/contracts/ticket-admission";
import { FIXED_CODING_PRESET } from "@bakery/contracts/workflow-presets";
import { appendAudit, appendDomainEvent } from "@bakery/persistence";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import type { OrganizationActor } from "../auth/application/authority.ts";
import { authorize } from "../auth/application/authorize.ts";
import {
  authorityVerdict,
  RouteOutcomeCode,
} from "../integrations/fact-reads.ts";
import { lockAuthority } from "../integrations/write-authority.ts";
import { createRunCommand } from "./run-command.ts";
import {
  approvalPolicyDigest,
  effectiveApprovalPolicy,
} from "./stage-policy.ts";
import {
  createTaskCommand,
  loadTaskScope,
  lockApplication,
  updateTaskCommand,
} from "./postgres.ts";
import {
  intentFromLabels,
  requestedIntentFromLabels,
  type TicketLabelBasis,
} from "./ticket-policy.ts";
import {
  isAutomaticOrigin,
  prefetchTicketReads,
  requestLabelOf,
  type TicketPrefetch,
  TicketPrefetchRequiredError,
} from "./ticket-prefetch.ts";
import {
  evaluateReadiness,
  type ReadinessInput,
  type ReadinessSourceFacts,
} from "./ticket-readiness.ts";
import {
  decideRecheck,
  type RecheckDecision,
  resumeTarget,
  suspensionReason,
} from "./ticket-request-state.ts";
import { requestRunPause, type RunPauseOutcome } from "./ticket-run-pause.ts";
import {
  normalizeLinks,
  normalizeSnapshot,
  requirementsDigest,
  taskDescriptionFooter,
} from "./ticket-snapshot.ts";
import {
  appendReportIfChanged,
  findAvailableApproval,
  findNonterminalRequest,
  insertPrimaryLink,
  insertRequest,
  latestReport,
  lockSource,
  lockTaskForUpdate,
  lockTicket,
  lockTicketByNumber,
  nextGeneration,
  readSourceHandle,
  readSourceScope,
  readTaskState,
  readTicketRef,
  requestById,
  runStatusOf,
  taskHasUnconsumedApproval,
  type TicketRequest,
  type TicketRow,
  type TicketSource,
  updateRequest,
  upsertExternalTicket,
} from "./ticket-store.ts";
import type { TicketSourceReader } from "./ticket-source-reader.ts";
import { presetAvailability } from "./workflow-presets.ts";

/**
 * Admission: the one function that turns a GitHub issue into at most one
 * nonterminal ticket request that owns one task and, when its approval policy
 * allows, one fixed-coding run. Manual, webhook and poll origins all call
 * `admitTicket`; nothing else inserts a request.
 *
 * Lock order of one admission transaction, the same for every ticket writer:
 * (1) the source row `for share`, which pins `policy_revision` and delegation;
 * (2) the live authority rows (installation, connection, resource) `for
 * share`; (3) the ticket row `for update`; (4) the application row `for
 * update`, taken right after the ticket and before any branch that writes a
 * task row or creates a run (HTTP `runs.create` takes application then task);
 * (5) the task row, only after the application. No GitHub read happens inside
 * the transaction: the answers arrive as a `TicketPrefetch` read before it
 * opened. `recheckTicket` and `advanceRequest` (below) take the same locks in
 * the same order for a request that already exists.
 */

/** Dependencies of one admission. Exactly one of `transaction` and `database` is set. */
export type AdmissionDeps = {
  reader: TicketSourceReader;
  /** Server budget policy; the fixed preset's availability reads it. */
  budget: BudgetRuntimeConfig | undefined;
  /**
   * Whether the caller is outside any transaction and so may let admission
   * read the provider. Automation sets it with a `database`; the operation
   * runner runs inside a registry `transaction`, sets it false and passes the
   * answers it prefetched. With `prefetch: null` and `readsAllowed` false,
   * admission throws `TicketPrefetchRequiredError` instead of reading.
   */
  readsAllowed: boolean;
  /** Operation mode: the caller's open transaction. */
  transaction?: PgTransactionClient;
  /** Automation mode: admission opens its own transaction. */
  database?: PgDatabase;
};

/** One admission call. */
export type AdmissionCall = {
  organizationId: string;
  sourceId: string;
  number: number;
  /**
   * What the caller asks for. Required for `manual`; for the other origins a
   * null intent is read from the issue's request label.
   */
  intent: TicketRequestIntent | null;
  origin: TicketRequestOrigin;
  /** The live actor of an explicit request (`manual`, `adoption`); null for webhook and poll. */
  caller: OrganizationActor | null;
  /** Provider answers read outside any transaction; null to let admission read them (automation only). */
  prefetch: TicketPrefetch | null;
  signal: AbortSignal;
  /**
   * The requirements digest the caller saw. A new admission, and an explicit
   * call on a suspended request, refuse with `PRECONDITION_FAILED
   * {requirements_changed}` when it is not the live digest. A suspended
   * request whose pinned digest differs is re-pinned to it; a plan request
   * asked to start refuses a digest other than its pin.
   */
  requirementsDigest?: string | null;
  /** Receipt route that triggered a webhook admission, kept as a pointer. */
  inboundEventRouteId?: string | null;
  /** Request and trace ids of the calling request; fresh ones are made when absent. */
  trace?: { requestId: string; traceId: string };
};

export type AdmissionKind =
  | "admitted"
  | "existing"
  | "upgraded"
  | "repinned"
  | "unadmitted";

/**
 * Outcome of one admission. `unadmitted` with a `request` means an existing
 * request refused an upgrade it was asked for and is unchanged.
 */
export type AdmissionResult = {
  kind: AdmissionKind;
  request: TicketRequest | null;
  report: TicketReadinessReport;
  /** The stored report the verdict rests on; null when no ticket row exists to hold one. */
  storedReport: TicketStoredReport | null;
  ticketId: string | null;
};

const PRESET_PIN: TicketPresetPin = Object.freeze({
  id: FIXED_CODING_PRESET.id as TicketPresetPin["id"],
  revision: FIXED_CODING_PRESET.revision,
  digest: FIXED_CODING_PRESET.digest,
});

function stateConflict(reason: string): StandardError {
  return new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

/** The caller's requirements digest is not the one the request would pin or hold. */
function requirementsChanged(): StandardError {
  return new StandardError({
    code: "PRECONDITION_FAILED",
    params: { reason: "requirements_changed" },
  });
}

/** The label basis of a new admission, from its origin and the issue's labels. */
export function labelBasisFor(
  origin: TicketRequestOrigin,
  labels: readonly string[],
  policy: TicketSource["policy"],
): TicketLabelBasis {
  if (origin === "manual") return "manual";
  if (isAutomaticOrigin(origin)) return "label";
  return requestedIntentFromLabels(labels, policy) === null
    ? "manual"
    : "label";
}

type Frame = {
  deps: AdmissionDeps;
  transaction: PgTransactionClient;
  call: AdmissionCall;
  prefetch: TicketPrefetch;
  source: TicketSource;
  trace: { requestId: string; traceId: string };
  authority:
    & Pick<
      ReadinessSourceFacts,
      "connectionEnabled" | "installationEnabled" | "resourceSelected"
    >
    & { repositoryFullName: string };
};

/** Live actor of a principal holding `task:write` and `run:write`, or null. */
async function liveActor(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string | null,
): Promise<OrganizationActor | null> {
  if (principalId === null) return null;
  try {
    const actor = await resolveOrganizationActor(
      transaction,
      toPrincipalId(principalId),
      toOrganizationId(organizationId),
    );
    authorize(actor, "task:write");
    authorize(actor, "run:write");
    return actor;
  } catch (error) {
    if (error instanceof StandardError) return null;
    throw error;
  }
}

/** The caller of an explicit request must hold both permissions now; a miss throws. */
function authorizeCaller(caller: OrganizationActor | null): OrganizationActor {
  if (caller === null) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  authorize(caller, "task:write");
  authorize(caller, "run:write");
  return caller;
}

function isExplicitOrigin(origin: TicketRequestOrigin): boolean {
  return origin === "manual" || origin === "adoption";
}

async function sourceAuthority(
  transaction: PgTransactionClient,
  source: TicketSource,
): Promise<Frame["authority"]> {
  const scope = await readSourceScope(transaction, source);
  const locked = await lockAuthority(transaction, {
    organizationId: source.organizationId,
    connectionId: source.connectionId,
    installationId: scope.installationId,
    resourceId: source.resourceId,
  });
  const verdict = authorityVerdict(
    {
      purpose: "fact_refresh",
      installationId: scope.installationId,
      resourceId: source.resourceId,
      eventKind: "issues",
    },
    { ...locked, tracked: true },
  );
  return {
    repositoryFullName: scope.handle.repositoryFullName,
    connectionEnabled: verdict !== RouteOutcomeCode.ConnectionNotEnabled &&
      verdict !== RouteOutcomeCode.ConnectionChanged,
    installationEnabled: verdict !== RouteOutcomeCode.InstallationUnavailable &&
      verdict !== RouteOutcomeCode.InstallationPending &&
      verdict !== RouteOutcomeCode.InstallationSuspended &&
      verdict !== RouteOutcomeCode.InstallationRevoked,
    resourceSelected: verdict !== RouteOutcomeCode.UnselectedRepository,
  };
}

/**
 * Repository and preset facts. Called after the application lock: the preset
 * check reads agent definitions `for share`, which `runs.create` takes after
 * the application as well.
 */
async function sourceFacts(frame: Frame): Promise<ReadinessSourceFacts> {
  const { source, transaction } = frame;
  const base = {
    enabled: source.enabled,
    connectionEnabled: frame.authority.connectionEnabled,
    installationEnabled: frame.authority.installationEnabled,
    resourceSelected: frame.authority.resourceSelected,
    repositoryFullName: frame.authority.repositoryFullName,
  };
  if (source.repositoryId === null) {
    return {
      ...base,
      repositoryArchived: false,
      repositoryHasActiveProfile: false,
      presetReady: false,
    };
  }
  const availability = await presetAvailability(
    transaction,
    source.organizationId,
    source.repositoryId,
    FIXED_CODING_PRESET,
    FIXED_CODING_PRESET.defaultBudgetLimitUsd,
    frame.deps.budget,
  );
  return {
    ...base,
    repositoryArchived: availability.reasons.includes("repository_archived") ||
      availability.reasons.includes("application_archived"),
    repositoryHasActiveProfile: !availability.reasons.includes(
      "no_active_profile",
    ),
    presetReady: availability.status === "ready",
  };
}

type EvaluationContext = {
  origin: TicketRequestOrigin;
  labelBasis: TicketLabelBasis;
  intent: TicketRequestIntent | null;
  principalActive: boolean;
  activeRequest: TicketRequest | null;
  pinnedRequirementsDigest: string | null;
};

async function evaluate(
  frame: Frame,
  context: EvaluationContext,
): Promise<TicketReadinessReport> {
  const { prefetch, source } = frame;
  const input: ReadinessInput = {
    source: await sourceFacts(frame),
    policy: source.policy,
    policyRevision: source.policyRevision,
    preset: PRESET_PIN,
    issue: prefetch.issue,
    links: prefetch.links,
    proofs: prefetch.proofs,
    authority: {
      principalActive: context.principalActive,
      provenance: prefetch.provenance,
      actorRole: prefetch.actorRole,
    },
    activeRequest: context.activeRequest === null
      ? null
      : { intent: context.activeRequest.intent },
    intent: context.intent,
    origin: context.origin,
    labelBasis: context.labelBasis,
    pinnedRequirementsDigest: context.pinnedRequirementsDigest,
  };
  return await evaluateReadiness(input);
}

function issueLabels(prefetch: TicketPrefetch): readonly string[] {
  return prefetch.issue.kind === "present"
    ? prefetch.issue.snapshot.labels
    : [];
}

/** Context for an internal command call: the acting actor, forwarded as `runs.create` and `tasks.*` expect. */
function internalContext(
  frame: Frame,
  actor: OrganizationActor,
  params: Record<string, string>,
  commandMetadata?: {
    operation: string;
    idempotencyKey: string;
    target: string;
    expectedVersion?: number;
  },
): ActionContext {
  return {
    request: new Request("https://internal.invalid/ticket-admission"),
    params,
    requestId: frame.trace.requestId,
    traceId: frame.trace.traceId,
    signal: frame.call.signal,
    principal: actor.subject,
    authority: actor,
    transaction: frame.transaction,
    ...(commandMetadata === undefined ? {} : { commandMetadata }),
  } as ActionContext;
}

function taskInputs(
  frame: Frame,
  snapshot: { title: string; body: string },
  number: number,
): { title: string; description: string } {
  const footer = taskDescriptionFooter(
    frame.authority.repositoryFullName,
    number,
  );
  return {
    title: snapshot.title,
    description: snapshot.body === ""
      ? footer.trimStart()
      : snapshot.body + footer,
  };
}

async function recordFacts(
  frame: Frame,
  request: TicketRequest,
  operation: string,
  principalId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  const task = await loadTaskScope(
    frame.transaction,
    request.organizationId,
    request.taskId,
    undefined,
    false,
  );
  await appendAudit(frame.transaction, {
    organizationId: request.organizationId,
    principalId,
    operation,
    resourceType: "ticket_request",
    resourceId: request.id,
    requestId: frame.trace.requestId,
    traceId: frame.trace.traceId,
    details: {
      ticketId: request.externalTicketId,
      generation: request.generation,
      intent: request.intent,
      origin: request.origin,
      disposition: request.disposition,
      dispositionReason: request.dispositionReason,
      ...details,
    },
  });
  await appendDomainEvent(frame.transaction, {
    organizationId: request.organizationId,
    applicationId: task.application_id,
    repositoryId: task.repository_id,
    taskId: task.id,
    conversationId: task.conversation_id,
    eventType: "ticket.request.updated",
    aggregateId: request.id,
    aggregateVersion: request.version,
    payload: { resourceId: request.id, resourceVersion: request.version },
    traceId: frame.trace.traceId,
  });
}

/**
 * Admits one ticket. Under one lock per external ticket it records a bounded
 * snapshot, appends an immutable readiness report when the basis changed and
 * creates at most one nonterminal request generation that owns one task and,
 * for a `start` intent under an automatic plan approval, one run. A duplicate
 * call returns the request that exists, judged by the origin, label basis and
 * intent the request was admitted under, so a duplicate cannot change a
 * decision. See the module comment for the lock order.
 */
export async function admitTicket(
  deps: AdmissionDeps,
  call: AdmissionCall,
): Promise<AdmissionResult> {
  assertDeps(deps, call.prefetch);
  if (deps.transaction !== undefined) {
    return await admitWithin(deps, deps.transaction, call, call.prefetch!);
  }
  const database = deps.database!;
  const prefetch = call.prefetch ?? await prefetchForCall(deps, database, call);
  return await withPgTransaction(
    database,
    (transaction) => admitWithin(deps, transaction, call, prefetch),
    call.signal,
  );
}

/**
 * Checks that exactly one of `transaction` and `database` is set, that an open
 * transaction never reads the provider and that a caller that may not read has
 * the answers. Operation mode (a `transaction`) never reads, so it always has
 * a prefetch once these pass.
 */
export function assertDeps(
  deps: AdmissionDeps,
  prefetch: TicketPrefetch | null,
): void {
  if ((deps.transaction === undefined) === (deps.database === undefined)) {
    throw new Error("TICKET_ADMISSION_DEPS_INVALID");
  }
  if (deps.transaction !== undefined && deps.readsAllowed) {
    throw new Error("TICKET_ADMISSION_DEPS_INVALID");
  }
  if (prefetch === null && !deps.readsAllowed) {
    throw new TicketPrefetchRequiredError();
  }
}

/** Reads the provider for a call with no prefetch: a short database read for the handle, then the reads with no transaction open. */
async function prefetchForCall(
  deps: AdmissionDeps,
  database: PgDatabase,
  call: AdmissionCall,
): Promise<TicketPrefetch> {
  const { source, handle } = await withPgTransaction(
    database,
    (transaction) =>
      readSourceHandle(transaction, call.organizationId, call.sourceId),
    call.signal,
  );
  return await prefetchTicketReads(
    deps.reader,
    handle,
    { number: call.number, policy: source.policy, origin: call.origin },
    call.signal,
  );
}

/** What `recordReadiness` stored. */
export type ReadinessRecord = {
  /** The ticket row the report belongs to; null when none exists (the issue was never seen and is gone, moved or a pull request). */
  ticketId: string | null;
  report: TicketReadinessReport;
  /** The stored report the verdict rests on; null when no ticket row exists to hold one. */
  storedReport: TicketStoredReport | null;
};

/**
 * Observes one ticket and records its readiness; it admits nothing. Locks,
 * prefetch rules and evaluation are `admitTicket`'s, but it stops before any
 * task, link, request or run write: it upserts the snapshot and appends a
 * report when the basis changed. A ticket that owns a nonterminal request is
 * judged as its recheck would judge it, so the stored report is the one the
 * next recheck would store. Source preview and `ticketReadiness.create` use it.
 */
export async function recordReadiness(
  deps: AdmissionDeps,
  call: AdmissionCall,
): Promise<ReadinessRecord> {
  assertDeps(deps, call.prefetch);
  if (deps.transaction !== undefined) {
    return await recordWithin(deps, deps.transaction, call, call.prefetch!);
  }
  const database = deps.database!;
  const prefetch = call.prefetch ?? await prefetchForCall(deps, database, call);
  return await withPgTransaction(
    database,
    (transaction) => recordWithin(deps, transaction, call, prefetch),
    call.signal,
  );
}

async function recordWithin(
  deps: AdmissionDeps,
  transaction: PgTransactionClient,
  call: AdmissionCall,
  prefetch: TicketPrefetch,
): Promise<ReadinessRecord> {
  const { organizationId } = call;
  const trace = call.trace ?? {
    requestId: `ticket-readiness:${crypto.randomUUID()}`,
    traceId: crypto.randomUUID(),
  };
  const source = await lockSource(transaction, organizationId, call.sourceId);
  const frame: Frame = {
    deps,
    transaction,
    call,
    prefetch,
    source,
    trace,
    authority: await sourceAuthority(transaction, source),
  };
  assertPrefetchCurrent(source, call, prefetch);
  const ticket = await resolveTicket(frame);
  const callerActor = isExplicitOrigin(call.origin)
    ? authorizeCaller(call.caller)
    : null;
  if (ticket === null) {
    const { report } = await unstored(frame, callerActor);
    return { ticketId: null, report, storedReport: null };
  }
  await lockApplication(transaction, organizationId, source.applicationId);
  const existing = await findNonterminalRequest(
    transaction,
    organizationId,
    ticket.id,
  );
  const context = existing === null
    ? await callContext(
      frame,
      null,
      askedIntent(frame),
      callerActor,
      prefetch.issue.kind === "present" ? ticket.requirementsDigest : null,
    )
    : await recordedContext(frame, existing, existing.requirementsDigest);
  const report = await evaluate(frame, context);
  const { stored } = await appendReportIfChanged(
    transaction,
    organizationId,
    ticket.id,
    report,
    call.origin,
  );
  return { ticketId: ticket.id, report, storedReport: stored };
}

async function admitWithin(
  deps: AdmissionDeps,
  transaction: PgTransactionClient,
  call: AdmissionCall,
  prefetch: TicketPrefetch,
): Promise<AdmissionResult> {
  const { organizationId } = call;
  const trace = call.trace ?? {
    requestId: `ticket-admission:${crypto.randomUUID()}`,
    traceId: crypto.randomUUID(),
  };
  // (1) The source, `for share`: pins the policy revision and the delegation.
  const source = await lockSource(transaction, organizationId, call.sourceId);
  // (2) Live source authority, `for share`, in the order the intake path uses.
  const authority = await sourceAuthority(transaction, source);
  const frame: Frame = {
    deps,
    transaction,
    call,
    prefetch,
    source,
    trace,
    authority,
  };
  assertPrefetchCurrent(source, call, prefetch);

  // (3) The ticket row: insert or lock `for update`; a stale read acts on nothing.
  const ticket = await resolveTicket(frame);
  const explicit = isExplicitOrigin(call.origin);
  const callerActor = explicit ? authorizeCaller(call.caller) : null;
  if (ticket === null) {
    return await unstored(frame, callerActor);
  }
  // (4) The application, before any branch that can write a task or a run.
  await lockApplication(transaction, organizationId, source.applicationId);

  const existing = await findNonterminalRequest(
    transaction,
    organizationId,
    ticket.id,
  );
  if (existing === null) {
    return await admitFresh(frame, ticket, callerActor);
  }
  return await admitExisting(frame, ticket, existing, callerActor);
}

/** The prefetch must answer for this source policy and this issue number. */
function assertPrefetchCurrent(
  source: TicketSource,
  call: Pick<AdmissionCall, "origin" | "number">,
  prefetch: TicketPrefetch,
): void {
  if (isAutomaticOrigin(call.origin) && prefetch.issue.kind === "present") {
    // The provenance read was for the label the policy named when it began;
    // a policy that moved on since makes that answer about the wrong label.
    if (
      requestLabelOf(issueLabels(prefetch), source.policy) !==
        prefetch.provenanceLabel
    ) {
      throw stateConflict("ticket_prefetch_stale");
    }
  }
  if (
    prefetch.issue.kind === "present" &&
    prefetch.issue.snapshot.number !== call.number
  ) {
    throw stateConflict("ticket_prefetch_mismatch");
  }
}

async function resolveTicket(frame: Frame): Promise<TicketRow | null> {
  const { transaction, source, call, prefetch } = frame;
  const issue = prefetch.issue;
  if (issue.kind !== "present") {
    return await lockTicketByNumber(
      transaction,
      call.organizationId,
      source.id,
      call.number,
    );
  }
  const links = prefetch.links?.kind === "present"
    ? normalizeLinks(prefetch.links)
    : null;
  const normalized = normalizeSnapshot(issue.snapshot, {
    links,
    providerUpdatedAt: issue.providerUpdatedAt,
  });
  const upserted = await upsertExternalTicket(transaction, {
    organizationId: call.organizationId,
    sourceId: source.id,
    externalTicketId: issue.snapshot.externalId,
    number: call.number,
    snapshot: normalized.snapshot,
    requirementsDigest: await requirementsDigest(normalized),
    providerUpdateMarker: issue.providerUpdatedAt,
    visibility: issue.visibility,
  });
  if (upserted.result === "stale") throw stateConflict("ticket_read_stale");
  return upserted.ticket;
}

/** The context of a call that stands on its own: a new admission, an upgrade ask or an explicit re-evaluation. */
async function callContext(
  frame: Frame,
  existing: TicketRequest | null,
  intent: TicketRequestIntent | null,
  callerActor: OrganizationActor | null,
  pinning: string | null,
): Promise<EvaluationContext & { actor: OrganizationActor | null }> {
  const { call, source, transaction } = frame;
  const labels = issueLabels(frame.prefetch);
  let actor: OrganizationActor | null = callerActor;
  if (callerActor === null) {
    const delegation = source.policy.delegation;
    actor = delegation === null ? null : await liveActor(
      transaction,
      call.organizationId,
      delegation.principalId,
    );
  }
  return {
    origin: call.origin,
    labelBasis: labelBasisFor(call.origin, labels, source.policy),
    intent,
    principalActive: actor !== null,
    activeRequest: existing,
    // A request that exists is judged against its pinned digest (or the one the
    // caller supplies to re-pin). A new admission is judged against the digest
    // it is about to pin, so its report has the checks a later recheck's has
    // and an unchanged recheck stores no new report.
    pinnedRequirementsDigest: existing === null
      ? pinning
      : call.requirementsDigest ?? existing.requirementsDigest,
    actor,
  };
}

/**
 * The context a request that exists is judged in: the origin, label basis and
 * intent it was admitted under and its recorded principal, live now. Never the
 * origin of the call that found it, so a poll that finds a healthy manual
 * request does not suspend it for a missing delegation.
 */
async function recordedContext(
  frame: Frame,
  existing: TicketRequest,
  pinnedRequirementsDigest: string,
): Promise<EvaluationContext & { actor: OrganizationActor | null }> {
  const actor = await liveActor(
    frame.transaction,
    existing.organizationId,
    existing.authorityPrincipalId,
  );
  return {
    origin: existing.origin,
    labelBasis: existing.authorityEvidence.labelBasis,
    intent: existing.intent,
    principalActive: actor !== null,
    activeRequest: existing,
    pinnedRequirementsDigest,
    actor,
  };
}

/** The intent a call asks for: its own, or the one the labels of an automatic origin ask. */
function askedIntent(frame: Frame): TicketRequestIntent | null {
  const { call, source } = frame;
  if (call.intent !== null) return call.intent;
  if (call.origin === "manual") {
    throw unprocessable(["intent"], "ticket_intent_required");
  }
  const asked = intentFromLabels(issueLabels(frame.prefetch), source.policy)
    .intent;
  if (asked === null && call.origin === "adoption") {
    throw unprocessable(["intent"], "ticket_intent_required");
  }
  return asked;
}

/** No ticket row exists (the issue is gone, moved or a pull request and was never seen): evaluate, store nothing. */
async function unstored(
  frame: Frame,
  callerActor: OrganizationActor | null,
): Promise<AdmissionResult> {
  const context = await callContext(
    frame,
    null,
    askedIntent(frame),
    callerActor,
    null,
  );
  const report = await evaluate(frame, context);
  return {
    kind: "unadmitted",
    request: null,
    report,
    storedReport: null,
    ticketId: null,
  };
}

function evidenceOf(
  frame: Frame,
  context: EvaluationContext & { actor: OrganizationActor | null },
): TicketAuthorityEvidence {
  const { provenance, actorRole } = frame.prefetch;
  const automatic = isAutomaticOrigin(frame.call.origin);
  return {
    version: 1,
    origin: frame.call.origin,
    labelBasis: context.labelBasis,
    actingPrincipalId: context.actor?.subject.principalId as string,
    callerPrincipalId: automatic
      ? null
      : frame.call.caller?.subject.principalId ?? null,
    provenance: automatic && provenance?.kind === "applied"
      ? {
        actorId: provenance.actorId,
        actorLogin: provenance.actorLogin,
        appliedAt: provenance.appliedAt,
      }
      : null,
    actorRole: automatic && actorRole?.kind === "present"
      ? { userId: actorRole.userId, permission: actorRole.permission }
      : null,
  };
}

async function admitFresh(
  frame: Frame,
  ticket: TicketRow,
  callerActor: OrganizationActor | null,
): Promise<AdmissionResult> {
  const { transaction, source, call, prefetch } = frame;
  // The ticket row now holds the text just read. A caller that pinned another
  // digest saw other text: refuse before anything but the snapshot is written
  // (the throw rolls that back too), so the client refreshes and asks again.
  if (
    call.requirementsDigest != null && prefetch.issue.kind === "present" &&
    call.requirementsDigest !== ticket.requirementsDigest
  ) throw requirementsChanged();
  const context = await callContext(
    frame,
    null,
    askedIntent(frame),
    callerActor,
    prefetch.issue.kind === "present" ? ticket.requirementsDigest : null,
  );
  const report = await evaluate(frame, context);
  const { stored } = await appendReportIfChanged(
    transaction,
    call.organizationId,
    ticket.id,
    report,
    call.origin,
  );
  const unadmitted: AdmissionResult = {
    kind: "unadmitted",
    request: null,
    report,
    storedReport: stored,
    ticketId: ticket.id,
  };
  const intent = context.intent;
  if (
    report.verdict !== "ready" || intent === null || context.actor === null ||
    report.requirementsDigest === null || prefetch.issue.kind !== "present"
  ) {
    return unadmitted;
  }
  const actor = context.actor;

  // (8) The task, its primary link and the request, in one transaction.
  const snapshot = ticket.snapshot;
  const text = taskInputs(frame, snapshot, call.number);
  const taskInput = contractSchemas.TaskCreate.safeParse({
    applicationId: source.applicationId,
    ...(source.repositoryId === null
      ? {}
      : { repositoryId: source.repositoryId }),
    taskType: "feature",
    title: text.title,
    description: text.description,
    approvalPolicy: { plan: source.policy.approval.plan },
    planningOnly: intent === "plan",
  });
  if (!taskInput.success) {
    throw unprocessable(
      ["title"],
      "ticket_task_input_invalid",
      taskInput.error,
    );
  }
  const task = await createTaskCommand(
    internalContext(frame, actor, {}),
    taskInput.data,
  ) as { id: string; repositoryProfileId: string | null };
  const linkId = await insertPrimaryLink(transaction, {
    organizationId: call.organizationId,
    ticketId: ticket.id,
    taskId: task.id,
  });
  const requestId = crypto.randomUUID();
  await insertRequest(transaction, {
    id: requestId,
    organizationId: call.organizationId,
    linkId,
    ticketId: ticket.id,
    intent,
    generation: await nextGeneration(
      transaction,
      call.organizationId,
      ticket.id,
    ),
    origin: call.origin,
    authorityPrincipalId: actor.subject.principalId as string,
    authorityEvidence: evidenceOf(frame, context),
    inboundEventRouteId: call.inboundEventRouteId ?? null,
    sourcePolicyRevision: source.policyRevision,
    requirementsDigest: report.requirementsDigest,
    readinessReportId: stored.id,
    pinnedPreset: report.preset,
  });
  let request = await mustRequest(transaction, call.organizationId, requestId);

  // (9) A start under an automatic plan approval creates the run now.
  if (intent === "start" && source.policy.approval.plan === "automatic") {
    const runId = await startRun(frame, actor, request, task);
    request = await updateRequest(transaction, request, {
      disposition: "admitted",
      workflowRunId: runId,
    });
  }
  await recordFacts(
    frame,
    request,
    "ticketRequests.create",
    actor.subject.principalId as string,
    { reportId: stored.id, runId: request.workflowRunId },
  );
  return {
    kind: "admitted",
    request,
    report,
    storedReport: stored,
    ticketId: ticket.id,
  };
}

async function mustRequest(
  transaction: PgTransactionClient,
  organizationId: string,
  requestId: string,
): Promise<TicketRequest> {
  const request = await requestById(transaction, organizationId, requestId);
  if (request === null) throw new Error("TICKET_REQUEST_INSERT_LOST");
  return request;
}

async function startRun(
  frame: Frame,
  actor: OrganizationActor,
  request: TicketRequest,
  task: { id: string; repositoryProfileId: string | null },
  approvalId?: string,
): Promise<string> {
  const input = contractSchemas.RunCreate.safeParse({
    presetId: "fixed-coding",
    executionMode: "repository",
    ...(task.repositoryProfileId === null
      ? {}
      : { repositoryProfileId: task.repositoryProfileId }),
    ...(approvalId === undefined ? {} : { approvalId }),
  });
  if (!input.success) {
    throw unprocessable(["presetId"], "ticket_run_input_invalid", input.error);
  }
  const run = await createRunCommand(
    internalContext(frame, actor, { id: task.id }, {
      operation: "runs.create",
      idempotencyKey: `ticket-request:${request.id}`,
      target: `/v1/tasks/${task.id}/runs`,
    }),
    input.data,
  );
  return run.id;
}

/**
 * A request exists. A call that asks to start a plan request is judged as the
 * new ask it is. An explicit call on a suspended request is a person
 * re-evaluating it and is judged as that person's request, on the label basis
 * the request was admitted on. Every other call is a duplicate or a recheck
 * and is judged by the origin, label basis and intent the request was
 * admitted under.
 */
async function admitExisting(
  frame: Frame,
  ticket: TicketRow,
  existing: TicketRequest,
  callerActor: OrganizationActor | null,
): Promise<AdmissionResult> {
  const { transaction, call } = frame;
  const suspended = existing.disposition === "suspended";
  const upgradeAsk = !suspended && existing.intent === "plan" &&
    call.intent === "start";
  const explicitResume = suspended && callerActor !== null;

  let context: EvaluationContext & { actor: OrganizationActor | null };
  if (upgradeAsk) {
    // The pin is judged against the request's own digest, so a plan request
    // never starts on text edited since it was pinned; a client that saw other
    // text re-pins first (an explicit call once the recheck suspends it).
    if (
      call.requirementsDigest != null &&
      call.requirementsDigest !== existing.requirementsDigest
    ) throw requirementsChanged();
    context = await callContext(frame, existing, "start", callerActor, null);
  } else if (explicitResume) {
    if (
      call.requirementsDigest != null &&
      frame.prefetch.issue.kind === "present" &&
      call.requirementsDigest !== ticket.requirementsDigest
    ) throw requirementsChanged();
    const asked = await callContext(
      frame,
      existing,
      existing.intent,
      callerActor,
      null,
    );
    // A request admitted on a label stays on it: the person's authority
    // replaces the label applier's, never the label, so a withdrawn label keeps
    // the request suspended instead of lasting until the next poll. A person
    // vouches as an adoption, which accepts the label basis without provenance.
    context = existing.authorityEvidence.labelBasis === "label"
      ? { ...asked, origin: "adoption", labelBasis: "label" }
      : asked;
  } else {
    // A duplicate is judged by the request's own pin, never the caller's: a
    // caller that saw other text re-pins first, so it cannot suspend a request.
    if (
      call.requirementsDigest != null &&
      call.requirementsDigest !== existing.requirementsDigest
    ) throw requirementsChanged();
    // A manual caller cannot supply the facts an automatic request rests on
    // (who applied its label), so it judges nothing and changes nothing.
    if (isAutomaticOrigin(existing.origin) && !isAutomaticOrigin(call.origin)) {
      return await unchanged(frame, ticket, existing);
    }
    context = await recordedContext(
      frame,
      existing,
      existing.requirementsDigest,
    );
  }
  const report = await evaluate(frame, context);
  const { stored } = await appendReportIfChanged(
    transaction,
    call.organizationId,
    ticket.id,
    report,
    call.origin,
  );
  const result = (
    kind: AdmissionKind,
    request: TicketRequest | null,
  ): AdmissionResult => ({
    kind,
    request,
    report,
    storedReport: stored,
    ticketId: ticket.id,
  });

  if (report.verdict !== "ready") {
    if (upgradeAsk) return result("unadmitted", existing);
    if (suspended) return result("existing", existing);
    const reason = suspensionReason(report);
    if (reason === null) return result("existing", existing);
    const request = await updateRequest(transaction, existing, {
      disposition: "suspended",
      dispositionReason: reason,
    });
    await recordFacts(
      frame,
      request,
      "ticketRequests.suspend",
      existing.authorityPrincipalId,
      { reportId: stored.id },
    );
    return result("existing", request);
  }
  if (upgradeAsk) {
    return result("upgraded", await upgrade(frame, existing, stored, context));
  }
  if (explicitResume) {
    return await resumeExplicitly(
      frame,
      ticket,
      existing,
      stored,
      report,
      context,
    );
  }
  return result("existing", existing);
}

/** The stored report of a request left unjudged, so the result still names the verdict in force. */
async function unchanged(
  frame: Frame,
  ticket: TicketRow,
  existing: TicketRequest,
): Promise<AdmissionResult> {
  const latest = await latestReport(
    frame.transaction,
    frame.call.organizationId,
    ticket.id,
  );
  if (latest === null) throw new Error("TICKET_REPORT_MISSING");
  return {
    kind: "existing",
    request: existing,
    report: latest.report,
    storedReport: latest,
    ticketId: ticket.id,
  };
}

/**
 * Plan to start. The task row is locked `for update` (the application lock is
 * already held) and `planning_only` is cleared through `updateTaskCommand`
 * with the version just read; under an automatic approval the run follows.
 */
async function upgrade(
  frame: Frame,
  existing: TicketRequest,
  stored: TicketStoredReport,
  context: EvaluationContext & { actor: OrganizationActor | null },
): Promise<TicketRequest> {
  const { transaction, call } = frame;
  const actor = context.actor!;
  const task = await lockTaskForUpdate(
    transaction,
    call.organizationId,
    existing.taskId,
  );
  await updateTaskCommand(
    internalContext(frame, actor, { id: task.id }, {
      operation: "tasks.update",
      idempotencyKey: `ticket-request:${existing.id}:start`,
      target: `/v1/tasks/${task.id}`,
      expectedVersion: task.version,
    }),
    { planningOnly: false },
  );
  let request = await updateRequest(transaction, existing, {
    intent: "start",
    readinessReportId: stored.id,
  });
  if (effectiveApprovalPolicy(task.approvalPolicy).plan === "automatic") {
    const runId = await startRun(frame, actor, request, {
      id: task.id,
      repositoryProfileId: await profileOfTask(
        transaction,
        call.organizationId,
        task.id,
      ),
    });
    request = await updateRequest(transaction, request, {
      disposition: "admitted",
      workflowRunId: runId,
    });
  }
  await recordFacts(
    frame,
    request,
    "ticketRequests.upgrade",
    actor.subject.principalId as string,
    { reportId: stored.id, runId: request.workflowRunId },
  );
  return request;
}

async function profileOfTask(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<string | null> {
  const result = await transaction.query<
    { repository_profile_id: string | null }
  >(
    `select repository_profile_id from bakery.tasks
      where organization_id = $1 and id = $2`,
    [organizationId, taskId],
  );
  return result.rows[0]?.repository_profile_id ?? null;
}

/**
 * A person re-evaluated a suspended request and it is ready. When the caller
 * supplied a requirements digest that differs from the pinned one the request
 * is re-pinned: the task text is rewritten from the new snapshot, the pin and
 * the report are replaced and the request returns to `waiting`. A request
 * that owns a run, or a task with an unconsumed plan approval made for the
 * old text, refuses the re-pin. Any other reason resumes in place. Either way
 * the pause mark is cleared, as an automatic resume clears it, so the next
 * suspension pauses a live run again.
 */
async function resumeExplicitly(
  frame: Frame,
  ticket: TicketRow,
  existing: TicketRequest,
  stored: TicketStoredReport,
  report: TicketReadinessReport,
  context: EvaluationContext & { actor: OrganizationActor | null },
): Promise<AdmissionResult> {
  const { transaction, call, source } = frame;
  const actor = context.actor!;
  const repin = call.requirementsDigest != null &&
    call.requirementsDigest !== existing.requirementsDigest;
  let request: TicketRequest;
  if (repin) {
    if (existing.workflowRunId !== null) {
      throw stateConflict("ticket_request_has_run");
    }
    if (
      await taskHasUnconsumedApproval(
        transaction,
        call.organizationId,
        existing.taskId,
      )
    ) {
      throw stateConflict("ticket_request_has_approval");
    }
    const task = await lockTaskForUpdate(
      transaction,
      call.organizationId,
      existing.taskId,
    );
    const text = taskInputs(frame, ticket.snapshot, call.number);
    const update = contractSchemas.TaskUpdate.safeParse(text);
    if (!update.success) {
      throw unprocessable(["title"], "ticket_task_input_invalid", update.error);
    }
    await updateTaskCommand(
      internalContext(frame, actor, { id: task.id }, {
        operation: "tasks.update",
        idempotencyKey: `ticket-request:${existing.id}:repin:${stored.id}`,
        target: `/v1/tasks/${task.id}`,
        expectedVersion: task.version,
      }),
      update.data,
    );
    request = await updateRequest(transaction, existing, {
      requirementsDigest: report.requirementsDigest!,
      readinessReportId: stored.id,
      sourcePolicyRevision: source.policyRevision,
      disposition: "waiting",
      dispositionReason: null,
      pauseRequestedAt: null,
    });
  } else {
    const runStatus = existing.workflowRunId === null
      ? null
      : await runStatusOf(
        transaction,
        call.organizationId,
        existing.workflowRunId,
      );
    request = await updateRequest(transaction, existing, {
      readinessReportId: stored.id,
      disposition: resumeTarget({
        hasRun: existing.workflowRunId !== null,
        runStatus,
      }),
      dispositionReason: null,
      pauseRequestedAt: null,
    });
  }
  await recordFacts(
    frame,
    request,
    repin ? "ticketRequests.repin" : "ticketRequests.resume",
    actor.subject.principalId as string,
    { reportId: stored.id },
  );
  return {
    kind: repin ? "repinned" : "existing",
    request,
    report,
    storedReport: stored,
    ticketId: ticket.id,
  };
}

/** Automation origins: the only callers that recheck a request they did not create. */
export type RecheckOrigin = "webhook" | "poll";

/** One recheck of the nonterminal request a ticket owns. */
export type RecheckCall = {
  organizationId: string;
  ticketId: string;
  /** The origin that found the ticket; it labels the stored report and the provenance read. */
  origin: RecheckOrigin;
  /** Provider answers read outside any transaction; null to let the recheck read them (automation only). */
  prefetch: TicketPrefetch | null;
  signal: AbortSignal;
  /** Request and trace ids of the calling request; fresh ones are made when absent. */
  trace?: { requestId: string; traceId: string };
};

/** What one pass applied to a request: a decision of the machine, or the link to a run started by hand. */
export type RecheckAction =
  | Exclude<RecheckDecision["action"], "none">
  | "link_run";

export type RecheckResult = {
  /** The changes made in this pass, in order; empty when the request was left alone. */
  applied: RecheckAction[];
  /** The request after the pass; null when the ticket had no nonterminal request (or not the one asked for). */
  request: TicketRequest | null;
  report: TicketReadinessReport | null;
  storedReport: TicketStoredReport | null;
  /** The outcome of the pause tried in this pass; null when none was tried. */
  pause: RunPauseOutcome | null;
};

type RecheckScope = {
  /** `all` applies every decision; `advance` applies only an `advance` decision. */
  apply: "all" | "advance";
  /** Act only on this request (the one `advanceRequest` was asked for). */
  requestId: string | null;
};

/**
 * Rechecks a ticket's nonterminal request against the live issue. It
 * evaluates the request as it was admitted (its recorded origin, label basis
 * and intent, through the same context `admitExisting` uses), appends a report
 * when the basis changed and applies what `decideRecheck` says: suspend,
 * pause, resume, advance or end the request. Every report stays; a suspension
 * keeps the task, link and run. A run started by hand on the request's task is
 * linked to the request first. Same lock order as `admitTicket` (source,
 * authority rows, ticket, application) and no provider read in a transaction.
 */
export async function recheckTicket(
  deps: AdmissionDeps,
  call: RecheckCall,
): Promise<RecheckResult> {
  return await runRecheck(deps, call, { apply: "all", requestId: null });
}

/** One advance of a request. Evaluates like `recheckTicket` and applies only an `advance`. */
export type AdvanceCall =
  & Omit<RecheckCall, "ticketId" | "origin" | "prefetch">
  & {
    requestId: string;
    origin?: RecheckOrigin;
    prefetch?: TicketPrefetch | null;
  };

/**
 * Starts the run of a `waiting` start request whose plan was approved. It
 * evaluates the request itself, through the path and prefetch `recheckTicket`
 * uses, and applies only an `advance` decision: it never starts a run on an
 * earlier evaluation, and it leaves a request that should be suspended to
 * `recheckTicket`. The run consumes the task's approved plan approval
 * (`runs.create`'s own compare-and-swap), so a repeat or a racing call starts
 * nothing more; a run started by hand is linked instead.
 */
export async function advanceRequest(
  deps: AdmissionDeps,
  call: AdvanceCall,
): Promise<RecheckResult> {
  const prefetch = call.prefetch ?? null;
  assertDeps(deps, prefetch);
  // The ticket is the lock anchor; the request row is never locked first.
  const ticketId = deps.transaction !== undefined
    ? await ticketOfRequest(deps.transaction, call)
    : await withPgTransaction(
      deps.database!,
      (transaction) => ticketOfRequest(transaction, call),
      call.signal,
    );
  return await runRecheck(deps, {
    organizationId: call.organizationId,
    ticketId,
    origin: call.origin ?? "poll",
    prefetch,
    signal: call.signal,
    trace: call.trace,
  }, { apply: "advance", requestId: call.requestId });
}

async function ticketOfRequest(
  transaction: PgTransactionClient,
  call: Pick<AdvanceCall, "organizationId" | "requestId">,
): Promise<string> {
  const request = await requestById(
    transaction,
    call.organizationId,
    call.requestId,
  );
  if (request === null) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return request.externalTicketId;
}

async function runRecheck(
  deps: AdmissionDeps,
  call: RecheckCall,
  scope: RecheckScope,
): Promise<RecheckResult> {
  assertDeps(deps, call.prefetch);
  if (deps.transaction !== undefined) {
    return await recheckWithin(
      deps,
      deps.transaction,
      call,
      call.prefetch!,
      scope,
    );
  }
  const database = deps.database!;
  const prefetch = call.prefetch ??
    await prefetchForRecheck(deps, database, call);
  return await withPgTransaction(
    database,
    (transaction) => recheckWithin(deps, transaction, call, prefetch, scope),
    call.signal,
  );
}

/** Reads the provider for a recheck with no prefetch, with no transaction open. */
async function prefetchForRecheck(
  deps: AdmissionDeps,
  database: PgDatabase,
  call: RecheckCall,
): Promise<TicketPrefetch> {
  const { source, handle, number } = await withPgTransaction(
    database,
    async (transaction) => {
      const ref = await readTicketRef(
        transaction,
        call.organizationId,
        call.ticketId,
      );
      return {
        ...(await readSourceHandle(
          transaction,
          call.organizationId,
          ref.sourceId,
        )),
        number: ref.number,
      };
    },
    call.signal,
  );
  if (number === null) throw new Error("TICKET_NUMBER_MISSING");
  return await prefetchTicketReads(
    deps.reader,
    handle,
    { number, policy: source.policy, origin: call.origin },
    call.signal,
  );
}

/** What the pass applies decisions with. */
type RecheckPass = {
  frame: Frame;
  context: EvaluationContext & { actor: OrganizationActor | null };
  stored: TicketStoredReport;
  /** The approval a `waiting` start request's run would consume; null when none. */
  approvalId: string | null;
  applied: RecheckAction[];
  pause: RunPauseOutcome | null;
};

async function recheckWithin(
  deps: AdmissionDeps,
  transaction: PgTransactionClient,
  call: RecheckCall,
  prefetch: TicketPrefetch,
  scope: RecheckScope,
): Promise<RecheckResult> {
  const { organizationId } = call;
  const nothing: RecheckResult = {
    applied: [],
    request: null,
    report: null,
    storedReport: null,
    pause: null,
  };
  const trace = call.trace ?? {
    requestId: `ticket-recheck:${crypto.randomUUID()}`,
    traceId: crypto.randomUUID(),
  };
  // The source comes first in the lock order but a ticket id names the ticket,
  // so read its immutable source without a lock, lock in order and read again.
  const ref = await readTicketRef(transaction, organizationId, call.ticketId);
  if (ref.number === null) throw new Error("TICKET_NUMBER_MISSING");
  const source = await lockSource(transaction, organizationId, ref.sourceId);
  const frame: Frame = {
    deps,
    transaction,
    call: {
      organizationId,
      sourceId: source.id,
      number: ref.number,
      intent: null,
      origin: call.origin,
      caller: null,
      prefetch,
      signal: call.signal,
    },
    prefetch,
    source,
    trace,
    authority: await sourceAuthority(transaction, source),
  };
  assertPrefetchCurrent(source, frame.call, prefetch);

  const locked = await lockTicket(transaction, organizationId, call.ticketId);
  const existing = await findNonterminalRequest(
    transaction,
    organizationId,
    locked.id,
  );
  if (
    existing === null ||
    (scope.requestId !== null && existing.id !== scope.requestId)
  ) return nothing;
  await lockApplication(transaction, organizationId, source.applicationId);
  let ticket = locked;
  if (prefetch.issue.kind === "present") {
    const resolved = await resolveTicket(frame);
    if (resolved?.id !== locked.id) {
      throw stateConflict("ticket_prefetch_mismatch");
    }
    ticket = resolved;
  }

  const context = await recordedContext(
    frame,
    existing,
    existing.requirementsDigest,
  );
  const report = await evaluate(frame, context);
  const { stored } = await appendReportIfChanged(
    transaction,
    organizationId,
    ticket.id,
    report,
    call.origin,
  );

  const task = await readTaskState(
    transaction,
    organizationId,
    existing.taskId,
  );
  const runId = existing.workflowRunId ?? task.currentRunId;
  const runStatus = runId === null
    ? null
    : await runStatusOf(transaction, organizationId, runId);
  const pass: RecheckPass = {
    frame,
    context,
    stored,
    approvalId: existing.disposition === "waiting" &&
        existing.intent === "start" && runId === null
      ? await findAvailableApproval(
        transaction,
        organizationId,
        existing.taskId,
        await approvalPolicyDigest(
          effectiveApprovalPolicy(task.approvalPolicy),
        ),
      )
      : null,
    applied: [],
    pause: null,
  };

  let request = existing;
  if (request.workflowRunId === null && runId !== null) {
    // A run started by hand (or by a `runs.create` that committed before this
    // pass) belongs to the request that owns the task: link it, never start a
    // second one.
    request = await updateRequest(transaction, request, {
      workflowRunId: runId,
      ...(request.disposition === "waiting"
        ? { disposition: resumeTarget({ hasRun: true, runStatus }) }
        : {}),
    });
    pass.applied.push("link_run");
    await recordFacts(
      frame,
      request,
      "ticketRequests.link_run",
      existing.authorityPrincipalId,
      { reportId: stored.id, runId },
    );
  }
  const decide = (current: TicketRequest): RecheckDecision =>
    decideRecheck({
      disposition: current.disposition,
      dispositionReason: current.dispositionReason,
      intent: current.intent,
      hasRun: current.workflowRunId !== null,
      runStatus,
      taskStatus: task.status,
      approvalAvailable: pass.approvalId !== null,
      pinnedRequirementsDigest: current.requirementsDigest,
      pauseRequestedAt: current.pauseRequestedAt?.toISOString() ?? null,
    }, report);

  const first = decide(request);
  if (
    first.action !== "none" &&
    (scope.apply === "all" || first.action === "advance")
  ) {
    request = await applyDecision(pass, request, first);
    if (first.action === "suspend") {
      // One decision per call: a request that owns a run is paused in the
      // same pass that suspended it, not five minutes later.
      const next = decide(request);
      if (next.action === "pause") {
        request = await applyDecision(pass, request, next);
      }
    }
  }
  return {
    applied: pass.applied,
    request,
    report,
    storedReport: stored,
    pause: pass.pause,
  };
}

async function applyDecision(
  pass: RecheckPass,
  request: TicketRequest,
  decision: Exclude<RecheckDecision, { action: "none" }>,
): Promise<TicketRequest> {
  const { frame, stored } = pass;
  const { transaction } = frame;
  const details: Record<string, unknown> = { reportId: stored.id };
  let next: TicketRequest;
  let operation: string;
  switch (decision.action) {
    case "suspend":
      // A request already suspended keeps its disposition and takes the
      // stronger reason; a move to itself is not a legal transition.
      next = await updateRequest(transaction, request, {
        dispositionReason: decision.reason,
        ...(request.disposition === "suspended"
          ? {}
          : { disposition: "suspended" as const }),
      });
      operation = "ticketRequests.suspend";
      details.reason = decision.reason;
      break;
    case "resume":
      next = await updateRequest(transaction, request, {
        disposition: decision.to,
        dispositionReason: null,
        readinessReportId: stored.id,
        pauseRequestedAt: null,
      });
      operation = "ticketRequests.resume";
      break;
    case "advance": {
      const runId = await startRun(
        frame,
        pass.context.actor!,
        request,
        {
          id: request.taskId,
          repositoryProfileId: await profileOfTask(
            transaction,
            request.organizationId,
            request.taskId,
          ),
        },
        pass.approvalId!,
      );
      next = await updateRequest(transaction, request, {
        disposition: "admitted",
        workflowRunId: runId,
        readinessReportId: stored.id,
      });
      operation = "ticketRequests.advance";
      details.runId = runId;
      details.approvalId = pass.approvalId;
      break;
    }
    case "terminal":
      next = await updateRequest(transaction, request, {
        disposition: decision.disposition,
        dispositionReason: decision.reason,
      });
      operation = "ticketRequests.end";
      details.reason = decision.reason;
      break;
    case "pause": {
      pass.pause = await requestRunPause(transaction, {
        organizationId: request.organizationId,
        runId: request.workflowRunId!,
        traceId: frame.trace.traceId,
        requestId: request.id,
        version: request.version,
      });
      // Nothing to pause (no live attempt, no steering): record nothing, so
      // the next pass looks again.
      if (!pass.pause.requested) return request;
      next = await updateRequest(transaction, request, {
        pauseRequestedAt: "now",
      });
      operation = "ticketRequests.pause";
      details.runId = request.workflowRunId;
      break;
    }
  }
  pass.applied.push(decision.action);
  await recordFacts(
    frame,
    next,
    operation,
    request.authorityPrincipalId,
    details,
  );
  return next;
}
