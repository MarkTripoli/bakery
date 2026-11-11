import { StandardError } from "@bakery/contracts/http";
import type {
  DeliveryDecisionKind,
  DeliveryDecisionReason,
} from "@bakery/contracts/review-evidence";
import {
  candidateProducer,
  harnessStepKeys,
  reviewLoopFromSnapshot,
  type ReviewLoopLimits,
} from "@bakery/persistence/repository-admission";
import type { PgTransactionClient } from "../../platform/database.ts";
import { formatMicroUsd, parseMicroUsd } from "../work/budget.ts";
import { reviewLoopSteps } from "./loop-steps.ts";
import type {
  DecisionBudget,
  DecisionReviewStatus,
  PriorDecision,
} from "./repair-loop.ts";

/**
 * The only module that writes `review_cycles`, `review_findings` and
 * `delivery_decisions` (a rail pins that). The three tables are insert-only
 * evidence for the review and repair loop (issue #94): the application role has
 * no update or delete grant, so a row cannot be edited after the fact, and
 * resolution of a finding is derived from the run's latest cycle when it is
 * read.
 *
 * Every function takes an explicit organization and reads or writes only that
 * organization's rows. A unique-key conflict is `STATE_CONFLICT`, never a raw
 * database error, so a replayed or racing writer is refused like any other
 * state it cannot reconcile.
 */

/** A `FailedCheck` as a decision stores it and a repair step receives it. */
export type StoredFailedCheck = {
  readonly checkRunId: string;
  readonly checkId: string;
  readonly result: "failed";
  readonly reason: string;
  readonly exitCode: number | null;
};

export type NewReviewCycle = {
  /** Identifier the reviewer generated for the report; becomes the row id. */
  readonly id: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly runStepId: string;
  readonly jobId: string;
  readonly attemptId: string;
  /** Fence of the attempt that produced the report, a decimal string. */
  readonly fence: string;
  readonly ordinal: number;
  readonly reviewerSessionId: string;
  readonly reviewerPrincipalId: string;
  readonly implementerSessionId: string;
  readonly implementerPrincipalId: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly policyDigest: string;
  readonly status: DecisionReviewStatus;
  readonly findingCount: number;
  readonly blockingCount: number;
};

export type NewReviewFinding = {
  readonly fingerprint: string;
  readonly severity: string;
  readonly path: string;
  readonly line: number | null;
  readonly body: string;
};

export type NewDeliveryDecision = {
  readonly id: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly reviewCycleId: string | null;
  readonly decision: DeliveryDecisionKind;
  readonly reason: DeliveryDecisionReason;
  readonly headSha: string;
  readonly baseSha: string | null;
  readonly policyDigest: string | null;
  readonly failedChecks: readonly StoredFailedCheck[];
  readonly blockingFingerprints: readonly string[];
  readonly limits: ReviewLoopLimits;
};

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

/**
 * Records one review cycle. Conflicts on the report's id, on the run's ordinal
 * or on the job's fence mean the report was already recorded or lost a race
 * with another; either way nothing is written.
 */
