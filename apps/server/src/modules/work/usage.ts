import type { output as ZodOutput } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import { formatMicroUsd, parseMicroUsd } from "./budget.ts";
import { requireInstallationTransaction } from "./work-transaction.ts";

type UsageQuery = ZodOutput<typeof contractSchemas.UsageQuery>;
type UsageSummary = ZodOutput<typeof contractSchemas.UsageSummary>;
type BudgetAccountSummary = UsageSummary["budgetAccounts"][number];
type ProviderUsageSummary = UsageSummary["byProvider"][number];

type BudgetAccountRow = {
  scope: "installation" | "run";
  runId: string | null;
  periodStart: Date | string;
  periodEnd: Date | string;
  limitUsd: string;
  reservedUsd: string;
  settledUsd: string;
  unknownCount: string;
};

type ProviderUsageRow = {
  provider: string;
  billingType: ProviderUsageSummary["billingType"];
  model: string | null;
  knownCostUsd: string;
  unverifiedCostUsd: string;
  unknownCount: string;
  unverifiedCount: string;
  inputTokens: string | null;
  outputTokens: string | null;
};

const DEFAULT_WINDOW_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

function addNullableDecimal(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null && right === null) return null;
  return (
    BigInt(left ?? "0") + BigInt(right ?? "0")
  ).toString();
}

function timestamp(value: string | undefined, fallback: Date): string {
  const date = value === undefined ? fallback : new Date(value);
  if (!Number.isFinite(date.getTime())) conflict("usage_window_invalid");
  return date.toISOString();
}

function accountSummary(row: BudgetAccountRow): BudgetAccountSummary {
  const limit = parseMicroUsd(row.limitUsd, "usage_account_limit");
  const reserved = parseMicroUsd(row.reservedUsd, "usage_account_reserved");
  const settled = parseMicroUsd(row.settledUsd, "usage_account_settled");
  const available = limit > reserved + settled
    ? limit - reserved - settled
    : 0n;
  return {
    scope: row.scope,
    runId: row.runId,
    periodStart: new Date(row.periodStart).toISOString(),
    periodEnd: new Date(row.periodEnd).toISOString(),
    limitUsd: formatMicroUsd(limit),
    reservedUsd: formatMicroUsd(reserved),
    settledUsd: formatMicroUsd(settled),
    availableUsd: formatMicroUsd(available),
    unknownCount: Number(row.unknownCount),
  };
}

function knownCost(rows: readonly ProviderUsageRow[]): string {
  let total = 0n;
  for (const row of rows) total += parseMicroUsd(row.knownCostUsd);
  return formatMicroUsd(total);
}

function unverifiedCost(rows: readonly ProviderUsageRow[]): string {
  let total = 0n;
  for (const row of rows) total += parseMicroUsd(row.unverifiedCostUsd);
  return formatMicroUsd(total);
}

function unknownCount(rows: readonly ProviderUsageRow[]): number {
  return rows.reduce((total, row) => total + Number(row.unknownCount), 0);
}

function unverifiedCount(rows: readonly ProviderUsageRow[]): number {
  return rows.reduce((total, row) => total + Number(row.unverifiedCount), 0);
}

