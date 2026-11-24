import {
  type DecisionLedgerKind,
  HUMAN_APPROVAL_EVENT,
  HUMAN_APPROVAL_WAIT_LIMIT_MS,
  validateDecisionLedgerEntry,
} from "@bakery/contracts/human-approval";
import { StandardError } from "@bakery/contracts/http";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { mayActOnQuestion } from "../auth/application/run-grants.ts";
import { completeRequestsOnQuestion } from "./run-requests.ts";
import {
  activeElapsedMs,
  APPROVAL_EXPIRED_OUTCOME,
  approvalExpired,
  CHANGES_REQUESTED_OUTCOME,
  HUMAN_APPROVAL_STEP_KEY,
  outcomeForDecision,
  REJECTED_OUTCOME,
  resolveApprover,
  type RunWait,
} from "./human-approval.ts";

/**
 * The writers behind the `human.approval` step.
 *
 * The whole point of this module is that the contract layer had no writer: the
 * schemas described an approval step, a ledger and a named outcome, and nothing
 * created any of them. Everything here exists to make those nouns real, and
 * three rules shape how:
 *
 * 1. A decision is applied by compare-and-swap, and the ledger entry is appended
 *    after the swap wins. Appending first would record a decision that lost the
 *    race, so the ledger could disagree with the run it describes.
 * 2. A refused or replayed decision appends nothing. The status code being right
 *    while an event was written is the defect this order exists to prevent.
 * 3. The wait closes in the same statement that records its outcome, so a run
 *    cannot be left with an open wait after it has already ended.
 */

/** How a principal may be attributed on a ledger entry (O50). */
export type LedgerActorKind = "person" | "agent";

type ApprovalRow = {
  id: string;
  organization_id: string;
  task_id: string;
  conversation_id: string;
  run_id: string | null;
  prompt: string;
  status: string;
  decision: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  expires_at: Date | null;
  audience: { type: string; principalIds?: string[] };
  /**
   * The step key this approval opened its wait under. Null only for rows
   * written before the column existed.
   */
  step_key?: string | null;
  version: number;
};

/**
 * Refuse with a named conflict.
 *
 * `never`, throwing internally, so a guard written as a bare call cannot compile
 * and then silently do nothing - which is exactly how four of these guards once
 * fell through to the next statement.
 */
function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

function notFound(): never {
  throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
}

/**
 * Append one entry to a work item's decisions ledger.
 *
 * This is the writer 0174 never had. The entry is validated before the insert,
 * so a `stop` or `accept_with_reason` without a reason fails here rather than
 * storing a row a reader cannot interpret. The table is append-only
 * (`grant select, insert`), so there is no update path by design.
 */
