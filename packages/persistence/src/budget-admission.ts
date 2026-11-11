import type { PgTransactionClient } from "./postgres.ts";

/** Check shaped model assignments against their own durable paired holds. */
export async function hasHeldJobBudgetReservation(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
): Promise<boolean> {
  const result = await transaction.query<{ id: string; maxTokens: string }>(
    `select intent.id, job.billing->>'maxTokens' as "maxTokens"
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
      where job.organization_id = $1 and job.id = $2
        and job.billing = job.agent_config->'billing'
        and intent.provider = job.billing->>'provider'
        and intent.billing_account_id = job.billing->>'billingAccountId'
        and intent.model = job.billing->>'model'
        and intent.billing_route = job.billing->>'billingRoute'
        and intent.pricing_metadata_snapshot = job.billing->>'pricingMetadataSnapshot'
        and intent.reserved_usd = (job.billing->>'maxUsdReservation')::numeric
        and intent.status = 'held'
      order by intent.id
      for share of intent`,
    [organizationId, jobId],
  );
  if (result.rows.length !== 1) return false;
  const intent = result.rows[0]!;

  // Read dispatch state after acquiring the intent lock: a binder that committed
  // while we waited must not be hidden by the first statement's older snapshot.
  const reservations = await transaction.query<{ id: string }>(
    `select reservation.id
       from bakery.budget_action_intents intent
       join bakery.provider_call_intents call
         on call.id = intent.provider_call_intent_id
        and call.organization_id = intent.organization_id
        and call.run_id = intent.run_id
        and call.run_step_id = intent.run_step_id
        and call.installation_reservation_id = intent.installation_reservation_id
        and call.provider = intent.provider
        and call.billing_account_id = intent.billing_account_id
        and call.model = intent.model
        and call.billing_type = intent.billing_route
        and call.pricing_metadata_snapshot = intent.pricing_metadata_snapshot
        and call.max_usd_reservation = intent.reserved_usd
       join bakery.provider_pricing_snapshots price
         on price.id = call.pricing_snapshot_id
        and price.provider = call.provider
        and price.billing_account_id = call.billing_account_id
        and price.model = call.model
        and price.billing_type = call.billing_type
        and price.pricing_metadata_snapshot = call.pricing_metadata_snapshot
       join bakery.budget_reservations reservation
         on reservation.organization_id = intent.organization_id
        and reservation.run_step_id = intent.run_step_id
        and reservation.reserved_usd = intent.reserved_usd
       join bakery.budget_accounts account
         on account.id = reservation.budget_account_id
      where intent.organization_id = $1 and intent.id = $2
        and call.max_tokens = $3::bigint
        and call.status = 'pending' and call.provider_call_id is null
        and reservation.status = 'held'
        and (
          (reservation.id = intent.installation_reservation_id
            and account.scope = 'installation'
            and account.organization_id is null and account.run_id is null)
          or
          (reservation.id = intent.run_reservation_id and account.scope = 'run'
            and account.organization_id = intent.organization_id
            and account.run_id = intent.run_id)
        )
      order by reservation.id
      for share of reservation`,
    [organizationId, intent.id, intent.maxTokens],
  );
  return reservations.rows.length === 2;
}
