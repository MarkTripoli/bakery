/**
 * Billing constants of the M1 (#132) proof, in one place so the pricing
 * snapshot rows the orchestrator inserts (operator step 1) and the agent
 * version configs the journey spec creates through the API cannot drift:
 * `prove-m1.ts` derives both the rows and `<state>/billing.json` from
 * `M1_AGENT_CONFIGS`, and the spec reads `billing.json`.
 *
 * Plain TypeScript types on purpose: this is evidence tooling, not a contract
 * surface, so there is no Zod schema to describe.
 */

/** The model both the coordinator and the coding agent run on. */
export const M1_PROOF_MODEL = "claude-sonnet-5-5";
export const M1_PROOF_PROVIDER = "anthropic";
export const M1_PROOF_BILLING_ACCOUNT_ID = "m1-proof-account";
export const M1_PROOF_PRICING_METADATA = "m1-proof-price-v1";
export const M1_PROOF_PRICING_SOURCE = "m1-proof-operator-step-1";

/** Billing routes the server accepts; the coordinator must use `subscription`. */
export type M1BillingRoute = "api" | "subscription";

/** One agent version's `billing` object, exactly as the API stores it. */
export type M1AgentBilling = {
  readonly provider: string;
  readonly billingAccountId: string;
  readonly model: string;
  readonly billingRoute: M1BillingRoute;
  readonly maxTokens: number;
  /** Per-run ceiling in USD; the web UI sets no `budgetLimitUsd`. */
  readonly maxUsdReservation: number;
  readonly pricingMetadataSnapshot: string;
};

/** An agent version `config` body (`AgentVersionCreateConfigSchema`). */
export type M1AgentConfig = {
  readonly harness: "claude_code";
  readonly allowedCapabilities?: readonly string[];
  readonly billing: M1AgentBilling;
};

export type M1AgentRole = "coordinator" | "coder";

/** An agent the journey creates, with the version config it carries. */
export type M1AgentDefinition = {
  readonly slug: string;
  readonly name: string;
  readonly config: M1AgentConfig;
};

export const M1_AGENT_ROLES: readonly M1AgentRole[] = ["coordinator", "coder"];

export const M1_AGENTS: Readonly<Record<M1AgentRole, M1AgentDefinition>> = {
  coordinator: {
    slug: "coordinator",
    name: "Coordinator",
    config: {
      harness: "claude_code",
      allowedCapabilities: ["model"],
      billing: {
        provider: M1_PROOF_PROVIDER,
        billingAccountId: M1_PROOF_BILLING_ACCOUNT_ID,
        model: M1_PROOF_MODEL,
        billingRoute: "subscription",
        maxTokens: 50_000,
        maxUsdReservation: 1,
        pricingMetadataSnapshot: M1_PROOF_PRICING_METADATA,
      },
    },
  },
  coder: {
    slug: "m1-coder",
    name: "M1 coder",
    config: {
      harness: "claude_code",
      billing: {
        provider: M1_PROOF_PROVIDER,
        billingAccountId: M1_PROOF_BILLING_ACCOUNT_ID,
        model: M1_PROOF_MODEL,
        billingRoute: "api",
        maxTokens: 200_000,
        maxUsdReservation: 5,
        pricingMetadataSnapshot: M1_PROOF_PRICING_METADATA,
      },
    },
  },
};

/** One `bakery.provider_pricing_snapshots` row (operator authority, owner role). */
export type M1PricingSnapshotRow = {
  readonly provider: string;
  readonly billingAccountId: string;
  readonly model: string;
  readonly billingType: M1BillingRoute;
  readonly pricingMetadataSnapshot: string;
  readonly sourceReference: string;
};

/**
 * One row per distinct (provider, account, model, route, metadata)
 * combination across the agents: the route is part of the snapshot identity,
 * so the subscription coordinator and the api coder need two rows.
 */
export function derivePricingSnapshotRows(
  agents: Readonly<Record<M1AgentRole, M1AgentDefinition>> = M1_AGENTS,
): readonly M1PricingSnapshotRow[] {
  const rows = new Map<string, M1PricingSnapshotRow>();
  for (const role of M1_AGENT_ROLES) {
    const billing = agents[role].config.billing;
    const row: M1PricingSnapshotRow = {
      provider: billing.provider,
      billingAccountId: billing.billingAccountId,
      model: billing.model,
      billingType: billing.billingRoute,
      pricingMetadataSnapshot: billing.pricingMetadataSnapshot,
      sourceReference: M1_PROOF_PRICING_SOURCE,
    };
    rows.set(
      JSON.stringify([
        row.provider,
        row.billingAccountId,
        row.model,
        row.billingType,
        row.pricingMetadataSnapshot,
      ]),
      row,
    );
  }
  return [...rows.values()];
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The single statement of operator step 1. The conflict clause mirrors
 * `seedProviderPricingSnapshot` (`tests/helpers/funded-model-job.ts`), so a
 * rerun reactivates the same rows. It holds no secret, so it is logged whole.
 */
export function pricingSnapshotSql(
  rows: readonly M1PricingSnapshotRow[] = derivePricingSnapshotRows(),
): string {
  if (rows.length === 0) throw new Error("M1_PRICING_SNAPSHOT_ROWS_EMPTY");
  const values = rows.map((row) =>
    `(${
      [
        row.provider,
        row.billingAccountId,
        row.model,
        row.billingType,
        row.pricingMetadataSnapshot,
        row.sourceReference,
      ].map(sqlLiteral).join(", ")
    }, clock_timestamp())`
  ).join(", ");
  return "insert into bakery.provider_pricing_snapshots (" +
    "provider, billing_account_id, model, billing_type, " +
    "pricing_metadata_snapshot, source_reference, effective_from) values " +
    `${values} on conflict (provider, billing_account_id, model, ` +
    "billing_type, pricing_metadata_snapshot) do update set " +
    "status = 'active', effective_until = null, updated_at = clock_timestamp()";
}

/** The shape of `<state>/billing.json`, read by the journey spec. */
export type M1BillingFile = {
  readonly schema: "bakery.m1-billing/v1";
  readonly agents: Readonly<Record<M1AgentRole, M1AgentDefinition>>;
  readonly pricingSnapshots: readonly M1PricingSnapshotRow[];
};

export function billingFile(
  agents: Readonly<Record<M1AgentRole, M1AgentDefinition>> = M1_AGENTS,
): M1BillingFile {
  return {
    schema: "bakery.m1-billing/v1",
    agents,
    pricingSnapshots: derivePricingSnapshotRows(agents),
  };
}