export async function appendDecision(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    taskId: string;
    runId: string | null;
    kind: DecisionLedgerKind;
    subjectKind: string;
    subjectId: string;
    /** Null only for an entry the system ended, such as an expiry. */
    decidedBy: string | null;
    reason?: string;
    text?: string;
    detail?: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  const entry = validateDecisionLedgerEntry({
    kind: input.kind,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    decidedBy: input.decidedBy,
    decidedAt: new Date().toISOString(),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.decisions_ledger
       (organization_id, task_id, run_id, kind, subject_kind, subject_id,
        decided_by, reason, text, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     returning id`,
    [
      input.organizationId,
      input.taskId,
      input.runId,
      entry.kind,
      entry.subjectKind,
      entry.subjectId,
      input.decidedBy,
      entry.reason ?? null,
      entry.text ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    ],
  );
  return inserted.rows[0]!;
}

/**
 * Create a `human.approval` step: resolve who may answer, record the approval,
 * and start the wait in one transaction.
 *
 * With no resolvable approver this refuses by name and writes nothing. The
 * alternative - widening to an organization admin - would produce a run that
 * looks approved by someone the workflow never named, and no reader could tell.
 */
export async function requestHumanApproval(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    runId: string;
    taskId: string;
    conversationId: string;
    stepKey: string;
    prompt: string;
    audience?: readonly string[];
    ownerPrincipalId: string | null;
    traceId: string;
    applicationId: string;
    repositoryId: string | null;
  },
): Promise<{ approvalId: string; approverPrincipalIds: readonly string[] }> {
  // Resolve the audience against real principal rows before deciding whether
  // anyone can answer. Trusting the strings would let an approval be addressed
  // to nobody and then sit until it expired.
  const candidates = [...(input.audience ?? [])];
  if (input.ownerPrincipalId !== null) candidates.push(input.ownerPrincipalId);
  const found = candidates.length === 0 ? new Set<string>() : new Set(
    (await transaction.query<{ id: string }>(
      // A principal is global; membership is what makes them somebody this
      // organization may ask. Checking both is the difference between "this id
      // exists somewhere" and "this person can answer here".
      `select principal.id
         from bakery.principals principal
         join bakery.organization_memberships membership
           on membership.principal_id = principal.id
        where membership.organization_id = $1
          and membership.status = 'active'
          and principal.id = any($2::uuid[])`,
      [input.organizationId, candidates],
    )).rows.map((row) => row.id),
  );
  const resolution = resolveApprover({
    audience: input.audience,
    ownerPrincipalId: input.ownerPrincipalId,
    principals: found,
  });
  if (!resolution.resolved) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { reason: resolution.refusal },
      detail:
        "This approval step has no one to ask: the workflow has no owner and the step names no audience.",
    });
  }

  const approvalId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + HUMAN_APPROVAL_WAIT_LIMIT_MS);
  // The approval is bound to an exact subject and an exact policy, and both are
  // digests rather than prose so a reader can recompute them. The subject is
  // this step, its prompt and its run: approving it says nothing about another
  // step, another prompt or a later run. The policy is who was asked, because
  // that is the rule in force that lets this approval be answered at all.
  const subjectDigest = await sha256Hex(canonicalJson({
    runId: input.runId,
    stepKey: input.stepKey,
    prompt: input.prompt,
  }));
  const policyDigest = await sha256Hex(canonicalJson({
    stepKey: input.stepKey,
    approverPrincipalIds: [...resolution.approverPrincipalIds].sort(),
  }));
  await transaction.query(
    `insert into bakery.questions
       (id, organization_id, kind, conversation_id, task_id, run_id, generation,
        prompt, allow_free_text, audience, expires_at, status, subject_type,
        subject_id, subject_digest, policy_digest, step_key)
     values ($1, $2, 'approval', $3, $4, $5, 1, $6, true, $7::jsonb, $8,
             'open', 'run_step', $9, $10, $11, $12)`,
    [
      approvalId,
      input.organizationId,
      input.conversationId,
      input.taskId,
      input.runId,
      input.prompt,
      JSON.stringify({
        type: "principals",
        principalIds: resolution.approverPrincipalIds,
      }),
      expiresAt,
      input.runId,
      subjectDigest,
      policyDigest,
      input.stepKey,
    ],
  );

  // The wait is a row, so the active clock can exclude it without anyone
  // remembering to subtract it.
  await transaction.query(
    `insert into bakery.run_waits
       (organization_id, run_id, step_key, kind, started_at)
     values ($1, $2, $3, 'human.approval', now())`,
    [input.organizationId, input.runId, input.stepKey],
  );

  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    applicationId: input.applicationId,
    repositoryId: input.repositoryId,
    taskId: input.taskId,
    conversationId: input.conversationId,
    eventType: "approval.requested",
    aggregateId: approvalId,
    aggregateVersion: 1,
    payload: { resourceId: approvalId, resourceVersion: 1 },
    traceId: input.traceId,
  });

  return {
    approvalId,
    approverPrincipalIds: resolution.approverPrincipalIds,
  };
}

/**
 * Close the wait a step is currently in. Called by every path that ends the wait
 * - a decision, an expiry, or a stop - so a finished approval never leaves an
 * open row that would keep being excluded from the clock.
 */
async function closeWait(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    runId: string;
    stepKey: string;
  },
): Promise<void> {
  await transaction.query(
    `update bakery.run_waits
        set ended_at = now()
      where organization_id = $1 and run_id = $2 and step_key = $3
        and ended_at is null`,
    [input.organizationId, input.runId, input.stepKey],
  );
}

/** Record a run's named ending. Null leaves the run running, which a step may. */
async function recordOutcome(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    runId: string;
    outcome: string | null;
    reason?: string;
    /**
     * The run status this ending implies. Callers that know why the run ended
     * say so rather than leaving it to be inferred from the outcome's spelling:
     * a `workflow.stop` step carries an author-chosen name, so no list of
     * known-good strings can decide whether the run succeeded.
     */
    status?: "succeeded" | "canceled";
  },
): Promise<void> {
  if (input.outcome === null) return;
  // The run's status says how it stopped running; the outcome says what it
  // ended as. A rejection or an expiry finished the run, but neither succeeded,
  // and recording them as `succeeded` would make a failed approval look like a
  // completed one to every reader that filters on status.
  const status = input.status ?? (
    input.outcome === REJECTED_OUTCOME ||
      input.outcome === APPROVAL_EXPIRED_OUTCOME ||
      input.outcome === CHANGES_REQUESTED_OUTCOME
      ? "canceled"
      : "succeeded"
  );
  await transaction.query(
    `update bakery.workflow_runs
        set outcome = $3, outcome_reason = $4, finished_at = now(),
            status = $5, updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [
      input.organizationId,
      input.runId,
      input.outcome,
      input.reason ?? null,
      status,
    ],
  );
}

/**
 * Apply a person's decision to an open approval step.
 *
 * Order matters and is the whole test: lock and swap first, then append the
 * ledger entry, then write the outcome. A rejected or replayed decision returns
 * the conflict before any write, so a 409 always means nothing was recorded.
 */
export async function decideHumanApproval(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    approvalId: string;
    principalId: string;
    decision: "approve" | "request_changes" | "reject";
    note?: string;
    expectedVersion: number;
    actorKind: LedgerActorKind;
    /** Session that made the call, when an agent acted (O50). */
    sessionId?: string;
    /** Principal the actor acted for, when an agent acted (O50). */
    onBehalfOf?: string;
    traceId: string;
    applicationId: string;
    repositoryId: string | null;
  },
): Promise<{ outcome: string | null; version: number }> {
  const loaded = await transaction.query<ApprovalRow>(
    `select id, organization_id, task_id, conversation_id, run_id, prompt,
            status, decision, decided_by, decided_at, expires_at, audience,
            step_key, version
       from bakery.questions
      where organization_id = $1 and id = $2 and subject_type = 'run_step'
      for update`,
    [input.organizationId, input.approvalId],
  );
  const row = loaded.rows[0];
  // A foreign or invented id answers identically: no oracle for existence.
  if (!row) notFound();
  // The store is the writer, so it enforces who may answer rather than trusting
  // every caller to check first. An approval addressed to named people does not
  // exist for anybody else, which is the same refusal the route gives.
  if (
    !await mayActOnQuestion(
      transaction,
      input.organizationId,
      input.principalId,
      row,
      "approve",
    )
  ) notFound();
  if (row.status === "answered") conflict("approval_decided");
  if (row.status !== "open") conflict(`approval_${row.status}`);
  if (row.version !== input.expectedVersion) conflict("approval_stale");
  if (
    row.expires_at !== null && row.expires_at.getTime() <= Date.now()
  ) {
    conflict("approval_unavailable");
  }

  const swapped = await transaction.query<{ version: number }>(
    `update bakery.questions
        set status = 'answered', decision = $3, decision_comment = $4,
            decided_by = $5, decided_at = now(), answer = $7::jsonb,
            answered_by = $5, answered_at = now(), updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2 and status = 'open'
        and version = $6
      returning version`,
    [
      input.organizationId,
      input.approvalId,
      input.decision,
      input.note === undefined || input.note.trim() === "" ? null : input.note,
      input.principalId,
      input.expectedVersion,
      // The same `answer` shape the approval route already stores, so a reader
      // of either kind of approval sees one projection.
      JSON.stringify({
        decision: input.decision,
        ...(input.note === undefined || input.note.trim() === ""
          ? {}
          : { note: input.note }),
      }),
    ],
  );
  if (swapped.rows.length !== 1) conflict("approval_unavailable");
  // The request that asked for this decision is done, and so is its power.
  await completeRequestsOnQuestion(
    transaction,
    input.organizationId,
    input.principalId,
    input.approvalId,
    "handled",
  );

  const outcome = outcomeForDecision(input.decision);
  // The ledger kind is the decision's own word, so a reader filters on the same
  // vocabulary the approver saw.
  const kind: DecisionLedgerKind = input.decision === "approve"
    ? "approval"
    : input.decision === "reject"
    ? "rejection"
    : "request_changes";
  await appendDecision(transaction, {
    organizationId: input.organizationId,
    taskId: row.task_id,
    runId: row.run_id,
    kind,
    subjectKind: "approval",
    subjectId: input.approvalId,
    decidedBy: input.principalId,
    ...(input.note === undefined || input.note.trim() === ""
      ? {}
      : { text: input.note }),
    detail: {
      decision: input.decision,
      actorKind: input.actorKind,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.onBehalfOf === undefined
        ? {}
        : { onBehalfOf: input.onBehalfOf }),
    },
  });

  if (row.run_id !== null) {
    await closeWait(transaction, {
      organizationId: input.organizationId,
      runId: row.run_id,
      // The key this approval opened its wait under, not a literal. A step
      // using any other key would otherwise leave its wait open, and an open
      // wait is excluded from the active clock forever.
      stepKey: row.step_key ?? HUMAN_APPROVAL_STEP_KEY,
    });
    if (outcome !== null) {
      await transaction.query(
        `update bakery.run_steps
            set status = 'completed',
                output = jsonb_build_object(
                  'decision', $3::text, 'note', $4::text,
                  'decidedBy', $5::uuid, 'decidedAt', clock_timestamp(),
                  'approvalId', $2::uuid
                ),
                finished_at = clock_timestamp(),
                updated_at = clock_timestamp(), version = version + 1
          where organization_id = $1 and run_id = $6 and status = 'waiting'
            and dispatch ->> 'kind' = 'wait'
            and dispatch #>> '{wait,approvalId}' = $2::text`,
        [
          input.organizationId,
          input.approvalId,
          input.decision,
          input.note === undefined || input.note.trim() === ""
            ? null
            : input.note,
          input.principalId,
          row.run_id,
        ],
      );
    }
    await recordOutcome(transaction, {
      organizationId: input.organizationId,
      runId: row.run_id,
      outcome,
      ...(input.note === undefined ? {} : { reason: input.note }),
    });
    await appendDomainEvent(transaction, {
      organizationId: input.organizationId,
      applicationId: input.applicationId,
      repositoryId: input.repositoryId,
      taskId: row.task_id,
      conversationId: row.conversation_id,
      eventType: HUMAN_APPROVAL_EVENT,
      aggregateId: input.approvalId,
      aggregateVersion: swapped.rows[0]!.version,
      // The event is an invalidation notice, so it carries the resource and its
      // version and nothing else; a consumer re-reads the decision from the
      // approval row and the ledger, which are the authoritative record.
      payload: {
        resourceId: input.approvalId,
        resourceVersion: swapped.rows[0]!.version,
      },
      traceId: input.traceId,
    });
  }

  return { outcome, version: swapped.rows[0]!.version };
}

