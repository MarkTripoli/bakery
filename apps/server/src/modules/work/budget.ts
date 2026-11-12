import {
  WORKFLOW_ACTION_METADATA,
  type WorkflowActionName,
} from "@bakery/contracts/workflow-action-registry";
import type {
  BillingConfig,
  ContractOutput,
} from "@bakery/contracts/contracts";
import {
  BillingConfigSchema,
  contractSchemas,
} from "@bakery/contracts/contracts";
import type { output as ZodOutput } from "zod";
import { StandardError } from "@bakery/contracts/http";
import type { BudgetRuntimeConfig } from "@bakery/config";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  assertReservationsFreeOfLiveEffects,
  noLiveEffectOnReservationsSql,
} from "@bakery/persistence/external-effect-holds";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";

export type ParsedUsageReceipt = ZodOutput<typeof contractSchemas.UsageReceipt>;

const MICRO_USD_SCALE = 1_000_000n;
const MAX_MICRO_USD = 99_999_999_999_999n;
const DECIMAL_USD = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type RunBudgetSummary = ContractOutput<"Run">["budgetSummary"];
type BudgetAccountSummary = RunBudgetSummary["run"];

export type BudgetPolicy = BudgetRuntimeConfig;

export type WorkflowBudgetReservation = Readonly<{
  intentId: string;
  installationReservationId: string;
  runReservationId: string;
  providerCallIntentId: string;
}>;

export type WorkflowBudgetReservationInput = Readonly<{
  organizationId: string;
  runId: string;
  runStepId: string;
  action: string;
  actionVersion: string;
  contentDigest: string;
  agentVersionId: string | null;
  billing: unknown;
  policy: BudgetPolicy | undefined;
}>;

export type UsageReceipt = Readonly<{
  usageFactId: string;
  providerCallId: string;
  provider: string;
  billingAccountId: string;
  model: string;
  billingRoute: "api" | "subscription";
  pricingMetadataSnapshot: string;
  inputTokens: string | null;
  outputTokens: string | null;
  costUsd: string | null;
  measurement: "reported" | "estimated" | "unknown";
  occurredAt: string;
}>;

export type BudgetReleaseEvidence = Readonly<{
  id: string;
  kind: "pre-dispatch-rejection";
  digest: string;
  jobId: string;
  jobVersion: number | null;
  attemptId: string | null;
  effectId: string;
  sourceEventId: string | null;
}>;

export type ProviderUsageReceiptCandidate = Readonly<{
  organizationId: string;
  installationReservationId: string;
  /** Worker-created usage record, when one exists; null = receipt-only. */
  usageRecordId: string | null;
  /** Durable receipt row id; the recovery candidate identity. */
  receiptId: string;
}>;

export type BudgetReleaseCandidate = Readonly<{
  organizationId: string;
  installationReservationId: string;
  evidenceId: string;
}>;

export type BudgetRecoveryFailureKind = "provider-receipt" | "release";

export type SettleWorkflowBudgetInput = Readonly<{
  organizationId: string;
  runId: string;
  runStepId: string;
  installationReservationId: string;
  attemptId: string;
  workerHostId: string;
  workerSessionId: string;
  workerSessionGeneration: string;
  fence: string;
  resultEventId: string;
  receipt: ParsedUsageReceipt;
}>;

type AccountRow = Readonly<{
  id: string;
  scope: "installation" | "run";
  runId: string | null;
  periodStart: Date | string;
  periodEnd: Date | string;
  limitUsd: string;
  reservedUsd: string;
  settledUsd: string;
}>;

type IntentRow = Readonly<{
  id: string;
  organizationId: string;
  runId: string;
  runStepId: string;
  action: string;
  actionVersion: string;
  agentVersionId: string;
  provider: string;
  billingAccountId: string;
  model: string;
  billingRoute: "api" | "subscription";
  pricingMetadataSnapshot: string;
  reservedUsd: string;
  contentDigest: string;
  dedupeKey: string;
  status: "held" | "settled" | "released";
  installationReservationId: string | null;
  runReservationId: string | null;
  providerCallIntentId: string | null;
}>;

type ReservationRow = Readonly<{
  id: string;
  budgetAccountId: string;
  reservedUsd: string;
  settledUsd: string | null;
  status: "held" | "settled" | "released";
}>;

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

export function parseMicroUsd(value: unknown, field = "amount"): bigint {
  const text = typeof value === "number"
    ? Number.isFinite(value) ? String(value) : ""
    : typeof value === "string"
    ? value.trim()
    : "";
  if (!DECIMAL_USD.test(text)) {
    conflict(`${field}_invalid`);
  }
  const [whole, fraction = ""] = text.split(".");
  const micros = BigInt(whole) * MICRO_USD_SCALE +
    BigInt(fraction.padEnd(6, "0"));
  if (micros > MAX_MICRO_USD) conflict(`${field}_out_of_range`);
  return micros;
}

export function formatMicroUsd(value: bigint): string {
  if (value < 0n || value > MAX_MICRO_USD) {
    throw new Error("BUDGET_MICRO_USD_OUT_OF_RANGE");
  }
  const whole = value / MICRO_USD_SCALE;
  const fraction = (value % MICRO_USD_SCALE).toString().padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("BUDGET_TIMESTAMP_INVALID");
  }
  return date.toISOString();
}

function billingConfig(value: unknown): BillingConfig {
  const parsed = BillingConfigSchema.safeParse(value);
  if (!parsed.success) conflict("billing_configuration_missing");
  parseMicroUsd(parsed.data.maxUsdReservation, "max_usd_reservation");
  return parsed.data;
}

async function requireTrustedPricingSnapshot(
  transaction: PgTransactionClient,
  billing: BillingConfig,
): Promise<string> {
  const snapshotId = await findTrustedPricingSnapshot(transaction, billing);
  if (snapshotId === null) conflict("budget_pricing_unavailable");
  return snapshotId;
}