function aggregateProviderRows(
  rows: readonly ProviderUsageRow[],
): ProviderUsageRow[] {
  const grouped = new Map<string, ProviderUsageRow>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.billingType}\u0000${
      row.model ?? ""
    }`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...row });
      continue;
    }
    current.knownCostUsd = formatMicroUsd(
      parseMicroUsd(current.knownCostUsd) +
        parseMicroUsd(row.knownCostUsd),
    );
    current.unverifiedCostUsd = formatMicroUsd(
      parseMicroUsd(current.unverifiedCostUsd) +
        parseMicroUsd(row.unverifiedCostUsd),
    );
    current.unknownCount = String(
      Number(current.unknownCount) + Number(row.unknownCount),
    );
    current.unverifiedCount = String(
      Number(current.unverifiedCount) + Number(row.unverifiedCount),
    );
    current.inputTokens = addNullableDecimal(
      current.inputTokens,
      row.inputTokens,
    );
    current.outputTokens = addNullableDecimal(
      current.outputTokens,
      row.outputTokens,
    );
  }
  return [...grouped.values()];
}

export async function readUsageSummary(
  transaction: PgTransactionClient,
  options: UsageQuery,
): Promise<UsageSummary> {
  const now = new Date();
  const to = timestamp(options.to, now);
  const from = timestamp(
    options.from,
    new Date(now.getTime() - DEFAULT_WINDOW_MILLISECONDS),
  );
  if (from >= to) conflict("usage_window_invalid");

  const accountResult = await transaction.query<BudgetAccountRow>(
    `select account.scope,
            account.run_id as "runId",
            account.period_start as "periodStart",
            account.period_end as "periodEnd",
            account.limit_usd as "limitUsd",
            account.reserved_usd as "reservedUsd",
            account.settled_usd as "settledUsd",
            (
              select count(distinct intent.id)::text
                from bakery.budget_action_intents intent
                join bakery.budget_reservations reservation
                  on reservation.organization_id = intent.organization_id
                 and (
                   reservation.id = intent.installation_reservation_id
                   or reservation.id = intent.run_reservation_id
                 )
               where reservation.budget_account_id = account.id
                 and intent.status = 'held'
            ) as "unknownCount"
       from bakery.budget_accounts account
      where account.period_start < $1::timestamptz
        and account.period_end > $2::timestamptz
        and (
          (account.scope = 'installation' and account.organization_id is null)
          or (
            account.scope = 'run'
            and $3::uuid is not null
            and account.run_id = $3::uuid
          )
        )
      order by account.period_start asc, account.scope asc, account.id asc`,
    [to, from, options.runId ?? null],
  );

  const providerResult = await transaction.query<ProviderUsageRow>(
    `select usage.provider,
            usage.billing_type as "billingType",
            usage.model,
            coalesce(
              sum(
                case
                  when usage.provenance = 'provider-authoritative'
                    and receipt.id is not null
                  then coalesce(usage.cost_usd, 0)
                  else 0
                end
              ), 0
            )::text as "knownCostUsd",
            coalesce(
              sum(
                case
                  when usage.provenance = 'provider-authoritative'
                    and receipt.id is not null
                  then 0
                  else coalesce(usage.cost_usd, 0)
                end
              ), 0
            )::text as "unverifiedCostUsd",
            count(*) filter (where usage.measurement = 'unknown')::text
              as "unknownCount",
            count(*) filter (
              where not (
                usage.provenance = 'provider-authoritative'
                and receipt.id is not null
              )
            )::text as "unverifiedCount",
            sum(usage.input_tokens)::text as "inputTokens",
            sum(usage.output_tokens)::text as "outputTokens"
       from bakery.usage_records usage
       join bakery.budget_reservations reservation
         on reservation.organization_id = usage.organization_id
        and reservation.id = usage.budget_reservation_id
       join bakery.budget_accounts account
         on account.id = reservation.budget_account_id
        and account.scope = 'installation'
        and account.organization_id is null
       left join bakery.budget_action_intents intent
         on intent.organization_id = usage.organization_id
        and intent.installation_reservation_id = usage.budget_reservation_id
       left join bakery.provider_call_intents call
         on call.organization_id = intent.organization_id
        and call.id = intent.provider_call_intent_id
       left join bakery.provider_authoritative_receipts receipt
         on receipt.organization_id = usage.organization_id
        and receipt.provider_call_intent_id = call.id
        and receipt.provider_call_id = usage.provider_call_id
        and receipt.usage_fact_id = usage.usage_fact_id
        and receipt.input_tokens is not distinct from usage.input_tokens
        and receipt.output_tokens is not distinct from usage.output_tokens
        and receipt.cost_usd is not distinct from usage.cost_usd
        and receipt.measurement = usage.measurement
        and receipt.occurred_at = usage.occurred_at
      where account.period_start < $1::timestamptz
        and account.period_end > $2::timestamptz
        and ($3::text is null or usage.provider = $3::text)
        and ($4::uuid is null or usage.run_id = $4::uuid)
      group by usage.provider, usage.billing_type, usage.model
      union all
      select intent.provider,
             intent.billing_route as "billingType",
             intent.model,
             '0' as "knownCostUsd",
             '0' as "unverifiedCostUsd",
             '1' as "unknownCount",
             '0' as "unverifiedCount",
             null as "inputTokens",
             null as "outputTokens"
        from bakery.budget_action_intents intent
        join bakery.budget_reservations reservation
          on reservation.organization_id = intent.organization_id
         and reservation.id = intent.installation_reservation_id
        join bakery.budget_accounts account
          on account.id = reservation.budget_account_id
         and account.scope = 'installation'
         and account.organization_id is null
       where intent.status = 'held'
         and account.period_start < $1::timestamptz
         and account.period_end > $2::timestamptz
         and ($3::text is null or intent.provider = $3::text)
         and ($4::uuid is null or intent.run_id = $4::uuid)
         and not exists (
           select 1
             from bakery.usage_records usage
            where usage.organization_id = intent.organization_id
              and usage.budget_reservation_id = reservation.id
         )
      order by 1 asc, 2 asc, 3 asc nulls first`,
    [to, from, options.provider ?? null, options.runId ?? null],
  );

  const rows = aggregateProviderRows(providerResult.rows);
  const totalKnown = knownCost(rows);
  const totalUnverified = unverifiedCost(rows);
  const totalUnknown = unknownCount(rows);
  const totalUnverifiedCount = unverifiedCount(rows);
  const completeness = totalUnknown === 0 && totalUnverifiedCount === 0
    ? "complete"
    : totalKnown === "0"
    ? "unknown"
    : "partial";
  return {
    from,
    to,
    knownCostUsd: totalKnown,
    unverifiedCostUsd: totalUnverified,
    unknownCount: totalUnknown,
    unverifiedCount: totalUnverifiedCount,
    completeness,
    byProvider: rows.map((row) => ({
      provider: row.provider,
      billingType: row.billingType,
      model: row.model,
      knownCostUsd: formatMicroUsd(parseMicroUsd(row.knownCostUsd)),
      unverifiedCostUsd: formatMicroUsd(
        parseMicroUsd(row.unverifiedCostUsd),
      ),
      unknownCount: Number(row.unknownCount),
      unverifiedCount: Number(row.unverifiedCount),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    })),
    budgetAccounts: accountResult.rows.map(accountSummary),
  };
}

export function createUsageQueryHandlers() {
  return {
    async usageList(context: ActionContext, input: UsageQuery) {
      const { transaction } = requireInstallationTransaction(context);
      return await readUsageSummary(transaction, input);
    },
  };
}