export async function insertReviewCycle(
  transaction: PgTransactionClient,
  cycle: NewReviewCycle,
): Promise<void> {
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.review_cycles (
       id, organization_id, run_id, run_step_id, job_id, attempt_id, fence,
       ordinal, reviewer_session_id, reviewer_principal_id,
       implementer_session_id, implementer_principal_id, head_sha, base_sha,
       policy_digest, status, finding_count, blocking_count
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, $18
     ) on conflict do nothing returning id`,
    [
      cycle.id,
      cycle.organizationId,
      cycle.runId,
      cycle.runStepId,
      cycle.jobId,
      cycle.attemptId,
      cycle.fence,
      cycle.ordinal,
      cycle.reviewerSessionId,
      cycle.reviewerPrincipalId,
      cycle.implementerSessionId,
      cycle.implementerPrincipalId,
      cycle.headSha,
      cycle.baseSha,
      cycle.policyDigest,
      cycle.status,
      cycle.findingCount,
      cycle.blockingCount,
    ],
  );
  if (inserted.rows.length !== 1) conflict("review_cycle_conflict");
}

/** Records the findings of one cycle, one row per fingerprint. */
export async function insertReviewFindings(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly reviewCycleId: string;
    readonly findings: readonly NewReviewFinding[];
  },
): Promise<void> {
  for (const finding of input.findings) {
    const inserted = await transaction.query<{ id: string }>(
      `insert into bakery.review_findings (
         id, organization_id, review_cycle_id, fingerprint, severity, path,
         line, body
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict do nothing returning id`,
      [
        crypto.randomUUID(),
        input.organizationId,
        input.reviewCycleId,
        finding.fingerprint,
        finding.severity,
        finding.path,
        finding.line,
        finding.body,
      ],
    );
    if (inserted.rows.length !== 1) conflict("review_finding_conflict");
  }
}

/** Records one delivery decision. */
export async function insertDeliveryDecision(
  transaction: PgTransactionClient,
  decision: NewDeliveryDecision,
): Promise<void> {
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.delivery_decisions (
       id, organization_id, run_id, ordinal, review_cycle_id, decision, reason,
       head_sha, base_sha, policy_digest, failed_checks,
       blocking_fingerprints, limits
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
       $13::jsonb
     ) on conflict do nothing returning id`,
    [
      decision.id,
      decision.organizationId,
      decision.runId,
      decision.ordinal,
      decision.reviewCycleId,
      decision.decision,
      decision.reason,
      decision.headSha,
      decision.baseSha,
      decision.policyDigest,
      JSON.stringify(decision.failedChecks),
      JSON.stringify(decision.blockingFingerprints),
      JSON.stringify(decision.limits),
    ],
  );
  if (inserted.rows.length !== 1) conflict("delivery_decision_conflict");
}

/** One session of an implementing (harness) step of the run. */
export type ImplementingSession = {
  readonly sessionId: string;
  readonly runStepId: string;
  readonly stepKey: string;
  readonly iteration: number;
  /** True once the step recorded an output, that is, produced a candidate. */
  readonly hasOutput: boolean;
  /**
   * Worker principal of the host that completed the step's job, or null when no
   * completed attempt exists. A cycle needs it, so a null refuses the review.
   */
  readonly workerPrincipalId: string | null;
};

/** What the review finalizer needs to know about a run before it records one. */
export type RunLoopFacts = {
  /** The run snapshot as stored; read only through the persistence readers. */
  readonly snapshot: unknown;
  /** The latest recorded output of each step key, as the claim query reads it. */
  readonly stepOutputs: Readonly<Record<string, unknown>>;
  /** Loop bounds frozen at admission; null when the run has no loop. */
  readonly reviewLoop: ReviewLoopLimits | null;
  readonly cycleCount: number;
  readonly decisionCount: number;
  /** Decisions already recorded, with the output digest of each failed check. */
  readonly priorDecisions: readonly PriorDecision[];
  /** Every session of every implementing step, all iterations. */
  readonly implementing: readonly ImplementingSession[];
};

type RunRow = { snapshot: unknown };

type StepOutputRow = { step_key: string; output: unknown };

type ImplementingRow = {
  session_id: string;
  run_step_id: string;
  step_key: string;
  iteration: number;
  has_output: boolean;
  principal_id: string | null;
};

type DecisionRow = {
  ordinal: number;
  decision: DeliveryDecisionKind;
  blocking_fingerprints: unknown;
  failed_checks: unknown;
};

function stringArray(value: unknown, what: string): string[] {
  if (
    !Array.isArray(value) || value.some((entry) => typeof entry !== "string")
  ) throw new Error(`DELIVERY_DECISION_ROW_INVALID:${what}`);
  return value as string[];
}

function failedCheckRefs(
  value: unknown,
): Array<{ checkRunId: string; checkId: string }> {
  if (!Array.isArray(value)) {
    throw new Error("DELIVERY_DECISION_ROW_INVALID:failed_checks");
  }
  return value.map((entry) => {
    const record = entry !== null && typeof entry === "object"
      ? entry as Record<string, unknown>
      : null;
    if (
      record === null || typeof record.checkRunId !== "string" ||
      typeof record.checkId !== "string"
    ) throw new Error("DELIVERY_DECISION_ROW_INVALID:failed_checks");
    return { checkRunId: record.checkRunId, checkId: record.checkId };
  });
}