/**
 * End every approval step that has passed its seven-day limit.
 *
 * Expiry is a named outcome and a ledger entry, not a failure: nothing went
 * wrong, the person did not answer. A reader of the run can then tell "nobody
 * answered in seven days" from "the run broke".
 */
export async function expireHumanApprovals(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    now?: Date;
  },
): Promise<readonly { approvalId: string; runId: string }[]> {
  const now = input.now ?? new Date();
  const due = await transaction.query<ApprovalRow & { step_key: string }>(
    `select q.id, q.organization_id, q.task_id, q.conversation_id, q.run_id,
            q.prompt, q.status, q.decision, q.decided_by, q.decided_at,
            q.expires_at, q.version, coalesce(w.step_key, 'human.approval') as step_key
       from bakery.questions q
       left join bakery.run_waits w
         on w.organization_id = q.organization_id and w.run_id = q.run_id
        -- The step key is part of the wait's identity. Joining only on the run
        -- would match another step's open wait, and the close would then end
        -- the wrong row (or none) while reporting success.
        and w.step_key = coalesce(q.step_key, 'human.approval')
        and w.ended_at is null
      where q.organization_id = $1 and q.subject_type = 'run_step'
        and q.status = 'open' and q.expires_at is not null
        and q.expires_at <= $2
      for update of q`,
    [input.organizationId, now],
  );

  const expired: { approvalId: string; runId: string }[] = [];
  for (const row of due.rows) {
    if (row.run_id === null) continue;
    const swapped = await transaction.query<{ version: number }>(
      `update bakery.questions
          set status = 'expired', updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2 and status = 'open'
        returning version`,
      [input.organizationId, row.id],
    );
    if (swapped.rows.length !== 1) continue;
    // The approval row itself proves the expiry; the helper is exercised against
    // the same instant so the rule and the writer cannot drift apart.
    approvalExpired({
      startedAt: row.expires_at === null
        ? now
        : new Date(row.expires_at.getTime() - HUMAN_APPROVAL_WAIT_LIMIT_MS),
      now,
      limitMs: HUMAN_APPROVAL_WAIT_LIMIT_MS,
    });
    await appendDecision(transaction, {
      organizationId: input.organizationId,
      taskId: row.task_id,
      runId: row.run_id,
      // "stop", not "approval": nothing was approved. The entry records that
      // the system ended the wait, and `stop` is the kind that says a run
      // finished on purpose and must carry a reason.
      kind: "stop",
      subjectKind: "approval",
      subjectId: row.id,
      // Nobody decided: the system ended the wait. Attributing that to the
      // approver would claim a decision they never made, so it is recorded as a
      // system entry with the reason naming why.
      decidedBy: null,
      reason: "The approval step expired after seven days without a decision.",
      detail: {
        decision: "expired",
        outcome: APPROVAL_EXPIRED_OUTCOME,
        endedBy: "system:approval_expiry",
      },
    });
    await closeWait(transaction, {
      organizationId: input.organizationId,
      runId: row.run_id,
      stepKey: row.step_key,
    });
    await recordOutcome(transaction, {
      organizationId: input.organizationId,
      runId: row.run_id,
      outcome: APPROVAL_EXPIRED_OUTCOME,
      reason: "The approval step expired after seven days without a decision.",
    });
    expired.push({ approvalId: row.id, runId: row.run_id });
  }
  return expired;
}

