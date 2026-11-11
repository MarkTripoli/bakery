-- Durable attempt attribution for bound provider calls and the trusted
-- authoritative-receipt writer used by budget reconciliation.
alter table bakery.provider_call_intents
  add column attempt_id uuid,
  add column worker_host_id uuid,
  add column worker_session_id uuid,
  add column worker_session_generation bigint,
  add column attempt_fence bigint;

-- The attribution tuple is set once by the trusted binding operation, scoped
-- like the existing provider_call_id/status bind columns.
grant update (
  provider_call_id, status, updated_at, version,
  attempt_id, worker_host_id, worker_session_id,
  worker_session_generation, attempt_fence
) on bakery.provider_call_intents to bakery_app;

-- Authoritative receipts represent provider-side billing facts. Direct table
-- inserts stay denied to bakery_app (migration 0064); the scheduled
-- reconciliation owner and the trusted provider adapter settle unknown spend
-- only through this definer-owned writer, which enforces that the receipt's
-- call intent is bound to the same provider call identity before storing it.
create function bakery.record_provider_usage_receipt(
  p_organization_id uuid,
  p_provider_call_intent_id uuid,
  p_provider_call_id text,
  p_usage_fact_id text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cost_usd numeric,
  p_measurement text,
  p_occurred_at timestamptz,
  p_receipt_digest text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, bakery, pg_temp
as $$
declare
  v_existing record;
  v_id uuid;
begin
  if p_provider_call_id is null or length(p_provider_call_id) > 255 then
    raise exception 'PROVIDER_CALL_IDENTITY_INVALID' using errcode = '22023';
  end if;
  if p_measurement not in ('reported', 'estimated') then
    raise exception 'PROVIDER_RECEIPT_MEASUREMENT_INVALID' using errcode = '22023';
  end if;
  if p_cost_usd is null then
    -- A receipt with no cost is not a provider-authoritative fact; proven
    -- no-spend is cost zero. Unknown spend keeps its hold instead.
    raise exception 'PROVIDER_RECEIPT_COST_MISSING' using errcode = '22023';
  end if;
  if not exists (
    select 1
      from bakery.provider_call_intents call
     where call.organization_id = p_organization_id
       and call.id = p_provider_call_intent_id
       and call.provider_call_id = p_provider_call_id
       and call.status = 'bound'
  ) then
    raise exception 'PROVIDER_CALL_UNBOUND' using errcode = '23514';
  end if;
  select id, receipt_digest into v_existing
    from bakery.provider_authoritative_receipts
   where provider_call_intent_id = p_provider_call_intent_id;
  if found then
    -- Receipts are immutable: the identical receipt replays as itself; a
    -- changed one is refused rather than overwritten.
    if v_existing.receipt_digest = p_receipt_digest then
      return v_existing.id;
    end if;
    raise exception 'PROVIDER_RECEIPT_MISMATCH' using errcode = '23505';
  end if;
  insert into bakery.provider_authoritative_receipts (
    id, organization_id, provider_call_intent_id, provider_call_id,
    usage_fact_id, input_tokens, output_tokens, cost_usd, measurement,
    occurred_at, receipt_digest, version
  ) values (
    gen_random_uuid(),
    p_organization_id,
    p_provider_call_intent_id,
    p_provider_call_id,
    p_usage_fact_id,
    p_input_tokens,
    p_output_tokens,
    p_cost_usd,
    p_measurement,
    p_occurred_at,
    p_receipt_digest,
    1
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function
  bakery.record_provider_usage_receipt(uuid, uuid, text, text, bigint, bigint, numeric, text, timestamptz, text)
from public;

grant execute on function
  bakery.record_provider_usage_receipt(uuid, uuid, text, text, bigint, bigint, numeric, text, timestamptz, text)
to bakery_app;