/**
 * The latest output of each step key of a run: the highest iteration that has
 * one. This is the same read the claim query does when it resolves a step's
 * references, so the candidate this module finds is the candidate the next
 * job would be admitted against.
 */
export async function loadStepOutputs(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runId: string },
): Promise<Record<string, unknown>> {
  const result = await transaction.query<StepOutputRow>(
    `select distinct on (step.step_key) step.step_key, step.output
       from bakery.run_steps step
      where step.organization_id = $1 and step.run_id = $2
        and step.output is not null
      order by step.step_key, step.iteration desc, step.position desc,
               step.id desc`,
    [input.organizationId, input.runId],
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.step_key, row.output]),
  );
}

/**
 * Reads everything the finalizer decides from, under an explicit organization
 * predicate. A run of another organization reads as missing. Nothing here
 * locks a row: the evidence tables are insert-only, and a racing second report
 * for the same run hits a unique key instead.
 */
export async function loadRunLoopFacts(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runId: string },
): Promise<RunLoopFacts> {
  const { organizationId, runId } = input;
  const run = await transaction.query<RunRow>(
    `select snapshot
       from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  const runRow = run.rows[0];
  if (!runRow) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const snapshot = runRow.snapshot;
  const reviewLoop = reviewLoopFromSnapshot(snapshot);
  const stepOutputs = await loadStepOutputs(transaction, input);

  const cycles = await transaction.query<{ count: string }>(
    `select count(*)::text as count from bakery.review_cycles
      where organization_id = $1 and run_id = $2`,
    [organizationId, runId],
  );
  const decisions = await transaction.query<DecisionRow>(
    `select ordinal, decision, blocking_fingerprints, failed_checks
       from bakery.delivery_decisions
      where organization_id = $1 and run_id = $2
      order by ordinal`,
    [organizationId, runId],
  );

  // A decision stores the failed checks by row id; the output digest that
  // tells whether a failure repeated lives on the immutable check run.
  const refs = decisions.rows.map((row) => ({
    row,
    checks: failedCheckRefs(row.failed_checks),
  }));
  const checkRunIds = [
    ...new Set(refs.flatMap(({ checks }) => checks.map((c) => c.checkRunId))),
  ];
  const digests = new Map<string, string | null>();
  if (checkRunIds.length > 0) {
    const rows = await transaction.query<
      { id: string; output_digest: string | null }
    >(
      `select id, output_digest from bakery.check_runs
        where organization_id = $1 and run_id = $2 and id = any($3::uuid[])`,
      [organizationId, runId, checkRunIds],
    );
    for (const row of rows.rows) digests.set(row.id, row.output_digest);
  }
  const priorDecisions: PriorDecision[] = refs.map(({ row, checks }) => ({
    ordinal: row.ordinal,
    decision: row.decision,
    blockingFingerprints: stringArray(
      row.blocking_fingerprints,
      "blocking_fingerprints",
    ),
    failedChecks: checks.map((check) => ({
      checkId: check.checkId,
      outputDigest: digests.get(check.checkRunId) ?? null,
    })),
  }));

  const stepKeys = reviewLoop === null ? [] : [...harnessStepKeys(snapshot)];
  const implementing: ImplementingSession[] = [];
  if (stepKeys.length > 0) {
    const sessions = await transaction.query<ImplementingRow>(
      `select session.id as session_id, step.id as run_step_id, step.step_key,
              step.iteration, step.output is not null as has_output,
              (
                select host.principal_id
                  from bakery.jobs job
                  join bakery.job_attempts attempt
                    on attempt.organization_id = job.organization_id
                   and attempt.job_id = job.id
                   and attempt.status = 'completed'
                  join bakery.worker_hosts host
                    on host.organization_id = attempt.organization_id
                   and host.id = attempt.worker_host_id
                 where job.organization_id = step.organization_id
                   and job.run_step_id = step.id
                 order by attempt.attempt_no desc
                 limit 1
              ) as principal_id
         from bakery.run_steps step
         join bakery.agent_sessions session
           on session.organization_id = step.organization_id
          and session.run_step_id = step.id
        where step.organization_id = $1 and step.run_id = $2
          and step.step_key = any($3::text[])
        order by step.iteration, step.position, session.created_at, session.id`,
      [organizationId, runId, stepKeys],
    );
    for (const row of sessions.rows) {
      implementing.push({
        sessionId: row.session_id,
        runStepId: row.run_step_id,
        stepKey: row.step_key,
        iteration: row.iteration,
        hasOutput: row.has_output,
        workerPrincipalId: row.principal_id,
      });
    }
  }
  return {
    snapshot,
    stepOutputs,
    reviewLoop,
    cycleCount: Number(cycles.rows[0]?.count ?? 0),
    decisionCount: decisions.rows.length,
    priorDecisions,
    implementing,
  };
}

/**
 * The implementing session that produced the run's current candidate: the
 * latest iteration of the producing step that recorded an output. Null when
 * the producing step has no session or no completed attempt on record, which
 * the caller refuses because a cycle must name both.
 */
export function candidateImplementer(
  facts: Pick<RunLoopFacts, "snapshot" | "stepOutputs" | "implementing">,
): ImplementingSession | null {
  const { stepKey } = candidateProducer(facts.snapshot, facts.stepOutputs);
  const produced = facts.implementing.filter((entry) =>
    entry.stepKey === stepKey && entry.hasOutput
  );
  if (produced.length === 0) return null;
  const latest = Math.max(...produced.map(({ iteration }) => iteration));
  return produced.find(({ iteration }) => iteration === latest) ?? null;
}

/**
 * Milliseconds since the run's first review cycle was recorded, on the
 * database clock. Null before any cycle exists. Callers record the cycle first,
 * so the first review of a run measures a few milliseconds, never a missing
 * value, and a later review measures the whole loop.
 */
export async function loopElapsedMs(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runId: string },
): Promise<number | null> {
  const result = await transaction.query<{ elapsed_ms: string | null }>(
    `select ceil(extract(epoch from (clock_timestamp() - min(created_at))) *
                 1000)::bigint::text as elapsed_ms
       from bakery.review_cycles
      where organization_id = $1 and run_id = $2`,
    [input.organizationId, input.runId],
  );
  const value = result.rows[0]?.elapsed_ms;
  return value === null || value === undefined ? null : Number(value);
}

/** The reservation a step's frozen agent holds, as micro-USD; 0 when unbilled. */
function frozenReservation(snapshot: unknown, stepKey: string): bigint {
  const agents = (snapshot as Record<string, unknown> | null)?.stepAgents;
  const agent = agents !== null && typeof agents === "object"
    ? (agents as Record<string, unknown>)[stepKey]
    : undefined;
  const config = agent !== null && typeof agent === "object"
    ? (agent as Record<string, unknown>).config
    : undefined;
  const billing = config !== null && typeof config === "object"
    ? (config as Record<string, unknown>).billing
    : undefined;
  const amount = billing !== null && typeof billing === "object"
    ? (billing as Record<string, unknown>).maxUsdReservation
    : undefined;
  return amount === undefined
    ? 0n
    : parseMicroUsd(amount, "max_usd_reservation");
}

/**
 * What the run can still spend and what one more repair and review would
 * reserve, as decimal USD strings, or null when the run has no budget account
 * to bound. `remainingUsd` is the run account's limit less what is held and
 * settled; `nextCycleUsd` is the sum of the frozen `maxUsdReservation` of the
 * repair and review agents, the amounts admission would reserve for them.
 * Held reservations of steps that reported no usage count as spent until they
 * settle or expire, which only ever stops a loop earlier, never later.
 */
export async function readRunBudgetHeadroom(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly snapshot: unknown;
  },
): Promise<DecisionBudget | null> {
  const account = await transaction.query<{ remaining: string }>(
    `select greatest(limit_usd - reserved_usd - settled_usd, 0)::text
              as remaining
       from bakery.budget_accounts
      where organization_id = $1 and scope = 'run' and run_id = $2`,
    [input.organizationId, input.runId],
  );
  const remaining = account.rows[0]?.remaining;
  if (remaining === undefined) return null;
  const steps = reviewLoopSteps(input.snapshot);
  const next = frozenReservation(input.snapshot, steps.repair.key) +
    frozenReservation(input.snapshot, steps.review.key);
  return { remainingUsd: remaining, nextCycleUsd: formatMicroUsd(next) };
}

/** The latest decision of a run, as stored. */
export type StoredDecision = {
  readonly id: string;
  readonly ordinal: number;
  readonly reviewCycleId: string | null;
  readonly decision: DeliveryDecisionKind;
  readonly reason: DeliveryDecisionReason;
  readonly headSha: string;
  readonly baseSha: string | null;
  readonly policyDigest: string | null;
};

type StoredDecisionRow = {
  id: string;
  ordinal: number;
  review_cycle_id: string | null;
  decision: DeliveryDecisionKind;
  reason: DeliveryDecisionReason;
  head_sha: string;
  base_sha: string | null;
  policy_digest: string | null;
};

/** The decision with the highest ordinal, or null before the first review. */
export async function readLatestDecision(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly runId: string },
): Promise<StoredDecision | null> {
  const result = await transaction.query<StoredDecisionRow>(
    `select id, ordinal, review_cycle_id, decision, reason, head_sha, base_sha,
            policy_digest
       from bakery.delivery_decisions
      where organization_id = $1 and run_id = $2
      order by ordinal desc
      limit 1`,
    [input.organizationId, input.runId],
  );
  const row = result.rows[0];
  return row === undefined ? null : {
    id: row.id,
    ordinal: row.ordinal,
    reviewCycleId: row.review_cycle_id,
    decision: row.decision,
    reason: row.reason,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    policyDigest: row.policy_digest,
  };
}

/** A review cycle as stored, without its findings. */
export type StoredCycle = {
  readonly id: string;
  readonly ordinal: number;
  readonly runStepId: string;
  readonly jobId: string | null;
  readonly reviewerSessionId: string;
  readonly implementerSessionId: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly policyDigest: string;
  readonly status: DecisionReviewStatus;
  readonly findingCount: number;
  readonly blockingCount: number;
};

type StoredCycleRow = {
  id: string;
  ordinal: number;
  run_step_id: string;
  job_id: string | null;
  reviewer_session_id: string;
  implementer_session_id: string;
  head_sha: string;
  base_sha: string;
  policy_digest: string;
  status: DecisionReviewStatus;
  finding_count: number;
  blocking_count: number;
};

/**
 * The newest cycle that reviewed exactly `headSha`, or null. A cycle of an
 * earlier head says nothing about a candidate that has moved.
 */
export async function readLatestCycleAtHead(
  transaction: PgTransactionClient,
  input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly headSha: string;
  },
): Promise<StoredCycle | null> {
  const result = await transaction.query<StoredCycleRow>(
    `select id, ordinal, run_step_id, job_id, reviewer_session_id,
            implementer_session_id, head_sha, base_sha, policy_digest, status,
            finding_count, blocking_count
       from bakery.review_cycles
      where organization_id = $1 and run_id = $2 and head_sha = $3
      order by ordinal desc
      limit 1`,
    [input.organizationId, input.runId, input.headSha],
  );
  const row = result.rows[0];
  return row === undefined ? null : {
    id: row.id,
    ordinal: row.ordinal,
    runStepId: row.run_step_id,
    jobId: row.job_id,
    reviewerSessionId: row.reviewer_session_id,
    implementerSessionId: row.implementer_session_id,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    policyDigest: row.policy_digest,
    status: row.status,
    findingCount: row.finding_count,
    blockingCount: row.blocking_count,
  };
}

/**
 * The stored input of the review job that produced a cycle: the pinned profile
 * and the revision admission froze. The delivery gate derives the pins a
 * decision was taken under from it, so it judges the checks by the same policy.
 */
export async function readCycleJobInput(
  transaction: PgTransactionClient,
  input: { readonly organizationId: string; readonly cycleId: string },
): Promise<unknown | null> {
  const result = await transaction.query<{ input: unknown }>(
    `select job.input
       from bakery.review_cycles cycle
       join bakery.jobs job
         on job.organization_id = cycle.organization_id
        and job.id = cycle.job_id
      where cycle.organization_id = $1 and cycle.id = $2`,
    [input.organizationId, input.cycleId],
  );
  return result.rows[0]?.input ?? null;
}