/**
 * End a run on purpose with a named outcome (`workflow.stop`).
 *
 * A stop and a rejection are different events with different outcomes, so they
 * never share a name: the name is what a person reading the run branches on, and
 * a single "stopped" for both would throw that away.
 */
export async function stopRun(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    runId: string;
    taskId: string;
    outcome: string;
    reason: string;
    decidedBy: string;
    traceId: string;
    applicationId: string;
    repositoryId: string | null;
    conversationId: string;
  },
): Promise<void> {
  // A stop requires a reason, enforced by the ledger validator, because a run
  // that ends on purpose has to say why.
  await appendDecision(transaction, {
    organizationId: input.organizationId,
    taskId: input.taskId,
    runId: input.runId,
    kind: "stop",
    subjectKind: "run",
    subjectId: input.runId,
    decidedBy: input.decidedBy,
    reason: input.reason,
    detail: { outcome: input.outcome },
  });
  await recordOutcome(transaction, {
    organizationId: input.organizationId,
    runId: input.runId,
    outcome: input.outcome,
    reason: input.reason,
    // A run stopped on purpose did not succeed, whichever name the workflow
    // author gave the ending. Inferring this from the name would mark a stop
    // named `nothing_to_do` as a success.
    status: "canceled",
  });
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    applicationId: input.applicationId,
    repositoryId: input.repositoryId,
    taskId: input.taskId,
    conversationId: input.conversationId,
    eventType: "workflow.stopped",
    aggregateId: input.runId,
    aggregateVersion: 1,
    payload: { resourceId: input.runId, resourceVersion: 1 },
    traceId: input.traceId,
  });
}