/** Non-throwing form of the pricing-snapshot predicate admission enforces. */
export async function findTrustedPricingSnapshot(
  transaction: PgTransactionClient,
  billing: BillingConfig,
): Promise<string | null> {
  const result = await transaction.query<{ id: string }>(
    `select id
       from bakery.provider_pricing_snapshots
      where provider = $1
        and billing_account_id = $2
        and model = $3
        and billing_type = $4
        and pricing_metadata_snapshot = $5
        and status = 'active'
        and effective_from <= clock_timestamp()
        and (effective_until is null or effective_until > clock_timestamp())
      order by effective_from desc, id desc
      limit 1`,
    [
      billing.provider,
      billing.billingAccountId,
      billing.model,
      billing.billingRoute,
      billing.pricingMetadataSnapshot,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * True when the action runs a model. The action registry is the one source of
 * truth for this, the same one the workflow compiler reads to decide which
 * steps may select an agent version, so the budget and the executor can never
 * disagree with it. An unregistered action is refused, not assumed free.
 */
export function isModelAction(action: string): boolean {
  if (!Object.hasOwn(WORKFLOW_ACTION_METADATA, action)) {
    throw new Error(`unsupported workflow action: ${action}`);
  }
  return WORKFLOW_ACTION_METADATA[action as WorkflowActionName].capabilities
    .includes("model");
}

function requirePolicy(policy: BudgetPolicy | undefined): BudgetPolicy {
  if (!policy) conflict("budget_policy_unavailable");
  parseMicroUsd(policy.installationMonthlyLimitUsd, "installation_limit");
  if (
    !Number.isSafeInteger(policy.reservationTtlSeconds) ||
    policy.reservationTtlSeconds < 1 ||
    !Number.isSafeInteger(policy.maxRunDurationSeconds) ||
    policy.maxRunDurationSeconds < 1
  ) conflict("budget_policy_invalid");
  return policy;
}

/** Non-throwing form of the budget-policy check admission enforces. */
export function budgetPolicyUsable(policy: BudgetPolicy | undefined): boolean {
  try {
    requirePolicy(policy);
    return true;
  } catch {
    return false;
  }
}

async function account(
  transaction: PgTransactionClient,
  options: Readonly<{
    scope: "installation" | "run";
    organizationId: string | null;
    runId: string | null;
    periodStart: Date | string;
    periodEnd: Date | string;
    limitUsd: string;
  }>,
): Promise<AccountRow> {
  await transaction.query(
    `insert into bakery.budget_accounts (
       id, organization_id, scope, run_id, period_start, period_end,
       limit_usd, reserved_usd, settled_usd, version
     ) values (
       gen_random_uuid(), $1, $2, $3, $4, $5, $6, 0, 0, 1
     )
     on conflict (scope, organization_id, run_id, period_start) do nothing`,
    [
      options.organizationId,
      options.scope,
      options.runId,
      options.periodStart,
      options.periodEnd,
      options.limitUsd,
    ],
  );
  const result = await transaction.query<AccountRow>(
    `select id, scope, run_id as "runId", period_start as "periodStart",
            period_end as "periodEnd", limit_usd as "limitUsd",
            reserved_usd as "reservedUsd", settled_usd as "settledUsd"
       from bakery.budget_accounts
      where scope = $1
        and organization_id is not distinct from $2
        and run_id is not distinct from $3
        and period_start = $4
      for update`,
    [
      options.scope,
      options.organizationId,
      options.runId,
      options.periodStart,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("BUDGET_ACCOUNT_MISSING");
  return row;
}

async function installationPeriod(
  transaction: PgTransactionClient,
): Promise<{ periodStart: Date; periodEnd: Date }> {
  const result = await transaction.query<{
    periodStart: Date;
    periodEnd: Date;
  }>(`
    select date_trunc('month', clock_timestamp() at time zone 'UTC')
             at time zone 'UTC' as "periodStart",
           (
             date_trunc('month', clock_timestamp() at time zone 'UTC') +
             interval '1 month'
           ) at time zone 'UTC' as "periodEnd"
  `);
  const row = result.rows[0];
  if (!row) throw new Error("BUDGET_INSTALLATION_PERIOD_MISSING");
  return row;
}

async function loadRun(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<{ createdAt: Date; limitUsd: string }> {
  const result = await transaction.query<{
    createdAt: Date;
    limitUsd: string;
  }>(
    `select created_at as "createdAt", budget_limit_usd as "limitUsd"
       from bakery.workflow_runs
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, runId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  parseMicroUsd(row.limitUsd, "run_limit");
  return row;
}

async function loadReservations(
  transaction: PgTransactionClient,
  intent: IntentRow,
): Promise<{ installation: ReservationRow; run: ReservationRow }> {
  if (!intent.installationReservationId || !intent.runReservationId) {
    conflict("budget_reservations_missing");
  }
  const result = await transaction.query<ReservationRow>(
    `select id, budget_account_id as "budgetAccountId",
            reserved_usd as "reservedUsd", settled_usd as "settledUsd", status
       from bakery.budget_reservations
      where organization_id = $1 and id = any($2::uuid[])`,
    [intent.organizationId, [
      intent.installationReservationId,
      intent.runReservationId,
    ]],
  );
  const byId = new Map<string, ReservationRow>(
    result.rows.map((row: ReservationRow) => [row.id, row]),
  );
  const installation = byId.get(intent.installationReservationId);
  const run = byId.get(intent.runReservationId);
  if (!installation || !run) conflict("budget_reservations_missing");
  return {
    installation: installation as ReservationRow,
    run: run as ReservationRow,
  };
}

async function lockReservations(
  transaction: PgTransactionClient,
  organizationId: string,
  ids: readonly string[],
): Promise<void> {
  const result = await transaction.query<ReservationRow>(
    `select id, budget_account_id as "budgetAccountId",
            reserved_usd as "reservedUsd", settled_usd as "settledUsd", status
       from bakery.budget_reservations
      where organization_id = $1 and id = any($2::uuid[])
      order by id
      for update`,
    [organizationId, ids],
  );
  if (result.rows.length !== ids.length) {
    conflict("budget_reservations_missing");
  }
}
async function lockAccounts(
  transaction: PgTransactionClient,
  ids: readonly string[],
): Promise<void> {
  const result = await transaction.query<{ id: string; scope: string }>(
    `select id, scope
       from bakery.budget_accounts
      where id = any($1::uuid[])
      order by case when scope = 'installation' then 0 else 1 end, id
      for update`,
    [ids],
  );
  if (result.rows.length !== ids.length) conflict("budget_accounts_missing");
}

function normalizeReceipt(receipt: ParsedUsageReceipt): UsageReceipt {
  const inputTokens = receipt.inputTokens ?? null;
  const outputTokens = receipt.outputTokens ?? null;
  const costUsd = receipt.costUsd ?? null;
  if (!receipt.usageFactId.trim()) conflict("usage_fact_identity_missing");
  if (!receipt.providerCallId.trim()) {
    conflict("provider_call_identity_missing");
  }
  if (!receipt.provider.trim() || !receipt.billingAccountId.trim()) {
    conflict("usage_identity_missing");
  }
  if (!receipt.model.trim() || !receipt.pricingMetadataSnapshot.trim()) {
    conflict("usage_policy_snapshot_missing");
  }
  if (receipt.measurement === "unknown" && costUsd !== null) {
    conflict("unknown_cost_must_be_null");
  }
  if (
    inputTokens !== null &&
    !/^(?:0|[1-9][0-9]*)$/.test(inputTokens)
  ) {
    conflict("input_tokens_invalid");
  }
  if (
    outputTokens !== null &&
    !/^(?:0|[1-9][0-9]*)$/.test(outputTokens)
  ) {
    conflict("output_tokens_invalid");
  }
  return {
    ...receipt,
    inputTokens,
    outputTokens,
    costUsd: costUsd === null
      ? null
      : formatMicroUsd(parseMicroUsd(costUsd, "usage_cost")),
    occurredAt: iso(receipt.occurredAt),
  };
}

function databaseText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function sameReceipt(
  left: Record<string, unknown>,
  right: UsageReceipt,
): boolean {
  const leftCost = left.cost_usd === null
    ? null
    : formatMicroUsd(parseMicroUsd(left.cost_usd, "stored_usage_cost"));
  return left.usage_fact_id === right.usageFactId &&
    left.provider_call_id === right.providerCallId &&
    left.provider === right.provider &&
    left.billing_account_id === right.billingAccountId &&
    left.model === right.model &&
    left.billing_route === right.billingRoute &&
    left.pricing_metadata_snapshot === right.pricingMetadataSnapshot &&
    databaseText(left.input_tokens) === right.inputTokens &&
    databaseText(left.output_tokens) === right.outputTokens &&
    leftCost === right.costUsd &&
    left.measurement === right.measurement &&
    iso(left.occurred_at as Date | string) === right.occurredAt;
}

/**
 * Shared coordination ceiling. A run that belongs to a coordination lane, or
 * that executes the plan's parent task itself, draws on the plan's
 * `budget_limit_usd`, summed over the held and settled spend of the parent
 * run and of every child run of the parent task's plan revisions. One
 * parent-level row, the parent task, is locked for every reservation under
 * any revision, so reservations from older and newer revisions serialize.
 * Lock order (see coordination-command.ts lockCoordinationScope): the engine
 * already holds job, step, run and child task; the parent task comes after
 * them. Replays return before they add anything, so a retry never multiplies
 * the ceiling.
 */
async function lockPlanBudget(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
): Promise<{ planId: string; limit: bigint } | null> {
  const plan = await transaction.query<
    { id: string; parent_task_id: string; limit: string | null }
  >(
    `select p.id, p.parent_task_id, p.budget_limit_usd::text as "limit"
       from bakery.workflow_runs r
       left join bakery.coordination_lanes l
         on l.organization_id = r.organization_id
        and l.child_task_id = r.task_id
       join bakery.coordination_plans p
         on p.organization_id = r.organization_id
        and (p.id = l.plan_id or p.parent_task_id = r.task_id)
      where r.organization_id = $1 and r.id = $2
      order by p.revision desc
      limit 1`,
    [organizationId, runId],
  );
  const row = plan.rows[0];
  if (!row || row.limit === null) return null;
  // Plan specs and ceilings are insert-only, so the limit read above is stable.
  await transaction.query(
    `select id from bakery.tasks
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, row.parent_task_id],
  );
  return { planId: row.id, limit: parseMicroUsd(row.limit, "plan_limit") };
}

/**
 * Settlement runs inside the worker result transaction, which then finalizes
 * the step, run and task and reconciles the coordination plan (parent task).
 * Reservation takes step, run, child task, parent task and only then the
 * budget accounts (lockPlanBudget), so settlement takes the same rows in the
 * same order before it touches an account. Otherwise a lane's terminal result
 * holding the shared installation account and a sibling lane's reservation
 * holding the parent task wait on each other.
 *
 * BUDGET LOCK ORDER (extends LOCK ORDER in coordination-command.ts
 * lockCoordinationScope; every reserve, settle, reconcile and release path):
 *   job -> run step -> run -> child task -> plan parent tasks (id asc)
 *   -> budget accounts (installation first, then id asc)
 *   -> budget reservations (id asc) -> usage records.
 * An action intent belongs to one run step, so its lock is ordered by the
 * step lock taken before it: settle and reconcile take it after the task
 * scope, reservation re-reads it after the accounts. settleWorkflowAction
 * takes the task scope first, so the result route (host, attempt, job already
 * held) follows the order. The budget recovery cron
 * (reconcileProviderUsageReceipt, nothing held) locks the intent's scope
 * itself, checks the usage row against it, and settles through
 * settleWithinLockedScope, which takes no scope lock. Release locks the failed job, the intent and
 * its provider call, then the accounts; never a step, run or task.
 */
async function lockSettlementScope(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
  runStepId: string,
): Promise<void> {
  await transaction.query(
    `select id from bakery.run_steps
      where organization_id = $1 and id = $2 and run_id = $3
      for update`,
    [organizationId, runStepId, runId],
  );
  const run = await transaction.query<{ task_id: string }>(
    `select task_id from bakery.workflow_runs
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, runId],
  );
  const taskId = run.rows[0]?.task_id;
  if (!taskId) return;
  await transaction.query(
    `select id from bakery.tasks
      where organization_id = $1 and id = $2
      for update`,
    [organizationId, taskId],
  );
  await transaction.query(
    `select id from bakery.tasks
      where organization_id = $1
        and id in (
          select p.parent_task_id
            from bakery.coordination_lanes l
            join bakery.coordination_plans p
              on p.organization_id = l.organization_id and p.id = l.plan_id
           where l.organization_id = $1 and l.child_task_id = $2
        )
      order by id
      for update`,
    [organizationId, taskId],
  );
}

async function assertPlanBudget(
  transaction: PgTransactionClient,
  organizationId: string,
  plan: { planId: string; limit: bigint },
  amount: bigint,
): Promise<void> {
  const spent = await transaction.query<{ total: string }>(
    `select coalesce(sum(a.reserved_usd + a.settled_usd), 0)::text as total
       from bakery.budget_accounts a
      where a.scope = 'run' and a.organization_id = $1
        and a.run_id in (
          select r.id
            from bakery.coordination_plans anchor
            join bakery.coordination_plans p
              on p.organization_id = anchor.organization_id
             and p.parent_task_id = anchor.parent_task_id
            join bakery.coordination_lanes l
              on l.organization_id = p.organization_id and l.plan_id = p.id
            join bakery.workflow_runs r
              on r.organization_id = l.organization_id
             and r.task_id = l.child_task_id
           where anchor.organization_id = $1 and anchor.id = $2
          union
          select pr.id
            from bakery.coordination_plans anchor
            join bakery.workflow_runs pr
              on pr.organization_id = anchor.organization_id
             and pr.task_id = anchor.parent_task_id
           where anchor.organization_id = $1 and anchor.id = $2
        )`,
    [organizationId, plan.planId],
  );
  const held = parseMicroUsd(spent.rows[0]?.total ?? "0", "plan_spent");
  if (held + amount > plan.limit) conflict("plan_budget_cap_exceeded");
}

export async function reserveWorkflowAction(
  transaction: PgTransactionClient,
  options: WorkflowBudgetReservationInput,
): Promise<WorkflowBudgetReservation | null> {
  if (!isModelAction(options.action)) return null;
  const policy = requirePolicy(options.policy);
  if (!options.agentVersionId?.trim()) conflict("agent_version_missing");
  const billing = billingConfig(options.billing);
  const pricingSnapshotId = await requireTrustedPricingSnapshot(
    transaction,
    billing,
  );
  if (!SHA256.test(options.contentDigest)) {
    conflict("budget_content_digest_invalid");
  }
  const amount = parseMicroUsd(
    billing.maxUsdReservation,
    "max_usd_reservation",
  );
  const amountText = formatMicroUsd(amount);
  const planBudget = await lockPlanBudget(
    transaction,
    options.organizationId,
    options.runId,
  );
  const period = await installationPeriod(transaction);
  const installation = await account(transaction, {
    scope: "installation",
    organizationId: null,
    runId: null,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    limitUsd: policy.installationMonthlyLimitUsd,
  });
  const run = await loadRun(transaction, options.organizationId, options.runId);
  const runAccount = await account(transaction, {
    scope: "run",
    organizationId: options.organizationId,
    runId: options.runId,
    periodStart: run.createdAt,
    periodEnd: new Date(
      run.createdAt.getTime() + policy.maxRunDurationSeconds * 1_000,
    ),
    limitUsd: run.limitUsd,
  });
  const dedupeKey = `workflow:${options.runStepId}:${options.action}`;
  const existing = await transaction.query<IntentRow>(
    `select id, organization_id as "organizationId", run_id as "runId",
            run_step_id as "runStepId", action, action_version as "actionVersion",
            agent_version_id as "agentVersionId", provider,
            billing_account_id as "billingAccountId", model,
            billing_route as "billingRoute",
            pricing_metadata_snapshot as "pricingMetadataSnapshot",
            reserved_usd as "reservedUsd", content_digest as "contentDigest",
            dedupe_key as "dedupeKey", status,
            installation_reservation_id as "installationReservationId",
            run_reservation_id as "runReservationId",
            provider_call_intent_id as "providerCallIntentId"
       from bakery.budget_action_intents
      where organization_id = $1 and dedupe_key = $2
      for update`,
    [options.organizationId, dedupeKey],
  );
  const current = existing.rows[0];
  if (current) {
    if (
      current.runId !== options.runId ||
      current.runStepId !== options.runStepId ||
      current.action !== options.action ||
      current.actionVersion !== options.actionVersion ||
      current.agentVersionId !== options.agentVersionId ||
      current.provider !== billing.provider ||
      current.billingAccountId !== billing.billingAccountId ||
      current.model !== billing.model ||
      current.billingRoute !== billing.billingRoute ||
      current.pricingMetadataSnapshot !== billing.pricingMetadataSnapshot ||
      current.contentDigest !== options.contentDigest ||
      parseMicroUsd(current.reservedUsd, "stored_reserved_usd") !== amount
    ) conflict("budget_replay_content_mismatch");
    if (
      !current.installationReservationId || !current.runReservationId ||
      !current.providerCallIntentId
    ) {
      conflict("budget_replay_reservations_missing");
    }
    return {
      intentId: current.id,
      installationReservationId: current.installationReservationId,
      runReservationId: current.runReservationId,
      providerCallIntentId: current.providerCallIntentId,
    };
  }
  if (planBudget) {
    await assertPlanBudget(
      transaction,
      options.organizationId,
      planBudget,
      amount,
    );
  }
  const intentId = crypto.randomUUID();
  const providerCallIntentId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.budget_action_intents (
       id, organization_id, run_id, run_step_id, action, action_version,
       agent_version_id, provider, billing_account_id, model, billing_route,
       pricing_metadata_snapshot, reserved_usd, content_digest, dedupe_key,
       status
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, 'held')`,
    [
      intentId,
      options.organizationId,
      options.runId,
      options.runStepId,
      options.action,
      options.actionVersion,
      options.agentVersionId,
      billing.provider,
      billing.billingAccountId,
      billing.model,
      billing.billingRoute,
      billing.pricingMetadataSnapshot,
      amountText,
      options.contentDigest,
      dedupeKey,
    ],
  );
  const installationReservationId = crypto.randomUUID();
  const runReservationId = crypto.randomUUID();
  for (
    const [id, budgetAccountId] of [
      [installationReservationId, installation.id],
      [runReservationId, runAccount.id],
    ] as const
  ) {
    await transaction.query(
      `insert into bakery.budget_reservations (
         id, organization_id, budget_account_id, run_step_id, dedupe_key,
         reserved_usd, settled_usd, status, expires_at, version
       ) values ($1, $2, $3, $4, $5, $6, null, 'held',
                 now() + ($7::integer * interval '1 second'), 1)`,
      [
        id,
        options.organizationId,
        budgetAccountId,
        options.runStepId,
        dedupeKey,
        amountText,
        policy.reservationTtlSeconds,
      ],
    );
    const updated = await transaction.query(
      `update bakery.budget_accounts
          set reserved_usd = reserved_usd + $2::numeric,
              updated_at = now(), version = version + 1
        where id = $1
          and reserved_usd + settled_usd + $2::numeric <= limit_usd
        returning id`,
      [budgetAccountId, amountText],
    );
    if (!updated.rows[0]) conflict("budget_cap_exceeded");
  }
  await transaction.query(
    `insert into bakery.provider_call_intents (
       id, organization_id, run_id, run_step_id,
       installation_reservation_id, provider, billing_account_id, model,
       billing_type, pricing_snapshot_id, pricing_metadata_snapshot, max_tokens,
       max_usd_reservation, status, version
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               'pending', 1)`,
    [
      providerCallIntentId,
      options.organizationId,
      options.runId,
      options.runStepId,
      installationReservationId,
      billing.provider,
      billing.billingAccountId,
      billing.model,
      billing.billingRoute,
      pricingSnapshotId,
      billing.pricingMetadataSnapshot,
      billing.maxTokens,
      amountText,
    ],
  );
  await transaction.query(
    `update bakery.budget_action_intents
        set installation_reservation_id = $2,
            run_reservation_id = $3,
            provider_call_intent_id = $4,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $5`,
    [
      options.organizationId,
      installationReservationId,
      runReservationId,
      providerCallIntentId,
      intentId,
    ],
  );
  return {
    intentId,
    installationReservationId,
    runReservationId,
    providerCallIntentId,
  };
}

export const COORDINATOR_TURN_DEDUPE_PREFIX = "coordinator-turn:";

export function coordinatorTurnDedupeKey(turnId: string): string {
  return `${COORDINATOR_TURN_DEDUPE_PREFIX}${turnId}`;
}

export type CoordinatorTurnReservation = Readonly<{
  reservationId: string;
  reservedUsd: string;
}>;

type CoordinatorReservationRow = Readonly<{
  id: string;
  budgetAccountId: string;
  reservedUsd: string;
  status: "held" | "settled" | "released";
}>;

/**
 * Funds one coordinator turn without a run: a single reservation on the
 * installation account, no run step, no usage receipt (subscription route
 * only). Replay of the same turn returns the existing held reservation.
 */
export async function reserveCoordinatorTurn(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    turnId: string;
    agentVersionId: string | null;
    billing: unknown;
    policy: BudgetPolicy | undefined;
  }>,
): Promise<CoordinatorTurnReservation> {
  if (!options.agentVersionId?.trim()) conflict("agent_version_missing");
  const billing = billingConfig(options.billing);
  if (billing.billingRoute !== "subscription") {
    conflict("coordinator_billing_unsupported");
  }
  if (!options.policy) conflict("coordinator_budget_unconfigured");
  const policy = requirePolicy(options.policy);
  await requireTrustedPricingSnapshot(transaction, billing);
  const amount = parseMicroUsd(
    billing.maxUsdReservation,
    "max_usd_reservation",
  );
  const amountText = formatMicroUsd(amount);
  const period = await installationPeriod(transaction);
  const installation = await account(transaction, {
    scope: "installation",
    organizationId: null,
    runId: null,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    limitUsd: policy.installationMonthlyLimitUsd,
  });
  const dedupeKey = coordinatorTurnDedupeKey(options.turnId);
  const existing = await transaction.query<
    CoordinatorReservationRow & { organizationId: string }
  >(
    `select id, organization_id as "organizationId",
            budget_account_id as "budgetAccountId",
            reserved_usd::text as "reservedUsd", status
       from bakery.budget_reservations
      where budget_account_id = $1 and dedupe_key = $2
      for update`,
    [installation.id, dedupeKey],
  );
  const current = existing.rows[0];
  if (current) {
    if (
      current.organizationId !== options.organizationId ||
      parseMicroUsd(current.reservedUsd, "stored_reserved_usd") !== amount
    ) conflict("budget_replay_content_mismatch");
    if (current.status !== "held") conflict("budget_reservation_not_held");
    return { reservationId: current.id, reservedUsd: amountText };
  }
  const reservationId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.budget_reservations (
       id, organization_id, budget_account_id, run_step_id, dedupe_key,
       reserved_usd, settled_usd, status, expires_at, version
     ) values ($1, $2, $3, null, $4, $5, null, 'held',
               now() + ($6::integer * interval '1 second'), 1)`,
    [
      reservationId,
      options.organizationId,
      installation.id,
      dedupeKey,
      amountText,
      policy.reservationTtlSeconds,
    ],
  );
  const updated = await transaction.query(
    `update bakery.budget_accounts
        set reserved_usd = reserved_usd + $2::numeric,
            updated_at = now(), version = version + 1
      where id = $1
        and reserved_usd + settled_usd + $2::numeric <= limit_usd
      returning id`,
    [installation.id, amountText],
  );
  if (!updated.rows[0]) conflict("budget_cap_exceeded");
  return { reservationId, reservedUsd: amountText };
}

async function loadIntent(
  transaction: PgTransactionClient,
  organizationId: string,
  installationReservationId: string,
): Promise<IntentRow> {
  const result = await transaction.query<IntentRow>(
    `select intent.id, intent.organization_id as "organizationId",
            intent.run_id as "runId", intent.run_step_id as "runStepId",
            intent.action, intent.action_version as "actionVersion",
            intent.agent_version_id as "agentVersionId", intent.provider,
            intent.billing_account_id as "billingAccountId", intent.model,
            intent.billing_route as "billingRoute",
            intent.pricing_metadata_snapshot as "pricingMetadataSnapshot",
            intent.reserved_usd as "reservedUsd",
            intent.content_digest as "contentDigest", intent.dedupe_key as "dedupeKey",
            intent.status,
            intent.installation_reservation_id as "installationReservationId",
            intent.run_reservation_id as "runReservationId",
            intent.provider_call_intent_id as "providerCallIntentId"
       from bakery.budget_action_intents intent
      where intent.organization_id = $1
        and intent.installation_reservation_id = $2
      for update`,
    [organizationId, installationReservationId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

async function requireBoundProviderEvidence(
  transaction: PgTransactionClient,
  organizationId: string,
  intent: IntentRow,
  receipt: UsageReceipt,
): Promise<void> {
  if (!intent.providerCallIntentId) conflict("provider_call_intent_missing");
  const result = await transaction.query<{
    providerCallId: string | null;
    provider: string;
    billingAccountId: string;
    model: string;
    billingRoute: "api" | "subscription";
    pricingMetadataSnapshot: string;
    receiptUsageFactId: string | null;
    receiptProviderCallId: string | null;
    inputTokens: string | number | null;
    outputTokens: string | number | null;
    costUsd: string | null;
    measurement: "reported" | "estimated" | null;
    occurredAt: Date | string | null;
  }>(
    `select call.provider_call_id as "providerCallId",
            call.provider, call.billing_account_id as "billingAccountId",
            call.model, call.billing_type as "billingRoute",
            call.pricing_metadata_snapshot as "pricingMetadataSnapshot",
            receipt.usage_fact_id as "receiptUsageFactId",
            receipt.provider_call_id as "receiptProviderCallId",
            receipt.input_tokens as "inputTokens",
            receipt.output_tokens as "outputTokens",
            receipt.cost_usd as "costUsd",
            receipt.measurement, receipt.occurred_at as "occurredAt"
       from bakery.provider_call_intents call
       left join bakery.provider_authoritative_receipts receipt
         on receipt.organization_id = call.organization_id
        and receipt.provider_call_intent_id = call.id
      where call.organization_id = $1 and call.id = $2`,
    [organizationId, intent.providerCallIntentId],
  );
  const row = result.rows[0];
  if (!row || row.providerCallId !== receipt.providerCallId) {
    conflict("provider_call_unbound");
  }
  if (receipt.measurement === "unknown") return;
  if (receipt.costUsd === null) conflict("provider_receipt_cost_missing");
  if (
    row.receiptUsageFactId === null ||
    row.receiptProviderCallId !== receipt.providerCallId ||
    row.measurement === null ||
    row.occurredAt === null
  ) conflict("provider_receipt_unavailable");
  const authoritativeCost = row.costUsd === null
    ? null
    : formatMicroUsd(parseMicroUsd(row.costUsd, "provider_receipt_cost"));
  if (
    row.provider !== receipt.provider ||
    row.billingAccountId !== receipt.billingAccountId ||
    row.model !== receipt.model ||
    row.billingRoute !== receipt.billingRoute ||
    row.pricingMetadataSnapshot !== receipt.pricingMetadataSnapshot ||
    row.receiptUsageFactId !== receipt.usageFactId ||
    databaseText(row.inputTokens) !== receipt.inputTokens ||
    databaseText(row.outputTokens) !== receipt.outputTokens ||
    authoritativeCost !== receipt.costUsd ||
    row.measurement !== receipt.measurement ||
    iso(row.occurredAt) !== receipt.occurredAt
  ) conflict("provider_receipt_mismatch");
}

export async function bindProviderCallIntent(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    installationReservationId: string;
    providerCallId: string;
  }>,
): Promise<string> {
  if (
    !options.organizationId.trim() ||
    !options.installationReservationId.trim() ||
    !options.providerCallId.trim() ||
    options.providerCallId.length > 255
  ) conflict("provider_call_identity_invalid");
  const intent = await loadIntent(
    transaction,
    options.organizationId,
    options.installationReservationId,
  );
  if (intent.status !== "held") conflict("budget_reservation_not_held");
  const result = await transaction.query<{ id: string }>(
    `update bakery.provider_call_intents call
        set provider_call_id = $3,
            status = 'bound',
            updated_at = now(), version = version + 1
      where call.organization_id = $1
        and call.installation_reservation_id = $2
        and call.id = $4
        and call.run_id = $5 and call.run_step_id = $6
        and call.status in ('pending', 'bound')
        and (call.provider_call_id is null or call.provider_call_id = $3)
      returning call.id`,
    [
      options.organizationId,
      options.installationReservationId,
      options.providerCallId,
      intent.providerCallIntentId,
      intent.runId,
      intent.runStepId,
    ],
  );
  const row = result.rows[0];
  if (!row) conflict("provider_call_bind_conflict");
  return row.id;
}

/**
 * Trusted authoritative-receipt writer: the only production path that
 * persists `provider_authoritative_receipts` (the runtime role has no direct
 * table insert; migration 0064). The definer function validates that the
 * call intent is bound to the same provider-call identity before storing.
 * Receipts are immutable; an identical receipt replays as itself.
 */
export async function recordProviderUsageReceipt(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    providerCallIntentId: string;
    receipt: UsageReceipt;
  }>,
): Promise<string> {
  if (options.receipt.measurement === "unknown") {
    conflict("provider_receipt_measurement_invalid");
  }
  if (options.receipt.costUsd === null) {
    conflict("provider_receipt_cost_missing");
  }
  const receiptDigest = await sha256Hex(
    canonicalJson(options.receipt),
  );
  const result = await transaction.query<{ id: string }>(
    `select bakery.record_provider_usage_receipt(
       $1::uuid, $2::uuid, $3, $4,
       $5::bigint, $6::bigint, $7::numeric, $8,
       $9::timestamptz, $10
     ) as id`,
    [
      options.organizationId,
      options.providerCallIntentId,
      options.receipt.providerCallId,
      options.receipt.usageFactId,
      options.receipt.inputTokens === null
        ? null
        : BigInt(options.receipt.inputTokens),
      options.receipt.outputTokens === null
        ? null
        : BigInt(options.receipt.outputTokens),
      options.receipt.costUsd,
      options.receipt.measurement,
      options.receipt.occurredAt,
      receiptDigest,
    ],
  );
  return String(result.rows[0].id);
}

export async function settleWorkflowAction(
  transaction: PgTransactionClient,
  options: SettleWorkflowBudgetInput,
): Promise<
  {
    usageRecordId: string;
    usageFactId: string;
    canonicalDigest: string;
    measurement: UsageReceipt["measurement"];
  }
> {
  // Canonical settlement order (see lockSettlementScope): task scope, then
  // the intent, then accounts. Callers that already hold the scope re-enter.
  await lockSettlementScope(
    transaction,
    options.organizationId,
    options.runId,
    options.runStepId,
  );
  return await settleWithinLockedScope(transaction, options);
}

/**
 * Settlement body for a caller that already holds the settlement scope of
 * `options.runId`/`options.runStepId` (lockSettlementScope). It takes no step,
 * run or task lock, so it never re-locks the scope under the account locks.
 *
 * `holdForLiveEffects` is true only for budget recovery (a receipt settled
 * without the worker): a live external effect then pins both reservations. The
 * worker's own terminal result passes false, so an effect that stays uncertain
 * never refuses the job's result.
 */
async function settleWithinLockedScope(
  transaction: PgTransactionClient,
  options: SettleWorkflowBudgetInput,
  holdForLiveEffects = false,
): Promise<
  {
    usageRecordId: string;
    usageFactId: string;
    canonicalDigest: string;
    measurement: UsageReceipt["measurement"];
  }
> {
  const intent = await loadIntent(
    transaction,
    options.organizationId,
    options.installationReservationId,
  );
  if (
    intent.runId !== options.runId ||
    intent.runStepId !== options.runStepId
  ) conflict("usage_execution_mismatch");
  const receipt = normalizeReceipt(options.receipt);
  if (
    receipt.provider !== intent.provider ||
    receipt.billingAccountId !== intent.billingAccountId ||
    receipt.model !== intent.model ||
    receipt.billingRoute !== intent.billingRoute ||
    receipt.pricingMetadataSnapshot !== intent.pricingMetadataSnapshot
  ) conflict("usage_identity_mismatch");
  await requireBoundProviderEvidence(
    transaction,
    options.organizationId,
    intent,
    receipt,
  );
  if (
    !options.workerHostId.trim() || !options.workerSessionId.trim() ||
    !options.workerSessionGeneration.trim() || !options.fence.trim() ||
    !options.resultEventId.trim()
  ) conflict("usage_authority_missing");
  const authority = await transaction.query<{
    id: string;
    workerHostId: string;
    workerSessionId: string;
    workerSessionGeneration: string | number;
    fence: string | number;
    runStepId: string;
    installationReservationId: string | null;
  }>(
    `select attempt.id, attempt.worker_host_id as "workerHostId",
            attempt.worker_session_id as "workerSessionId",
            attempt.worker_session_generation as "workerSessionGeneration",
            attempt.fence, job.run_step_id as "runStepId",
            job.installation_reservation_id as "installationReservationId"
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id and job.id = attempt.job_id
      where attempt.organization_id = $1 and attempt.id = $2`,
    [options.organizationId, options.attemptId],
  );
  const authorityRow = authority.rows[0];
  if (
    !authorityRow ||
    authorityRow.runStepId !== options.runStepId ||
    authorityRow.installationReservationId !==
      options.installationReservationId ||
    authorityRow.workerHostId !== options.workerHostId ||
    authorityRow.workerSessionId !== options.workerSessionId ||
    BigInt(authorityRow.workerSessionGeneration) !==
      BigInt(options.workerSessionGeneration) ||
    BigInt(authorityRow.fence) !== BigInt(options.fence)
  ) conflict("usage_attempt_mismatch");
  if (holdForLiveEffects) {
    await assertReservationsFreeOfLiveEffects(
      transaction,
      options.organizationId,
      [intent.installationReservationId, intent.runReservationId],
    );
  }
  const reservations = await loadReservations(transaction, intent);
  await lockAccounts(transaction, [
    reservations.installation.budgetAccountId,
    reservations.run.budgetAccountId,
  ]);
  await lockReservations(transaction, options.organizationId, [
    reservations.installation.id,
    reservations.run.id,
  ]);
  const existing = await transaction.query<Record<string, unknown>>(
    `select id, usage_fact_id, canonical_digest,
            reconciled_canonical_digest, provider_call_id, provider,
            billing_account_id, model, billing_type as billing_route,
            pricing_metadata_snapshot, input_tokens, output_tokens, cost_usd,
            measurement, provenance, occurred_at, run_id, run_step_id, attempt_id,
            worker_host_id, worker_session_id, worker_session_generation, fence,
            result_event_id, budget_reservation_id
       from bakery.usage_records
      where organization_id = $1
        and (
          (provider = $2 and billing_account_id = $3 and provider_call_id = $4)
          or usage_fact_id = $5
        )
      for update`,
    [
      options.organizationId,
      receipt.provider,
      receipt.billingAccountId,
      receipt.providerCallId,
      receipt.usageFactId,
    ],
  );
  if (existing.rows.length > 1) conflict("usage_identity_reused");
  const prior = existing.rows[0];
  const canonicalDigest = await budgetContentDigest({
    usageFactId: receipt.usageFactId,
    providerCallId: receipt.providerCallId,
    provider: receipt.provider,
    billingAccountId: receipt.billingAccountId,
    model: receipt.model,
    billingRoute: receipt.billingRoute,
    pricingMetadataSnapshot: receipt.pricingMetadataSnapshot,
    inputTokens: receipt.inputTokens,
    outputTokens: receipt.outputTokens,
    costUsd: receipt.costUsd,
    measurement: receipt.measurement,
    occurredAt: receipt.occurredAt,
    organizationId: options.organizationId,
    runId: options.runId,
    runStepId: options.runStepId,
    attemptId: options.attemptId,
    workerHostId: options.workerHostId,
    workerSessionId: options.workerSessionId,
    workerSessionGeneration: options.workerSessionGeneration,
    fence: options.fence,
    installationReservationId: options.installationReservationId,
    resultEventId: String(prior?.result_event_id ?? options.resultEventId),
  });
  const isUnknown = receipt.measurement === "unknown";
  let usageRecordId: string;
  if (prior) {
    usageRecordId = String(prior.id);
    const immutableIdentityMatches =
      prior.usage_fact_id === receipt.usageFactId &&
      prior.provider_call_id === receipt.providerCallId &&
      prior.provider === receipt.provider &&
      prior.billing_account_id === receipt.billingAccountId &&
      prior.model === receipt.model &&
      prior.billing_route === receipt.billingRoute &&
      prior.pricing_metadata_snapshot === receipt.pricingMetadataSnapshot;
    const authorityMatches = prior.run_id === options.runId &&
      prior.run_step_id === options.runStepId &&
      prior.attempt_id === options.attemptId &&
      prior.worker_host_id === options.workerHostId &&
      prior.worker_session_id === options.workerSessionId &&
      BigInt(prior.worker_session_generation as string | number) ===
        BigInt(options.workerSessionGeneration) &&
      BigInt(prior.fence as string | number) === BigInt(options.fence);
    const priorDigest = String(
      prior.reconciled_canonical_digest ?? prior.canonical_digest,
    );
    if (
      prior.budget_reservation_id !== intent.installationReservationId ||
      (!sameReceipt(prior, receipt) &&
        (!immutableIdentityMatches || !authorityMatches ||
          prior.measurement !== "unknown" || isUnknown)) ||
      (priorDigest !== canonicalDigest &&
        (prior.measurement !== "unknown" || isUnknown ||
          !immutableIdentityMatches || !authorityMatches))
    ) conflict("usage_replay_content_mismatch");
    if (sameReceipt(prior, receipt)) {
      if (
        receipt.measurement !== "unknown" &&
        prior.provenance !== "provider-authoritative"
      ) {
        await transaction.query(
          `update bakery.usage_records
              set provenance = 'provider-authoritative',
                  updated_at = now(), version = version + 1
            where organization_id = $1 and id = $2`,
          [options.organizationId, prior.id],
        );
      }
      return {
        usageRecordId,
        usageFactId: receipt.usageFactId,
        canonicalDigest: priorDigest,
        measurement: receipt.measurement,
      };
    }
    await transaction.query(
      `update bakery.usage_records
          set input_tokens = $2, output_tokens = $3, cost_usd = $4,
              measurement = $5, provenance = 'provider-authoritative',
              occurred_at = $6,
              reconciled_canonical_digest = $7,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $8`,
      [
        options.organizationId,
        receipt.inputTokens,
        receipt.outputTokens,
        receipt.costUsd,
        receipt.measurement,
        receipt.occurredAt,
        canonicalDigest,
        prior.id,
      ],
    );
  } else {
    usageRecordId = crypto.randomUUID();
    await transaction.query(
      `insert into bakery.usage_records (
         id, organization_id, run_id, run_step_id, attempt_id,
         worker_host_id, worker_session_id, worker_session_generation, fence,
         result_event_id, usage_fact_id, canonical_digest, provider,
         billing_account_id, model, billing_type, input_tokens, output_tokens,
         cost_usd, measurement, provider_call_id, pricing_metadata_snapshot,
         dedupe_key, occurred_at, budget_reservation_id,
         original_input_tokens, original_output_tokens, original_cost_usd,
         original_measurement, original_occurred_at, provenance,
         created_at, updated_at, version
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
         $27, $28, $29, $30, $31, now(), now(), 1
       )`,
      [
        usageRecordId,
        options.organizationId,
        options.runId,
        options.runStepId,
        options.attemptId,
        options.workerHostId,
        options.workerSessionId,
        options.workerSessionGeneration,
        options.fence,
        options.resultEventId,
        receipt.usageFactId,
        canonicalDigest,
        receipt.provider,
        receipt.billingAccountId,
        receipt.model,
        receipt.billingRoute,
        receipt.inputTokens,
        receipt.outputTokens,
        receipt.costUsd,
        receipt.measurement,
        receipt.providerCallId,
        receipt.pricingMetadataSnapshot,
        `${options.organizationId}:${receipt.provider}:${receipt.billingAccountId}:${receipt.providerCallId}`,
        receipt.occurredAt,
        intent.installationReservationId,
        receipt.inputTokens,
        receipt.outputTokens,
        receipt.costUsd,
        receipt.measurement,
        receipt.occurredAt,
        receipt.measurement === "unknown"
          ? "worker-unverified"
          : "provider-authoritative",
      ],
    );
  }
  if (isUnknown) {
    return {
      usageRecordId,
      usageFactId: receipt.usageFactId,
      canonicalDigest: prior
        ? String(prior.reconciled_canonical_digest ?? prior.canonical_digest)
        : canonicalDigest,
      measurement: receipt.measurement,
    };
  }
  if (intent.status !== "held") {
    if (intent.status === "settled") {
      conflict("usage_settlement_replay_mismatch");
    }
    conflict("budget_reservation_released");
  }
  const cost = parseMicroUsd(receipt.costUsd, "usage_cost");
  const reserved = parseMicroUsd(intent.reservedUsd, "reserved_usd");
  const costText = formatMicroUsd(cost);
  const overrunText = formatMicroUsd(cost > reserved ? cost - reserved : 0n);
  await transaction.query(
    `update bakery.usage_records
        set overrun_usd = $2::numeric,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $3`,
    [options.organizationId, overrunText, usageRecordId],
  );
  for (const reservation of [reservations.installation, reservations.run]) {
    if (reservation.status !== "held") conflict("budget_reservation_not_held");
    const updated = await transaction.query(
      `update bakery.budget_accounts
          set reserved_usd = reserved_usd - $2::numeric,
              settled_usd = settled_usd + $3::numeric,
              updated_at = now(), version = version + 1
        where id = $1 and reserved_usd >= $2::numeric
        returning id`,
      [reservation.budgetAccountId, intent.reservedUsd, costText],
    );
    if (!updated.rows[0]) conflict("budget_reservation_balance_invalid");
  }
  await transaction.query(
    `update bakery.budget_reservations
        set status = 'settled', settled_usd = $2,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = any($3::uuid[]) and status = 'held'`,
    [options.organizationId, costText, [
      reservations.installation.id,
      reservations.run.id,
    ]],
  );
  await transaction.query(
    `update bakery.budget_action_intents
        set status = 'settled', updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and status = 'held'`,
    [options.organizationId, intent.id],
  );
  await transaction.query(
    `update bakery.provider_call_intents
        set status = 'reconciled', updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and provider_call_id = $3`,
    [
      options.organizationId,
      intent.providerCallIntentId,
      receipt.providerCallId,
    ],
  );
  return {
    usageRecordId,
    usageFactId: receipt.usageFactId,
    canonicalDigest,
    measurement: receipt.measurement,
  };
}

async function assignmentRejectionEvidenceDigest(options: {
  organizationId: string;
  jobId: string;
  jobVersion: number;
  installationReservationId: string;
  effectId: string;
  sourceEventId: string;
}): Promise<string> {
  return await sha256Hex(canonicalJson([
    "budget-assignment-rejection-v1",
    "INVALID_ASSIGNMENT_PAYLOAD",
    options.organizationId,
    options.jobId,
    options.jobVersion,
    null,
    options.installationReservationId,
    options.effectId,
    options.sourceEventId,
  ]));
}

async function loadReleaseEvidence(
  transaction: PgTransactionClient,
  organizationId: string,
  installationReservationId: string,
  evidenceId: string,
): Promise<BudgetReleaseEvidence> {
  const result = await transaction.query<BudgetReleaseEvidence>(
    `select id, kind, digest,
            job_id as "jobId", job_version as "jobVersion",
            attempt_id as "attemptId", effect_id as "effectId",
            source_event_id as "sourceEventId"
       from bakery.budget_release_evidence
      where organization_id = $1
        and installation_reservation_id = $2
        and id = $3`,
    [organizationId, installationReservationId, evidenceId],
  );
  const evidence = result.rows[0];
  if (!evidence) conflict("no_spend_evidence_unavailable");
  return evidence;
}

async function validateReleaseEvidence(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    installationReservationId: string;
    evidence: BudgetReleaseEvidence;
  }>,
): Promise<void> {
  const evidence = options.evidence;
  if (
    evidence.kind !== "pre-dispatch-rejection" ||
    evidence.jobVersion === null ||
    !Number.isSafeInteger(evidence.jobVersion) || evidence.jobVersion < 1 ||
    evidence.sourceEventId === null ||
    evidence.attemptId !== null
  ) conflict("no_spend_evidence_identity_invalid");
  const job = await transaction.query<{
    jobVersion: number;
    jobStatus: string;
    installationReservationId: string | null;
    attemptCount: string;
  }>(
    `select job.version as "jobVersion", job.status as "jobStatus",
            job.installation_reservation_id as "installationReservationId",
            (
              select count(*)::text
                from bakery.job_attempts attempt
               where attempt.organization_id = job.organization_id
                 and attempt.job_id = job.id
            ) as "attemptCount"
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.budget_action_intents intent
         on intent.organization_id = job.organization_id
        and intent.run_id = step.run_id
        and intent.run_step_id = job.run_step_id
        and intent.action = job.action
        and intent.agent_version_id = job.agent_version_id
        and intent.installation_reservation_id = job.installation_reservation_id
       join bakery.audit_events audit
         on audit.organization_id = job.organization_id
        and audit.id = $4
        and audit.operation = 'workers.claim.assignment_payload_rejected'
        and audit.resource_type = 'job'
        and audit.resource_id = job.id::text
        and audit.outcome = 'denied'
        and audit.details->>'code' = 'INVALID_ASSIGNMENT_PAYLOAD'
        and audit.details->>'version' = job.version::text
      where job.organization_id = $1
        and job.id = $2
        and job.version = $3
      for update of job`,
    [
      options.organizationId,
      evidence.jobId,
      evidence.jobVersion,
      evidence.sourceEventId,
    ],
  );
  const jobRow = job.rows[0];
  if (
    !jobRow ||
    jobRow.jobStatus !== "failed" ||
    jobRow.installationReservationId !== options.installationReservationId ||
    Number(jobRow.attemptCount) !== 0
  ) conflict("no_spend_evidence_source_mismatch");
  const effectId =
    `budget-assignment-rejection:${evidence.jobId}:${evidence.jobVersion}`;
  if (evidence.effectId !== effectId) {
    conflict("no_spend_evidence_effect_mismatch");
  }
  const digest = await assignmentRejectionEvidenceDigest({
    organizationId: options.organizationId,
    jobId: evidence.jobId,
    jobVersion: evidence.jobVersion,
    installationReservationId: options.installationReservationId,
    effectId,
    sourceEventId: evidence.sourceEventId,
  });
  if (evidence.digest !== digest) conflict("no_spend_evidence_digest_mismatch");
}

export async function releaseWorkflowAction(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    installationReservationId: string;
    evidenceId: string;
  }>,
): Promise<void> {
  // Evidence is immutable. Acquire the failed job before the financial intent,
  // matching the claim-side producer and avoiding replay/release inversion.
  const persistedEvidence = await loadReleaseEvidence(
    transaction,
    options.organizationId,
    options.installationReservationId,
    options.evidenceId,
  );
  await validateReleaseEvidence(transaction, {
    organizationId: options.organizationId,
    installationReservationId: options.installationReservationId,
    evidence: persistedEvidence,
  });
  const intent = await loadIntent(
    transaction,
    options.organizationId,
    options.installationReservationId,
  );
  const providerCall = await transaction.query<{
    status: string;
    providerCallId: string | null;
  }>(
    `select call.status, call.provider_call_id as "providerCallId"
       from bakery.budget_action_intents intent
       join bakery.provider_call_intents call
         on call.organization_id = intent.organization_id
        and call.id = intent.provider_call_intent_id
        and call.run_id = intent.run_id
        and call.run_step_id = intent.run_step_id
        and call.installation_reservation_id = intent.installation_reservation_id
      where intent.organization_id = $1
        and intent.installation_reservation_id = $2
        and intent.provider_call_intent_id is not null
      for update of call`,
    [options.organizationId, options.installationReservationId],
  );
  const providerCallRow = providerCall.rows[0];
  if (
    !providerCallRow ||
    providerCallRow.status !== "pending" ||
    providerCallRow.providerCallId !== null
  ) conflict("no_spend_evidence_dispatch_ambiguous");
  if (intent.status !== "held") {
    if (intent.status === "released") return;
    conflict("budget_reservation_not_held");
  }
  await assertReservationsFreeOfLiveEffects(
    transaction,
    options.organizationId,
    [intent.installationReservationId, intent.runReservationId],
  );
  const reservations = await loadReservations(transaction, intent);
  await lockAccounts(transaction, [
    reservations.installation.budgetAccountId,
    reservations.run.budgetAccountId,
  ]);
  await lockReservations(transaction, options.organizationId, [
    reservations.installation.id,
    reservations.run.id,
  ]);
  for (const reservation of [reservations.installation, reservations.run]) {
    const updated = await transaction.query(
      `update bakery.budget_accounts
          set reserved_usd = reserved_usd - $2::numeric,
              updated_at = now(), version = version + 1
        where id = $1 and reserved_usd >= $2::numeric
        returning id`,
      [reservation.budgetAccountId, intent.reservedUsd],
    );
    if (!updated.rows[0]) conflict("budget_reservation_balance_invalid");
  }
  await transaction.query(
    `update bakery.budget_reservations
        set status = 'released', updated_at = now(), version = version + 1
      where organization_id = $1 and id = any($2::uuid[]) and status = 'held'`,
    [options.organizationId, [
      reservations.installation.id,
      reservations.run.id,
    ]],
  );
  await transaction.query(
    `update bakery.budget_action_intents
        set status = 'released', updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2 and status = 'held'`,
    [options.organizationId, intent.id],
  );
}

export async function findExpiredBudgetReleaseCandidates(
  transaction: PgTransactionClient,
  limit = 50,
): Promise<BudgetReleaseCandidate[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    conflict("budget_reconciliation_limit_invalid");
  }
  const result = await transaction.query<{
    evidenceId: string;
    organizationId: string;
    installationReservationId: string;
  }>(
    `select evidence.id as "evidenceId",
            intent.organization_id as "organizationId",
            intent.installation_reservation_id as "installationReservationId"
       from bakery.budget_action_intents intent
       join bakery.budget_reservations reservation
         on reservation.organization_id = intent.organization_id
        and reservation.id = intent.installation_reservation_id
       join bakery.budget_release_evidence evidence
         on evidence.organization_id = intent.organization_id
        and evidence.installation_reservation_id =
          intent.installation_reservation_id
      where intent.status = 'held'
        and reservation.status = 'held'
        and reservation.expires_at <= clock_timestamp()
        and evidence.job_version is not null
        and evidence.source_event_id is not null
        and evidence.attempt_id is null
        and ${
      noLiveEffectOnReservationsSql("intent.organization_id", [
        "intent.installation_reservation_id",
        "intent.run_reservation_id",
      ])
    }
        and not exists (
          select 1
            from bakery.budget_reconciliation_failures failure
           where failure.candidate_kind = 'release'
             and failure.organization_id = intent.organization_id
             and failure.candidate_id = evidence.id
        )
      order by reservation.expires_at asc, evidence.id asc
      limit $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    organizationId: row.organizationId,
    installationReservationId: row.installationReservationId,
    evidenceId: row.evidenceId,
  }));
}

export async function reconcileExpiredBudgetReservations(
  transaction: PgTransactionClient,
  limit = 50,
): Promise<number> {
  const candidates = await findExpiredBudgetReleaseCandidates(
    transaction,
    limit,
  );
  for (const candidate of candidates) {
    await releaseWorkflowAction(transaction, candidate);
  }
  return candidates.length;
}

export async function findProviderUsageReceiptCandidates(
  transaction: PgTransactionClient,
  limit = 50,
): Promise<ProviderUsageReceiptCandidate[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    conflict("budget_reconciliation_limit_invalid");
  }
  // Two candidate sources. (1) A worker-created unknown usage row with a
  // matching costed receipt: settles by promoting the unknown measurement.
  // (2) A receipt-only candidate: a bound call intent with durable attempt
  // attribution and a costed authoritative receipt, but no usage record for
  // the call at all (terminal usage publication was lost or never happened).
  // Genuinely unresolved charges — an unbound call or an unknown worker fact
  // without a receipt — never become candidates and stay reserved.
  // A live external effect pins both reservations; settling now would move
  // money under an effect that may have reached the provider.
  const liveFilter = noLiveEffectOnReservationsSql("intent.organization_id", [
    "intent.installation_reservation_id",
    "intent.run_reservation_id",
  ]);
  const result = await transaction.query<{
    organizationId: string;
    installationReservationId: string;
    usageRecordId: string | null;
    receiptId: string;
  }>(
    `select usage.organization_id as "organizationId",
            usage.budget_reservation_id as "installationReservationId",
            usage.id as "usageRecordId",
            receipt.id as "receiptId"
       from bakery.usage_records usage
       join bakery.budget_action_intents intent
         on intent.organization_id = usage.organization_id
        and intent.installation_reservation_id = usage.budget_reservation_id
       join bakery.provider_authoritative_receipts receipt
         on receipt.organization_id = usage.organization_id
        and receipt.provider_call_intent_id = intent.provider_call_intent_id
        and receipt.cost_usd is not null
      where usage.measurement = 'unknown'
        and ${liveFilter}
        and not exists (
          select 1
            from bakery.budget_reconciliation_failures failure
           where failure.candidate_kind = 'provider-receipt'
             and failure.organization_id = usage.organization_id
             and failure.candidate_id = receipt.id
        )
      union all
      select intent.organization_id as "organizationId",
             intent.installation_reservation_id as "installationReservationId",
             null as "usageRecordId",
             receipt.id as "receiptId"
        from bakery.provider_authoritative_receipts receipt
        join bakery.provider_call_intents call
          on call.organization_id = receipt.organization_id
         and call.id = receipt.provider_call_intent_id
         and call.status = 'bound'
         and call.attempt_id is not null
        join bakery.budget_action_intents intent
          on intent.organization_id = call.organization_id
         and intent.provider_call_intent_id = call.id
        join bakery.budget_reservations reservation
          on reservation.organization_id = intent.organization_id
         and reservation.id = intent.installation_reservation_id
       where receipt.cost_usd is not null
         and reservation.status = 'held'
         and ${liveFilter}
         and not exists (
           select 1
             from bakery.usage_records published
            where published.organization_id = receipt.organization_id
              and published.provider_call_id = receipt.provider_call_id
         )
         and not exists (
           select 1
             from bakery.budget_reconciliation_failures failure
            where failure.candidate_kind = 'provider-receipt'
              and failure.organization_id = receipt.organization_id
              and failure.candidate_id = receipt.id
         )
      order by "receiptId"
      limit $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    organizationId: row.organizationId,
    installationReservationId: row.installationReservationId,
    usageRecordId: row.usageRecordId,
    receiptId: row.receiptId,
  }));
}

export async function recordBudgetRecoveryFailure(
  transaction: PgTransactionClient,
  options: Readonly<{
    kind: BudgetRecoveryFailureKind;
    organizationId: string;
    installationReservationId: string;
    candidateId: string;
    errorCode: string;
  }>,
): Promise<void> {
  await transaction.query(
    `insert into bakery.budget_reconciliation_failures (
       candidate_kind, organization_id, installation_reservation_id,
       candidate_id, error_code, attempts, observed_at
     ) values ($1, $2, $3, $4, $5, 1, clock_timestamp())
     on conflict (candidate_kind, organization_id, candidate_id)
     do update set error_code = excluded.error_code,
                   attempts = bakery.budget_reconciliation_failures.attempts + 1,
                   observed_at = excluded.observed_at`,
    [
      options.kind,
      options.organizationId,
      options.installationReservationId,
      options.candidateId,
      options.errorCode,
    ],
  );
}

export async function clearBudgetRecoveryFailure(
  transaction: PgTransactionClient,
  options: Readonly<{
    kind: BudgetRecoveryFailureKind;
    organizationId: string;
    candidateId: string;
  }>,
): Promise<void> {
  await transaction.query(
    `delete from bakery.budget_reconciliation_failures
      where candidate_kind = $1
        and organization_id = $2
        and candidate_id = $3`,
    [options.kind, options.organizationId, options.candidateId],
  );
}

/**
 * Deterministic UUID for a receipt observation. `usage_records.result_event_id`
 * is a UUID column, and an identical receipt must reconcile to one exact
 * committed identity, so the absent worker result event is replaced by a
 * stable UUID derived from the immutable receipt row id.
 */
async function receiptObservationEventId(receiptId: string): Promise<string> {
  const digest = await sha256Hex(`receipt-observation:${receiptId}`);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${
    digest.slice(13, 16)
  }-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function reconcileProviderUsageReceipt(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    installationReservationId: string;
    /** Worker-created usage record, when one exists; null = receipt-only. */
    usageRecordId?: string | null;
    /** Durable receipt row id for receipt-only candidates. */
    receiptId?: string;
  }>,
): Promise<
  {
    usageRecordId: string;
    usageFactId: string;
    canonicalDigest: string;
    measurement: UsageReceipt["measurement"];
  } | null
> {
  // The recovery transaction holds nothing yet. Read the intent's run and
  // step without a lock (both are immutable) and take the settlement scope
  // before the intent and the accounts, the same order as reservation and
  // the result route (see lockSettlementScope).
  const target = await transaction.query<{ runId: string; runStepId: string }>(
    `select run_id as "runId", run_step_id as "runStepId"
       from bakery.budget_action_intents
      where organization_id = $1 and installation_reservation_id = $2`,
    [options.organizationId, options.installationReservationId],
  );
  const scope = target.rows[0];
  if (!scope) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  await lockSettlementScope(
    transaction,
    options.organizationId,
    scope.runId,
    scope.runStepId,
  );
  const intent = await loadIntent(
    transaction,
    options.organizationId,
    options.installationReservationId,
  );
  const reservations = await loadReservations(transaction, intent);
  await lockAccounts(transaction, [
    reservations.installation.budgetAccountId,
    reservations.run.budgetAccountId,
  ]);
  await lockReservations(transaction, options.organizationId, [
    reservations.installation.id,
    reservations.run.id,
  ]);
  const result = await transaction.query<{
    runId: string;
    runStepId: string;
    attemptId: string;
    workerHostId: string;
    workerSessionId: string;
    workerSessionGeneration: string | number;
    fence: string | number;
    resultEventId: string;
    usageFactId: string;
    providerCallId: string;
    provider: string;
    billingAccountId: string;
    model: string;
    billingRoute: "api" | "subscription";
    pricingMetadataSnapshot: string;
    inputTokens: string | number | null;
    outputTokens: string | number | null;
    costUsd: string | null;
    measurement: "reported" | "estimated";
    occurredAt: Date | string;
  }>(
    `select usage.run_id as "runId", usage.run_step_id as "runStepId",
            usage.attempt_id as "attemptId",
            usage.worker_host_id as "workerHostId",
            usage.worker_session_id as "workerSessionId",
            usage.worker_session_generation as "workerSessionGeneration",
            usage.fence, usage.result_event_id as "resultEventId",
            receipt.usage_fact_id as "usageFactId",
            receipt.provider_call_id as "providerCallId",
            call.provider, call.billing_account_id as "billingAccountId",
            call.model, call.billing_type as "billingRoute",
            call.pricing_metadata_snapshot as "pricingMetadataSnapshot",
            receipt.input_tokens as "inputTokens",
            receipt.output_tokens as "outputTokens",
            receipt.cost_usd as "costUsd", receipt.measurement,
            receipt.occurred_at as "occurredAt"
       from bakery.usage_records usage
       join bakery.provider_call_intents call
         on call.organization_id = usage.organization_id
        and call.installation_reservation_id = usage.budget_reservation_id
       join bakery.provider_authoritative_receipts receipt
         on receipt.organization_id = call.organization_id
        and receipt.provider_call_intent_id = call.id
        and receipt.cost_usd is not null
      where usage.organization_id = $1
        and usage.budget_reservation_id = $2
        and ($3::uuid is null or usage.id = $3::uuid)
        and usage.measurement = 'unknown'
      order by usage.updated_at asc, usage.id asc
      for update of usage`,
    [
      options.organizationId,
      options.installationReservationId,
      options.usageRecordId ?? null,
    ],
  );
  const row = result.rows[0];
  // Receipt-only reconciliation: the worker never published a usage record
  // for this bound call. The durable source of identity is the binding's
  // attempt attribution plus the immutable receipt itself; the receipt
  // observation stands in for the absent worker result event so the
  // settlement digest has one exact, stable identity.
  if (!row) {
    if (options.usageRecordId) return null;
    const receiptOnly = await transaction.query<{
      usageFactId: string;
      providerCallId: string;
      provider: string;
      billingAccountId: string;
      model: string;
      billingRoute: "api" | "subscription";
      pricingMetadataSnapshot: string;
      attemptId: string;
      workerHostId: string;
      workerSessionId: string;
      workerSessionGeneration: string | number;
      fence: string | number;
      inputTokens: string | number | null;
      outputTokens: string | number | null;
      costUsd: string;
      measurement: "reported" | "estimated";
      occurredAt: Date | string;
    }>(
      `select receipt.usage_fact_id as "usageFactId",
              receipt.provider_call_id as "providerCallId",
              call.provider, call.billing_account_id as "billingAccountId",
              call.model, call.billing_type as "billingRoute",
              call.pricing_metadata_snapshot as "pricingMetadataSnapshot",
              call.attempt_id as "attemptId",
              call.worker_host_id as "workerHostId",
              call.worker_session_id as "workerSessionId",
              call.worker_session_generation as "workerSessionGeneration",
              call.attempt_fence as fence,
              receipt.input_tokens as "inputTokens",
              receipt.output_tokens as "outputTokens",
              receipt.cost_usd as "costUsd", receipt.measurement,
              receipt.occurred_at as "occurredAt"
         from bakery.provider_authoritative_receipts receipt
         join bakery.provider_call_intents call
           on call.organization_id = receipt.organization_id
          and call.id = receipt.provider_call_intent_id
          and call.status = 'bound'
          and call.attempt_id is not null
        where receipt.organization_id = $1
          and receipt.id = $2::uuid`,
      [
        options.organizationId,
        options.receiptId ?? null,
      ],
    );
    const observed = receiptOnly.rows[0];
    if (!observed) return null;
    return await settleWithinLockedScope(transaction, {
      organizationId: options.organizationId,
      runId: scope.runId,
      runStepId: scope.runStepId,
      installationReservationId: options.installationReservationId,
      attemptId: observed.attemptId,
      workerHostId: observed.workerHostId,
      workerSessionId: observed.workerSessionId,
      workerSessionGeneration: String(observed.workerSessionGeneration),
      fence: String(observed.fence),
      resultEventId: await receiptObservationEventId(options.receiptId ?? ""),
      receipt: {
        usageFactId: observed.usageFactId,
        providerCallId: observed.providerCallId,
        provider: observed.provider,
        billingAccountId: observed.billingAccountId,
        model: observed.model,
        billingRoute: observed.billingRoute,
        pricingMetadataSnapshot: observed.pricingMetadataSnapshot,
        ...(observed.inputTokens === null
          ? {}
          : { inputTokens: databaseText(observed.inputTokens) as string }),
        ...(observed.outputTokens === null
          ? {}
          : { outputTokens: databaseText(observed.outputTokens) as string }),
        costUsd: observed.costUsd,
        measurement: observed.measurement,
        occurredAt: iso(observed.occurredAt),
      },
    }, true);
  }
  // The scope locked above is the intent's run and step. A usage row for
  // another run or step must fail here, before settlement, rather than lock a
  // second scope while the accounts, reservations and usage row are held.
  if (row.runId !== scope.runId || row.runStepId !== scope.runStepId) {
    conflict("usage_execution_mismatch");
  }
  return await settleWithinLockedScope(transaction, {
    organizationId: options.organizationId,
    runId: scope.runId,
    runStepId: scope.runStepId,
    installationReservationId: options.installationReservationId,
    attemptId: row.attemptId,
    workerHostId: row.workerHostId,
    workerSessionId: row.workerSessionId,
    workerSessionGeneration: String(row.workerSessionGeneration),
    fence: String(row.fence),
    resultEventId: row.resultEventId,
    receipt: {
      usageFactId: row.usageFactId,
      providerCallId: row.providerCallId,
      provider: row.provider,
      billingAccountId: row.billingAccountId,
      model: row.model,
      billingRoute: row.billingRoute,
      pricingMetadataSnapshot: row.pricingMetadataSnapshot,
      ...(row.inputTokens === null
        ? {}
        : { inputTokens: databaseText(row.inputTokens) as string }),
      ...(row.outputTokens === null
        ? {}
        : { outputTokens: databaseText(row.outputTokens) as string }),
      ...(row.costUsd === null ? {} : { costUsd: row.costUsd }),
      measurement: row.measurement,
      occurredAt: iso(row.occurredAt),
    },
  }, true);
}

function emptySummary(
  runId: string,
  limitUsd: string,
): RunBudgetSummary {
  return {
    installation: null,
    run: {
      scope: "run",
      runId,
      periodStart: null,
      periodEnd: null,
      limitUsd,
      reservedUsd: "0",
      settledUsd: "0",
      availableUsd: limitUsd,
      unknownCount: 1,
    },
  };
}

function accountSummary(
  row: AccountRow,
  unknownCount: number,
): BudgetAccountSummary {
  const limit = parseMicroUsd(row.limitUsd, "account_limit");
  const reserved = parseMicroUsd(row.reservedUsd, "account_reserved");
  const settled = parseMicroUsd(row.settledUsd, "account_settled");
  const available = limit > reserved + settled
    ? limit - reserved - settled
    : 0n;
  return {
    scope: row.scope,
    runId: row.runId,
    periodStart: iso(row.periodStart),
    periodEnd: iso(row.periodEnd),
    limitUsd: formatMicroUsd(limit),
    reservedUsd: formatMicroUsd(reserved),
    settledUsd: formatMicroUsd(settled),
    availableUsd: formatMicroUsd(available),
    unknownCount,
  };
}

export async function readRunBudgetSummary(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    runId: string;
    limitUsd: string;
  }>,
): Promise<RunBudgetSummary> {
  const result = await transaction.query<AccountRow & { unknownCount: string }>(
    `select account.id, account.scope, account.run_id as "runId",
            account.period_start as "periodStart",
            account.period_end as "periodEnd",
            account.limit_usd as "limitUsd",
            account.reserved_usd as "reservedUsd",
            account.settled_usd as "settledUsd",
            count(intent.id)::text as "unknownCount"
       from bakery.budget_accounts account
       left join bakery.budget_action_intents intent
         on intent.organization_id = account.organization_id
        and intent.run_id = account.run_id
        and intent.status = 'held'
      where account.organization_id = $1
        and account.scope = 'run'
        and account.run_id = $2
      group by account.id, account.scope, account.run_id,
               account.period_start, account.period_end, account.limit_usd,
               account.reserved_usd, account.settled_usd`,
    [options.organizationId, options.runId],
  );
  const runAccount = result.rows[0];
  if (!runAccount) return emptySummary(options.runId, options.limitUsd);
  return {
    // Installation totals are global deployment enforcement state. They are
    // deliberately not exposed through ordinary tenant Run reads.
    installation: null,
    run: accountSummary(runAccount, Number(runAccount.unknownCount)),
  };
}

export type PersistedUsageFact = Readonly<{
  id: string;
  organizationId: string;
  runId: string;
  runStepId: string;
  attemptId: string;
  workerHostId: string;
  workerSessionId: string;
  workerSessionGeneration: string;
  fence: string;
  resultEventId: string;
  usageFactId: string;
  canonicalDigest: string;
  originalCanonicalDigest: string;
  reconciledCanonicalDigest: string | null;
  provider: string;
  billingAccountId: string;
  model: string;
  billingRoute: "api" | "subscription";
  inputTokens: string | null;
  outputTokens: string | null;
  costUsd: string | null;
  overrunUsd: string;
  measurement: UsageReceipt["measurement"];
  provenance: "provider-authoritative" | "worker-unverified";
  providerCallId: string;
  pricingMetadataSnapshot: string;
  occurredAt: string;
  budgetReservationId: string;
}>;

export async function readPersistedUsageFact(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    usageFactId: string;
    canonicalDigest: string;
  }>,
): Promise<PersistedUsageFact | null> {
  if (!options.usageFactId.trim() || !SHA256.test(options.canonicalDigest)) {
    conflict("usage_readback_identity_invalid");
  }
  const result = await transaction.query<{
    id: string;
    organizationId: string;
    runId: string;
    runStepId: string;
    attemptId: string;
    workerHostId: string;
    workerSessionId: string;
    workerSessionGeneration: string | number;
    fence: string | number;
    resultEventId: string;
    usageFactId: string;
    originalCanonicalDigest: string;
    reconciledCanonicalDigest: string | null;
    provider: string;
    billingAccountId: string;
    model: string;
    billingRoute: "api" | "subscription";
    inputTokens: string | null;
    outputTokens: string | null;
    costUsd: string | null;
    overrunUsd: string;
    originalInputTokens: string | null;
    originalOutputTokens: string | null;
    originalCostUsd: string | null;
    originalMeasurement: UsageReceipt["measurement"] | null;
    originalOccurredAt: Date | string | null;
    measurement: UsageReceipt["measurement"];
    provenance: "provider-authoritative" | "worker-unverified";
    providerCallId: string;
    pricingMetadataSnapshot: string;
    occurredAt: Date | string;
    budgetReservationId: string;
  }>(
    `select id, organization_id as "organizationId", run_id as "runId",
            run_step_id as "runStepId", attempt_id as "attemptId",
            worker_host_id as "workerHostId",
            worker_session_id as "workerSessionId",
            worker_session_generation as "workerSessionGeneration",
            fence, result_event_id as "resultEventId",
            usage_fact_id as "usageFactId",
            canonical_digest as "originalCanonicalDigest",
            reconciled_canonical_digest as "reconciledCanonicalDigest",
            provider, billing_account_id as "billingAccountId", model,
            billing_type as "billingRoute",
            provider_call_id as "providerCallId",
            pricing_metadata_snapshot as "pricingMetadataSnapshot",
            input_tokens as "inputTokens",
            output_tokens as "outputTokens", cost_usd as "costUsd",
            overrun_usd as "overrunUsd",
            original_input_tokens as "originalInputTokens",
            original_output_tokens as "originalOutputTokens",
            original_cost_usd as "originalCostUsd",
            original_measurement as "originalMeasurement",
            original_occurred_at as "originalOccurredAt",
            measurement, provenance, occurred_at as "occurredAt",
            budget_reservation_id as "budgetReservationId"
       from bakery.usage_records
      where organization_id = $1 and usage_fact_id = $2`,
    [options.organizationId, options.usageFactId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const isOriginalDigest =
    options.canonicalDigest === row.originalCanonicalDigest;
  const isReconciledDigest = row.reconciledCanonicalDigest !== null &&
    options.canonicalDigest === row.reconciledCanonicalDigest;
  if (!isOriginalDigest && !isReconciledDigest) {
    conflict("usage_readback_digest_mismatch");
  }
  const historicalOriginal = isOriginalDigest &&
    row.reconciledCanonicalDigest !== null;
  if (
    historicalOriginal &&
    (row.originalMeasurement === null || row.originalOccurredAt === null)
  ) {
    conflict("usage_original_snapshot_missing");
  }
  const inputTokens = databaseText(
    historicalOriginal ? row.originalInputTokens : row.inputTokens,
  );
  const outputTokens = databaseText(
    historicalOriginal ? row.originalOutputTokens : row.outputTokens,
  );
  const costValue = historicalOriginal ? row.originalCostUsd : row.costUsd;
  const costUsd = costValue === null
    ? null
    : formatMicroUsd(parseMicroUsd(costValue, "stored_usage_cost"));
  const overrunUsd = historicalOriginal ? "0" : formatMicroUsd(
    parseMicroUsd(row.overrunUsd, "stored_overrun_usd"),
  );
  const measurement = historicalOriginal
    ? row.originalMeasurement as UsageReceipt["measurement"]
    : row.measurement;
  const occurredAt = historicalOriginal
    ? row.originalOccurredAt as Date | string
    : row.occurredAt;
  const {
    originalInputTokens: _originalInputTokens,
    originalOutputTokens: _originalOutputTokens,
    originalCostUsd: _originalCostUsd,
    originalMeasurement: _originalMeasurement,
    originalOccurredAt: _originalOccurredAt,
    ...persisted
  } = row;
  return {
    ...persisted,
    canonicalDigest: options.canonicalDigest,
    inputTokens,
    outputTokens,
    costUsd,
    overrunUsd,
    measurement,
    provenance: historicalOriginal ? "worker-unverified" : row.provenance,
    workerSessionGeneration: String(row.workerSessionGeneration),
    fence: String(row.fence),
    occurredAt: iso(occurredAt),
  };
}

export async function budgetContentDigest(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}