/**
 * The run's active elapsed time: wall time since its first review cycle minus
 * every wait it spent on a person.
 *
 * This is the replacement for the raw wall-clock difference that would charge a
 * run for the seven days a human took to answer, and then stop the loop as
 * though it had spent that time working.
 */
export async function activeLoopElapsedMs(
  transaction: PgTransactionClient,
  input: { organizationId: string; runId: string },
): Promise<number | null> {
  const wall = await transaction.query<{ elapsed_ms: string | null }>(
    `select ceil(extract(epoch from (clock_timestamp() - min(created_at))) *
                 1000)::bigint::text as elapsed_ms
       from bakery.review_cycles
      where organization_id = $1 and run_id = $2`,
    [input.organizationId, input.runId],
  );
  const wallValue = wall.rows[0]?.elapsed_ms;
  if (wallValue === null || wallValue === undefined) return null;

  const waits = await transaction.query<
    { started_at: Date; ended_at: Date | null }
  >(
    `select started_at, ended_at
       from bakery.run_waits
      where organization_id = $1 and run_id = $2`,
    [input.organizationId, input.runId],
  );
  const rows: RunWait[] = waits.rows.map((row) => ({
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }));
  return activeElapsedMs({
    wallElapsedMs: Number(wallValue),
    waits: rows,
    now: new Date(),
  });
}
